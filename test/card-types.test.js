import test from "node:test";
import assert from "node:assert/strict";

import { normalizeGeneratedDeck } from "../src/lib/deck.js";

function resultWithCards(cards) {
  return {
    assistantMessage: "Updated the deck.",
    deck: {
      title: "Test Deck",
      subject: "Testing",
      deckKind: "study",
      detectedLanguage: "",
      summary: "Test cards",
      coverage: {
        level: "high",
        estimatedKeyConcepts: cards.length,
        cardsCreated: cards.length,
        omittedImportantTopics: []
      },
      cards
    }
  };
}

test("normalizes a matching card with 2 to 4 unique pairs", () => {
  const normalized = normalizeGeneratedDeck(
    resultWithCards([
      {
        id: "matching-1",
        type: "matching",
        prompt: "Match each term with its definition.",
        answer: "ignored",
        hint: "ignored",
        explanation: "ignored",
        options: ["ignored"],
        correctAnswerIndex: 2,
        matchingPairs: [
          { left: " Hola ", right: " Hello " },
          { left: "Adiós", right: "Goodbye" }
        ],
        difficulty: "medium",
        tags: [],
        sourceExcerpt: "",
        sourceLocator: ""
      }
    ])
  );
  const card = normalized.deck.cards[0];

  assert.equal(card.type, "matching");
  assert.equal(card.answer, "");
  assert.equal(card.hint, "");
  assert.deepEqual(card.options, []);
  assert.equal(card.correctAnswerIndex, -1);
  assert.deepEqual(card.matchingPairs, [
    { left: "Hola", right: "Hello" },
    { left: "Adiós", right: "Goodbye" }
  ]);
});

test("a repeated term is dropped but the card survives", () => {
  const normalized = normalizeGeneratedDeck(
    resultWithCards([
      {
        id: "matching-1",
        type: "matching",
        prompt: "Match the pairs.",
        matchingPairs: [
          { left: "One", right: "Uno" },
          { left: "Two", right: "Dos" },
          // "one" duplicates "One": ambiguous, so this pair goes.
          { left: "one", right: "Ein" }
        ]
      }
    ])
  );

  assert.deepEqual(normalized.deck.cards[0].matchingPairs, [
    { left: "One", right: "Uno" },
    { left: "Two", right: "Dos" }
  ]);
  assert.deepEqual(normalized.droppedCards, []);
});

test("an unsalvageable card is dropped without killing the deck", () => {
  const normalized = normalizeGeneratedDeck(
    resultWithCards([
      {
        id: "good-1",
        type: "tap_reveal",
        prompt: "Capital of France",
        answer: "Paris"
      },
      {
        // Dedupes down to one pair, which is not a matching card.
        id: "matching-1",
        type: "matching",
        prompt: "Match the pairs.",
        matchingPairs: [
          { left: "One", right: "Uno" },
          { left: "one", right: "Ein" }
        ]
      },
      {
        id: "bad-mc",
        type: "multiple_choice",
        prompt: "Pick one",
        options: ["a", "a", "b", "c"],
        correctAnswerIndex: 0
      }
    ])
  );

  // The good card survives. This is the whole point of the change.
  assert.equal(normalized.deck.cards.length, 1);
  assert.equal(normalized.deck.cards[0].id, "good-1");

  assert.equal(normalized.droppedCards.length, 2);
  assert.deepEqual(
    normalized.droppedCards.map((entry) => entry.type),
    ["matching", "multiple_choice"]
  );
  assert.match(normalized.droppedCards[0].reason, /unique left and right/);
});

test("a deck with no salvageable cards still fails", () => {
  assert.throws(
    () =>
      normalizeGeneratedDeck(
        resultWithCards([
          {
            id: "matching-1",
            type: "matching",
            prompt: "Match the pairs.",
            matchingPairs: [{ left: "One", right: "Uno" }]
          }
        ])
      ),
    /no usable cards/
  );
});

test("normalizes fill-in-the-blank fields", () => {
  const normalized = normalizeGeneratedDeck(
    resultWithCards([
      {
        id: "fill-1",
        type: "fill_blank",
        prompt: "The capital of France is ____.",
        answer: "Paris",
        hint: "A European capital",
        explanation: "Paris is the capital of France.",
        options: ["Paris"],
        correctAnswerIndex: 0,
        matchingPairs: [{ left: "France", right: "Paris" }],
        difficulty: "easy",
        tags: ["geography"],
        sourceExcerpt: "Paris is the capital of France.",
        sourceLocator: ""
      }
    ])
  );
  const card = normalized.deck.cards[0];

  assert.equal(card.type, "fill_blank");
  assert.equal(card.answer, "Paris");
  assert.deepEqual(card.options, []);
  assert.equal(card.correctAnswerIndex, -1);
  assert.deepEqual(card.matchingPairs, []);
});

test("preserves existing refinement IDs and replaces new temporary IDs", () => {
  const normalized = normalizeGeneratedDeck(
    resultWithCards([
      {
        id: "existing-card",
        type: "tap_reveal",
        prompt: "Existing",
        answer: "Answer"
      },
      {
        id: "new_card",
        type: "tap_reveal",
        prompt: "New",
        answer: "Answer"
      }
    ]),
    50,
    new Set(["existing-card"])
  );

  assert.equal(normalized.deck.cards[0].id, "existing-card");
  assert.notEqual(normalized.deck.cards[1].id, "new_card");
  assert.equal(normalized.deck.cards[1].id.startsWith("new_"), false);
});
