# Public LearnAlert decks

The production API is the `learnalertapi` Worker at `https://api.learnalertapp.com`.
The similarly named `learnalert-api` Worker does not serve that domain.
The marketing site stays at `learnalertapp.com`; uploads need no additional domain.

Deck metadata, card snapshots, ownership, sessions, and reports live in the
`learnalert-community` D1 database. Image/audio files live in the private
`learnalert-deck-assets` R2 bucket. Keep public bucket access disabled: the Worker
checks that an attachment belongs to a published deck before serving it.

## App flow

1. Create cards in a personal deck. Attach question/answer images and an optional
   MP3, M4A, or WAV question clip using the card editor.
2. Open Premade Decks → User-Made Decks → Share Deck and sign in with Apple.
3. Choose a deck, category, and description. Publishing uploads a draft's media
   and then atomically publishes its card snapshot. Updates retain the public ID.
4. Other users browse without signing in and download editable local copies,
   including images, audio, and sections. Study progress and source documents
   are never part of the shared payload.
5. The owner can update or remove the public copy through Share Deck. Removal
   immediately blocks API access; existing downloaded copies remain local.

The app entitlement includes Sign in with Apple for `com.learnalert.app`. A
device/release provisioning profile must include that capability. Apple JWTs are
verified against Apple's signing keys, issuer, audience, expiry, and request
nonce. Thirty-day opaque sessions are hashed in D1 and stored in the app Keychain.
The existing AI API keys remain independent of community authentication.

## API

All paths start with `/v1/community`.

| Method | Path | Access |
| --- | --- | --- |
| POST | `/auth/apple` | Apple identity token, original nonce, optional given name |
| GET | `/decks?q=&category=&offset=&limit=` | Public summaries and `nextOffset` |
| POST | `/decks/drafts` | Bearer session; returns deck ID |
| POST | `/decks/:id/media` | Owner; raw binary body and allowed Content-Type |
| PUT | `/decks/:id` | Owner; metadata and complete card snapshot |
| GET | `/decks/:id` | Public published snapshot; increments download requests |
| GET/HEAD | `/media/:id` | Public if referenced by a published deck; otherwise owner |
| DELETE | `/decks/:id` | Owner; removes public copy |
| POST | `/decks/:id/reports` | Signed-in user; JSON `reason` |

Images: JPEG/PNG, 10 MiB each. Audio: MP3/M4A/WAV, 20 MiB each. Published
decks: 1–500 cards, 100 MiB total unique media, 1,000 attachments. Published
decks allow an additional 100 MiB of staging space during replacement uploads.
Users can have 50 active shared decks and create at most 20 per day. JSON bodies
are capped at 1 MiB. These limits apply server-side, including streamed uploads.

Daily cleanup at 04:17 UTC expires sessions, removes abandoned drafts after
24 hours, and deletes up to 500 removed or old unused media objects per run.
Reports are stored in `community_reports`; they are not automatically moderated.
To inspect reports:

```sh
./node_modules/.bin/wrangler d1 execute learnalert-community --remote --command \
  "SELECT r.deck_id,d.name,r.reason,r.created_at FROM community_reports r JOIN community_decks d ON d.id=r.deck_id ORDER BY r.created_at DESC LIMIT 100"
```

## Deployment and verification

Bindings and IDs are declared in `wrangler.jsonc`. Existing production secrets
are retained by deployment. Apply future database migrations before deploying:

```sh
./node_modules/.bin/wrangler d1 migrations apply learnalert-community --remote
node --test
./node_modules/.bin/wrangler deploy
curl -sS https://api.learnalertapp.com/
curl -sS https://api.learnalertapp.com/v1/community/decks
```

The initial schema is applied remotely and registered in D1's migration history.
Health reports `community.databaseConfigured` and `community.mediaConfigured`.
`test/community.test.js` uses local D1/R2, real test RSA signatures, and local-only
seeded sessions to verify ownership, quotas, draft privacy, replacement media,
publication, reports, and removal. There is no production authentication bypass.

Swift transfer tests use a stub URLSession with real JPEG and playable WAV data.
Before App Store distribution, include the added community collection types in
the store's privacy answers and test Apple sign-in on a provisioned device.

Apply every file in `community-migrations/` before deploying this version.
Migration 0002 adds deletion claims and a transactional publication trigger.
Cleanup claims a still-unused object before deleting it; publication cannot attach
claimed, missing, or unfinished media. A failed R2 deletion is retried on later cleanup.

## Moderation and community account deletion

Configure the Worker secret `COMMUNITY_MODERATION_TOKEN` with a separate random
administrator credential; never include it in the app. The same environment
variable (or an ignored `.env.moderation.local` file containing only that token)
lets `node scripts/moderate.mjs reports` list reports and
`node scripts/moderate.mjs remove <deck-id>` remove an offending public deck.
Removal immediately blocks downloads; the scheduled cleanup deletes its media.
The administrator endpoints return 404 without a valid moderator credential.

`DELETE /v1/community/account` requires the user's session. It atomically deletes
that user's community profile, sessions, reports, and public decks, queuing media
for cleanup. The app exposes this action in Share a Deck's account menu. Personal
library copies are retained, and previously downloaded public copies cannot be
remotely erased. A new Apple sign-in may create a new profile afterward.
Apply migration 0003 before deploying these account controls.
