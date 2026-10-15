# LearnAlert 1.1 (3) — App Store metadata draft

The coordinating app chat reports App Store privacy/metadata updates and a calculated 13+ age rating; this API/site chat has not independently inspected those entries. Owner final review remains required. This file does not submit a release. AI consent screen/UX was intentionally unchanged. iOS version/build, manifests, device checks and archive are owned by the app chat; this API/site task does not verify them. Apple revocation credentials and the notification endpoint are configured; the app chat has reported live authorization-code exchange/encrypted retention and accepted revocation after owner-approved account/listing deletion. Signed server-notification delivery remains unverified; the app chat reports its completion race fixed in commit 648ac13, with 20 community tests, a signed stable archive and successful live UI retest preserving three personal library items. Distribution export was still running at that report. See APPLE_SETUP.md for exact evidence and limits.

## App Privacy

Use the actual production behavior and all third-party providers. Do not select Data Not Collected: community profiles/content and operational metadata are retained. No advertising/tracking purpose is intended; confirm the built app's disabled tracking SDK state before answering No to tracking.

| Data type | Candidate purpose | Linked to identity? | Basis |
| --- | --- | --- | --- |
| Identifiers / User ID | App Functionality | Yes | Apple app-specific account ID, opaque community author ID, username, sessions, blocks, bans |
| User Content / Other User Content | App Functionality | Yes for community | Deck/card text, description/category, profile character choices, report text; retained while pending/rejected/approved |
| User Content / Photos or Videos | App Functionality | Yes for community | User-selected deck image bytes retained in R2 |
| User Content / Audio Data | App Functionality | Yes for community | Uploaded question audio/recordings retained in R2 |
| User Content / Customer Support | App Functionality | Review actual support collection | Moderation reports and support messages may include account/contact details; verify label classification |
| Usage Data / Product Interaction | App Functionality | Review implementation | Aggregate download-request counters; don't claim per-user study history is collected |
| Diagnostics / Other Diagnostic Data | App Functionality | Review provider/infra logs | Request IDs, timestamps, model/provider/token/cost/error metadata; backend AI logs retained seven days |
| Other Data Types | App Functionality | Review hashing/linkage | Hashed IP quota windows; no tracking purpose; verify Apple classification |

Usernames are not legal names collected from Apple. The server does not request/store Apple email/name for profile generation, and never receives Apple passwords. Do not add Name or Email solely because Sign in with Apple is present. If actual support/provider flows retain contact information, disclose those actual flows. Photos/audio/text sent for AI also require the applicable labels based on provider retention and linkage; verify provider terms rather than assuming transient/no collection. Private on-device/CloudKit study progress differs from voluntarily shared community content.

Privacy policy URL: https://learnalertapp.com/privacy-policy
Support URL: https://learnalertapp.com/support
Marketing URL: https://learnalertapp.com

## Age-rating questionnaire

- User-Generated Content: Yes — community decks distribute user-created text/images/audio after manual approval.
- Messaging/Chat: No user-to-user chat exists. Private operator moderation notes are notices, not an anonymous/peer chat feature. Review Apple's current definition when entering the answer.
- Advertising: No if the shipped binary matches the current intended behavior.
- Unrestricted Web Access: No if the shipped app cannot freely browse arbitrary websites; verify any in-app links/browser behavior.
- Gambling/Contests, Simulated Gambling, Purchases of random items: None absent actual features.
- Review every content descriptor against the real approved catalog and intended educational content. Do not use a blanket None merely because uploads are reviewed; anatomy/medical or exam content may affect medical/treatment descriptors. Objectionable sexual/abusive/violent content is prohibited, reported and removed, but age answers must reflect actual content.
- Let App Store Connect calculate the rating; no arbitrary 4+ claim or Kids Category selection. Do not submit a release from this checklist.

## Reviewer notes draft (verify exact iOS labels before pasting)

LearnAlert teaches personal flashcards through local interactive notifications. Personal study and community browse/download work without an account. Confirm the live community catalog before naming public examples: the two listings used in the live Apple deletion test were intentionally deleted with owner approval and must not be promised as available or automatically recreated. Notification permission is optional; in-app study remains available. Test a fresh installation on both iPhone and iPad.

Discover > Community decks: browse, preview and download an editable personal copy. Sign in with Apple for sharing/reporting/blocking and account management using the reviewer's own Apple account; there is no shared password/demo admin login. Show Block author on another author's deck and manage Unblock in the community account controls. While signed in, blocking filters browse/preview/download/media; existing personal copies remain available. Report a public deck using its Report control and reason.

Share a personal deck, including supported image/audio attachments. Submission immediately shows Pending review and “Review can take up to 3 days”; it remains private until operator approval. Updating an approved deck returns it to private review. My shared decks refreshes and shows operator notes/removal notices; Removed notices can be dismissed. No automatic approval timer or user-to-user chat exists. Contact contact@learnalertapp.com if expedited review of a test submission is needed; do not give reviewers owner-only Cloudflare admin access.

Community account controls > Delete Community Account: complete Apple reauthentication if prompted. Community profile/sessions/content are removed, with queued media cleanup; personal device decks remain. Live exchange/retention and accepted revocation are supported by the evidence in APPLE_SETUP.md; the app completion fix and live deletion retest are reported successful; confirm final distribution export separately and keep signed webhook delivery marked unverified. Admin audit/security records can survive deletion as disclosed in the privacy policy. Abuse reports are reviewed by the owner, who can reject/hide/delete and suspend/ban persistently.

## Sources

- https://developer.apple.com/app-store/review/guidelines/ (1.2 UGC, 5.1 privacy/account deletion)
- https://developer.apple.com/app-store/app-privacy-details/
- https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating
- https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/
