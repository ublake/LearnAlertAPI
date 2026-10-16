import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sha256 } from '../src/lib/communityAuth.js';
import { communityContentSignature, validateCommunityDeck } from '../src/lib/communityValidation.js';
import { cleanupCommunity } from '../src/routes/community.js';

const imageCard = (overrides = {}) => ({ id: 'picture', cardType: 'images', promptImageID: crypto.randomUUID(), ...overrides });

test('image cards require a front and allow a back without text, choices, pairs, or audio', () => {
  const card = imageCard();
  const result = validateCommunityDeck({ name: 'Pictures', cards: [card] });
  assert.equal(result.cards[0].cardType, 'images');
  assert.equal(result.cards[0].question, '');
  assert.equal(result.cards[0].correctAnswer, '');
  assert.equal(result.cards[0].hint, '');
  assert.deepEqual(result.cards[0].options, []);
  assert.deepEqual([...result.media], [[card.promptImageID, 'image']]);
  const back = crypto.randomUUID();
  const twoSides = validateCommunityDeck({ name: 'Pictures', cards: [{ ...card, answerImageID: back }] });
  assert.equal(twoSides.cards[0].answerImageID, back);
  assert.deepEqual([...twoSides.media], [[card.promptImageID, 'image'], [back, 'image']]);
  for (const invalid of [
    { promptImageID: null }, { promptImageID: 'not-an-upload' },
    { promptImageID: null, answerImageID: back }, { answerImageID: 'not-an-upload' },
    { question: 'Question' }, { correctAnswer: 'Answer' }, { hint: 'Hint' },
    { options: ['A'] }, { matchingLeftItems: ['A'] }, { matchingRightItems: ['B'] },
    { optionImageIDs: [crypto.randomUUID()] }, { promptAudioID: crypto.randomUUID() },
    { question: 1 }, { correctAnswer: {} }, { options: 'A' }, { cardType: 'image' }
  ]) {
    assert.throws(() => validateCommunityDeck({ name: 'Pictures', cards: [imageCard(invalid)] }), error => error.status === 400);
  }
  // The new format must not relax the existing text formats.
  for (const cardType of ['vocabulary', 'tap_reveal', 'multiple_choice', 'matching', 'fill_blank']) {
    assert.throws(() => validateCommunityDeck({ name: 'Incomplete', cards: [{ id: 'bad', cardType, question: '', correctAnswer: '' }] }), error => error.status === 400);
    if (!['multiple_choice','matching'].includes(cardType)) assert.equal(validateCommunityDeck({ name: 'Media answer', cards: [{ id: 'media', cardType, question: 'Q', correctAnswer: '', answerImageID: back }] }).cards[0].answerImageID, back);
  }
});

test('image-only decks have no empty-text duplicate signature; text copy detection is unchanged', () => {
  const images = Array.from({ length: 3 }, (_, i) => imageCard({ id: String(i) }));
  assert.equal(communityContentSignature(images), null);
  const text = ['Mercury', 'Venus', 'Earth'].map((answer, i) => ({ id: String(i), cardType: 'tap_reveal', question: `Planet ${i + 1}`, correctAnswer: answer }));
  const reordered = text.toReversed().map(card => ({ ...card, id: crypto.randomUUID(), question: ` ${card.question.toUpperCase()} ` }));
  assert.equal(communityContentSignature(text), communityContentSignature(reordered));
  assert.equal(communityContentSignature([...text, ...images]), communityContentSignature(text));
  assert.equal(communityContentSignature([text[0], ...images]), null);
});

