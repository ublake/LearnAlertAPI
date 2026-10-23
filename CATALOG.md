# First-party content catalog

`learnalertapp.com/admin` is the compact content studio. Courses and Exam prep
edit the same published catalog consumed by the updated app. Community uses the
existing submissions, media, moderation, profiles, restrictions and audit data.
The dashboard remains unlinked from the public website and protected by the
existing Cloudflare Access application. No new administrator credentials exist.

## Editing and publishing

- The catalog list, searchable outline and selected-node inspector share one
  page. Select a unit, lesson, card, checkpoint, guide or guide presentation to
  edit it. Add, duplicate, reorder or remove nodes in the outline.
- Fields and JSON edit the same document. Unknown properties survive edits.
  Full-document JSON and downloadable format examples support AI-assisted work.
- Save draft does not replace published content. Validate checks the current
  document without writing anything. Publish validates the complete curriculum,
  media ownership/type and expected revision before updating the live catalog.
- Catalog Order controls course/deck order; nested arrays control unit, lesson,
  card and guide order. Keep stable IDs when editing existing material to retain
  learning history. Renaming a title does not require changing its ID.
- Archive removes content from discovery. History and Restore retain recovery;
  DELETE is also reversible archive. Restoring an old revision creates a draft
  and does not automatically publish it.
- Upload images/audio to the selected course or exam deck. `catalog:<UUID>`
  references may be placed in its native image/audio fields. Draft media remains
  private; public media must be referenced by a live publication.

Course documents include all native metadata, ordered units/lessons/cards,
checkpoint quizzes and thresholds, vocabulary metadata, activity parameters,
speech/listening alternatives, image/audio fields, `guides` keyed by unit ID and
`guidePresentation`. The latter controls the Hangul diagram's visibility,
editable labels/examples, footer and reference link. Exam documents use the
native `PremadeDeck` format. The transport budget is 16 MiB per JSON request,
without a card-count cap. Existing community publishing limits remain separate.

## App synchronization

GET `/v1/catalog` returns a versioned manifest. Each item points to an immutable
published revision under `/v1/catalog/:id?revision=N`; the app fetches changed
documents and missing media in bounded batches, then installs one atomic shared
snapshot. Foreground refresh runs at most once per minute. A failure retains the
last complete snapshot. App-group storage also supplies offline notification
study and guides. Media does not use user-editable attachment storage.

Bundled content is a first-install fallback until the server catalog has been
initialized. An initialized empty catalog stays empty. Removed catalog items are
not resurrected from the bundle. Existing enrolled courses retain their last
known content for continued study, and downloaded personal decks are not erased.
Stable course/card identifiers preserve course SRS and local review history;
pending course alerts refresh their content without creating a new schedule.
Older app versions continue using their bundled curriculum until updated.

Language topic decks may set `importance` on their lesson object: a whole number
from 1 to 10, with 5 as the default when omitted. Both draft saves and publishing
reject invalid supplied weights. The current app uses this relative frequency
within its eligible level, keeping topic/card identities and mastery intact.
Weights do not unlock future levels. The compact topic-deck Fields editor
exposes the value, and import/export/legacy simplification retain it.

## Storage and API

Migration `community-migrations/0014_managed_catalog.sql` adds only managed
catalog tables. D1 stores metadata, revision indexes, media ownership and the
public manifest state. Immutable documents/media live in the existing
`learnalert-deck-assets` R2 bucket, under `catalog/`. Existing community tables and
moderation behavior are retained. Every normal write uses the existing verified
Access JWT, same-origin protection, optimistic revision checks and admin audit.

Admin routes are `/v1/admin/catalog`, `/:id`, `/validate`, `/:id/publish`,
`/:id/archive`, `/:id/history`, `/:id/restore`, `/:id/media` and `/media/:id`.
The website proxies them through `/admin/api/catalog`. Direct unauthenticated
Worker routes fail closed. Published media is `/v1/catalog/media/:id`.

## One-time bundled content bootstrap

Export the actual Swift builders from the app checkout:

```sh
DEVELOPER_DIR='/path/to/Xcode.app/Contents/Developer' \
  python3 scripts/export-managed-catalog.py --output /tmp/catalog-seed.json
```

Then in this API checkout, after applying migration 0014:

```sh
node scripts/bootstrap-catalog.mjs --input /tmp/catalog-seed.json \
  --app-source /path/to/LearnAlert --output /tmp/catalog-bootstrap
node scripts/bootstrap-catalog.mjs --output /tmp/catalog-bootstrap --apply
```

Preparation validates all actual native content, packages existing bundled
artwork into portable media, and writes an immutable upload plan plus SQL.
It makes no remote changes. Apply uses the owner's existing Wrangler login,
verifies prepared bytes, refuses an existing or edited catalog, uploads objects
before publishing metadata, and initializes the manifest only after all planned
records exist. Reusing the same plan can resume an interrupted initial import.
Use the studio for all later changes; never rerun bootstrap to overwrite edits.

The initial native export contains Spanish Foundations (57 cards), Korean
(1,386 cards), SAT Academic Vocabulary (5 cards) and Study Skills (5 cards), plus
all eleven section guides. Forty portable images preserve the original bundled
course artwork. No community submissions or personal learning records are part
of this migration.

## Prerecorded course speech

The admin API can generate or reuse private MP3 media with the existing OpenAI
binding and signed-in administrator. See [SPEECH.md](SPEECH.md) for the protected
routes, immutable run allowances, exact voice profile, cache/reconciliation and
QA contract. It does not edit or publish courses, and cannot make a paid request
without an explicit bounded allowance. USD reservations are estimates, not a
verified provider billing hard cap.
