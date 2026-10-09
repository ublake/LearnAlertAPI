import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { limitAIRequest, pruneAILimits } from '../src/lib/aiLimits.js';
import worker from '../src/index.js';

const request = ip => new Request('https://example.test/v1/decks/generate', {
  method: 'POST', headers: { 'CF-Connecting-IP': ip, 'X-API-Key': 'valid-key' }, body: '{}'
});
test('AI limits fail closed when storage is missing, before any provider call', async () => {
  const response = await worker.fetch(request('1.2.3.4'), { API_KEY: 'valid-key' });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'AI_LIMITS_UNAVAILABLE');
});
test('durable AI reservations enforce per-client and global budgets under concurrent requests', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-09-04', d1Databases: ['LOGS_DB'] }));
  try {
    const db = await mf.getD1Database('LOGS_DB');
    const sql = await readFile(new URL('../migrations/0003_ai_limits.sql', import.meta.url), 'utf8');
    await db.prepare(sql).run();
    const env = { LOGS_DB: db, AI_REQUESTS_PER_IP_HOUR: '2', AI_REQUESTS_PER_IP_DAY: '3', AI_REQUESTS_PER_DAY: '4' };
    const time = Date.UTC(2026, 9, 9, 12);
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => limitAIRequest(request('1.2.3.4'), env, `concurrent-${i}`, time)));
    assert.equal(responses.filter(value => value === null).length, 2);
    for (const response of responses.filter(Boolean)) {
      assert.equal(response.status, 429); assert.equal(response.headers.get('Retry-After'), '3600');
    }
    // Denied client requests must not consume the global allowance.
    assert.equal((await db.prepare("SELECT used FROM ai_request_limits WHERE subject='global'").first()).used, 2);
    assert.equal(await limitAIRequest(request('1.2.3.4'), env, 'next-hour', time + 3600000), null);
    assert.equal((await limitAIRequest(request('1.2.3.4'), env, 'daily', time + 3600000)).status, 429);
    assert.equal(await limitAIRequest(request('5.6.7.8'), env, 'other-client', time), null);
    assert.equal((await limitAIRequest(request('9.10.11.12'), env, 'global-denied', time)).status, 429);
    assert.equal(await limitAIRequest(request('1.2.3.4'), env, 'tomorrow', time + 86400000), null);
    const rows = (await db.prepare('SELECT subject FROM ai_request_limits').all()).results;
    assert.ok(rows.every(row => !row.subject.includes('1.2.3.4')));
    await pruneAILimits(env);
  } finally { await mf.dispose(); }
});
