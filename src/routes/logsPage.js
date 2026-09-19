import {
  relativeTime,
  formatDuration,
  logsEnabled,
  CALL_LOG_RETENTION_DAYS
} from "../lib/callLog.js";
import {
  RANGES,
  ENDPOINTS,
  PROVIDERS,
  resolveFilters,
  bucketSeries,
  totalsFor,
  listFiltered
} from "../lib/callStats.js";
import { stackedBarChart, CHART_STYLES, CHART_SCRIPT } from "../lib/charts.js";
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

/**
 * Outcome uses the fixed status palette, never the categorical slots, so a
 * state can never impersonate a series. Every series carries a legend label —
 * hue never has to do the work alone, and the table below repeats every value.
 */
const COLORS = {
  succeeded: "var(--good)",
  failed: "var(--critical)",
  cost: "var(--series-1)",
  freshIn: "var(--series-1)",
  cachedIn: "var(--series-3)",
  tokensOut: "var(--series-2)"
};

function formatTokens(value) {
  if (value === null || value === undefined) return "—";

  const n = Number(value);

  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;

  return n.toLocaleString();
}

function formatCost(value) {
  if (value === null || value === undefined) return "n/a";
  if (value === 0) return "$0";

  // Sub-cent calls are the common case, so two decimals would read as $0.00.
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(2)}`;
}

/**
 * A reported cost is what the provider billed; an estimated one is our
 * arithmetic. Marking the estimates keeps the difference visible without
 * shouting about the exact ones.
 */
function costCell(entry) {
  const amount = escapeHtml(formatCost(entry.costUsd));

  if (entry.costSource === "estimated") {
    return `${amount} <span class="est" title="Estimated from the rate card; this provider does not report cost">est</span>`;
  }

  return amount;
}

function statusLabel(status) {
  return status === "in_progress" ? "in-progress" : status;
}

function renderRow(entry, now) {
  const cached =
    entry.tokensCached > 0
      ? ` <span class="cached">${formatTokens(entry.tokensCached)} cached</span>`
      : "";

  return `
    <tr>
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
      <td class="num">${costCell(entry)}</td>
      <td class="mono dim">${entry.errorCode ? escapeHtml(entry.errorCode) : ""}</td>
    </tr>`;
}

function href(filters, patch, token) {
  const params = new URLSearchParams({ ...filters, ...patch });

  if (token) params.set("token", token);

  return `?${params}`;
}

/**
 * Filters sit in one row above the charts, range first — it is the control
 * every reader reaches for. Plain links, so the state is in the URL and a
 * filtered view can be bookmarked or shared.
 */
function renderFilters(filters, token) {
  const group = (name, options, active) =>
    `<div class="fg" role="group" aria-label="${escapeHtml(name)}">${Object.entries(
      options
    )
      .map(
        ([key, option]) =>
          `<a class="fo${key === active ? " on" : ""}" href="${escapeHtml(
            href(filters, { [name]: key }, token)
          )}"${key === active ? ' aria-current="true"' : ""}>${escapeHtml(
            option.label
          )}</a>`
      )
      .join("")}</div>`;

  return `<div class="filters">
    ${group("range", RANGES, filters.range)}
    ${group("endpoint", ENDPOINTS, filters.endpoint)}
    ${group("provider", PROVIDERS, filters.provider)}
  </div>`;
}

function tile(value, label, hint = "") {
  return `<div class="tile">
    <div class="tv">${value}</div>
    <div class="tl">${escapeHtml(label)}</div>
    ${hint ? `<div class="th">${escapeHtml(hint)}</div>` : ""}
  </div>`;
}

/**
 * Totals for exactly what the filters select, so the number under the page
 * always answers the question the controls above it just asked.
 */
function renderTotals(totals, filters) {
  if (!totals) return "";

  const scope = [
    filters.range === "all"
      ? `all ${CALL_LOG_RETENTION_DAYS} retained days`
      : `the last ${RANGES[filters.range].label}`,
    filters.endpoint === "all" ? null : ENDPOINTS[filters.endpoint].label,
    filters.provider === "all" ? null : PROVIDERS[filters.provider].label
  ]
    .filter(Boolean)
    .join(" · ");

  const costHint =
    totals.calls === 0
      ? ""
      : totals.estimated > 0
        ? `${totals.estimated} of ${totals.calls} estimated`
        : "all provider-reported";

  return `<section class="totals">
    <h2>Totals — ${escapeHtml(scope)}</h2>
    <div class="tiles">
      ${tile(escapeHtml(formatCost(totals.costUsd)), "Total cost", costHint)}
      ${tile(
        totals.costPerCall === null
          ? "—"
          : escapeHtml(formatCost(totals.costPerCall)),
        "Cost per call"
      )}
      ${tile(
        String(totals.calls),
        "Calls",
        `${totals.succeeded} ok · ${totals.failed} failed`
      )}
      ${tile(formatTokens(totals.tokensIn), "Tokens in")}
      ${tile(formatTokens(totals.tokensOut), "Tokens out")}
      ${tile(
        totals.cachedShare === null
          ? "—"
          : `${Math.round(totals.cachedShare * 100)}%`,
        "Input cached",
        "higher is cheaper"
      )}
      ${tile(
        totals.avgMs === null
          ? "—"
          : escapeHtml(formatDuration(Math.round(totals.avgMs))),
        "Average call"
      )}
    </div>
  </section>`;
}

const STYLES = `
  :root {
    color-scheme: light dark;
    --surface: #fcfcfb; --plane: #f9f9f7; --fg: #0b0b0b;
    --dim: #52514e; --muted: #898781; --line: #e1e0d9;
    --grid: #e1e0d9; --baseline: #c3c2b7;
    --good: #0ca30c; --critical: #d03b3b; --warning: #fab219;
    --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --surface: #1a1a19; --plane: #0d0d0d; --fg: #ffffff;
      --dim: #c3c2b7; --muted: #898781; --line: #2c2c2a;
      --grid: #2c2c2a; --baseline: #383835;
      --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 22px 16px 40px; background: var(--plane); color: var(--fg);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 10px; color: var(--dim); }
  .sub { color: var(--dim); font-size: 13px; margin: 0 0 14px; }
  a { color: inherit; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .fg {
    display: flex; border: 1px solid var(--line); border-radius: 8px;
    overflow: hidden; background: var(--surface);
  }
  .fo {
    padding: 5px 11px; font-size: 12px; text-decoration: none; color: var(--dim);
    border-right: 1px solid var(--line); white-space: nowrap;
  }
  .fo:last-child { border-right: 0; }
  .fo:hover { background: var(--plane); }
  .fo.on { background: var(--fg); color: var(--surface); font-weight: 600; }
  ${CHART_STYLES}
  .scroll {
    overflow-x: auto; -webkit-overflow-scrolling: touch;
    border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
  }
  table { border-collapse: collapse; width: 100%; min-width: 760px; }
  th {
    text-align: left; font-size: 11px; text-transform: uppercase;
    letter-spacing: .04em; color: var(--muted); font-weight: 600;
    padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap;
  }
  td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr:last-child td { border-bottom: 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .dim { color: var(--dim); }
  .when { color: var(--dim); white-space: nowrap; }
  .cached { color: var(--muted); font-size: 11px; display: block; }
  .est {
    color: var(--muted); font-size: 10px; text-transform: uppercase;
    letter-spacing: .04em; border: 1px solid var(--line); border-radius: 3px;
    padding: 0 3px; cursor: help;
  }
  .pill {
    display: inline-block; padding: 1px 8px; border-radius: 999px;
    font-size: 11px; font-weight: 600; white-space: nowrap;
  }
  .pill-success { color: var(--good); border: 1px solid currentColor; }
  .pill-failed { color: var(--critical); border: 1px solid currentColor; }
  .pill-in_progress { color: var(--warning); border: 1px solid currentColor; }
  .empty {
    color: var(--dim); padding: 30px 0; text-align: center;
    border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
  }
  .totals { margin-top: 20px; }
  .tiles {
    display: grid; gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  }
  .tile {
    border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px;
    background: var(--surface);
  }
  .tv { font-size: 21px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .tl { font-size: 12px; color: var(--dim); margin-top: 1px; }
  .th { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .note {
    margin-top: 18px; font-size: 12px; color: var(--dim);
    border-top: 1px solid var(--line); padding-top: 12px;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--surface); padding: 1px 4px; border-radius: 3px;
  }
  @media (max-width: 600px) { body { padding: 16px 12px 32px; } }
`;

function bucketLabel(range) {
  return (bucket) => {
    const date = new Date(bucket.startedAt);

    if (RANGES[range].tick === "day") {
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric"
      });
    }

    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    });
  };
}

function renderPage({
  entries,
  totals,
  buckets,
  filters,
  prices,
  now,
  refreshSeconds,
  token,
  jsonHref
}) {
  const label = bucketLabel(filters.range);
  const rows = entries.map((entry) => renderRow(entry, now)).join("");
  const card = prices.shortContext;

  const charts = `<div class="charts">
    ${stackedBarChart({
      title: "Calls",
      subtitle: "by outcome",
      buckets,
      series: [
        { key: "succeeded", label: "Success", color: COLORS.succeeded },
        { key: "failed", label: "Failed", color: COLORS.failed }
      ],
      formatValue: (value) => String(Math.round(value)),
      formatBucket: label
    })}
    ${stackedBarChart({
      title: "Cost",
      subtitle: "USD per bucket",
      buckets,
      series: [{ key: "cost", label: "Cost", color: COLORS.cost }],
      formatValue: (value) => (value === 0 ? "$0" : `$${value.toFixed(3)}`),
      formatBucket: label
    })}
    <div class="wide">
      ${stackedBarChart({
        title: "Tokens",
        subtitle: "input split by cache, plus output",
        buckets,
        series: [
          { key: "freshIn", label: "Input", color: COLORS.freshIn },
          { key: "cachedIn", label: "Cached", color: COLORS.cachedIn },
          { key: "tokensOut", label: "Output", color: COLORS.tokensOut }
        ],
        formatValue: (value, exact) =>
          exact ? Math.round(value).toLocaleString() : formatTokens(value),
        formatBucket: label
      })}
    </div>
  </div>`;

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
      Refreshes every ${refreshSeconds}s · kept ${CALL_LOG_RETENTION_DAYS} days ·
      <a href="${escapeHtml(jsonHref)}">JSON</a>
    </p>
    ${renderFilters(filters, token)}
    ${charts}
    ${
      entries.length === 0
        ? `<p class="empty">No calls in this range.</p>`
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
    ${renderTotals(totals, filters)}
    <p class="note">
      Costs without a badge are what the provider reported billing — exact, and
      they follow rate changes on their own. A <span class="est">est</span> badge
      means the provider reports no cost, so the figure is our arithmetic against
      the rate card: <code>$${card.input ?? "—"}</code> per million input tokens,
      <code>$${card.cachedInput ?? card.input ?? "—"}</code> cached,
      <code>$${card.output ?? "—"}</code> output, switching to the long-context
      tier above ${prices.longContextThreshold.toLocaleString()} prompt tokens.
    </p>
  </div>
  <div id="tip" role="status"></div>
  <script>${CHART_SCRIPT}</script>
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
          "apply the migrations in ./migrations."
      },
      503
    );
  }

  const filters = resolveFilters(url.searchParams);
  const now = Date.now();

  const [rows, totals, series] = await Promise.all([
    listFiltered(env, filters, url.searchParams.get("limit"), now),
    totalsFor(env, filters, now),
    bucketSeries(env, filters, now)
  ]);

  const entries = rows.map((row) => ({
    requestId: row.request_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    endpoint: row.endpoint,
    provider: row.provider,
    model: row.model,
    sourceType: row.source_type,
    tokensIn: row.tokens_in,
    tokensCached: row.tokens_cached,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    costSource: row.cost_source,
    httpStatus: row.http_status,
    errorCode: row.error_code,
    durationMs:
      row.finished_at && row.started_at ? row.finished_at - row.started_at : null
  }));

  const prices = pricing(env);

  if (url.searchParams.get("format") === "json") {
    return json({
      ok: true,
      now: new Date(now).toISOString(),
      retentionDays: CALL_LOG_RETENTION_DAYS,
      filters,
      rateCard: prices,
      totals,
      buckets: series.buckets,
      calls: entries.map((entry) => ({
        ...entry,
        age: relativeTime(entry.startedAt, now)
      }))
    });
  }

  // In-flight rows are the reason to keep the tab open, so refresh faster
  // while something is running.
  const refreshSeconds = totals?.inFlight > 0 ? 5 : 15;

  const jsonParams = new URLSearchParams(url.searchParams);
  jsonParams.set("format", "json");

  return new Response(
    renderPage({
      entries,
      totals,
      buckets: series.buckets,
      filters,
      prices,
      now,
      refreshSeconds,
      token: url.searchParams.get("token") || "",
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
