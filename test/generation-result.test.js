import test from "node:test";
import assert from "node:assert/strict";

import { normalizeGeneratedDeck, normalizeGenerationResult } from "../src/lib/deck.js";
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

test("generated deck summaries stay brief without clipping sentences", () => {
  const summary = "I've created 1 flashcard covering cell biology.";
  const limitation = "Some advanced topics were omitted.";
  const deck = {
    cards: [{ type: "tap_reveal", prompt: "What produces ATP?", answer: "Mitochondria" }]
  };
  const normalize = (assistantMessage) => normalizeGenerationResult({
    action: "deck", assistantMessage, deck
  }).assistantMessage;

  assert.equal(normalize(summary), summary);
  assert.equal(normalize(`${summary}\n\n${limitation}`), `${summary} ${limitation}`);
  assert.equal(
    normalize(`${summary} ${limitation} Start with foundations and ask me any questions.`),
    `${summary} ${limitation}`
  );
  const longSentence = `I've created cards covering ${"all the detailed concepts and definitions ".repeat(10)}from your source.`;
  assert.equal(normalize(`${summary} ${longSentence}`), summary);
  assert.equal(normalize(longSentence), "Created 1 study card.");
  assert.equal(normalize("x".repeat(300)), "Created 1 study card.");
  assert.equal(normalize("   "), "Created 1 study card.");

  // The limit applies only to deck generation; tutoring and refinements retain detail.
  assert.equal(normalizeGenerationResult({
    action: "chat", assistantMessage: longSentence, deck: null
  }).assistantMessage, longSentence);
  assert.equal(normalizeGeneratedDeck({ assistantMessage: longSentence, deck }).assistantMessage, longSentence);
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
    // Layout is the prompt-cache contract: system, then the stable source,
    // then the history that grows each turn, then this turn's preferences.
    assert.equal(requestBody.messages[0].role, "system");
    assert.equal(requestBody.messages[1].role, "user");
    assert.match(requestBody.messages[1].content, /<source_material>\nhello/);
    assert.deepEqual(requestBody.messages.slice(2, 4), [
      {
        role: "user",
        content: "Create Spanish cards."
      },
      {
        role: "assistant",
        content: "Send your notes."
      }
    ]);
    assert.equal(requestBody.messages[4].role, "user");
    assert.match(
      requestBody.messages[4].content,
      /<generation_preferences>/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
