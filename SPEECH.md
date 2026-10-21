# Admin course speech

Generates private, reusable MP3 course media through the existing OpenAI Worker
secret and existing Cloudflare Access administrator identity. It does not change
the public app API keys, provider switcher, course JSON or publication state.
No new credential is required or returned.

## Authentication and access

Use the existing signed-in content-studio browser session at
`https://learnalertapp.com/admin`. Its existing server proxy forwards the verified
Access assertion to the API; do not copy tokens into scripts or the client bundle.

| Method | API path | Same-origin studio path | Purpose |
| --- | --- | --- | --- |
| GET | `/v1/admin/catalog/speech/studio` | `/admin/api/catalog/speech/studio` | Protected visible browser controls |
| GET | `/v1/admin/catalog/speech/status` | `/admin/api/catalog/speech/status` | Non-secret readiness and fixed profile |
| GET/POST | `/v1/admin/catalog/:id/speech/budgets` | `/admin/api/catalog/:id/speech/budgets` | List/create immutable run allowances |
| POST | `/v1/admin/catalog/:id/speech` | `/admin/api/catalog/:id/speech` | Generate or reuse one clip |
| GET | `/v1/admin/catalog/:id/speech/:requestHash` | `/admin/api/catalog/:id/speech/:requestHash` | Inspect durable request outcome |

Replace `:id` with the actual existing catalog ID, not a title. Writes require
JSON and `Origin: https://learnalertapp.com`, in addition to the existing valid
Access JWT. The app's shared API key is not an administrator credential. There
is no public unauthenticated speech route and no admin CORS permission.

