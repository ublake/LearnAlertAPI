# LearnAlert admin

## Production configuration

Activated October 13, 2026:

- Access application: `LearnAlert Admin`, ID `4346bfdc-b397-4004-8476-3a8e7191199a`.
- Issuer: `https://hidden-truth-1193.cloudflareaccess.com`.
- Owner policy: exact email `ttw55970@gmail.com`, policy ID
  `23e89d5c-ec41-43db-ad8b-8e518866b3ee`.
- Login method: one-time PIN only; one-hour application sessions; HTTP-only
  authorization cookie; application hidden from the Access launcher.
- Migrations `0005_admin.sql` through `0010_community_safety.sql` applied to production D1.
- API release: `1018792f-16a2-4e4e-9758-f960f35b713b`.
- Website release: `be62dabd-c3ef-4492-a7b3-fcae2d12560f`.
- Migration `0006_deck_revisions.sql` applied for optimistic editor saves.

Production checks passed: signed-out admin routes redirect to Access; direct
admin API and forged identity requests return 401; homepage and public deck
browsing return 200. Owner email-code sign-in loads the correct live totals,
profiles, reports and full card previews. Hide/restore and audit logging were
verified with a temporary private draft; its test records were removed afterward.
The homepage has no admin link.

The account owner activated the Zero Trust Free subscription and confirmed
owner-only application access. Cloudflare's free-plan checkout requires its
terms and an authorization for usage exceeding free limits.

The dashboard lives at `https://learnalertapp.com/admin`. The public website has
no login link. Decks, profiles, reports and media remain in the existing community
D1 database and R2 bucket. The website proxies same-origin requests to the API;
the browser never receives a database credential or the moderation token.

## Activate sign-in

1. In Cloudflare Zero Trust, create a self-hosted Access application named
   `LearnAlert Admin`. Protect both `learnalertapp.com/admin` and
   `learnalertapp.com/admin/*`, including nested API paths. Do not protect the
   homepage or the app's `/v1/community/*` API.
2. Add an Allow policy with **Emails: `ttw55970@gmail.com`**. Enable one-time PIN
   as the identity provider, use a one-hour session, and keep the app out of the
   Access launcher. Do not use an Everyone, Bypass, or Service Auth policy.
3. Copy the team's issuer (`https://<team>.cloudflareaccess.com`) and this
   application's audience tag into `ADMIN_ACCESS_ISSUER` and `ADMIN_ACCESS_AUD`
   in `wrangler.jsonc`. `ADMIN_EMAILS` also enforces the allowlist at the Worker.
   These are configuration values, not passwords. All admin endpoints fail
   closed until the three values are configured.
4. Apply migration 0005 before deploying the API:
   `npx wrangler d1 migrations apply learnalert-community --remote`.
5. Run `npm test`, then `npm run deploy` here. In the website checkout, run
   `npm run lint`, `npm run build`, and `npm run deploy`.
6. In a signed-out browser, confirm `/admin` and `/admin/api/overview` both
   require Access login. Sign in with the allowed email and check dashboard
   counts, previews and private media. A different email must be denied.
   Direct `/v1/admin/overview` calls without a signed Access assertion must
   return 401, including on the API's workers.dev URL.

## Manual creation and AI import

New deck offers Blank deck and Import JSON. Choose the official @learnalert
publisher or an existing author. Official publishing uses a dedicated admin
profile, with no Apple sign-in session. JSON imports use promptImage, promptAudio
and optionImages filenames plus selected image/audio files. The client validates
cards before creating a private draft, uploads referenced files once, replaces
filenames with media IDs, saves validated content, and opens the editor. Draft
creation, uploads and publication are audited. Publish deck validates the saved
snapshot and checks its revision before changing public visibility.

The website provides /admin-deck-format.md and /admin-deck-template.json plus
a copyable AI prompt. Original generated files must be supplied separately;
remote URLs and base64 are not imported. PNG/JPEG are limited to 10 MB per file;
MP3/M4A/WAV to 20 MB. Saving/linking retains attachments; unused unsaved uploads
may be cleaned up after 24 hours. Admin-created drafts are retained until deleted.
Migration 0007_admin_created.sql must be applied before deploying these routes.

## Available controls

Decks display created, published, and updated dates. Edit opens metadata fields,
the download counter, and card forms for questions, answers, choices, matching
pairs, hints and sections. Cards can be added/removed, and Edit JSON exposes all
card fields, including existing media references. Saved changes update the
community copy; existing device-local downloads are not remotely rewritten.
Creation/publication dates, creator ownership and visibility are preserved.
The update date is set on save. Every edit is audited with its previous content.
Card validation and attachment ownership/type/size checks run at the API.
Revision checks reject stale saves, including intervening owner edits, hiding,
or download-count changes, without changing cards or attachment bookkeeping.

