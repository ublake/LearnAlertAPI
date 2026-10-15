# Apple authorization lifecycle

Configured October 14, 2026. Production Worker `learnalertapi` uses `APPLE_CLIENT_ID=com.learnalert.app`, Apple Team ID `5UCA258TUZ`, and SIWA-only Key ID `LWATVP7S48`, registered with owner approval for primary App ID `5UCA258TUZ.com.learnalert.app`. The prior downloaded key `27B7A3X76Q` was verified by the coordinating app chat as Apple Maps only and was not used for SIWA.

All four values are installed as Cloudflare secrets: `APPLE_PRIVATE_KEY`, `APPLE_KEY_ID`, `APPLE_TEAM_ID`, and `APPLE_TOKEN_ENCRYPTION_KEY`. The private key file was verified as PKCS#8 P-256 and secured to mode 0600. A fresh random 32-byte base64 AES key was generated without logging it. Secret values were passed only through stdin, never command arguments or repository files. Repeat setup preserves an existing encryption key; never rotate it without re-encrypting saved tokens and queued jobs.

API release: `1018792f-16a2-4e4e-9758-f960f35b713b`. Live health reports `community.appleRevocationConfigured=true` with existing database/media bindings intact. The actual key passed local ES256 client-secret signature and required-claims checks. All four lifecycle/safety tests passed. Unsigned production notifications return 401 / APPLE_EVENT_INVALID.

The coordinating Apple Developer flow saved and reopened the primary app's configuration to confirm this server notification endpoint is registered: `https://api.learnalertapp.com/v1/community/auth/apple/notifications`. Primary `com.learnalert.app` remained selected. APPLE_NOTIFICATION_AUDIENCE falls back to APPLE_CLIENT_ID; never accept arbitrary audiences or relax signatures.

**Still unverified:** a fresh real Apple authorization-code exchange, subsequent token revocation/account deletion, and actual signed notification delivery. Configuration presence, local signing and mocked tests do not establish those live outcomes. No real user token was exchanged or revoked by this setup task, and no public deck or profile was changed.

## Maintenance

Use Wrangler secret put with safe stdin/file input; never commit a .p8 or env file or print key/token material. All four settings are secrets so normal deployment preserves them. If using non-secret Worker variables instead, add their values to wrangler.jsonc before redeploying; Dashboard-only variables may be overwritten by Wrangler. New key registration or permission changes require owner authorization. Retain the installed encryption key across deployment/key-signing rotation.

## Client contract

POST /v1/community/auth/apple accepts identityToken, nonce (original 64-character hex nonce), and optional authorizationCode. Token signature, issuer, audience, expiry, recent issue time and SHA-256 nonce are verified. Configured code exchange also verifies the returned Apple identity token and exact subject. It stores only an AES-GCM-encrypted refresh token, never raw tokens in audit/logs/client responses. Response adds appleRevocationAvailable boolean and profile.authorID; legacy sign-in without a code still works.

DELETE /v1/community/account uses the existing bearer session and optionally {identityToken, authorizationCode, nonce}. Every supplied fresh identity must match the authenticated account. With configured revocation, a legacy account without a saved token returns HTTP 409 / APPLE_REAUTH_REQUIRED until fresh Apple reauthentication is supplied; nothing is deleted on this response. With a saved token, no-body deletion still works. When configuration is absent, no-body deletion still removes community data and returns appleRevocation=not_configured; this fallback is no longer the active production configuration. Existing accounts without retained tokens now need the app’s fresh Apple reauthentication flow before deletion.

Successful deletion removes community data immediately and returns success:true plus appleRevocation=revoked, pending, or not_configured. Encrypted token jobs survive deletion and retry daily on transient failure. They contain no decks/profile data and are removed only after Apple accepts revocation. An existing banned/suspended profile can sign in for management, inspect GET /account and /account/decks and delete with its valid session; the restriction survives deletion. Admin profile deletion similarly queues retained tokens.

Apple notifications accept JSON {payload: signedJWT}. RS256 signatures, known Apple key, issuer, configured audience, issue time (within seven days), optional expiry and unique jti are checked. Apple examples omit exp; absence does not disable signature/time verification. consent-revoked/account-deleted delete only the matching account whose creation predates the event, its sessions and community content. Email events are acknowledged without collecting email. Receipt IDs deduplicate deliveries for 30 days; old events do not remove a newly created account. The endpoint is registered; a real signed Apple notification delivery remains to be tested.

## Validation required before submission

Mocked Apple tests verify ES256 client secrets, code exchange, mismatched identities, AES-GCM storage, reauthentication errors, immediate deletion, transient revocation retry, verified server notifications and replay/stale-account guards. With the enabled key/config now installed, test a disposable real Apple account's authorization and deletion, verify Apple's revoked credential state, and test signed server notifications before claiming the lifecycle complete in production.

Primary references:
- https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
- https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
- https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens
- https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts
- https://developer.apple.com/help/account/capabilities/enabling-server-to-server-notifications
