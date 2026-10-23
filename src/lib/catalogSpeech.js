import { CommunityError, readCommunityJSON, readLimitedBody, validateMedia } from './communityValidation.js';
import { limitAIRequest } from './aiLimits.js';

export const SPEECH_INSTRUCTIONS = 'speak in a enounced, madrid spain accented, slowly like your a teacher teaching pronoucation.';
export const KOREAN_SPEECH_INSTRUCTIONS = 'Speak only the supplied Korean text in clear, natural standard South Korean pronunciation, slowly and carefully for a beginner learning Hangul. Do not translate, add an introduction, spell out Unicode characters, or add any other words. For an isolated consonant name, pronounce its Korean letter name exactly as supplied; for a syllable or word, pronounce its sound.';
export const SPEECH_MODEL = 'gpt-4o-mini-tts';
const endpoint = 'https://api.openai.com/v1/audio/speech';
const encoder = new TextEncoder();
const now = () => Math.floor(Date.now() / 1000);
const fail = (status, code, message) => { throw new CommunityError(status, message, code); };
const budgetPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const costNotice = 'USD reservations are conservative estimates, not measured charges or an OpenAI billing hard cap. Failed and uncertain requests retain their reservation. Verify provider billing limits separately.';

// Additive, idempotent initialization in the existing catalog database. No
// credential, binding, catalog revision, or publication is changed by setup.
export const speechSchema = [
  `CREATE TABLE IF NOT EXISTS catalog_speech_budgets (
    id TEXT PRIMARY KEY, catalog_id TEXT NOT NULL REFERENCES managed_catalog(id),
    model TEXT NOT NULL, maximum_requests INTEGER NOT NULL,
    budget_microusd INTEGER NOT NULL, reservation_microusd INTEGER NOT NULL,
    created_at INTEGER NOT NULL, actor TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS catalog_speech_jobs (
    request_hash TEXT PRIMARY KEY, request_json TEXT NOT NULL,
    budget_id TEXT NOT NULL REFERENCES catalog_speech_budgets(id),
    catalog_id TEXT NOT NULL REFERENCES managed_catalog(id),
    attempt_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL,
    reservation_microusd INTEGER NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, actor TEXT NOT NULL, object_key TEXT,
    file_sha256 TEXT, byte_size INTEGER, provider_request_id TEXT, error_code TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS catalog_speech_jobs_budget ON catalog_speech_jobs(budget_id)',
  'CREATE INDEX IF NOT EXISTS catalog_speech_jobs_state ON catalog_speech_jobs(state)'
];

async function storage(env) {
  if (!env.COMMUNITY_DB || !env.DECK_ASSETS || !env.LOGS_DB) fail(503, 'TTS_STORAGE_UNAVAILABLE', 'Speech storage or AI quota storage is unavailable.');
  try { await env.COMMUNITY_DB.batch(speechSchema.map(sql => env.COMMUNITY_DB.prepare(sql))); }
  catch { fail(503, 'TTS_STORAGE_UNAVAILABLE', 'Speech bookkeeping is unavailable. No audio request was submitted.'); }
}
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'TTS_INVALID_REQUEST', 'Unsupported speech request fields.');
}
function modelFor(env) {
  const model = env.TTS_MODEL || SPEECH_MODEL;
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(model)) fail(503, 'TTS_CONFIGURATION_ERROR', 'The configured speech model is invalid.');
  return model;
}
export function speechBody(input, env, language = 'Spanish') {
  // A tighter course-clip bound than the provider maximum. The byte bound also
  // keeps unusually token-dense Unicode comfortably below the model input limit.
  if (typeof input !== 'string' || !input.trim() || input.length > 1000 || encoder.encode(input).byteLength > 1800) fail(400, 'TTS_INPUT_TOO_LONG', 'Use 1–1,000 characters and at most 1,800 UTF-8 bytes. Split longer passages into short clips.');
  const korean = /^(korean|ko|ko-kr)$/i.test(language);
  const instructions = korean ? KOREAN_SPEECH_INSTRUCTIONS : /^(spanish|es|es-es)$/i.test(language)
    ? SPEECH_INSTRUCTIONS : `Speak only the supplied text in clear, natural ${language || 'original-language'} pronunciation, slowly for a beginner. Do not translate or add any other words.`;
  return { model: modelFor(env), voice: 'cedar', instructions, response_format: 'mp3', speed: 1, input };
}
function canonical(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return Array.isArray(value) ? value.map(canonical) : value;
}
export async function sha256(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function speechHash(body) { return sha256(JSON.stringify(canonical({ provider: 'OpenAI', endpoint, body }))); }
function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000) fail(400, 'TTS_INVALID_BUDGET', 'USD reservation amounts must be greater than zero and at most 1,000.');
  const amount = Math.round(value * 1_000_000);
  if (!amount || Math.abs(amount / 1_000_000 - value) > 1e-9) fail(400, 'TTS_INVALID_BUDGET', 'USD amounts support at most six decimal places.');
  return amount;
}
async function catalog(env, id, allowArchived = false) {
  const row = await env.COMMUNITY_DB.prepare('SELECT id,status,language FROM managed_catalog WHERE id=?').bind(id).first();
  if (!row) fail(404, 'TTS_CATALOG_NOT_FOUND', 'Catalog item not found.');
  if (row.status === 'archived' && !allowArchived) fail(409, 'TTS_CATALOG_ARCHIVED', 'Restore this catalog item before adding speech.');
  return row;
}
async function budgetSummary(db, row) {
  const usage = await db.prepare('SELECT COUNT(*) AS requests,COALESCE(SUM(reservation_microusd),0) AS reserved FROM catalog_speech_jobs WHERE budget_id=?').bind(row.id).first();
  return { id: row.id, catalogId: row.catalog_id, model: row.model, maxRequests: row.maximum_requests, requests: usage.requests,
    reservationBudgetUsd: row.budget_microusd / 1_000_000, reservedUsd: usage.reserved / 1_000_000,
    reservationPerRequestUsd: row.reservation_microusd / 1_000_000, actualCostUsd: null, costNotice };
}
function metadata(job) {
  const body = JSON.parse(job.request_json);
  return { requestHash: job.request_hash, budgetId: job.budget_id, attemptId: job.attempt_id, state: job.state,
    provider: 'OpenAI', requestedModel: body.model, resolvedModel: null, voice: body.voice,
    instructions: body.instructions, input: body.input, responseFormat: body.response_format, speed: body.speed,
    fileSha256: job.file_sha256, byteSize: job.byte_size, generatedAt: job.state === 'ready' ? job.updated_at : null,
    providerRequestId: job.provider_request_id, reservationUsd: job.reservation_microusd / 1_000_000,
    actualCostUsd: null, costStatus: 'unreconciled', qaStatus: 'pending', errorCode: job.error_code,
    disclosure: 'AI-generated OpenAI speech. Listening and pronunciation review required before publication.' };
}
async function jobFor(db, hash) { return db.prepare('SELECT * FROM catalog_speech_jobs WHERE request_hash=?').bind(hash).first(); }
async function mediaIdentity(catalogId, requestHash) {
  const digest = await sha256(`catalog-speech:${catalogId}:${requestHash}`);
  const id = `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
  return { id, key: `catalog/media/${catalogId}/${id}.mp3` };
}
async function materialize(env, catalogId, job, actor, cached) {
  if (job.state !== 'ready') fail(409, job.state === 'submitted' ? 'TTS_IN_PROGRESS' : 'TTS_RECONCILIATION_REQUIRED', 'This exact speech request was already submitted. Inspect its status; do not resubmit or change the text just to retry.');
  // Stable per-course IDs make concurrent cache reuse idempotent while retaining
  // the existing one-course-per-media ownership contract and unique R2 keys.
  const { id, key } = await mediaIdentity(catalogId, job.request_hash), db = env.COMMUNITY_DB;
  const existing = await db.prepare('SELECT * FROM managed_catalog_media WHERE id=?').bind(id).first();
  if (!existing) {
    const source = await env.DECK_ASSETS.get(job.object_key);
    if (!source) fail(503, 'TTS_AUDIO_UNAVAILABLE', 'Saved audio is unavailable. It will not be regenerated automatically.');
    const bytes = await source.arrayBuffer();
    if (bytes.byteLength !== job.byte_size || await sha256(bytes) !== job.file_sha256) fail(503,'TTS_CACHE_INVALID','Saved audio failed its integrity check. It will not be regenerated automatically.');
    await env.DECK_ASSETS.put(key, bytes, { httpMetadata: { contentType: 'audio/mpeg' }, customMetadata: { requestHash: job.request_hash, fileSha256: job.file_sha256 } });
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO managed_catalog_media(id,catalog_id,object_key,content_type,byte_size,created_at,actor) VALUES(?,?,?,?,?,?,?)').bind(id,catalogId,key,'audio/mpeg',job.byte_size,now(),actor),
      db.prepare(`INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) VALUES(?,?,?,?,?,?)`).bind(crypto.randomUUID(),actor,'catalog_speech_media',catalogId,JSON.stringify({mediaId:id,requestHash:job.request_hash,cached}),now())
    ]);
  } else if (existing.catalog_id !== catalogId || existing.object_key !== key) {
    fail(409, 'TTS_MEDIA_CONFLICT', 'Speech media ownership conflict.');
  }
  const asset = await env.DECK_ASSETS.get(key);
  if (!asset) fail(503,'TTS_AUDIO_UNAVAILABLE','The catalog audio is unavailable. It will not be regenerated automatically.');
  const assetBytes = await asset.arrayBuffer();
  if (assetBytes.byteLength !== job.byte_size || await sha256(assetBytes) !== job.file_sha256 || await speechHash(JSON.parse(job.request_json)) !== job.request_hash) fail(503,'TTS_CACHE_INVALID','Saved audio failed its integrity check. It will not be regenerated automatically.');
  const publication = await db.prepare("SELECT 1 FROM managed_catalog_public_media p JOIN managed_catalog c ON c.id=p.catalog_id WHERE p.media_id=? AND c.status='published' AND c.published_key IS NOT NULL LIMIT 1").bind(id).first();
  return { status: cached ? 200 : 201, body: { id, reference: `catalog:${id}`, url: `https://api.learnalertapp.com/v1/admin/catalog/media/${id}`,
    contentType: 'audio/mpeg', byteSize: job.byte_size, cached, published: Boolean(publication), publicationChanged: false, ...metadata(job) } };
}
async function updateJob(db, hash, state, errorCode, providerRequestId = null) {
  await db.prepare('UPDATE catalog_speech_jobs SET state=?,error_code=?,provider_request_id=COALESCE(?,provider_request_id),updated_at=? WHERE request_hash=? AND state=\'submitted\'').bind(state,errorCode,providerRequestId,now(),hash).run();
}

