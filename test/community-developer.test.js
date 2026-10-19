import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sha256 } from '../src/lib/communityAuth.js';
import { validateCommunityDeck } from '../src/lib/communityValidation.js';

const folder = '12345678-1234-1234-1234-123456789abc';
const card = { id: 'anki', cardType: 'anki', question: 'Front', correctAnswer: 'Back', ankiContent: {
  frontHTML: '<b>Front</b>', backHTML: '<b>Back</b>', css: '.card { color:blue }', mediaFolder: folder, templateOrdinal: 0, noteType: 'Basic', tags: []
} };
const native = { name: 'Personal', cards: [{id: 'native', cardType: 'tap_reveal', question: 'Q', correctAnswer: 'A'}] };

test('Anki payload validation requires privilege and rejects unsafe file paths', () => {
  assert.throws(() => validateCommunityDeck({name: 'Anki', cards: [card]}), error => error.status === 403);
  assert.equal(validateCommunityDeck({name: 'Anki', cards: [card]}, true).cards[0].ankiContent.frontHTML, '<b>Front</b>');
  for (const name of ['../escape.png', '/escape', 'a\\b', '..', 'bad\nname', '__proto__']) {
    assert.throws(() => validateCommunityDeck({name: 'Anki', cards: [card], ankiMedia: {[folder]: {[name]: crypto.randomUUID()}}}, true), error => error.status === 400);
  }
  assert.throws(() => validateCommunityDeck({...native, publisherHandle: 'Changed'}), error => error.status === 403);
  const removed = validateCommunityDeck({...native, ankiMedia:{[folder]:{'old.png':crypto.randomUUID()}}},true);
  assert.deepEqual(removed.ankiMedia,{}); assert.equal(removed.media.size,0);
});

