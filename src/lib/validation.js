import {
  LIMITS,
  CARD_TYPES,
  MODES,
  DIFFICULTIES,
  LANGUAGE_DIRECTIONS,
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_EXTRACT_BYTES,
  estimateFileTokens
} from "../config.js";

export function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

export function optionalString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

export function requiredString(value, fieldName, maxLength = Infinity) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`${fieldName} is required.`);
  }

  const trimmed = value.trim();

  if (trimmed.length > maxLength) {
    throw new ValidationError(
      `${fieldName} is too long: ${trimmed.length.toLocaleString()} characters, ` +
        `maximum is ${maxLength.toLocaleString()}.`,
      {
        field: fieldName,
        received: trimmed.length,
        maximum: maxLength,
        // Enough to tell a user's message from a pasted transcript, without
        // putting the whole payload in the debug log.
        startsWith: trimmed.slice(0, 120),
        endsWith: trimmed.slice(-120)
      }
    );
  }

  return trimmed;
}

export function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export function stringArray(value, allowed = null) {
  if (!Array.isArray(value)) return [];

  const values = value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!allowed) return [...new Set(values)];

  return [...new Set(values.filter((item) => allowed.includes(item)))];
}

function parseFormStringArray(value) {
  if (typeof value !== "string" || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to comma-separated format.
  }

  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeChatHistory(value) {
  const rawHistory = Array.isArray(value)
    ? value.slice(-LIMITS.MAX_CHAT_MESSAGES)
    : [];

  return rawHistory
    .filter(
      (message) =>
        message &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.content === "string"
    )
    .map((message) => ({
      role: message.role,
      content: message.content
        .trim()
        .slice(0, LIMITS.MAX_CHAT_MESSAGE_CHARS)
    }))
    .filter((message) => message.content.length > 0);
}

function parseFormChatHistory(value) {
  if (typeof value !== "string" || !value.trim()) return [];

  let parsed;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ValidationError("chatHistory must be a valid JSON array.");
  }

  if (!Array.isArray(parsed)) {
    throw new ValidationError("chatHistory must be a valid JSON array.");
  }

  return normalizeChatHistory(parsed);
}

function commonGenerateOptions(body) {
  const maxCards = clampInteger(
    body?.maxCards,
    LIMITS.DEFAULT_MAX_CARDS,
    1,
    LIMITS.MAX_CARDS
  );

  return {
    maxCards,
    mode: enumValue(body?.mode, MODES, "auto"),
    difficulty: enumValue(body?.difficulty, DIFFICULTIES, "auto"),
    languageDirection: enumValue(
      body?.languageDirection,
      LANGUAGE_DIRECTIONS,
      "auto"
    ),
    preferredCardTypes: stringArray(
      body?.preferredCardTypes,
      CARD_TYPES
    ),
    chatHistory: normalizeChatHistory(body?.chatHistory),
    userInstruction: optionalString(
      body?.userInstruction,
      LIMITS.MAX_USER_INSTRUCTION_CHARS
    ),
    sourceName: optionalString(body?.sourceName, 200)
  };
}

export function validateGenerateRequest(body) {
  const text = requiredString(
    body?.text,
    "text",
    LIMITS.MAX_SOURCE_CHARS
  );

  return {
    text,
    ...commonGenerateOptions(body)
  };
}

function validateUploadedFile(file, maxBytes = LIMITS.MAX_UPLOAD_BYTES) {
  if (file.size <= 0) {
    throw new ValidationError("The uploaded file is empty.");
  }

  // Reject before encoding: an oversized file costs real money to discover
  // upstream, and the request cannot fit the context window anyway.
  if (file.size > maxBytes) {
    const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MB`;

    throw new ValidationError(
      `This file is ${mb(file.size)}, over this endpoint's ${mb(maxBytes)} limit. ` +
        "Split it into sections, or send a shorter excerpt.",
      { fileBytes: file.size, estimatedTokens: estimateFileTokens(file.size) }
    );
  }

  const filename = file.name || "upload";
  const extension = filename.includes(".")
    ? filename.split(".").pop().toLowerCase()
    : "";

  if (!ALLOWED_UPLOAD_EXTENSIONS.includes(extension)) {
    throw new ValidationError(
      `Unsupported file type. Supported: ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")}.`
    );
  }

  const mimeType = file.type || "application/octet-stream";

  return {
    filename,
    mimeType,
    sourceKind: mimeType.startsWith("image/") ? "image" : "file"
  };
}

