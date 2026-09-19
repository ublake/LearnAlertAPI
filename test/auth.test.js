import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

const OPEN = { CHEAPER_INFERENCE_API_KEY: "ci", OPENAI_API_KEY: "sk" };
const LOCKED = { ...OPEN, API_KEYS: "live_abc123" };

function generate(headers = {}) {
  return new Request("https://api.example/v1/decks/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ text: "la mesa = table" })
  });
}

function stubUpstream() {
  let called = false;

  globalThis.fetch = async () => {
    called = true;
    return new Response(
      JSON.stringify({
        id: "r",
        model: "m",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                action: "chat",
                assistantMessage: "hi",
                deck: null
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  return () => called;
}

test("no key configured leaves the endpoint open, so deploying cannot break a live app", async () => {
  const originalFetch = globalThis.fetch;
  stubUpstream();

  try {
    const response = await worker.fetch(generate(), OPEN);
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("once a key is configured, an unauthenticated request is rejected free", async () => {
  const originalFetch = globalThis.fetch;
  const wasCalled = stubUpstream();

  try {
    const response = await worker.fetch(generate(), LOCKED);
    const body = await response.json();

    assert.equal(response.status, 401);
    assert.equal(body.error.code, "UNAUTHORIZED");
    // The whole point: rejection must cost nothing upstream.
    assert.equal(wasCalled(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a valid key is accepted via either header form", async () => {
  const originalFetch = globalThis.fetch;
  stubUpstream();

  try {
    const viaHeader = await worker.fetch(
      generate({ "X-API-Key": "live_abc123" }),
      LOCKED
    );
    assert.equal(viaHeader.status, 200);

    const viaBearer = await worker.fetch(
      generate({ Authorization: "Bearer live_abc123" }),
      LOCKED
    );
    assert.equal(viaBearer.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a wrong key is rejected", async () => {
  const originalFetch = globalThis.fetch;
  stubUpstream();

  try {
    const response = await worker.fetch(
      generate({ "X-API-Key": "live_wrong" }),
      LOCKED
    );
    assert.equal(response.status, 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("multiple keys are accepted so a key can be rotated without downtime", async () => {
  const originalFetch = globalThis.fetch;
  stubUpstream();
  const env = { ...OPEN, API_KEYS: "live_old , live_new" };

  try {
    for (const key of ["live_old", "live_new"]) {
      const response = await worker.fetch(generate({ "X-API-Key": key }), env);
      assert.equal(response.status, 200, key);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the health check stays open and reports whether auth is on", async () => {
  const locked = await worker.fetch(
    new Request("https://api.example/"),
    LOCKED
  );
  const lockedBody = await locked.json();

  assert.equal(locked.status, 200);
  assert.equal(lockedBody.auth.required, true);

  const open = await worker.fetch(new Request("https://api.example/"), OPEN);
  // Visible rather than assumed: this is how you catch "I thought it was on".
  assert.equal((await open.json()).auth.required, false);
});

test("the legacy quiz endpoint is protected too", async () => {
  const originalFetch = globalThis.fetch;
  const wasCalled = stubUpstream();

  try {
    const response = await worker.fetch(
      new Request("https://api.example/generate-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi", questionCount: 5 })
      }),
      LOCKED
    );

    assert.equal(response.status, 401);
    assert.equal(wasCalled(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