test('developer capabilities are private, cannot be self-granted, and enforce the upload switch server-side', async () => {
  const bundle = await build({entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser'});
  const mf = new Miniflare(convertV4MiniflareOptions({modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-04', d1Databases: ['COMMUNITY_DB'], r2Buckets: ['DECK_ASSETS']}));
  try {
    const db = await mf.getD1Database('COMMUNITY_DB');
    for (const file of (await readdir(new URL('../community-migrations/', import.meta.url))).sort()) {
      const sql = await readFile(new URL(`../community-migrations/${file}`, import.meta.url), 'utf8');
      const triggers = sql.match(/CREATE TRIGGER[\s\S]*?END;/g) ?? [];
      for (const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g,'').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
      for (const trigger of triggers) await db.prepare(trigger).run();
    }
    const regular = 'a'.repeat(64), developer = 'b'.repeat(64);
    for (const [id, token, role] of [['regular',regular,0],['developer',developer,1]]) {
      await db.prepare('INSERT INTO community_users(id,handle,created_at,profile_completed,is_developer) VALUES(?,?,1,1,?)').bind(id, `@${id}`,role).run();
      await db.prepare('INSERT INTO community_sessions VALUES(?,?,?)').bind(await sha256(token),id,Math.floor(Date.now()/1000)+3600).run();
    }
    const request = (path, method='GET', body, token=regular, type='application/json') => mf.dispatchFetch(`https://community.test/v1/community/${path}`, {method, headers: {...(token ? {Authorization:`Bearer ${token}`} : {}), 'Content-Type':type}, body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body});
    const owner = await (await request('account','GET',undefined,developer)).json();
    assert.equal(owner.isDeveloper,true); assert.equal(owner.allowAnkiUploads,false);
    const publicProfile = await (await request(`profiles/${owner.authorID}`,'GET',undefined,null)).json();
    assert.equal(JSON.stringify(publicProfile).includes('isDeveloper'),false);
    assert.equal(JSON.stringify(publicProfile).includes('allowAnkiUploads'),false);
    assert.equal((await request('account/developer','PUT',{allowAnkiUploads:true})).status,403);
    assert.equal((await request('account','PUT',{isDeveloper:true,allowAnkiUploads:true})).status,400);
    assert.equal((await request('decks/drafts','POST',{name:'Anki',deckType:'Anki'})).status,403);
    const regularDraft = await (await request('decks/drafts','POST',{name:'Native'})).json();
    assert.equal((await request(`decks/${regularDraft.id}`,'PUT',{...native,cards:[card],isDeveloper:true,allowAnkiUploads:true})).status,403);
    assert.equal((await request(`decks/${regularDraft.id}`,'PUT',{...native,publisherHandle:'Custom'})).status,403);
    assert.equal((await request(`decks/${regularDraft.id}/media`,'POST',new Uint8Array([1,2,3]),regular,'application/octet-stream')).status,403);
    assert.equal((await request('decks/drafts','POST',{name:'Anki',deckType:'Anki'},developer)).status,403);
    assert.equal((await request('account/developer','PUT',{allowAnkiUploads:true},developer)).status,200);
    const draftResponse = await request('decks/drafts','POST',{name:'Anki',deckType:'Anki'},developer);
    assert.equal(draftResponse.status,201); const {id} = await draftResponse.json();
    const uploaded = await request(`decks/${id}/media`,'POST',new Uint8Array([1,2,3,4]),developer,'application/octet-stream');
    assert.equal(uploaded.status,201); const media = await uploaded.json();
    const body = {name:'Anki',origin:'anki',deckType:'Anki',cards:[card],ankiMedia:{[folder]:{'hello.mp3':media.id}},publisherHandle:'A fun creator'};
    assert.equal((await request(`decks/${regularDraft.id}`,'PUT',body,developer)).status,404);
    const largeCard = {...card,ankiContent:{...card.ankiContent,frontHTML:'x'.repeat(200000),backHTML:'x'.repeat(200000),css:'x'.repeat(100000)}};
    const tooLarge = {...body,cards:[largeCard,{...largeCard,id:'second'},{...largeCard,id:'third'}]};
    assert.equal((await request(`decks/${id}`,'PUT',tooLarge,developer)).status,413);
    const wrongID = structuredClone(body); wrongID.ankiMedia[folder]['hello.mp3']=crypto.randomUUID();
    assert.equal((await request(`decks/${id}`,'PUT',wrongID,developer)).status,400);
    const published = await request(`decks/${id}`,'PUT',body,developer);
    assert.equal(published.status,202,await published.text());
    const stored = await db.prepare('SELECT * FROM community_decks WHERE id=?').bind(id).first();
    assert.equal(stored.review_status,'pending'); assert.equal(stored.status,'draft');
    assert.equal(JSON.parse(stored.cards_json)[0].ankiContent.backHTML,'<b>Back</b>');
    assert.equal((await request(`decks/${id}`,'GET',undefined,null)).status,404);
    await db.prepare("UPDATE community_decks SET status='published',review_status='approved' WHERE id=?").bind(id).run();
    const detail = await (await request(`decks/${id}`,'GET',undefined,null)).json();
    assert.equal(detail.deck.authorHandle,'A fun creator'); assert.equal(detail.deck.ankiMedia[folder]['hello.mp3'],media.id);
    assert.equal((await request(`media/${media.id}`,'GET',undefined,null)).status,200);
    assert.equal((await request('account','GET',undefined,developer)).status,200);
    assert.equal((await (await request('account','GET',undefined,developer)).json()).handle,'@developer');
    await request('account/developer','PUT',{allowAnkiUploads:false},developer);
    assert.equal((await request(`decks/${id}`,'PUT',body,developer)).status,403);
    assert.equal((await request(`decks/${id}`,'PUT',{...native,publisherHandle:'Another name'},developer)).status,202);
    await db.prepare("UPDATE community_users SET is_developer=0 WHERE id='developer'").run();
    assert.equal((await request('account/developer','PUT',{allowAnkiUploads:true},developer)).status,403);
  } finally { await mf.dispose(); }
});
