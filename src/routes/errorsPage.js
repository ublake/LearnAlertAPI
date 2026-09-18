import {
  listErrors,
  errorLogTtlSeconds,
  isDebugAuthorized
} from "../lib/errorLog.js";

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]
  );
}

/**
 * Error details can quote upstream payloads, so this is not public by default:
 * it serves only when ERROR_LOG_ENABLED is "true", and when DEBUG_TOKEN is set
 * the caller must present it.
 */
export function isErrorsPageAllowed(request, env) {
  if (env.ERROR_LOG_ENABLED !== "true") return false;
  if (!env.DEBUG_TOKEN) return true;

  return isDebugAuthorized(request, env);
}

function renderRow(entry) {
  const details = entry.details
    ? `<pre>${escapeHtml(JSON.stringify(entry.details, null, 2))}</pre>`
    : "";

  return `
    <article class="entry status-${Math.floor(entry.status / 100)}">
      <header>
        <span class="code">${escapeHtml(entry.code)}</span>
        <span class="status">HTTP ${entry.status}</span>
        <span class="age">${entry.ageSeconds}s ago &middot; gone in ${entry.expiresInSeconds}s</span>
      </header>
      <p class="message">${escapeHtml(entry.message)}</p>
      <p class="meta">
        ${escapeHtml(entry.method)} ${escapeHtml(entry.path)}
        &middot; <code>${escapeHtml(entry.requestId)}</code>
      </p>
      ${details}
    </article>`;
}

function renderHtml(entries, ttlSeconds) {
  const body = entries.length
    ? entries.map(renderRow).join("")
    : `<p class="empty">No errors in the last ${ttlSeconds / 60} minutes.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>LearnAlert API errors</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --fg:#e6edf3; --dim:#8b949e; --card:#161b22; --line:#30363d; --warn:#d29922; --bad:#f85149; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size:16px; margin:0 0 4px; }
  .sub { color:var(--dim); margin:0 0 20px; }
  .entry { background:var(--card); border:1px solid var(--line);
           border-left-width:3px; border-radius:6px; padding:12px 14px; margin-bottom:12px; }
  .status-4 { border-left-color:var(--warn); }
  .status-5 { border-left-color:var(--bad); }
  header { display:flex; flex-wrap:wrap; gap:10px; align-items:baseline; margin-bottom:6px; }
  .code { font-weight:600; }
  .status, .age, .meta { color:var(--dim); font-size:12px; }
  .message { margin:0 0 6px; }
  pre { background:#0d1117; border:1px solid var(--line); border-radius:4px;
        padding:8px; overflow-x:auto; font-size:12px; color:var(--dim); margin:8px 0 0; }
  .empty { color:var(--dim); }
</style>
</head>
<body>
  <h1>LearnAlert API errors</h1>
  <p class="sub">
    Last ${ttlSeconds / 60} minutes &middot; auto-refreshes every 5s &middot;
    best-effort, per-isolate. Use <code>wrangler tail</code> for the full stream.
  </p>
  ${body}
</body>
</html>`;
}

export function errorsPage(request) {
  const url = new URL(request.url);
  const entries = listErrors();
  const ttlSeconds = errorLogTtlSeconds();

  if (url.searchParams.get("format") === "json") {
    return new Response(
      JSON.stringify({ ttlSeconds, count: entries.length, errors: entries }, null, 2),
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store"
        }
      }
    );
  }

  return new Response(renderHtml(entries, ttlSeconds), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
