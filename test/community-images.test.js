import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sha256 } from '../src/lib/communityAuth.js';
import { communityContentSignature, validateCommunityDeck } from '../src/lib/communityValidation.js';

const imageCard = (overrides = {}) => ({ id: 'picture', cardType: 'images', promptImageID: crypto.randomUUID(), ...overrides });

test('image cards require a single image without text, choices, pairs, or audio', () => {
  const card = imageCard();
  const result = validateCommunityDeck({ name: 'Pictures', cards: [card] });
  assert.equal(result.cards[0].cardType, 'images');
  assert.equal(result.cards[0].question, '');
  assert.equal(result.cards[0].correctAnswer, '');
  assert.equal(result.cards[0].hint, '');
  assert.deepEqual(result.cards[0].options, []);
  assert.deepEqual([...result.media], [[card.promptImageID, 'image']]);
  for (const invalid of [
    { promptImageID: null }, { promptImageID: 'not-an-upload' },
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

test('image-only publication requires owned uploaded image bytes and survives review/preview/download', async () => {
  const bundle = await build({ entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-04', d1Databases: ['COMMUNITY_DB'], r2Buckets: ['DECK_ASSETS'] }));
  try {
    const db = await mf.getD1Database('COMMUNITY_DB');
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
      await db.prepare('INSERT INTO community_sessions VALUES(?,?,?)').bind(await sha256(token), user, Math.floor(Date.now() / 1000) + 3600).run();
    }
    function request(path, method = 'GET', body, token = null, contentType = 'application/json') {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = contentType;
      return mf.dispatchFetch(`https://community.test/v1/community/${path}`, { method, headers, body: body === undefined ? undefined : contentType === 'application/json' ? JSON.stringify(body) : body });
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH5kAAAAASUVORK5CYII=', 'base64');
    let firstImageID;
    for (const [index, token] of tokens.entries()) {
      const draft = await request('decks/drafts', 'POST', { name: `Image deck ${index}` }, token);
      assert.equal(draft.status, 201);
      const { id } = await draft.json();
      const upload = await request(`decks/${id}/media`, 'POST', png, token, 'image/png');
      assert.equal(upload.status, 201);
      const imageID = (await upload.json()).id;
      const payload = { name: `Image deck ${index}`, cards: Array.from({ length: 3 }, (_, i) => imageCard({ id: String(i), promptImageID: imageID })) };
      const absent = structuredClone(payload); absent.cards[0].promptImageID = crypto.randomUUID();
      assert.equal((await request(`decks/${id}`, 'PUT', absent, token)).status, 400);
      if (firstImageID) {
        const foreign = structuredClone(payload); foreign.cards[0].promptImageID = firstImageID;
        assert.equal((await request(`decks/${id}`, 'PUT', foreign, token)).status, 400);
      }
      const submitted = await request(`decks/${id}`, 'PUT', payload, token);
      assert.equal(submitted.status, 202, await submitted.text());
      assert.equal((await request(`decks/${id}/preview`)).status, 404);
      await db.prepare("UPDATE community_decks SET status='published',review_status='approved',published_at=1 WHERE id=?").bind(id).run();
      const preview = await (await request(`decks/${id}/preview`)).json();
      const download = await (await request(`decks/${id}`)).json();
      for (const response of [preview, download]) {
        assert.equal(response.deck.cards.length, 3);
        assert.equal(response.deck.cards[0].cardType, 'images');
        assert.equal(response.deck.cards[0].question, '');
        assert.equal(response.deck.cards[0].correctAnswer, '');
        assert.equal(response.deck.cards[0].promptImageID, imageID);
      }
      assert.deepEqual(Buffer.from(await (await request(`media/${imageID}`)).arrayBuffer()), png);
      firstImageID = imageID;
    }
  } finally { await mf.dispose(); }
});
