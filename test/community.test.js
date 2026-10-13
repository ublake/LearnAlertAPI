import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { verifyAppleIdentity, sha256 } from '../src/lib/communityAuth.js';
import { cleanupCommunity } from '../src/routes/community.js';
import { ensureCommunityUser, generatedCommunityHandle } from '../src/lib/communityHandles.js';
import { readLimitedBody, validateCommunityDeck } from '../src/lib/communityValidation.js';

const nonce = 'a'.repeat(64);
const toBase64URL = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

async function applyCommunityMigrations(db) {
  for (const file of (await readdir(new URL('../community-migrations/', import.meta.url))).sort()) {
      const sql = await readFile(new URL(`../community-migrations/${file}`, import.meta.url), 'utf8');
      const triggers = sql.match(/CREATE TRIGGER[\s\S]*?END;/g) ?? [];
      const remaining = sql.replace(/CREATE TRIGGER[\s\S]*?END;/g, '');
      for (const statement of remaining.split(';').map(item => item.trim()).filter(Boolean)) await db.prepare(statement).run();
      for (const trigger of triggers) await db.prepare(trigger).run();
    }
}

test('Apple identity verification rejects incorrect audience, nonce, expiry, and forged signatures', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'test-key', alg: 'RS256' };
  const claims = { iss: 'https://appleid.apple.com', aud: 'com.learnalert.app', sub: 'apple-test-user', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce: await sha256(nonce) };
  async function tokenFor(overrides = {}) {
    const message = `${toBase64URL({ kid: 'test-key', alg: 'RS256' })}.${toBase64URL({ ...claims, ...overrides })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(message));
    return `${message}.${Buffer.from(signature).toString('base64url')}`;
  }
  const token = await tokenFor();
  assert.equal(await verifyAppleIdentity(token, nonce, 'com.learnalert.app', [jwk]), 'apple-test-user');
  for (const invalid of [{ aud: 'another-app' }, { exp: claims.iat - 1 }, { nonce: 'wrong' }, { iss: 'https://attacker.example' }]) {
    await assert.rejects(verifyAppleIdentity(await tokenFor(invalid), nonce, 'com.learnalert.app', [jwk]), error => error.status === 401);
  }
  const forged = token.slice(0, token.lastIndexOf('.') + 1) + Buffer.alloc(256).toString('base64url');
  await assert.rejects(verifyAppleIdentity(forged, nonce, 'com.learnalert.app', [jwk]), error => error.status === 401);
});

test('upload limits apply to streamed bodies even without Content-Length', async () => {
  const request = new Request('https://example.test', { method: 'POST', body: new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close();
  } }), duplex: 'half' });
  await assert.rejects(readLimitedBody(request, 10), error => error.status === 413);
});

test('community validation strips private fields and rejects incorrect answers', () => {
  const result = validateCommunityDeck({ name: 'Safe deck', sourceText: 'PRIVATE NOTES', cards: [{ id: '1', cardType: 'tap_reveal', question: 'Q', correctAnswer: 'A', masteryScore: 3 }] });
  assert.equal(result.cards[0].masteryScore, undefined);
  assert.equal(result.metadata.sourceText, undefined);
  assert.throws(() => validateCommunityDeck({ name: 'Invalid', cards: [{ id: '1', cardType: 'multiple_choice', question: 'Q', options: ['A', 'B'], correctAnswer: 'C' }] }));
});

test('community publishing preserves image/audio, enforces ownership, and hides drafts/removed media', async () => {
  const bundle = await build({ entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-04', d1Databases: ['COMMUNITY_DB'], r2Buckets: ['DECK_ASSETS'], bindings: { API_KEY: 'ai-secret', COMMUNITY_MODERATION_TOKEN: 'moderator-test' } }));
  try {
    const db = await mf.getD1Database('COMMUNITY_DB');
    await applyCommunityMigrations(db);
    const ownerToken = 'b'.repeat(64);
    const otherToken = 'c'.repeat(64);
    for (const [id, token] of [['owner', ownerToken], ['other', otherToken]]) {
      await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,?)').bind(id, `@${id}`, 1).run();
      await db.prepare('INSERT INTO community_sessions VALUES(?,?,?)').bind(await sha256(token), id, Math.floor(Date.now() / 1000) + 3600).run();
    }
    async function request(path, method = 'GET', body, token) {
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body && !(body instanceof Uint8Array)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
      return mf.dispatchFetch(`https://api.example.test/v1/community/${path}`, { method, headers, body });
    }
    assert.equal((await request('account')).status, 401);
    assert.equal((await request('account/decks')).status, 401);
    assert.equal((await request('account', 'PUT', { username: 'hi', avatar: { hair: 0, eyes: 0, mouth: 0 } }, ownerToken)).status, 400);
    assert.equal((await request('account', 'PUT', { username: 'buddy', avatar: { hair: 16, eyes: 0, mouth: 0 } }, ownerToken)).status, 400);
    const profile = { username: 'Funny_Buddy', avatar: { hair: 5, eyes: 4, mouth: 3 } };
    assert.equal((await request('account', 'PUT', profile, ownerToken)).status, 200);
    assert.deepEqual(await (await request('account', 'GET', undefined, ownerToken)).json(), {
      handle: '@funny_buddy', avatar: { ...profile.avatar, skinTone: 3 }, isComplete: true
    });
    assert.equal((await request('account', 'PUT', { ...profile, username: '@FUNNY_BUDDY' }, otherToken)).status, 409);
    assert.equal((await request('account', 'GET', undefined, otherToken)).status, 200);
    assert.equal((await request('account', 'PUT', { ...profile, username: 'different_name' }, ownerToken)).status, 409);
    for (const skinTone of [-1, 7, 2.5, null, '3']) {
      assert.equal((await request('account', 'PUT', { ...profile, avatar: { ...profile.avatar, skinTone } }, ownerToken)).status, 400);
    }
    for (let index = 0; index < 16; index++) {
      profile.avatar = { hair: index, eyes: index, mouth: index, skinTone: index % 7 };
      assert.equal((await request('account', 'PUT', profile, ownerToken)).status, 200);
      assert.deepEqual((await (await request('account', 'GET', undefined, ownerToken)).json()).avatar, profile.avatar);
    }
    for (const part of ['hair', 'eyes', 'mouth']) {
      for (const invalid of [-1, 16, 1.5, null, '2']) {
        assert.equal((await request('account', 'PUT', { ...profile, avatar: { ...profile.avatar, [part]: invalid } }, ownerToken)).status, 400);
      }
    }
    profile.avatar.skinTone = 6;
    assert.equal((await request('account', 'PUT', profile, ownerToken)).status, 200);
    const legacyAvatar = { hair: profile.avatar.hair, eyes: profile.avatar.eyes, mouth: profile.avatar.mouth };
    assert.equal((await request('account', 'PUT', { username: profile.username, avatar: legacyAvatar }, ownerToken)).status, 200);
    assert.deepEqual((await (await request('account', 'GET', undefined, ownerToken)).json()).avatar, profile.avatar);
    const concurrentSetups = await Promise.all(['first_choice', 'second_choice'].map(username =>
      request('account', 'PUT', { username, avatar: legacyAvatar }, otherToken)));
    assert.deepEqual(concurrentSetups.map(response => response.status).sort(), [200, 409]);
    const winner = await concurrentSetups.find(response => response.status === 200).json();
    assert.equal((await (await request('account', 'GET', undefined, otherToken)).json()).handle, winner.handle);
    assert.equal((await request('decks/drafts', 'POST', { name: 'Unauthorized' })).status, 401);
    const draft = await request('decks/drafts', 'POST', { name: 'Images and audio', categoryTag: 'Science' }, ownerToken);
    assert.equal(draft.status, 201);
    const { id } = await draft.json();
    assert.equal((await request(`decks/${id}`)).status, 404);
    const listingBefore = await (await request('decks')).json();
    assert.deepEqual(listingBefore.decks, []);
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const audio = new TextEncoder().encode('RIFF1234WAVEfmt test data');
    async function upload(bytes, contentType, token = ownerToken) {
      return mf.dispatchFetch(`https://api.example.test/v1/community/decks/${id}/media`, { method: 'POST', headers: { 'Content-Type': contentType, Authorization: `Bearer ${token}` }, body: bytes });
    }
    assert.equal((await upload(image, 'image/jpeg', otherToken)).status, 404);
    assert.equal((await upload(image, 'text/html')).status, 415);
    assert.equal((await upload(new TextEncoder().encode('not a real image'), 'image/jpeg')).status, 400);
    const imageResponse = await upload(image, 'image/jpeg');
    assert.equal(imageResponse.status, 201);
    const imageID = (await imageResponse.json()).id;
    const audioResponse = await upload(audio, 'audio/wav');
    assert.equal(audioResponse.status, 201);
    const audioID = (await audioResponse.json()).id;
    assert.equal((await request(`media/${imageID}`)).status, 404);
    assert.equal((await request(`media/${imageID}`, 'GET', undefined, ownerToken)).status, 200);
    const payload = { name: 'Images and audio', categoryTag: 'Science', cards: [{ id: 'card-1', question: 'Listen and identify', correctAnswer: 'Example', cardType: 'tap_reveal', promptImageID: imageID, promptAudioID: audioID, sectionName: 'Introduction' }] };
    assert.equal((await request(`decks/${id}`, 'PUT', payload, otherToken)).status, 404);
    const invalid = structuredClone(payload);
    invalid.cards[0].promptImageID = audioID;
    assert.equal((await request(`decks/${id}`, 'PUT', invalid, ownerToken)).status, 400);
    const unknown = structuredClone(payload);
    unknown.cards[0].promptImageID = crypto.randomUUID();
    assert.equal((await request(`decks/${id}`, 'PUT', unknown, ownerToken)).status, 400);
    const published = await request(`decks/${id}`, 'PUT', payload, ownerToken);
    assert.equal(published.status, 200, await published.text());
    const listing = await (await request('decks?category=Science&q=Images')).json();
    assert.equal(listing.decks.length, 1);
    assert.equal(listing.decks[0].cards, undefined);
    assert.equal(listing.decks[0].authorHandle, '@funny_buddy');
    assert.deepEqual(listing.decks[0].authorAvatar, profile.avatar);
    const mine = await (await request('account/decks', 'GET', undefined, ownerToken)).json();
    assert.equal(mine.decks.length, 1);
    assert.equal((await (await request('account/decks', 'GET', undefined, otherToken)).json()).decks.length, 0);
    const preview = await (await request(`decks/${id}/preview`)).json();
    assert.equal(preview.deck.downloadCount, 0);
    assert.equal(preview.deck.cards[0].promptImageID, imageID);
    assert.equal((await db.prepare('SELECT download_count AS count FROM community_decks WHERE id=?').bind(id).first()).count, 0);
    const detail = await (await request(`decks/${id}`)).json();
    assert.equal(detail.deck.cards[0].promptAudioID, audioID);
    assert.equal(detail.deck.cards[0].promptImageID, imageID);
    assert.equal(detail.deck.cards[0].sectionName, 'Introduction');
    const publicAudio = await request(`media/${audioID}`);
    assert.equal(publicAudio.status, 200);
    assert.equal(publicAudio.headers.get('Content-Type'), 'audio/wav');
    assert.deepEqual(new Uint8Array(await publicAudio.arrayBuffer()), audio);
    // Replacement uploads can coexist with the published snapshot. Only referenced media is public.
    await db.prepare('UPDATE community_media SET byte_size=? WHERE id=?').bind(100 * 1024 * 1024 - audio.length, imageID).run();
    const replacementResponse = await upload(image, 'image/jpeg');
    assert.equal(replacementResponse.status, 201);
    const replacementID = (await replacementResponse.json()).id;
    assert.equal((await request(`media/${replacementID}`)).status, 404);
    const oversized = structuredClone(payload);
    oversized.cards[0].optionImageIDs = [replacementID];
    oversized.cards[0].options = ['Example'];
    assert.equal((await request(`decks/${id}`, 'PUT', oversized, ownerToken)).status, 413);
    const updated = structuredClone(payload);
    updated.cards[0].promptImageID = replacementID;
    assert.equal((await request(`decks/${id}`, 'PUT', updated, ownerToken)).status, 200);
    assert.equal((await request(`media/${imageID}`)).status, 404);
    assert.equal((await request(`media/${replacementID}`)).status, 200);
    const bucket = await mf.getR2Bucket('DECK_ASSETS');
    const staleResponse = await upload(image, 'image/jpeg');
    const staleID = (await staleResponse.json()).id;
    await db.prepare('UPDATE community_media SET created_at=? WHERE id=?').bind(1, staleID).run();
    let publication;
    await cleanupCommunity({ COMMUNITY_DB: db, DECK_ASSETS: {
      async delete(key) {
        // Cleanup has claimed the file; publication must not succeed.
        const racing = structuredClone(updated); racing.cards[0].promptImageID = staleID;
        publication = await request(`decks/${id}`, 'PUT', racing, ownerToken);
        await bucket.delete(key);
      }
    } });
    assert.equal(publication.status, 400);
    assert.equal((await request(`media/${replacementID}`)).status, 200);
    // The transaction trigger protects the gap after preliminary validation too.
    const claimedResponse = await upload(image, 'image/jpeg');
    const claimedID = (await claimedResponse.json()).id;
    await db.prepare('UPDATE community_media SET deleting=1 WHERE id=?').bind(claimedID).run();
    const unsafe = structuredClone(updated); unsafe.cards[0].optionImageIDs = [claimedID];
    await assert.rejects(db.batch([
      db.prepare('UPDATE community_media SET attached=1 WHERE id=?').bind(claimedID),
      db.prepare('UPDATE community_decks SET cards_json=? WHERE id=?').bind(JSON.stringify(unsafe.cards), id)
    ]), /community_attachment_unavailable/);
    assert.equal((await db.prepare('SELECT attached FROM community_media WHERE id=?').bind(claimedID).first()).attached, 0);
    // A published old attachment is retained indefinitely.
    await db.prepare('UPDATE community_media SET created_at=1 WHERE id=?').bind(replacementID).run();
    await cleanupCommunity({ COMMUNITY_DB: db, DECK_ASSETS: bucket });
    assert.equal((await request(`media/${replacementID}`)).status, 200);
    assert.equal((await request(`decks/${id}/reports`, 'POST', { reason: 'Test report' }, otherToken)).status, 200);
    assert.equal((await request('moderation/reports')).status, 404);
    const reports = await mf.dispatchFetch('https://api.example.test/v1/community/moderation/reports', {
      headers: { Authorization: 'Bearer moderator-test' }
    });
    assert.equal(reports.status, 200);
    assert.equal((await reports.json()).reports[0].deck_id, id);
    assert.equal((await request(`decks/${id}`, 'DELETE', undefined, otherToken)).status, 404);
    assert.equal((await request(`decks/${id}`, 'DELETE', undefined, ownerToken)).status, 200);
    assert.equal((await request(`decks/${id}`)).status, 404);
    assert.equal((await request(`media/${audioID}`)).status, 404);
    assert.equal((await request(`media/${imageID}`)).status, 404);
    // Moderator removal is independent of ownership and immediately hides a deck.
    const moderatedID = (await (await request('decks/drafts', 'POST', { name: 'Moderation test' }, ownerToken)).json()).id;
    assert.equal((await request(`decks/${moderatedID}`, 'PUT', { name: 'Moderation test', cards: [{ id: 'q', question: 'Q', correctAnswer: 'A', cardType: 'tap_reveal' }] }, ownerToken)).status, 200);
    assert.equal((await mf.dispatchFetch(`https://api.example.test/v1/community/moderation/decks/${moderatedID}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer wrong' }
    })).status, 404);
    assert.equal((await mf.dispatchFetch(`https://api.example.test/v1/community/moderation/decks/${moderatedID}`, {
      method: 'DELETE', headers: { Authorization: 'Bearer moderator-test' }
    })).status, 200);
    assert.equal((await request(`decks/${moderatedID}`)).status, 404);
    // Both declared origins and renamed/reordered copies are rejected before publishing.
    for (const restricted of [{ origin: 'community' }, { origin: 'builtIn' }, { sourceCommunityID: id }, { sourcePremadeID: 'sat' }, { deckType: 'Course' }]) {
      assert.equal((await request('decks/drafts', 'POST', { name: 'Copy', ...restricted }, otherToken)).status, 403);
    }
    const originalID = (await (await request('decks/drafts', 'POST', { name: 'Original content' }, ownerToken)).json()).id;
    const original = { name: 'Original content', cards: ['Mercury', 'Venus', 'Earth'].map((answer, i) => ({ id: `original-${i}`, question: `Planet ${i + 1}`, correctAnswer: answer, cardType: 'tap_reveal' })) };
    assert.equal((await request(`decks/${originalID}`, 'PUT', original, ownerToken)).status, 200);
    const copyID = (await (await request('decks/drafts', 'POST', { name: 'Renamed copy' }, otherToken)).json()).id;
    const copied = { name: 'Renamed copy', cards: original.cards.toReversed().map((card, i) => ({ ...card, id: `new-${i}`, question: `  ${card.question.toUpperCase()}  ` })) };
    assert.equal((await request(`decks/${copyID}`, 'PUT', copied, otherToken)).status, 409);
    // Original creators can still update their own publications.
    assert.equal((await request(`decks/${originalID}`, 'PUT', original, ownerToken)).status, 200);
    copied.cards[0].correctAnswer = 'Different material';
    assert.equal((await request(`decks/${copyID}`, 'PUT', copied, otherToken)).status, 200);

    // Account deletion removes profiles, sessions and public copies, preserving an R2 retry queue.
    const accountID = (await (await request('decks/drafts', 'POST', { name: 'Account removal' }, ownerToken)).json()).id;
    const attachment = await mf.dispatchFetch(`https://api.example.test/v1/community/decks/${accountID}/media`, {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg', Authorization: `Bearer ${ownerToken}` }, body: image
    });
    const attachmentID = (await attachment.json()).id;
    assert.equal((await request(`decks/${accountID}`, 'PUT', { name: 'Account removal', cards: [{ id: 'q', question: 'Q', correctAnswer: 'A', cardType: 'tap_reveal', promptImageID: attachmentID }] }, ownerToken)).status, 200);
    assert.equal((await request('account', 'DELETE')).status, 401);
    assert.equal((await request('account', 'DELETE', undefined, ownerToken)).status, 200);
    assert.equal((await request(`decks/${accountID}`)).status, 404);
    assert.equal((await request(`media/${attachmentID}`)).status, 404);
    assert.equal(await db.prepare("SELECT id FROM community_users WHERE id='owner'").first(), null);
    assert.equal((await request('decks/drafts', 'POST', { name: 'Expired account' }, ownerToken)).status, 401);
    assert.ok((await db.prepare('SELECT COUNT(*) AS count FROM community_deleted_objects').first()).count > 0);
    await cleanupCommunity({ COMMUNITY_DB: db, DECK_ASSETS: bucket });
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM community_deleted_objects').first()).count, 0);
  } finally { await mf.dispose(); }
});


