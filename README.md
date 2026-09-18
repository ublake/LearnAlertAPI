# LearnAlert Advanced API

Cloudflare Worker backend for AI-generated study decks.

## What changed in this version

Documents and images can now be sent as their **original files** instead of being flattened to plain text first.

Flow:

`iOS file picker -> LearnAlert Cloudflare API -> inline file input -> structured deck JSON`

This preserves much more source structure for PDFs, slides, documents, tables, diagrams, screenshots, and images.

Pasted notes can still use the existing JSON text request.

## Endpoints

### GET /
Health check.

### POST /v1/sources/extract — transcribe a document once

The cheap path. Converts a document into complete Markdown **one time**, so
every deck, refinement, and follow-up afterwards runs on text instead of
re-parsing the file.

```bash
curl -X POST https://api.learnalertapp.com/v1/sources/extract \
  -F 'file=@SpanishModule.pdf' \
  -F 'sourceName=Spanish Module 3'
```

```json
{
  "success": true,
  "contentHash": "9f2b...c41e",
  "source": { "name": "Spanish Module 3", "kind": "file",
              "mimeType": "application/pdf", "byteSize": 254119 },
  "extraction": {
    "markdown": "## Page 1\n\nla mesa — the table\n...",
    "pageCount": 42,
    "detectedLanguage": "es",
    "coverageNotes": [],
    "characterCount": 112480,
    "estimatedTokens": 28120
  },
  "meta": { "provider": "openai", "model": "gpt-5.6-luna", "usage": {} }
}
```

Store `extraction.markdown` in the app and send it as `text` to
`/v1/decks/generate` or `sourceText` to `/v1/decks/refine` from then on. The
file never travels again.

`contentHash` is the SHA-256 of the file bytes. Keep it alongside the
transcription: if the user picks the same document again, the hash matches and
you skip extraction entirely. This is what stops the duplicate-upload problem —
the hash is over content, so a renamed file still matches.

`coverageNotes` lists anything the model could not transcribe faithfully, such
as an illegible scan. An empty array means it believes the transcription is
complete. It is not a summary field.

Extraction accepts files up to **8 MB**, far above the inline limit, because it
routes to a provider that parses documents natively rather than tokenizing
base64. Output is capped at 64,000 tokens; a document longer than that returns a
truncation error and must be split.

### POST /v1/decks/generate — original file upload

Use `multipart/form-data`.

Fields:

- `file` — original source file
- `maxCards` — 1-50, default 50
- `mode` — `auto`, `language`, `exam`, `mixed`
- `difficulty` — `auto`, `easy`, `medium`, `hard`
- `languageDirection` — `auto`, `target_to_english`, `english_to_target`, `mixed`
- `preferredCardTypes` — JSON array or comma-separated list containing `tap_reveal`, `multiple_choice`, `matching`, and/or `fill_blank`
- `chatHistory` — optional JSON-string array of recent `{ "role", "content" }` messages
- `userInstruction` — optional
- `sourceName` — optional; filename is used automatically when omitted

Example:

```bash
curl -X POST https://api.learnalertapp.com/v1/decks/generate \
  -F 'file=@SpanishModule.pdf' \
  -F 'maxCards=50' \
  -F 'mode=auto' \
  -F 'difficulty=auto' \
  -F 'languageDirection=mixed' \
  -F 'preferredCardTypes=["tap_reveal","multiple_choice","matching","fill_blank"]' \
  -F 'chatHistory=[{"role":"user","content":"Create Spanish vocabulary cards."},{"role":"assistant","content":"Send your vocabulary notes."}]' \
  -F 'userInstruction=Focus on new vocabulary and important grammar.'
```

The Worker base64-encodes the file and attaches it inline to a
`POST /v1/chat/completions` call. Nothing is uploaded or stored upstream.

Successful file generations include:

