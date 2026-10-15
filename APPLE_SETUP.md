# Apple authorization lifecycle

As checked October 14, 2026, production has APPLE_CLIENT_ID=com.learnalert.app but no Apple revocation secrets. Existing sign-in/verification is operational; production Apple token exchange/revocation has NOT been verified. A downloaded AuthKey .p8 file exists but its Sign in with Apple capability is unverified. An App Store Connect API key is not interchangeable with a Sign in with Apple key.

Required operator inputs:

1. A PKCS#8 P-256 .p8 private key specifically enabled for Sign in with Apple and associated with LearnAlert's primary App ID. Supply its secure local file path, never paste it into source/docs/chat.
2. Its 10-character Apple Key ID: APPLE_KEY_ID.
3. Apple developer Team ID: APPLE_TEAM_ID. The app project currently specifies 5UCA258TUZ; confirm that the key belongs to that team.
4. APPLE_TOKEN_ENCRYPTION_KEY: a separately generated random 32-byte AES key encoded in base64, installed as a Cloudflare secret. Do not rotate without re-encrypting stored tokens and queued revocations.
5. Register https://api.learnalertapp.com/v1/community/auth/apple/notifications as the Sign in with Apple server-to-server endpoint for the primary app group. APPLE_NOTIFICATION_AUDIENCE may be set if the group's audience differs from APPLE_CLIENT_ID; never relax verification or accept arbitrary audiences.

Install private key and encryption key using Wrangler secret put with stdin/file input; never commit a .p8 or env file. APPLE_KEY_ID and APPLE_TEAM_ID can also be installed as secrets so deployment preserves them. If using non-secret Worker variables instead, add their values to wrangler.jsonc before redeploying; Dashboard-only variables may be overwritten by Wrangler. Deploy only after configuration verification. Registering a new Apple key/permission is an owner action. No credentials were installed or new Apple permissions granted by this task.

## Client contract

POST /v1/community/auth/apple accepts identityToken, nonce (original 64-character hex nonce), and optional authorizationCode. Token signature, issuer, audience, expiry, recent issue time and SHA-256 nonce are verified. Configured code exchange also verifies the returned Apple identity token and exact subject. It stores only an AES-GCM-encrypted refresh token, never raw tokens in audit/logs/client responses. Response adds appleRevocationAvailable boolean and profile.authorID; legacy sign-in without a code still works.

DELETE /v1/community/account uses the existing bearer session and optionally {identityToken, authorizationCode, nonce}. Every supplied fresh identity must match the authenticated account. With configured revocation, a legacy account without a saved token returns HTTP 409 / APPLE_REAUTH_REQUIRED until fresh Apple reauthentication is supplied; nothing is deleted on this response. With a saved token, no-body deletion still works. Unconfigured production continues to accept existing no-body deletion and returns appleRevocation=not_configured; this is not proof of Apple authorization revocation.

Successful deletion removes community data immediately and returns success:true plus appleRevocation=revoked, pending, or not_configured. Encrypted token jobs survive deletion and retry daily on transient failure. They contain no decks/profile data and are removed only after Apple accepts revocation. An existing banned/suspended profile can sign in for management, inspect GET /account and /account/decks and delete with its valid session; the restriction survives deletion. Admin profile deletion similarly queues retained tokens.

Apple notifications accept JSON {payload: signedJWT}. RS256 signatures, known Apple key, issuer, configured audience, issue time (within seven days), optional expiry and unique jti are checked. Apple examples omit exp; absence does not disable signature/time verification. consent-revoked/account-deleted delete only the matching account whose creation predates the event, its sessions and community content. Email events are acknowledged without collecting email. Receipt IDs deduplicate deliveries for 30 days; old events do not remove a newly created account. This endpoint still needs registration and a real Apple notification test.

## Validation required before submission

Mocked Apple tests verify ES256 client secrets, code exchange, mismatched identities, AES-GCM storage, reauthentication errors, immediate deletion, transient revocation retry, verified server notifications and replay/stale-account guards. Obtain the enabled key/config, test a disposable real Apple account's authorization and deletion, verify Apple's revoked credential state, and test signed server notifications before claiming the lifecycle complete in production.

Primary references:
- https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
- https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
- https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens
- https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts
- https://developer.apple.com/help/account/capabilities/enabling-server-to-server-notifications
