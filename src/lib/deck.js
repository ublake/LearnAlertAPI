import { LIMITS } from "../config.js";

/** A single card is unusable. The rest of the deck is unaffected. */
export class CardError extends Error {}

/** The whole response is unusable. */
export class DeckError extends Error {}

function cleanString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeMatchingPairs(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    throw new CardError("A matching card must contain 2 to 4 complete pairs.");
  }

  const pairs = value.map((pair) => ({
    left: cleanString(pair?.left),
    right: cleanString(pair?.right)
  }));

  if (pairs.some((pair) => !pair.left || !pair.right)) {
    throw new CardError("A matching card must contain 2 to 4 complete pairs.");
  }

  // A repeated term makes the card ambiguous, but the other pairs are still
  // good. Drop the duplicates and keep the card if enough survive.
  const seenLeft = new Set();
  const seenRight = new Set();
  const unique = pairs.filter((pair) => {
    const left = pair.left.toLowerCase();
    const right = pair.right.toLowerCase();

    if (seenLeft.has(left) || seenRight.has(right)) return false;

    seenLeft.add(left);
    seenRight.add(right);
    return true;
  });

  if (unique.length < 2) {
    throw new CardError("A matching card must contain unique left and right values.");
  }

  return unique;
}

function normalizeCard(card, usedIds, validIds = null) {
  let id = cleanString(card?.id);

  if (
    !id ||
    id.startsWith("new_") ||
    usedIds.has(id) ||
    (validIds && !validIds.has(id))
  ) {
    id = crypto.randomUUID();
  }

  usedIds.add(id);

  const type = [
    "tap_reveal",
    "multiple_choice",
    "matching",
    "fill_blank"
  ].includes(card?.type)
    ? card.type
    : "tap_reveal";

  const options = Array.isArray(card?.options)
    ? card.options
        .filter((option) => typeof option === "string")
        .map((option) => option.trim())
    : [];

  let correctAnswerIndex = Number.isInteger(card?.correctAnswerIndex)
    ? card.correctAnswerIndex
    : -1;

  let normalizedOptions = options;
  let answer = cleanString(card?.answer);
  let hint = cleanString(card?.hint);
  let explanation = cleanString(card?.explanation);
  let matchingPairs = [];

  if (type === "multiple_choice") {
    normalizedOptions = options.slice(0, 4);

    if (
      normalizedOptions.length !== 4 ||
      new Set(normalizedOptions).size !== 4
    ) {
      throw new CardError("A multiple-choice card did not contain 4 distinct options.");
    }

    if (correctAnswerIndex < 0 || correctAnswerIndex > 3) {
      throw new CardError("A multiple-choice card had an invalid correctAnswerIndex.");
    }

    answer = normalizedOptions[correctAnswerIndex];
  } else {
    normalizedOptions = [];
    correctAnswerIndex = -1;
  }

  if (type === "matching") {
    matchingPairs = normalizeMatchingPairs(card?.matchingPairs);
    answer = "";
    hint = "";
    explanation = "";
  }

  if (type === "fill_blank") {
    if (!answer) {
      throw new CardError("A fill-in-the-blank card must contain an answer.");
    }
  }

  return {
    id,
    type,
    prompt: cleanString(card?.prompt),
    answer,
    hint,
    explanation,
    options: normalizedOptions,
    correctAnswerIndex,
    matchingPairs,
    difficulty: ["easy", "medium", "hard"].includes(card?.difficulty)
      ? card.difficulty
      : "medium",
    tags: Array.isArray(card?.tags)
      ? [...new Set(
          card.tags
            .filter((tag) => typeof tag === "string")
            .map((tag) => tag.trim())
            .filter(Boolean)
        )].slice(0, 8)
      : [],
    sourceLocator: cleanString(card?.sourceLocator),
    sourceExcerpt: cleanString(card?.sourceExcerpt)
  };
}

export function normalizeGeneratedDeck(
  result,
  maxCards = LIMITS.MAX_CARDS,
  validIds = null
) {
  if (!result?.deck || !Array.isArray(result.deck.cards)) {
    throw new DeckError("AI returned an invalid deck.");
  }

  const usedIds = new Set();
  const cards = [];
  const dropped = [];

  // One malformed card must not cost the user the whole deck.
  for (const card of result.deck.cards.slice(
    0,
    Math.min(maxCards, LIMITS.MAX_CARDS)
  )) {
    try {
      cards.push(normalizeCard(card, usedIds, validIds));
    } catch (error) {
      if (!(error instanceof CardError)) throw error;
      dropped.push({ type: card?.type ?? "unknown", reason: error.message });
    }
  }

  if (cards.length === 0) {
    throw new DeckError("AI generated no usable cards.");
  }

  const coverage = result.deck.coverage || {};

  return {
    assistantMessage: cleanString(
      result.assistantMessage,
      `Created ${cards.length} study cards.`
    ),
    deck: {
      title: cleanString(result.deck.title, "Generated Deck"),
      subject: cleanString(result.deck.subject, "Study"),
      deckKind: ["language_learning", "study", "mixed"].includes(result.deck.deckKind)
        ? result.deck.deckKind
        : "study",
      detectedLanguage: cleanString(result.deck.detectedLanguage),
      summary: cleanString(result.deck.summary),
      coverage: {
        level: ["low", "medium", "high"].includes(coverage.level)
          ? coverage.level
          : "medium",
        estimatedKeyConcepts: Number.isInteger(coverage.estimatedKeyConcepts)
          ? Math.max(0, Math.min(coverage.estimatedKeyConcepts, 500))
          : cards.length,
        cardsCreated: cards.length,
        omittedImportantTopics: Array.isArray(coverage.omittedImportantTopics)
          ? coverage.omittedImportantTopics
              .filter((topic) => typeof topic === "string")
              .map((topic) => topic.trim())
              .filter(Boolean)
              .slice(0, 12)
          : []
      },
      cards
    },
    // Visible rather than silent: a deck that quietly lost cards should be
    // debuggable without diffing against the upstream response.
    droppedCards: dropped
  };
}

export function normalizeGenerationResult(
  result,
  maxCards = LIMITS.MAX_CARDS
) {
  if (result?.action === "chat") {
    if (result.deck !== null) {
      throw new DeckError("AI returned a deck for a chat response.");
    }

    return {
      action: "chat",
      assistantMessage: cleanString(
        result.assistantMessage,
        "What would you like to study?"
      ),
      deck: null
    };
  }

  if (result?.action !== "deck") {
    throw new DeckError("AI returned an invalid generation action.");
  }

  if (!result.deck) {
    throw new DeckError("AI returned no deck for a deck response.");
  }

  return {
    action: "deck",
    ...normalizeGeneratedDeck(result, maxCards)
  };
}
