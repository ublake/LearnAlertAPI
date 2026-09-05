import { DECK_SCHEMA } from "../schemas.js";
import { REFINE_INSTRUCTIONS } from "../prompts.js";
import {
  callStructuredOutput,
  sourceContentItem
} from "../lib/openai.js";
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

  const sourceContext = config.sourceId
    ? "<source_note>The original uploaded source is attached to this request. Use it as the factual authority and inspect its original structure/visuals when relevant.</source_note>"
    : config.sourceText
      ? `<source_material name="${config.sourceName || "source"}">\n${config.sourceText}\n</source_material>`
      : "<source_material>No source material was supplied. Do not introduce new factual claims beyond what is already supported by the current deck.</source_material>";

  const contextText = `
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

${sourceContext}
`.trim();

  let input;

  if (config.sourceId) {
    input = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: contextText
          },
          sourceContentItem({
            sourceId: config.sourceId,
            sourceKind: config.sourceKind
          })
        ]
      }
    ];
  } else {
    input = contextText;
  }

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
    ...(config.sourceId
      ? {
          sourceId: config.sourceId,
          sourceKind: config.sourceKind,
          source: {
            id: config.sourceId,
            kind: config.sourceKind,
            name: config.sourceName || ""
          }
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
