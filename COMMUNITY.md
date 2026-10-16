# Public LearnAlert decks

The production API is the `learnalertapi` Worker at `https://api.learnalertapp.com`.
The similarly named `learnalert-api` Worker does not serve that domain.
The marketing site stays at `learnalertapp.com`; uploads need no additional domain.

Deck metadata, card snapshots, ownership, sessions, and reports live in the
`learnalert-community` D1 database. Image/audio files live in the private
`learnalert-deck-assets` R2 bucket. Keep public bucket access disabled: the Worker
checks that an attachment belongs to an approved, published, visible deck before serving it publicly.

## App flow

1. Create cards in a personal deck. Attach question/answer images and an optional
   MP3, M4A, or WAV question clip using the card editor.
2. Open Discover → Community decks → Share. Sign in with Apple when publishing,
   or use the profile card at the top of Settings. Choose a username and character.
3. Choose a deck, category, and description. Submission uploads media and saves
   a private card snapshot for manual review. Review can take up to 3 days; there
   is no automatic approval. Owner updates retain the same ID and immediately
   return previously approved decks to private pending review. Sharing after an
   account change creates a new submission.
4. Other users browse without signing in and download editable local copies,
   including images, audio, and sections. Study progress and source documents
   are never part of the shared payload.
5. The owner can update or remove the public copy in Settings → profile →
   My shared decks. Removal
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
| POST | `/auth/apple` | Apple identity token, original nonce; returns session and profile |
| GET | `/account` | Bearer session; current public profile |
| PUT | `/account` | Bearer session; username and character choices |
| GET | `/account/decks` | Bearer session; own published, pending, and rejected decks |
| DELETE | `/account` | Bearer session; removes account and public content |
| GET | `/decks?q=&category=&offset=&limit=` | Public approved summaries and `nextOffset` |
| POST | `/decks/drafts` | Bearer session; returns deck ID |
| POST | `/decks/:id/media` | Owner; raw binary body and allowed Content-Type |
| PUT/PATCH | `/decks/:id` | Owner; complete snapshot; HTTP 202 pending review |
| GET | `/decks/:id/preview` | Public first five cards; does not increment downloads |
| GET | `/decks/:id` | Public approved published snapshot; increments download requests |
| GET/HEAD | `/media/:id` | Public if referenced by an approved visible published deck; otherwise owner |
| DELETE | `/decks/:id` | Owner; removes public copy |
| POST | `/decks/:id/reports` | Signed-in user; JSON `reason` |

Submission succeeds with HTTP 202 and `{ id, success: true, reviewStatus: "pending", submittedAt, message: "Review can take up to 3 days." }`. Owner deck summaries include optional `reviewStatus` (`pending`, `approved`, or `rejected`), `reviewMessage` (rejection reason or null), and `submittedAt` (epoch seconds or null). Resubmission clears an old rejection reason. Pending/rejected cards and referenced media remain private and are retained until removed by the owner/admin.

The protected admin queue is `GET /v1/admin/reviews?status=pending`. Review decisions use `POST /v1/admin/decks/:id/review` with `decision: "approve" | "reject"`, `expectedRevision`, and a required rejection `reason` of 1–1000 characters. Approvals validate saved cards and attachments; stale decisions return 409. Both decisions are audited. Only trusted admin-created drafts can use direct publication. Existing public decks remain approved after migration 0008. Approval preserves any separate admin hide flag.

Images: JPEG/PNG, 10 MiB each. Audio: MP3/M4A/WAV, 20 MiB each. Published
decks: 1–500 cards, 100 MiB total unique media, 1,000 attachments. Published
decks allow an additional 100 MiB of staging space during replacement uploads.
Users can have 50 active shared decks and create at most 20 per day. JSON bodies
are capped at 1 MiB. These limits apply server-side, including streamed uploads.

Image-only cards use `cardType: "images"` with a required front `promptImageID`
and an optional back `answerImageID`. With no back, the front is a review card;
with a back, the app reveals the second picture. Question, answer, and hint are
empty (or omitted); choices, matching pairs, option images, and audio are not
permitted. Both images must already be uploaded to that deck. Back images are
not accepted on other card types. The existing private review, public media
access, ownership, and removal rules apply. Migration 0011 adds back images to
the atomic publication/submission attachment guards; apply it before deploying
this Worker or distributing an app build that publishes front/back image cards.
Existing single-image cards remain valid.

