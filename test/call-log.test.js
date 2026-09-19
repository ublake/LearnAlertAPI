import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { relativeTime, formatDuration } from "../src/lib/callLog.js";
import { estimateCostUsd, pricing } from "../src/config.js";

/**
 * A D1 stand-in that understands only the handful of statements callLog
 * issues. It stores rows in a Map so ordering and updates are observable.
 */
function fakeD1() {
  const rows = new Map();

  return {
    rows,
    prepare(sql) {
      let bound = [];

      const statement = {
        bind(...args) {
          bound = args;
          return statement;
        },
        async run() {
          if (sql.includes("INSERT INTO call_log")) {
            const [request_id, started_at, status, method, endpoint] = bound;

            if (!rows.has(request_id)) {
              rows.set(request_id, {
                request_id,
                started_at,
                status,
                method,
                endpoint,
                finished_at: null,
                provider: null,
                model: null,
                source_type: null,
                tokens_in: null,
                tokens_cached: null,
                tokens_out: null,
                cost_usd: null,
                cost_source: null,
                http_status: null,
                error_code: null
              });
            }

            return { success: true };
          }

          if (sql.includes("UPDATE call_log")) {
            const [
              finished_at,
              status,
              provider,
              model,
              source_type,
              tokens_in,
              tokens_cached,
              tokens_out,
              cost_usd,
              cost_source,
              http_status,
              error_code,
              request_id
            ] = bound;

            const row = rows.get(request_id);

            if (row) {
              Object.assign(row, {
                finished_at,
                status,
                provider,
                model,
                source_type,
                tokens_in,
                tokens_cached,
                tokens_out,
                cost_usd,
                cost_source,
                http_status,
                error_code
              });
            }

            return { success: true };
          }

          if (sql.includes("DELETE FROM call_log")) {
            return { success: true };
          }

          throw new Error(`unexpected SQL: ${sql}`);
        },
        async all() {
          const sorted = [...rows.values()].sort(
            (a, b) => b.started_at - a.started_at
          );

          return { results: sorted.slice(0, bound[0] ?? 100) };
        },
        async first() {
          const all = [...rows.values()];

          return {
            calls: all.length,
            succeeded: all.filter((r) => r.status === "success").length,
            failed: all.filter((r) => r.status === "failed").length,
            inFlight: all.filter((r) => r.status === "in_progress").length,
            tokensIn: all.reduce((sum, r) => sum + (r.tokens_in || 0), 0),
            tokensCached: all.reduce(
              (sum, r) => sum + (r.tokens_cached || 0),
              0
            ),
            tokensOut: all.reduce((sum, r) => sum + (r.tokens_out || 0), 0),
            costUsd: all.reduce((sum, r) => sum + (r.cost_usd || 0), 0),
            estimated: all.filter((r) => r.cost_source === "estimated").length
          };
        }
      };

      return statement;
    }
  };
}

function ctxWithWaits() {
  const pending = [];

  return {
    ctx: { waitUntil: (promise) => pending.push(promise) },
    settle: () => Promise.all(pending)
  };
}

const DECK_REPLY = {
  action: "deck",
  assistantMessage: "Made a deck.",
  deck: {
    title: "Spanish",
    subject: "Spanish",
    deckKind: "language_learning",
    detectedLanguage: "es",
    summary: "Basics",
    cards: [
      {
        id: "card-1",
        type: "tap_reveal",
        prompt: "la mesa",
        answer: "the table",
        hint: "",
        options: [],
        correctAnswerIndex: -1,
        matchingPairs: [],
        tags: [],
        sourceLocator: ""
      }
    ]
  }
};

