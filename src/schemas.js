const CARD_SCHEMA = {
  type: "object",
  properties: {
    id: {
      type: "string"
    },
    type: {
      type: "string",
      enum: ["tap_reveal", "multiple_choice"]
    },
    prompt: {
      type: "string"
    },
    answer: {
      type: "string"
    },
    hint: {
      type: "string"
    },
    explanation: {
      type: "string"
    },
    options: {
      type: "array",
      items: {
        type: "string"
      },
      minItems: 0,
      maxItems: 4
    },
    correctAnswerIndex: {
      type: "integer",
      minimum: -1,
      maximum: 3
    },
    difficulty: {
      type: "string",
      enum: ["easy", "medium", "hard"]
    },
    tags: {
      type: "array",
      items: {
        type: "string"
      },
      maxItems: 8
    },
    sourceLocator: {
      type: "string"
    },
    sourceExcerpt: {
      type: "string"
    }
  },
  required: [
    "id",
    "type",
    "prompt",
    "answer",
    "hint",
    "explanation",
    "options",
    "correctAnswerIndex",
    "difficulty",
    "tags",
    "sourceLocator",
    "sourceExcerpt"
  ],
  additionalProperties: false
};

const COVERAGE_SCHEMA = {
  type: "object",
  properties: {
    level: {
      type: "string",
      enum: ["low", "medium", "high"]
    },
    estimatedKeyConcepts: {
      type: "integer",
      minimum: 0,
      maximum: 500
    },
    cardsCreated: {
      type: "integer",
      minimum: 1,
      maximum: 50
    },
    omittedImportantTopics: {
      type: "array",
      items: {
        type: "string"
      },
      maxItems: 12
    }
  },
  required: [
    "level",
    "estimatedKeyConcepts",
    "cardsCreated",
    "omittedImportantTopics"
  ],
  additionalProperties: false
};

export const DECK_SCHEMA = {
  type: "object",
  properties: {
    assistantMessage: {
      type: "string"
    },
    deck: {
      type: "object",
      properties: {
        title: {
          type: "string"
        },
        subject: {
          type: "string"
        },
        deckKind: {
          type: "string",
          enum: ["language_learning", "study", "mixed"]
        },
        detectedLanguage: {
          type: "string"
        },
        summary: {
          type: "string"
        },
        coverage: COVERAGE_SCHEMA,
        cards: {
          type: "array",
          items: CARD_SCHEMA,
          minItems: 1,
          maxItems: 50
        }
      },
      required: [
        "title",
        "subject",
        "deckKind",
        "detectedLanguage",
        "summary",
        "coverage",
        "cards"
      ],
      additionalProperties: false
    }
  },
  required: [
    "assistantMessage",
    "deck"
  ],
  additionalProperties: false
};
