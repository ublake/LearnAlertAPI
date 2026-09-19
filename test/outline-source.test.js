import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { OUTLINE } from "../src/config.js";

const ENV = { CHEAPER_INFERENCE_API_KEY: "ci_live_test", OPENAI_API_KEY: "sk" };

function stub(sections) {
  const calls = {};

  globalThis.fetch = async (url, options) => {
    calls.url = url;
    calls.body = JSON.parse(options.body);

    return new Response(
      JSON.stringify({
        id: "resp-outline",
        model: "test-model",
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify({ sections }) }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  return calls;
}

function outlineRequest(pages, sourceName = "Spanish 101") {
  return new Request("https://api.example/v1/sources/outline", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pages, sourceName })
  });
}

const PAGES = [
  { index: 0, snippet: "Spanish 101 — Table of Contents" },
  { index: 1, snippet: "Módulo 1: Saludos" },
  { index: 2, snippet: "práctica de saludos" },
  { index: 3, snippet: "Módulo 2: Ser y Estar" },
  { index: 4, snippet: "conjugación de ser" }
];

test("outline uses the cheap text provider, not the document one", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stub([
    { title: "Front matter", kind: "front_matter", startPage: 0, endPage: 0, summary: "TOC" },
    { title: "Módulo 1: Saludos", kind: "module", startPage: 1, endPage: 2, summary: "Greetings" },
    { title: "Módulo 2: Ser y Estar", kind: "module", startPage: 3, endPage: 4, summary: "Ser" }
  ]);

  try {
    const body = await (
      await worker.fetch(outlineRequest(PAGES), ENV)
    ).json();

    // No file involved, so this must not route to the expensive parser.
    assert.equal(
      calls.url,
      "https://api.cheaperinference.com/v1/chat/completions"
    );
    assert.equal(body.meta.provider, "cheaper_inference");

    assert.equal(body.sections.length, 3);
    assert.equal(body.sections[1].title, "Módulo 1: Saludos");
    assert.equal(body.sections[1].pageCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("overlapping sections are trimmed into selectable ranges", async () => {
  const originalFetch = globalThis.fetch;
  stub([
    { title: "A", kind: "module", startPage: 0, endPage: 3, summary: "" },
    // Overlaps A, and runs past the last page.
    { title: "B", kind: "module", startPage: 2, endPage: 99, summary: "" }
  ]);

  try {
    const body = await (
      await worker.fetch(outlineRequest(PAGES), ENV)
    ).json();

    assert.deepEqual(
      body.sections.map((s) => [s.startPage, s.endPage]),
      [
        [0, 3],
        [4, 4]
      ]
    );
    assert.equal(body.sections[1].pageCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a section swallowed by trimming is dropped, not emitted backwards", async () => {
  const originalFetch = globalThis.fetch;
  stub([
    { title: "A", kind: "module", startPage: 0, endPage: 4, summary: "" },
    { title: "B", kind: "module", startPage: 1, endPage: 2, summary: "" }
  ]);

  try {
    const body = await (
      await worker.fetch(outlineRequest(PAGES), ENV)
    ).json();

    assert.equal(body.sections.length, 1);
    assert.ok(body.sections.every((s) => s.endPage >= s.startPage));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("too many pages is rejected before any call", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not be reached");
  };

  try {
    const pages = Array.from({ length: OUTLINE.MAX_PAGES + 1 }, (_, i) => ({
      index: i,
      snippet: "x"
    }));
    const response = await worker.fetch(outlineRequest(pages), ENV);
    const body = await response.json();

    assert.equal(called, false);
    assert.equal(response.status, 400);
    assert.match(body.error.message, /Too many pages/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an all-empty document is rejected with an OCR hint", async () => {
  const response = await worker.fetch(
    outlineRequest([
      { index: 0, snippet: "" },
      { index: 1, snippet: "   " }
    ]),
    ENV
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.match(body.error.message, /OCR/);
});

test("snippets are truncated so long pages cannot inflate cost", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stub([
    { title: "A", kind: "module", startPage: 0, endPage: 0, summary: "" }
  ]);

  try {
    await worker.fetch(
      outlineRequest([{ index: 0, snippet: "y".repeat(5_000) }]),
      ENV
    );

    const sent = calls.body.messages[1].content;
    assert.ok(sent.includes("y".repeat(OUTLINE.MAX_SNIPPET_CHARS)));
    assert.equal(sent.includes("y".repeat(OUTLINE.MAX_SNIPPET_CHARS + 1)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
