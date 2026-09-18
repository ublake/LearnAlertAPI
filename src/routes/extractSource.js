import { EXTRACTION_SCHEMA } from "../schemas.js";
import { EXTRACTION_INSTRUCTIONS } from "../prompts.js";
import { EXTRACTION_OUTPUT_TOKENS } from "../config.js";
import {
  callStructuredOutput,
  encodeSourceFile,
  resolveProviderForContent,
  sourceContentItem,
  textContentItem
} from "../lib/ai.js";
import { validateExtractForm } from "../lib/validation.js";
import { json } from "../lib/http.js";

/**
 * Stable identity for a document, so re-uploading the same file can reuse an
 * existing transcription instead of paying to parse it again. Hashing the
 * bytes means a renamed file still matches.
 */
async function contentHash(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function extractSource(request, env, requestId) {
  const config = validateExtractForm(await request.formData());

  const provider = resolveProviderForContent(env, {
    hasFile: true,
    requested: request.headers.get("x-ai-provider") || ""
  });

  const buffer = await config.file.arrayBuffer();
  const hash = await contentHash(buffer);

  const encoded = await encodeSourceFile(config.file, config.mimeType);

  const ai = await callStructuredOutput({
    env,
    provider,
    instructions: EXTRACTION_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          textContentItem(
            `Transcribe this document completely. Source name: ${config.sourceName}.`
          ),
          sourceContentItem({
            dataUrl: encoded.dataUrl,
            filename: encoded.filename,
            sourceKind: config.sourceKind
          })
        ]
      }
    ],
    schema: EXTRACTION_SCHEMA,
    schemaName: "learnalert_source_extraction",
    maxOutputTokens: EXTRACTION_OUTPUT_TOKENS,
    reasoningEffort: "low"
  });

  const markdown = typeof ai.value.markdown === "string" ? ai.value.markdown : "";

  return json({
    success: true,
    requestId,
    contentHash: hash,
    source: {
      name: config.sourceName,
      kind: config.sourceKind,
      mimeType: encoded.mimeType,
      byteSize: encoded.byteSize
    },
    extraction: {
      markdown,
      pageCount: ai.value.pageCount ?? 0,
      detectedLanguage: ai.value.detectedLanguage || "",
      coverageNotes: Array.isArray(ai.value.coverageNotes)
        ? ai.value.coverageNotes
        : [],
      characterCount: markdown.length,
      // What this text will cost as a prompt from now on.
      estimatedTokens: Math.ceil(markdown.length / 4)
    },
    meta: {
      provider: ai.provider,
      model: ai.model,
      responseId: ai.responseId,
      usage: ai.usage
    }
  });
}