- Decks: search, page, inspect every card and image/audio attachment, hide and
  restore. Hiding blocks public browsing, previews, downloads and media access.
  The owner can still access attachments using their own session. The hide flag
  survives owner updates. Restoring preserves the existing draft/published state.
- Profiles: search and rename a username, enforcing the existing format and
  uniqueness rules. This is an administrator exception to the app's locked name.
- Reports: review open/resolved reports, preview or hide the reported deck, and
  resolve individual reports. A new report resets its resolution state.
- Audit: page through who changed visibility, renamed a profile, or resolved a
  report, with timestamps and before/after details.

Hiding does not delete cards/media or trigger R2 cleanup. It cannot remotely
remove copies that people already downloaded to their devices. Deleted decks
cannot be restored here because the existing deletion cleanup may remove media.
Delete buttons are available for decks, reports, and profiles. Each requires an
explicit confirmation in the dashboard and writes an audit entry. Deck deletion
removes its D1 row, attached report/media metadata, and queues R2 objects for
cleanup. Profile deletion removes all that user's community decks and reports,
revokes every session, and queues their media. Personal device-local decks are
unaffected; signing in with Apple again can create a new profile. Report deletion
removes only that report and preserves its reason in the audit log. These actions
cannot be undone; use Hide for reversible deck moderation. User bans are not
included.

Admin writes require a JSON body and a same-origin browser request. The API
validates Access JWT signatures, issuer, audience, lifetime and allowed email,
and returns no CORS permissions for admin endpoints. No arbitrary SQL execution
or session-token listing is exposed.

## Manual community review

Reviews shows pending submissions with full card/media previews, submitted dates, and revision-guarded Approve/Reject controls. Rejection requires a reason. Owner submissions and edits return HTTP 202 and remain private until approved; the app displays “Review can take up to 3 days.” This is an expectation, not an automatic approval timer. Pending/rejected submissions and their linked media are retained until deleted. Existing published decks remain approved. Trusted admin-created imports can still publish directly. Approval/rejection is audited; approval preserves an existing hide flag.

Migration 0008 adds review status, message, submission/review timestamps, reviewer, and transactional attachment validation for submissions. API integration tests cover private cards/media, owner status, retention, resubmission, approval/rejection, stale decisions, origin checks, and audit records.

Review release verification: all 92 API tests pass; website lint/build and all seven format JSON examples pass. A temporary production profile submitted a PNG deck through the app API: HTTP 202, owner pending status, anonymous cards/preview/media/HEAD/report denied, owner image bytes matched. Fixture profile/session/deck/media were removed; normal public deck IDs, names and card counts stayed unchanged. Admin review API rejects anonymous callers with 401; site/proxy redirect to Access. Live signed-in approval/rejection was not re-exercised for this release; those decisions are covered by the integration tests.

## Notes to authors and removed notices

Deck edits, Hide/Restore and deck deletion have an optional Note to author (up to 1000 characters). Each successful action replaces the previous note/action/time; an empty note clears the previous text. User resubmissions and review decisions preserve it. Notes are private: only the authenticated author account list and protected admin routes expose them. The author sees current metadata/card counts after edits; local personal/downloaded decks are unchanged.

Migration 0009_author_admin_notices.sql adds note fields and a separate minimal author-owned deletion notice. Hard deletion still removes cards, reports and media metadata immediately and queues R2 cleanup; the notice stores only the deck ID, owner ID, title, card count, note and action time. It survives media cleanup until the author dismisses it or the account/profile is deleted. Existing historical deletions are not reconstructed.

Owner GET /v1/community/account/decks includes optional status (draft/published/deleted), adminNote, adminAction (edited/removed/hidden/restored or null), adminUpdatedAt (epoch seconds or null), and isHidden (boolean). Removed notices use status=deleted, adminAction=removed and isHidden=false. They contain no cards/media references, with empty/default metadata for compatibility. Public browse/preview/download payloads omit all five fields. Lists are paginated at 50 rows using offset and nextOffset; a refresh should follow every page. Owner DELETE /v1/community/decks/:id dismisses an owned notice when the original deck is gone, and returns 404 for another owner's notice.

