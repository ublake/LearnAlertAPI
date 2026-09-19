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

export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"];

/**
 * Per-task reasoning effort. Defaults stay at the known-working "low" — this
 * exists so the tradeoff can be measured per task without a redeploy, since
 * generation needs judgment (distractors, difficulty) while outline detection
 * does not.
 *
 * Override with REASONING_GENERATION / _REFINE / _OUTLINE.
 */
const REASONING_DEFAULTS = {
  generation: "low",
  refine: "low",
  outline: "low"
};

export function reasoningEffort(task, env = {}) {
  const requested = env[`REASONING_${task.toUpperCase()}`];

  // An unknown value would be a 400 from upstream, so fall back instead.
  return REASONING_EFFORTS.includes(requested)
    ? requested
    : REASONING_DEFAULTS[task] || "low";
}

/**
 * What a call cost, in USD.
 *
 * Two sources, in order of trust:
 *
 * 1. What the provider reports. CheaperInference returns `usage.cost` on every
 *    response, which is the amount actually billed. Its rates move, and a
 *    reported figure tracks them for free — no rate card to keep in sync.
 * 2. The rate card below. OpenAI reports no cost, so its calls are estimated
 *    from published prices.
 *
 * The log records which of the two produced each number, because "exact" and
 * "our arithmetic against a table we typed in" deserve different trust.
 */

/**
 * Published prices in USD per million tokens. Long-context requests are billed
 * at a higher rate above a token threshold, so both tiers are kept.
 *
 * NOTE: the threshold is the same single-sourced 272k figure used for the
 * upload budget and is still unverified against OpenAI's pricing page. Set
 * PRICE_LONG_CONTEXT_THRESHOLD to correct it without a redeploy of this file.
 */
export const RATE_CARDS = {
  // gpt-5.6-luna, from OpenAI's pricing page.
  openai: {
    shortContext: { input: 0.2, cachedInput: 0.02, output: 1.2 },
    longContext: { input: 0.4, cachedInput: 0.04, output: 1.8 }
  },
  // Deliberately absent: CheaperInference reports real cost per request, so a
  // card here would only ever be a stale second opinion.
  cheaper_inference: null
};

export function pricing(env = {}, providerName = "openai") {
  const card = RATE_CARDS[providerName] || null;

  const override = (name) => {
    const raw = env[name];

    // An unset var and a var set to "" mean the same thing: no rate card.
    // Number("") is 0, not NaN, so without this an empty string would price
    // every call at $0 and claim the figure was real.
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "string" && raw.trim() === "") return null;

    const parsed = Number(raw);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };

  const threshold =
    override("PRICE_LONG_CONTEXT_THRESHOLD") ?? STANDARD_CONTEXT_INPUT_TOKENS;

  // Env overrides win over the card, so a price change is a var edit rather
  // than a code change. The unsuffixed names are the short-context tier,
  // which is what almost every request hits.
  const tier = (prefix, fallback) => ({
    input: override(`PRICE_${prefix}INPUT_PER_MTOK`) ?? fallback?.input ?? null,
    cachedInput:
      override(`PRICE_${prefix}CACHED_INPUT_PER_MTOK`) ??
      fallback?.cachedInput ??
      null,
    output:
      override(`PRICE_${prefix}OUTPUT_PER_MTOK`) ?? fallback?.output ?? null
  });

  return {
    provider: providerName,
    longContextThreshold: threshold,
    shortContext: tier("", card?.shortContext),
    longContext: tier("LONG_", card?.longContext)
  };
}

/**
 * Returns { usd, source } where source is "reported" (the provider told us),
 * "estimated" (our arithmetic), or null (neither was possible).
 *
 * Cached prompt tokens are included in prompt_tokens, so they are subtracted
 * out before the uncached rate is applied rather than billed twice.
 */
export function estimateCostUsd(usage, prices) {
  if (!usage) return { usd: null, source: null };

  if (typeof usage.reportedCostUsd === "number") {
    return { usd: Number(usage.reportedCostUsd.toFixed(6)), source: "reported" };
  }

  const promptTokens = Number(usage.prompt_tokens) || 0;
  const cachedTokens = Number(usage.cachedTokens) || 0;
  const outputTokens = Number(usage.completion_tokens) || 0;

  // Which tier applies is decided by the prompt size, the same quantity the
  // provider bills against.
  const tier =
    promptTokens > prices.longContextThreshold
      ? prices.longContext
      : prices.shortContext;

  if (!tier || tier.input === null || tier.output === null) {
    return { usd: null, source: null };
  }

  const billedCached = Math.min(cachedTokens, promptTokens);
  const billedFresh = promptTokens - billedCached;

  // An unset cached rate falls back to the full input rate, which overstates
  // rather than understates the bill.
  const cachedRate = tier.cachedInput === null ? tier.input : tier.cachedInput;

  const cost =
    (billedFresh * tier.input +
      billedCached * cachedRate +
      outputTokens * tier.output) /
    1_000_000;

  return { usd: Number(cost.toFixed(6)), source: "estimated" };
}

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
