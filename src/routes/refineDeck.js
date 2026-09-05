import { DECK_SCHEMA } from "../schemas.js";
import { REFINE_INSTRUCTIONS } from "../prompts.js";
import { callStructuredOutput } from "../lib/openai.js";
import { normalizeGeneratedDeck } from "../lib/deck.js";
import { validateRefineRequest } from "../lib/validation.js";
import { json } from "../lib/http.js";

export async function refineDeck(request, env, requestId) {
  const body = await request.json();
  const config = validateRefineRequest(body);

  const historyText =
    config.chatHistory.length > 0
      ? config.chatHistory
          .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
          .join("\n")
      : "No previous chat messages.";

  const sourceBlock = config.sourceText
    ? `
<source_material name="${config.sourceName || "source"}">
${config.sourceText}
</source_material>
`
    : `
<source_material>
No source material was supplied in this edit request.
Do not add new factual claims beyond the current deck.
</source_material>
`;

  const input = `
<maximum_cards>
${config.maxCards}
</maximum_cards>

<current_deck>
${JSON.stringify(config.deck)}
</current_deck>

<recent_chat_history>
${historyText}
</recent_chat_history>

<user_request>
${config.instruction}
</user_request>

${sourceBlock}
`.trim();

  const ai = await callStructuredOutput({
    env,
    instructions: REFINE_INSTRUCTIONS,
    input,
    schema: DECK_SCHEMA,
    schemaName: "learnalert_refined_deck",
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
