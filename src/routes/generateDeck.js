import { DECK_SCHEMA } from "../schemas.js";
import { GENERATION_INSTRUCTIONS } from "../prompts.js";
import { callStructuredOutput } from "../lib/openai.js";
import { normalizeGeneratedDeck } from "../lib/deck.js";
import { validateGenerateRequest } from "../lib/validation.js";
import { json } from "../lib/http.js";

export async function generateDeck(request, env, requestId) {
  const body = await request.json();
  const config = validateGenerateRequest(body);

  const preferences = {
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

  const input = `
<generation_preferences>
${JSON.stringify(preferences, null, 2)}
</generation_preferences>

<source_material>
${config.text}
</source_material>
`.trim();

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
    ...normalized,
    meta: {
      model: ai.model,
      openAIResponseId: ai.responseId,
      usage: ai.usage
    }
  });
}
