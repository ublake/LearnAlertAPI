import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { LIMITS } from "../src/config.js";

const ENABLED = {
  ERROR_LOG_ENABLED: "true",
  CHEAPER_INFERENCE_API_KEY: "ci_live_test",
  OPENAI_API_KEY: "sk-test"
};

function oversizedUpload() {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(LIMITS.MAX_UPLOAD_BYTES + 1)], "huge.pdf", {
      type: "application/pdf"
    })
  );

  return new Request("https://api.example/v1/decks/generate", {
    method: "POST",
    body: form
  });
}

test("an oversized upload is rejected without calling upstream", async () => {
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
    assert.match(body.error.message, /over this endpoint's 0\.92 MB limit/);
    assert.match(body.error.message, /Split it into sections/);
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