// Called only AFTER adminCatalog has verified the existing signed Access JWT,
// allowed administrator, same origin and JSON content type.
export async function catalogSpeech(request, env, actor, catalogId, action, hash) {
  const db = env.COMMUNITY_DB;
  const item = catalogId ? await catalog(env,catalogId,request.method === 'GET') : null;
  const language = item?.language || 'Spanish';
  if (action === 'status') return { body: { configured: Boolean(env.OPENAI_API_KEY), disabled: env.TTS_DISABLED === 'true',
    catalogId: catalogId || null, language, model: modelFor(env), voice: 'cedar', instructions: speechBody('profile',env,language).instructions, responseFormat: 'mp3',
    maxInputCharacters: 1000, maxInputBytes: 1800, requiresBudget: true, costNotice } };
  await storage(env);
  if (action === 'budgets') {
    if (request.method === 'GET') {
      const rows = (await db.prepare('SELECT * FROM catalog_speech_budgets WHERE catalog_id=? ORDER BY created_at DESC,id').bind(catalogId).all()).results;
      return { body: { items: await Promise.all(rows.map(row => budgetSummary(db,row))) } };
    }
    const body = await readCommunityJSON(request,false,8192);
    fields(body,['id','maxRequests','reservationBudgetUsd','reservationPerRequestUsd','acknowledgeEstimatedCost']);
    if (typeof body.id !== 'string' || !budgetPattern.test(body.id) || !Number.isSafeInteger(body.maxRequests) || body.maxRequests < 1 || body.maxRequests > 1000 || body.acknowledgeEstimatedCost !== true) fail(400,'TTS_INVALID_BUDGET','Provide a stable budget ID, maxRequests of 1–1,000 and acknowledgeEstimatedCost: true.');
    const total = money(body.reservationBudgetUsd), reservation = money(body.reservationPerRequestUsd);
    if (reservation > total) fail(400,'TTS_INVALID_BUDGET','The per-request reservation exceeds the run reservation budget.');
    const model = modelFor(env), stamp = now();
    const results = await db.batch([
      db.prepare(`INSERT INTO catalog_speech_budgets(id,catalog_id,model,maximum_requests,budget_microusd,reservation_microusd,created_at,actor) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(body.id,catalogId,model,body.maxRequests,total,reservation,stamp,actor),
      db.prepare(`INSERT INTO community_admin_audit(id,actor,action,target,details,created_at) SELECT ?,?,'catalog_speech_budget',?,?,? WHERE changes()=1`).bind(crypto.randomUUID(),actor,catalogId,JSON.stringify({budgetId:body.id,model,maxRequests:body.maxRequests,reservationBudgetUsd:body.reservationBudgetUsd,reservationPerRequestUsd:body.reservationPerRequestUsd}),stamp)
    ]);
    const result = results[0];
    const row = await db.prepare('SELECT * FROM catalog_speech_budgets WHERE id=?').bind(body.id).first();
    if (row.catalog_id !== catalogId || row.model !== model || row.maximum_requests !== body.maxRequests || row.budget_microusd !== total || row.reservation_microusd !== reservation) fail(409,'TTS_BUDGET_CONFLICT','This budget ID already exists with different settings. Budgets are immutable.');
    return { status: result.meta.changes ? 201 : 200, body: { budget: await budgetSummary(db,row) } };
  }
  if (action === 'job') {
    if (!hashPattern.test(hash)) fail(404,'TTS_NOT_FOUND','Speech request not found.');
    const job = await jobFor(db,hash);
    if (!job) fail(404,'TTS_NOT_FOUND','Speech request not found.');
    const { id } = await mediaIdentity(catalogId, job.request_hash);
    const row = await db.prepare('SELECT id,content_type,byte_size FROM managed_catalog_media WHERE id=? AND catalog_id=?').bind(id,catalogId).first();
    const media = row ? { id:row.id, reference:`catalog:${row.id}`, url:`https://api.learnalertapp.com/v1/admin/catalog/media/${row.id}`, contentType:row.content_type, byteSize:row.byte_size } : null;
    return { body: { ...metadata(job), media, costNotice } };
  }
  const body = await readCommunityJSON(request,false,8192);
  fields(body,['input','budgetId','cacheOnly']);
  if (body.cacheOnly !== undefined && typeof body.cacheOnly !== 'boolean') fail(400,'TTS_INVALID_REQUEST','cacheOnly must be a boolean.');
  const speech = speechBody(body.input,env,language), requestHash = await speechHash(speech);
  const previous = await jobFor(db,requestHash);
  if (previous) return materialize(env,catalogId,previous,actor,true);
  if (body.cacheOnly === true) fail(404,'TTS_CACHE_MISS','No completed recording is cached for this exact profile and text. Recovery never generates audio.');
  if (env.TTS_DISABLED === 'true') fail(503,'TTS_DISABLED','New speech generation is disabled. Saved audio remains available.');
  if (!env.OPENAI_API_KEY) fail(503,'TTS_NOT_CONFIGURED','The existing OpenAI API key binding is unavailable.');
  if (typeof body.budgetId !== 'string' || !budgetPattern.test(body.budgetId)) fail(400,'TTS_BUDGET_REQUIRED','Create an approved bounded speech budget and provide its budgetId.');
  const budget = await db.prepare('SELECT * FROM catalog_speech_budgets WHERE id=? AND catalog_id=?').bind(body.budgetId,catalogId).first();
  if (!budget) fail(409,'TTS_BUDGET_REQUIRED','No speech allowance exists for this catalog item and budget ID.');
  if (budget.model !== speech.model) fail(409,'TTS_MODEL_CHANGED','The configured model differs from this budget. Review pricing and create a new approved budget; no model substitution was made.');
  // Do not allow the development opt-out to bypass production TTS rate limits.
  const limited = await limitAIRequest(request,{...env,AI_LIMITS_DISABLED:'false',
    AI_REQUESTS_PER_IP_HOUR:env.TTS_REQUESTS_PER_IP_HOUR || env.AI_REQUESTS_PER_IP_HOUR,
    AI_REQUESTS_PER_IP_DAY:env.TTS_REQUESTS_PER_IP_DAY || env.AI_REQUESTS_PER_IP_DAY},crypto.randomUUID());
  if (limited) return { status: limited.status, body: await limited.json(), retryAfter: limited.headers.get('Retry-After') };
  const stamp = now(), attempt = crypto.randomUUID();
  // One atomic D1 statement serializes duplicate/hash, global single-flight,
  // count and reservation checks across isolates. Reservations never auto-expire.
  const result = await db.prepare(`INSERT INTO catalog_speech_jobs(request_hash,request_json,budget_id,catalog_id,attempt_id,state,reservation_microusd,created_at,updated_at,actor)
    SELECT ?,?,?,?,?, 'submitted',?,?,?,? FROM catalog_speech_budgets b WHERE b.id=? AND b.catalog_id=?
    AND (SELECT COUNT(*) FROM catalog_speech_jobs WHERE budget_id=b.id)<b.maximum_requests
    AND (SELECT COALESCE(SUM(reservation_microusd),0) FROM catalog_speech_jobs WHERE budget_id=b.id)+b.reservation_microusd<=b.budget_microusd
    AND NOT EXISTS(SELECT 1 FROM catalog_speech_jobs WHERE state IN ('submitted','uncertain'))
    ON CONFLICT(request_hash) DO NOTHING`).bind(requestHash,JSON.stringify(speech),budget.id,catalogId,attempt,budget.reservation_microusd,stamp,stamp,actor,budget.id,catalogId).run();
  if (!result.meta.changes) {
    const duplicate = await jobFor(db,requestHash);
    if (duplicate) return materialize(env,catalogId,duplicate,actor,true);
    if (await db.prepare("SELECT 1 FROM catalog_speech_jobs WHERE state IN ('submitted','uncertain') LIMIT 1").first()) fail(409,'TTS_BUSY','Another speech request is in progress or awaiting reconciliation.');
    fail(429,'TTS_BUDGET_EXHAUSTED','This speech run has reached its request or reserved-cost allowance.');
  }
  let providerRequestId = null;
  try {
    const response = await fetch(endpoint,{ method:'POST', redirect:'manual', signal:AbortSignal.timeout(120_000),
      headers:{ Authorization:`Bearer ${env.OPENAI_API_KEY}`, 'Content-Type':'application/json', 'X-Client-Request-Id':attempt }, body:JSON.stringify(speech) });
    const upstreamId = response.headers.get('x-request-id');
    providerRequestId = upstreamId && /^[a-zA-Z0-9_-]{1,200}$/.test(upstreamId) ? upstreamId : null;
    if (!response.ok) {
      // Never echo/log the upstream body; it may contain request data. Do not
      // automatically retry even 429/5xx: billing/execution could be uncertain.
      await response.body?.cancel();
      await updateJob(db,requestHash,'failed',`UPSTREAM_${response.status}`,providerRequestId);
      fail(502,'TTS_PROVIDER_REJECTED','OpenAI rejected the selected speech request. Check model access/billing and the saved request status. No fallback or automatic retry was attempted.');
    }
    if (!['audio/mpeg','audio/mp3','application/octet-stream'].includes((response.headers.get('Content-Type') || '').split(';')[0].toLowerCase())) throw new Error('Unexpected audio response');
    const bytes = await readLimitedBody(response,20*1024*1024);
    validateMedia(bytes,'audio/mpeg');
    const fileHash = await sha256(bytes), key = `catalog/speech/${requestHash}.mp3`;
    await env.DECK_ASSETS.put(key,bytes,{ httpMetadata:{contentType:'audio/mpeg'}, customMetadata:{requestHash,fileSha256:fileHash,attemptId:attempt} });
    await db.prepare("UPDATE catalog_speech_jobs SET state='ready',object_key=?,file_sha256=?,byte_size=?,provider_request_id=?,updated_at=? WHERE request_hash=? AND attempt_id=? AND state='submitted'").bind(key,fileHash,bytes.length,providerRequestId,now(),requestHash,attempt).run();
  } catch (error) {
    if (error instanceof CommunityError && error.code === 'TTS_PROVIDER_REJECTED') throw error;
    // Keep the exact request and cost reservation. A timeout or storage error
    // cannot prove the provider did not charge. No logs contain keys or text.
    try { await updateJob(db,requestHash,'uncertain','TTS_OUTCOME_UNCERTAIN',providerRequestId); } catch { /* submitted still fails closed */ }
    fail(503,'TTS_OUTCOME_UNCERTAIN','The speech request outcome needs reconciliation. Saved bytes may exist; do not retry. The cost reservation is retained.');
  }
  return materialize(env,catalogId,await jobFor(db,requestHash),actor,false);
}