Duplicate text-deck checks still compare normalized card text. Image-only cards
are excluded from that fingerprint, and at least three text cards are required;
unrelated photo decks must not collide because both have empty text. Media has
no stored content hash, so the text fingerprint does not detect copied images.
Built-in/community provenance restrictions and upload ownership remain enforced.

Daily cleanup at 04:17 UTC expires sessions, removes abandoned drafts after
24 hours (excluding submitted pending/rejected and admin-created drafts), and deletes up to 500 removed or old unused media objects per run.
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
for cleanup. The app exposes this action in Settings → profile → account menu. Personal
library copies are retained, and previously downloaded public copies cannot be
remotely erased. A new Apple sign-in may create a new profile afterward.
Apply migration 0003 before deploying these account controls.

## Public profiles

Apply migration 0004 before deploying the profile endpoints. Usernames are
case-insensitive and unique, normalized to lowercase, and use 3–24 ASCII letters,
numbers, or underscores with a letter first. PUT `/account` accepts
`{"username":"funny_buddy","avatar":{"hair":2,"eyes":4,"mouth":5,"skinTone":3}}`.
Hair, eyes, and mouth are integers from 0 to 5. Skin tone is an integer from
0 to 6 and defaults to the middle shade (3). Legacy clients that omit skin tone
preserve the saved shade. Arbitrary photo uploads are not part of the profile feature. The response is `handle`, `avatar`, and `isComplete`.
Apple sign-in returns the existing profile, and public deck responses expose
`authorHandle` and `authorAvatar` without exposing the Apple identity or session.
Existing accounts receive a default character and can finish setup in Settings.

The first successful profile save permanently locks the username for that account.
Later saves can update the character with the same username, and simultaneous
first saves cannot overwrite each other. Sign-out and sign-in restore the saved
profile without reopening setup; Settings still opens the character editor manually.
Account deletion continues to remove the profile and release its username.

## Author moderation notices

Authenticated GET /account/decks returns current saved metadata and optional status, adminNote, adminAction, adminUpdatedAt and isHidden. Notes are not returned by public browse/preview/download endpoints. App resubmissions cannot replace these admin-owned fields. Admin hard-deletion leaves a minimal Removed notice without cards/media; DELETE /decks/:id dismisses only the caller's notice. Account/profile deletion removes all their notices. Follow nextOffset with ?offset=... when refreshing; pages contain at most 50 rows ordered by latest update, then ID.

## Blocking and account restrictions

Public deck summaries/preview/downloads and owner rows add authorID (32 lowercase hex characters), an opaque profile identifier, never Apple's subject. GET /account and the sign-in result.profile also include authorID. It stays stable across profile edits; after full deletion/recreation a new opaque profile ID may be issued, while enforcement still follows the internal Apple account identity.

Authenticated GET /account/blocks returns {users:[{id,handle}]}. POST /account/blocks accepts {authorID}; DELETE /account/blocks/:authorID unblocks. The list has a maximum of 500 entries. A block does not remove personal downloaded copies, notify the blocked author, or affect anonymous browsing. It filters public list/count results for the signed-in viewer and denies that viewer's preview/detail/media GET/HEAD and report access with HTTP 403 / AUTHOR_BLOCKED. Supply the same bearer on all browse/download/media requests. An invalid supplied bearer returns 401 instead of silently falling back to anonymous content.

Admin /profiles/restrict accepts authorID, action (suspend/ban/restore), expectedRevision, reason (required 1–1000 characters for suspension/ban), and until (epoch seconds, future and at most one year, for suspension). Restrictions are audited, keep existing decks/media intact, hide all restricted account content from public access, and deny its posting/profile-edit/public-viewer actions with 403 / ACCOUNT_SUSPENDED or ACCOUNT_BANNED. Existing restricted profiles may sign in for management and use GET /account, GET /account/decks and DELETE /account. Profile responses privately include accountStatus (active/banned/suspended) and restrictionMessage. A deleted restricted identity cannot recreate its profile. Suspension expiry restores access automatically; permanent bans have no expiry. GET /v1/admin/restrictions lists current restrictions even after a profile is deleted, with Restore access in the dashboard. Enforcement records and another user's block references are deliberately not foreign-keyed to the deleted profile, so recreating it cannot evade them.

## Apple lifecycle

See APPLE_SETUP.md for token exchange, encrypted retention, reauthentication-bound deletion, revocation retries and signature-verified server notifications. Health includes community.appleRevocationConfigured; absence of the required key/configuration is a release validation blocker, not a claim that existing Apple identity verification is broken. Legacy sign-in stays available and unconfigured production account deletion still removes community content.