test('Apple sign-in restores a saved profile after its original generated username is reused', async () => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'profile-sign-in-test', alg: 'RS256' };
  const claims = { iss: 'https://appleid.apple.com', aud: 'com.learnalert.app', sub: 'profile-account-test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, nonce: await sha256(nonce) };
  const message = `${toBase64URL({ kid: jwk.kid, alg: 'RS256' })}.${toBase64URL(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(message));
  const identityToken = `${message}.${Buffer.from(signature).toString('base64url')}`;
  const bundle = await build({ entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-04', d1Databases: ['COMMUNITY_DB'], r2Buckets: ['DECK_ASSETS'],
    outboundService: request => {
      assert.equal(request.url, 'https://appleid.apple.com/auth/keys');
      return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'Content-Type': 'application/json' } });
    }
  }));
  try {
    const db = await mf.getD1Database('COMMUNITY_DB');
    await applyCommunityMigrations(db);
    const signIn = () => mf.dispatchFetch('https://api.example.test/v1/community/auth/apple', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identityToken, nonce }) });
    const firstResponse = await signIn();
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();
    assert.equal(first.profile.isComplete, false);
    assert.match(first.handle, /^@[a-z]+_[a-z]+$/);
    assert.deepEqual(first.profile.avatar, { hair: 0, eyes: 0, mouth: 0, skinTone: 3 });
    const updated = await mf.dispatchFetch('https://api.example.test/v1/community/account', { method: 'PUT', headers: { Authorization: `Bearer ${first.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'funny_buddy', avatar: { hair: 2, eyes: 4, mouth: 5, skinTone: 0 } }) });
    assert.equal(updated.status, 200);
    await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,?)').bind('another-account', first.handle, 1).run();
    const secondResponse = await signIn();
    assert.equal(secondResponse.status, 201);
    const second = await secondResponse.json();
    assert.equal(second.handle, '@funny_buddy');
    assert.deepEqual(second.profile, { handle: '@funny_buddy', avatar: { hair: 2, eyes: 4, mouth: 5, skinTone: 0 }, isComplete: true });
    assert.notEqual(second.token, first.token);
    const restored = await mf.dispatchFetch('https://api.example.test/v1/community/account', { headers: { Authorization: `Bearer ${second.token}` } });
    assert.deepEqual(await restored.json(), second.profile);
  } finally { await mf.dispose(); }
});


