# LearnAlert API

Turns study material — a PDF, a photo of a page, or pasted notes — into a deck
of flashcards, then lets the user chat with it to refine them.

Cloudflare Worker. No database, no sessions: every request carries everything
it needs.

---

## How it fits together

```
        ┌─────────────────────────────────────────────┐
        │  A 200-page textbook? Narrow it down first.  │
        └─────────────────────────────────────────────┘
                              │
                    POST /v1/sources/outline
                    "which pages are Módulo 3?"
                              │
                              ▼
          ┌───────────────────────────────────┐
          │   Upload the pages you care about  │
          └───────────────────────────────────┘
                              │
                    POST /v1/decks/generate
                              │
                              ▼
                     ┌────────────────┐
                     │   A deck of    │
                     │  1–200 cards   │
                     └────────────────┘
                              │
                    POST /v1/decks/refine
              "make these harder" · "add 10 more"
                              │
                              ▼
                     ┌────────────────┐
                     │  Updated deck  │
                     └────────────────┘
```

---

## Endpoints

| Method | Path | Give it | Get back |
| --- | --- | --- | --- |
| `GET` | `/` | — | Health, and which AI providers are live |
| `GET` | `/logs` | — | Every call: tokens, status, provider, cost |
| `POST` | `/v1/sources/outline` | The first ~240 chars of each page | Section list with page ranges |
| `POST` | `/v1/decks/generate` | A file **or** text | A deck, or a chat reply |
| `POST` | `/v1/decks/refine` | A deck + an instruction | The updated deck, or a chat reply |
| `POST` | `/generate-quiz` | Text | Legacy shape, kept for the old app |

**You only need `/v1/decks/generate` and `/v1/decks/refine` to build the whole
app.** The other two are optimisations for large documents.

---

## Quick start

Make a deck from notes:

```bash
curl -X POST https://api.learnalertapp.com/v1/decks/generate \
  -H 'Content-Type: application/json' \
  -d '{ "text": "la mesa = table\nla silla = chair", "maxCards": 20 }'
```

Make a deck from a PDF:

```bash
curl -X POST https://api.learnalertapp.com/v1/decks/generate \
  -F 'file=@SpanishModule.pdf' \
  -F 'maxCards=50'
```

Then chat with it:

```bash
curl -X POST https://api.learnalertapp.com/v1/decks/refine \
  -H 'Content-Type: application/json' \
  -d '{ "deck": { ... }, "instruction": "Make these harder." }'
```

---

## The one thing to understand

Every response has an **`action`**, and it is either a deck or a conversation:

```json
{ "action": "deck", "assistantMessage": "Created 50 cards.", "deck": { ... } }
{ "action": "chat", "assistantMessage": "Hi! What are you studying?", "deck": null }
```

The AI decides. Say "hello" and you get `chat`. Send a vocabulary list and you
get `deck`. **Branch on `action`** — never assume a deck came back.

---

## Deck shape

```json
{
  "success": true,
  "requestId": "uuid",
  "action": "deck",
  "assistantMessage": "Created 50 cards covering...",
  "deck": {
    "title": "Spanish Lesson 3",
    "subject": "Spanish",
    "deckKind": "language_learning",
    "detectedLanguage": "es",
    "summary": "Subject pronouns and present-tense ser",
    "cards": [ ... ]
  },
  "droppedCards": [],
  "meta": { "provider": "openai", "model": "gpt-5.6-luna", "usage": { ... } }
}
```

`droppedCards` lists cards that failed validation and were skipped — the rest of
the deck is still good.

### Cards

All four types share one shape, so decode them into one struct. Unused fields
come back empty, never missing.

| Type | Uses | Empty |
| --- | --- | --- |
| `tap_reveal` | `prompt`, `answer` | `options`, `matchingPairs` |
| `multiple_choice` | `options` (exactly 4), `correctAnswerIndex` | `matchingPairs` |
| `matching` | `matchingPairs` (2–4) | `options` |
| `fill_blank` | `prompt` with one `____`, `answer` | `options`, `matchingPairs` |

```json
{
  "id": "uuid",
  "type": "multiple_choice",
  "prompt": "Which pronoun is formal?",
  "answer": "usted",
  "hint": "Used with strangers",
  "options": ["tú", "usted", "vos", "vosotros"],
  "correctAnswerIndex": 1,
  "matchingPairs": [],
  "tags": ["pronouns"],
  "sourceLocator": "p. 15"
}
```

Empty means `options: []`, `correctAnswerIndex: -1`, `matchingPairs: []`.

---

## Endpoint details

### POST /v1/decks/generate

Two ways to send material.

**JSON** — pasted notes:

| Field | Notes |
| --- | --- |
| `text` | **required**, max 300,000 chars |
| `maxCards` | 1–200, default 50 |
| `mode` | `auto` · `language` · `exam` · `mixed` |
| `difficulty` | `auto` · `easy` · `medium` · `hard` |
| `languageDirection` | `auto` · `target_to_english` · `english_to_target` · `mixed` |
| `preferredCardTypes` | array of the four card types |
| `chatHistory` | prior turns, `{ role, content }` |
| `userInstruction` | max 2,000 chars |
| `sourceName` | max 200 chars |

