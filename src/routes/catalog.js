import { catalogSpeech } from '../lib/catalogSpeech.js';
import { adminIdentity } from '../lib/adminAuth.js';
import { CommunityError, MEDIA_TYPES, readLimitedBody, validateMedia } from '../lib/communityValidation.js';
import { catalogIDPattern, expectedCatalogRevision, readCatalogJSON, validateCatalogContent } from '../lib/catalogValidation.js';

const seconds = () => Math.floor(Date.now() / 1000);
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function reply(body, status = 200, isPublic = false) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(isPublic ? { 'Access-Control-Allow-Origin': '*' } : { 'X-Robots-Tag': 'noindex, nofollow' }) } });
}
function summary(row) {
  return { id: row.id, kind: row.kind, title: row.title, subtitle: row.subtitle, language: row.language, colorHex: row.color_hex, status: row.status, revision: row.revision, publishedRevision: row.published_revision, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at, updatedBy: row.updated_by, ...JSON.parse(row.summary_json) };
}
async function documentFor(env, key) {
  const object = await env.DECK_ASSETS.get(key);
  if (!object) throw new CommunityError(503, 'This content snapshot is temporarily unavailable.');
  return object.json();
}
function mediaReferences(document) {
  const references = new Map();
  // Scan values, not keys. Future attachment fields keep ownership checks too.
  function visit(value, field = '') {
    if (typeof value === 'string' && value.startsWith('catalog:')) {
      const id = value.slice(8); if (!uuidPattern.test(id)) throw new CommunityError(400, 'Invalid catalog media reference.');
      const kind = /^(image|imageID)$|Image(?:ID|Name|IDs|Names)$/.test(field) ? 'image' : /^(audio|audioID)$|Audio(?:ID|Name|IDs|Names)$/.test(field) ? 'audio' : null;
      if (!references.has(id)) references.set(id, new Set());
      if (kind) references.get(id).add(kind);
    } else if (Array.isArray(value)) value.forEach(item => visit(item, field));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([key,item]) => visit(item,key));
  }
  visit(document); return references;
}
function note(body) {
  if (body.note == null) return '';
  if (typeof body.note !== 'string' || body.note.length > 4000) throw new CommunityError(400, 'Revision notes support up to 4,000 characters.');
  return body.note.trim();
}
async function checkMedia(db, id, document) {
  const references = mediaReferences(document);
  if (references.size) {
    const rows = (await db.prepare('SELECT id,content_type FROM managed_catalog_media WHERE catalog_id=?').bind(id).all()).results;
    const available = new Map(rows.map(row => [row.id,row.content_type]));
    for (const [reference,kinds] of references) {
      if (!available.has(reference)) throw new CommunityError(400, 'Upload each referenced image/audio file to this course or deck before publishing.');
      if ([...kinds].some(kind => !available.get(reference).startsWith(kind + '/'))) throw new CommunityError(400, 'An image/audio reference does not match its attachment field.');
    }
  }
  return [...references.keys()];
}
function replaceMediaReferences(value, replacements) {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map(item => replaceMediaReferences(item, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,replaceMediaReferences(item,replacements)]));
  return value;
}
async function cloneMedia(env, sourceID, targetID, document, pendingKeys) {
  if (typeof sourceID !== 'string' || !catalogIDPattern.test(sourceID)) throw new CommunityError(400, 'Choose a valid source catalog ID.');
  await current(env.COMMUNITY_DB, sourceID);
  const references = await checkMedia(env.COMMUNITY_DB, sourceID, document);
  const rows = new Map((await env.COMMUNITY_DB.prepare('SELECT * FROM managed_catalog_media WHERE catalog_id=?').bind(sourceID).all()).results.map(row => [row.id,row]));
  const replacements = new Map(), cloned = [];
  for (const reference of references) {
    const source = rows.get(reference), type = MEDIA_TYPES[source.content_type];
    if (!type) throw new CommunityError(400, 'This source attachment cannot be duplicated.');
    const object = await env.DECK_ASSETS.get(source.object_key);
    if (!object) throw new CommunityError(503, 'A source attachment is temporarily unavailable. Duplicate again after it is restored.');
    const id = crypto.randomUUID(), key = `catalog/media/${targetID}/${id}.${type.extension}`;
    pendingKeys.push(key);
    await env.DECK_ASSETS.put(key, object.body, { httpMetadata: { contentType: source.content_type } });
    cloned.push({ id, key, contentType: source.content_type, byteSize: source.byte_size });
    replacements.set(`catalog:${reference}`, `catalog:${id}`);
  }
  return { document: replaceMediaReferences(document, replacements), media: cloned };
}
async function removePendingObjects(bucket, keys) {
  for (let start = 0; start < keys.length; start += 1000) await bucket.delete(keys.slice(start,start+1000));
}
function audit(db, actor, id, action, details, expectedRevision) {
  return db.prepare(`INSERT INTO community_admin_audit(id,actor,action,target,details,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_catalog WHERE id=? AND revision=?)`)
    .bind(crypto.randomUUID(), actor, `catalog_${action}`, id, JSON.stringify(details), seconds(), id, expectedRevision);
}
async function itemFor(env, row) { return { ...summary(row), document: await documentFor(env, row.draft_key) }; }
async function current(db, id) {
  const row = await db.prepare('SELECT * FROM managed_catalog WHERE id=?').bind(id).first();
  if (!row) throw new CommunityError(404, 'Catalog item not found.');
  return row;
}
function requireRevision(row, body) {
  const expected = expectedCatalogRevision(body);
  if (expected !== row.revision) throw new CommunityError(409, 'This content changed since you opened it. Reload before saving.', 'CATALOG_CONFLICT');
  return expected;
}
function revisionInsert(db, row, revision, action, key, actor, body, isPublished = false) {
  return db.prepare(`INSERT INTO managed_catalog_revisions(catalog_id,revision,action,content_key,actor,note,created_at,published)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_catalog WHERE id=? AND revision=?)`)
    .bind(row.id, revision, action, key, actor, note(body), seconds(), isPublished ? 1 : 0, row.id, row.revision);
}
function advanceState(db, row, initialize = false) {
  return db.prepare(`UPDATE managed_catalog_state SET revision=revision+1,initialized=MAX(initialized,?) WHERE id=1
    AND EXISTS(SELECT 1 FROM managed_catalog WHERE id=? AND revision=?)`).bind(initialize ? 1 : 0, row.id, row.revision);
}
function metadata(document, validated) {
  return [validated.title, document.subtitle ?? document.levelTag ?? document.subcategory ?? '', document.language ?? null, document.colorHex, JSON.stringify(validated.summary)];
}
function sortOrder(body, fallback = 0) {
  const value = body.sortOrder ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new CommunityError(400, 'Sort order must be a finite number.');
  return value;
}
async function saveDraft(env, row, body, actor, document, action = 'save') {
  requireRevision(row, body);
  const validated = validateCatalogContent(row.kind, document, row.id);
  const revision = row.revision + 1, stamp = seconds(), key = `catalog/documents/${row.id}/${crypto.randomUUID()}.json`;
  const order = sortOrder(body, row.sort_order);
  const revisionNote = note(body); // Validate before uploading to avoid orphan objects.
  await env.DECK_ASSETS.put(key, JSON.stringify(document), { httpMetadata: { contentType: 'application/json' } });
  try {
    const result = await env.COMMUNITY_DB.batch([
      revisionInsert(env.COMMUNITY_DB, row, revision, action, key, actor, { ...body, note: revisionNote }),
      audit(env.COMMUNITY_DB, actor, row.id, action, { revision, previousRevision: row.revision, title: validated.title, note: revisionNote }, row.revision),
      advanceState(env.COMMUNITY_DB, row),
      env.COMMUNITY_DB.prepare(`UPDATE managed_catalog SET title=?,subtitle=?,language=?,color_hex=?,summary_json=?,draft_key=?,revision=?,sort_order=?,status=CASE WHEN status='archived' THEN 'draft' ELSE status END,archived_at=NULL,updated_at=?,updated_by=? WHERE id=? AND revision=?`)
        .bind(...metadata(document, validated), key, revision, order, stamp, actor, row.id, row.revision)
    ]);
    if (!result.at(-1).meta.changes) throw new CommunityError(409, 'This content changed while saving. Reload it.', 'CATALOG_CONFLICT');
  } catch (error) { await env.DECK_ASSETS.delete(key); throw error; }
  return current(env.COMMUNITY_DB, row.id);
}
async function mediaResponse(request, env, id, isPublic) {
  if (!uuidPattern.test(id)) throw new CommunityError(404, 'Media not found.');
  const query = isPublic
    ? `SELECT m.* FROM managed_catalog_media m JOIN managed_catalog_public_media p ON p.media_id=m.id JOIN managed_catalog c ON c.id=p.catalog_id WHERE m.id=? AND c.status='published' AND c.published_key IS NOT NULL`
    : 'SELECT * FROM managed_catalog_media WHERE id=?';
  const row = await env.COMMUNITY_DB.prepare(query).bind(id).first();
  if (!row) throw new CommunityError(404, 'Media not found.');
  const object = await env.DECK_ASSETS.get(row.object_key);
  if (!object) throw new CommunityError(404, 'Media not found.');
  return new Response(request.method === 'HEAD' ? null : object.body, { headers: { 'Content-Type': row.content_type, 'Content-Length': String(row.byte_size), 'Cache-Control': isPublic ? 'public, max-age=300' : 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline', ...(isPublic ? { 'Access-Control-Allow-Origin': '*' } : { 'X-Robots-Tag': 'noindex, nofollow' }) } });
}

export async function adminCatalog(request, env) {
  try {
    const actor = await adminIdentity(request, env);
    if (!env.COMMUNITY_DB || !env.DECK_ASSETS) throw new CommunityError(503, 'Catalog storage is unavailable.');
    const db = env.COMMUNITY_DB, url = new URL(request.url), method = request.method;
    const path = url.pathname.slice('/v1/admin/catalog'.length).replace(/^\//, '');
    const upload = path.match(/^([^/]+)\/media$/);
    if (!['GET','HEAD'].includes(method) && (request.headers.get('Origin') !== 'https://learnalertapp.com' || (!upload && request.headers.get('Content-Type')?.split(';')[0] !== 'application/json'))) throw new CommunityError(403, 'Invalid admin request origin.');
    const speech = path.match(/^([^/]+)\/speech(?:\/(budgets|[a-f0-9]{64}))?$/);
    if ((path === 'speech/status' && method === 'GET') || (speech && catalogIDPattern.test(speech[1]) &&
        ((!speech[2] && method === 'POST') || (speech[2] === 'budgets' && ['GET','POST'].includes(method)) || (speech[2] && speech[2] !== 'budgets' && method === 'GET')))) {
      try {
        const result = await catalogSpeech(request,env,actor,speech?.[1],path === 'speech/status' ? 'status' : speech[2] === 'budgets' ? 'budgets' : speech[2] ? 'job' : 'generate',speech?.[2]);
        const response = reply(result.body,result.status || 200);
        if (result.retryAfter) response.headers.set('Retry-After',result.retryAfter);
        return response;
      } catch (error) {
        if (error instanceof CommunityError) return reply({error:{code:error.code,message:error.message}},error.status);
        // Avoid leaking prompts/credentials through raw upstream/storage errors.
        return reply({error:{code:'TTS_UNAVAILABLE',message:'Speech is unavailable. Check saved request status before retrying.'}},503);
      }
    }
    if (!path && method === 'GET') {
      const kind = url.searchParams.get('kind');
      if (kind && !['course','exam'].includes(kind)) throw new CommunityError(400, 'Invalid catalog kind.');
      const rows = kind ? await db.prepare('SELECT * FROM managed_catalog WHERE kind=? ORDER BY sort_order,title,id').bind(kind).all() : await db.prepare('SELECT * FROM managed_catalog ORDER BY kind,sort_order,title,id').all();
      return reply({ items: rows.results.map(summary) });
    }
    if (path === 'validate' && method === 'POST') {
      const body = await readCatalogJSON(request);
      const id = body.id ?? body.document?.id;
      const validated = validateCatalogContent(body.kind, body.document, id, { publish: true });
      await checkMedia(db, id, body.document);
      return reply({ valid: true, errors: [], warnings: [], summary: validated.summary });
    }
    if (!path && method === 'POST') {
      const body = await readCatalogJSON(request), { id, kind } = body;
      let document = body.document;
      const validated = validateCatalogContent(kind, document, id), stamp = seconds(), key = `catalog/documents/${id}/${crypto.randomUUID()}.json`, order = sortOrder(body), revisionNote = note(body), pendingKeys = [];
      if (await db.prepare('SELECT id FROM managed_catalog WHERE id=?').bind(id).first()) throw new CommunityError(409, 'This catalog ID already exists. Open it or choose a new stable ID.');
      try {
        let cloned = [];
        if (body.sourceCatalogID !== undefined) {
          const result = await cloneMedia(env, body.sourceCatalogID, id, document, pendingKeys);
          document = result.document; cloned = result.media;
        }
        pendingKeys.push(key);
        await env.DECK_ASSETS.put(key, JSON.stringify(document), { httpMetadata: { contentType: 'application/json' } });
        const mediaInserts = [];
        for (let start = 0; start < cloned.length; start += 10) {
          const chunk = cloned.slice(start,start+10);
          mediaInserts.push(db.prepare(`INSERT INTO managed_catalog_media(id,catalog_id,object_key,content_type,byte_size,created_at,actor) ${chunk.map(() => 'SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_catalog WHERE id=? AND draft_key=?)').join(' UNION ALL ')}`)
            .bind(...chunk.flatMap(media => [media.id,id,media.key,media.contentType,media.byteSize,stamp,actor,id,key])));
        }
        const result = await db.batch([
          db.prepare(`INSERT INTO managed_catalog(id,kind,title,subtitle,language,color_hex,summary_json,draft_key,created_at,updated_at,updated_by,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
            .bind(id, kind, ...metadata(document, validated), key, stamp, stamp, actor, order),
          ...mediaInserts,
          db.prepare(`INSERT INTO managed_catalog_revisions(catalog_id,revision,action,content_key,actor,note,created_at) SELECT ?,1,'create',?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_catalog WHERE id=? AND draft_key=?)`).bind(id, key, actor, revisionNote, stamp, id, key),
          db.prepare(`INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) SELECT ?,?,'catalog_create',?,?,? WHERE EXISTS(SELECT 1 FROM managed_catalog WHERE id=? AND draft_key=?)`).bind(crypto.randomUUID(), actor, id, JSON.stringify({ kind, title: validated.title, ...(body.sourceCatalogID ? { sourceCatalogID: body.sourceCatalogID, clonedMediaCount: cloned.length } : {}) }), stamp, id, key),
          db.prepare('UPDATE managed_catalog_state SET revision=revision+1 WHERE id=1 AND EXISTS(SELECT 1 FROM managed_catalog WHERE id=? AND draft_key=?)').bind(id,key)
        ]);
        if (!result[0].meta.changes) throw new CommunityError(409, 'This catalog ID already exists. Open it or choose a new stable ID.');
      } catch(error) { await removePendingObjects(env.DECK_ASSETS,pendingKeys); throw error; }
      return reply({ item: await itemFor(env, await current(db,id)) },201);
    }
    const media = path.match(/^media\/([^/]+)$/);
    if (media && ['GET','HEAD'].includes(method)) return await mediaResponse(request,env,media[1],false);
    if (upload && method === 'POST') {
      const row = await current(db,upload[1]);
      const contentType = (request.headers.get('Content-Type') || '').split(';')[0].toLowerCase(), type = MEDIA_TYPES[contentType];
      if (!type) throw new CommunityError(415, 'Use PNG/JPEG images or MP3/M4A/WAV audio.');
      const bytes = await readLimitedBody(request,type.maximum); validateMedia(bytes,contentType);
      const id=crypto.randomUUID(), key=`catalog/media/${row.id}/${id}.${type.extension}`;
      await env.DECK_ASSETS.put(key,bytes,{httpMetadata:{contentType}});
      try { await db.batch([
        db.prepare('INSERT INTO managed_catalog_media(id,catalog_id,object_key,content_type,byte_size,created_at,actor) VALUES(?,?,?,?,?,?,?)').bind(id,row.id,key,contentType,bytes.length,seconds(),actor),
        db.prepare('INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),actor,'catalog_upload_media',row.id,JSON.stringify({mediaId:id,contentType,byteSize:bytes.length}),seconds())
      ]); } catch(error) { await env.DECK_ASSETS.delete(key); throw error; }
      return reply({id,reference:`catalog:${id}`,url:`https://api.learnalertapp.com/v1/admin/catalog/media/${id}`,contentType,byteSize:bytes.length},201);
    }
    const match = path.match(/^([^/]+)(?:\/(publish|archive|restore|history))?$/);
    if (!match || !catalogIDPattern.test(match[1])) throw new CommunityError(404,'Catalog endpoint not found.');
    const row = await current(db,match[1]), action=match[2];
    if (!action && method==='GET') {
      if (url.searchParams.has('revision')) {
        const requested=Number(url.searchParams.get('revision'));
        if (!Number.isSafeInteger(requested)||requested<1) throw new CommunityError(400,'Invalid catalog revision.');
        const snapshot=await db.prepare('SELECT content_key FROM managed_catalog_revisions WHERE catalog_id=? AND revision=?').bind(row.id,requested).first();
        if (!snapshot) throw new CommunityError(404,'Historical revision not found.');
        return reply({item:{...summary(row),viewedRevision:requested,document:await documentFor(env,snapshot.content_key)}});
      }
      return reply({item:await itemFor(env,row)});
    }
    if (action==='history' && method==='GET') {
      const rows=await db.prepare('SELECT revision,action,actor,note,created_at,published FROM managed_catalog_revisions WHERE catalog_id=? ORDER BY revision DESC').bind(row.id).all();
      return reply({items:rows.results.map(item=>({revision:item.revision,action:item.action,actor:item.actor,note:item.note,createdAt:item.created_at,published:Boolean(item.published)}))});
    }
    if (!action && method==='PUT') {
      const body=await readCatalogJSON(request);
      return reply({item:await itemFor(env,await saveDraft(env,row,body,actor,body.document))});
    }
    if (action==='restore' && method==='POST') {
      const body=await readCatalogJSON(request); requireRevision(row,body);
      let key=row.draft_key;
      if (body.revision!=null) {
        if (!Number.isSafeInteger(body.revision)||body.revision<1) throw new CommunityError(400,'Choose a valid historical revision.');
        const source=await db.prepare('SELECT content_key FROM managed_catalog_revisions WHERE catalog_id=? AND revision=?').bind(row.id,body.revision).first();
        if (!source) throw new CommunityError(404,'Historical revision not found.'); key=source.content_key;
      }
      return reply({item:await itemFor(env,await saveDraft(env,row,body,actor,await documentFor(env,key),'restore'))});
    }
    if ((action==='publish'||action==='archive')&&method==='POST'||!action&&method==='DELETE') {
      const body=await readCatalogJSON(request); requireRevision(row,body); note(body);
      const publishing=action==='publish', next=row.revision+1, stamp=seconds(), effective=publishing?'publish':'archive';
      const document=await documentFor(env,row.draft_key);
      const validated=validateCatalogContent(row.kind,document,row.id,{publish:publishing});
      const references=publishing?await checkMedia(db,row.id,document):[];
      const guard='EXISTS(SELECT 1 FROM managed_catalog WHERE id=? AND revision=?)';
      const statements=[revisionInsert(db,row,next,effective,row.draft_key,actor,body,publishing),audit(db,actor,row.id,effective,{revision:next,previousRevision:row.revision,title:validated.title,note:note(body)},row.revision),advanceState(db,row,publishing),db.prepare(`DELETE FROM managed_catalog_public_media WHERE catalog_id=? AND ${guard}`).bind(row.id,row.id,row.revision)];
      for (let start=0;start<references.length;start+=80) {
        const chunk=references.slice(start,start+80);
        statements.push(db.prepare(`INSERT INTO managed_catalog_public_media(catalog_id,media_id) SELECT catalog_id,id FROM managed_catalog_media WHERE catalog_id=? AND id IN (${chunk.map(()=>'?').join(',')}) AND ${guard}`).bind(row.id,...chunk,row.id,row.revision));
      }
      statements.push(publishing
        ?db.prepare("UPDATE managed_catalog SET status='published',revision=?,published_key=draft_key,published_revision=?,published_title=?,published_at=?,archived_at=NULL,updated_at=?,updated_by=? WHERE id=? AND revision=?").bind(next,next,validated.title,stamp,stamp,actor,row.id,row.revision)
        :db.prepare("UPDATE managed_catalog SET status='archived',revision=?,published_key=NULL,published_revision=NULL,archived_at=?,updated_at=?,updated_by=? WHERE id=? AND revision=?").bind(next,stamp,stamp,actor,row.id,row.revision));
      const result=await db.batch(statements);
      if(!result.at(-1).meta.changes)throw new CommunityError(409,'This content changed. Reload before publishing or archiving.','CATALOG_CONFLICT');
      return reply({item:await itemFor(env,await current(db,row.id))});
    }
    throw new CommunityError(404,'Catalog endpoint not found.');
  } catch(error) { return catalogError(error,false); }
}

export async function publicCatalog(request,env) {
  try {
    if(!env.COMMUNITY_DB||!env.DECK_ASSETS)throw new CommunityError(503,'Catalog storage is unavailable.');
    const url=new URL(request.url),path=url.pathname.slice('/v1/catalog'.length).replace(/^\//,'');
    if(!['GET','HEAD'].includes(request.method))throw new CommunityError(405,'Use GET to browse the catalog.');
    if(!path) {
      const snapshot=await env.COMMUNITY_DB.batch([
        env.COMMUNITY_DB.prepare('SELECT revision,initialized FROM managed_catalog_state WHERE id=1'),
        env.COMMUNITY_DB.prepare("SELECT id,kind,published_title,published_revision,published_at FROM managed_catalog WHERE status='published' AND published_key IS NOT NULL ORDER BY sort_order,id"),
        env.COMMUNITY_DB.prepare("SELECT m.id,m.catalog_id,m.content_type FROM managed_catalog_media m JOIN managed_catalog_public_media p ON p.media_id=m.id JOIN managed_catalog c ON c.id=p.catalog_id WHERE c.status='published' AND c.published_key IS NOT NULL")
      ]);
      const state=snapshot[0].results[0],rows=snapshot[1].results,assets=snapshot[2].results;
      return reply({schemaVersion:1,revision:String(state?.revision??0),initialized:Boolean(state?.initialized),items:rows.map(row=>({id:row.id,kind:row.kind,title:row.published_title,revision:row.published_revision,updatedAt:row.published_at,contentURL:`https://api.learnalertapp.com/v1/catalog/${encodeURIComponent(row.id)}?revision=${row.published_revision}`,assets:assets.filter(asset=>asset.catalog_id===row.id).map(asset=>({id:asset.id,reference:`catalog:${asset.id}`,contentType:asset.content_type,url:`https://api.learnalertapp.com/v1/catalog/media/${asset.id}`}))}))},200,true);
    }
    const media=path.match(/^media\/([^/]+)$/);
    if(media)return await mediaResponse(request,env,media[1],true);
    if(!catalogIDPattern.test(path))throw new CommunityError(404,'Catalog item not found.');
    const row=await current(env.COMMUNITY_DB,path);
    if(row.status!=='published'||!row.published_key)throw new CommunityError(404,'Catalog item not found.');
    let key=row.published_key,revision=row.published_revision;
    if(url.searchParams.has('revision')) {
      const requested=Number(url.searchParams.get('revision'));
      if(!Number.isSafeInteger(requested)||requested<1)throw new CommunityError(400,'Invalid catalog revision.');
      const snapshot=await env.COMMUNITY_DB.prepare('SELECT content_key FROM managed_catalog_revisions WHERE catalog_id=? AND revision=? AND published=1').bind(row.id,requested).first();
      if(!snapshot)throw new CommunityError(404,'Published revision not found.'); key=snapshot.content_key; revision=requested;
    }
    return reply({id:row.id,kind:row.kind,revision,document:await documentFor(env,key)},200,true);
  }catch(error){return catalogError(error,true);}
}
function catalogError(error,isPublic) {
  if(error instanceof CommunityError)return reply({error:{code:error.code,message:error.message}},error.status,isPublic);
  console.error('Catalog request failed',error);
  return reply({error:{message:'Catalog request failed. Please refresh and try again.'}},500,isPublic);
}
