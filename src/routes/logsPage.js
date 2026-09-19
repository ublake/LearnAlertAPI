import {
  listCalls,
  summarize,
  relativeTime,
  formatDuration,
  logsEnabled,
  CALL_LOG_RETENTION_DAYS
} from "../lib/callLog.js";
import { pricing } from "../config.js";
import { isDebugAuthorized } from "../lib/errorLog.js";
import { json } from "../lib/http.js";

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
 * Fails closed. Traffic volume and spend are business data, and this page sits
 * in front of the API key check so it can be opened in a browser — so an
 * unset DEBUG_TOKEN must mean "nobody", never "everybody". Set DEBUG_TOKEN as
 * a secret, then reach the page at /logs?token=... or with X-Debug-Token.
 *
 * It deliberately carries no prompts, deck content, or source text: only
 * metadata about each call.
 */
export function isLogsPageAllowed(request, env) {
  if (!env.DEBUG_TOKEN) return false;

  return isDebugAuthorized(request, env);
}

function formatTokens(value) {
  if (value === null || value === undefined) return "—";

  return Number(value).toLocaleString();
}

function formatCost(value, prices) {
  if (prices.input === null || prices.output === null) return "n/a";
  if (value === null || value === undefined) return "—";
  if (value === 0) return "$0";

  // Sub-cent calls are the common case, so two decimals would read as $0.00.
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(3)}`;
}

function statusLabel(status) {
  if (status === "in_progress") return "in-progress";

  return status;
}

function renderRow(entry, now, prices) {
  const cached =
    entry.tokensCached > 0
      ? ` <span class="cached">${formatTokens(entry.tokensCached)} cached</span>`
      : "";

  return `
    <tr class="status-${escapeHtml(entry.status)}">
      <td class="when" title="${escapeHtml(new Date(entry.startedAt).toISOString())}">
        ${escapeHtml(relativeTime(entry.startedAt, now))}
      </td>
      <td><span class="pill pill-${escapeHtml(entry.status)}">${escapeHtml(
        statusLabel(entry.status)
      )}</span></td>
      <td class="mono">${escapeHtml(entry.endpoint)}</td>
      <td>${entry.sourceType ? escapeHtml(entry.sourceType) : "—"}</td>
      <td>${entry.provider ? escapeHtml(entry.provider) : "—"}</td>
      <td class="num">${formatTokens(entry.tokensIn)}${cached}</td>
      <td class="num">${formatTokens(entry.tokensOut)}</td>
      <td class="num">${escapeHtml(formatDuration(entry.durationMs))}</td>
      <td class="num">${escapeHtml(formatCost(entry.costUsd, prices))}</td>
      <td class="mono dim">${
        entry.errorCode ? escapeHtml(entry.errorCode) : ""
      }</td>
    </tr>`;
}

function renderSummary(totals, prices) {
  if (!totals) return "";

  return `
    <div class="totals">
      <span><strong>${totals.calls}</strong> calls</span>
      <span><strong>${totals.succeeded}</strong> ok</span>
      <span><strong>${totals.failed}</strong> failed</span>
      <span><strong>${totals.inFlight}</strong> in flight</span>
      <span><strong>${formatTokens(totals.tokensIn)}</strong> in</span>
      <span><strong>${formatTokens(totals.tokensCached)}</strong> cached</span>
      <span><strong>${formatTokens(totals.tokensOut)}</strong> out</span>
      <span><strong>${formatCost(totals.costUsd, prices)}</strong> total</span>
    </div>`;
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1a1a1a; --dim: #6b7280; --line: #e5e7eb;
    --ok: #047857; --fail: #b91c1c; --live: #a16207; --row: #f9fafb;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --fg: #e6edf3; --dim: #8b949e; --line: #21262d;
      --ok: #3fb950; --fail: #f85149; --live: #d29922; --row: #161b22;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--dim); font-size: 13px; margin: 0 0 16px; }
  .totals {
    display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 12px 14px;
    border: 1px solid var(--line); border-radius: 8px; margin-bottom: 16px;
    font-size: 13px; color: var(--dim);
  }
  .totals strong { color: var(--fg); font-variant-numeric: tabular-nums; }
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { border-collapse: collapse; width: 100%; min-width: 760px; }
  th {
    text-align: left; font-size: 11px; text-transform: uppercase;
    letter-spacing: .04em; color: var(--dim); font-weight: 600;
    padding: 6px 10px; border-bottom: 1px solid var(--line); white-space: nowrap;
  }
  td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr:nth-child(even) { background: var(--row); }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .dim { color: var(--dim); }
  .when { color: var(--dim); white-space: nowrap; }
  .cached { color: var(--dim); font-size: 11px; display: block; }
  .pill {
    display: inline-block; padding: 1px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 600; white-space: nowrap;
  }
  .pill-success { color: var(--ok); border: 1px solid currentColor; }
  .pill-failed { color: var(--fail); border: 1px solid currentColor; }
  .pill-in_progress { color: var(--live); border: 1px solid currentColor; }
  .empty { color: var(--dim); padding: 32px 0; text-align: center; }
  .note {
    margin-top: 16px; font-size: 12px; color: var(--dim);
    border-top: 1px solid var(--line); padding-top: 12px;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--row); padding: 1px 4px; border-radius: 3px;
  }
  @media (max-width: 600px) { body { padding: 16px 12px; } }
`;

