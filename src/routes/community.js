import { ensureCommunityUser } from '../lib/communityHandles.js';
import { avatarResponse, creatorStats, profileCreatedAt, pageParameters, publicDeckSQL, validLikeSQL, reactionColumnsSQL } from '../lib/communityCreators.js';
import { rejectCommunityRepublication } from '../lib/communityValidation.js';
import { json, apiError } from '../lib/http.js';
import { communityUser, sha256, verifyAppleIdentity, checkAccountRestriction, accountRestriction, checkViewerAccess, restrictedSQL } from '../lib/communityAuth.js';
import { appleConfigured, validateAppleCode, exchangeAppleCode, revokeAppleJob, deleteCommunityAccount, verifyAppleEvent } from '../lib/appleLifecycle.js';
import { CommunityError, readCommunityJSON, readLimitedBody, deckMetadata, validateCommunityDeck, MEDIA_TYPES, validateMedia, validateCommunityProfile } from '../lib/communityValidation.js';

const now = () => Math.floor(Date.now() / 1000);
const uuidPattern = '[a-fA-F0-9-]{36}';
const maxDeckBytes = 100 * 1024 * 1024;

function requireStorage(env) {
  if (!env.DECK_ASSETS) throw new CommunityError(503, 'Media uploads are not configured yet.');
}
async function ownedDeck(env, id, user) {
  const deck = await env.COMMUNITY_DB.prepare("SELECT * FROM community_decks WHERE id=? AND owner_id=? AND status!='deleted'").bind(id, user.id).first();
  if (!deck) throw new CommunityError(404, 'Deck not found.');
  return deck;
}
function profileResponse(row,restriction=null) {
  return { accountStatus: restriction?.status||'active', restrictionMessage: restriction?.reason||null, authorID: row.public_id, handle: row.handle, avatar: avatarResponse(row), isComplete: Boolean(row.profile_completed) };
}
async function ownerProfile(db, row, restriction = null) {
  return { ...profileResponse(row,restriction), profileCreatedAt: profileCreatedAt(row),
    hideStatsPublicly: Boolean(row.hide_stats_publicly), stats: await creatorStats(db,row) };
}
function deckResponse(row, detail = false, owner = false) {
  return { id: row.id, authorID: row.author_id, name: row.name, description: row.description, authorHandle: row.handle,
    authorAvatar: avatarResponse(row), categoryTag: row.category_tag, colorHex: row.color_hex, deckType: row.deck_type,
    cardCount: row.card_count, downloadCount: row.download_count, publishedAt: row.published_at,
    likeCount: row.like_count ?? 0, viewerHasLiked: Boolean(row.viewer_has_liked),
    ...(row.review_status ? { reviewStatus: row.review_status } : {}),
    reviewMessage: row.review_message ?? null, submittedAt: row.submitted_at ?? null,
    ...(owner ? { status: row.status, adminNote: row.admin_note ?? null, adminAction: row.admin_action ?? null, adminUpdatedAt: row.admin_updated_at ?? null, isHidden: Boolean(row.admin_hidden) } : {}),
    ...(detail ? { cards: JSON.parse(row.cards_json) } : {}) };
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const db = env.COMMUNITY_DB;
  if (!db) throw new CommunityError(503, 'The community library is not configured yet.');

  if (path.startsWith('/v1/community/moderation/')) {
    const supplied = request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
    if (!env.COMMUNITY_MODERATION_TOKEN || !supplied ||
        await sha256(supplied) !== await sha256(env.COMMUNITY_MODERATION_TOKEN)) {
      throw new CommunityError(404, 'Endpoint not found.');
    }
    if (path === '/v1/community/moderation/reports' && method === 'GET') {
      const offset = Math.max(0, Math.min(100000, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
      const { results } = await db.prepare(`SELECT r.deck_id,r.reason,r.created_at,d.name,d.status,u.handle
        FROM community_reports r JOIN community_decks d ON d.id=r.deck_id
        JOIN community_users u ON u.id=d.owner_id WHERE d.status='published'
        ORDER BY r.created_at DESC,r.deck_id LIMIT 51 OFFSET ?`).bind(offset).all();
      return json({ reports: results.slice(0, 50), nextOffset: results.length > 50 ? offset + 50 : null });
    }
    const removal = path.match(new RegExp(`^/v1/community/moderation/decks/(${uuidPattern})$`));
    if (removal && method === 'DELETE') {
      const result = await db.prepare("UPDATE community_decks SET status='deleted',updated_at=? WHERE id=? AND status!='deleted'")
        .bind(now(), removal[1]).run();
      if (!result.meta.changes) throw new CommunityError(404, 'Deck not found.');
      return json({ success: true });
    }
    throw new CommunityError(404, 'Endpoint not found.');
  }

  if (path === '/v1/community/account' && (method === 'GET' || method === 'PUT')) {
    const user = await communityUser(request, env,true,method==='GET');
    if (method === 'PUT') {
      const body = await readCommunityJSON(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          (body.hideStatsPublicly !== undefined && typeof body.hideStatsPublicly !== 'boolean')) {
        throw new CommunityError(400,'Choose a valid profile privacy setting.');
      }
      const hasProfile = body.username !== undefined || body.avatar !== undefined;
      if (!hasProfile && body.hideStatsPublicly === undefined) throw new CommunityError(400,'Choose a profile change.');
      if (hasProfile) {
        const profile = validateCommunityProfile(body);
        const taken = await db.prepare('SELECT id FROM community_users WHERE handle=? COLLATE NOCASE AND id!=?')
          .bind(profile.handle, user.id).first();
        if (taken) throw new CommunityError(409, 'That username is taken. Try another one.');
        try {
          const avatarJSON = JSON.stringify(profile.avatar);
          const result = await db.prepare(`UPDATE community_users SET handle=?,
            avatar_json=CASE WHEN ? THEN ? ELSE json_set(?, '$.skinTone', COALESCE(json_extract(avatar_json,'$.skinTone'),3)) END,
            profile_completed=1,hide_stats_publicly=CASE WHEN ? THEN ? ELSE hide_stats_publicly END
            WHERE id=? AND (profile_completed=0 OR handle=? COLLATE NOCASE)`)
            .bind(profile.handle, body.avatar.skinTone !== undefined ? 1 : 0, avatarJSON, avatarJSON,
              body.hideStatsPublicly !== undefined ? 1 : 0,body.hideStatsPublicly ? 1 : 0,user.id,profile.handle).run();
          if (!result.meta.changes) throw new CommunityError(409, 'Your username is permanent. You can still change your character.');
        } catch (error) {
          if (String(error.message).includes('UNIQUE constraint failed')) throw new CommunityError(409, 'That username is taken. Try another one.');
          throw error;
        }
      } else {
        await db.prepare('UPDATE community_users SET hide_stats_publicly=? WHERE id=?').bind(body.hideStatsPublicly ? 1 : 0,user.id).run();
      }
    }
    const row = await db.prepare('SELECT * FROM community_users WHERE id=?').bind(user.id).first();
    if (!row) throw new CommunityError(401, 'Please sign in with Apple again.');
    return json(await ownerProfile(db,row,await accountRestriction(db,user.id)));
  }

  const creatorMatch = path.match(/^\/v1\/community\/profiles\/([a-f0-9]{32})$/);
  if (creatorMatch && method === 'GET') {
    const viewer = await communityUser(request,env,false);
    const author = await db.prepare('SELECT * FROM community_users WHERE public_id=?').bind(creatorMatch[1]).first();
    if (!author) throw new CommunityError(404,'Profile not found.');
    await checkViewerAccess(db,viewer,author.id);
    const {limit,offset} = pageParameters(url);
    const [page,count] = await db.batch([
      db.prepare(`SELECT d.*,u.handle,u.avatar_json,u.public_id AS author_id,${reactionColumnsSQL}
        FROM community_decks d JOIN community_users u ON u.id=d.owner_id
        WHERE d.owner_id=? AND ${publicDeckSQL} ORDER BY d.published_at DESC,d.id DESC LIMIT ? OFFSET ?`)
        .bind(viewer?.id || '',author.id,limit+1,offset),
      db.prepare(`SELECT COUNT(*) AS total FROM community_decks d WHERE d.owner_id=? AND ${publicDeckSQL}`).bind(author.id)
    ]);
    return json({profile:{authorID:author.public_id,handle:author.handle,avatar:avatarResponse(author),
      profileCreatedAt:profileCreatedAt(author),hideStatsPublicly:Boolean(author.hide_stats_publicly),
      stats:author.hide_stats_publicly && viewer?.id!==author.id ? null : await creatorStats(db,author)},
      decks:page.results.slice(0,limit).map(row=>deckResponse(row)),nextOffset:page.results.length>limit?offset+limit:null,totalCount:count.results[0].total});
  }

  if (path === '/v1/community/account/likes' && method === 'GET') {
    const user = await communityUser(request,env,true,true);
    const {limit,offset} = pageParameters(url);
    const from = `FROM community_likes l JOIN community_decks d ON d.id=l.deck_id
      JOIN community_users liker ON liker.id=l.user_id WHERE d.owner_id=? AND ${publicDeckSQL} AND ${validLikeSQL}`;
    const [page,count,decks] = await db.batch([
      db.prepare(`SELECT liker.public_id AS authorID,liker.handle,liker.avatar_json,d.id AS deckID,d.name AS deckName,l.created_at AS createdAt
        ${from} ORDER BY l.created_at DESC,d.id DESC,liker.public_id DESC LIMIT ? OFFSET ?`).bind(user.id,limit+1,offset),
      db.prepare(`SELECT COUNT(*) AS total ${from}`).bind(user.id),
      db.prepare(`SELECT d.id AS deckID,d.name AS deckName,COUNT(*) AS likeCount ${from}
        GROUP BY d.id,d.name ORDER BY likeCount DESC,d.name,d.id`).bind(user.id)
    ]);
    return json({likes:page.results.slice(0,limit).map(row=>({authorID:row.authorID,handle:row.handle,avatar:avatarResponse(row),deckID:row.deckID,deckName:row.deckName,createdAt:row.createdAt})),
      totalCount:count.results[0].total,nextOffset:page.results.length>limit?offset+limit:null,deckCounts:decks.results});
  }

  const likeMatch = path.match(new RegExp(`^/v1/community/decks/(${uuidPattern})/like$`));
  if (likeMatch && (method === 'PUT' || method === 'DELETE')) {
    const user = await communityUser(request,env);
    async function target() {
      const row = await db.prepare(`SELECT d.* FROM community_decks d WHERE d.id=? AND ${publicDeckSQL}`).bind(likeMatch[1]).first();
      if (!row) throw new CommunityError(404,'Deck not found.');
      await checkViewerAccess(db,user,row.owner_id);
      if (row.owner_id===user.id) throw new CommunityError(400,'You cannot heart your own deck.');
      return row;
    }
    await target();
    if (method === 'PUT' && !(await db.prepare('SELECT profile_completed FROM community_users WHERE id=?').bind(user.id).first())?.profile_completed) {
      throw new CommunityError(409,'Finish your username and character in Settings before sending a heart.','PROFILE_INCOMPLETE');
    }
    const eligible = `${publicDeckSQL} AND d.owner_id!=? AND NOT EXISTS(SELECT 1 FROM community_account_restrictions r WHERE r.account_id=? AND ${restrictedSQL})
      AND NOT EXISTS(SELECT 1 FROM community_blocks b WHERE (b.viewer_id=? AND b.blocked_account_id=d.owner_id) OR (b.viewer_id=d.owner_id AND b.blocked_account_id=?))
      AND EXISTS(SELECT 1 FROM community_users actor WHERE actor.id=? AND (?=0 OR actor.profile_completed=1))`;
    if (method === 'PUT') {
      try {
        await db.prepare(`INSERT INTO community_likes(deck_id,user_id,created_at)
          SELECT d.id,?,? FROM community_decks d WHERE d.id=? AND ${eligible}
          ON CONFLICT(deck_id,user_id) DO NOTHING`).bind(user.id,now(),likeMatch[1],user.id,user.id,user.id,user.id,user.id,1).run();
      } catch(error) {
        if(String(error.message).includes('community_like_unavailable')) throw new CommunityError(404,'Deck not found.');
        throw error;
      }
    } else {
      await db.prepare(`DELETE FROM community_likes WHERE deck_id=? AND user_id=? AND EXISTS(SELECT 1 FROM community_decks d WHERE d.id=community_likes.deck_id AND ${eligible})`)
        .bind(likeMatch[1],user.id,user.id,user.id,user.id,user.id,user.id,0).run();
    }
    await target();
    const reaction = await db.prepare(`SELECT ${reactionColumnsSQL} FROM community_decks d WHERE d.id=?`).bind(user.id,likeMatch[1]).first();
    return json({success:true,likeCount:reaction.like_count,viewerHasLiked:Boolean(reaction.viewer_has_liked)});
  }

  if (path === '/v1/community/account/decks' && method === 'GET') {
    const user = await communityUser(request, env,true,true);
    const offset = Math.max(0, Math.min(100000, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    const { results } = await db.prepare(`SELECT d.id AS id,d.name,d.description,d.category_tag,d.color_hex,d.deck_type,d.card_count,d.download_count,d.published_at,d.review_status,d.review_message,d.submitted_at,d.status,d.admin_note,d.admin_action,d.admin_updated_at,u.handle,u.avatar_json,d.admin_hidden,u.public_id AS author_id,${reactionColumnsSQL},d.updated_at AS sort_at
      FROM community_decks d JOIN community_users u ON u.id=d.owner_id
      WHERE d.owner_id=? AND d.status!='deleted' AND (d.status='published' OR d.review_status IN ('pending','rejected') OR d.admin_action IS NOT NULL)
      UNION ALL
      SELECT n.deck_id,n.name,'','General','#5B70E0','Mixed',n.card_count,0,NULL,NULL,NULL,NULL,'deleted',n.admin_note,'removed',n.admin_updated_at,u.handle,u.avatar_json,0,u.public_id,0,0,n.admin_updated_at
      FROM community_deck_notices n JOIN community_users u ON u.id=n.owner_id WHERE n.owner_id=?
      ORDER BY sort_at DESC,id DESC LIMIT 51 OFFSET ?`).bind(user.id,user.id,user.id,offset).all();
    return json({ decks: results.slice(0,50).map(row => deckResponse(row,false,true)), nextOffset: results.length>50 ? offset+50 : null });
  }

  if (path === '/v1/community/account' && method === 'DELETE') {
    const user = await communityUser(request,env,true,true);
    const body=await readCommunityJSON(request,true);
    if(!body || typeof body!=='object')throw new CommunityError(400,'Invalid deletion request.');
    validateAppleCode(body);
    if(body.identityToken!==undefined || body.authorizationCode!==undefined) {
      if(typeof body.identityToken!=='string'||body.identityToken.length>12000||typeof body.nonce!=='string'||!/^[a-f0-9]{64}$/.test(body.nonce))throw new CommunityError(400,'Reauthenticate with Apple before deleting.');
      const identity=await verifyAppleIdentity(body.identityToken,body.nonce,env.APPLE_CLIENT_ID||'com.learnalert.app');
      if(identity!==user.id)throw new CommunityError(401,'Use the Apple account associated with this community profile.','APPLE_IDENTITY_MISMATCH');
      if(body.authorizationCode && appleConfigured(env)) {
        const encrypted=await exchangeAppleCode(env,body,user.id);
        await db.prepare('INSERT INTO community_apple_tokens(user_id,encrypted_token,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET encrypted_token=excluded.encrypted_token,updated_at=excluded.updated_at').bind(user.id,encrypted,now()).run();
      }
    }
    const saved=await db.prepare('SELECT 1 FROM community_apple_tokens WHERE user_id=?').bind(user.id).first();
    if(appleConfigured(env)&&!saved)throw new CommunityError(409,'Sign in with Apple again to authorize account deletion.','APPLE_REAUTH_REQUIRED');
    const job=await deleteCommunityAccount(db,user.id);
    const appleRevocation=job ? (await revokeAppleJob(env,job) ? 'revoked' : 'pending') : 'not_configured';
    return json({success:true,appleRevocation});
  }

  if(path==='/v1/community/auth/apple/notifications' && method==='POST') {
    const body=await readCommunityJSON(request);
    const {id,event}=await verifyAppleEvent(body?.payload,env.APPLE_NOTIFICATION_AUDIENCE||env.APPLE_CLIENT_ID||'com.learnalert.app');
    const eligible="EXISTS(SELECT 1 FROM community_users WHERE id=? AND created_at<=?) AND NOT EXISTS(SELECT 1 FROM community_apple_events WHERE id=?)";
    const statements=[];
    if(['consent-revoked','account-deleted'].includes(event.type))statements.push(
      db.prepare(`INSERT OR IGNORE INTO community_deleted_objects(object_key,created_at) SELECT m.object_key,? FROM community_media m JOIN community_decks d ON d.id=m.deck_id WHERE d.owner_id=? AND ${eligible}`).bind(now(),event.sub,event.sub,event.event_time,id),
      db.prepare(`DELETE FROM community_reports WHERE user_id=? AND ${eligible}`).bind(event.sub,event.sub,event.event_time,id),
      db.prepare(`DELETE FROM community_decks WHERE owner_id=? AND ${eligible}`).bind(event.sub,event.sub,event.event_time,id),
      db.prepare(`DELETE FROM community_users WHERE id=? AND created_at<=? AND NOT EXISTS(SELECT 1 FROM community_apple_events WHERE id=?)`).bind(event.sub,event.event_time,id));
    statements.push(db.prepare('INSERT INTO community_apple_events(id,created_at) VALUES(?,?) ON CONFLICT(id) DO NOTHING').bind(id,now()));
    await db.batch(statements);return json({success:true});
  }

  if(path==='/v1/community/account/blocks' && (method==='GET'||method==='POST')) {
    const user=await communityUser(request,env);
    if(method==='GET') {
      const {results}=await db.prepare('SELECT COALESCE(u.public_id,b.blocked_author_id) AS id,COALESCE(u.handle,b.blocked_handle) AS handle FROM community_blocks b LEFT JOIN community_users u ON u.id=b.blocked_account_id WHERE b.viewer_id=? ORDER BY b.created_at DESC,b.blocked_author_id').bind(user.id).all();
      return json({users:results});
    }
    const body=await readCommunityJSON(request);
    if(typeof body?.authorID!=='string'||!/^[a-f0-9]{32}$/.test(body.authorID))throw new CommunityError(400,'Choose a valid community author.');
    const author=await db.prepare('SELECT id,handle,public_id FROM community_users WHERE public_id=?').bind(body.authorID).first();
    if(!author)throw new CommunityError(404,'Author not found.');
    if(author.id===user.id)throw new CommunityError(400,'You cannot block your own profile.');
    const result=await db.prepare(`INSERT INTO community_blocks(viewer_id,blocked_account_id,blocked_author_id,blocked_handle,created_at)
      SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM community_blocks WHERE viewer_id=?)<500 OR EXISTS(SELECT 1 FROM community_blocks WHERE viewer_id=? AND blocked_account_id=?)
      ON CONFLICT(viewer_id,blocked_account_id) DO UPDATE SET blocked_author_id=excluded.blocked_author_id,blocked_handle=excluded.blocked_handle`).bind(user.id,author.id,author.public_id,author.handle,now(),user.id,user.id,author.id).run();
    if(!result.meta.changes)throw new CommunityError(429,'Your block list is full. Unblock an author first.');
    return json({success:true});
  }
  const unblock=path.match(/^\/v1\/community\/account\/blocks\/([a-f0-9]{32})$/);
  if(unblock&&method==='DELETE') {
    const user=await communityUser(request,env);
    await db.prepare('DELETE FROM community_blocks WHERE viewer_id=? AND (blocked_author_id=? OR blocked_account_id=(SELECT id FROM community_users WHERE public_id=?))').bind(user.id,unblock[1],unblock[1]).run();
    return json({success:true});
  }

  if (path === '/v1/community/auth/apple' && method === 'POST') {
    const body = await readCommunityJSON(request);
    if (typeof body?.identityToken !== 'string' || body.identityToken.length > 12000 ||
        typeof body.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(body.nonce)) {
      throw new CommunityError(400, 'Invalid sign-in request.');
    }
    validateAppleCode(body);
    const id = await verifyAppleIdentity(body.identityToken, body.nonce, env.APPLE_CLIENT_ID || 'com.learnalert.app');
    const restriction=await accountRestriction(db,id);
    if(restriction&&!await db.prepare('SELECT 1 FROM community_users WHERE id=?').bind(id).first())await checkAccountRestriction(db,id);
    const encrypted=body.authorizationCode && appleConfigured(env) ? await exchangeAppleCode(env,body,id) : null;
    await ensureCommunityUser(db, id, now());
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const expiresAt = now() + 30 * 86400;
    const statements=[
      db.prepare('DELETE FROM community_sessions WHERE user_id=? AND expires_at<=?').bind(id, now()),
      db.prepare('INSERT INTO community_sessions(token_hash,user_id,expires_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM community_users WHERE id=?)').bind(await sha256(token), id, expiresAt,id)
    ];
    if(encrypted)statements.push(db.prepare('INSERT INTO community_apple_tokens(user_id,encrypted_token,updated_at) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM community_users WHERE id=?) ON CONFLICT(user_id) DO UPDATE SET encrypted_token=excluded.encrypted_token,updated_at=excluded.updated_at').bind(id,encrypted,now(),id));
    await db.batch(statements);
    const user = await db.prepare('SELECT * FROM community_users WHERE id=?').bind(id).first();
    if(!user) {
      if(encrypted) { const job={id:crypto.randomUUID(),encrypted_token:encrypted};await db.prepare('INSERT INTO community_apple_revocations(id,encrypted_token,created_at) VALUES(?,?,?)').bind(job.id,encrypted,now()).run();await revokeAppleJob(env,job); }
      throw new CommunityError(401,'This community account was removed.');
    }
    return json({ token, expiresAt, appleRevocationAvailable: appleConfigured(env)&&Boolean(encrypted||await db.prepare('SELECT 1 FROM community_apple_tokens WHERE user_id=?').bind(id).first()), handle: user.handle, profile: await ownerProfile(db,user,await accountRestriction(db,id)) }, 201);
  }

  if (path === '/v1/community/decks' && method === 'GET') {
    const viewer=await communityUser(request,env,false);
    const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '30', 10) || 30));
    const offset = Math.min(100000, Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    const search = (url.searchParams.get('q') || '').trim().slice(0, 120);
    const category = (url.searchParams.get('category') || '').trim().slice(0, 60);
    // Only fixed sort clauses enter SQL; older clients retain the recent-first default.
    const order = url.searchParams.get('sort') === 'popular'
      ? 'd.download_count DESC, d.published_at DESC, d.id DESC'
      : 'd.published_at DESC, d.id DESC';
    // Escape LIKE wildcards so a user's search is interpreted literally.
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const filter = `FROM community_decks d JOIN community_users u ON u.id=d.owner_id
      WHERE d.status='published' AND d.review_status='approved' AND d.admin_hidden=0
      AND NOT EXISTS(SELECT 1 FROM community_account_restrictions r WHERE r.account_id=d.owner_id AND ${restrictedSQL})
      AND NOT EXISTS(SELECT 1 FROM community_blocks b WHERE (b.viewer_id=? AND b.blocked_account_id=d.owner_id) OR (b.viewer_id=d.owner_id AND b.blocked_account_id=?)) AND (?='' OR d.category_tag=? COLLATE NOCASE)
      AND (?='' OR d.name LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\' OR u.handle LIKE ? ESCAPE '\\')`;
    const parameters = [viewer?.id||'',viewer?.id||'',category, category, search, pattern, pattern, pattern];
    const [page, count] = await db.batch([
      db.prepare(`SELECT d.*,u.handle,u.avatar_json,u.public_id AS author_id,${reactionColumnsSQL} ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .bind(viewer?.id||'',...parameters, limit + 1, offset),
      db.prepare(`SELECT COUNT(*) AS total ${filter}`).bind(...parameters)
    ]);
    return json({ decks: page.results.slice(0, limit).map(row => deckResponse(row)),
      nextOffset: page.results.length > limit ? offset + limit : null, totalCount: count.results[0].total });
  }

  if (path === '/v1/community/decks/drafts' && method === 'POST') {
    const user = await communityUser(request, env);
    const meta = deckMetadata(await readCommunityJSON(request));
    const id = crypto.randomUUID();
    const result = await db.prepare(`INSERT INTO community_decks(id,owner_id,name,description,category_tag,color_hex,deck_type,created_at,updated_at,review_status)
      SELECT ?,?,?,?,?,?,?,?,?,NULL WHERE
      (SELECT COUNT(*) FROM community_decks WHERE owner_id=? AND status!='deleted')<50 AND
      (SELECT COUNT(*) FROM community_decks WHERE owner_id=? AND created_at>?)<20`)
      .bind(id, user.id, meta.name, meta.description, meta.categoryTag, meta.colorHex, meta.deckType, now(), now(), user.id, user.id, now() - 86400).run();
    if (!result.meta.changes) throw new CommunityError(429, 'You can have 50 shared decks and create up to 20 per day.');
    return json({ id }, 201);
  }

  const uploadMatch = path.match(new RegExp(`^/v1/community/decks/(${uuidPattern})/media$`));
  if (uploadMatch && method === 'POST') {
    requireStorage(env);
    const user = await communityUser(request, env);
    const deck = await ownedDeck(env, uploadMatch[1], user);
    const contentType = (request.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
    const type = MEDIA_TYPES[contentType];
    if (!type) throw new CommunityError(415, 'Use JPEG/PNG images or MP3/M4A/WAV audio.');
    const bytes = await readLimitedBody(request, type.maximum);
    validateMedia(bytes, contentType);
    const id = crypto.randomUUID();
    const key = `decks/${deck.id}/${id}.${type.extension}`;
    // Reserve capacity in the same SQL statement that checks it, including concurrent uploads.
    const result = await db.prepare(`INSERT INTO community_media(id,deck_id,object_key,content_type,byte_size,created_at)
      SELECT ?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(byte_size),0) FROM community_media WHERE deck_id=?)+?<=?
      AND (SELECT COUNT(*) FROM community_media WHERE deck_id=?)<?
      AND EXISTS(SELECT 1 FROM community_decks WHERE id=? AND status!='deleted')`)
      .bind(id, deck.id, key, contentType, bytes.length, now(), deck.id, bytes.length,
        deck.status === 'published' ? maxDeckBytes * 2 : maxDeckBytes, deck.id,
        deck.status === 'published' ? 2000 : 1000, deck.id).run();
    if (!result.meta.changes) throw new CommunityError(413, 'This deck has reached its upload capacity. Remove unused attachments or try again after temporary uploads are cleared.');
    try {
      await env.DECK_ASSETS.put(key, bytes, { httpMetadata: { contentType } });
      const finalized = await db.prepare(`UPDATE community_media SET uploaded=1 WHERE id=? AND EXISTS
        (SELECT 1 FROM community_decks WHERE id=? AND status!='deleted')`).bind(id, deck.id).run();
      if (!finalized.meta.changes) throw new CommunityError(409, 'This deck was removed while uploading.');
    } catch (error) {
      await env.DECK_ASSETS.delete(key);
      await db.prepare('DELETE FROM community_media WHERE id=?').bind(id).run();
      throw error;
    }
    return json({ id, contentType, byteSize: bytes.length }, 201);
  }

  const mediaMatch = path.match(new RegExp(`^/v1/community/media/(${uuidPattern})$`));
  if (mediaMatch && (method === 'GET' || method === 'HEAD')) {
    requireStorage(env);
    const row = await db.prepare(`SELECT m.*, d.owner_id,d.status,d.admin_hidden,d.review_status FROM community_media m
      JOIN community_decks d ON d.id=m.deck_id WHERE m.id=? AND m.uploaded=1 AND m.deleting=0 AND d.status!='deleted'`).bind(mediaMatch[1]).first();
    if (!row) throw new CommunityError(404, 'Attachment not found.');
    const viewer=await communityUser(request,env,false);
    await checkViewerAccess(db,viewer,row.owner_id);
    if (row.status !== 'published' || row.review_status !== 'approved' || row.admin_hidden || !row.attached) {
      if (!viewer || viewer.id !== row.owner_id) throw new CommunityError(404, 'Attachment not found.');
    }
    const object = method === 'HEAD' ? await env.DECK_ASSETS.head(row.object_key) : await env.DECK_ASSETS.get(row.object_key);
    if (!object) throw new CommunityError(404, 'Attachment not found.');
    return new Response(method === 'HEAD' ? null : object.body, { headers: {
      'Content-Type': row.content_type, 'Content-Length': String(object.size),
      'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': '*',
      // Always check publication status; do not leave removed content in a public cache.
      'Cache-Control': 'no-store', 'ETag': object.httpEtag
    } });
  }

  const reportMatch = path.match(new RegExp(`^/v1/community/decks/(${uuidPattern})/reports$`));
  if (reportMatch && method === 'POST') {
    const user = await communityUser(request, env);
    const body = await readCommunityJSON(request);
    const target=await db.prepare('SELECT owner_id FROM community_decks WHERE id=?').bind(reportMatch[1]).first();
    if(target)await checkViewerAccess(db,user,target.owner_id);
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000) throw new CommunityError(400, 'Please give a reason for reporting this deck.');
    const result = await db.prepare(`INSERT INTO community_reports(deck_id,user_id,reason,created_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM community_decks WHERE id=? AND status='published' AND review_status='approved' AND admin_hidden=0)
      ON CONFLICT(deck_id,user_id) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at,resolved_at=NULL,resolved_by=NULL`)
      .bind(reportMatch[1], user.id, body.reason.trim(), now(), reportMatch[1]).run();
    if (!result.meta.changes) throw new CommunityError(404, 'Deck not found.');
    return json({ success: true });
  }

  const previewMatch = path.match(new RegExp(`^/v1/community/decks/(${uuidPattern})/preview$`));
  if (previewMatch && method === 'GET') {
    const viewer = await communityUser(request,env,false);
    const row = await db.prepare(`SELECT d.*,u.handle,u.avatar_json,u.public_id AS author_id,${reactionColumnsSQL} FROM community_decks d
      JOIN community_users u ON u.id=d.owner_id WHERE d.id=? AND d.status='published' AND d.review_status='approved' AND d.admin_hidden=0`).bind(viewer?.id||'',previewMatch[1]).first();
    if (!row) throw new CommunityError(404, 'Deck not found.');
    await checkViewerAccess(db,viewer,row.owner_id);
    const deck = deckResponse(row, true);
    deck.cards = deck.cards.slice(0, 5);
    return json({ deck });
  }

  const deckMatch = path.match(new RegExp(`^/v1/community/decks/(${uuidPattern})$`));
  if (deckMatch) {
    const id = deckMatch[1];
    if (method === 'GET') {
      const viewer = await communityUser(request,env,false);
      const row = await db.prepare(`SELECT d.*,u.handle,u.avatar_json,u.public_id AS author_id,${reactionColumnsSQL} FROM community_decks d JOIN community_users u ON u.id=d.owner_id WHERE d.id=? AND d.status='published' AND d.review_status='approved' AND d.admin_hidden=0`).bind(viewer?.id||'',id).first();
      if (!row) throw new CommunityError(404, 'Deck not found.');
      await checkViewerAccess(db,viewer,row.owner_id);
      await db.prepare("UPDATE community_decks SET download_count=download_count+1 WHERE id=? AND status='published' AND review_status='approved' AND admin_hidden=0").bind(id).run();
      return json({ deck: deckResponse({ ...row, download_count: row.download_count + 1 }, true) });
    }
    const user = await communityUser(request, env);
    if (method === 'DELETE') {
      const dismissed = await db.prepare('DELETE FROM community_deck_notices WHERE deck_id=? AND owner_id=?').bind(id,user.id).run();
      if (dismissed.meta.changes) return json({ success: true });
    }
    await ownedDeck(env, id, user);
    if (method === 'PUT' || method === 'PATCH') {
      const { metadata: meta, cards, media } = validateCommunityDeck(await readCommunityJSON(request));
      await rejectCommunityRepublication(db, cards, user.id);
      const { results: uploads } = await db.prepare('SELECT id,content_type,byte_size FROM community_media WHERE deck_id=? AND uploaded=1 AND deleting=0').bind(id).all();
      let publishedBytes = 0;
      for (const [reference, kind] of media) {
        const upload = uploads.find(item => item.id === reference);
        if (!upload || !upload.content_type.startsWith(`${kind}/`)) throw new CommunityError(400, 'Every attachment must be uploaded to this deck before publishing.');
        publishedBytes += upload.byte_size;
      }
      if (publishedBytes > maxDeckBytes || media.size > 1000) throw new CommunityError(413, 'A shared deck can contain up to 100 MB of media and 1,000 attachments.');
      const guard = "EXISTS(SELECT 1 FROM community_decks WHERE id=? AND owner_id=? AND status!='deleted')";
      const statements = [db.prepare(`UPDATE community_media SET attached=0 WHERE deck_id=? AND ${guard}`).bind(id,id,user.id)];
      // Each prepared statement stays below D1's bind parameter limit.
      const mediaIDs = [...media.keys()];
      for (let start = 0; start < mediaIDs.length; start += 90) {
        const chunk = mediaIDs.slice(start, start + 90);
        statements.push(db.prepare(`UPDATE community_media SET attached=1 WHERE deck_id=? AND id IN (${chunk.map(() => '?').join(',')}) AND ${guard}`).bind(id, ...chunk,id,user.id));
      }
      statements.push(db.prepare(`UPDATE community_decks SET name=?,description=?,category_tag=?,color_hex=?,deck_type=?,cards_json=?,card_count=?,status='draft',review_status='pending',review_message=NULL,submitted_at=?,reviewed_at=NULL,reviewed_by=NULL,updated_at=? WHERE id=? AND owner_id=? AND status!='deleted'`)
        .bind(meta.name, meta.description, meta.categoryTag, meta.colorHex, meta.deckType, JSON.stringify(cards), cards.length, now(), now(), id, user.id));
      const results = await db.batch(statements);
      if (!results.at(-1).meta.changes) throw new CommunityError(409, 'This deck was removed while publishing.');
      const submitted = await db.prepare('SELECT submitted_at FROM community_decks WHERE id=? AND owner_id=?').bind(id,user.id).first();
      return json({ id, success: true, reviewStatus: 'pending', submittedAt: submitted?.submitted_at ?? now(), message: 'Review can take up to 3 days.' }, 202);
    }
    if (method === 'DELETE') {
      await db.prepare("UPDATE community_decks SET status='deleted',updated_at=? WHERE id=? AND owner_id=?").bind(now(), id, user.id).run();
      // Immediately inaccessible; scheduled cleanup removes the underlying files.
      return json({ success: true });
    }
  }
  throw new CommunityError(404, 'Endpoint not found.');
}

export async function community(request, env, requestId) {
  try { return await handle(request, env); }
  catch (error) {
    if (String(error.message).includes('community_attachment_unavailable')) {
      return apiError('ATTACHMENT_UNAVAILABLE', 'An attachment expired. Upload it again before publishing.', 409, requestId);
    }
    if (error instanceof CommunityError) return apiError(error.code || 'COMMUNITY_ERROR', error.message, error.status, requestId);
    console.error('Community request failed', requestId, error);
    return apiError('COMMUNITY_ERROR', 'The community library is temporarily unavailable. Please try again.', 500, requestId);
  }
}

export async function cleanupCommunity(env) {
  if (!env.COMMUNITY_DB || !env.DECK_ASSETS) return;
  const db = env.COMMUNITY_DB;
  await db.batch([
    db.prepare('DELETE FROM community_sessions WHERE expires_at<=?').bind(now()),
    db.prepare("UPDATE community_decks SET status='deleted' WHERE status='draft' AND admin_created=0 AND COALESCE(review_status,'') NOT IN ('pending','rejected') AND updated_at<?").bind(now() - 86400)
  ]);
  await db.prepare('DELETE FROM community_apple_events WHERE created_at<?').bind(now()-30*86400).run();
  const revocations=await db.prepare('SELECT id,encrypted_token FROM community_apple_revocations ORDER BY created_at LIMIT 10').all();
  for(const job of revocations.results)await revokeAppleJob(env,job);
  const queued = await db.prepare('SELECT object_key FROM community_deleted_objects ORDER BY created_at LIMIT 500').all();
  for (const row of queued.results) {
    await env.DECK_ASSETS.delete(row.object_key);
    await db.prepare('DELETE FROM community_deleted_objects WHERE object_key=?').bind(row.object_key).run();
  }
  const { results } = await db.prepare(`SELECT m.id,m.object_key FROM community_media m JOIN community_decks d ON d.id=m.deck_id
    WHERE d.status='deleted' OR (m.attached=0 AND m.created_at<?) LIMIT 500`).bind(now() - 86400).all();
  for (const row of results) {
    const claimed = await db.prepare(`UPDATE community_media SET deleting=1 WHERE id=? AND
      (EXISTS(SELECT 1 FROM community_decks WHERE id=deck_id AND status='deleted')
       OR (attached=0 AND created_at<?))`).bind(row.id, now() - 86400).run();
    if (!claimed.meta.changes) continue;
    await env.DECK_ASSETS.delete(row.object_key);
    await db.prepare('DELETE FROM community_media WHERE id=? AND deleting=1').bind(row.id).run();
  }
}
