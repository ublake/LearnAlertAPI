import { json } from './http.js';

function ceiling(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Reservations happen before any upstream work. D1 batch is transactional:
// each later reservation depends on this same request owning the earlier one.
export async function limitAIRequest(request, env, requestId, time = Date.now()) {
  if (env.AI_LIMITS_DISABLED === 'true') return null; // Explicit local/test opt-out.
  if (!env.LOGS_DB) return unavailable(requestId);
  const now = Math.floor(time / 1000);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`learnalert:${ip}`));
  const subject = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const budgets = [
    { subject, seconds: 3600, maximum: ceiling(env.AI_REQUESTS_PER_IP_HOUR, 10) },
    { subject, seconds: 86400, maximum: ceiling(env.AI_REQUESTS_PER_IP_DAY, 50) },
    { subject: 'global', seconds: 86400, maximum: ceiling(env.AI_REQUESTS_PER_DAY, 200) }
  ].map(budget => ({ ...budget, start: now - now % budget.seconds }));
  try {
    const statements = budgets.map((budget, index) => {
      const previous = budgets[index - 1];
      const dependency = previous ? ` AND EXISTS(SELECT 1 FROM ai_request_limits
        WHERE subject=? AND window_start=? AND window_seconds=? AND last_request=?)` : '';
      const values = [budget.subject, budget.start, budget.seconds, requestId];
      if (previous) values.push(previous.subject, previous.start, previous.seconds, requestId);
      values.push(budget.maximum);
      return env.LOGS_DB.prepare(`INSERT INTO ai_request_limits(subject,window_start,window_seconds,used,last_request)
        SELECT ?,?,?,1,? WHERE 1=1${dependency}
        ON CONFLICT(subject,window_start,window_seconds) DO UPDATE SET used=used+1,last_request=excluded.last_request
        WHERE used<?`).bind(...values);
    });
    const results = await env.LOGS_DB.batch(statements);
    const denied = results.findIndex(result => !result.meta.changes);
    if (denied >= 0) {
      const budget = budgets[denied];
      return json({ success: false, requestId, error: { code: 'RATE_LIMITED',
        message: 'AI request limit reached. Please try again later.' } }, 429,
        { 'Retry-After': String(budget.start + budget.seconds - now) });
    }
    return null;
  } catch (error) {
    console.error(`[${requestId}] AI limit reservation failed`, error);
    return unavailable(requestId);
  }
}
function unavailable(requestId) {
  return json({ success: false, requestId, error: { code: 'AI_LIMITS_UNAVAILABLE',
    message: 'AI generation is temporarily unavailable. Please try again later.' } }, 503);
}
export async function pruneAILimits(env) {
  if (env.LOGS_DB) await env.LOGS_DB.prepare('DELETE FROM ai_request_limits WHERE window_start+window_seconds<?')
    .bind(Math.floor(Date.now() / 1000) - 86400).run();
}