**multipart/form-data** — a file. Same fields, plus `file`. Arrays may be JSON
strings or comma-separated. Supported: PDF, TXT, MD, RTF, DOCX, PPTX, PNG, JPG,
WEBP. Max **8 MB**.

A file response also includes `source` with the name, MIME type and byte size.

### POST /v1/decks/refine

| Field | Notes |
| --- | --- |
| `deck` | **required**, the full current deck |
| `instruction` | **required**, max 2,000 chars — *only the user's new message* |
| `chatHistory` | prior turns; last 12 kept, 1,500 chars each |
| `sourceText` | optional source material |
| `maxCards` | 1–200 |

Always returns the **complete** deck, not a patch. Existing card IDs are kept
where possible.

To refine against the original document, resend it as `multipart/form-data`
with a `file` field. There is no server-side copy to point at.

> `instruction` is the user's message and nothing else. Putting prompt
> templates or prior turns in it wastes tokens every turn and breaks at 2,000
> characters.

### POST /v1/sources/outline

Finds module and chapter boundaries so a user can study one section instead of
a whole textbook. Send **only the opening lines of each page**, never the file.

```json
{
  "sourceName": "Spanish 101",
  "pages": [
    { "index": 0, "snippet": "Table of Contents" },
    { "index": 1, "snippet": "Módulo 1: Saludos" }
  ]
}
```

```json
{
  "pageCount": 200,
  "sections": [
    { "title": "Módulo 1: Saludos", "kind": "module",
      "startPage": 1, "endPage": 10, "pageCount": 10,
      "summary": "Greetings and introductions" }
  ]
}
```

Pages are **zero-based**, matching PDFKit. Ranges come back sorted, non-
overlapping and clamped. `kind` is `module` · `chapter` · `section` ·
`front_matter` · `back_matter` · `other`. Max 1,000 pages.

> Try `PDFDocument.outlineRoot` first — most textbooks carry their own bookmark
> tree, which gives you exact sections for free. This endpoint is the fallback.


## Errors

```json
{ "success": false, "requestId": "uuid",
  "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Bad request. Do not retry. |
| `INVALID_JSON` | 400 | Malformed body. |
| `UNAUTHORIZED` | 401 | Missing or invalid API key. |
| `AI_INVALID_OUTPUT` | 502 | Model returned unusable content. Retry may work. |
| `AI_REQUEST_FAILED` | 4xx/502 | Upstream provider failed. |
| `INTERNAL_ERROR` | 500 | A bug here. Report it with the `requestId`. |
| `NOT_FOUND` | 404 | Unknown route. |

Check `success` first. A 200 with `action: "chat"` is a success.

### Debugging

Set a `DEBUG_TOKEN` secret and send `X-Debug-Token`. Error responses then
include `error.details` — token counts, upstream payloads, field lengths:

```json
"error": { "code": "VALIDATION_ERROR",
           "message": "instruction is too long: 2,027 characters, maximum is 2,000.",
           "details": { "field": "instruction", "received": 2027,
                        "startsWith": "...", "endsWith": "..." } }
```

`GET /errors` is **disabled** (`ERROR_LOG_ENABLED` is `"false"`). It was a
testing aid and a poor one: it only ever saw a single Cloudflare isolate's
memory, so an error from a phone rarely appeared in a browser. Use
`X-Debug-Token` above, or the Cloudflare dashboard logs.

---

## GET /logs

A rolling log of every call that spends money upstream, so you can see what
the app is actually costing you without opening the Cloudflare dashboard.

```
When      Status        Endpoint             Source  Provider     Tokens in  Tokens out  Took    Cost
2m ago    success       /v1/decks/generate   file    openai         141,238       9,210  28.0s   $0.269
40s ago   failed        /v1/decks/refine     text    cheaper_...          0           0   2.0s   $0
just now  in-progress   /v1/decks/generate   —       —                    —           —      —      —
```

A row opens the moment work starts, so a generation that takes three minutes
is visible while it runs rather than appearing only once it settles. The page
refreshes every 15 seconds, or every 5 while something is in flight. Add
`?format=json` for the same data as JSON, `?limit=n` for more or fewer rows.

Rows are kept **7 days** and pruned opportunistically, so the table stays small
without a scheduled worker.

### Setup

```bash
npx wrangler d1 create learnalert-logs
# paste the printed database_id into wrangler.jsonc
npx wrangler d1 execute learnalert-logs --remote --file=./migrations/0001_call_log.sql
npx wrangler secret put DEBUG_TOKEN
```

Then open `https://your-api/logs?token=...`.

`/logs` **fails closed**: with no `DEBUG_TOKEN` set it answers 404 to everyone.
It sits in front of the API-key check so a browser can reach it, and traffic
volume and spend are not public information. It carries no prompts, deck
content, or source text — only metadata about each call.

