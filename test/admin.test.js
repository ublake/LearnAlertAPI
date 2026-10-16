import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { adminIdentity } from '../src/lib/adminAuth.js';
import { sha256 } from '../src/lib/communityAuth.js';
import { cleanupCommunity } from '../src/routes/community.js';

const env = { ADMIN_ACCESS_ISSUER: 'https://learnalert-test.cloudflareaccess.com', ADMIN_ACCESS_AUD: 'admin-test', ADMIN_EMAILS: 'ttw55970@gmail.com' };
const b64 = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function signing() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'admin-test', alg: 'RS256' };
  async function token(overrides = {}) {
    const now = Math.floor(Date.now() / 1000);
    const message = `${b64({ alg: 'RS256', kid: jwk.kid })}.${b64({ iss: env.ADMIN_ACCESS_ISSUER, aud: [env.ADMIN_ACCESS_AUD], email: env.ADMIN_EMAILS, iat: now, exp: now + 600, ...overrides })}`;
    return `${message}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(message))).toString('base64url')}`;
  }
  return { jwk, token };
}
test('admin authentication fails closed and rejects spoofed, expired, wrong-audience and non-admin identities', async () => {
  const { jwk, token } = await signing();
  const req = value => new Request('https://api.example.test/v1/admin/overview', { headers: { 'Cf-Access-Jwt-Assertion': value, 'Cf-Access-Authenticated-User-Email': env.ADMIN_EMAILS } });
  assert.equal(await adminIdentity(req(await token()), env, [jwk]), env.ADMIN_EMAILS);
  for (const claims of [{ aud: ['other'] }, { iss: 'https://attacker.example' }, { email: 'someone@example.com' }, { exp: 1 }, { iat: 9999999999 }]) {
    await assert.rejects(adminIdentity(req(await token(claims)), env, [jwk]), e => e.status === 401);
  }
  const valid = await token();
  await assert.rejects(adminIdentity(req(valid.slice(0, -20) + 'aaaaaaaaaaaaaaaaaaaa'), env, [jwk]), e => e.status === 401);
  await assert.rejects(adminIdentity(req(''), env, [jwk]), e => e.status === 401);
  await assert.rejects(adminIdentity(req(valid), {}, [jwk]), e => e.status === 503);
});

