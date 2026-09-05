import { DECK_SCHEMA } from "../schemas.js";
import { GENERATION_INSTRUCTIONS } from "../prompts.js";
import {
  callStructuredOutput,
  uploadSourceFile,
  sourceContentItem
} from "../lib/openai.js";
import { normalizeGeneratedDeck } from "../lib/deck.js";
import {
  validateGenerateRequest,
  validateGenerateForm
} from "../lib/validation.js";
import { json } from "../lib/http.js";

function buildPreferences(config) {
  return {
    maxCards: config.maxCards,
    mode: config.mode,
    difficulty: config.difficulty,
    languageDirection: config.languageDirection,
    preferredCardTypes:
      config.preferredCardTypes.length > 0
        ? config.preferredCardTypes
        : ["tap_reveal", "multiple_choice"],
    userInstruction: config.userInstruction || "No additional instruction.",
    sourceName: config.sourceName || "Untitled source"
  };
}

export async function generateDeck(request, env, requestId) {
  const contentType = request.headers.get("content-type") || "";

  let config;
  let source = null;
  let input;

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    config = validateGenerateForm(formData);

    const uploaded = await uploadSourceFile(env, config.file);

    source = {
      id: uploaded.id,
      kind: config.sourceKind,
      name: config.sourceName,
      mimeType: config.mimeType,
      expiresAt: uploaded.expires_at || null
    };

    input = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Generation preferences:\n${JSON.stringify(
              buildPreferences(config),
              null,
              2
            )}\n\nAnalyze the attached original source directly. Preserve and use meaningful layout, tables, columns, diagrams, labels, and visual relationships when they affect the study content.`
          },
          sourceContentItem({
            sourceId: source.id,
            sourceKind: source.kind
          })
        ]
      }
    ];
  } else {
    const body = await request.json();
    config = validateGenerateRequest(body);

    input = `
<generation_preferences>
${JSON.stringify(buildPreferences(config), null, 2)}
</generation_preferences>

<source_material>
${config.text}
</source_material>
`.trim();
  }

  const ai = await callStructuredOutput({
    env,
    instructions: GENERATION_INSTRUCTIONS,
    input,
    schema: DECK_SCHEMA,
    schemaName: "learnalert_deck",
    maxOutputTokens: 24_000,
    reasoningEffort: "low"
  });

  const normalized = normalizeGeneratedDeck(
    ai.value,
    config.maxCards
  );

  return json({
    success: true,
    requestId,
    ...(source
      ? {
          sourceId: source.id,
          sourceKind: source.kind,
          source
        }
      : {}),
    ...normalized,
    meta: {
      model: ai.model,
      openAIResponseId: ai.responseId,
      usage: ai.usage
    }
  });
}
