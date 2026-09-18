const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 50;

/**
 * Best-effort in-memory error log for debugging.
 *
 * This lives in the isolate's memory, which is a real limitation: Cloudflare
 * runs many short-lived isolates per region, so /errors shows what the isolate
 * answering that request happened to see. An error can be missing here and
 * still be real. `wrangler tail` is the authoritative stream; this is the
 * convenient one.
 */
const entries = [];

function prune(now) {
  while (entries.length > 0 && now - entries[0].at > TTL_MS) {
    entries.shift();
  }
}

export function recordError(entry) {
  const now = Date.now();
  prune(now);

  entries.push({ at: now, ...entry });

  while (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
}

export function listErrors(now = Date.now()) {
  prune(now);

  return entries
    .map((entry) => ({
      ...entry,
      ageSeconds: Math.round((now - entry.at) / 1000),
      expiresInSeconds: Math.max(
        0,
        Math.round((TTL_MS - (now - entry.at)) / 1000)
      ),
      time: new Date(entry.at).toISOString()
    }))
    .reverse();
}

export function errorLogTtlSeconds() {
  return TTL_MS / 1000;
}

/**
 * Debug access is opt-in and token-gated: `details` can quote upstream
 * payloads and user content, so it is never exposed without DEBUG_TOKEN set
 * and presented.
 */
export function isDebugAuthorized(request, env) {
  if (!env.DEBUG_TOKEN) return false;

  const url = new URL(request.url);
  const supplied =
    request.headers.get("x-debug-token") || url.searchParams.get("token") || "";

  return supplied === env.DEBUG_TOKEN;
}