test('admin moderation hides all public entry points, survives owner edits, restores media, and audits reports/profile changes', async () => {
  const { jwk, token } = await signing();
  const jwt = await token();
  const bundle = await build({ entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-04', bindings: env, d1Databases: ['COMMUNITY_DB'], r2Buckets: ['DECK_ASSETS'], outboundService: () => new Response(JSON.stringify({ keys: [jwk] })) }));
  try {
    const db = await mf.getD1Database('COMMUNITY_DB');
    for (const file of (await readdir(new URL('../community-migrations/', import.meta.url))).sort()) {
      const sql = await readFile(new URL(`../community-migrations/${file}`, import.meta.url), 'utf8');
      const triggers = sql.match(/CREATE TRIGGER[\s\S]*?END;/g) || [];
      for (const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
      for (const trigger of triggers) await db.prepare(trigger).run();
    }
    const id = crypto.randomUUID(), media = crypto.randomUUID();
    await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,?)').bind('owner', '@owner', 1).run();
    await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,?)').bind('reporter', '@reporter', 1).run();
    await db.prepare("INSERT INTO community_decks(id,owner_id,name,category_tag,color_hex,deck_type,status,created_at,updated_at) VALUES(?,'owner','Test','Science','#123456','Quiz','published',1,1)").bind(id).run();
    await db.prepare("INSERT INTO community_media(id,deck_id,object_key,content_type,byte_size,uploaded,attached,created_at) VALUES(?,?,'test-image','image/jpeg',3,1,1,1)").bind(media, id).run();
    await (await mf.getR2Bucket('DECK_ASSETS')).put('test-image', new Uint8Array([1, 2, 3]));
    await db.prepare('INSERT INTO community_reports(deck_id,user_id,reason,created_at) VALUES(?,?,?,?)').bind(id, 'reporter', 'Please review', 10).run();
    const call = (path, method = 'GET', body, origin = 'https://learnalertapp.com', assertion = jwt) => mf.dispatchFetch(`https://api.example.test/v1/admin/${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': assertion, Origin: origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const pub = path => mf.dispatchFetch(`https://api.example.test/v1/community/${path}`);
    assert.equal((await call('overview', 'GET', undefined, undefined, '')).status, 401);
    assert.equal((await call(`decks/${id}`, 'PATCH', { hidden: true }, 'https://attacker.example')).status, 403);
    assert.equal((await call(`decks/${id}`, 'PATCH', { hidden: true })).status, 200);
    assert.equal((await (await pub('decks')).json()).totalCount, 0);
    for (const path of [`decks/${id}`, `decks/${id}/preview`, `media/${media}`]) assert.equal((await pub(path)).status, 404);
    assert.equal((await call(`media/${media}`)).status, 200);
    await db.prepare("UPDATE community_decks SET name='Edited',status='published' WHERE id=?").bind(id).run();
    assert.equal((await pub(`decks/${id}`)).status, 404);
    assert.equal((await call(`decks/${id}`, 'PATCH', { hidden: false })).status, 200);
    assert.equal((await pub(`media/${media}`)).status, 200);
    assert.equal((await pub(`decks/${id}`)).status, 200);
    assert.equal((await call('reports/resolve', 'POST', { deckId: id, userId: 'reporter', createdAt: 9 })).status, 409);
    assert.equal((await call('reports/resolve', 'POST', { deckId: id, userId: 'reporter', createdAt: 10 })).status, 200);
    assert.equal((await (await call('reports')).json()).items.length, 0);
    assert.equal((await (await call('reports?resolved=true')).json()).items.length, 1);
    assert.equal((await call('profiles/update', 'POST', { id: 'owner', username: 'reporter' })).status, 409);
    assert.equal((await call('profiles/update', 'POST', { id: 'owner', username: 'new_owner' })).status, 200);
    assert.equal((await (await call('audit')).json()).items.length, 4);
    assert.equal((await (await call('overview')).json()).actor, env.ADMIN_EMAILS);
    // Content edits preserve visibility, dates and ownership, validate cards
    // and attachment ownership, and reject stale snapshots without side effects.
    await db.prepare('UPDATE community_decks SET admin_hidden=1 WHERE id=?').bind(id).run();
    const original = (await (await call(`decks/${id}`)).json()).deck;
    const edit = { expectedRevision: original.revision, name: 'Admin edited title', description: 'Updated description', categoryTag: 'Languages', colorHex: '#abcdef', deckType: 'Mixed', downloadCount: 7,
      cards: [{ id: 'edited-card', cardType: 'tap_reveal', question: 'Updated question', correctAnswer: 'Updated answer', promptImageID: media }] };
    assert.equal((await call(`decks/${id}`, 'PUT', edit, 'https://attacker.example')).status, 403);
    assert.equal((await call(`decks/${id}`, 'PUT', { ...edit, downloadCount: -1 })).status, 400);
    assert.equal((await call(`decks/${id}`, 'PUT', { ...edit, cards: [{ ...edit.cards[0], promptImageID: crypto.randomUUID() }] })).status, 400);
    assert.equal((await call(`decks/${id}`, 'PUT', { ...edit, cards: [{ ...edit.cards[0], promptImageID: null, promptAudioID: media }] })).status, 400);
    assert.equal((await call(`decks/${id}`, 'PUT', { ...edit, cards: [{ ...edit.cards[0], cardType: 'multiple_choice', options: ['X','Y'] }] })).status, 400);
    assert.equal((await call(`decks/${id}`, 'PUT', edit)).status, 200);
    const edited = (await (await call(`decks/${id}`)).json()).deck;
    assert.equal(edited.name, edit.name); assert.equal(edited.download_count, 7);
    assert.equal(edited.card_count, 1); assert.equal(edited.cards[0].correctAnswer, 'Updated answer');
    assert.equal(edited.owner_id, original.owner_id); assert.equal(edited.status, original.status);
    assert.equal(edited.admin_hidden, 1); assert.equal(edited.created_at, original.created_at);
    assert.equal(edited.published_at, original.published_at); assert.ok(edited.updated_at >= original.updated_at);
    assert.ok(Math.abs(edited.updated_at - Math.floor(Date.now() / 1000)) < 10);
    assert.equal(edited.revision, original.revision + 1);
    assert.equal((await call(`decks/${id}`, 'PUT', edit)).status, 409);
    assert.equal((await db.prepare('SELECT attached FROM community_media WHERE id=?').bind(media).first()).attached, 1);
    assert.equal((await pub(`decks/${id}`)).status, 404);
    await db.prepare('UPDATE community_decks SET admin_hidden=0 WHERE id=?').bind(id).run();
    const published = (await (await pub(`decks/${id}`)).json()).deck;
    assert.equal(published.name, edit.name); assert.equal(published.cards[0].question, 'Updated question');
    assert.ok((await (await call('decks')).json()).items[0].updated_at);
    assert.ok((await (await call('audit')).json()).items.some(item => item.action === 'edit_deck'));
    // Destructive actions retain authentication/origin checks and audit history.
    assert.equal((await call(`decks/${id}`, 'DELETE', {}, undefined, '')).status, 401);
    assert.equal((await call('profiles/delete', 'POST', { id: 'owner' }, 'https://attacker.example')).status, 403);
    assert.equal((await call('reports/delete', 'POST', { deckId: id, userId: 'reporter', createdAt: 9 })).status, 409);
    assert.equal((await call('reports/delete', 'POST', { deckId: id, userId: 'reporter', createdAt: 10 })).status, 200);
    assert.equal((await (await call('reports?resolved=true')).json()).items.length, 0);
    assert.ok(await db.prepare("SELECT id FROM community_users WHERE id='reporter'").first());
    assert.equal((await pub(`decks/${id}`)).status, 200);
    assert.equal((await call(`decks/${id}`, 'DELETE', {})).status, 200);
    assert.equal((await call(`decks/${id}`, 'DELETE', {})).status, 404);
    for (const path of [`decks/${id}`, `decks/${id}/preview`, `media/${media}`]) assert.equal((await pub(path)).status, 404);
    assert.equal((await call(`decks/${id}`, 'PATCH', { hidden: false })).status, 404);
    const bucket = await mf.getR2Bucket('DECK_ASSETS');
    await cleanupCommunity({ COMMUNITY_DB: db, DECK_ASSETS: bucket });
    assert.equal(await bucket.head('test-image'), null);
    const second = crypto.randomUUID(), secondMedia = crypto.randomUUID(), session = 'b'.repeat(64);
    await db.prepare("INSERT INTO community_decks(id,owner_id,name,category_tag,color_hex,deck_type,status,created_at,updated_at) VALUES(?,'owner','Profile deletion test','General','#123456','Quiz','published',1,1)").bind(second).run();
    await db.prepare("INSERT INTO community_media(id,deck_id,object_key,content_type,byte_size,uploaded,attached,created_at) VALUES(?,?,'profile-image','image/jpeg',3,1,1,1)").bind(secondMedia, second).run();
    await bucket.put('profile-image', new Uint8Array([1, 2, 3]));
    await db.prepare('INSERT INTO community_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(session), 'owner', 9999999999).run();
    await db.prepare('INSERT INTO community_reports(deck_id,user_id,reason,created_at) VALUES(?,?,?,?)').bind(second, 'reporter', 'Another report', 1).run();
    assert.equal((await call('profiles/delete', 'POST', { id: 'owner' })).status, 200);
    assert.equal(await db.prepare("SELECT id FROM community_users WHERE id='owner'").first(), null);
    assert.equal(await db.prepare('SELECT id FROM community_decks WHERE id=?').bind(second).first(), null);
    assert.equal((await pub(`media/${secondMedia}`)).status, 404);
    assert.equal((await mf.dispatchFetch('https://api.example.test/v1/community/account', { headers: { Authorization: `Bearer ${session}` } })).status, 401);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM community_deleted_objects').first()).n, 1);
    assert.ok(await db.prepare("SELECT id FROM community_users WHERE id='reporter'").first());
    await cleanupCommunity({ COMMUNITY_DB: db, DECK_ASSETS: bucket });
    assert.equal(await bucket.head('profile-image'), null);
    const audit = (await (await call('audit')).json()).items;
    for (const action of ['delete_deck', 'delete_report', 'delete_profile']) assert.ok(audit.some(entry => entry.action === action));
    // Admin-created decks can upload real media, stay private until published,
    // and survive abandoned-app-draft cleanup.
    const create = await call('decks', 'POST', { name: 'Imported biology', ownerId: 'official', categoryTag: 'Science' });
    assert.equal(create.status, 201);
    const importedId = (await create.json()).id;
    const initial = (await (await call(`decks/${importedId}`)).json()).deck;
    assert.equal(initial.status, 'draft'); assert.equal(initial.handle, '@learnalert'); assert.equal(initial.admin_created, 1);
    assert.equal((await pub(`decks/${importedId}`)).status, 404);
    const upload = (bytes, type = 'image/png', origin = 'https://learnalertapp.com') => mf.dispatchFetch(`https://api.example.test/v1/admin/decks/${importedId}/media`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': jwt, Origin: origin, 'Content-Type': type }, body: bytes });
    assert.equal((await upload(new Uint8Array(16), 'image/png', 'https://attacker.example')).status, 403);
    assert.equal((await upload(new Uint8Array(16))).status, 400);
    const imageBytes = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
    const uploaded = await upload(imageBytes); assert.equal(uploaded.status, 201);
    const importedMedia = (await uploaded.json()).id;
    assert.equal((await pub(`media/${importedMedia}`)).status, 404);
    assert.equal((await call(`media/${importedMedia}`)).status, 200);
    const importedBody = { name: 'Imported biology', categoryTag: 'Science', downloadCount: 0, expectedRevision: initial.revision,
      cards: [{ id: 'imported-card', cardType: 'tap_reveal', question: 'What is this structure?', correctAnswer: 'Nucleus', promptImageID: importedMedia }] };
    assert.equal((await call('decks/validate', 'POST', importedBody)).status, 200);
    assert.equal((await call(`decks/${importedId}`, 'PUT', importedBody)).status, 200);
    await db.prepare('UPDATE community_decks SET updated_at=1 WHERE id=?').bind(importedId).run();
    await cleanupCommunity({ COMMUNITY_DB: db, DECK_ASSETS: bucket });
    const retained = (await (await call(`decks/${importedId}`)).json()).deck;
    assert.equal(retained.status, 'draft');
    assert.equal((await call(`decks/${importedId}/publish`, 'POST', { expectedRevision: initial.revision })).status, 409);
    assert.equal((await call(`decks/${importedId}/publish`, 'POST', { expectedRevision: retained.revision })).status, 200);
    assert.equal((await pub(`decks/${importedId}`)).status, 200);
    assert.equal((await pub(`media/${importedMedia}`)).status, 200);
    const publication = (await (await call(`decks/${importedId}`)).json()).deck;
    assert.ok(publication.published_at); assert.equal(publication.cards[0].promptImageID, importedMedia);
    const official = await db.prepare("SELECT public_id,created_at FROM community_users WHERE handle='@learnalert'").first();
    const officialProfileResponse=await pub(`profiles/${official.public_id}`);
    assert.equal(officialProfileResponse.status,200);
    const officialProfile=await officialProfileResponse.json();
    assert.equal(officialProfile.profile.handle,'@learnalert'); assert.equal(officialProfile.profile.profileCreatedAt,official.created_at);
    assert.equal(officialProfile.profile.stats.publishedDeckCount,1); assert.equal(officialProfile.decks[0].id,importedId);
    assert.equal((await call('decks', 'POST', { name: 'Second official deck', ownerId: 'official' })).status, 201);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM community_users WHERE handle='@learnalert'").first()).n, 1);
    // Real app submissions are private, retained for manual review, and cannot
    // spoof approval or use the trusted-admin direct-publication endpoint.
    const reviewToken = 'c'.repeat(64);
    await db.prepare('INSERT INTO community_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(await sha256(reviewToken),'reporter',Math.floor(Date.now()/1000)+30*86400).run();
    const app = (path,method='GET',body) => mf.dispatchFetch(`https://api.example.test/v1/community/${path}`, { method, headers: { Authorization: `Bearer ${reviewToken}`, 'Content-Type': body instanceof Uint8Array ? 'image/png' : 'application/json' }, body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body) });
    const appDraft = (await (await app('decks/drafts','POST',{ name: 'Needs review', admin_created: 1, reviewStatus: 'approved' })).json()).id;
    assert.ok(appDraft);
    assert.equal((await (await call(`decks/${appDraft}`)).json()).deck.admin_created, 0);
    assert.ok(!(await (await app('account/decks')).json()).decks.some(deck=>deck.id===appDraft));
    const reviewMedia = (await (await app(`decks/${appDraft}/media`,'POST',imageBytes)).json()).id;
    const submission = { name: 'Needs review', reviewStatus: 'approved', cards: [{ id: 'review-card', cardType: 'tap_reveal', question: 'Review this image', correctAnswer: 'Original answer', promptImageID: reviewMedia }] };
    const submitted = await app(`decks/${appDraft}`,'PUT',submission);
    assert.equal(submitted.status,202); const receipt = await submitted.json();
    assert.equal(receipt.reviewStatus,'pending'); assert.ok(receipt.submittedAt); assert.equal(receipt.message,'Review can take up to 3 days.');
    async function privateSubmission() {
      assert.ok(!(await (await pub('decks')).json()).decks.some(deck=>deck.id===appDraft));
      for (const path of [`decks/${appDraft}`,`decks/${appDraft}/preview`,`media/${reviewMedia}`]) assert.equal((await pub(path)).status,404);
      assert.equal((await mf.dispatchFetch(`https://api.example.test/v1/community/media/${reviewMedia}`, { method: 'HEAD' })).status,404);
      assert.equal((await app(`decks/${appDraft}/reports`,'POST',{ reason:'Not publicly visible' })).status,404);
      assert.equal((await app(`media/${reviewMedia}`)).status,200);
    }
    await privateSubmission();
    let owned = (await (await app('account/decks')).json()).decks.find(deck=>deck.id===appDraft);
    assert.equal(owned.reviewStatus,'pending'); assert.equal(owned.submittedAt,receipt.submittedAt);
    await db.prepare('UPDATE community_decks SET updated_at=?,submitted_at=? WHERE id=?').bind(1,1,appDraft).run();
    await db.prepare('UPDATE community_media SET created_at=1 WHERE id=?').bind(reviewMedia).run();
    await cleanupCommunity({ COMMUNITY_DB: db, DECK_ASSETS: bucket });
    let reviewDeck=(await (await call(`decks/${appDraft}`)).json()).deck;
    assert.equal(reviewDeck.status,'draft'); assert.equal(reviewDeck.review_status,'pending'); await privateSubmission();
    assert.ok((await (await call('reviews')).json()).items.some(deck=>deck.id===appDraft));
    const decide = (decision,expectedRevision=reviewDeck.revision,reason) => call(`decks/${appDraft}/review`,'POST',{decision,expectedRevision,reason});
    assert.equal((await call(`decks/${appDraft}/publish`,'POST',{ expectedRevision:reviewDeck.revision })).status,409);
    assert.equal((await decide('reject',reviewDeck.revision,'  ')).status,400);
    assert.equal((await decide('approve',reviewDeck.revision-1)).status,409);
    assert.equal((await call(`decks/${appDraft}/review`,'POST',{decision:'approve',expectedRevision:reviewDeck.revision},'https://attacker.example')).status,403);
    assert.equal((await decide('approve')).status,200);
    assert.equal((await pub(`decks/${appDraft}`)).status,200); assert.equal((await pub(`media/${reviewMedia}`)).status,200);
    assert.equal((await decide('reject',reviewDeck.revision,'Stale')).status,409);
    owned=(await (await app('account/decks')).json()).decks.find(deck=>deck.id===appDraft);
    assert.equal(owned.reviewStatus,'approved');
    // Approved user edits immediately withdraw the public copy and media.
    assert.equal((await app(`decks/${appDraft}`,'PATCH',{...submission,name:'Edited after approval'})).status,202);
    await privateSubmission();
    reviewDeck=(await (await call(`decks/${appDraft}`)).json()).deck;
    assert.equal((await decide('reject',reviewDeck.revision,'Please correct the answer.')).status,200);
    owned=(await (await app('account/decks')).json()).decks.find(deck=>deck.id===appDraft);
    assert.equal(owned.reviewStatus,'rejected'); assert.equal(owned.reviewMessage,'Please correct the answer.');
    await db.prepare('UPDATE community_decks SET updated_at=1 WHERE id=?').bind(appDraft).run();
    await cleanupCommunity({ COMMUNITY_DB:db,DECK_ASSETS:bucket }); await privateSubmission();
    assert.equal((await app(`decks/${appDraft}`,'PUT',submission)).status,202);
    owned=(await (await app('account/decks')).json()).decks.find(deck=>deck.id===appDraft);
    assert.equal(owned.reviewStatus,'pending'); assert.equal(owned.reviewMessage,null);
    assert.equal((await (await app('account')).json()).handle,'@reporter');
    await call(`decks/${appDraft}`,'PATCH',{hidden:true});
    reviewDeck=(await (await call(`decks/${appDraft}`)).json()).deck;
    assert.equal((await decide('approve')).status,200);
    assert.equal((await pub(`decks/${appDraft}`)).status,404); // approval does not clear moderation hiding
    const decisions=(await (await call('audit')).json()).items.filter(item=>item.action==='approve_deck'||item.action==='reject_deck');
    assert.equal(decisions.length,3);
  } finally { await mf.dispose(); }
});

test('author admin notes stay private, survive resubmission, and deleted notices are minimal and owner-dismissible', async () => {
  const { jwk, token } = await signing(); const jwt=await token();
  const bundle=await build({entryPoints:['src/index.js'],bundle:true,write:false,format:'esm',platform:'browser'});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-04',bindings:env,d1Databases:['COMMUNITY_DB'],r2Buckets:['DECK_ASSETS'],outboundService:()=>new Response(JSON.stringify({keys:[jwk]}))}));
  try {
    const db=await mf.getD1Database('COMMUNITY_DB'), bucket=await mf.getR2Bucket('DECK_ASSETS');
    for(const file of (await readdir(new URL('../community-migrations/',import.meta.url))).sort()) {
      const sql=await readFile(new URL(`../community-migrations/${file}`,import.meta.url),'utf8'), triggers=sql.match(/CREATE TRIGGER[\s\S]*?END;/g)||[];
      for(const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g,'').split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
      for(const trigger of triggers)await db.prepare(trigger).run();
    }
    const session='d'.repeat(64), other='e'.repeat(64), id=crypto.randomUUID(), media=crypto.randomUUID();
    for(const [user,bearer] of [['author',session],['other',other]]) {
      await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,1)').bind(user,'@'+user).run();
      await db.prepare('INSERT INTO community_sessions(token_hash,user_id,expires_at) VALUES(?,?,9999999999)').bind(await sha256(bearer),user).run();
    }
    const cards=[{id:'card',question:'Question',correctAnswer:'Answer',cardType:'tap_reveal',promptImageID:media}];
    await db.prepare("INSERT INTO community_decks(id,owner_id,name,category_tag,color_hex,deck_type,status,created_at,updated_at,cards_json,card_count) VALUES(?,'author','Original','General','#123456','Mixed','published',1,1,?,1)").bind(id,JSON.stringify(cards)).run();
    await db.prepare("INSERT INTO community_media(id,deck_id,object_key,content_type,byte_size,uploaded,attached,created_at) VALUES(?,?,'notice-image','image/png',3,1,1,1)").bind(media,id).run(); await bucket.put('notice-image',new Uint8Array([1,2,3]));
    const call=(path,method='GET',body,assertion=jwt)=>mf.dispatchFetch('https://api.example.test/v1/admin/'+path,{method,headers:{'Cf-Access-Jwt-Assertion':assertion,Origin:'https://learnalertapp.com','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const app=(path,method='GET',body,bearer=session)=>mf.dispatchFetch('https://api.example.test/v1/community/'+path,{method,headers:{...(bearer?{Authorization:'Bearer '+bearer}:{}),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const row=async()=> (await (await app('account/decks')).json()).decks.find(d=>d.id===id);
    const current=async()=> (await (await call('decks/'+id)).json()).deck;
    let revision=(await current()).revision;
    const edit={name:'Edited by admin',categoryTag:'General',colorHex:'#123456',deckType:'Mixed',cards,downloadCount:0,expectedRevision:revision,adminNote:'Corrected an inaccurate answer.'};
    assert.equal((await call('decks/'+id,'PUT',{...edit,adminNote:4})).status,400);
    assert.equal((await call('decks/'+id,'PUT',{...edit,adminNote:'x'.repeat(1001)})).status,400);
    assert.equal((await call('decks/'+id,'PUT',edit)).status,200);
    let owned=await row(); assert.equal(owned.name,edit.name); assert.equal(owned.adminNote,edit.adminNote); assert.equal(owned.adminAction,'edited'); assert.ok(owned.adminUpdatedAt); assert.equal(owned.status,'published'); assert.equal(owned.isHidden,false);
    for(const path of ['decks','decks/'+id+'/preview','decks/'+id]) {
      const response=await app(path,'GET',undefined,''); assert.equal(response.status,200);
      const payload=await response.json(), publicRow=payload.deck||payload.decks.find(d=>d.id===id);
      for(const field of ['adminNote','adminAction','adminUpdatedAt','status','isHidden'])assert.equal(field in publicRow,false);
    }
    assert.equal((await call('decks/'+id,'PUT',edit)).status,409); assert.equal((await row()).adminNote,edit.adminNote);
    revision=(await current()).revision;
    assert.equal((await call('decks/'+id,'PATCH',{hidden:true,adminNote:'Hidden while being checked.',expectedRevision:revision})).status,200);
    assert.equal((await row()).adminAction,'hidden'); assert.equal((await row()).isHidden,true);
    assert.equal((await call('decks/'+id,'PATCH',{hidden:false,expectedRevision:revision})).status,409);
    assert.equal((await app('decks/'+id,'PUT',{...edit,adminNote:'Author cannot spoof a note',adminAction:'restored'})).status,202);
    owned=await row(); assert.equal(owned.status,'draft'); assert.equal(owned.adminNote,'Hidden while being checked.'); assert.equal(owned.adminAction,'hidden'); assert.equal(owned.isHidden,true);
    revision=(await current()).revision;
    assert.equal((await call('decks/'+id,'PUT',{...edit,expectedRevision:revision,adminNote:'Edited while hidden.'})).status,200);
    assert.equal((await row()).isHidden,true); assert.equal((await row()).adminAction,'edited');
    revision=(await current()).revision;
    assert.equal((await call('decks/'+id,'PATCH',{hidden:false,expectedRevision:revision,adminNote:'Ready for another review.'})).status,200);
    assert.equal((await row()).adminAction,'restored'); assert.equal((await row()).isHidden,false);
    revision=(await current()).revision;
    assert.equal((await call('decks/'+id,'DELETE',{expectedRevision:revision-1,adminNote:'Stale'})).status,409);
    assert.equal((await call('decks/'+id,'DELETE',{expectedRevision:revision,adminNote:'Removed due to inappropriate content.'},'')).status,401);
    assert.equal((await call('decks/'+id,'DELETE',{expectedRevision:revision,adminNote:'Removed due to inappropriate content.'})).status,200);
    assert.equal(await db.prepare('SELECT id FROM community_decks WHERE id=?').bind(id).first(),null);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM community_media WHERE deck_id=?').bind(id).first()).n,0);
    owned=await row(); assert.equal(owned.status,'deleted'); assert.equal(owned.adminAction,'removed'); assert.equal(owned.adminNote,'Removed due to inappropriate content.'); assert.equal(owned.name,edit.name); assert.equal(owned.cardCount,1); assert.equal(owned.isHidden,false); assert.equal('cards' in owned,false);
    const tombstone=await db.prepare('SELECT * FROM community_deck_notices WHERE deck_id=?').bind(id).first();
    assert.deepEqual(Object.keys(tombstone).sort(),['deck_id','owner_id','name','card_count','admin_note','admin_updated_at'].sort());
    for(const path of ['decks/'+id,'decks/'+id+'/preview','media/'+media]) assert.equal((await app(path)).status,404);
    await cleanupCommunity({COMMUNITY_DB:db,DECK_ASSETS:bucket}); assert.equal(await bucket.head('notice-image'),null); assert.ok(await row());
    assert.equal((await app('decks/'+id,'DELETE',undefined,other)).status,404); assert.ok(await row());
    assert.equal((await app('decks/'+id,'DELETE')).status,200); assert.equal(await row(),undefined);
    assert.equal((await app('decks/'+id,'DELETE')).status,404);
    // More than one page of notices must not erase existing active entries.
    for(let i=0;i<52;i++)await db.prepare('INSERT INTO community_deck_notices(deck_id,owner_id,name,card_count,admin_note,admin_updated_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(),'author','Removed '+i,1,'Notice',i+1).run();
    let page=await (await app('account/decks')).json(); assert.equal(page.decks.length,50); assert.equal(page.nextOffset,50);
    page=await (await app('account/decks?offset=50')).json(); assert.equal(page.decks.length,2); assert.equal(page.nextOffset,null);
    assert.equal((await (await app('account/decks','GET',undefined,other)).json()).decks.length,0);
    assert.equal((await app('account','DELETE')).status,200); assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM community_deck_notices WHERE owner_id='author'").first()).n,0);
    const deletedOwner='profile-owner'; await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,1)').bind(deletedOwner,'@profile_owner').run();
    await db.prepare('INSERT INTO community_deck_notices(deck_id,owner_id,name,card_count,admin_updated_at) VALUES(?,?,?,1,1)').bind(crypto.randomUUID(),deletedOwner,'Removed').run();
    assert.equal((await call('profiles/delete','POST',{id:deletedOwner})).status,200);assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM community_deck_notices WHERE owner_id=?').bind(deletedOwner).first()).n,0);
    const audit=(await (await call('audit')).json()).items.find(r=>r.action==='delete_deck'&&r.target===id); assert.equal(JSON.parse(audit.details).adminNote,'Removed due to inappropriate content.');
  } finally {await mf.dispose();}
});
