# Private developer options

Developer access lives on `community_users.is_developer` in D1. It is never returned in public creator profiles. Authenticated owner profiles include `isDeveloper` and `allowAnkiUploads` only for developers. Ordinary clients cannot grant themselves the role.

Manage access from the protected website `/admin` dashboard's Developer role section. Search for an existing account, grant or revoke Developer access, and choose whether to enable Anki uploads. Granting Developer access defaults the upload option off. Revoking access clears the upload option without deleting the profile, sessions, decks, or moderation state. Developer access does not grant admin access.

The dashboard uses `GET /v1/admin/developers?q=&offset=&role=all|developer` to list accounts. It returns the normal `items` and `nextOffset` page fields; each item includes private account ID, public author ID, handle, creation time, profile-completion status, and the two capability flags. These flags remain absent from public creator profiles.

`POST /v1/admin/developers/update` requires exactly this JSON shape, with all four flags as booleans:

```json
{
  "id": "account-id-from-the-admin-list",
  "isDeveloper": true,
  "allowAnkiUploads": false,
  "expectedIsDeveloper": false,
  "expectedAllowAnkiUploads": false
}
```

The expected flags must match the account snapshot shown in the dashboard. A stale snapshot returns `409` and creates no audit entry; reload the account before trying again. Unknown fields, invalid types, or enabling Anki uploads without Developer access return `400`; a missing account returns `404`. Success returns `{ "success": true, "user": { "id": "...", "handle": "@...", "isDeveloper": true, "allowAnkiUploads": false } }`.

Both endpoints require the existing signed Cloudflare Access identity and admin email allowlist. Writes also require the website's same-origin JSON request. Each successful update and its `update_developer` audit entry commit together, recording the actor, account ID, and before/after flags. Ordinary community session tokens cannot call these endpoints.

For direct database maintenance, access can also be granted from the Cloudflare D1 console:

```sql
UPDATE community_users SET is_developer=1,developer_anki_uploads=0 WHERE handle='@jolly_sprout' COLLATE NOCASE;
```

Revoke access and its upload preference:

```sql
UPDATE community_users SET is_developer=0,developer_anki_uploads=0 WHERE handle='@jolly_sprout' COLLATE NOCASE;
```

The backend also supports authenticated `PUT /v1/community/account/developer` for an existing developer to save their own `allowAnkiUploads` preference. The current iOS Settings screen does not expose this developer options menu; the admin controls do not change the app's upload screens or their gates. The server checks the current role and switch again for drafts, binary attachments, and submissions. The switch defaults off. Published decks remain subject to the usual moderation, blocking, reporting, and media ownership checks.

Developers can set an optional `publisherHandle` per submission. It changes only the listing attribution, never their permanent account username or the stable profile ID. It can also be used for native decks while Anki uploads are disabled.

Anki submissions retain HTML/CSS, card metadata, and original media names mapped to private upload IDs. Binary files remain opaque on the API and are rendered only in the app's existing isolated Anki renderer after downloading. Standard limits still apply: 500 cards, 1,000 attachments, 20 MB per Anki attachment, 100 MB total, and 1 MB of card templates per submission. Normal accounts receive “Uploading decks imported from Anki are not supported yet”.