Open [the speech studio](https://learnalertapp.com/admin/api/catalog/speech/studio)
after the normal administrator sign-in. Its visible controls use the existing
same-origin proxy; no website deployment or token copying is needed. If Access
blocks the page, complete its normal owner sign-in; it does not bypass it.

1. Inspect the exact current voice/profile and select an existing catalog item.
2. Select its already-approved run, or explicitly create one with the owner's
   reviewed allowance, request count and conservative per-request reservation.
   Amounts start blank. A one-time approval is not a permanent default allowance.
3. Enter the exact text and click **Generate MP3 using selected run** once.
4. Listen through the normal audio controls or **Download MP3**. New media stays
   private; cached media retains its publication status. No course is edited or
   published.

The static page loads no third-party assets. Existing Access protects the HTML
and JSON routes, and existing Origin/JSON checks still protect writes. A nonce
CSP is included both in headers and in HTML because the website proxy forwards
only a subset of headers. Controls are hidden without JavaScript and disabled
in frames. All returned text is rendered as text, not HTML.

Pending request text, catalog/run IDs and canonical hash are retained only in
this browser tab's session storage for recovery, never credentials. Reloading
does not resume generation. On a timeout, use **Check saved request status**,
not Generate again. A ready job returns its already-attached, same-catalog media.
If attachment was interrupted, **Recover completed saved media** requires a
ready status and exact current profile/hash, then makes a server-enforced
cache-only request. It cannot initiate paid generation. Uncertain/submitted
jobs cannot be cleared from the recovery view; clearing a completed view never
resets server records or reservations.

## Bounded runs, not an unverified billing guarantee

Fresh installation has **no allowance**, so no provider request can run. The
first authenticated speech operation initializes two additive bookkeeping tables
in the existing COMMUNITY_DB. Existing catalog data is untouched. New speech also
requires existing LOGS_DB and DECK_ASSETS bindings and OPENAI_API_KEY.

Before creating a run, the owner must approve its scope/count and spending
exposure and check the applicable provider billing limits and rate card. Example
**shape only**, not spending authorization or a suggested safe price:

```json
{
  "id": "owner-approved-run-id",
  "maxRequests": 5,
  "reservationBudgetUsd": 1,
  "reservationPerRequestUsd": 0.2,
  "acknowledgeEstimatedCost": true
}
```

POST this to the catalog's `/speech/budgets` route. These example amounts are
placeholders; use reviewed owner-approved figures. Amounts are USD with up to
six decimal places; each must be positive and at most 1,000. Count is 1–1,000.
Budgets are immutable, scoped to one catalog item and pinned to the configured
model. Repeating the same ID/settings is idempotent; changing settings under an
existing ID returns 409. Creating an allowance does not generate audio.

D1 atomically admits a new request only while both the run's hard request count
and its reserved-USD allowance permit it. Failed, pending and uncertain requests
retain their full reservations. There is no daily reset, automatic replenishment
or assumption that missing usage means zero cost. List budgets to inspect counts
and reserved totals. Cached reuse does not spend or consume an allowance.

**Reserved USD is not measured spend and is not an OpenAI billing hard cap.** The
binary Speech response does not provide billed token usage. A reservation is only
as conservative as the reviewed per-request exposure. Input limits, timeout and
response-byte limits do not themselves prove a dollar ceiling. Verify provider
controls separately; do not enable a run if its exposure cannot be bounded to the
owner's approval. Actual charges remain `null` pending external reconciliation.
Existing quotas additionally apply: 10/IP/hour, 50/IP/day and 200 global/day by
default, shared with other AI endpoints. TTS cannot use AI_LIMITS_DISABLED to skip
them. The studio proxy may share an IP quota, so these are not per-admin limits.

## Generate and reuse

```json
{ "input": "¡Hola! ¿Cómo estás?", "budgetId": "owner-approved-run-id" }
```

Input is preserved exactly, including accents, whitespace, case and punctuation.
Use at most 1,000 characters and 1,800 UTF-8 bytes per short clip. Unknown request
fields, arbitrary provider URLs and per-request profile overrides are rejected.

Optional `cacheOnly: true` on the generation route permits only an exact existing
recording; a missing cache returns 404 before budget/quota/provider work.
Non-boolean values are rejected. This is for recovery/reuse, not a retry flag.

Fixed defaults:

- model: `gpt-4o-mini-tts`
- voice: `cedar`
- instructions: `speak in a enounced, madrid spain accented, slowly like your a teacher teaching pronoucation.`
- response_format: `mp3`
- speed: `1`

`TTS_MODEL` is a server-only explicit model override. There is no automatic
provider/model/voice fallback. Existing AI_MODEL, AI_PROVIDER and AI_BASE_URL do
not change TTS. A model change requires a new reviewed allowance. `TTS_DISABLED=true`
is an optional emergency stop for new provider calls; cached files remain usable.
No new environment setting is necessary for this release's defaults.

Success returns HTTP 201 for new audio or 200 for reuse, with a real `id`,
`reference: "catalog:<UUID>"`, authenticated preview `url`, `contentType`,
`byteSize`, `requestHash`, `fileSha256`, exact request/provenance, `cached`,
`qaStatus: "pending"`, actual `published` status, `publicationChanged: false`, and nullable actual cost. New media is private; previously published cached media remains published. Download via
`/admin/api/catalog/media/<UUID>` while signed in. Store the returned reference
in a draft's supported audio field only after reviewing the audio. Do not invent
media UUIDs. Public media remains 404 until explicitly referenced by a published
catalog revision through the existing publish workflow.

The complete request is hashed with SHA-256 over compact, recursively key-sorted
UTF-8 JSON of `{provider:"OpenAI",endpoint:"https://api.openai.com/v1/audio/speech",body}`.
Use literal Unicode and JavaScript canonical numeric representation (`speed:1`,
not `1.0`) in other-language producers. Fixture for the exact defaults above and
input `¡Hola! ¿Cómo estás?`:
`f99a87816d424cb2079daf5303adb591d63ab3a87f382e442b45e03d7cc8492a`.
The hash excludes catalog/card IDs. Identical audio can be reused in another
catalog with its own private media UUID and owned R2 copy; it does not share a
foreign catalog's reference. Integrity checks compare saved bytes/size/hash.

## Failures, reconciliation and QA

- 401/403: existing admin authentication/origin rejected; no provider call.
- 400/409: invalid input, missing/conflicting allowance or model change.
- 429: existing AI quota or the run's count/reservation allowance exhausted.
- 409 TTS_IN_PROGRESS/TTS_BUSY: one global producer is running or a previous
  submitted/uncertain outcome requires reconciliation. No parallel paid request.
- 502 TTS_PROVIDER_REJECTED: OpenAI rejected the selected request; inspect its
  saved status. No upstream error body or credential is exposed.
- 503 TTS_OUTCOME_UNCERTAIN: timeout, output or persistence failure. Do not retry.

Every admitted request is durably marked submitted before the provider fetch.
Duplicate requests never cause another paid fetch, including after failures,
network loss or Worker termination. The initial version intentionally has no
automatic retries, stale-lock expiry, regeneration/retake button, or reset/delete
API. Do not change whitespace to circumvent a failed request's lock.

If reconciliation is needed, an authorized operator must check the job's
attempt/provider request IDs, provider billing evidence and any saved bytes
before deciding the next action. R2 originals at `catalog/speech/<hash>.mp3` are
retained after potential payment, even if catalog attachment/finalization fails.
A submitted or uncertain outcome blocks new generation globally; cached ready
assets still work. Failed HTTP outcomes retain their reservation and exact-hash
lock. No historical jobs or allowance rows are automatically pruned.

MP3 signature, byte count and SHA-256 checks are not complete decoding or quality
review. Full decode/duration/non-silence, transcript, Madrid pronunciation and
mobile playback review remain pending. Label the voice as AI-generated OpenAI
speech. Preserve readable Spanish transcripts and listening alternatives.
Generation never edits or publishes a course.

Provider reference: https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
Model lifecycle: verify availability before generating; do not silently replace
the owner's selected model if it becomes unavailable.

## Verification

`npm test` includes mocked provider tests for existing authentication/origin,
missing setup, strict input/profile, budget idempotency and caps, shared quotas,
concurrent duplicate/distinct requests, private ownership, cross-catalog cache
reuse, unchanged publication, rejected/uncertain outcomes and corrupt/missing
cache. No test uses real OpenAI credentials or generates paid audio.

`npm run test:studio` runs visible-control browser regressions with every network
request mocked, using local Chromium (`CHROMIUM_PATH` may override the executable).
It covers explicit allowances, exact text/hash, private downloads, uncertain reload
recovery, expired sign-in and profile changes. No real account or paid provider
is contacted. Set `STUDIO_SCREENSHOTS` to a local folder for mock desktop/mobile
screenshots. Install Chromium separately when not already present.
