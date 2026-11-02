import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sha256 } from '../src/lib/communityAuth.js';

const bindings = { ADMIN_ACCESS_ISSUER: 'https://developer-admin-test.cloudflareaccess.com', ADMIN_ACCESS_AUD: 'developer-admin', ADMIN_EMAILS: 'admin@example.com' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');

async function signedAccess() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'developer-admin', alg: 'RS256' };
  const token = async (email = bindings.ADMIN_EMAILS) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ iss: bindings.ADMIN_ACCESS_ISSUER, aud: [bindings.ADMIN_ACCESS_AUD], email, iat: timestamp, exp: timestamp + 600 })}`;
    return `${message}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(message))).toString('base64url')}`;
  };
  return { jwk, token };
}

test('admin developer roles require Access identity and preserve private account state', async t => {
  const { jwk, token } = await signedAccess();
  const jwt = await token();
  const bundle = await build({ entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-04', bindings, d1Databases: ['COMMUNITY_DB'], outboundService: () => new Response(JSON.stringify({ keys: [jwk] })) }));
  try {
    const db = await mf.getD1Database('COMMUNITY_DB');
    for (const file of (await readdir(new URL('../community-migrations/', import.meta.url))).sort()) {
      const sql = await readFile(new URL(`../community-migrations/${file}`, import.meta.url), 'utf8');
      const triggers = sql.match(/CREATE TRIGGER[\s\S]*?END;/g) || [];
      for (const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g, '').split(';').map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
      for (const trigger of triggers) await db.prepare(trigger).run();
    }
    const session = 'a'.repeat(64), developerSession = 'b'.repeat(64);
    for (const [id, role, uploads, created] of [['target', 0, 0, 3], ['existing', 1, 1, 2], ['restricted', 0, 0, 1], ['race', 0, 0, 0]]) {
      await db.prepare('INSERT INTO community_users(id,handle,created_at,profile_completed,is_developer,developer_anki_uploads) VALUES(?,?,?,1,?,?)').bind(id, `@${id}`, created, role, uploads).run();
    }
    for (const [id, value] of [['target', session], ['existing', developerSession]]) await db.prepare('INSERT INTO community_sessions VALUES(?,?,?)').bind(await sha256(value), id, Math.floor(Date.now() / 1000) + 3600).run();
    await db.prepare("UPDATE community_users SET hide_stats_publicly=1 WHERE id='target'").run();
    const restricted = await db.prepare("SELECT public_id FROM community_users WHERE id='restricted'").first();
    await db.prepare("INSERT INTO community_account_restrictions(account_id,author_id,handle,status,reason,until_at,updated_at,actor) VALUES('restricted',?,'@restricted','suspended','Review',9999999999,1,'admin@example.com')").bind(restricted.public_id).run();
    const deckId = crypto.randomUUID();
    await db.prepare("INSERT INTO community_decks(id,owner_id,name,category_tag,color_hex,deck_type,status,created_at,updated_at) VALUES(?,'target','Keep this deck','General','#123456','Quiz','published',1,1)").bind(deckId).run();
    const call = (path, method = 'GET', body, headers = {}) => mf.dispatchFetch(`https://api.example.test/v1/admin/${path}`, { method, headers: { 'Cf-Access-Jwt-Assertion': jwt, Origin: 'https://learnalertapp.com', 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const update = (changes = {}) => ({ id: 'target', isDeveloper: true, allowAnkiUploads: false, expectedIsDeveloper: false, expectedAllowAnkiUploads: false, ...changes });
    const auditCount = async () => (await db.prepare('SELECT COUNT(*) AS n FROM community_admin_audit').first()).n;

    await t.test('rejects unsigned requests, non-admin Access identities, community tokens and cross-origin writes', async () => {
      for (const authorization of ['', `Bearer ${session}`, `Bearer ${developerSession}`]) {
        const headers = { 'Cf-Access-Jwt-Assertion': '', 'Cf-Access-Authenticated-User-Email': bindings.ADMIN_EMAILS, Authorization: authorization };
        assert.equal((await call('developers', 'GET', undefined, headers)).status, 401);
        assert.equal((await call('developers/update', 'POST', update(), headers)).status, 401);
      }
      assert.equal((await call('developers', 'GET', undefined, { 'Cf-Access-Jwt-Assertion': await token('other@example.com') })).status, 401);
      for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: '' }, { 'Content-Type': 'text/plain' }]) assert.equal((await call('developers/update', 'POST', update(), headers)).status, 403);
      assert.equal(await auditCount(), 0);
    });

    await t.test('lists accounts with role filtering, escaped search, restrictions and stable pagination', async () => {
      const response = await call('developers');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const all = await response.json();
      assert.deepEqual(all.items.map(row => row.id), ['target', 'existing', 'restricted', 'race']);
      assert.equal(all.nextOffset, null);
      assert.equal(all.items[0].profile_completed, 1);
      assert.equal(all.items[0].is_developer, 0);
      assert.equal(all.items[0].developer_anki_uploads, 0);
      assert.equal(all.items[0].created_at, 3);
      assert.match(all.items[0].author_id, /^[a-f0-9]{32}$/);
      assert.equal(all.items[2].restriction_status, 'suspended');
      assert.equal(all.items[2].until_at, 9999999999);
      assert.deepEqual((await (await call('developers?role=developer')).json()).items.map(row => row.id), ['existing']);
      assert.deepEqual((await (await call('developers?role=all&q=%40TARGET')).json()).items.map(row => row.id), ['target']);
      assert.deepEqual((await (await call(`developers?q=${all.items[0].author_id}`)).json()).items.map(row => row.id), ['target']);
      assert.equal((await (await call('developers?q=%25')).json()).items.length, 0);
      assert.equal((await call('developers?role=owner')).status, 400);
      for (let index = 0; index < 49; index++) await db.prepare('INSERT INTO community_users(id,handle,created_at) VALUES(?,?,?)').bind(`page-${index.toString().padStart(2, '0')}`, `@page_${index}`, -index - 1).run();
      const page = await (await call('developers?role=all')).json();
      assert.equal(page.items.length, 50); assert.equal(page.nextOffset, 50);
      const last = await (await call('developers?role=all&offset=50')).json();
      assert.equal(last.items.length, 3); assert.equal(last.nextOffset, null);
      assert.equal(new Set([...page.items, ...last.items].map(row => row.id)).size, 53);
    });

    await t.test('requires exact fields, real booleans, a valid account and consistent desired permissions', async () => {
      const invalid = [null, [], {}, update({ id: '' }), update({ id: ' ' }), update({ id: 1 }), update({ id: 'x'.repeat(256) }), update({ unknown: true }), update({ isDeveloper: false, allowAnkiUploads: true })];
      for (const key of ['isDeveloper', 'allowAnkiUploads', 'expectedIsDeveloper', 'expectedAllowAnkiUploads']) {
        for (const value of [0, 1, 'false', null]) invalid.push(update({ [key]: value }));
        const missing = update(); delete missing[key]; invalid.push(missing);
      }
      for (const body of invalid) assert.equal((await call('developers/update', 'POST', body)).status, 400, JSON.stringify(body));
      assert.equal((await call('developers/update', 'POST', update({ id: 'missing' }))).status, 404);
      assert.equal(await auditCount(), 0);
    });

    await t.test('grants, changes the upload option and revokes with before/after audit while retaining profile, sessions and decks', async () => {
      const before = await db.prepare("SELECT * FROM community_users WHERE id='target'").first();
      const deckBefore = await db.prepare('SELECT * FROM community_decks WHERE id=?').bind(deckId).first();
      const grant = await call('developers/update', 'POST', update());
      assert.equal(grant.status, 200);
      assert.deepEqual(await grant.json(), { success: true, user: { id: 'target', handle: '@target', isDeveloper: true, allowAnkiUploads: false } });
      const enabled = await call('developers/update', 'POST', update({ allowAnkiUploads: true, expectedIsDeveloper: true }));
      assert.equal(enabled.status, 200);
      assert.equal((await enabled.json()).user.allowAnkiUploads, true);
      const owner = await (await mf.dispatchFetch('https://api.example.test/v1/community/account', { headers: { Authorization: `Bearer ${session}` } })).json();
      assert.equal(owner.isDeveloper, true); assert.equal(owner.allowAnkiUploads, true);
      const publicProfile = await mf.dispatchFetch(`https://api.example.test/v1/community/profiles/${before.public_id}`);
      assert.equal(publicProfile.status, 200);
      const publicJSON = JSON.stringify(await publicProfile.json());
      for (const privateField of ['isDeveloper', 'allowAnkiUploads', 'is_developer', 'developer_anki_uploads']) assert.equal(publicJSON.includes(privateField), false);
      const revoke = await call('developers/update', 'POST', update({ isDeveloper: false, expectedIsDeveloper: true, expectedAllowAnkiUploads: true }));
      assert.equal(revoke.status, 200);
      assert.deepEqual((await revoke.json()).user, { id: 'target', handle: '@target', isDeveloper: false, allowAnkiUploads: false });
      assert.deepEqual(await db.prepare("SELECT * FROM community_users WHERE id='target'").first(), before);
      assert.deepEqual(await db.prepare('SELECT * FROM community_decks WHERE id=?').bind(deckId).first(), deckBefore);
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM community_sessions WHERE user_id='target'").first()).n, 1);
      const revokedOwner = await (await mf.dispatchFetch('https://api.example.test/v1/community/account', { headers: { Authorization: `Bearer ${session}` } })).json();
      assert.equal('isDeveloper' in revokedOwner, false);
      assert.equal('allowAnkiUploads' in revokedOwner, false);
      assert.equal((await mf.dispatchFetch('https://api.example.test/v1/community/account/developer', { method: 'PUT', headers: { Authorization: `Bearer ${session}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ allowAnkiUploads: true }) })).status, 403);
      const audit = (await db.prepare("SELECT * FROM community_admin_audit WHERE target='target'").all()).results;
      assert.equal(audit.length, 3);
      assert.ok(audit.every(row => row.actor === bindings.ADMIN_EMAILS && row.action === 'update_developer'));
      const details = audit.map(row => JSON.parse(row.details));
      assert.ok(details.some(row => row.before.isDeveloper === false && row.before.allowAnkiUploads === false && row.after.isDeveloper === true && row.after.allowAnkiUploads === false));
      assert.ok(details.some(row => row.before.isDeveloper === true && row.before.allowAnkiUploads === false && row.after.allowAnkiUploads === true));
      assert.ok(details.some(row => row.before.isDeveloper === true && row.before.allowAnkiUploads === true && row.after.isDeveloper === false && row.after.allowAnkiUploads === false));
    });

    await t.test('rejects stale role or upload snapshots without state changes or audit entries', async () => {
      const count = await auditCount();
      const before = await db.prepare("SELECT * FROM community_users WHERE id='target'").first();
      for (const expected of [{ expectedIsDeveloper: true }, { expectedAllowAnkiUploads: true }]) assert.equal((await call('developers/update', 'POST', update(expected))).status, 409);
      assert.deepEqual(await db.prepare("SELECT * FROM community_users WHERE id='target'").first(), before);
      assert.equal(await auditCount(), count);
    });

    await t.test('granting a role retains moderation restrictions and public visibility rules', async () => {
      const before = await db.prepare("SELECT * FROM community_account_restrictions WHERE account_id='restricted'").first();
      assert.equal((await call('developers/update', 'POST', update({ id: 'restricted' }))).status, 200);
      assert.deepEqual(await db.prepare("SELECT * FROM community_account_restrictions WHERE account_id='restricted'").first(), before);
      assert.equal((await mf.dispatchFetch(`https://api.example.test/v1/community/profiles/${restricted.public_id}`)).status, 404);
    });

    await t.test('only one competing update succeeds and the sole audit matches its committed flags', async () => {
      const count = await auditCount();
      const results = await Promise.all([false, true].map(allowAnkiUploads => call('developers/update', 'POST', update({ id: 'race', allowAnkiUploads }))));
      assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
      const row = await db.prepare("SELECT is_developer,developer_anki_uploads FROM community_users WHERE id='race'").first();
      const winner = await results.find(response => response.status === 200).json();
      assert.equal(winner.user.isDeveloper, true);
      assert.equal(winner.user.allowAnkiUploads, Boolean(row.developer_anki_uploads));
      assert.equal(row.is_developer, 1);
      assert.equal(await auditCount(), count + 1);
      const entries = (await db.prepare("SELECT details FROM community_admin_audit WHERE target='race'").all()).results;
      assert.equal(entries.length, 1);
      assert.deepEqual(JSON.parse(entries[0].details), { before: { isDeveloper: false, allowAnkiUploads: false }, after: { isDeveloper: true, allowAnkiUploads: winner.user.allowAnkiUploads } });
    });
  } finally { await mf.dispose(); }
});
