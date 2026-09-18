export const MODEL = "gpt-5.6-luna";

/**
 * Both providers speak the same chat-completions dialect, so switching is a
 * matter of host, key, and model. Only the primary is expected to be cheaper;
 * `openai` is the standby.
 */
export const PROVIDERS = {
  cheaper_inference: {
    label: "Cheaper Inference",
    baseUrl: "https://api.cheaperinference.com/v1",
    keyVar: "CHEAPER_INFERENCE_API_KEY",
    model: MODEL
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyVar: "OPENAI_API_KEY",
    model: MODEL
  }
};

export const DEFAULT_PROVIDER = "cheaper_inference";

export const LIMITS = {
  MAX_CARDS: 50,
  DEFAULT_MAX_CARDS: 50,
  MAX_SOURCE_CHARS: 300_000,
  MAX_USER_INSTRUCTION_CHARS: 2_000,
  MAX_CHAT_MESSAGES: 12,
  MAX_CHAT_MESSAGE_CHARS: 1_500,
  MAX_UPLOAD_BYTES: 20 * 1024 * 1024
};

export const CARD_TYPES = [
  "tap_reveal",
  "multiple_choice",
  "matching",
  "fill_blank"
];

export const MODES = [
  "auto",
  "language",
  "exam",
  "mixed"
];

export const DIFFICULTIES = [
  "auto",
  "easy",
  "medium",
  "hard"
];

export const LANGUAGE_DIRECTIONS = [
  "auto",
  "target_to_english",
  "english_to_target",
  "mixed"
];

export const ALLOWED_UPLOAD_EXTENSIONS = [
  "pdf",
  "txt",
  "md",
  "rtf",
  "docx",
  "pptx",
  "png",
  "jpg",
  "jpeg",
  "webp"
];
