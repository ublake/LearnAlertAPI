import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sha256 } from '../src/lib/communityAuth.js';

async function setup({legacy = false} = {}) {
  const bundle = await build({ entryPoints: ['src/index.js'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-04', d1Databases: ['COMMUNITY_DB'], r2Buckets: ['DECK_ASSETS'] }));
  const db = await mf.getD1Database('COMMUNITY_DB');
  for (const file of (await readdir(new URL('../community-migrations/', import.meta.url))).sort()) {
    if (legacy && file.startsWith('0012_')) await db.prepare("INSERT INTO community_users(id,handle,created_at,profile_completed) VALUES('legacy','@legacy',42,1),('legacy_incomplete','@legacy_incomplete',43,0)").run();
    const sql = await readFile(new URL(`../community-migrations/${file}`, import.meta.url), 'utf8');
    const triggers = sql.match(/CREATE TRIGGER[\s\S]*?END;/g) ?? [];
    for (const statement of sql.replace(/CREATE TRIGGER[\s\S]*?END;/g, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
    for (const trigger of triggers) await db.prepare(trigger).run();
  }
  const request = (path, method = 'GET', body, token) => mf.dispatchFetch(`https://community.test/v1/community/${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  async function user(name, complete = true) {
    const id = `private-apple-${name}`, token = crypto.randomUUID().replaceAll('-', '') + 'f'.repeat(32);
    await db.prepare('INSERT INTO community_users(id,handle,created_at,profile_completed) VALUES(?,?,?,?)').bind(id, `@${name}`, 100, complete ? 1 : 0).run();
    await db.prepare('INSERT INTO community_sessions VALUES(?,?,?)').bind(await sha256(token), id, Math.floor(Date.now() / 1000) + 3600).run();
    return { id, token, authorID: (await db.prepare('SELECT public_id FROM community_users WHERE id=?').bind(id).first()).public_id };
  }
  async function deck(owner, name, { status = 'published', review = 'approved', hidden = 0, downloads = 0, published = 1 } = {}) {
    const id = crypto.randomUUID();
    await db.prepare(`INSERT INTO community_decks(id,owner_id,name,category_tag,color_hex,deck_type,status,review_status,admin_hidden,download_count,published_at,created_at,updated_at,cards_json,card_count)
      VALUES(?,?,?,'General','#123456','Mixed',?,?,?,?,?,1,1,'[]',0)`).bind(id, owner.id, name, status, review, hidden, downloads, published).run();
    return id;
  }
  return { mf, db, request, user, deck };
}

test('creator profiles paginate only public decks, distinguish creation counts, and enforce server-side stats privacy', async () => {
  const { mf, db, request, user, deck } = await setup({legacy:true});
  try {
    const legacyID=(await db.prepare("SELECT public_id FROM community_users WHERE id='legacy'").first()).public_id;
    assert.equal((await (await request(`profiles/${legacyID}`)).json()).profile.profileCreatedAt,42);
    assert.equal((await db.prepare("SELECT profile_created_at FROM community_users WHERE id='legacy_incomplete'").first()).profile_created_at,null);
    const legacyToken='c'.repeat(64);
    await db.prepare('INSERT INTO community_sessions VALUES(?,?,?)').bind(await sha256(legacyToken),'legacy_incomplete',Math.floor(Date.now()/1000)+600).run();
    const completionTime=Math.floor(Date.now()/1000);
    const completedLegacy=await request('account','PUT',{username:'legacy_incomplete',avatar:{hair:0,eyes:0,mouth:0}},legacyToken);
    assert.equal(completedLegacy.status,200);
    assert.ok((await completedLegacy.json()).profileCreatedAt>=completionTime);
    const owner = await user('creator', false), visitor = await user('visitor');
    const before = Math.floor(Date.now() / 1000);
    const saved = await request('account', 'PUT', { username: 'creator', avatar: { hair: 2, eyes: 3, mouth: 4, skinTone: 5 } }, owner.token);
    assert.equal(saved.status, 200);
    const account = await saved.json();
    assert.ok(account.profileCreatedAt >= before);
    assert.equal(account.hideStatsPublicly, false);
    for (let i = 1; i <= 21; i++) await deck(owner, `Public ${i}`, { downloads: i, published: i });
    await deck(owner, 'SECRET pending', { status: 'draft', review: 'pending' });
    await deck(owner, 'SECRET rejected', { status: 'draft', review: 'rejected' });
    await deck(owner, 'SECRET draft', { status: 'draft', review: null });
    await deck(owner, 'SECRET hidden', { hidden: 1, downloads: 999 });
    await deck(owner, 'SECRET removed', { status: 'deleted', downloads: 999 });
    const firstResponse = await request(`profiles/${owner.authorID}?limit=20`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json();
    assert.equal(first.decks.length, 20); assert.equal(first.nextOffset, 20); assert.equal(first.totalCount, 21);
    assert.equal(first.profile.profileCreatedAt, account.profileCreatedAt);
    assert.deepEqual(first.profile.stats, { profileCreatedAt: account.profileCreatedAt, createdDeckCount: 25, publishedDeckCount: 21, downloadCount: 231, receivedLikeCount: 0, hasReceivedLikes: false });
    assert.equal(first.profile.avatar.skinTone, 5);
    assert.ok(!JSON.stringify(first).includes('SECRET'));
    assert.ok(!JSON.stringify(first).includes(owner.id));
    const second = await (await request(`profiles/${owner.authorID}?limit=20&offset=${first.nextOffset}`)).json();
    assert.equal(second.decks.length, 1); assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first.decks, ...second.decks].map(d => d.id)).size, 21);
    assert.equal((await request('account', 'PUT', { hideStatsPublicly: true }, owner.token)).status, 200);
    for (const token of [undefined, visitor.token]) {
      const hidden = await (await request(`profiles/${owner.authorID}`, 'GET', undefined, token)).json();
      assert.equal(hidden.profile.stats, null); assert.equal(hidden.profile.hideStatsPublicly, true);
      assert.equal(hidden.profile.profileCreatedAt, account.profileCreatedAt);
      assert.equal(hidden.decks.length, 20);
    }
    assert.equal((await (await request(`profiles/${owner.authorID}`, 'GET', undefined, owner.token)).json()).profile.stats.createdDeckCount, 25);
    assert.equal((await (await request('account', 'GET', undefined, owner.token)).json()).stats.createdDeckCount, 25);
    assert.equal((await request('account', 'PUT', { username: 'creator', avatar: { hair: 5, eyes: 0, mouth: 1 } }, owner.token)).status, 200);
    const updated = await (await request('account', 'GET', undefined, owner.token)).json();
    assert.equal(updated.profileCreatedAt, account.profileCreatedAt); assert.equal(updated.hideStatsPublicly, true);
    for (const value of [null, 1, 'true', {}]) assert.equal((await request('account', 'PUT', { hideStatsPublicly: value }, owner.token)).status, 400);
    assert.equal((await request('account', 'PUT', { username: 'renamed', avatar: { hair: 0, eyes: 0, mouth: 0 } }, owner.token)).status, 409);
    assert.equal((await request(`profiles/${owner.authorID}`, 'GET', undefined, '0'.repeat(64))).status, 401);
    assert.equal((await request(`profiles/${'0'.repeat(32)}`)).status, 404);
    // Completing a profile never changes a legacy account's migrated date.
    await db.prepare('UPDATE community_users SET profile_created_at=50 WHERE id=?').bind(owner.id).run();
    await request('account', 'PUT', { username: 'creator', avatar: { hair: 1, eyes: 1, mouth: 1 } }, owner.token);
    assert.equal((await (await request('account', 'GET', undefined, owner.token)).json()).profileCreatedAt, 50);
  } finally { await mf.dispose(); }
});

test('hearts are authenticated, idempotent under concurrency, owner-only in analytics, and permanently unlock appreciation', async () => {
  const { mf, db, request, user, deck } = await setup();
  try {
    const owner = await user('creator'), one = await user('one'), two = await user('two'), other = await user('other'), unfinished=await user('unfinished',false);
    const first = await deck(owner, 'First'), second = await deck(owner, 'Second');
    assert.equal((await request(`decks/${first}/like`, 'PUT')).status, 401);
    assert.equal((await request(`decks/${first}/like`, 'PUT', undefined, owner.token)).status, 400);
    const incomplete=await request(`decks/${first}/like`,'PUT',undefined,unfinished.token);
    assert.equal(incomplete.status,409); assert.equal((await incomplete.json()).error.code,'PROFILE_INCOMPLETE');
    await assert.rejects(db.prepare('INSERT INTO community_likes VALUES(?,?,?)').bind(first,unfinished.id,10).run(),/community_like_unavailable/);
    assert.equal((await request('account/likes')).status, 401);
    assert.equal((await (await request('account', 'GET', undefined, owner.token)).json()).stats.hasReceivedLikes, false);
    const responses = await Promise.all(Array.from({ length: 8 }, () => request(`decks/${first}/like`, 'PUT', undefined, one.token)));
    for (const response of responses) { assert.equal(response.status, 200); assert.deepEqual(await response.json(), { success: true, likeCount: 1, viewerHasLiked: true }); }
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM community_likes').first()).n, 1);
    const firstReceived = (await db.prepare('SELECT first_like_received_at FROM community_users WHERE id=?').bind(owner.id).first()).first_like_received_at;
    assert.ok(firstReceived > 0);
    await db.prepare('UPDATE community_likes SET created_at=100 WHERE deck_id=? AND user_id=?').bind(first,one.id).run();
    await request(`decks/${first}/like`, 'PUT', undefined, one.token);
    assert.equal((await db.prepare('SELECT created_at FROM community_likes WHERE deck_id=? AND user_id=?').bind(first,one.id).first()).created_at, 100);
    await request(`decks/${first}/like`, 'PUT', undefined, two.token);
    await request(`decks/${second}/like`, 'PUT', undefined, one.token);
    const feed = await (await request('decks?limit=20', 'GET', undefined, one.token)).json();
    assert.equal(feed.decks.find(d => d.id === first).likeCount, 2);
    assert.ok(feed.decks.every(d => d.viewerHasLiked));
    for (const path of [`decks/${first}`, `decks/${first}/preview`, `profiles/${owner.authorID}`]) {
      const response = await (await request(path, 'GET', undefined, one.token)).json();
      const target = response.deck ?? response.decks.find(d => d.id === first);
      assert.equal(target.likeCount, 2); assert.equal(target.viewerHasLiked, true);
    }
    const anonymous = await (await request(`decks/${first}/preview`)).json();
    assert.equal(anonymous.deck.viewerHasLiked, false);
    const pages = [];
    let offset = 0;
    do {
      const page = await (await request(`account/likes?limit=1&offset=${offset}`, 'GET', undefined, owner.token)).json();
      assert.equal(page.totalCount, 3); pages.push(...page.likes); offset = page.nextOffset;
      assert.deepEqual(page.deckCounts.map(d => d.likeCount).sort(), [1,2]);
    } while (offset !== null);
    assert.equal(new Set(pages.map(l => `${l.authorID}:${l.deckID}`)).size, 3);
    assert.ok(pages.every(l => l.avatar && l.handle && Number.isInteger(l.createdAt)));
    assert.ok(!JSON.stringify(pages).includes('private-apple-'));
    assert.equal((await (await request(`account/likes?authorID=${owner.authorID}`, 'GET', undefined, other.token)).json()).totalCount, 0);
    for (let i = 0; i < 2; i++) assert.deepEqual(await (await request(`decks/${first}/like`, 'DELETE', undefined, two.token)).json(), {success:true,likeCount:1,viewerHasLiked:false});
    assert.equal((await (await request(`decks/${first}/like`, 'DELETE', undefined, other.token)).json()).likeCount, 1);
    await request(`decks/${first}/like`, 'DELETE', undefined, one.token);
    await request(`decks/${second}/like`, 'DELETE', undefined, one.token);
    const stats = (await (await request('account', 'GET', undefined, owner.token)).json()).stats;
    assert.equal(stats.receivedLikeCount, 0); assert.equal(stats.hasReceivedLikes, true);
    assert.equal((await db.prepare('SELECT first_like_received_at FROM community_users WHERE id=?').bind(owner.id).first()).first_like_received_at, firstReceived);
  } finally { await mf.dispose(); }
});

test('blocks, moderation, restrictions, and deletion hide both heart identities and aggregate counts consistently', async () => {
  const { mf, db, request, user, deck } = await setup();
  try {
    const owner = await user('creator'), one = await user('one'), two = await user('two');
    const good = await deck(owner, 'Visible');
    const invalid = [await deck(owner, 'Pending', {status:'draft',review:'pending'}),await deck(owner, 'Rejected', {status:'draft',review:'rejected'}),await deck(owner,'Hidden',{hidden:1}),await deck(owner,'Removed',{status:'deleted'})];
    for (const id of invalid) {
      assert.equal((await request(`decks/${id}/like`, 'PUT', undefined, one.token)).status, 404);
      await assert.rejects(db.prepare('INSERT INTO community_likes VALUES(?,?,?)').bind(id,one.id,10).run(), /community_like_unavailable/);
    }
    assert.equal((await (await request('account', 'GET', undefined, owner.token)).json()).stats.hasReceivedLikes, false);
    for (const actor of [one,two]) assert.equal((await request(`decks/${good}/like`, 'PUT', undefined, actor.token)).status, 200);
    async function counts(expected) {
      assert.equal((await (await request(`decks/${good}/preview`)).json()).deck.likeCount, expected);
      const ledger = await (await request('account/likes', 'GET', undefined, owner.token)).json();
      assert.equal(ledger.totalCount,expected); assert.equal(ledger.likes.length,expected);
      assert.equal((await (await request('account', 'GET', undefined, owner.token)).json()).stats.receivedLikeCount,expected);
    }
    await counts(2);
    await request('account/blocks','POST',{authorID:one.authorID},owner.token);
    await counts(1);
    for (const path of [`profiles/${owner.authorID}`,`decks/${good}/preview`]) assert.equal((await request(path,'GET',undefined,one.token)).status,403);
    assert.equal((await request(`profiles/${one.authorID}`,'GET',undefined,owner.token)).status,403);
    assert.equal((await (await request('decks','GET',undefined,one.token)).json()).decks.length,0);
    assert.equal((await request(`decks/${good}/like`,'PUT',undefined,one.token)).status,403);
    await request(`account/blocks/${one.authorID}`,'DELETE',undefined,owner.token);
    await counts(2);
    await db.prepare("INSERT INTO community_account_restrictions(account_id,author_id,handle,status,until_at,updated_at,actor) VALUES(?,?,?,'suspended',unixepoch()+600,1,'test')").bind(two.id,two.authorID,'@two').run();
    await counts(1);
    assert.equal((await request(`decks/${good}/like`,'PUT',undefined,two.token)).status,403);
    assert.equal((await request(`profiles/${two.authorID}`)).status,404);
    await db.prepare("UPDATE community_account_restrictions SET status='active' WHERE account_id=?").bind(two.id).run();
    await counts(2);
    await db.prepare("INSERT INTO community_account_restrictions(account_id,author_id,handle,status,updated_at,actor) VALUES(?,?,?,'banned',1,'test')").bind(owner.id,owner.authorID,'@creator').run();
    assert.equal((await request(`profiles/${owner.authorID}`)).status,404);
    assert.equal((await request(`decks/${good}/like`,'PUT',undefined,one.token)).status,404);
    assert.equal((await (await request('account/likes','GET',undefined,owner.token)).json()).totalCount,0);
    const restrictedAccount=await (await request('account','GET',undefined,owner.token)).json();
    assert.equal(restrictedAccount.accountStatus,'banned'); assert.equal(restrictedAccount.stats.receivedLikeCount,0);
    await db.prepare("UPDATE community_account_restrictions SET status='active' WHERE account_id=?").bind(owner.id).run();
    await counts(2);
    for (const patch of ["admin_hidden=1", "admin_hidden=0,status='draft',review_status='pending'", "status='deleted'"]) {
      await db.prepare(`UPDATE community_decks SET ${patch} WHERE id=?`).bind(good).run();
      assert.equal((await request(`decks/${good}/like`,'PUT',undefined,one.token)).status,404);
      assert.equal((await (await request('account/likes','GET',undefined,owner.token)).json()).totalCount,0);
      assert.equal((await (await request('account','GET',undefined,owner.token)).json()).stats.receivedLikeCount,0);
    }
    await db.prepare("UPDATE community_decks SET status='published',review_status='approved',admin_hidden=0 WHERE id=?").bind(good).run();
    await counts(2);
    assert.equal((await request('account','DELETE',undefined,two.token)).status,200);
    await counts(1);
    assert.equal((await request(`profiles/${two.authorID}`)).status,404);
    await db.prepare('DELETE FROM community_decks WHERE id=?').bind(good).run();
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM community_likes').first()).n,0);
    assert.equal((await (await request('account','GET',undefined,owner.token)).json()).stats.hasReceivedLikes,true);
    assert.equal((await request('account','DELETE',undefined,owner.token)).status,200);
    assert.equal((await request(`profiles/${owner.authorID}`)).status,404);
  } finally { await mf.dispose(); }
});