function renderPage({ entries, totals, prices, now, refreshSeconds, jsonHref }) {
  const rows = entries.map((entry) => renderRow(entry, now, prices)).join("");

  const priceNote =
    prices.input === null || prices.output === null
      ? `<p class="note">Costs read <code>n/a</code> until
         <code>PRICE_INPUT_PER_MTOK</code>,
         <code>PRICE_CACHED_INPUT_PER_MTOK</code> and
         <code>PRICE_OUTPUT_PER_MTOK</code> are set to your rate card, in USD
         per million tokens. No rates are assumed, because a wrong number
         looks authoritative.</p>`
      : `<p class="note">Costs are computed from your configured rates:
         <code>$${prices.input}</code> per million input tokens,
         <code>$${
           prices.cachedInput === null ? prices.input : prices.cachedInput
         }</code> cached, <code>$${prices.output}</code> output. They are an
         estimate from reported usage, not a bill.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${refreshSeconds}">
<title>LearnAlert API calls</title>
<style>${STYLES}</style>
</head>
<body>
  <div class="wrap">
    <h1>API calls</h1>
    <p class="sub">
      Newest first · refreshes every ${refreshSeconds}s ·
      kept ${CALL_LOG_RETENTION_DAYS} days ·
      <a href="${escapeHtml(jsonHref)}">JSON</a>
    </p>
    ${renderSummary(totals, prices)}
    ${
      entries.length === 0
        ? `<p class="empty">No calls logged yet.</p>`
        : `<div class="scroll"><table>
             <thead>
               <tr>
                 <th>When</th><th>Status</th><th>Endpoint</th><th>Source</th>
                 <th>Provider</th><th class="num">Tokens in</th>
                 <th class="num">Tokens out</th><th class="num">Took</th>
                 <th class="num">Cost</th><th>Error</th>
               </tr>
             </thead>
             <tbody>${rows}</tbody>
           </table></div>`
    }
    ${priceNote}
  </div>
</body>
</html>`;
}

export async function logsPage(request, env) {
  const url = new URL(request.url);

  if (!logsEnabled(env)) {
    return json(
      {
        ok: false,
        error: "Call logging is not configured.",
        hint:
          "Create the D1 database, bind it as LOGS_DB in wrangler.jsonc, and " +
          "apply migrations/0001_call_log.sql."
      },
      503
    );
  }

  const limit = url.searchParams.get("limit");
  const [entries, totals] = await Promise.all([
    listCalls(env, { limit }),
    summarize(env)
  ]);

  const prices = pricing(env);
  const now = Date.now();

  if (url.searchParams.get("format") === "json") {
    return json({
      ok: true,
      now: new Date(now).toISOString(),
      retentionDays: CALL_LOG_RETENTION_DAYS,
      priced: prices.input !== null && prices.output !== null,
      totals,
      calls: entries.map((entry) => ({
        ...entry,
        age: relativeTime(entry.startedAt, now)
      }))
    });
  }

  // In-flight rows are the reason to keep the tab open, so refresh faster
  // while something is running.
  const refreshSeconds = totals?.inFlight > 0 ? 5 : 15;

  // The token lives in the query string, so the JSON link has to carry it or
  // it lands on a 404.
  const jsonParams = new URLSearchParams(url.searchParams);
  jsonParams.set("format", "json");

  return new Response(
    renderPage({
      entries,
      totals,
      prices,
      now,
      refreshSeconds,
      jsonHref: `?${jsonParams}`
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      }
    }
  );
}
