import { apiError, json, optionsResponse } from "./lib/http.js";
import { ValidationError } from "./lib/validation.js";
import { OpenAIRequestError } from "./lib/openai.js";
import { generateDeck } from "./routes/generateDeck.js";
import { refineDeck } from "./routes/refineDeck.js";
import { legacyQuiz } from "./routes/legacyQuiz.js";

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return optionsResponse();
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "LearnAlert API",
        version: "1.0.0",
        endpoints: [
          "POST /v1/decks/generate",
          "POST /v1/decks/refine",
          "POST /generate-quiz"
        ]
      });
    }

    try {
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

      if (error instanceof ValidationError) {
        return apiError(
          "VALIDATION_ERROR",
          error.message,
          400,
          requestId
        );
      }

      if (error instanceof OpenAIRequestError) {
        // Do not leak full upstream details to the app.
        console.error(
          `[${requestId}] OpenAI details:`,
          error.details
        );

        return apiError(
          "AI_REQUEST_FAILED",
          error.message,
          error.status >= 400 && error.status < 600
            ? error.status
            : 502,
          requestId
        );
      }

      if (error instanceof SyntaxError) {
        return apiError(
          "INVALID_JSON",
          "Request body must be valid JSON.",
          400,
          requestId
        );
      }

      return apiError(
        "INTERNAL_ERROR",
        "Something went wrong while processing the request.",
        500,
        requestId
      );
    }
  }
};
