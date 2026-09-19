import { logsEnabled } from "./callLog.js";

/**
 * Time ranges offered by the page. `all` is bounded by the log's retention, so
 * it is labelled honestly rather than promising history that was pruned.
 *
 * Bucket counts are chosen so a bar stays wide enough to hit with a pointer:
 * twelve 5-minute bars in an hour, twenty-four hourly bars in a day, seven
 * daily bars in a week.
 */
export const RANGES = {
  "1h": { label: "1h", windowMs: 60 * 60 * 1000, buckets: 12, tick: "time" },
  "1d": { label: "1d", windowMs: 24 * 60 * 60 * 1000, buckets: 24, tick: "time" },
  "7d": { label: "7d", windowMs: 7 * 24 * 60 * 60 * 1000, buckets: 7, tick: "day" },
  all: {
    label: "All",
    windowMs: 7 * 24 * 60 * 60 * 1000,
    buckets: 7,
    tick: "day"
  }
};

export const ENDPOINTS = {
  all: { label: "All endpoints", path: null },
  generate: { label: "Generate", path: "/v1/decks/generate" },
  refine: { label: "Refine", path: "/v1/decks/refine" },
  outline: { label: "Outline", path: "/v1/sources/outline" },
  legacy: { label: "Legacy quiz", path: "/generate-quiz" }
};

export const PROVIDERS = {
  all: { label: "All providers" },
  cheaper_inference: { label: "CheaperInference" },
  openai: { label: "OpenAI" }
};

export function resolveFilters(searchParams) {
  const range = RANGES[searchParams.get("range")] ? searchParams.get("range") : "1d";
  const endpoint = ENDPOINTS[searchParams.get("endpoint")]
    ? searchParams.get("endpoint")
    : "all";
  const provider = PROVIDERS[searchParams.get("provider")]
    ? searchParams.get("provider")
    : "all";

  return { range, endpoint, provider };
}

/**
 * Both queries filter identically, so the clause is built once. Values are
 * bound, never interpolated.
 */
function whereClause(filters, since) {
  const clauses = ["started_at >= ?"];
  const binds = [since];

  const path = ENDPOINTS[filters.endpoint]?.path;

  if (path) {
    clauses.push("endpoint = ?");
    binds.push(path);
  }

  if (filters.provider !== "all") {
    clauses.push("provider = ?");
    binds.push(filters.provider);
  }

  return { sql: clauses.join(" AND "), binds };
}

/**
 * One row per time bucket, with empty buckets filled in. A gap in traffic is
 * information, so it renders as a zero-height bar rather than vanishing and
 * compressing the axis.
 */
export async function bucketSeries(env, filters, now = Date.now()) {
  const range = RANGES[filters.range];
  const since = now - range.windowMs;
  const width = Math.ceil(range.windowMs / range.buckets);
  const { sql, binds } = whereClause(filters, since);

  if (!logsEnabled(env)) return { buckets: [], since, width };

  const { results } = await env.LOGS_DB.prepare(
    `SELECT
       CAST((started_at - ?) / ? AS INTEGER) AS bucket,
       COUNT(*) AS calls,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(MAX(COALESCE(tokens_in, 0) - COALESCE(tokens_cached, 0), 0)) AS freshIn,
       SUM(COALESCE(tokens_cached, 0)) AS cachedIn,
       SUM(COALESCE(tokens_out, 0)) AS tokensOut,
       SUM(COALESCE(cost_usd, 0)) AS cost
     FROM call_log
     WHERE ${sql}
     GROUP BY bucket
     ORDER BY bucket`
  )
    .bind(since, width, ...binds)
    .all();

  const byIndex = new Map(
    (results || []).map((row) => [Number(row.bucket), row])
  );

  const buckets = [];

  for (let index = 0; index < range.buckets; index += 1) {
    const row = byIndex.get(index);

    buckets.push({
      startedAt: since + index * width,
      endedAt: since + (index + 1) * width,
      calls: row?.calls || 0,
      succeeded: row?.succeeded || 0,
      failed: row?.failed || 0,
      freshIn: row?.freshIn || 0,
      cachedIn: row?.cachedIn || 0,
      tokensOut: row?.tokensOut || 0,
      cost: row?.cost || 0
    });
  }

  return { buckets, since, width };
}

/**
 * Totals for exactly the rows the filters select, so the figure under the page
 * always answers "within this range, for this endpoint".
 */
export async function totalsFor(env, filters, now = Date.now()) {
  if (!logsEnabled(env)) return null;

  const since = now - RANGES[filters.range].windowMs;
  const { sql, binds } = whereClause(filters, since);

  const row = await env.LOGS_DB.prepare(
    `SELECT
       COUNT(*) AS calls,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS inFlight,
       SUM(COALESCE(tokens_in, 0)) AS tokensIn,
       SUM(COALESCE(tokens_cached, 0)) AS tokensCached,
       SUM(COALESCE(tokens_out, 0)) AS tokensOut,
       SUM(COALESCE(cost_usd, 0)) AS costUsd,
       SUM(CASE WHEN cost_source = 'estimated' THEN 1 ELSE 0 END) AS estimated,
       AVG(CASE WHEN finished_at IS NOT NULL
             THEN finished_at - started_at END) AS avgMs
     FROM call_log
     WHERE ${sql}`
  )
    .bind(...binds)
    .first();

  const calls = row?.calls || 0;
  const tokensIn = row?.tokensIn || 0;

  return {
    calls,
    succeeded: row?.succeeded || 0,
    failed: row?.failed || 0,
    inFlight: row?.inFlight || 0,
    tokensIn,
    tokensCached: row?.tokensCached || 0,
    tokensOut: row?.tokensOut || 0,
    costUsd: row?.costUsd || 0,
    estimated: row?.estimated || 0,
    avgMs: row?.avgMs ?? null,
    // The headline number for whether the prompt-cache ordering is working.
    cachedShare: tokensIn > 0 ? (row?.tokensCached || 0) / tokensIn : null,
    costPerCall: calls > 0 ? (row?.costUsd || 0) / calls : null
  };
}

export async function listFiltered(env, filters, limit, now = Date.now()) {
  if (!logsEnabled(env)) return [];

  const since = now - RANGES[filters.range].windowMs;
  const { sql, binds } = whereClause(filters, since);
  // A nonsensical limit falls back to the default rather than clamping to a
  // single row, which would read as "the log is empty" instead of "bad input".
  const asked = Number(limit);
  const capped = Number.isFinite(asked) && asked >= 1 ? Math.min(asked, 500) : 100;

  const { results } = await env.LOGS_DB.prepare(
    `SELECT * FROM call_log
     WHERE ${sql}
     ORDER BY started_at DESC
     LIMIT ?`
  )
    .bind(...binds, capped)
    .all();

  return results || [];
}
