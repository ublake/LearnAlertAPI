# Private developer options

Developer access lives on `community_users.is_developer` in D1. It is never returned in public creator profiles. Authenticated owner profiles include `isDeveloper` and `allowAnkiUploads` only for developers. Ordinary clients cannot grant themselves the role.

Grant access to a known account from the Cloudflare D1 console:

```sql
UPDATE community_users SET is_developer=1 WHERE handle='@jolly_sprout' COLLATE NOCASE;
```

Revoke access and its upload preference:

```sql
UPDATE community_users SET is_developer=0,developer_anki_uploads=0 WHERE handle='@jolly_sprout' COLLATE NOCASE;
```

The app refreshes its owner profile when Settings opens. Its Developer options section saves the Anki upload switch through authenticated `PUT /v1/community/account/developer`. The server checks the current role and switch again for drafts, binary attachments, and submissions. The switch defaults off. Published decks remain subject to the usual moderation, blocking, reporting, and media ownership checks.

Developers can set an optional `publisherHandle` per submission. It changes only the listing attribution, never their permanent account username or the stable profile ID. It can also be used for native decks while Anki uploads are disabled.

Anki submissions retain HTML/CSS, card metadata, and original media names mapped to private upload IDs. Binary files remain opaque on the API and are rendered only in the app's existing isolated Anki renderer after downloading. Standard limits still apply: 500 cards, 1,000 attachments, 20 MB per Anki attachment, 100 MB total, and 1 MB of card templates per submission. Normal accounts receive “Uploading decks imported from Anki are not supported yet”.
