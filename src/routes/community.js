import { json, apiError } from '../lib/http.js';
import { communityUser, sha256, verifyAppleIdentity } from '../lib/communityAuth.js';
import { CommunityError, readCommunityJSON, readLimitedBody, deckMetadata, validateCommunityDeck, MEDIA_TYPES, validateMedia } from '../lib/communityValidation.js';

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
function deckResponse(row, detail = false) {
  return { id: row.id, name: row.name, description: row.description, authorHandle: row.handle,
    categoryTag: row.category_tag, colorHex: row.color_hex, deckType: row.deck_type,
    cardCount: row.card_count, downloadCount: row.download_count, publishedAt: row.published_at,
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

  if (path === '/v1/community/account' && method === 'DELETE') {
    const user = await communityUser(request, env);
    // Preserve object keys in a deletion queue before cascading their SQL rows.
    // Public access and every session end immediately, even if R2 is unavailable.
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO community_deleted_objects(object_key,created_at)
        SELECT m.object_key,? FROM community_media m JOIN community_decks d ON d.id=m.deck_id
        WHERE d.owner_id=?`).bind(now(), user.id),
      db.prepare('DELETE FROM community_reports WHERE user_id=?').bind(user.id),
      db.prepare('DELETE FROM community_decks WHERE owner_id=?').bind(user.id),
      db.prepare('DELETE FROM community_users WHERE id=?').bind(user.id)
    ]);
    return json({ success: true });
  }

  if (path === '/v1/community/auth/apple' && method === 'POST') {
    const body = await readCommunityJSON(request);
    if (typeof body.identityToken !== 'string' || body.identityToken.length > 12000 ||
        typeof body.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(body.nonce)) {
      throw new CommunityError(400, 'Invalid sign-in request.');
    }
    const id = await verifyAppleIdentity(body.identityToken, body.nonce, env.APPLE_CLIENT_ID || 'com.learnalert.app');
    const suffix = (await sha256(id)).slice(0, 8);
    const requested = typeof body.givenName === 'string' ? body.givenName.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) : '';
    const handle = `@${requested || 'learner'}_${suffix}`;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const expiresAt = now() + 30 * 86400;
    await db.batch([
      db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING').bind(id, handle, now()),
      db.prepare('DELETE FROM community_sessions WHERE user_id=? AND expires_at<=?').bind(id, now()),
      db.prepare('INSERT INTO community_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(token), id, expiresAt)
    ]);
    const user = await db.prepare('SELECT handle FROM community_users WHERE id=?').bind(id).first();
    return json({ token, expiresAt, handle: user.handle }, 201);
  }

  if (path === '/v1/community/decks' && method === 'GET') {
    const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '30', 10) || 30));
    const offset = Math.min(100000, Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0));
    const search = (url.searchParams.get('q') || '').trim().slice(0, 120);
    const category = (url.searchParams.get('category') || '').trim().slice(0, 60);
    // Escape LIKE wildcards so a user's search is interpreted literally.
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const { results } = await db.prepare(`SELECT d.*, u.handle FROM community_decks d JOIN community_users u ON u.id=d.owner_id
      WHERE d.status='published' AND (?='' OR d.category_tag=? COLLATE NOCASE)
      AND (?='' OR d.name LIKE ? ESCAPE '\\' OR d.description LIKE ? ESCAPE '\\' OR u.handle LIKE ? ESCAPE '\\')
      ORDER BY d.published_at DESC, d.id DESC LIMIT ? OFFSET ?`)
      .bind(category, category, search, pattern, pattern, pattern, limit + 1, offset).all();
    return json({ decks: results.slice(0, limit).map(row => deckResponse(row)), nextOffset: results.length > limit ? offset + limit : null });
  }

  if (path === '/v1/community/decks/drafts' && method === 'POST') {
    const user = await communityUser(request, env);
    const meta = deckMetadata(await readCommunityJSON(request));
    const id = crypto.randomUUID();
    const result = await db.prepare(`INSERT INTO community_decks(id,owner_id,name,description,category_tag,color_hex,deck_type,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE
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
    const row = await db.prepare(`SELECT m.*, d.owner_id,d.status FROM community_media m
      JOIN community_decks d ON d.id=m.deck_id WHERE m.id=? AND m.uploaded=1 AND m.deleting=0 AND d.status!='deleted'`).bind(mediaMatch[1]).first();
    if (!row) throw new CommunityError(404, 'Attachment not found.');
    if (row.status !== 'published' || !row.attached) {
      const user = await communityUser(request, env, false);
      if (!user || user.id !== row.owner_id) throw new CommunityError(404, 'Attachment not found.');
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
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1000) throw new CommunityError(400, 'Please give a reason for reporting this deck.');
    const result = await db.prepare(`INSERT INTO community_reports(deck_id,user_id,reason,created_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM community_decks WHERE id=? AND status='published')
      ON CONFLICT(deck_id,user_id) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at`)
      .bind(reportMatch[1], user.id, body.reason.trim(), now(), reportMatch[1]).run();
    if (!result.meta.changes) throw new CommunityError(404, 'Deck not found.');
    return json({ success: true });
  }

  const deckMatch = path.match(new RegExp(`^/v1/community/decks/(${uuidPattern})$`));
  if (deckMatch) {
    const id = deckMatch[1];
    if (method === 'GET') {
      const row = await db.prepare(`SELECT d.*,u.handle FROM community_decks d JOIN community_users u ON u.id=d.owner_id WHERE d.id=? AND d.status='published'`).bind(id).first();
      if (!row) throw new CommunityError(404, 'Deck not found.');
      await db.prepare("UPDATE community_decks SET download_count=download_count+1 WHERE id=? AND status='published'").bind(id).run();
      return json({ deck: deckResponse({ ...row, download_count: row.download_count + 1 }, true) });
    }
    const user = await communityUser(request, env);
    await ownedDeck(env, id, user);
    if (method === 'PUT' || method === 'PATCH') {
      const { metadata: meta, cards, media } = validateCommunityDeck(await readCommunityJSON(request));
      const { results: uploads } = await db.prepare('SELECT id,content_type,byte_size FROM community_media WHERE deck_id=? AND uploaded=1 AND deleting=0').bind(id).all();
      let publishedBytes = 0;
      for (const [reference, kind] of media) {
        const upload = uploads.find(item => item.id === reference);
        if (!upload || !upload.content_type.startsWith(`${kind}/`)) throw new CommunityError(400, 'Every attachment must be uploaded to this deck before publishing.');
        publishedBytes += upload.byte_size;
      }
      if (publishedBytes > maxDeckBytes || media.size > 1000) throw new CommunityError(413, 'A shared deck can contain up to 100 MB of media and 1,000 attachments.');
      const statements = [db.prepare('UPDATE community_media SET attached=0 WHERE deck_id=?').bind(id)];
      // Each prepared statement stays below D1's bind parameter limit.
      const mediaIDs = [...media.keys()];
      for (let start = 0; start < mediaIDs.length; start += 90) {
        const chunk = mediaIDs.slice(start, start + 90);
        statements.push(db.prepare(`UPDATE community_media SET attached=1 WHERE deck_id=? AND id IN (${chunk.map(() => '?').join(',')})`).bind(id, ...chunk));
      }
      statements.push(db.prepare(`UPDATE community_decks SET name=?,description=?,category_tag=?,color_hex=?,deck_type=?,cards_json=?,card_count=?,status='published',published_at=COALESCE(published_at,?),updated_at=? WHERE id=? AND owner_id=? AND status!='deleted'`)
        .bind(meta.name, meta.description, meta.categoryTag, meta.colorHex, meta.deckType, JSON.stringify(cards), cards.length, now(), now(), id, user.id));
      const results = await db.batch(statements);
      if (!results.at(-1).meta.changes) throw new CommunityError(409, 'This deck was removed while publishing.');
      return json({ id, success: true });
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
    if (error instanceof CommunityError) return apiError('COMMUNITY_ERROR', error.message, error.status, requestId);
    console.error('Community request failed', requestId, error);
    return apiError('COMMUNITY_ERROR', 'The community library is temporarily unavailable. Please try again.', 500, requestId);
  }
}

export async function cleanupCommunity(env) {
  if (!env.COMMUNITY_DB || !env.DECK_ASSETS) return;
  const db = env.COMMUNITY_DB;
  await db.batch([
    db.prepare('DELETE FROM community_sessions WHERE expires_at<=?').bind(now()),
    db.prepare("UPDATE community_decks SET status='deleted' WHERE status='draft' AND updated_at<?").bind(now() - 86400)
  ]);
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