```json
{
  "success": true,
  "action": "deck",
  "sourceKind": "file",
  "source": {
    "kind": "file",
    "name": "SpanishModule.pdf",
    "mimeType": "application/pdf",
    "byteSize": 254119
  },
  "assistantMessage": "...",
  "deck": {}
}
```

The endpoint makes the relevance decision with the AI. If the supplied input is
conversation rather than usable study material, it returns a chat response
instead of manufacturing cards:

```json
{
  "success": true,
  "action": "chat",
  "assistantMessage": "Hi! What would you like to study?",
  "deck": null
}
```

When usable study material is supplied, `action` is `"deck"` and `deck`
contains the generated study deck. Clients should branch on `action` rather
than implementing their own relevance heuristic.

For images, `sourceKind` is `image` and the request uses an `image_url` content part instead of a `file` part.

Supported upload extensions in this project:

- PDF
- TXT
- Markdown
- RTF
- DOCX
- PPTX
- PNG
- JPG / JPEG
- WEBP

### Upload size is a token budget, not a file-size preference

An inlined file is billed and counted as **tokens**, not bytes. Base64 expands
bytes by 4/3 and tokenizes at roughly 4 characters per token, so one token costs
about three source bytes:

| Upload | Approx. tokens | Fits a 400k window? |
| --- | --- | --- |
| 100 KB | ~34,000 | yes |
| 500 KB | ~170,000 | yes |
| 1 MB | ~350,000 | barely |
| 20 MB | ~7,000,000 | no, 17x over |

The ceiling is therefore derived in `src/config.js` from the context window
rather than picked by hand: **`MAX_SOURCE_TOKENS * BYTES_PER_TOKEN`, about
0.9 MB**. Oversized uploads are rejected with a 400 before anything is encoded
or sent, because discovering the limit upstream costs real money.

If you need to handle large documents, inlining is the wrong tool: extract text
in the app, or render pages to images and send those instead.

### POST /v1/decks/generate — pasted text

The original JSON text flow still works:

```json
{
  "text": "la mesa = table\nla silla = chair",
  "sourceName": "Pasted Notes",
  "maxCards": 50,
  "mode": "auto",
  "difficulty": "auto",
  "languageDirection": "mixed",
  "preferredCardTypes": [
    "tap_reveal",
    "multiple_choice",
    "matching",
    "fill_blank"
  ],
  "chatHistory": [
    {
      "role": "user",
      "content": "Create Spanish vocabulary cards."
    },
    {
      "role": "assistant",
      "content": "Send your vocabulary notes."
    }
  ],
  "userInstruction": "Focus on new vocabulary."
}
```

Generation and refinement pass `chatHistory` upstream as role-preserving
conversation messages. At most the latest 12 non-empty user/assistant messages
are used, and each message is limited to 1,500 characters.

### Card types

Every returned card uses the same shape. `matchingPairs` is required and must be
an empty array for every type except `matching`.

A matching card contains 2-4 one-to-one pairs with unique left and right values:

```json
{
  "id": "card-id",
  "type": "matching",
  "prompt": "Match each term with its definition.",
  "answer": "",
  "hint": "",
  "explanation": "",
  "options": [],
  "correctAnswerIndex": -1,
  "matchingPairs": [
    { "left": "Hola", "right": "Hello" },
    { "left": "Adiós", "right": "Goodbye" }
  ],
  "difficulty": "medium",
  "tags": [],
  "sourceExcerpt": "",
  "sourceLocator": ""
}
```

A fill-in-the-blank card uses one visible `____` marker. The app can grade its
answer case-insensitively:

```json
{
  "id": "card-id",
  "type": "fill_blank",
  "prompt": "The capital of France is ____.",
  "answer": "Paris",
  "hint": "",
  "explanation": "",
  "options": [],
  "correctAnswerIndex": -1,
  "matchingPairs": [],
  "difficulty": "medium",
  "tags": [],
  "sourceExcerpt": "",
  "sourceLocator": ""
}
```

### POST /v1/decks/refine

Chat-style editing of the current generated deck.

