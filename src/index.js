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
import { isAuthorized, authRequired } from "./lib/auth.js";
import { errorsPage, isErrorsPageAllowed } from "./routes/errorsPage.js";
import { logsPage, isLogsPageAllowed } from "./routes/logsPage.js";
import {
  startCall,
  insertCall,
  finishCall,
  pruneCalls,
  logsEnabled
} from "./lib/callLog.js";
import { outlineSource } from "./routes/outlineSource.js";
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

const ROUTES = {
  "POST /v1/sources/outline": outlineSource,
  "POST /v1/decks/generate": generateDeck,
  "POST /v1/decks/refine": refineDeck,
  // Keeps older shipped builds working; nothing new should call it.
  "POST /generate-quiz": legacyQuiz
};

function routeFor(method, pathname) {
  return ROUTES[`${method} ${pathname}`] || null;
}

export default {
  async fetch(request, env, ctx) {
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

    if (request.method === "GET" && url.pathname === "/logs") {
      if (!isLogsPageAllowed(request, env)) {
        return apiError("NOT_FOUND", "Endpoint not found.", 404, requestId);
      }

      return logsPage(request, env);
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "LearnAlert API",
        version: "1.1.0",
        auth: {
          required: authRequired(env)
        },
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
          "POST /v1/sources/outline",
          "POST /v1/decks/generate",
          "POST /v1/decks/refine",
          "POST /generate-quiz"
        ]
      });
    }

    // Every remaining route spends money upstream, so authorize before doing
    // any parsing or provider work.
    if (!isAuthorized(request, env)) {
      recordError({
        requestId,
        code: "UNAUTHORIZED",
        message: "Missing or invalid API key.",
        status: 401,
        details: { path: url.pathname, hadHeader: Boolean(request.headers.get("x-api-key")) },
        method: request.method,
        path: url.pathname
      });

      return apiError("UNAUTHORIZED", "Missing or invalid API key.", 401, requestId);
    }

    const handler = routeFor(request.method, url.pathname);

    if (!handler) {
      return apiError(
        "NOT_FOUND",
        "Endpoint not found.",
        404,
        requestId
      );
    }

    // The row opens before the upstream call so an in-flight generation shows
    // up while it runs, not three minutes later when it settles.
    const call = startCall({
      requestId,
      method: request.method,
      endpoint: url.pathname
    });

    if (logsEnabled(env)) {
      await insertCall(env, call);

      // Trimming on roughly one call in fifty keeps the table bounded without
      // a scheduled worker, and never blocks a response.
      if (Math.random() < 0.02) {
        ctx?.waitUntil?.(pruneCalls(env));
      }
    }

    try {
      const response = await handler(request, env, requestId, call);

      // Logging must not delay the deck the user is waiting on.
      ctx?.waitUntil?.(
        finishCall(env, call, {
          status: response.status < 400 ? "success" : "failed",
          httpStatus: response.status,
          errorCode: null
        })
      );

      return response;
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

      ctx?.waitUntil?.(
        finishCall(env, call, {
          status: "failed",
          httpStatus: status,
          errorCode: code
        })
      );

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
