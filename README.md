# LearnAlert Advanced API

Cloudflare Worker backend for AI-generated study decks.

## Endpoints

### GET /
Health check.

### POST /v1/decks/generate
Analyzes source text and generates the best deck up to `maxCards` (maximum 50).

Example:

```json
{
  "text": "la mesa = table\nla silla = chair",
  "sourceName": "Spanish Module 2",
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

Example:

```json
{
  "instruction": "Make the vocabulary mostly English to Spanish and add 5 harder questions.",
  "maxCards": 50,
  "sourceText": "original extracted document text",
  "sourceName": "Spanish Module 2",
  "deck": {
    "...": "the current deck object returned by /v1/decks/generate"
  },
  "chatHistory": [
    {
      "role": "user",
      "content": "Focus on nouns."
    },
    {
      "role": "assistant",
      "content": "I shifted the deck toward nouns."
    }
  ]
}
```

### POST /generate-quiz
Legacy compatibility endpoint for the earlier LearnAlert integration.

```json
{
  "text": "Mitochondria produce ATP.",
  "questionCount": 10
}
```

## Cloudflare secret

Create this secret in Cloudflare:

`OPENAI_API_KEY`

Never commit the key to GitHub or ship it in the iOS app.

## Deploy

```bash
npm install
npm run deploy
```

If GitHub auto-deploy is already connected to Cloudflare, committing these files is enough.

## Important production note

The endpoints are intentionally unauthenticated for development. Before public App Store release, put real per-user authentication and rate limiting in front of AI generation. A static secret embedded in the iOS app is not secure.

## PDF page markers

For better source locations, have the iOS app extract PDFs like:

```text
[Page 1]
...

[Page 2]
...
```

The model can then return `sourceLocator` values such as `Page 2` without inventing page numbers.
