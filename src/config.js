export const MODEL = "gpt-5.6-luna";

export const LIMITS = {
  MAX_CARDS: 50,
  DEFAULT_MAX_CARDS: 50,
  MAX_SOURCE_CHARS: 300_000,
  MAX_USER_INSTRUCTION_CHARS: 2_000,
  MAX_CHAT_MESSAGES: 12,
  MAX_CHAT_MESSAGE_CHARS: 1_500,
  MAX_UPLOAD_BYTES: 20 * 1024 * 1024,
  SOURCE_EXPIRATION_SECONDS: 24 * 60 * 60
};

export const CARD_TYPES = [
  "tap_reveal",
  "multiple_choice"
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
