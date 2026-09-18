import test from "node:test";
import assert from "node:assert/strict";

import { normalizeGenerationResult } from "../src/lib/deck.js";
import { generateDeck } from "../src/routes/generateDeck.js";
import { GENERATION_RESULT_SCHEMA } from "../src/schemas.js";

function assertStrictObjects(schema) {
  if (!schema || typeof schema !== "object") return;

  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(
      [...schema.required].sort(),
      Object.keys(schema.properties).sort()
    );
  }

  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      value.forEach(assertStrictObjects);
    } else {
      assertStrictObjects(value);
    }
  }
}

test("uses a strict root object with a nullable nested deck", () => {
  assert.equal(GENERATION_RESULT_SCHEMA.type, "object");
  assert.equal("anyOf" in GENERATION_RESULT_SCHEMA, false);
  assert.deepEqual(
    GENERATION_RESULT_SCHEMA.properties.action.enum,
    ["chat", "deck"]
  );
  assert.equal(
    GENERATION_RESULT_SCHEMA.properties.deck.anyOf.some(
      (branch) => branch.type === "null"
    ),
    true
  );
  assertStrictObjects(GENERATION_RESULT_SCHEMA);

  const deckSchema = GENERATION_RESULT_SCHEMA.properties.deck.anyOf.find(
    (branch) => branch.type === "object"
  );
  const cardSchemas = deckSchema.properties.cards.items.anyOf;
  const matchingSchema = cardSchemas.find(
    (schema) => schema.properties.type.enum[0] === "matching"
  );

  assert.deepEqual(
    cardSchemas.map((schema) => schema.properties.type.enum[0]),
    ["tap_reveal", "multiple_choice", "matching", "fill_blank"]
  );
  assert.equal(matchingSchema.properties.matchingPairs.minItems, 2);
  assert.equal(matchingSchema.properties.matchingPairs.maxItems, 4);
});

test("normalizes a conversational generation response", () => {
  assert.deepEqual(
    normalizeGenerationResult({
      action: "chat",
      assistantMessage: "Hi! What would you like to study?",
      deck: null
    }),
    {
      action: "chat",
      assistantMessage: "Hi! What would you like to study?",
      deck: null
    }
  );
});

test("rejects a chat response that contains a deck", () => {
  assert.throws(
    () =>
      normalizeGenerationResult({
        action: "chat",
        assistantMessage: "Hello",
        deck: {}
      }),
    /deck for a chat response/
  );
});

test("normalizes a deck generation response", () => {
  const result = normalizeGenerationResult(
    {
      action: "deck",
      assistantMessage: "Created a focused deck.",
      deck: {
        title: "Biology",
        subject: "Cells",
        deckKind: "study",
        detectedLanguage: "",
        summary: "Cell basics",
        coverage: {
          level: "high",
          estimatedKeyConcepts: 1,
          cardsCreated: 99,
          omittedImportantTopics: []
        },
        cards: [
          {
            id: "card-1",
            type: "tap_reveal",
            prompt: "What is the powerhouse of the cell?",
            answer: "The mitochondrion",
            hint: "Think energy",
            explanation: "It produces most cellular ATP.",
            options: [],
            correctAnswerIndex: -1,
            difficulty: "easy",
            tags: ["cells"],
            sourceLocator: "",
            sourceExcerpt: "Mitochondria produce ATP."
          }
        ]
      }
    },
    10
  );

  assert.equal(result.action, "deck");
  assert.equal(result.deck.cards.length, 1);
  assert.equal(result.deck.coverage.cardsCreated, 1);
});

test("rejects a deck response without a deck", () => {
  assert.throws(
    () =>
      normalizeGenerationResult({
        action: "deck",
        assistantMessage: "Created a deck.",
        deck: null
      }),
    /no deck for a deck response/
  );
});

test("generate endpoint returns the AI-selected chat action", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;

  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);

    return new Response(
      JSON.stringify({
        id: "resp-test",
        model: "test-model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({
                action: "chat",
                assistantMessage: "Hi! What would you like to study?",
                deck: null
              })
            }
          }
        ]
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  };

  try {
    const response = await generateDeck(
      new Request("https://api.example/v1/decks/generate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: "hello",
          chatHistory: [
            { role: "user", content: "Create Spanish cards." },
            { role: "assistant", content: "Send your notes." }
          ]
        })
      }),
      { CHEAPER_INFERENCE_API_KEY: "test-key" },
      "request-test"
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.action, "chat");
    assert.equal(body.deck, null);
    assert.equal(body.assistantMessage, "Hi! What would you like to study?");
    assert.equal(
      requestBody.response_format.json_schema.name,
      "learnalert_generation_result"
    );
    assert.deepEqual(
      requestBody.response_format.json_schema.schema,
      GENERATION_RESULT_SCHEMA
    );
    assert.equal(requestBody.messages[0].role, "system");
    assert.deepEqual(requestBody.messages.slice(1, 3), [
      {
        role: "user",
        content: "Create Spanish cards."
      },
      {
        role: "assistant",
        content: "Send your notes."
      }
    ]);
    assert.equal(requestBody.messages[3].role, "user");
    assert.match(requestBody.messages[3].content, /<source_material>\nhello/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
