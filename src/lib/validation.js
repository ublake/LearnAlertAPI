import {
  LIMITS,
  CARD_TYPES,
  MODES,
  DIFFICULTIES,
  LANGUAGE_DIRECTIONS,
  ALLOWED_UPLOAD_EXTENSIONS
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
      `${fieldName} is too long. Maximum length is ${maxLength.toLocaleString()} characters.`
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

export function validateGenerateForm(formData) {
  const file = formData.get("file");

  if (!(file instanceof File)) {
    throw new ValidationError("file is required for multipart upload.");
  }

  if (file.size <= 0) {
    throw new ValidationError("The uploaded file is empty.");
  }

  if (file.size > LIMITS.MAX_UPLOAD_BYTES) {
    throw new ValidationError("The uploaded file is too large. Maximum size is 20 MB.");
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

  const preferredCardTypes = parseFormStringArray(
    formData.get("preferredCardTypes")
  );

  const options = commonGenerateOptions({
    maxCards: formData.get("maxCards"),
    mode: formData.get("mode"),
    difficulty: formData.get("difficulty"),
    languageDirection: formData.get("languageDirection"),
    preferredCardTypes,
    userInstruction: formData.get("userInstruction"),
    sourceName: formData.get("sourceName") || filename
  });

  const mimeType = file.type || "application/octet-stream";
  const sourceKind = mimeType.startsWith("image/") ? "image" : "file";

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

  const sourceId = optionalString(
    body.sourceId || body?.source?.id,
    200
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

  const rawHistory = Array.isArray(body.chatHistory)
    ? body.chatHistory.slice(-LIMITS.MAX_CHAT_MESSAGES)
    : [];

  const chatHistory = rawHistory
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

  return {
    deck: body.deck,
    instruction,
    sourceText,
    sourceId,
    sourceKind,
    sourceName,
    maxCards,
    chatHistory
  };
}

export class ValidationError extends Error {}
