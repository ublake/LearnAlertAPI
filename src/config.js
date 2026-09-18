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

/**
 * Documents go to whoever actually parses them into pages and text rather than
 * tokenizing base64 as prose. Text goes to whoever is cheapest per token.
 */
export const DEFAULT_DOCUMENT_PROVIDER = "openai";

/**
 * Inlined files are billed and counted as tokens, so the upload ceiling is a
 * function of the context window, not of what a phone can send.
 *
 * Base64 expands bytes by 4/3 and tokenizes at roughly 4 chars per token, so
 * one token costs about three source bytes. A 20 MB upload would be ~7M
 * tokens: 17x over the window. These numbers keep a request inside it.
 */
export const CONTEXT_WINDOW_TOKENS = 400_000;
export const BYTES_PER_TOKEN = 3;

// Room reserved for the system prompt, schema, deck JSON, and the reply.
export const RESERVED_TOKENS = 80_000;

export const MAX_SOURCE_TOKENS = CONTEXT_WINDOW_TOKENS - RESERVED_TOKENS;

export const LIMITS = {
  MAX_CARDS: 200,
  DEFAULT_MAX_CARDS: 50,
  MAX_SOURCE_CHARS: 300_000,
  MAX_USER_INSTRUCTION_CHARS: 2_000,
  MAX_CHAT_MESSAGES: 12,
  MAX_CHAT_MESSAGE_CHARS: 1_500,
  MAX_UPLOAD_BYTES: MAX_SOURCE_TOKENS * BYTES_PER_TOKEN
};

/**
 * A natively parsed document costs tokens per page, not per byte, so the
 * extraction path can accept far more than the inline path's byte budget.
 */
export const MAX_EXTRACT_BYTES = 8 * 1024 * 1024;

// Transcription is long by design; give it most of the output window.
export const EXTRACTION_OUTPUT_TOKENS = 64_000;

export function estimateFileTokens(byteSize) {
  return Math.ceil(byteSize / BYTES_PER_TOKEN);
}

/**
 * Asking for 24k output while generating 12 cards wastes budget; asking for it
 * while generating 200 guarantees truncation. Scale it to the deck.
 */
export function outputBudget(maxCards) {
  const budget = 4_000 + maxCards * 300;
  return Math.min(Math.max(budget, 8_000), 64_000);
}

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
