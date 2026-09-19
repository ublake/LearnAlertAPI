const MATCHING_PAIR_SCHEMA = {
  type: "object",
  properties: {
    left: {
      type: "string"
    },
    right: {
      type: "string"
    }
  },
  required: ["left", "right"],
  additionalProperties: false
};

function cardSchema(type) {
  const multipleChoice = type === "multiple_choice";
  const matching = type === "matching";

  return {
    type: "object",
    properties: {
      id: {
        type: "string"
      },
      type: {
        type: "string",
        enum: [type]
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
      options: {
        type: "array",
        items: {
          type: "string"
        },
        minItems: multipleChoice ? 4 : 0,
        maxItems: multipleChoice ? 4 : 0
      },
      correctAnswerIndex: {
        type: "integer",
        minimum: multipleChoice ? 0 : -1,
        maximum: multipleChoice ? 3 : -1
      },
      matchingPairs: {
        type: "array",
        items: MATCHING_PAIR_SCHEMA,
        minItems: matching ? 2 : 0,
        maxItems: matching ? 4 : 0
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
      }
    },
    required: [
      "id",
      "type",
      "prompt",
      "answer",
      "hint",
      "options",
      "correctAnswerIndex",
      "matchingPairs",
      "tags",
      "sourceLocator"
    ],
    additionalProperties: false
  };
}

const CARD_SCHEMA = {
  anyOf: [
    cardSchema("tap_reveal"),
    cardSchema("multiple_choice"),
    cardSchema("matching"),
    cardSchema("fill_blank")
  ]
};

const DECK_OBJECT_SCHEMA = {
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
    cards: {
      type: "array",
      items: CARD_SCHEMA,
      minItems: 1,
      maxItems: 200
    }
  },
  required: [
    "title",
    "subject",
    "deckKind",
    "detectedLanguage",
    "summary",
    "cards"
  ],
  additionalProperties: false
};

export const DECK_SCHEMA = {
  type: "object",
  properties: {
    assistantMessage: {
      type: "string"
    },
    deck: DECK_OBJECT_SCHEMA
  },
  required: [
    "assistantMessage",
    "deck"
  ],
  additionalProperties: false
};

export const GENERATION_RESULT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["chat", "deck"]
    },
    assistantMessage: {
      type: "string"
    },
    deck: {
      anyOf: [
        DECK_OBJECT_SCHEMA,
        {
          type: "null"
        }
      ]
    }
  },
  required: [
    "action",
    "assistantMessage",
    "deck"
  ],
  additionalProperties: false
};

export const OUTLINE_SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string"
          },
          kind: {
            type: "string",
            enum: [
              "module",
              "chapter",
              "section",
              "front_matter",
              "back_matter",
              "other"
            ]
          },
          startPage: {
            type: "integer",
            minimum: 0
          },
          endPage: {
            type: "integer",
            minimum: 0
          },
          summary: {
            type: "string"
          }
        },
        required: ["title", "kind", "startPage", "endPage", "summary"],
        additionalProperties: false
      },
      minItems: 1,
      maxItems: 200
    }
  },
  required: ["sections"],
  additionalProperties: false
};