export function validateGenerateForm(formData) {
  const file = formData.get("file");

  if (!(file instanceof File)) {
    throw new ValidationError("file is required for multipart upload.");
  }

  const { filename, mimeType, sourceKind } = validateUploadedFile(file);

  const preferredCardTypes = parseFormStringArray(
    formData.get("preferredCardTypes")
  );
  const chatHistory = parseFormChatHistory(
    formData.get("chatHistory")
  );

  const options = commonGenerateOptions({
    maxCards: formData.get("maxCards"),
    mode: formData.get("mode"),
    difficulty: formData.get("difficulty"),
    languageDirection: formData.get("languageDirection"),
    preferredCardTypes,
    chatHistory,
    userInstruction: formData.get("userInstruction"),
    sourceName: formData.get("sourceName") || filename
  });

  return {
    file,
    mimeType,
    sourceKind,
    ...options,
    sourceName: options.sourceName || filename
  };
}

export function validateRefineRequest(body) {
  if (!body || typeof body !== "object") {
    throw new ValidationError("Request body must be a JSON object.");
  }

  if (!body.deck || typeof body.deck !== "object") {
    throw new ValidationError("deck is required.");
  }

  const instruction = requiredString(
    body.instruction,
    "instruction",
    LIMITS.MAX_USER_INSTRUCTION_CHARS
  );

  const sourceText = optionalString(
    body.sourceText,
    LIMITS.MAX_SOURCE_CHARS
  );

  const sourceKind = enumValue(
    body.sourceKind || body?.source?.kind,
    ["file", "image"],
    "file"
  );

  const sourceName = optionalString(
    body.sourceName || body?.source?.name,
    200
  );

  const maxCards = clampInteger(
    body.maxCards,
    LIMITS.DEFAULT_MAX_CARDS,
    1,
    LIMITS.MAX_CARDS
  );

  return {
    deck: body.deck,
    instruction,
    sourceText,
    sourceKind,
    sourceName,
    maxCards,
    file: null,
    mimeType: "",
    chatHistory: normalizeChatHistory(body.chatHistory)
  };
}

/**
 * Refining against the original document means re-sending it: the gateway is
 * stateless, so there is no server-side copy to point at.
 */
export function validateRefineForm(formData) {
  const rawDeck = formData.get("deck");

  if (typeof rawDeck !== "string" || !rawDeck.trim()) {
    throw new ValidationError("deck is required.");
  }

  let deck;

  try {
    deck = JSON.parse(rawDeck);
  } catch {
    throw new ValidationError("deck must be a valid JSON object.");
  }

  const config = validateRefineRequest({
    deck,
    instruction: formData.get("instruction"),
    sourceText: formData.get("sourceText"),
    sourceName: formData.get("sourceName"),
    maxCards: formData.get("maxCards"),
    chatHistory: parseFormChatHistory(formData.get("chatHistory"))
  });

  const file = formData.get("file");

  if (!(file instanceof File)) {
    return config;
  }

  const { filename, mimeType, sourceKind } = validateUploadedFile(file);

  return {
    ...config,
    file,
    mimeType,
    sourceKind,
    sourceName: config.sourceName || filename
  };
}

export class ValidationError extends Error {
  constructor(message, details = null) {
    super(message);
    this.details = details;
  }
}

/**
 * Extraction routes to a provider that parses documents natively, so it is
 * bounded by file size rather than by the inline token budget.
 */
export function validateExtractForm(formData) {
  const file = formData.get("file");

  if (!(file instanceof File)) {
    throw new ValidationError("file is required for extraction.");
  }

  const { filename, mimeType, sourceKind } = validateUploadedFile(
    file,
    MAX_EXTRACT_BYTES
  );

  return {
    file,
    mimeType,
    sourceKind,
    sourceName: optionalString(formData.get("sourceName"), 200) || filename
  };
}
