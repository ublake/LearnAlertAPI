import test from "node:test";
import assert from "node:assert/strict";

import { refineDeck } from "../src/routes/refineDeck.js";
import { DECK_SCHEMA } from "../src/schemas.js";

test("refinement uses role-preserving history and returns a complete deck", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;

  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);

    return new Response(
      JSON.stringify({
        id: "resp-refine-test",
        status: "completed",
        model: "test-model",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  assistantMessage: "I converted the card to fill-in-the-blank.",
                  deck: {
                    title: "Geography",
                    subject: "Capitals",
                    deckKind: "study",
                    detectedLanguage: "",
                    summary: "European capitals",
                    coverage: {
                      level: "high",
                      estimatedKeyConcepts: 1,
                      cardsCreated: 1,
                      omittedImportantTopics: []
                    },
                    cards: [
                      {
                        id: "card-1",
                        type: "fill_blank",
                        prompt: "The capital of France is ____.",
                        answer: "Paris",
                        hint: "A city on the Seine",
                        explanation: "Paris is the capital of France.",
                        options: [],
                        correctAnswerIndex: -1,
                        matchingPairs: [],
                        difficulty: "easy",
                        tags: ["geography"],
                        sourceLocator: "",
                        sourceExcerpt: "Paris is the capital of France."
                      }
                    ]
                  }
                })
              }
            ]
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
    const response = await refineDeck(
      new Request("https://api.example/v1/decks/refine", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          instruction: "Make that a fill-in-the-blank card.",
          deck: {
            cards: [
              {
                id: "card-1",
                type: "tap_reveal",
                prompt: "Capital of France",
                answer: "Paris"
              }
            ]
          },
          chatHistory: [
            { role: "user", content: "Focus on European capitals." },
            { role: "assistant", content: "The deck now focuses on Europe." }
          ]
        })
      }),
      { OPENAI_API_KEY: "test-key" },
      "request-refine-test"
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.action, "deck");
    assert.equal(body.deck.cards.length, 1);
    assert.equal(body.deck.cards[0].id, "card-1");
    assert.equal(body.deck.cards[0].type, "fill_blank");
    assert.deepEqual(requestBody.input.slice(0, 2), [
      { role: "user", content: "Focus on European capitals." },
      { role: "assistant", content: "The deck now focuses on Europe." }
    ]);
    assert.equal(requestBody.input[2].role, "user");
    assert.match(
      requestBody.input[2].content,
      /Make that a fill-in-the-blank card\./
    );
    assert.deepEqual(requestBody.text.format.schema, DECK_SCHEMA);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