function stubAI({ usage, fail = false } = {}) {
  globalThis.fetch = async () => {
    if (fail) {
      return new Response(JSON.stringify({ error: { message: "nope" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(
      JSON.stringify({
        id: "resp-1",
        model: "gpt-5.6-luna",
        usage: {
          prompt_tokens: 12_000,
          completion_tokens: 900,
          prompt_tokens_details: { cached_tokens: 10_000 },
          ...usage
        },
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(DECK_REPLY) }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
}

function envWith(db, extra = {}) {
  return {
    LOGS_DB: db,
    CHEAPER_INFERENCE_API_KEY: "sk-cheap",
    OPENAI_API_KEY: "sk-test",
    ...extra
  };
}

function generateRequest() {
  return new Request("https://api.example/v1/decks/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "la mesa - the table", maxCards: 5 })
  });
}

test("a successful call is logged with usage, provider, and source type", async () => {
  const originalFetch = globalThis.fetch;
  const db = fakeD1();
  const { ctx, settle } = ctxWithWaits();

  stubAI();

  try {
    const response = await worker.fetch(generateRequest(), envWith(db), ctx);
    await settle();

    assert.equal(response.status, 200);

    const [row] = [...db.rows.values()];

    assert.equal(row.status, "success");
    assert.equal(row.endpoint, "/v1/decks/generate");
    assert.equal(row.provider, "cheaper_inference");
    assert.equal(row.model, "gpt-5.6-luna");
    assert.equal(row.source_type, "text");
    assert.equal(row.tokens_in, 12_000);
    assert.equal(row.tokens_cached, 10_000);
    assert.equal(row.tokens_out, 900);
    assert.equal(row.http_status, 200);
    assert.equal(row.error_code, null);
    assert.ok(row.finished_at >= row.started_at);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the row opens as in-progress before the upstream call returns", async () => {
  const originalFetch = globalThis.fetch;
  const db = fakeD1();
  const { ctx, settle } = ctxWithWaits();

  let seenDuringCall = null;

  globalThis.fetch = async () => {
    // The request is mid-flight here, which is exactly when /logs should
    // already show it.
    seenDuringCall = [...db.rows.values()][0]?.status;

    return new Response(
      JSON.stringify({
        id: "resp-1",
        model: "gpt-5.6-luna",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(DECK_REPLY) }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    await worker.fetch(generateRequest(), envWith(db), ctx);
    await settle();

    assert.equal(seenDuringCall, "in_progress");
    assert.equal([...db.rows.values()][0].status, "success");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a failed call is logged with its error code", async () => {
  const originalFetch = globalThis.fetch;
  const db = fakeD1();
  const { ctx, settle } = ctxWithWaits();

  stubAI({ fail: true });

  try {
    const response = await worker.fetch(generateRequest(), envWith(db), ctx);
    await settle();

    assert.ok(response.status >= 400);

    const [row] = [...db.rows.values()];

    assert.equal(row.status, "failed");
    assert.equal(row.error_code, "AI_REQUEST_FAILED");
    assert.equal(row.http_status, response.status);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cost is null without rates and computed with them", async () => {
  const originalFetch = globalThis.fetch;
  const { ctx, settle } = ctxWithWaits();

  stubAI();

  try {
    const unpriced = fakeD1();
    await worker.fetch(generateRequest(), envWith(unpriced), ctx);
    await settle();

    assert.equal([...unpriced.rows.values()][0].cost_usd, null);

    const priced = fakeD1();
    const { ctx: ctx2, settle: settle2 } = ctxWithWaits();

    await worker.fetch(
      generateRequest(),
      envWith(priced, {
        PRICE_INPUT_PER_MTOK: "1.25",
        PRICE_CACHED_INPUT_PER_MTOK: "0.125",
        PRICE_OUTPUT_PER_MTOK: "10"
      }),
      ctx2
    );
    await settle2();

    // 2k fresh @1.25 + 10k cached @0.125 + 900 out @10 per million.
    assert.equal([...priced.rows.values()][0].cost_usd, 0.012750);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GET /logs renders the page and serves JSON", async () => {
  const originalFetch = globalThis.fetch;
  const db = fakeD1();
  const { ctx, settle } = ctxWithWaits();
  const env = envWith(db, { DEBUG_TOKEN: "secret" });

  stubAI();

  try {
    await worker.fetch(generateRequest(), env, ctx);
    await settle();

    const page = await worker.fetch(
      new Request("https://api.example/logs?token=secret"),
      env,
      ctx
    );
    const html = await page.text();

    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /text\/html/);
    assert.match(html, /\/v1\/decks\/generate/);
    assert.match(html, /success/);
    // Large token counts are abbreviated in the table.
    assert.match(html, /12k/);
    // Charts, filter row, and the filtered totals block are all present.
    assert.match(html, /<svg /);
    assert.match(html, /Totals &mdash; |Totals — /);
    assert.match(html, /range=1h/);
    // No rates configured, so costs must not show an invented number.
    assert.match(html, /n\/a/);

    const asJson = await worker.fetch(
      new Request("https://api.example/logs?format=json&token=secret"),
      env,
      ctx
    );
    const body = await asJson.json();

    assert.equal(body.ok, true);
    // The stub provider reports no cost and has no rate card, so nothing is
    // priced — and the page must say so rather than invent a number.
    assert.equal(body.calls[0].costUsd, null);
    assert.equal(body.calls[0].costSource, null);
    assert.equal(body.rateCard.longContextThreshold, 272_000);
    assert.equal(body.totals.calls, 1);
    assert.equal(body.calls[0].endpoint, "/v1/decks/generate");
    assert.equal(body.calls[0].tokensIn, 12_000);
    assert.match(body.calls[0].age, /ago|just now/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("/logs fails closed: no token configured, no page", async () => {
  const db = fakeD1();

  // An unset DEBUG_TOKEN must mean nobody, not everybody.
  const unconfigured = await worker.fetch(
    new Request("https://api.example/logs"),
    envWith(db),
    { waitUntil: () => {} }
  );

  assert.equal(unconfigured.status, 404);

  const denied = await worker.fetch(
    new Request("https://api.example/logs"),
    envWith(db, { DEBUG_TOKEN: "secret" }),
    { waitUntil: () => {} }
  );

  assert.equal(denied.status, 404);

  const allowed = await worker.fetch(
    new Request("https://api.example/logs?token=secret"),
    envWith(db, { DEBUG_TOKEN: "secret" }),
    { waitUntil: () => {} }
  );

  assert.equal(allowed.status, 200);
});

test("without a D1 binding the API still works and /logs says so", async () => {
  const originalFetch = globalThis.fetch;

  stubAI();

  try {
    const response = await worker.fetch(
      generateRequest(),
      { CHEAPER_INFERENCE_API_KEY: "sk-cheap" },
      { waitUntil: () => {} }
    );

    assert.equal(response.status, 200);

    const logs = await worker.fetch(
      new Request("https://api.example/logs?token=secret"),
      { CHEAPER_INFERENCE_API_KEY: "sk-cheap", DEBUG_TOKEN: "secret" },
      { waitUntil: () => {} }
    );

    assert.equal(logs.status, 503);
    assert.match((await logs.json()).hint, /LOGS_DB/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("relative time and duration read the way a log should", () => {
  const now = Date.parse("2026-09-19T12:00:00Z");

  assert.equal(relativeTime(now - 2_000, now), "just now");
  assert.equal(relativeTime(now - 30_000, now), "30s ago");
  assert.equal(relativeTime(now - 60_000, now), "1m ago");
  assert.equal(relativeTime(now - 3_600_000, now), "1h ago");
  assert.equal(relativeTime(now - 86_400_000, now), "1d ago");

  assert.equal(formatDuration(450), "450ms");
  assert.equal(formatDuration(31_400), "31.4s");
  assert.equal(formatDuration(null), "—");
});

test("blank price vars read as unset, not as a rate of zero", () => {
  // A provider with no rate card and no reported cost cannot be priced.
  const none = pricing({}, "cheaper_inference");

  assert.equal(none.shortContext.input, null);
  assert.deepEqual(
    estimateCostUsd(
      { prompt_tokens: 1_000_000, cachedTokens: 0, completion_tokens: 1000 },
      none
    ),
    { usd: null, source: null }
  );

  // "" must not read as 0: Number("") is 0, not NaN.
  assert.equal(
    pricing({ PRICE_INPUT_PER_MTOK: "  " }, "cheaper_inference").shortContext
      .input,
    null
  );

  // A deliberate zero is still a real rate.
  assert.equal(
    pricing({ PRICE_INPUT_PER_MTOK: "0" }, "cheaper_inference").shortContext
      .input,
    0
  );
});

test("a provider-reported cost beats the rate card", () => {
  const prices = pricing({}, "cheaper_inference");

  // CheaperInference reports real cost, so nothing is estimated.
  assert.deepEqual(
    estimateCostUsd(
      { prompt_tokens: 50_000, completion_tokens: 900, reportedCostUsd: 0.0042 },
      prices
    ),
    { usd: 0.0042, source: "reported" }
  );

  // Even where a card exists, the reported figure wins.
  assert.deepEqual(
    estimateCostUsd(
      { prompt_tokens: 50_000, completion_tokens: 900, reportedCostUsd: 0.5 },
      pricing({}, "openai")
    ),
    { usd: 0.5, source: "reported" }
  );
});

test("the long-context tier applies above the threshold", () => {
  const prices = pricing({}, "openai");

  // 100k prompt: short tier. 100k @ $0.20 + 5k @ $1.20 per million.
  assert.deepEqual(
    estimateCostUsd(
      { prompt_tokens: 100_000, cachedTokens: 0, completion_tokens: 5_000 },
      prices
    ),
    { usd: 0.026, source: "estimated" }
  );

  // 300k prompt: long tier, double the rate.
  assert.deepEqual(
    estimateCostUsd(
      { prompt_tokens: 300_000, cachedTokens: 0, completion_tokens: 5_000 },
      prices
    ),
    { usd: 0.129, source: "estimated" }
  );

  // The threshold is tunable without a code change.
  assert.equal(
    estimateCostUsd(
      { prompt_tokens: 100_000, cachedTokens: 0, completion_tokens: 5_000 },
      pricing({ PRICE_LONG_CONTEXT_THRESHOLD: "50000" }, "openai")
    ).usd,
    0.049
  );
});

test("cached tokens are billed at the cached rate, not twice", () => {
  const prices = pricing(
    {
      PRICE_INPUT_PER_MTOK: "10",
      PRICE_CACHED_INPUT_PER_MTOK: "1",
      PRICE_OUTPUT_PER_MTOK: "30",
      PRICE_LONG_CONTEXT_THRESHOLD: "99999999"
    },
    "cheaper_inference"
  );

  // 1M prompt tokens, all cached, no output: the cached rate alone.
  assert.equal(
    estimateCostUsd(
      { prompt_tokens: 1_000_000, cachedTokens: 1_000_000, completion_tokens: 0 },
      prices
    ).usd,
    1
  );

  // Nothing cached: the full input rate.
  assert.equal(
    estimateCostUsd(
      { prompt_tokens: 1_000_000, cachedTokens: 0, completion_tokens: 0 },
      prices
    ).usd,
    10
  );

  // An unset cached rate overstates rather than understates.
  assert.equal(
    estimateCostUsd(
      { prompt_tokens: 1_000_000, cachedTokens: 1_000_000, completion_tokens: 0 },
      pricing(
        {
          PRICE_INPUT_PER_MTOK: "10",
          PRICE_OUTPUT_PER_MTOK: "30",
          PRICE_LONG_CONTEXT_THRESHOLD: "99999999"
        },
        "cheaper_inference"
      )
    ).usd,
    10
  );
});
