import test from "node:test";
import assert from "node:assert/strict";

import { generateDeck } from "../src/routes/generateDeck.js";
import { refineDeck } from "../src/routes/refineDeck.js";

const BOTH_KEYS = {
  CHEAPER_INFERENCE_API_KEY: "ci_live_test",
  OPENAI_API_KEY: "sk-test"
};

const DECK_PAYLOAD = {
  assistantMessage: "Done.",
  deck: {
    title: "Notes",
    subject: "Notes",
    deckKind: "study",
    detectedLanguage: "",
    summary: "From the attached source",
    coverage: {
      level: "high",
      estimatedKeyConcepts: 1,
      cardsCreated: 1,
      omittedImportantTopics: []
    },
    cards: [
      {
        id: "card-1",
        type: "tap_reveal",
        prompt: "What did the source say?",
        answer: "Something",
        hint: "Recall",
        explanation: "Stated in the source.",
        options: [],
        correctAnswerIndex: -1,
        matchingPairs: [],
        difficulty: "easy",
        tags: [],
        sourceLocator: "",
        sourceExcerpt: "Something"
      }
    ]
  }
};

function stubFetch(payload) {
  const calls = {};

  globalThis.fetch = async (url, options) => {
    calls.url = url;
    calls.headers = options.headers;
    calls.body = JSON.parse(options.body);

    return new Response(
      JSON.stringify({
        id: "resp-inline",
        model: "test-model",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: JSON.stringify(payload) }
          }
        ]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  return calls;
}

function lastUserParts(body) {
  return body.messages[body.messages.length - 1].content;
}

test("multipart generation inlines a PDF as a base64 data URL", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubFetch({ action: "deck", ...DECK_PAYLOAD });

  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "notes.pdf", {
      type: "application/pdf"
    })
  );

  try {
    const response = await generateDeck(
      new Request("https://api.example/v1/decks/generate", {
        method: "POST",
        body: form
      }),
      BOTH_KEYS,
      "request-inline-pdf"
    );
    const body = await response.json();

    // A document routes to the provider that parses documents.
    assert.equal(calls.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls.headers.Authorization, "Bearer sk-test");

    const parts = lastUserParts(calls.body);
    const filePart = parts.find((part) => part.type === "file");

    assert.equal(parts[0].type, "text");
    assert.equal(filePart.file.filename, "notes.pdf");
    assert.equal(
      filePart.file.file_data,
      "data:application/pdf;base64,JVBERg=="
    );

    // No /v1/files round trip means no upstream id to hand back.
    assert.equal("sourceId" in body, false);
    assert.equal(body.source.mimeType, "application/pdf");
    assert.equal(body.source.byteSize, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("multipart generation inlines an image as an image_url part", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubFetch({ action: "deck", ...DECK_PAYLOAD });

  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array([1, 2, 3])], "board.png", { type: "image/png" })
  );

  try {
    await generateDeck(
      new Request("https://api.example/v1/decks/generate", {
        method: "POST",
        body: form
      }),
      BOTH_KEYS,
      "request-inline-image"
    );

    const imagePart = lastUserParts(calls.body).find(
      (part) => part.type === "image_url"
    );

    assert.match(imagePart.image_url.url, /^data:image\/png;base64,/);
    assert.equal(imagePart.image_url.detail, "auto");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refinement re-attaches a resent file from multipart", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubFetch(DECK_PAYLOAD);

  const form = new FormData();
  form.append("instruction", "Add one more card.");
  form.append(
    "deck",
    JSON.stringify({ cards: [{ id: "card-1", type: "tap_reveal" }] })
  );
  form.append(
    "file",
    new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "notes.pdf", {
      type: "application/pdf"
    })
  );

  try {
    const response = await refineDeck(
      new Request("https://api.example/v1/decks/refine", {
        method: "POST",
        body: form
      }),
      BOTH_KEYS,
      "request-refine-file"
    );
    const body = await response.json();

    const parts = lastUserParts(calls.body);

    assert.match(parts[0].text, /source_note/);
    assert.equal(parts[1].file.filename, "notes.pdf");
    assert.equal(body.source.name, "notes.pdf");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refinement without a source falls back to the deck-only note", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubFetch(DECK_PAYLOAD);

  try {
    await refineDeck(
      new Request("https://api.example/v1/decks/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction: "Reword card one.",
          deck: { cards: [{ id: "card-1", type: "tap_reveal" }] },
          sourceId: "file-abc123"
        })
      }),
      BOTH_KEYS,
      "request-refine-stale-id"
    );

    // A stale sourceId from the old files-API flow must not claim an attachment.
    assert.match(
      lastUserParts(calls.body),
      /No source material was supplied/
    );
    // No file means no reason to leave the cheap provider.
    assert.equal(
      calls.url,
      "https://api.cheaperinference.com/v1/chat/completions"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function truncatedRefine(promptTokens) {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        id: "resp-truncated",
        model: "test-model",
        choices: [{ finish_reason: "length", message: { content: "" } }],
        usage: { prompt_tokens: promptTokens, completion_tokens: 6421 }
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const done = refineDeck(
    new Request("https://api.example/v1/decks/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instruction: "Reword card one.",
        deck: { cards: [{ id: "card-1", type: "tap_reveal" }] }
      })
    }),
    BOTH_KEYS,
    "request-truncated"
  );

  return { done, restore: () => (globalThis.fetch = originalFetch) };
}

test("a source that fills the context window says so", async () => {
  // The real failure: 399,047 prompt tokens left no room for a deck.
  const { done, restore } = truncatedRefine(399_047);

  try {
    await assert.rejects(done, /filled the model's context window/);
  } finally {
    restore();
  }
});

test("a merely long deck is reported as a card-count problem", async () => {
  const { done, restore } = truncatedRefine(5_000);

  try {
    await assert.rejects(done, /Ask for fewer cards/);
  } finally {
    restore();
  }
});
