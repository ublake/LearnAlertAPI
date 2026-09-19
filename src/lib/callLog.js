import { estimateCostUsd, pricing } from "../config.js";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * Durable call log, backed by D1.
 *
 * Unlike the in-memory error log, this survives isolate churn: every isolate
 * writes to the same database, so the page shows all traffic rather than
 * whatever one isolate happened to serve.
 *
 * Every write is best-effort. A logging failure must never turn a working
 * deck generation into an error, so the helpers swallow their own exceptions
 * and report to the console instead.
 */

export function logsEnabled(env) {
  return Boolean(env?.LOGS_DB);
}

/**
 * Opens a row the moment work begins, so an in-flight generation is visible
 * while it runs. Generation can take three minutes; a log that only shows
 * settled calls would look empty for most of that.
 */
export function startCall({ requestId, method, endpoint }) {
  return {
    requestId,
    method,
    endpoint,
    startedAt: Date.now(),
    status: "in_progress",
    provider: null,
    model: null,
    sourceType: null,
    usage: null,
    httpStatus: null,
    errorCode: null,
    inserted: null
  };
}

/**
 * Routes call this with what only they know: which provider answered, which
 * model, and what kind of source the user sent.
 */
export function recordAttempt(call, { provider, model, usage, sourceType }) {
  if (!call) return;

  if (provider !== undefined) call.provider = provider;
  if (model !== undefined) call.model = model;
  if (usage !== undefined) call.usage = usage;
  if (sourceType !== undefined) call.sourceType = sourceType;
}

export async function insertCall(env, call) {
  if (!call || !logsEnabled(env)) return;

  const promise = env.LOGS_DB.prepare(
    `INSERT INTO call_log
       (request_id, started_at, status, method, endpoint)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(request_id) DO NOTHING`
  )
    .bind(
      call.requestId,
      call.startedAt,
      call.status,
      call.method,
      call.endpoint
    )
    .run()
    .catch((error) => {
      console.error(`[${call.requestId}] call log insert failed:`, error);
    });

  call.inserted = promise;

  return promise;
}

/**
 * Settles the row. The update waits on the insert so the two cannot race when
 * the whole call finishes faster than the first write lands.
 */
export async function finishCall(env, call, { status, httpStatus, errorCode }) {
  if (!call || !logsEnabled(env)) return;

  if (call.inserted) await call.inserted;

  const usage = call.usage;

  // Priced against the provider that actually answered, since their rate
  // cards differ and only some report a real cost.
  const cost = estimateCostUsd(usage, pricing(env, call.provider));

  try {
    await env.LOGS_DB.prepare(
      `UPDATE call_log SET
         finished_at = ?, status = ?, provider = ?, model = ?,
         source_type = ?, tokens_in = ?, tokens_cached = ?, tokens_out = ?,
         cost_usd = ?, cost_source = ?, http_status = ?, error_code = ?
       WHERE request_id = ?`
    )
      .bind(
        Date.now(),
        status,
        call.provider,
        call.model,
        call.sourceType,
        usage ? Number(usage.prompt_tokens) || 0 : null,
        usage ? Number(usage.cachedTokens) || 0 : null,
        usage ? Number(usage.completion_tokens) || 0 : null,
        cost.usd,
        cost.source,
        httpStatus ?? null,
        errorCode ?? null,
        call.requestId
      )
      .run();
  } catch (error) {
    console.error(`[${call.requestId}] call log update failed:`, error);
  }
}

/**
 * Old rows are deleted opportunistically rather than on a cron, which keeps
 * the table small without adding a scheduled worker.
 */
export async function pruneCalls(env, now = Date.now()) {
  if (!logsEnabled(env)) return;

  try {
    await env.LOGS_DB.prepare(`DELETE FROM call_log WHERE started_at < ?`)
      .bind(now - RETENTION_MS)
      .run();
  } catch (error) {
    console.error("call log prune failed:", error);
  }
}

export async function listCalls(env, { limit = DEFAULT_LIMIT } = {}) {
  if (!logsEnabled(env)) return [];

  const capped = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const { results } = await env.LOGS_DB.prepare(
    `SELECT * FROM call_log ORDER BY started_at DESC LIMIT ?`
  )
    .bind(capped)
    .all();

  return (results || []).map(toEntry);
}

export async function summarize(env) {
  if (!logsEnabled(env)) return null;

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
       SUM(CASE WHEN cost_source = 'estimated' THEN 1 ELSE 0 END) AS estimated
     FROM call_log`
  ).first();

  return {
    calls: row?.calls || 0,
    succeeded: row?.succeeded || 0,
    failed: row?.failed || 0,
    inFlight: row?.inFlight || 0,
    tokensIn: row?.tokensIn || 0,
    tokensCached: row?.tokensCached || 0,
    tokensOut: row?.tokensOut || 0,
    costUsd: row?.costUsd || 0,
    estimated: row?.estimated || 0
  };
}

function toEntry(row) {
  return {
    requestId: row.request_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    method: row.method,
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
      row.finished_at && row.started_at
        ? row.finished_at - row.started_at
        : null
  };
}

/**
 * "1m ago" rather than a timestamp: the question this page answers is always
 * "what just happened", never "what happened at 14:07:33Z".
 */
export function relativeTime(then, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - then) / 1000));

  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return `${Math.round(hours / 24)}d ago`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;

  return `${(ms / 1000).toFixed(1)}s`;
}

export const CALL_LOG_RETENTION_DAYS = RETENTION_MS / (24 * 60 * 60 * 1000);
