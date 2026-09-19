import { OUTLINE_SCHEMA } from "../schemas.js";
import { OUTLINE_INSTRUCTIONS } from "../prompts.js";
import { OUTLINE } from "../config.js";
import {
  callStructuredOutput,
  resolveProviderForContent
} from "../lib/ai.js";
import { validateOutlineRequest } from "../lib/validation.js";
import { json } from "../lib/http.js";

/**
 * The model can misnumber pages, overlap sections, or leave gaps. Clamp and
 * repair rather than trust, so the app always gets selectable ranges.
 */
function normalizeSections(sections, lastPage) {
  if (!Array.isArray(sections)) return [];

  const cleaned = sections
    .map((section) => {
      const start = Math.max(0, Math.min(section?.startPage ?? 0, lastPage));
      const end = Math.max(start, Math.min(section?.endPage ?? start, lastPage));

      return {
        title: String(section?.title ?? "").trim() || "Untitled section",
        kind: section?.kind ?? "other",
        startPage: start,
        endPage: end,
        pageCount: end - start + 1,
        summary: String(section?.summary ?? "").trim()
      };
    })
    .sort((a, b) => a.startPage - b.startPage);

  // Trim overlaps so page ranges stay disjoint and selectable.
  const disjoint = [];

  for (const section of cleaned) {
    const previous = disjoint[disjoint.length - 1];

    if (previous && section.startPage <= previous.endPage) {
      section.startPage = previous.endPage + 1;
    }

    if (section.startPage > section.endPage) continue;

    section.pageCount = section.endPage - section.startPage + 1;
    disjoint.push(section);
  }

  return disjoint;
}

export async function outlineSource(request, env, requestId) {
  const config = validateOutlineRequest(await request.json());

  // Snippets are text, so this takes the cheap provider.
  const provider = resolveProviderForContent(env, {
    hasFile: false,
    requested: request.headers.get("x-ai-provider") || ""
  });

  const lastPage = config.pages[config.pages.length - 1].index;

  const pageList = config.pages
    .map((page) => `[p${page.index}] ${page.snippet || "(no text)"}`)
    .join("\n");

  const ai = await callStructuredOutput({
    env,
    provider,
    instructions: OUTLINE_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: `Document: ${config.sourceName}\nPages: ${config.pages.length} (indices ${config.pages[0].index}-${lastPage})\n\n${pageList}`
      }
    ],
    schema: OUTLINE_SCHEMA,
    schemaName: "learnalert_source_outline",
    maxOutputTokens: OUTLINE.OUTPUT_TOKENS,
    reasoningEffort: "low"
  });

  const sections = normalizeSections(ai.value.sections, lastPage);

  return json({
    success: true,
    requestId,
    sourceName: config.sourceName,
    pageCount: config.pages.length,
    sections,
    meta: {
      provider: ai.provider,
      model: ai.model,
      responseId: ai.responseId,
      usage: ai.usage
    }
  });
}
