import { GENERATION_RESULT_SCHEMA } from "../schemas.js";
import { GENERATION_INSTRUCTIONS } from "../prompts.js";
import {
  CARD_TYPES,
  outputBudget,
  uploadCeilingBytes,
  reasoningEffort
} from "../config.js";
import {
  callStructuredOutput,
  encodeSourceFile,
  resolveProviderForContent,
  sourceContentItem,
  textContentItem
} from "../lib/ai.js";
import { normalizeGenerationResult } from "../lib/deck.js";
import {
  validateGenerateRequest,
  validateGenerateForm
} from "../lib/validation.js";
import { json } from "../lib/http.js";
import { recordAttempt } from "../lib/callLog.js";

function buildPreferences(config) {
  return {
    maxCards: config.maxCards,
    mode: config.mode,
    difficulty: config.difficulty,
    languageDirection: config.languageDirection,
    preferredCardTypes:
      config.preferredCardTypes.length > 0
        ? config.preferredCardTypes
        : [...CARD_TYPES],
    userInstruction: config.userInstruction || "No additional instruction.",
    sourceName: config.sourceName || "Untitled source"
  };
}

export async function generateDeck(request, env, requestId, call = null) {
  const contentType = request.headers.get("content-type") || "";
  const isUpload = contentType.includes("multipart/form-data");

  // A request carrying a document needs a provider that parses documents.
  const provider = resolveProviderForContent(env, {
    hasFile: isUpload,
    requested: request.headers.get("x-ai-provider") || ""
  });

  let config;
  let source = null;
  let sourceMessage;

  if (isUpload) {
    const formData = await request.formData();
    config = validateGenerateForm(formData, uploadCeilingBytes(provider));

    const encoded = await encodeSourceFile(config.file, config.mimeType);

    source = {
      kind: config.sourceKind,
      name: config.sourceName,
      mimeType: encoded.mimeType,
      byteSize: encoded.byteSize
    };

    sourceMessage = {
      role: "user",
      content: [
        textContentItem(
          "Analyze the attached original source directly. Preserve and use meaningful layout, tables, columns, diagrams, labels, and visual relationships when they affect the study content."
        ),
        sourceContentItem({
          dataUrl: encoded.dataUrl,
          filename: encoded.filename,
          sourceKind: source.kind
        })
      ]
    };
  } else {
    const body = await request.json();
    config = validateGenerateRequest(body);

    sourceMessage = {
      role: "user",
      content: `<source_material>\n${config.text}\n</source_material>`
    };
  }

  // Order matters for prompt caching: the cache matches on an exact prefix, so
  // the source goes first and stays byte-identical across a session's turns,
  // while the history grows behind it. Preferences change per call, so they go
  // last — which also puts the instructions closest to the reply.
  const input = [
    sourceMessage,
    ...config.chatHistory,
    {
      role: "user",
      content: `<generation_preferences>\n${JSON.stringify(
        buildPreferences(config),
        null,
        2
      )}\n</generation_preferences>`
    }
  ];

  recordAttempt(call, {
    sourceType: source ? source.kind : "text"
  });

  const ai = await callStructuredOutput({
    env,
    provider,
    instructions: GENERATION_INSTRUCTIONS,
    input,
    schema: GENERATION_RESULT_SCHEMA,
    schemaName: "learnalert_generation_result",
    maxOutputTokens: outputBudget(config.maxCards),
    reasoningEffort: reasoningEffort("generation", env)
  });

  recordAttempt(call, {
    provider: ai.provider,
    model: ai.model,
    usage: ai.usage
  });

  const normalized = normalizeGenerationResult(
    ai.value,
    config.maxCards
  );

  return json({
    success: true,
    requestId,
    ...(source
      ? {
          sourceKind: source.kind,
          source
        }
      : {}),
    ...normalized,
    meta: {
      provider: ai.provider,
      model: ai.model,
      responseId: ai.responseId,
      usage: ai.usage
    }
  });
}
