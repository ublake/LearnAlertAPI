import { adminIdentity } from '../lib/adminAuth.js';
import { CommunityError, readCommunityJSON, validateCommunityProfile, validateCommunityDeck, deckMetadata, MEDIA_TYPES, readLimitedBody, validateMedia } from '../lib/communityValidation.js';
import { sha256 } from '../lib/communityAuth.js';

function reply(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow'
  } });
}
const now = () => Math.floor(Date.now() / 1000);
export async function admin(request, env) {
  try {
    const actor = await adminIdentity(request, env);
    const db = env.COMMUNITY_DB;
    if (!db) throw new CommunityError(503, 'Community database unavailable.');
    const url = new URL(request.url);
    const path = url.pathname.slice('/v1/admin/'.length);
    const method = request.method;
    const uploadMatch = path.match(/^decks\/([a-fA-F0-9-]{36})\/media$/);
    // Browser writes must arrive from the same-origin website proxy. Access
    // authentication alone does not prevent cross-site request forgery.
    if (method !== 'GET' && (request.headers.get('Origin') !== 'https://learnalertapp.com' ||
        (!uploadMatch && request.headers.get('Content-Type')?.split(';')[0] !== 'application/json'))) {
      throw new CommunityError(403, 'Invalid admin request origin.');
    }
    const audit = (action, target, details) => db.prepare('INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) VALUES(?,?,?,?,?,?)')
      .bind(crypto.randomUUID(), actor, action, target, JSON.stringify(details), now());
    if (path === 'decks/validate' && method === 'POST') {
      const { metadata, cards } = validateCommunityDeck(await readCommunityJSON(request));
      return reply({ success: true, metadata, cards });
    }
    if (path === 'decks' && method === 'POST') {
      const body = await readCommunityJSON(request);
      const meta = deckMetadata(body);
      let owner = body.ownerId;
      if (owner === 'official') {
        owner = `admin:${await sha256(actor)}`;
        const exists = await db.prepare('SELECT id FROM community_users WHERE id=?').bind(owner).first();
        if (!exists) {
          const claimed = await db.prepare("SELECT id FROM community_users WHERE handle='@learnalert' COLLATE NOCASE").first();
          if (claimed) throw new CommunityError(409, 'The @learnalert username is already in use. Choose an existing author.');
          await db.prepare("INSERT INTO community_users(id,handle,created_at,profile_completed) VALUES(?,'@learnalert',?,1) ON CONFLICT(id) DO NOTHING").bind(owner, now()).run();
        }
      }
      if (typeof owner !== 'string' || !await db.prepare('SELECT id FROM community_users WHERE id=?').bind(owner).first()) throw new CommunityError(400, 'Choose a valid author.');
      const id = crypto.randomUUID();
      await db.batch([
        db.prepare('INSERT INTO community_decks(id,owner_id,name,description,category_tag,color_hex,deck_type,created_at,updated_at,admin_created,review_status) VALUES(?,?,?,?,?,?,?,?,?,1,NULL)')
          .bind(id, owner, meta.name, meta.description, meta.categoryTag, meta.colorHex, meta.deckType, now(), now()),
        audit('create_deck', id, { name: meta.name, owner })
      ]);
      return reply({ id, success: true }, 201);
    }
    if (uploadMatch && method === 'POST') {
      if (!env.DECK_ASSETS) throw new CommunityError(503, 'Media storage is unavailable.');
      const deck = await db.prepare("SELECT id,status FROM community_decks WHERE id=? AND status!='deleted'").bind(uploadMatch[1]).first();
      if (!deck) throw new CommunityError(404, 'Deck not found.');
      const contentType = (request.headers.get('Content-Type') || '').split(';')[0].toLowerCase();
      const type = MEDIA_TYPES[contentType];
      if (!type) throw new CommunityError(415, 'Use PNG/JPEG images or MP3/M4A/WAV audio.');
      const bytes = await readLimitedBody(request, type.maximum);
      validateMedia(bytes, contentType);
      const id = crypto.randomUUID(), key = `decks/${deck.id}/${id}.${type.extension}`;
      const reserved = await db.prepare(`INSERT INTO community_media(id,deck_id,object_key,content_type,byte_size,created_at)
        SELECT ?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(byte_size),0) FROM community_media WHERE deck_id=?)+?<=?
        AND (SELECT COUNT(*) FROM community_media WHERE deck_id=?)<1000
        AND EXISTS(SELECT 1 FROM community_decks WHERE id=? AND status!='deleted')`)
        .bind(id, deck.id, key, contentType, bytes.length, now(), deck.id, bytes.length, deck.status === 'published' ? 200*1024*1024 : 100*1024*1024, deck.id, deck.id).run();
      if (!reserved.meta.changes) throw new CommunityError(413, 'Deck upload capacity reached.');
      try {
        await env.DECK_ASSETS.put(key, bytes, { httpMetadata: { contentType } });
        const finalized = await db.prepare("UPDATE community_media SET uploaded=1 WHERE id=? AND EXISTS(SELECT 1 FROM community_decks WHERE id=? AND status!='deleted')").bind(id, deck.id).run();
        if (!finalized.meta.changes) throw new CommunityError(409, 'Deck removed while uploading.');
        await audit('upload_media', deck.id, { mediaId: id, contentType, byteSize: bytes.length }).run();
      } catch (error) {
        await env.DECK_ASSETS.delete(key);
        await db.prepare('DELETE FROM community_media WHERE id=?').bind(id).run();
        throw error;
      }
      return reply({ id, contentType, byteSize: bytes.length }, 201);
    }
    const publishMatch = path.match(/^decks\/([a-fA-F0-9-]{36})\/publish$/);
    if (publishMatch && method === 'POST') {
      const body = await readCommunityJSON(request);
      const deck = await db.prepare("SELECT * FROM community_decks WHERE id=? AND status='draft' AND admin_created=1 AND (review_status IS NULL OR (review_status='approved' AND submitted_at IS NULL))").bind(publishMatch[1]).first();
      if (!deck) throw new CommunityError(409, 'Deck is no longer a draft. Reload it.');
      if (deck.revision !== body.expectedRevision) throw new CommunityError(409, 'Deck changed. Reload it before publishing.');
      validateCommunityDeck({ name: deck.name, description: deck.description, categoryTag: deck.category_tag, colorHex: deck.color_hex, deckType: deck.deck_type, cards: JSON.parse(deck.cards_json) });
      const result = await db.batch([
        db.prepare("INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) SELECT ?,?,'publish_deck',?,?,? WHERE EXISTS(SELECT 1 FROM community_decks WHERE id=? AND revision=? AND status='draft')")
          .bind(crypto.randomUUID(), actor, deck.id, JSON.stringify({ name: deck.name }), now(), deck.id, body.expectedRevision),
        db.prepare("UPDATE community_decks SET status='published',review_status='approved',review_message=NULL,reviewed_at=NULL,reviewed_by=NULL,published_at=COALESCE(published_at,?),updated_at=? WHERE id=? AND revision=? AND status='draft'")
          .bind(now(), now(), deck.id, body.expectedRevision)
      ]);
      if (!result[1].meta.changes) throw new CommunityError(409, 'Deck changed while publishing. Reload it.');
      return reply({ success: true });
    }
    if (path === 'overview' && method === 'GET') {
      const [decks, profiles, reports, reviews] = await db.batch([
        db.prepare("SELECT COUNT(*) AS total,SUM(status='published' AND review_status='approved' AND admin_hidden=0) AS published,SUM(admin_hidden=1 AND status!='deleted') AS hidden FROM community_decks WHERE status!='deleted'"),
        db.prepare('SELECT COUNT(*) AS total FROM community_users'),
        db.prepare('SELECT COUNT(*) AS total FROM community_reports WHERE resolved_at IS NULL'),
        db.prepare("SELECT COUNT(*) AS total FROM community_decks WHERE review_status='pending' AND status!='deleted'")
      ]);
      return reply({ actor, decks: decks.results[0], profiles: profiles.results[0].total, reports: reports.results[0].total, pendingReviews: reviews.results[0].total });
    }
    const offset = Math.max(0, Math.min(100000, parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    let list;
    if (method === 'GET' && path === 'reviews') {
      const status = url.searchParams.get('status') || 'pending';
      if (!['pending','approved','rejected'].includes(status)) throw new CommunityError(400, 'Invalid review status.');
      list = await db.prepare(`SELECT d.id,d.name,d.description,d.status,d.review_status,d.review_message,d.submitted_at,d.reviewed_at,d.revision,d.admin_hidden,d.card_count,u.handle
        FROM community_decks d JOIN community_users u ON u.id=d.owner_id WHERE d.status!='deleted' AND d.review_status=? AND d.submitted_at IS NOT NULL
        AND (?='' OR d.name LIKE ? ESCAPE '\\' OR u.handle LIKE ? ESCAPE '\\') ORDER BY d.submitted_at DESC,d.id LIMIT 51 OFFSET ?`)
        .bind(status,q,pattern,pattern,offset).all();
    } else if (method === 'GET' && path === 'decks') {
      list = await db.prepare(`SELECT d.id,d.name,d.description,d.category_tag,d.status,d.admin_hidden,d.card_count,d.download_count,d.created_at,d.updated_at,d.published_at,d.review_status,d.review_message,d.submitted_at,d.reviewed_at,d.revision,d.admin_created,u.handle,
        (SELECT COUNT(*) FROM community_reports r WHERE r.deck_id=d.id AND r.resolved_at IS NULL) AS report_count
        FROM community_decks d JOIN community_users u ON u.id=d.owner_id
        WHERE (?='' OR d.name LIKE ? ESCAPE '\\' OR u.handle LIKE ? ESCAPE '\\') ORDER BY d.created_at DESC,d.id LIMIT 51 OFFSET ?`).bind(q, pattern, pattern, offset).all();
    } else if (method === 'GET' && path === 'profiles') {
      list = await db.prepare(`SELECT u.id,u.handle,u.avatar_json,u.profile_completed,u.created_at,
        (SELECT COUNT(*) FROM community_decks d WHERE d.owner_id=u.id AND d.status!='deleted') AS deck_count
        FROM community_users u WHERE (?='' OR u.handle LIKE ? ESCAPE '\\') ORDER BY u.created_at DESC,u.id LIMIT 51 OFFSET ?`).bind(q, pattern, offset).all();
    } else if (method === 'GET' && path === 'reports') {
      const resolved = url.searchParams.get('resolved') === 'true' ? 1 : 0;
      list = await db.prepare(`SELECT r.*,d.name,d.status,d.admin_hidden,owner.handle AS owner_handle,reporter.handle AS reporter_handle
        FROM community_reports r JOIN community_decks d ON d.id=r.deck_id
        JOIN community_users owner ON owner.id=d.owner_id JOIN community_users reporter ON reporter.id=r.user_id
        WHERE (r.resolved_at IS NOT NULL)=? AND (?='' OR d.name LIKE ? ESCAPE '\\' OR r.reason LIKE ? ESCAPE '\\')
        ORDER BY r.created_at DESC,r.deck_id,r.user_id LIMIT 51 OFFSET ?`).bind(resolved, q, pattern, pattern, offset).all();
    } else if (method === 'GET' && path === 'audit') {
      list = await db.prepare('SELECT * FROM community_admin_audit ORDER BY created_at DESC,id LIMIT 51 OFFSET ?').bind(offset).all();
    }
    if (list) return reply({ items: list.results.slice(0, 50), nextOffset: list.results.length > 50 ? offset + 50 : null });
    const reviewMatch = path.match(/^decks\/([a-fA-F0-9-]{36})\/review$/);
    if (reviewMatch && method === 'POST') {
      const body = await readCommunityJSON(request);
      if (!body || !['approve','reject'].includes(body.decision) || !Number.isSafeInteger(body.expectedRevision)) throw new CommunityError(400, 'Choose a valid review decision and revision.');
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      if (body.decision === 'reject' && (!reason || reason.length > 1000)) throw new CommunityError(400, 'Give a rejection reason of 1–1000 characters.');
      const deck = await db.prepare("SELECT * FROM community_decks WHERE id=? AND status='draft' AND review_status='pending'").bind(reviewMatch[1]).first();
      if (!deck || deck.revision !== body.expectedRevision) throw new CommunityError(409, 'Submission changed or was already reviewed. Refresh it before deciding.');
      if (body.decision === 'approve') {
        const { media } = validateCommunityDeck({ name: deck.name, description: deck.description, categoryTag: deck.category_tag, colorHex: deck.color_hex, deckType: deck.deck_type, cards: JSON.parse(deck.cards_json) });
        const uploads = (await db.prepare('SELECT id,content_type,byte_size FROM community_media WHERE deck_id=? AND uploaded=1 AND attached=1 AND deleting=0').bind(deck.id).all()).results;
        let bytes = 0;
        for (const [reference,kind] of media) {
          const upload = uploads.find(row => row.id === reference);
          if (!upload || !upload.content_type.startsWith(`${kind}/`)) throw new CommunityError(409, 'Submission has an unavailable attachment. Ask the author to resubmit.');
          bytes += upload.byte_size;
        }
        if (bytes > 100*1024*1024 || media.size > 1000) throw new CommunityError(413, 'Submission exceeds media limits.');
      }
      const approved = body.decision === 'approve';
      const result = await db.batch([
        db.prepare("INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM community_decks WHERE id=? AND revision=? AND status='draft' AND review_status='pending')")
          .bind(crypto.randomUUID(),actor,approved ? 'approve_deck' : 'reject_deck',deck.id,JSON.stringify({ name: deck.name, submittedAt: deck.submitted_at, revision: deck.revision, reason: approved ? null : reason }),now(),deck.id,body.expectedRevision),
        db.prepare("UPDATE community_decks SET status=?,review_status=?,review_message=?,reviewed_at=?,reviewed_by=?,updated_at=?,published_at=CASE WHEN ? THEN COALESCE(published_at,?) ELSE published_at END WHERE id=? AND revision=? AND status='draft' AND review_status='pending'")
          .bind(approved ? 'published' : 'draft',approved ? 'approved' : 'rejected',approved ? null : reason,now(),actor,now(),approved ? 1 : 0,now(),deck.id,body.expectedRevision)
      ]);
      if (!result[1].meta.changes) throw new CommunityError(409, 'Submission changed while reviewing. Refresh it.');
      return reply({ success: true, reviewStatus: approved ? 'approved' : 'rejected' });
    }
    const detail = path.match(/^decks\/([a-fA-F0-9-]{36})$/);
    if (detail && method === 'PUT') {
      const body = await readCommunityJSON(request);
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new CommunityError(400, 'Reload the deck before editing.');
      if (!Number.isSafeInteger(body.downloadCount) || body.downloadCount < 0 || body.downloadCount > 2147483647) throw new CommunityError(400, 'Downloads must be a whole number from 0 to 2147483647.');
      const current = await db.prepare("SELECT * FROM community_decks WHERE id=? AND status!='deleted'").bind(detail[1]).first();
      if (!current) throw new CommunityError(404, 'Deck not found or already deleted.');
      if (current.revision !== body.expectedRevision) throw new CommunityError(409, 'This deck changed since you opened it. Reload it before saving.');
      const { metadata: meta, cards, media } = validateCommunityDeck(body);
      const uploads = (await db.prepare('SELECT id,content_type,byte_size FROM community_media WHERE deck_id=? AND uploaded=1 AND deleting=0').bind(detail[1]).all()).results;
      let bytes = 0;
      for (const [id, kind] of media) {
        const upload = uploads.find(row => row.id === id);
        if (!upload || !upload.content_type.startsWith(`${kind}/`)) throw new CommunityError(400, 'Attachments must belong to this deck and match the image/audio field.');
        bytes += upload.byte_size;
      }
      if (bytes > 100 * 1024 * 1024 || media.size > 1000) throw new CommunityError(413, 'A deck supports up to 100 MB of media and 1,000 attachments.');
      const guard = "EXISTS(SELECT 1 FROM community_decks WHERE id=? AND revision=? AND status!='deleted')";
      const statements = [
        db.prepare(`INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) SELECT ?,?,'edit_deck',?,?,? WHERE ${guard}`)
          .bind(crypto.randomUUID(), actor, detail[1], JSON.stringify({ before: { name: current.name, description: current.description, categoryTag: current.category_tag, colorHex: current.color_hex, deckType: current.deck_type, downloadCount: current.download_count, cards: JSON.parse(current.cards_json) }, after: { ...meta, cardCount: cards.length, downloadCount: body.downloadCount } }), now(), detail[1], body.expectedRevision),
        db.prepare(`UPDATE community_media SET attached=0 WHERE deck_id=? AND ${guard}`).bind(detail[1], detail[1], body.expectedRevision)
      ];
      const ids = [...media.keys()];
      for (let start = 0; start < ids.length; start += 85) {
        const chunk = ids.slice(start, start + 85);
        statements.push(db.prepare(`UPDATE community_media SET attached=1 WHERE deck_id=? AND id IN (${chunk.map(() => '?').join(',')}) AND ${guard}`).bind(detail[1], ...chunk, detail[1], body.expectedRevision));
      }
      statements.push(db.prepare(`UPDATE community_decks SET name=?,description=?,category_tag=?,color_hex=?,deck_type=?,cards_json=?,card_count=?,download_count=?,updated_at=?
        WHERE id=? AND revision=? AND status!='deleted'`).bind(meta.name, meta.description, meta.categoryTag, meta.colorHex, meta.deckType, JSON.stringify(cards), cards.length, body.downloadCount, now(), detail[1], body.expectedRevision));
      const result = await db.batch(statements);
      if (!result.at(-1).meta.changes) throw new CommunityError(409, 'This deck changed while saving. Reload it before saving.');
      return reply({ success: true });
    }
    if (detail && method === 'DELETE') {
      const deck = await db.prepare("SELECT name,status FROM community_decks WHERE id=? AND status!='deleted'").bind(detail[1]).first();
      if (!deck) throw new CommunityError(404, 'Deck not found or already deleted.');
      await db.batch([
        db.prepare('INSERT OR IGNORE INTO community_deleted_objects(object_key,created_at) SELECT object_key,? FROM community_media WHERE deck_id=?').bind(now(), detail[1]),
        db.prepare('DELETE FROM community_decks WHERE id=?').bind(detail[1]),
        audit('delete_deck', detail[1], { name: deck.name, previousStatus: deck.status })
      ]);
      return reply({ success: true });
    }
    if (detail && method === 'GET') {
      const deck = await db.prepare('SELECT d.*,u.handle FROM community_decks d JOIN community_users u ON u.id=d.owner_id WHERE d.id=?').bind(detail[1]).first();
      if (!deck) throw new CommunityError(404, 'Deck not found.');
      return reply({ deck: { ...deck, cards: JSON.parse(deck.cards_json), cards_json: undefined } });
    }
    const media = path.match(/^media\/([a-fA-F0-9-]{36})$/);
    if (media && method === 'GET') {
      const row = await db.prepare('SELECT * FROM community_media WHERE id=? AND uploaded=1 AND deleting=0').bind(media[1]).first();
      const object = row && env.DECK_ASSETS && await env.DECK_ASSETS.get(row.object_key);
      if (!object) throw new CommunityError(404, 'Attachment unavailable.');
      return new Response(object.body, { headers: { 'Content-Type': row.content_type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (detail && method === 'PATCH') {
      const body = await readCommunityJSON(request);
      if (typeof body.hidden !== 'boolean') throw new CommunityError(400, 'Choose a visibility state.');
      const deck = await db.prepare("SELECT admin_hidden FROM community_decks WHERE id=? AND status!='deleted'").bind(detail[1]).first();
      if (!deck) throw new CommunityError(404, 'Deck not found or already deleted.');
      await db.batch([
        db.prepare("UPDATE community_decks SET admin_hidden=?,updated_at=? WHERE id=? AND status!='deleted'").bind(body.hidden ? 1 : 0, now(), detail[1]),
        audit(body.hidden ? 'hide_deck' : 'restore_deck', detail[1], { before: deck.admin_hidden, hidden: body.hidden })
      ]);
      return reply({ success: true });
    }
    if (path === 'profiles/delete' && method === 'POST') {
      const body = await readCommunityJSON(request);
      if (typeof body.id !== 'string' || !body.id || body.id.length > 255) throw new CommunityError(400, 'Invalid profile.');
      const profile = await db.prepare('SELECT handle FROM community_users WHERE id=?').bind(body.id).first();
      if (!profile) throw new CommunityError(404, 'Profile not found.');
      const count = await db.prepare('SELECT COUNT(*) AS total FROM community_decks WHERE owner_id=?').bind(body.id).first();
      // Match account deletion: queue R2 keys before deleting the SQL rows.
      // Sessions cascade, and public content disappears immediately.
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO community_deleted_objects(object_key,created_at)
          SELECT m.object_key,? FROM community_media m JOIN community_decks d ON d.id=m.deck_id WHERE d.owner_id=?`).bind(now(), body.id),
        db.prepare('DELETE FROM community_reports WHERE user_id=?').bind(body.id),
        db.prepare('DELETE FROM community_decks WHERE owner_id=?').bind(body.id),
        db.prepare('DELETE FROM community_users WHERE id=?').bind(body.id),
        audit('delete_profile', body.id, { handle: profile.handle, decks: count.total })
      ]);
      return reply({ success: true });
    }
    if (path === 'reports/delete' && method === 'POST') {
      const body = await readCommunityJSON(request);
      if (typeof body.deckId !== 'string' || typeof body.userId !== 'string' || !Number.isInteger(body.createdAt)) throw new CommunityError(400, 'Invalid report.');
      // Delete and audit from the same report snapshot in one transaction.
      const result = await db.batch([
        db.prepare(`INSERT INTO community_admin_audit(id,actor,action,target,details,created_at)
          SELECT ?,?,'delete_report',deck_id,json_object('reporter',user_id,'reason',reason),?
          FROM community_reports WHERE deck_id=? AND user_id=? AND created_at=?`)
          .bind(crypto.randomUUID(), actor, now(), body.deckId, body.userId, body.createdAt),
        db.prepare('DELETE FROM community_reports WHERE deck_id=? AND user_id=? AND created_at=?').bind(body.deckId, body.userId, body.createdAt)
      ]);
      if (!result[1].meta.changes) throw new CommunityError(409, 'Report changed or was deleted. Refresh the list.');
      return reply({ success: true });
    }
    if (path === 'reports/resolve' && method === 'POST') {
      const body = await readCommunityJSON(request);
      if (typeof body.deckId !== 'string' || typeof body.userId !== 'string' || !Number.isInteger(body.createdAt)) throw new CommunityError(400, 'Invalid report.');
      // Optimistic check prevents a newly re-filed report being resolved from a stale screen.
      const report = await db.prepare('SELECT * FROM community_reports WHERE deck_id=? AND user_id=? AND created_at=? AND resolved_at IS NULL')
        .bind(body.deckId, body.userId, body.createdAt).first();
      if (!report) throw new CommunityError(409, 'Report changed. Refresh the list.');
      await db.batch([
        db.prepare('UPDATE community_reports SET resolved_at=?,resolved_by=? WHERE deck_id=? AND user_id=? AND created_at=? AND resolved_at IS NULL')
          .bind(now(), actor, body.deckId, body.userId, body.createdAt),
        audit('resolve_report', body.deckId, { reporter: body.userId, reason: report.reason })
      ]);
      return reply({ success: true });
    }
    if (path === 'profiles/update' && method === 'POST') {
      const body = await readCommunityJSON(request);
      if (typeof body.id !== 'string' || body.id.length > 255) throw new CommunityError(400, 'Invalid profile.');
      const current = await db.prepare('SELECT * FROM community_users WHERE id=?').bind(body.id).first();
      if (!current) throw new CommunityError(404, 'Profile not found.');
      const profile = validateCommunityProfile({ username: body.username, avatar: JSON.parse(current.avatar_json) });
      if (await db.prepare('SELECT id FROM community_users WHERE handle=? COLLATE NOCASE AND id!=?').bind(profile.handle, body.id).first()) throw new CommunityError(409, 'Username already in use.');
      await db.batch([
        db.prepare('UPDATE community_users SET handle=? WHERE id=?').bind(profile.handle, body.id),
        audit('rename_profile', body.id, { before: current.handle, after: profile.handle })
      ]);
      return reply({ success: true });
    }
    throw new CommunityError(404, 'Admin endpoint not found.');
  } catch (error) {
    if (String(error.message).includes('community_attachment_unavailable')) return reply({ error: { message: 'An attachment is unavailable. Reload the deck and remove or replace its reference.' } }, 409);
    if (error instanceof CommunityError) return reply({ error: { message: error.message } }, error.status);
    if (String(error.message).includes('UNIQUE constraint')) return reply({ error: { message: 'Username already in use.' } }, 409);
    console.error('Admin request failed', error);
    return reply({ error: { message: 'Admin request failed. Please refresh and try again.' } }, 500);
  }
}
