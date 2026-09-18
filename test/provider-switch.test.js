import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { generateDeck } from "../src/routes/generateDeck.js";
import { resolveProvider } from "../src/lib/ai.js";

function stubFetch() {
  const calls = {};

  globalThis.fetch = async (url, options) => {
    calls.url = url;
    calls.headers = options.headers;
    calls.body = JSON.parse(options.body);

    return new Response(
      JSON.stringify({
        id: "resp-switch",
        model: "upstream-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                action: "chat",
                assistantMessage: "Hi!",
                deck: null
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

function generateRequest(headers = {}) {
  return new Request("https://api.example/v1/decks/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ text: "hello" })
  });
}

test("defaults to Cheaper Inference", () => {
  const provider = resolveProvider({ CHEAPER_INFERENCE_API_KEY: "ci_live" });

  assert.equal(provider.name, "cheaper_inference");
  assert.equal(provider.baseUrl, "https://api.cheaperinference.com/v1");
  assert.equal(provider.apiKey, "ci_live");
});

test("AI_PROVIDER switches the whole call to OpenAI", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubFetch();

  try {
    const response = await generateDeck(
      generateRequest(),
      {
        AI_PROVIDER: "openai",
        OPENAI_API_KEY: "sk-test",
        CHEAPER_INFERENCE_API_KEY: "ci_live"
      },
      "request-openai"
    );
    const body = await response.json();

    assert.equal(calls.url, "https://api.openai.com/v1/chat/completions");
    assert.equal(calls.headers.Authorization, "Bearer sk-test");
    assert.equal(body.meta.provider, "openai");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AI_MODEL overrides the provider's default model", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubFetch();

  try {
    await generateDeck(
      generateRequest(),
      {
        AI_PROVIDER: "openai",
        AI_MODEL: "gpt-5.6-terra",
        OPENAI_API_KEY: "sk-test"
      },
      "request-model"
    );

    assert.equal(calls.body.model, "gpt-5.6-terra");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the X-AI-Provider header is ignored unless overrides are enabled", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubFetch();

  try {
    await generateDeck(
      generateRequest({ "X-AI-Provider": "openai" }),
      { CHEAPER_INFERENCE_API_KEY: "ci_live", OPENAI_API_KEY: "sk-test" },
      "request-ignored-override"
    );

    assert.equal(
      calls.url,
      "https://api.cheaperinference.com/v1/chat/completions"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the X-AI-Provider header is honoured when overrides are enabled", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubFetch();

  try {
    await generateDeck(
      generateRequest({ "X-AI-Provider": "openai" }),
      {
        ALLOW_PROVIDER_OVERRIDE: "true",
        CHEAPER_INFERENCE_API_KEY: "ci_live",
        OPENAI_API_KEY: "sk-test"
      },
      "request-honoured-override"
    );

    assert.equal(calls.url, "https://api.openai.com/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a selected provider with no key fails before any upstream call", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;

  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not be reached");
  };

  try {
    const response = await worker.fetch(generateRequest(), {
      AI_PROVIDER: "openai",
      CHEAPER_INFERENCE_API_KEY: "ci_live"
    });
    const body = await response.json();

    assert.equal(called, false);
    assert.equal(response.status, 500);
    assert.match(body.error.message, /OPENAI_API_KEY is not configured/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an unknown provider name is rejected", async () => {
  const response = await worker.fetch(generateRequest(), {
    AI_PROVIDER: "definitely-not-a-provider",
    CHEAPER_INFERENCE_API_KEY: "ci_live"
  });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.match(body.error.message, /Unknown AI provider/);
});

test("the health check reports the active and standby providers", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/", { method: "GET" }),
    { AI_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" }
  );
  const body = await response.json();

  assert.equal(body.ai.active, "openai");
  assert.equal(body.ai.overrideAllowed, false);
  // Cheaper Inference has no key here, so it must not look ready.
  assert.deepEqual(body.ai.configured, ["openai"]);
});

test("DOCUMENT_PROVIDER applies even when AI_PROVIDER is set", async () => {
  const originalFetch = globalThis.fetch;
  const calls = stubFetch();

  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array([1, 2, 3])], "notes.pdf", {
      type: "application/pdf"
    })
  );

  try {
    await generateDeck(
      new Request("https://api.example/v1/decks/generate", {
        method: "POST",
        body: form
      }),
      {
        // Both set: text follows one, documents the other.
        AI_PROVIDER: "cheaper_inference",
        DOCUMENT_PROVIDER: "openai",
        CHEAPER_INFERENCE_API_KEY: "ci_live",
        OPENAI_API_KEY: "sk-test"
      },
      "request-doc-provider"
    );

    assert.equal(calls.url, "https://api.openai.com/v1/chat/completions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the health check reports the document provider separately", async () => {
  const response = await worker.fetch(
    new Request("https://api.example/", { method: "GET" }),
    {
      AI_PROVIDER: "cheaper_inference",
      DOCUMENT_PROVIDER: "openai",
      CHEAPER_INFERENCE_API_KEY: "ci_live",
      OPENAI_API_KEY: "sk-test"
    }
  );
  const body = await response.json();

  assert.equal(body.ai.active, "cheaper_inference");
  assert.equal(body.ai.documents, "openai");
});
