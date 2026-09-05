# LearnAlert Advanced API

Cloudflare Worker backend for AI-generated study decks.

## What changed in this version

Documents and images can now be sent as their **original files** instead of being flattened to plain text first.

Flow:

`iOS file picker -> LearnAlert Cloudflare API -> OpenAI file input -> structured deck JSON`

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
- `preferredCardTypes` — JSON array or comma-separated list, e.g. `["tap_reveal","multiple_choice"]`
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
  -F 'preferredCardTypes=["tap_reveal","multiple_choice"]' \
  -F 'userInstruction=Focus on new vocabulary and important grammar.'
```

The Worker uploads the file to OpenAI with `purpose=user_data` and a 24-hour expiration, then passes that file directly into the Responses API.

Successful file generations include:

```json
{
  "success": true,
  "action": "deck",
  "sourceId": "file-abc123",
  "sourceKind": "file",
  "source": {
    "id": "file-abc123",
    "kind": "file",
    "name": "SpanishModule.pdf",
    "mimeType": "application/pdf",
    "expiresAt": 1780000000
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

For images, `sourceKind` is `image` and the Responses API uses an image input instead of a document file input.

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
  "preferredCardTypes": ["tap_reveal", "multiple_choice"],
  "userInstruction": "Focus on new vocabulary."
}
```

### POST /v1/decks/refine

Chat-style editing of the current generated deck.

For a deck originally generated from a file, send the `sourceId` and `sourceKind` returned by generation so the original source can be attached again without uploading it from the phone a second time.

```json
{
  "instruction": "Make these harder and focus more on nouns.",
  "maxCards": 50,
  "sourceId": "file-abc123",
  "sourceKind": "file",
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

You may alternatively send the returned `source` object:

```json
{
  "source": {
    "id": "file-abc123",
    "kind": "file",
    "name": "SpanishModule.pdf"
  }
}
```

For pasted text, refinement can continue using `sourceText` instead.

### POST /generate-quiz

Legacy compatibility endpoint for the earlier LearnAlert integration. It still accepts extracted text.

## Cloudflare secret

Keep this Cloudflare Worker secret:

`OPENAI_API_KEY`

Never put it in GitHub or the iOS app.

## Important behavior

Uploaded OpenAI source files are configured to expire after **24 hours**. That means AI chat/refinement can reuse the original document during the generation/review session without permanently storing it in LearnAlert.

If you want deck chat to continue days later against the original source, add durable private file storage later (for example R2) and re-upload to OpenAI when needed.

## iOS integration change

For files/photos, stop extracting the document to text before generation. Send the original bytes to `/v1/decks/generate` as multipart form data.

For pasted notes, keep using the JSON text request.

When generation returns `sourceId`, `sourceKind`, and `source`, keep those in temporary generation/review state. Send them back to `/v1/decks/refine` while the user chats with the AI.

Do not persist OpenAI credentials anywhere in the app.
