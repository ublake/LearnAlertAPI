import { MODEL, LIMITS } from "../config.js";

export class OpenAIRequestError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function extractOutputText(data) {
  const parts = [];

  for (const item of data?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }

  return parts.join("");
}

export async function uploadSourceFile(env, file) {
  if (!env.OPENAI_API_KEY) {
    throw new OpenAIRequestError(
      "OPENAI_API_KEY is not configured on the Worker.",
      500
    );
  }

  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", file, file.name || "upload");
  form.append("expires_after[anchor]", "created_at");
  form.append(
    "expires_after[seconds]",
    String(LIMITS.SOURCE_EXPIRATION_SECONDS)
  );

  const response = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    throw new OpenAIRequestError(
      data?.error?.message || "Failed to upload source file to OpenAI.",
      response.status,
      data?.error || data
    );
  }

  return data;
}

export function sourceContentItem({ sourceId, sourceKind = "file" }) {
  if (sourceKind === "image") {
    return {
      type: "input_image",
      file_id: sourceId,
      detail: "auto"
    };
  }

  return {
    type: "input_file",
    file_id: sourceId
  };
}

export async function callStructuredOutput({
  env,
  instructions,
  input,
  schema,
  schemaName,
  maxOutputTokens = 20_000,
  reasoningEffort = "low"
}) {
  if (!env.OPENAI_API_KEY) {
    throw new OpenAIRequestError(
      "OPENAI_API_KEY is not configured on the Worker.",
      500
    );
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      reasoning: {
        effort: reasoningEffort
      },
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema
        }
      }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new OpenAIRequestError(
      data?.error?.message || "OpenAI request failed.",
      response.status,
      data?.error || data
    );
  }

  if (data.status === "failed") {
    throw new OpenAIRequestError(
      data?.error?.message || "OpenAI response failed.",
      502,
      data?.error || data
    );
  }

  if (data.status === "incomplete") {
    throw new OpenAIRequestError(
      "The AI response was incomplete. Try a smaller document or fewer cards.",
      502,
      data?.incomplete_details || null
    );
  }

  const outputText = extractOutputText(data);

  if (!outputText) {
    throw new OpenAIRequestError(
      "OpenAI returned no structured output.",
      502,
      {
        responseId: data?.id,
        status: data?.status
      }
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new OpenAIRequestError(
      "OpenAI returned invalid structured JSON.",
      502
    );
  }

  return {
    value: parsed,
    responseId: data.id,
    usage: data.usage || null,
    model: data.model || MODEL
  };
}