test('community Popular and Recent sorting preserve search, filters and pagination', async () => {
  const bundle = await build({ entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-04', d1Databases: ['COMMUNITY_DB'] }));
  try {
    const db = await mf.getD1Database('COMMUNITY_DB');
    await applyCommunityMigrations(db);
    await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,?)').bind('sort-owner', '@sort_owner', 1).run();
    for (const [name, category, date, downloads, status] of [
      ['Older popular', 'Science', 100, 20, 'published'],
      ['Newer popular', 'Science', 200, 20, 'published'],
      ['Newest deck', 'Science', 300, 1, 'published'],
      ['Language favorite', 'Languages', 150, 40, 'published'],
      ['Hidden draft', 'Science', 500, 90, 'draft']
    ]) {
      await db.prepare(`INSERT INTO community_decks(id,owner_id,name,description,category_tag,color_hex,deck_type,cards_json,card_count,download_count,status,published_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), 'sort-owner', name, '', category, '#4868F8', 'Quiz', '[]', 0, downloads, status, date, date, date).run();
    }
    async function list(query) { return (await mf.dispatchFetch(`https://api.example.test/v1/community/decks?${query}`)).json(); }
    const names = page => page.decks.map(deck => deck.name);
    assert.deepEqual(names(await list('sort=popular')), ['Language favorite', 'Newer popular', 'Older popular', 'Newest deck']);
    assert.deepEqual(names(await list('sort=recent')), ['Newest deck', 'Newer popular', 'Language favorite', 'Older popular']);
    assert.deepEqual(names(await list('')), names(await list('sort=recent')));
    assert.deepEqual(names(await list('sort=invalid')), names(await list('sort=recent')));
    const first = await list('sort=popular&category=Science&limit=1');
    assert.deepEqual(names(first), ['Newer popular']); assert.equal(first.nextOffset, 1); assert.equal(first.totalCount, 3);
    assert.deepEqual(names(await list(`sort=popular&category=Science&limit=1&offset=${first.nextOffset}`)), ['Older popular']);
    const searched = await list('sort=recent&category=Science&q=popular');
    assert.deepEqual(names(searched), ['Newer popular', 'Older popular']); assert.equal(searched.totalCount, 2);
    const beyond = await list('sort=popular&offset=100');
    assert.deepEqual(beyond.decks, []); assert.equal(beyond.totalCount, 4);
    const noResults = await list('q=does-not-exist');
    assert.equal(noResults.totalCount, 0); assert.equal(noResults.nextOffset, null);
  } finally { await mf.dispose(); }
});


test('generated usernames retry collisions atomically and preserve completed profiles', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("OK")}}', compatibilityDate: '2026-09-04', d1Databases: ['COMMUNITY_DB'] }));
  try {
    const db = await mf.getD1Database('COMMUNITY_DB');
    await applyCommunityMigrations(db);
    await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,?)').bind('reserved', '@Cozy_Otter', 1).run();
    const fresh = await ensureCommunityUser(db, 'fresh', 2, attempt => attempt === 0 ? '@cozy_otter' : '@sunny_mango');
    assert.equal(fresh.handle, '@sunny_mango');
    await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,?)').bind('legacy', '@learner_0123456789abcdef', 1).run();
    const upgraded = await ensureCommunityUser(db, 'legacy', 2, () => '@bouncy_bean');
    assert.equal(upgraded.handle, '@bouncy_bean');
    await db.prepare('INSERT INTO community_users(id,handle,created_at,profile_completed) VALUES(?,?,?,?)').bind('completed', '@learner_abcdef0123456789', 1, 1).run();
    assert.equal((await ensureCommunityUser(db, 'completed', 2, () => '@never_changed')).handle, '@learner_abcdef0123456789');
    const concurrent = await Promise.all([
      ensureCommunityUser(db, 'same-apple-user', 2, () => '@happy_panda'),
      ensureCommunityUser(db, 'same-apple-user', 2, () => '@tiny_mochi')
    ]);
    assert.equal(concurrent[0].handle, concurrent[1].handle);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM community_users WHERE id='same-apple-user'").first()).n, 1);
    await assert.rejects(ensureCommunityUser(db, 'full', 2, () => '@COZY_OTTER'), error => error.status === 503);
    for (let attempt = 0; attempt < 32; attempt++) {
      const name = generatedCommunityHandle(attempt);
      assert.match(name, attempt < 16 ? /^@[a-z]+_[a-z]+$/ : /^@[a-z]+_[a-z]+[0-9]{2}$/);
      assert.ok(name.length <= 25);
    }
  } finally { await mf.dispose(); }
});
