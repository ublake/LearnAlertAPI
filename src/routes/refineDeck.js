import { DECK_SCHEMA } from "../schemas.js";
import { REFINE_INSTRUCTIONS } from "../prompts.js";
import { outputBudget, uploadCeilingBytes, PROVIDERS, DEFAULT_DOCUMENT_PROVIDER } from "../config.js";
import {
  callStructuredOutput,
  encodeSourceFile,
  resolveProviderForContent,
  sourceContentItem,
  textContentItem
} from "../lib/ai.js";
import { normalizeGeneratedDeck } from "../lib/deck.js";
import {
  validateRefineRequest,
  validateRefineForm
} from "../lib/validation.js";
import { json } from "../lib/http.js";

export async function refineDeck(request, env, requestId) {
  const contentType = request.headers.get("content-type") || "";

  // The document provider decides the ceiling, and it is known before the
  // form is parsed because only a multipart request can carry a file.
  const documentCeiling = uploadCeilingBytes(
    PROVIDERS[env.DOCUMENT_PROVIDER || DEFAULT_DOCUMENT_PROVIDER]
  );

  const config = contentType.includes("multipart/form-data")
    ? validateRefineForm(await request.formData(), documentCeiling)
    : validateRefineRequest(await request.json());

  // Only a request that actually carries a file needs the document provider.
  const provider = resolveProviderForContent(env, {
    hasFile: Boolean(config.file),
    requested: request.headers.get("x-ai-provider") || ""
  });

  const sourceContext = config.file
    ? "<source_note>The original source is attached to this request. Use it as the factual authority and inspect its original structure/visuals when relevant.</source_note>"
    : config.sourceText
      ? `<source_material name="${config.sourceName || "source"}">\n${config.sourceText}\n</source_material>`
      : "<source_material>No source material was supplied. Do not introduce new factual claims beyond what is already supported by the current deck.</source_material>";

  // Order matters for prompt caching: the cache matches on prefix, so stable
  // content goes first and anything that changes every turn goes last. The
  // source is identical across a conversation; the deck is not.
  const contextText = `
${sourceContext}

<maximum_cards>
${config.maxCards}
</maximum_cards>

<current_deck>
${JSON.stringify(config.deck)}
</current_deck>

<user_request>
${config.instruction}
</user_request>
`.trim();

  let source = null;
  let input;

  if (config.file) {
    const encoded = await encodeSourceFile(config.file, config.mimeType);

    source = {
      kind: config.sourceKind,
      name: config.sourceName || encoded.filename,
      mimeType: encoded.mimeType,
      byteSize: encoded.byteSize
    };

    input = [
      ...config.chatHistory,
      {
        role: "user",
        content: [
          textContentItem(contextText),
          sourceContentItem({
            dataUrl: encoded.dataUrl,
            filename: encoded.filename,
            sourceKind: source.kind
          })
        ]
      }
    ];
  } else {
    input = [
      ...config.chatHistory,
      {
        role: "user",
        content: contextText
      }
    ];
  }

  const ai = await callStructuredOutput({
    env,
    provider,
    instructions: REFINE_INSTRUCTIONS,
    input,
    schema: DECK_SCHEMA,
    schemaName: "learnalert_refined_deck",
    maxOutputTokens: outputBudget(config.maxCards),
    reasoningEffort: "low"
  });

  const validIds = new Set(
    Array.isArray(config.deck.cards)
      ? config.deck.cards
          .map((card) => card?.id)
          .filter((id) => typeof id === "string" && id.trim())
          .map((id) => id.trim())
      : []
  );

  const normalized = normalizeGeneratedDeck(
    ai.value,
    config.maxCards,
    validIds
  );

  return json({
    success: true,
    requestId,
    action: "deck",
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
