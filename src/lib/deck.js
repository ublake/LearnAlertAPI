import { LIMITS } from "../config.js";

function cleanString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeCard(card, usedIds) {
  let id = cleanString(card?.id);

  if (!id || id.startsWith("new_") || usedIds.has(id)) {
    id = crypto.randomUUID();
  }

  usedIds.add(id);

  const type =
    card?.type === "multiple_choice"
      ? "multiple_choice"
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

  if (type === "tap_reveal") {
    normalizedOptions = [];
    correctAnswerIndex = -1;
  } else {
    normalizedOptions = options.slice(0, 4);

    if (
      normalizedOptions.length !== 4 ||
      new Set(normalizedOptions).size !== 4
    ) {
      throw new Error("A multiple-choice card did not contain 4 distinct options.");
    }

    if (correctAnswerIndex < 0 || correctAnswerIndex > 3) {
      throw new Error("A multiple-choice card had an invalid correctAnswerIndex.");
    }

    answer = normalizedOptions[correctAnswerIndex];
  }

  return {
    id,
    type,
    prompt: cleanString(card?.prompt),
    answer,
    hint: cleanString(card?.hint),
    explanation: cleanString(card?.explanation),
    options: normalizedOptions,
    correctAnswerIndex,
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

export function normalizeGeneratedDeck(result, maxCards = LIMITS.MAX_CARDS) {
  if (!result?.deck || !Array.isArray(result.deck.cards)) {
    throw new Error("AI returned an invalid deck.");
  }

  const usedIds = new Set();
  const cards = result.deck.cards
    .slice(0, Math.min(maxCards, LIMITS.MAX_CARDS))
    .map((card) => normalizeCard(card, usedIds));

  if (cards.length === 0) {
    throw new Error("AI generated no usable cards.");
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
    }
  };
}
