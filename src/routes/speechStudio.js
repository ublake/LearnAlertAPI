// Static UI only. The existing catalog router verifies Access before serving it.
// A meta CSP survives the existing website proxy's limited header forwarding.
const CLIENT_SCRIPT = String.raw`
if (window.top !== window.self) {
  document.getElementById('message').textContent = 'Open the speech studio directly in its own tab. Generation is unavailable inside a frame.';
  throw new Error('Framed speech studio is disabled.');
}
document.getElementById('studio-controls').hidden = false;
const el = id => document.getElementById(id);
const api = '/admin/api/catalog';
let profile, budgets = [], pending = null, busy = false, selectionVersion = 0;
const readPending = () => { try { return JSON.parse(sessionStorage.getItem('learnalert-speech-pending') || 'null'); } catch { return null; } };
const savePending = value => {
  try { value ? sessionStorage.setItem('learnalert-speech-pending', JSON.stringify(value)) : sessionStorage.removeItem('learnalert-speech-pending'); }
  catch { if (value) throw new Error('Browser recovery storage is unavailable. No audio was submitted. Enable session storage before generating.'); }
  pending = value; renderPending();
};
function say(message, error = false) { el('message').textContent = message; el('message').className = error ? 'notice error' : 'notice'; }
function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll('button')) button.disabled = value;
  el('catalog').disabled = value;
  el('budget').disabled = value;
  el('input').disabled = value;
}
function renderPending() {
  el('recovery').hidden = !pending;
  if (pending) el('request-hash').textContent = pending.hash;
}
async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 135000);
  try {
    const response = await fetch(api + path, { ...options, credentials: 'same-origin', redirect: 'error', signal: controller.signal,
      headers: { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) } });
    if (!(response.headers.get('Content-Type') || '').includes('application/json')) throw new Error('Sign-in may have expired. Open the admin studio, sign in, then check the saved request status. Do not generate again.');
    const body = await response.json();
    if (!response.ok) {
      const error = new Error(body.error?.message || 'Request failed.');
      error.code = body.error?.code || ''; error.status = response.status; throw error;
    }
    return body;
  } finally { clearTimeout(timer); }
}
function currentCatalog() {
  const id = el('catalog').value;
  if (!id) throw new Error('Select an existing catalog item.');
  return id;
}
function pathFor(id) { return '/' + encodeURIComponent(id) + '/speech'; }
function showBudget() {
  const row = budgets.find(item => item.id === el('budget').value);
  el('budget-summary').textContent = row
    ? row.requests + ' / ' + row.maxRequests + ' requests used. USD ' + row.reservedUsd.toFixed(6) + ' reserved of ' + row.reservationBudgetUsd.toFixed(6) + '. Actual billed cost: unknown.'
    : 'Select an existing approved run, or create one below. Do not create a new run to reset an existing allowance.';
}
async function loadBudgets(preferred = '') {
  const id = currentCatalog(), version = ++selectionVersion;
  const data = await request(pathFor(id) + '/budgets');
  if (version !== selectionVersion || id !== el('catalog').value) return;
  budgets = data.items;
  el('budget').replaceChildren(new Option('Select approved run', ''));
  for (const row of budgets) el('budget').add(new Option(row.id, row.id));
  if (budgets.some(row => row.id === preferred)) el('budget').value = preferred;
  showBudget();
}
function canonical(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
async function hashRequest(input, selectedProfile = profile) {
  const body = { model: selectedProfile.model, voice: selectedProfile.voice, instructions: selectedProfile.instructions, response_format: selectedProfile.responseFormat, speed: 1, input };
  const value = JSON.stringify(canonical({ provider:'OpenAI', endpoint:'https://api.openai.com/v1/audio/speech', body }));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2,'0')).join('');
}
function showResult(result) {
  const media = result.media || (result.id ? result : null);
  el('result').hidden = false;
  el('provenance').textContent = JSON.stringify(result, null, 2);
  el('audio').removeAttribute('src');
  el('download').hidden = true;
  if (media && /^[a-f0-9-]{36}$/i.test(media.id)) {
    const url = api + '/media/' + encodeURIComponent(media.id);
    el('audio').src = url;
    el('download').href = url;
    el('download').download = 'learnalert-cedar-' + result.requestHash + '.mp3';
    el('download').hidden = false;
  }
  el('audio').hidden = !media;
}
async function run(action) {
  if (busy) return;
  setBusy(true);
  try { await action(); }
  catch (error) {
    say(error.name === 'AbortError' ? 'The request timed out. It may still have completed. Check the saved request status; do not generate again.' : error.message, true);
  } finally { setBusy(false); }
}
el('catalog').addEventListener('change', () => run(async () => {
  el('result').hidden = true;
  profile = await request(pathFor(currentCatalog()) + '/status');
  el('profile').textContent = JSON.stringify(profile, null, 2);
  el('input').placeholder = 'Enter the exact ' + profile.language + ' text to speak.';
  await loadBudgets();
  say('Catalog selected. Generation only happens when you click Generate MP3.');
}));
el('budget').addEventListener('change', showBudget);
el('refresh-budgets').addEventListener('click', () => run(async () => { await loadBudgets(el('budget').value); say('Allowance status refreshed. No audio generated.'); }));
el('create-budget').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    const id = currentCatalog();
    const body = { id:el('budget-id').value, maxRequests:Number(el('max-requests').value),
      reservationBudgetUsd:Number(el('budget-usd').value), reservationPerRequestUsd:Number(el('per-request-usd').value),
      acknowledgeEstimatedCost:el('cost-ack').checked };
    const result = await request(pathFor(id) + '/budgets', { method:'POST', body:JSON.stringify(body) });
    await loadBudgets(result.budget.id);
    say('Bounded run saved. No audio generated. Keep using this run for the whole approved allowance.');
  });
});
el('generate-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    if (!profile?.configured || profile.disabled) throw new Error('New speech generation is not available.');
    if (pending) throw new Error('Check or clear the saved request first. Do not repeat an uncertain submission.');
    const catalogId = currentCatalog(), budgetId = el('budget').value, input = el('input').value;
    if (!budgetId) throw new Error('Select an approved bounded run.');
    if (!input.trim() || input.length > 1000 || new TextEncoder().encode(input).byteLength > 1800) throw new Error('Use 1–1,000 characters and at most 1,800 UTF-8 bytes.');
    const hash = await hashRequest(input);
    savePending({catalogId,budgetId,input,hash,model:profile.model});
    say('Generating one clip. Do not close this page or repeat the request.');
    const result = await request(pathFor(catalogId), {method:'POST',body:JSON.stringify({input,budgetId})});
    showResult(result);
    savePending(null);
    await loadBudgets(budgetId);
    say(result.cached ? 'Reused saved audio. No new provider call. Review the audio before publication.' : 'MP3 saved privately. Listening and pronunciation review are still required.');
  });
});
el('check-status').addEventListener('click', () => run(async () => {
  if (!pending) return;
  const result = await request(pathFor(pending.catalogId) + '/' + pending.hash);
  showResult(result);
  say(result.state === 'ready' ? 'Saved audio is ready. If no download appears, use Recover saved media. No generation retry is needed.' : 'Saved state: ' + result.state + '. Do not retry an uncertain or failed request.');
  el('recover-media').hidden = result.state !== 'ready' || Boolean(result.media);
}));
el('recover-media').addEventListener('click', () => run(async () => {
  if (!pending) throw new Error('No saved request to recover.');
  const savedProfile = await request(pathFor(pending.catalogId) + '/status');
  if (savedProfile.model !== pending.model || await hashRequest(pending.input, savedProfile) !== pending.hash) throw new Error('The speech profile changed. Stop and review this saved request.');
  const status = await request(pathFor(pending.catalogId) + '/' + pending.hash);
  if (status.state !== 'ready') throw new Error('Only a completed cached recording can be recovered.');
  const result = await request(pathFor(pending.catalogId), {method:'POST',body:JSON.stringify({input:pending.input,budgetId:pending.budgetId,cacheOnly:true})});
  if (!result.cached) throw new Error('Unexpected recovery result. Stop and inspect the request.');
  showResult(result); savePending(null); el('recover-media').hidden = true;
  say('Existing saved MP3 attached. No new provider request was needed.');
}));
el('clear-recovery').addEventListener('click', () => run(async () => {
  if (!pending) return;
  try {
    const status = await request(pathFor(pending.catalogId) + '/' + pending.hash);
    if (status.state !== 'ready' && status.state !== 'failed') throw new Error('This request is still in progress or uncertain. Keep it for reconciliation.');
  } catch (error) { if (error.status !== 404) throw error; }
  savePending(null); el('recover-media').hidden = true;
  say('Recovery view cleared. Its server record and reserved costs were not reset.');
}));
el('input').addEventListener('input', () => { el('input-count').textContent = el('input').value.length + ' characters; ' + new TextEncoder().encode(el('input').value).byteLength + ' UTF-8 bytes.'; });
run(async () => {
  if (location.origin !== 'https://learnalertapp.com') throw new Error('Open this page through https://learnalertapp.com/admin/api/catalog/speech/studio after signing in.');
  profile = await request('/speech/status');
  el('profile').textContent = JSON.stringify(profile, null, 2);
  const catalog = await request('');
  for (const item of catalog.items.filter(item => item.status !== 'archived')) el('catalog').add(new Option(item.title + ' (' + item.id + ')', item.id));
  const remembered = readPending();
  if (remembered && typeof remembered.catalogId === 'string' && /^[a-f0-9]{64}$/.test(remembered.hash || '')) savePending(remembered);
  say(pending ? 'A previous request needs a status check. No generation was resumed.' : 'Ready. Select a course and its approved run. No audio is generated automatically.');
});
`;
const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-__NONCE__'; style-src 'nonce-__NONCE__'; connect-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'">
<title>LearnAlert · Course speech studio</title>
<style nonce="__NONCE__">
:root{font-family:system-ui,sans-serif;color:#172033;background:#f4f6fb;line-height:1.5}
body{max-width:980px;margin:0 auto;padding:28px 20px 70px}h1{font-size:2rem;margin-bottom:6px}h2{font-size:1.2rem}
a{color:#234fd4}section,details{background:#fff;border:1px solid #dce2ef;border-radius:14px;padding:20px;margin-top:18px}
label{display:block;font-weight:600;margin:14px 0 6px}input,select,textarea,button{font:inherit;box-sizing:border-box}
input:not([type=checkbox]),select,textarea{width:100%;padding:10px;border:1px solid #aab5ca;border-radius:7px;background:#fff;color:#172033}
textarea{min-height:140px;resize:vertical}button,.download{display:inline-block;padding:10px 15px;border-radius:8px;border:1px solid #234fd4;background:#234fd4;color:white;cursor:pointer;margin:12px 8px 0 0;text-decoration:none}
button.secondary{background:#fff;color:#234fd4}button:disabled{opacity:.55;cursor:wait}.notice{padding:14px;border-radius:8px;background:#eaf0ff}.error{background:#ffecec;color:#8a1820}
.small{color:#4c5c75;font-size:.92rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem;background:#f6f8fc;padding:12px;border-radius:8px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}audio{width:100%;margin-top:15px}[hidden]{display:none!important}.check{font-weight:400}summary{font-weight:700;cursor:pointer}
@media(max-width:600px){.grid{grid-template-columns:1fr}body{padding:20px 12px}section,details{padding:16px}}
</style>
</head>
<body>
<a href="/admin">← Back to content studio</a>
<h1>Course speech studio</h1>
<p>Generate one private MP3 at a time using the existing administrator sign-in. No audio is generated automatically.</p>
<p id="message" class="notice" role="status" aria-live="polite">Checking speech configuration…</p>
<noscript>JavaScript is required for visible, explicit speech actions. No audio will be generated.</noscript>
<main id="studio-controls" hidden>
<details><summary>Current voice profile and limits</summary><pre id="profile">Loading…</pre></details>
<section>
<h2>1. Select the course and approved run</h2>
<label for="catalog">Catalog item</label><select id="catalog"><option value="">Select a course or exam deck</option></select>
<label for="budget">Existing approved run</label><select id="budget"><option value="">Select approved run</option></select>
<p id="budget-summary" class="small">Choose a catalog item to load its existing allowances.</p>
<button id="refresh-budgets" class="secondary" type="button">Refresh allowance status</button>
<details>
<summary>Create a new bounded run only with owner approval</summary>
<p>Keep the same run for the entire approved allowance, including failed attempts and retakes. Do not create another run to reset its limit.</p>
<p class="notice">USD reservations are estimates, not actual billed charges or an OpenAI billing hard cap. Verify provider controls and a defensible per-request exposure before starting. No credits are purchased here.</p>
<form id="create-budget">
<label for="budget-id">Stable run ID</label><input id="budget-id" required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}" maxlength="64" placeholder="approved-spanish-pilot">
<div class="grid">
<div><label for="budget-usd">Approved total reservation allowance (USD)</label><input id="budget-usd" required type="number" min="0.000001" max="1000" step="0.000001" placeholder="Enter the approved amount"></div>
<div><label for="max-requests">Maximum new provider requests</label><input id="max-requests" required type="number" min="1" max="1000" step="1" placeholder="Enter the approved count"></div>
</div>
<label for="per-request-usd">Conservative reservation per request (USD)</label><input id="per-request-usd" required type="number" min="0.000001" max="1000" step="0.000001" placeholder="Use a reviewed exposure amount, not a quoted price">
<label class="check"><input id="cost-ack" type="checkbox" required> The owner approved this specific run. I understand reserved USD is not verified billed spend and failed/uncertain requests retain their reservation.</label>
<button type="submit">Create bounded run (no audio yet)</button>
</form>
</details>
</section>
<section>
<h2>2. Generate one clip</h2>
<form id="generate-form">
<label for="input">Exact spoken text</label><textarea id="input" required maxlength="1000" spellcheck="false" placeholder="Enter the exact Spanish text, including accents and punctuation."></textarea>
<p id="input-count" class="small">Maximum 1,000 characters and 1,800 UTF-8 bytes. No automatic retries or fallback voice.</p>
<button id="generate-button" type="submit">Generate MP3 using selected run</button>
</form>
</section>
<section id="recovery" hidden>
<h2>Saved request recovery</h2>
<p>Check this request before submitting anything again. Reloading this page never resumes generation automatically.</p>
<pre id="request-hash"></pre>
<button id="check-status" type="button">Check saved request status</button>
<button id="recover-media" type="button" hidden>Recover completed saved media</button>
<button id="clear-recovery" class="secondary" type="button">Clear completed recovery view</button>
</section>
<section id="result" hidden>
<h2>Audio and provenance</h2>
<p>AI-generated OpenAI speech. Listen for completeness and pronunciation before using it. Generation does not edit or publish a course.</p>
<audio id="audio" controls preload="none" hidden></audio>
<a id="download" class="download" hidden>Download MP3</a>
<details><summary>Result details and catalog reference</summary><pre id="provenance"></pre></details>
</section>
</main>
<script nonce="__NONCE__">__SCRIPT__</script>
</body></html>`;

export function speechStudio() {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;
  return new Response(HTML.replaceAll('__NONCE__', nonce).replace('__SCRIPT__', CLIENT_SCRIPT), { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': policy, 'Referrer-Policy': 'no-referrer'
  } });
}