Successful refinement returns `action: "deck"` and the complete updated deck,
including unchanged cards. Valid existing card IDs are preserved where possible.

For a deck originally generated from a file, resend the file as
`multipart/form-data` so it can be attached again. There is no server-side copy
to point at: the upstream gateway is stateless and has no file storage.

```bash
curl -X POST https://api.learnalertapp.com/v1/decks/refine \
  -F 'file=@SpanishModule.pdf' \
  -F 'instruction=Make these harder and focus more on nouns.' \
  -F 'maxCards=50' \
  -F 'deck={"title":"...","cards":[]}' \
  -F 'chatHistory=[{"role":"user","content":"Focus more on vocabulary."}]'
```

The JSON form is unchanged when no file is attached:

```json
{
  "instruction": "Make these harder and focus more on nouns.",
  "maxCards": 50,
  "sourceText": "la mesa = table",
  "sourceName": "SpanishModule.pdf",
  "deck": {
    "...": "the current deck object"
  },
  "chatHistory": [
    {
      "role": "user",
      "content": "Focus more on vocabulary."
    },
    {
      "role": "assistant",
      "content": "I shifted the deck toward vocabulary."
    }
  ]
}
```

For pasted text, refinement can continue using `sourceText` instead. A request
that carries neither a file nor `sourceText` is still refined, but only against
the current deck: the model is told not to introduce new factual claims.

### GET /errors

A debugging view of API errors from the last **5 minutes**, newest first.
HTML by default; add `?format=json` for machine-readable output.

```bash
curl 'https://api.learnalertapp.com/errors?format=json'
```

Each entry carries the error code, HTTP status, message, request id, route, and
the internal `details` that are deliberately withheld from the app's response —
upstream payloads, token counts, and the like.

**This is best-effort.** The log lives in the memory of one Cloudflare isolate.
Cloudflare runs many short-lived isolates per region, so the page shows what the
isolate answering *that* request happened to see. An error missing here may
still have happened. For the authoritative stream:

```bash
npx wrangler tail
```

Two settings control access, because `details` can quote upstream payloads:

- `ERROR_LOG_ENABLED` — must be `"true"`, or the route 404s.
- `DEBUG_TOKEN` — optional secret. When set, callers must pass it as
  `?token=...` or an `X-Debug-Token` header. Set one if the Worker is public.

### POST /generate-quiz

Legacy compatibility endpoint for the earlier LearnAlert integration. It still accepts extracted text.

## Upstream provider

Every call is a plain `POST /v1/chat/completions`, which both providers accept
with an identical body. Switching is therefore only a change of host and key.

### Routing by content type

Text and documents have different economics, so they route separately:

| Request | Setting | Default | Why |
| --- | --- | --- | --- |
| Text (JSON body) | `AI_PROVIDER` | `cheaper_inference` | identical work, ~60% cheaper |
| Carries a file | `DOCUMENT_PROVIDER` | `openai` | must parse the document, not tokenize base64 |

These are independent. `DOCUMENT_PROVIDER` applies even when `AI_PROVIDER` is
set, so the usual deployment uses the gateway for text and OpenAI for files. An
`X-AI-Provider` header, when overrides are enabled, beats both.

The reason is cost. A base64 file that nobody decodes is billed as text: the
same document costs ~400k tokens as base64 versus ~110k parsed natively. A 60%
discount does not cover a 4x token penalty.

| Provider | `AI_PROVIDER` | Base URL | Secret |
| --- | --- | --- | --- |
| Cheaper Inference (default) | `cheaper_inference` | `https://api.cheaperinference.com/v1` | `CHEAPER_INFERENCE_API_KEY` |
| OpenAI (standby) | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |

Both are declared in `src/config.js`. The model is `gpt-5.6-luna` on either.

### Switching

`AI_PROVIDER` in `wrangler.jsonc` is the setting. Change it and redeploy:

```bash
npx wrangler deploy
```

Keep both secrets set so the standby is genuinely ready to take over:

```bash
npx wrangler secret put CHEAPER_INFERENCE_API_KEY
npx wrangler secret put OPENAI_API_KEY
```

There is no cross-provider key fallback: whichever provider is selected must
have its own secret, or the request fails with a 500 that names the missing
variable before any upstream call is made. `GET /` reports which provider is
active and which ones actually have a key:

```json
{
  "ai": {
    "active": "cheaper_inference",
    "overrideAllowed": false,
    "configured": ["cheaper_inference", "openai"]
  }
}
```

Every generation and refinement response also reports what served it, in
`meta.provider` and `meta.model`.

### Other overrides

- `AI_MODEL` — use a different model than the provider default.
- `AI_BASE_URL` — point a provider at a different host.
- `ALLOW_PROVIDER_OVERRIDE` — when `"true"`, a request may select the provider
  with an `X-AI-Provider: openai` header. Useful for smoke-testing the standby
  without redeploying. Leave it `"false"` in production, or callers choose who
  you pay.

```bash
curl -X POST https://api.learnalertapp.com/v1/decks/generate \
  -H 'Content-Type: application/json' \
  -H 'X-AI-Provider: openai' \
  -d '{"text":"la mesa = table"}'
```

Never put either secret in GitHub or the iOS app.

## Where errors come from

Three different layers can fail, and they surface differently:

| Origin | What it looks like | Where to see it |
| --- | --- | --- |
| Request validation (this Worker) | `VALIDATION_ERROR`, HTTP 400 | response body, `/errors`, `wrangler tail` |
| Upstream provider | `AI_REQUEST_FAILED` with the provider's message | same, plus the provider dashboard |
| Our handling of a good response | `AI_REQUEST_FAILED`, HTTP 502 | same, but **not** the provider dashboard |

That third row is the confusing one. If the provider shows a request as
`settled` but your app shows an error, the upstream call succeeded and was
billed — the failure happened here, after the response came back. Truncated
decks (`finish_reason: "length"`) are the usual cause.

The app never sees `details`; it gets `{ success, requestId, error: { code,
message } }`. Match the `requestId` against `/errors` or `wrangler tail` to see
the rest.

## Important behavior

The gateway is stateless and zero-retention: there is no `/v1/files` endpoint,
so source bytes are sent inline on every request and nothing persists upstream.

That means refinement days later needs the file resent from the device — unless
you use `/v1/sources/extract` first, which is the recommended flow. Once you
hold the Markdown, nothing needs the original file again, and the app can keep
it forever for free.

### Recommended flow

```
1. POST /v1/sources/extract   (once per document, OpenAI, ~110k tokens)
        -> store markdown + contentHash in the app

2. POST /v1/decks/generate    { "text": "<markdown>" }
        -> gateway, ~28k tokens, 60% off

3. POST /v1/decks/refine      { "deck": {...}, "instruction": "..." }
        -> gateway, ~18k tokens per turn
```

Costs for one document, one deck, five refinements:

| | tokens | cost |
| --- | --- | --- |
| Sending the PDF every time | 449,000 | $0.095 |
| Extract once, then text | 228,000 | $0.083 |
| **Every later deck from that document** | **118,000** | **$0.025** |

The first deck saves little. The saving is that extraction never repeats: a
second deck from the same source costs about a quarter of what it used to.

## iOS integration change

For files/photos, stop extracting the document to text before generation. Send the original bytes to `/v1/decks/generate` as multipart form data.

For pasted notes, keep using the JSON text request.

Keep the picked file around for the generation/review session. While the user
chats with the AI, resend it to `/v1/decks/refine` as multipart form data so
refinement can still see the original document. Generation no longer returns a
`sourceId`, and a stale one is ignored.

Send recent `chatHistory` on every generation/refinement turn so follow-up
messages retain their user/assistant roles. Decode all four card types and include
`matchingPairs: []` on non-matching cards when sending a deck back for refinement.

Do not persist upstream API credentials anywhere in the app.