Until `database_id` is filled in, `/logs` answers 503 and the rest of the API
runs exactly as before. Logging is never on the critical path: a D1 failure is
logged to the console and the deck still goes out.

### Costs

The cost column reads `n/a` until you set your rate card, in USD per million
tokens:

| Var | Meaning |
| --- | --- |
| `PRICE_INPUT_PER_MTOK` | Uncached input tokens |
| `PRICE_CACHED_INPUT_PER_MTOK` | Cached input tokens, usually far cheaper |
| `PRICE_OUTPUT_PER_MTOK` | Output tokens |

No rates are assumed, because a guessed number looks authoritative. Cached
tokens are subtracted from the prompt total before the uncached rate applies,
rather than billed twice. If the cached rate is unset, cached tokens fall back
to the full input rate, which overstates rather than understates the bill.

Figures are an estimate from the usage each provider reports, not a bill.

## Authentication

Every endpoint that costs money requires an API key once one is configured:

```bash
curl -X POST https://api.learnalertapp.com/v1/decks/generate \
  -H 'X-API-Key: live_abc123' \
  -H 'Content-Type: application/json' \
  -d '{ "text": "la mesa = table" }'
```

`Authorization: Bearer live_abc123` works too.

Set `API_KEYS` as a Cloudflare secret. It accepts a comma-separated list, so a
key can be rotated by adding the new one, shipping the app update, then
removing the old one.

**Until `API_KEYS` is set, the API is open.** That is deliberate — deploying
this cannot take a live app offline — but it means setting the secret is the
actual cutover. `GET /` reports `auth.required` so the state is checkable
rather than assumed.

Unauthorized requests are rejected with a 401 before any parsing or upstream
call, so they cost nothing.

> A key shipped inside an app binary can be extracted, and is visible to anyone
> proxying their own device. This stops scanners and opportunists, not a
> determined attacker. Device attestation (App Attest) is the real answer;
> this is the layer that closes the door today.

## Providers and cost

Two upstream providers, chosen per request by content type:

| Request | Provider | Setting | Why |
| --- | --- | --- | --- |
| Text | Cheaper Inference | `AI_PROVIDER` | Identical work, ~60% cheaper |
| Carries a file | OpenAI | `DOCUMENT_PROVIDER` | Must parse the document |

Both speak the same chat-completions dialect, so switching is only a change of
host and key. Both serve `gpt-5.6-luna` (~1.05M context, 128k output).

Documents go to a provider that parses them because an inlined file that nobody
decodes is billed as raw text — roughly 400k tokens for a PDF versus 110k
parsed. A discount does not cover a 4x token penalty.

Every response reports what served it in `meta.provider`, `meta.model` and
`meta.usage` (including `cachedTokens`).

### Configuration

Secrets, set in the Cloudflare dashboard:

| Secret | For |
| --- | --- |
| `CHEAPER_INFERENCE_API_KEY` | Text requests |
| `OPENAI_API_KEY` | Document requests |
| `DEBUG_TOKEN` | Unlocks `error.details` **and** `GET /logs`. |
| `API_KEYS` | Comma-separated client keys. Unset = open. |

Variables, in `wrangler.jsonc` or the dashboard:

| Variable | Default | Does |
| --- | --- | --- |
| `AI_PROVIDER` | `cheaper_inference` | Provider for text |
| `DOCUMENT_PROVIDER` | `openai` | Provider for files |
| `AI_MODEL` | — | Override the model |
| `ALLOW_PROVIDER_OVERRIDE` | `false` | Honour an `X-AI-Provider` header |
| `ERROR_LOG_ENABLED` | `false` | Serve `GET /errors` (off) |
| `REASONING_GENERATION` | `low` | Also `_REFINE`, `_OUTLINE` |
| `PRICE_INPUT_PER_MTOK` | — | USD per 1M input tokens, for `/logs` |
| `PRICE_CACHED_INPUT_PER_MTOK` | — | USD per 1M cached input tokens |
| `PRICE_OUTPUT_PER_MTOK` | — | USD per 1M output tokens |

Bindings, in `wrangler.jsonc`:

| Binding | For |
| --- | --- |
| `LOGS_DB` | D1 database behind `GET /logs`. Unbound = `/logs` is 503. |

There is no key fallback between providers: whichever is selected must have its
own secret, or the request fails with a 500 naming the missing variable before
anything is sent. `GET /` shows which are configured.

---

## Notes for the iOS app

- Send `instruction` as the user's typed message only. Context goes in
  `chatHistory`, `sourceText` or `deck`.
- Only append a message to `chatHistory` **after** a request succeeds.
  Otherwise failed messages get answered out of order later.
- Narrow large PDFs before uploading. Ten pages produces better coverage than
  two hundred, because a 200-page document cannot fit in 200 cards.
- `deck.title` is regenerated on every refine. If users can rename a deck,
  store the name locally and stop overwriting it.
