import { apiError, json, optionsResponse } from "./lib/http.js";
import { ValidationError } from "./lib/validation.js";
import { DeckError } from "./lib/deck.js";
import {
  AIRequestError,
  isProviderConfigured,
  providerNames
} from "./lib/ai.js";
import { DEFAULT_PROVIDER, DEFAULT_DOCUMENT_PROVIDER } from "./config.js";
import { recordError, isDebugAuthorized } from "./lib/errorLog.js";
import { errorsPage, isErrorsPageAllowed } from "./routes/errorsPage.js";
import { extractSource } from "./routes/extractSource.js";
import { generateDeck } from "./routes/generateDeck.js";
import { refineDeck } from "./routes/refineDeck.js";
import { legacyQuiz } from "./routes/legacyQuiz.js";

function classify(error) {
  if (error instanceof ValidationError) {
    return {
      code: "VALIDATION_ERROR",
      message: error.message,
      status: 400,
      details: error.details || null
    };
  }

  if (error instanceof AIRequestError) {
    return {
      code: "AI_REQUEST_FAILED",
      message: error.message,
      status:
        error.status >= 400 && error.status < 600 ? error.status : 502,
      details: error.details || null
    };
  }

  // Unusable model output is an upstream problem, not a server fault.
  if (error instanceof DeckError) {
    return {
      code: "AI_INVALID_OUTPUT",
      message: error.message,
      status: 502,
      details: null
    };
  }

  if (error instanceof SyntaxError) {
    return {
      code: "INVALID_JSON",
      message: "Request body must be valid JSON.",
      status: 400,
      details: null
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: "Something went wrong while processing the request.",
    status: 500,
    // The app gets a generic message; the log keeps what actually happened.
    details: { name: error?.name, message: error?.message }
  };
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return optionsResponse();
    }

    if (request.method === "GET" && url.pathname === "/errors") {
      if (!isErrorsPageAllowed(request, env)) {
        return apiError("NOT_FOUND", "Endpoint not found.", 404, requestId);
      }

      return errorsPage(request);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "LearnAlert API",
        version: "1.1.0",
        ai: {
          active: env.AI_PROVIDER || DEFAULT_PROVIDER,
          documents: env.DOCUMENT_PROVIDER || DEFAULT_DOCUMENT_PROVIDER,
          overrideAllowed: env.ALLOW_PROVIDER_OVERRIDE === "true",
          // Which providers actually have a key, so a standby that was never
          // given one does not look ready.
          configured: providerNames().filter((name) =>
            isProviderConfigured(env, name)
          )
        },
        endpoints: [
          "POST /v1/sources/extract",
          "POST /v1/decks/generate",
          "POST /v1/decks/refine",
          "POST /generate-quiz"
        ]
      });
    }

    try {
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sources/extract"
      ) {
        return await extractSource(request, env, requestId);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/decks/generate"
      ) {
        return await generateDeck(request, env, requestId);
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/decks/refine"
      ) {
        return await refineDeck(request, env, requestId);
      }

      // Keeps your current iOS/test integration working while you migrate.
      if (
        request.method === "POST" &&
        url.pathname === "/generate-quiz"
      ) {
        return await legacyQuiz(request, env, requestId);
      }

      return apiError(
        "NOT_FOUND",
        "Endpoint not found.",
        404,
        requestId
      );
    } catch (error) {
      console.error(`[${requestId}]`, error);

      const { code, message, status, details } = classify(error);

      // Details stay out of the app's response, but the debug log keeps them.
      if (details) {
        console.error(`[${requestId}] details:`, details);
      }

      recordError({
        requestId,
        code,
        message,
        status,
        details,
        method: request.method,
        path: url.pathname
      });

      // An authorized caller gets the details in the response itself. The
      // in-memory log lives in one isolate, so a phone error is usually
      // invisible to a browser hitting a different colo.
      return apiError(
        code,
        message,
        status,
        requestId,
        isDebugAuthorized(request, env) ? details : null
      );
    }
  }
};