test('front/back images preserve review privacy, ownership, atomic guards, downloads, and cleanup', async () => {
  const access = { ADMIN_ACCESS_ISSUER: 'https://learnalert-test.cloudflareaccess.com', ADMIN_ACCESS_AUD: 'admin-test', ADMIN_EMAILS: 'admin@example.test' };
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'image-admin', alg: 'RS256' };
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const message = `${b64({ alg: 'RS256', kid: jwk.kid })}.${b64({ iss: access.ADMIN_ACCESS_ISSUER, aud: [access.ADMIN_ACCESS_AUD], email: access.ADMIN_EMAILS, iat: now, exp: now + 600 })}`;
  const assertion = `${message}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(message))).toString('base64url')}`;
  const bundle = await build({ entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-04', bindings: access, d1Databases: ['COMMUNITY_DB'], r2Buckets: ['DECK_ASSETS'], outboundService: () => new Response(JSON.stringify({ keys: [jwk] })) }));
  try {
    const db = await mf.getD1Database('COMMUNITY_DB');
    const bucket = await mf.getR2Bucket('DECK_ASSETS');
    for (const file of (await readdir(new URL('../community-migrations/', import.meta.url))).sort()) {
      const sql = await readFile(new URL(`../community-migrations/${file}`, import.meta.url), 'utf8');
      const triggers = sql.match(/CREATE TRIGGER[\s\S]*?END;/g) ?? [];
      for (const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g, '').split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
      for (const trigger of triggers) await db.prepare(trigger).run();
    }
    const tokens = ['a'.repeat(64), 'b'.repeat(64)];
    for (const [index, token] of tokens.entries()) {
      const user = `image-owner-${index}`;
      await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,?)').bind(user, `@picture${index}`, 1).run();
      await db.prepare('INSERT INTO community_sessions VALUES(?,?,?)').bind(await sha256(token), user, now + 3600).run();
    }
    function request(path, method = 'GET', body, token = null, contentType = 'application/json') {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = contentType;
      return mf.dispatchFetch(`https://community.test/v1/community/${path}`, { method, headers, body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body });
    }
    function admin(path, method = 'GET', body) {
      return mf.dispatchFetch(`https://community.test/v1/admin/${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': assertion, Origin: 'https://learnalertapp.com', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    }
    async function approve(id) {
      const { deck } = await (await admin(`decks/${id}`)).json();
      const response = await admin(`decks/${id}/review`, 'POST', { decision: 'approve', expectedRevision: deck.revision });
      assert.equal(response.status, 200, await response.text());
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH5kAAAAASUVORK5CYII=', 'base64');
    let firstImageID;
    const deckIDs = [], mediaKeys = [];
    for (const [index, token] of tokens.entries()) {
      const draft = await request('decks/drafts', 'POST', { name: `Image deck ${index}` }, token);
      assert.equal(draft.status, 201);
      const { id } = await draft.json();
      deckIDs.push(id);
      async function upload(bytes, type) {
        const response = await request(`decks/${id}/media`, 'POST', bytes, token, type);
        assert.equal(response.status, 201);
        return (await response.json()).id;
      }
      const front = await upload(png, 'image/png');
      const back = await upload(png, 'image/png');
      const audio = await upload(new TextEncoder().encode('RIFF1234WAVE'), 'audio/wav');
      const payload = { name: `Image deck ${index}`, cards: Array.from({ length: 3 }, (_, i) => imageCard({ id: String(i), promptImageID: front, answerImageID: i === 0 ? back : null })) };
      payload.cards[1] = { id: 'audio-choice', cardType: 'multiple_choice', question: '', correctAnswer: '', options: ['', ''], correctOptionIndex: 1,
        fieldMedia: { prompt: { audioID: audio }, 'option:0': { imageID: front }, 'option:1': { audioID: audio }, hint: { imageID: back } } };
      const invalidField = structuredClone(payload); invalidField.cards[1].fieldMedia['option:1'].audioID = crypto.randomUUID();
      assert.equal((await request(`decks/${id}`, 'PUT', invalidField, token)).status, 400);

      for (const invalid of [{ promptImageID: crypto.randomUUID() }, { answerImageID: crypto.randomUUID() }, { answerImageID: audio }, ...(firstImageID ? [{ answerImageID: firstImageID }] : [])]) {
        const malformed = structuredClone(payload); Object.assign(malformed.cards[0], invalid);
        assert.equal((await request(`decks/${id}`, 'PUT', malformed, token)).status, 400);
      }
      const submitted = await request(`decks/${id}`, 'PUT', payload, token);
      assert.equal(submitted.status, 202, await submitted.text());
      assert.equal((await request(`decks/${id}/preview`)).status, 404);
      for (const image of [front, back]) {
        assert.equal((await request(`media/${image}`)).status, 404);
        assert.equal((await request(`media/${image}`, 'GET', undefined, token)).status, 200);
        assert.equal((await db.prepare('SELECT attached FROM community_media WHERE id=?').bind(image).first()).attached, 1);
        mediaKeys.push((await db.prepare('SELECT object_key FROM community_media WHERE id=?').bind(image).first()).object_key);
      }
      // Review must reject a back claimed by cleanup, then work when available again.
      await db.prepare('UPDATE community_media SET deleting=1 WHERE id=?').bind(back).run();
      const pending = (await (await admin(`decks/${id}`)).json()).deck;
      assert.equal((await admin(`decks/${id}/review`, 'POST', { decision: 'approve', expectedRevision: pending.revision })).status, 409);
      await db.prepare('UPDATE community_media SET deleting=0 WHERE id=?').bind(back).run();
      await approve(id);
      for (const path of [`decks/${id}/preview`, `decks/${id}`]) {
        const response = await (await request(path)).json();
        assert.equal(response.deck.cards.length, 3);
        assert.equal(response.deck.cards[0].cardType, 'images');
        assert.equal(response.deck.cards[0].question, '');
        assert.equal(response.deck.cards[0].correctAnswer, '');
        assert.equal(response.deck.cards[0].promptImageID, front);
        assert.equal(response.deck.cards[0].answerImageID, back);
        assert.equal(response.deck.cards[1].answerImageID, null);
        assert.equal(response.deck.cards[1].fieldMedia['option:1'].audioID, audio);
        assert.equal(response.deck.cards[1].correctOptionIndex, 1);
      }
      for (const image of [front, back]) {
        assert.deepEqual(Buffer.from(await (await request(`media/${image}`)).arrayBuffer()), png);
        assert.equal((await request(`media/${image}`, 'HEAD')).status, 200);
      }
      // D1 itself guards the new reference against attachment/cleanup races.
      const missing = structuredClone(payload.cards); missing[0].answerImageID = crypto.randomUUID();
      await assert.rejects(db.prepare('UPDATE community_decks SET cards_json=? WHERE id=?').bind(JSON.stringify(missing), id).run(), /community_attachment_unavailable/);
      await assert.rejects(db.prepare("UPDATE community_decks SET status='draft',review_status='pending',cards_json=? WHERE id=?").bind(JSON.stringify(missing), id).run(), /community_attachment_unavailable/);
      const missingField = structuredClone(payload.cards); missingField[1].fieldMedia['option:1'].audioID = crypto.randomUUID();
      await assert.rejects(db.prepare('UPDATE community_decks SET cards_json=? WHERE id=?').bind(JSON.stringify(missingField), id).run(), /community_attachment_unavailable/);
      // Admin edits preserve both sides, then removing only the back unlinks it.
      const current = (await (await admin(`decks/${id}`)).json()).deck;
      const edit = { ...payload, expectedRevision: current.revision, downloadCount: current.download_count };
      assert.equal((await admin(`decks/${id}`, 'PUT', edit)).status, 200);
      assert.equal((await (await request(`decks/${id}/preview`)).json()).deck.cards[0].answerImageID, back);
      payload.cards[0].answerImageID = null;
      payload.cards[1].fieldMedia.hint = {}; // Unlink the same image from every field before cleanup.
      assert.equal((await request(`decks/${id}`, 'PUT', payload, token)).status, 202);
      await approve(id);
      assert.equal((await request(`media/${front}`)).status, 200);
      assert.equal((await request(`media/${back}`)).status, 404);
      assert.equal((await db.prepare('SELECT attached FROM community_media WHERE id=?').bind(back).first()).attached, 0);
      await db.prepare('UPDATE community_media SET created_at=1 WHERE id=?').bind(back).run();
      await cleanupCommunity(await mf.getBindings());
      assert.equal(await db.prepare('SELECT id FROM community_media WHERE id=?').bind(back).first(), null);
      assert.equal((await request(`media/${front}`)).status, 200);
      firstImageID = front;
    }
    for (const [index, id] of deckIDs.entries()) assert.equal((await request(`decks/${id}`, 'DELETE', undefined, tokens[index])).status, 200);
    await cleanupCommunity(await mf.getBindings());
    for (const key of mediaKeys) assert.equal(await bucket.head(key), null);
  } finally { await mf.dispose(); }
});
