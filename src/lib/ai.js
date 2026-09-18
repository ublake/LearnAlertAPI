import { PROVIDERS, DEFAULT_PROVIDER } from "../config.js";

export class AIRequestError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function providerNames() {
  return Object.keys(PROVIDERS);
}

export function isProviderConfigured(env, name) {
  const provider = PROVIDERS[name];
  return Boolean(provider && env[provider.keyVar]);
}

/**
 * The switcher. `AI_PROVIDER` is the deployed setting; `requested` is an
 * optional per-request override, only honoured when ALLOW_PROVIDER_OVERRIDE is
 * on, so a smoke test can hit the standby without redeploying.
 */
export function resolveProvider(env, requested = "") {
  const override =
    env.ALLOW_PROVIDER_OVERRIDE === "true" ? requested.trim() : "";
  const name = (override || env.AI_PROVIDER || DEFAULT_PROVIDER).trim();
  const provider = PROVIDERS[name];

  if (!provider) {
    throw new AIRequestError(
      `Unknown AI provider "${name}". Configured: ${providerNames().join(", ")}.`,
      override ? 400 : 500
    );
  }

  const apiKey = env[provider.keyVar];

  if (!apiKey) {
    throw new AIRequestError(
      `${provider.label} is selected but ${provider.keyVar} is not configured on the Worker.`,
      500
    );
  }

  return {
    name,
    label: provider.label,
    apiKey,
    model: env.AI_MODEL || provider.model,
    baseUrl: (env.AI_BASE_URL || provider.baseUrl).replace(/\/+$/, "")
  };
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

/**
 * The gateway is stateless: there is no /v1/files to upload to, so every
 * request carries the source bytes inline as a data URL.
 */
export async function encodeSourceFile(file, mimeType) {
  const type = mimeType || file.type || "application/octet-stream";
  const base64 = toBase64(await file.arrayBuffer());

  return {
    dataUrl: `data:${type};base64,${base64}`,
    filename: file.name || "upload",
    mimeType: type,
    byteSize: file.size
  };
}

export function sourceContentItem({
  dataUrl,
  filename = "upload",
  sourceKind = "file"
}) {
  if (sourceKind === "image") {
    return {
      type: "image_url",
      image_url: {
        url: dataUrl,
        detail: "auto"
      }
    };
  }

  return {
    type: "file",
    file: {
      filename,
      file_data: dataUrl
    }
  };
}

export function textContentItem(text) {
  return {
    type: "text",
    text
  };
}

export async function callStructuredOutput({
  env,
  provider,
  instructions,
  input,
  schema,
  schemaName,
  maxOutputTokens = 20_000,
  reasoningEffort = "low"
}) {
  const target = provider || resolveProvider(env);

  const response = await fetch(`${target.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${target.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: target.model,
      reasoning_effort: reasoningEffort,
      max_completion_tokens: maxOutputTokens,
      messages: [
        {
          role: "system",
          content: instructions
        },
        ...input
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema
        }
      }
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new AIRequestError(
      data?.error?.message || `${target.label} request failed.`,
      response.status,
      { provider: target.name, error: data?.error || data }
    );
  }

  const choice = data?.choices?.[0];

  if (choice?.message?.refusal) {
    throw new AIRequestError(
      choice.message.refusal,
      502,
      { finishReason: choice.finish_reason }
    );
  }

  if (choice?.finish_reason === "length") {
    throw new AIRequestError(
      "The AI response was incomplete. Try a smaller document or fewer cards.",
      502,
      { finishReason: choice.finish_reason }
    );
  }

  const outputText = choice?.message?.content;

  if (typeof outputText !== "string" || !outputText.trim()) {
    throw new AIRequestError(
      "The AI returned no structured output.",
      502,
      {
        responseId: data?.id,
        finishReason: choice?.finish_reason ?? null
      }
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new AIRequestError(
      "The AI returned invalid structured JSON.",
      502
    );
  }

  return {
    value: parsed,
    responseId: data.id,
    usage: data.usage || null,
    model: data.model || target.model,
    provider: target.name
  };
}
