import { DECK_SCHEMA } from "../schemas.js";
import { REFINE_INSTRUCTIONS } from "../prompts.js";
import { outputBudget, uploadCeilingBytes, PROVIDERS, DEFAULT_DOCUMENT_PROVIDER, reasoningEffort } from "../config.js";
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
import { recordAttempt } from "../lib/callLog.js";

export async function refineDeck(request, env, requestId, call = null) {
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

  // Order matters for prompt caching: the cache matches on an exact prefix, so
  // the source — byte-identical on every turn of a session — gets its own
  // leading message, ahead of the history that grows each turn. The deck and
  // the request change every turn, so they go last and are never cacheable.
  const turnText = `
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
  let sourceMessage;

  if (config.file) {
    const encoded = await encodeSourceFile(config.file, config.mimeType);

    source = {
      kind: config.sourceKind,
      name: config.sourceName || encoded.filename,
      mimeType: encoded.mimeType,
      byteSize: encoded.byteSize
    };

    sourceMessage = {
      role: "user",
      content: [
        textContentItem(sourceContext),
        sourceContentItem({
          dataUrl: encoded.dataUrl,
          filename: encoded.filename,
          sourceKind: source.kind
        })
      ]
    };
  } else {
    sourceMessage = {
      role: "user",
      content: sourceContext
    };
  }

  const input = [
    sourceMessage,
    ...config.chatHistory,
    {
      role: "user",
      content: turnText
    }
  ];

  recordAttempt(call, {
    sourceType: source ? source.kind : config.sourceText ? "text" : "none"
  });

  const ai = await callStructuredOutput({
    env,
    provider,
    instructions: REFINE_INSTRUCTIONS,
    input,
    schema: DECK_SCHEMA,
    schemaName: "learnalert_refined_deck",
    maxOutputTokens: outputBudget(config.maxCards),
    reasoningEffort: reasoningEffort("refine", env)
  });

  recordAttempt(call, {
    provider: ai.provider,
    model: ai.model,
    usage: ai.usage
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
