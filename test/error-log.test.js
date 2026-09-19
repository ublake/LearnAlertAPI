import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { MAX_EXTRACT_BYTES } from "../src/config.js";

const ENABLED = {
  ERROR_LOG_ENABLED: "true",
  CHEAPER_INFERENCE_API_KEY: "ci_live_test",
  OPENAI_API_KEY: "sk-test"
};

function uploadOf(bytes) {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(bytes)], "huge.pdf", { type: "application/pdf" })
  );

  return new Request("https://api.example/v1/decks/generate", {
    method: "POST",
    body: form
  });
}

function oversizedUpload() {
  return uploadOf(MAX_EXTRACT_BYTES + 1);
}

test("a file over the parsing provider's ceiling is rejected free", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;

  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not be reached");
  };

  try {
    const response = await worker.fetch(oversizedUpload(), ENABLED);
    const body = await response.json();

    assert.equal(called, false);
    assert.equal(response.status, 400);
    assert.match(body.error.message, /over the 8\.00 MB limit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a natively parsing provider accepts what the inline path cannot", async () => {
  const originalFetch = globalThis.fetch;
  let url = "";

  globalThis.fetch = async (requestUrl) => {
    url = requestUrl;
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
                assistantMessage: "ok",
                deck: null
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  try {
    // 2 MB: far past the 0.92 MB base64 budget, fine for a real parser.
    const response = await worker.fetch(
      uploadOf(2 * 1024 * 1024),
      ENABLED
    );

    assert.equal(response.status, 200);
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the small ceiling still applies to a provider that cannot parse", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;

  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not be reached");
  };

  try {
    const response = await worker.fetch(uploadOf(2 * 1024 * 1024), {
      ...ENABLED,
      // Force documents onto the gateway, where base64 is billed as text.
      DOCUMENT_PROVIDER: "cheaper_inference"
    });
    const body = await response.json();

    assert.equal(called, false);
    assert.equal(response.status, 400);
    assert.match(body.error.message, /over the 0\.55 MB limit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the errors page lists a recent failure as JSON", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("should not be reached");
  };

  try {
    await worker.fetch(oversizedUpload(), ENABLED);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const response = await worker.fetch(
    new Request("https://api.example/errors?format=json"),
    ENABLED
  );
  const body = await response.json();

  assert.equal(body.ttlSeconds, 300);
  assert.ok(body.count >= 1);

  const entry = body.errors[0];

  assert.equal(entry.code, "VALIDATION_ERROR");
  assert.equal(entry.status, 400);
  assert.equal(entry.path, "/v1/decks/generate");
  assert.ok(entry.expiresInSeconds <= 300);
  assert.ok(entry.details.estimatedTokens > 0);
});

test("the errors page renders HTML by default", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/errors"),
    ENABLED
  );

  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /LearnAlert API errors/);
});

test("the errors page is off unless explicitly enabled", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/errors"),
    { CHEAPER_INFERENCE_API_KEY: "ci_live_test" }
  );

  assert.equal(response.status, 404);
});

test("a debug token, when set, is required", async () => {
  const env = { ...ENABLED, DEBUG_TOKEN: "s3cret" };

  const denied = await worker.fetch(
    new Request("https://api.example/errors"),
    env
  );
  assert.equal(denied.status, 404);

  const allowed = await worker.fetch(
    new Request("https://api.example/errors?token=s3cret"),
    env
  );
  assert.equal(allowed.status, 200);

  const byHeader = await worker.fetch(
    new Request("https://api.example/errors", {
      headers: { "X-Debug-Token": "s3cret" }
    }),
    env
  );
  assert.equal(byHeader.status, 200);
});

test("HTML output escapes error text", async () => {
  const request = new Request("https://api.example/v1/decks/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "hi", sourceName: "<img src=x onerror=1>" })
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("<script>alert(1)</script>");
  };

  try {
    await worker.fetch(request, ENABLED);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const response = await worker.fetch(
    new Request("https://api.example/errors"),
    ENABLED
  );
  const html = await response.text();

  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.match(html, /&lt;script&gt;/);
});

test("unusable model output is a 502, not an INTERNAL_ERROR", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "resp-bad-deck",
        model: "test-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                action: "deck",
                assistantMessage: "Here you go.",
                deck: null
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  try {
    const response = await worker.fetch(
      new Request("https://api.example/v1/decks/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "la mesa = table" })
      }),
      ENABLED
    );
    const body = await response.json();

    assert.equal(response.status, 502);
    assert.equal(body.error.code, "AI_INVALID_OUTPUT");
    // The old behaviour hid this behind "Something went wrong".
    assert.match(body.error.message, /no deck for a deck response/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an over-length field reports what it actually received", async () => {
  const transcript = "A".repeat(8_000);

  const response = await worker.fetch(
    new Request("https://api.example/v1/decks/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deck: { cards: [] },
        instruction: transcript
      })
    }),
    ENABLED
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  // The app gets the numbers, so "too long" is actionable on its own.
  assert.match(body.error.message, /8,000 characters/);
  assert.match(body.error.message, /maximum is 2,000/);

  const log = await (
    await worker.fetch(
      new Request("https://api.example/errors?format=json"),
      ENABLED
    )
  ).json();

  const entry = log.errors[0];

  assert.equal(entry.details.field, "instruction");
  assert.equal(entry.details.received, 8_000);
  assert.equal(entry.details.startsWith.length, 120);
});

test("details reach an authorized caller in the response itself", async () => {
  const env = { ...ENABLED, DEBUG_TOKEN: "s3cret" };

  function refineRequest(headers = {}) {
    return new Request("https://api.example/v1/decks/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        deck: { cards: [] },
        instruction: "B".repeat(2_027)
      })
    });
  }

  // Without the token, details stay server-side.
  const plain = await (await worker.fetch(refineRequest(), env)).json();
  assert.equal(plain.error.details, undefined);
  assert.match(plain.error.message, /2,027 characters/);

  // With it, the app can show them without any isolate involved.
  const debug = await (
    await worker.fetch(refineRequest({ "X-Debug-Token": "s3cret" }), env)
  ).json();

  assert.equal(debug.error.details.field, "instruction");
  assert.equal(debug.error.details.received, 2_027);
  assert.equal(debug.error.details.startsWith.length, 120);
  assert.equal(debug.error.details.endsWith.length, 120);
});

test("a wrong debug token reveals nothing", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/v1/decks/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Token": "wrong" },
      body: JSON.stringify({ deck: { cards: [] }, instruction: "B".repeat(3000) })
    }),
    { ...ENABLED, DEBUG_TOKEN: "s3cret" }
  );
  const body = await response.json();

  assert.equal(body.error.details, undefined);
});
