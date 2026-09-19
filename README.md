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

`/v1/sources/extract` is an optional shortcut: transcribe a document **once**
into text, then generate as many decks from that text as you like without ever
re-parsing the file.

---

## Endpoints

| Method | Path | Give it | Get back |
| --- | --- | --- | --- |
| `GET` | `/` | — | Health, and which AI providers are live |
| `POST` | `/v1/sources/outline` | The first ~240 chars of each page | Section list with page ranges |
| `POST` | `/v1/sources/extract` | A file | Full Markdown + a `contentHash` |
| `POST` | `/v1/decks/generate` | A file **or** text | A deck, or a chat reply |
| `POST` | `/v1/decks/refine` | A deck + an instruction | The updated deck, or a chat reply |
| `GET` | `/errors` | — | Recent errors (debug only) |
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
    "coverage": {
      "level": "high",
      "cardsCreated": 50,
      "estimatedKeyConcepts": 62,
      "omittedImportantTopics": ["past tense"]
    },
    "cards": [ ... ]
  },
  "droppedCards": [],
  "meta": { "provider": "openai", "model": "gpt-5.6-luna", "usage": { ... } }
}
```

`coverage.omittedImportantTopics` is the AI telling you what it could not fit.
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
  "explanation": "usted is the formal singular you.",
  "options": ["tú", "usted", "vos", "vosotros"],
  "correctAnswerIndex": 1,
  "matchingPairs": [],
  "difficulty": "medium",
  "tags": ["pronouns"],
  "sourceLocator": "p. 15",
  "sourceExcerpt": "usted is used in formal settings."
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

### POST /v1/sources/extract

Transcribes a document into Markdown once, so later decks run on text.

```bash
curl -X POST .../v1/sources/extract -F 'file=@SpanishModule.pdf'
```

```json
{
  "contentHash": "9f2b...c41e",
  "extraction": {
    "markdown": "## Page 1\n\nla mesa — the table\n...",
    "pageCount": 42,
    "detectedLanguage": "es",
    "coverageNotes": [],
    "estimatedTokens": 28120
  }
}
```

Store the Markdown and send it as `text` from then on. `contentHash` is the
SHA-256 of the bytes — keep it, and skip extraction when the user picks the same
file again. Nothing is cached server-side.

`coverageNotes` lists anything that could not be transcribed, such as an
illegible scan. Empty means the transcription is believed complete.

---

## Errors

```json
{ "success": false, "requestId": "uuid",
  "error": { "code": "VALIDATION_ERROR", "message": "..." } }
```

| Code | HTTP | Meaning |
| --- | --- | --- |
| `VALIDATION_ERROR` | 400 | Bad request. Do not retry. |
| `INVALID_JSON` | 400 | Malformed body. |
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

`GET /errors` shows the last 5 minutes as a page, but it reads one Cloudflare
isolate's memory — an error from a phone will usually **not** appear in a
browser on another device. Use `X-Debug-Token`, or the Cloudflare dashboard
logs, for anything cross-device.

---

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
| `DEBUG_TOKEN` | Optional. Unlocks `error.details`. |

Variables, in `wrangler.jsonc` or the dashboard:

| Variable | Default | Does |
| --- | --- | --- |
| `AI_PROVIDER` | `cheaper_inference` | Provider for text |
| `DOCUMENT_PROVIDER` | `openai` | Provider for files |
| `AI_MODEL` | — | Override the model |
| `ALLOW_PROVIDER_OVERRIDE` | `false` | Honour an `X-AI-Provider` header |
| `ERROR_LOG_ENABLED` | `true` | Serve `GET /errors` |
| `REASONING_GENERATION` | `low` | Also `_REFINE`, `_EXTRACTION`, `_OUTLINE` |

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
