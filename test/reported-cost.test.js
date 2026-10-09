import test from 'node:test';
import assert from 'node:assert/strict';
import { callStructuredOutput, resolveProvider } from '../src/lib/ai.js';

test('missing reported cost falls through, but numeric zero remains valid', async () => {
  const original = globalThis.fetch;
  try {
    for (const [cost, fallback, expected] of [[null, undefined, null], ['', undefined, null], ['  ', 0.02, 0.02], [false, 0.02, 0.02], [0, 0.02, 0], ['0.03', undefined, 0.03]]) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 10, cost, cost_details: { upstream_inference_cost: fallback } }
      }));
      const result = await callStructuredOutput({ provider: resolveProvider({ CHEAPER_INFERENCE_API_KEY: 'test' }),
        instructions: 'test', input: [{ role: 'user', content: 'test' }], schemaName: 'test',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } });
      assert.equal(result.usage.reportedCostUsd, expected);
    }
  } finally { globalThis.fetch = original; }
});
