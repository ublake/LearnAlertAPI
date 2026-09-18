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

Maximum upload size enforced by LearnAlert: **20 MB**.

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

### POST /generate-quiz

Legacy compatibility endpoint for the earlier LearnAlert integration. It still accepts extracted text.

## Upstream provider

Every call is a plain `POST /v1/chat/completions`, which both providers accept
with an identical body. Switching is therefore only a change of host and key.

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

## Important behavior

The gateway is stateless and zero-retention: there is no `/v1/files` endpoint,
so source bytes are sent inline on every request and nothing persists upstream.

That means refinement days later needs the file resent from the device. If you
want the Worker to hold it instead, add durable private storage (for example R2)
keyed by a source id, and inline the bytes from there.

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