Admin PUT continues to require expectedRevision; dashboard Hide/Restore and Delete also send it. Older API callers may omit expectedRevision for Hide/Restore/Delete, but each operation still uses the database snapshot's revision to atomically guard note updates, deletion, media queuing, the removal notice and audit logging.

Author-notice release verification: 93 API tests pass; website lint, build and targeted admin TypeScript checks pass. The production owner API was tested with isolated seeded admin edit/delete states plus real owner submissions, PNG upload/access and notice dismissal. Private notes stayed protected through resubmission, Removed rows had no cards/media, public responses omitted the new fields, and test profile/session/deck/notice/R2 data were cleaned up. Existing public deck IDs, names and card counts were unchanged. Live signed-in admin edit/delete controls were not exercised in this release; their endpoints and atomic audit/cleanup behavior are covered by integration tests.

## Blocking, suspension and permanent bans

Migration 0010 adds opaque public profile IDs, private block lists, persistent identity restrictions, encrypted Apple token records, revocation jobs and notification receipts. Profiles offers Suspend, Ban and Restore access; Restrictions lists active restrictions after profile deletion. Actions require revision checks and a moderation reason. Suspension lasts 1–365 days; ban persists until the owner restores access. All restricted content is excluded from public browse/download/media without deleting it, and blocked viewers cannot download that author's content while signed in. Public author IDs never expose Apple's identity subject. Private study/downloaded copies are unaffected.

Account restriction records and another user's block reference intentionally survive profile deletion to prevent evasion; see the website policy for retained moderation/audit data. ADMIN.md contains no private Apple keys. Required Apple setup and precise production-validation limitations are in APPLE_SETUP.md, with App Store drafts in RELEASE_REVIEW_1_1.md.

Safety release verification: all 97 API tests pass. Website lint, targeted admin TypeScript checks and production build pass from an isolated copy with the same lockfile (Desktop dependencies initially stalled); changed source files were compared to the original checkout before deployment. Updated public privacy/terms HTML is live. A temporary production profile verified opaque author/profile IDs, real viewer block/list/count filtering, denied blocked detail/preview requests without changing download counters, unblock, private PNG access, restricted-account management/deletion, and continuing posting denial across a seeded profile recreation. Invalid Apple notifications were rejected. All test profile/session/block/restriction/deck/media and queued test objects were removed; existing public IDs, titles, card and download counts were unchanged. The live test caught and fixed Cloudflare's empty DELETE-body stream behavior; this is covered by a regression test.

At the safety-release smoke test Apple revocation was not yet configured; see the current configuration status below. At that point no real authorization-code exchange, Apple revocation, server-notification delivery or signed-in admin button interaction had been exercised; lifecycle and admin routes are covered by cryptographic/local integration tests. Later real-account evidence and remaining validation are recorded below. The AI consent screen and iOS files were not changed by this API/site task.

Apple configuration follow-up: owner-approved SIWA-only Key ID LWATVP7S48 / Team 5UCA258TUZ and a new random AES encryption key are installed as four Worker secrets through stdin. The local .p8 is mode 0600 and absent from Git. Worker release 1018792f-16a2-4e4e-9758-f960f35b713b reports appleRevocationConfigured=true; database/media bindings remain configured and unsigned notifications return 401. Actual-key local ES256 signing and four lifecycle/safety tests pass. The coordinating Apple Developer flow reopened and confirmed the registered notification URL. Later real Apple exchange/revocation evidence is recorded below; signed webhook delivery remains unverified. Legacy accounts without stored tokens now require fresh Apple reauthentication on deletion; existing sign-in without an authorization code stays supported. See APPLE_SETUP.md.

Live Apple follow-up (reported by the coordinating app chat): real sign-out/sign-in restored the test profile/avatar/permanent username and its two approved listings; read-only D1 confirmed has_encrypted_apple_token=1. After explicit user approval to permanently delete that account and both listings, fresh SIWA reauthentication/deletion succeeded and D1 reported matching_accounts=0, stored_apple_tokens=0 and pending_apple_revocations=0. The empty revocation queue after a retained token/deletion supports Apple HTTP-200 acceptance under revokeAppleJob's implementation; no outbound Apple response was independently captured by this docs-only update. The app's deletion completion race was fixed in app commit 648ac13; the coordinating app chat reports 20 passing community tests, a signed stable archive and a successful repeated live deletion flow returning to Settings signed out while preserving three personal library items. Read-only D1 reported test_accounts_remaining=0, stored_apple_tokens=0 and pending_apple_revocations=0. Distribution export was still running when reported. It does not establish signed server webhook delivery, which remains unverified. Do not recreate the intentionally deleted test profile or listings.
