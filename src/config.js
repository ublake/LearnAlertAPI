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
    model: MODEL,
    // Unconfirmed that it parses `file` parts; assume base64 is billed as
    // text until measured, which makes bytes the binding constraint.
    parsesDocuments: false
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyVar: "OPENAI_API_KEY",
    model: MODEL,
    parsesDocuments: true
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
// Documented capacity for gpt-5.6-luna: ~1.05M total, 922k in, 128k out.
export const CONTEXT_WINDOW_TOKENS = 1_050_000;
export const MAX_INPUT_TOKENS = 922_000;
export const MAX_OUTPUT_TOKENS = 128_000;

export const BYTES_PER_TOKEN = 3;

/**
 * Capacity is not the binding constraint — cost is. Long-context requests are
 * billed at a premium above a threshold, so the default budget targets that
 * cliff rather than the ceiling.
 *
 * NOTE: the 272k figure is single-sourced and unverified against OpenAI's
 * pricing page. It is used as a soft budget, never as a hard capacity claim.
 */
export const STANDARD_CONTEXT_INPUT_TOKENS = 272_000;

// Room reserved for the system prompt, schema, deck JSON, and the reply.
export const RESERVED_TOKENS = 80_000;

export const MAX_SOURCE_TOKENS =
  STANDARD_CONTEXT_INPUT_TOKENS - RESERVED_TOKENS;

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
export const EXTRACTION_OUTPUT_TOKENS = 96_000;

/**
 * A parser that reads the document costs tokens per page, so bytes stop being
 * the binding constraint and a generous byte ceiling is fine. A provider that
 * tokenizes base64 as prose costs ~1 token per 3 bytes, which the context
 * window caps hard.
 */
export function uploadCeilingBytes(provider) {
  return provider?.parsesDocuments
    ? MAX_EXTRACT_BYTES
    : LIMITS.MAX_UPLOAD_BYTES;
}

/**
 * Outline detection reads only the opening lines of each page, which is why it
 * is ~0.1% the cost of sending the document itself.
 */
export const OUTLINE = {
  MAX_PAGES: 1_000,
  MAX_SNIPPET_CHARS: 240,
  OUTPUT_TOKENS: 16_000
};

export function estimateFileTokens(byteSize) {
  return Math.ceil(byteSize / BYTES_PER_TOKEN);
}

/**
 * Asking for 24k output while generating 12 cards wastes budget; asking for it
 * while generating 200 guarantees truncation. Scale it to the deck.
 */
export function outputBudget(maxCards) {
  const budget = 4_000 + maxCards * 300;
  return Math.min(Math.max(budget, 8_000), MAX_OUTPUT_TOKENS);
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
