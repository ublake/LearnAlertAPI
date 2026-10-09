/**
 * Shared-key authentication.
 *
 * A key shipped inside an iOS binary can be extracted by a determined person,
 * so this is not the end state — App Attest is. What it does do is close the
 * endpoint to anyone who has not deliberately targeted this app, which covers
 * the scanners and opportunists that make an open AI endpoint expensive.
 */

/** Comparison that does not leak the correct key through timing. */
function safeEqual(a, b) {
  if (a.length !== b.length) return false;

  let mismatch = 0;

  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return mismatch === 0;
}

/** Comma-separated so a key can be rotated without a window of downtime. */
export function configuredKeys(env) {
  return String(env.API_KEYS || env.API_KEY || "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

export function authRequired(env) {
  return configuredKeys(env).length > 0 || env.ALLOW_UNAUTHENTICATED_AI !== "true";
}

function presentedKey(request) {
  const header = request.headers.get("x-api-key");
  if (header) return header.trim();

  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);

  return bearer ? bearer[1].trim() : "";
}

/**
 * Production fails closed without a key. Local development may explicitly
 * set ALLOW_UNAUTHENTICATED_AI=true; never set it in production.
 */
export function isAuthorized(request, env) {
  const keys = configuredKeys(env);
  if (keys.length === 0) return env.ALLOW_UNAUTHENTICATED_AI === "true";

  const supplied = presentedKey(request);
  if (!supplied) return false;

  return keys.some((key) => safeEqual(key, supplied));
}
