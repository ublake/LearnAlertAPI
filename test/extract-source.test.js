import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { extractSource } from "../src/routes/extractSource.js";
import { EXTRACTION_SCHEMA } from "../src/schemas.js";
import { MAX_EXTRACT_BYTES, EXTRACTION_OUTPUT_TOKENS } from "../src/config.js";

const BOTH_KEYS = {
  CHEAPER_INFERENCE_API_KEY: "ci_live_test",
  OPENAI_API_KEY: "sk-test"
};

const MARKDOWN = "## Page 1\n\nla mesa — the table\nla silla — the chair";

function stubExtraction(overrides = {}) {
  const calls = {};

  globalThis.fetch = async (url, options) => {
    calls.url = url;
    calls.headers = options.headers;
    calls.body = JSON.parse(options.body);

    return new Response(
      JSON.stringify({
        id: "resp-extract",
        model: "test-model",
        usage: { prompt_tokens: 110_000, completion_tokens: 9_000 },
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                markdown: MARKDOWN,
                pageCount: 1,
                detectedLanguage: "es",
                coverageNotes: [],
                ...overrides
              })
            }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  return calls;
}

function uploadRequest(bytes = [0x25, 0x50, 0x44, 0x46], name = "spanish.pdf") {
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(bytes)], name, { type: "application/pdf" })
  );

  return new Request("https://api.example/v1/sources/extract", {
    method: "POST",
    body: form
  });
}

test("extraction routes to the document provider and returns markdown", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubExtraction();

  try {
    const response = await extractSource(
      uploadRequest(),
      BOTH_KEYS,
      "request-extract"
    );
    const body = await response.json();

    assert.equal(calls.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls.body.max_completion_tokens, EXTRACTION_OUTPUT_TOKENS);
    assert.deepEqual(
      calls.body.response_format.json_schema.schema,
      EXTRACTION_SCHEMA
    );

    assert.equal(body.success, true);
    assert.equal(body.extraction.markdown, MARKDOWN);
    assert.equal(body.extraction.pageCount, 1);
    assert.equal(body.extraction.detectedLanguage, "es");
    assert.equal(body.extraction.characterCount, MARKDOWN.length);
    assert.ok(body.extraction.estimatedTokens > 0);
    assert.equal(body.meta.provider, "openai");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the same bytes always produce the same contentHash", async () => {
  const originalFetch = globalThis.fetch;
  stubExtraction();

  try {
    const first = await (
      await extractSource(uploadRequest(), BOTH_KEYS, "r1")
    ).json();

    // Same bytes, different filename: still the same document.
    const renamed = await (
      await extractSource(
        uploadRequest([0x25, 0x50, 0x44, 0x46], "renamed.pdf"),
        BOTH_KEYS,
        "r2"
      )
    ).json();

    const different = await (
      await extractSource(uploadRequest([1, 2, 3, 4]), BOTH_KEYS, "r3")
    ).json();

    assert.match(first.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(first.contentHash, renamed.contentHash);
    assert.notEqual(first.contentHash, different.contentHash);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("coverage notes survive so gaps are visible", async () => {
  const originalFetch = globalThis.fetch;
  stubExtraction({ coverageNotes: ["Page 4 scan was illegible."] });

  try {
    const body = await (
      await extractSource(uploadRequest(), BOTH_KEYS, "r-notes")
    ).json();

    assert.deepEqual(body.extraction.coverageNotes, [
      "Page 4 scan was illegible."
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extraction accepts files far larger than the inline limit", async () => {
  const originalFetch = globalThis.fetch;
  stubExtraction();

  try {
    // 4 MB: rejected by the inline path, fine for a natively parsed one.
    const body = await (
      await extractSource(
        uploadRequest(new Array(4 * 1024 * 1024).fill(0x41)),
        BOTH_KEYS,
        "r-large"
      )
    ).json();

    assert.equal(body.success, true);
    assert.equal(body.source.byteSize, 4 * 1024 * 1024);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extraction still refuses a file past its own ceiling", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not be reached");
  };

  try {
    const response = await worker.fetch(
      uploadRequest(new Array(MAX_EXTRACT_BYTES + 1).fill(0x41)),
      BOTH_KEYS
    );
    const body = await response.json();

    assert.equal(called, false);
    assert.equal(response.status, 400);
    assert.match(body.error.message, /8\.00 MB limit/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the extracted text then generates a deck on the cheap provider", async () => {
  const originalFetch = globalThis.fetch;
  const calls = {};

  globalThis.fetch = async (url, options) => {
    calls.url = url;
    return new Response(
      JSON.stringify({
        id: "resp-gen",
        model: "test-model",
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
    // The whole point: after extraction, the PDF never travels again.
    await worker.fetch(
      new Request("https://api.example/v1/decks/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: MARKDOWN, sourceName: "spanish.pdf" })
      }),
      BOTH_KEYS
    );

    assert.equal(
      calls.url,
      "https://api.cheaperinference.com/v1/chat/completions"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
