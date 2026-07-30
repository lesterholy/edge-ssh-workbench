# Google login deployment

EdgeSSH uses Google OpenID Connect for an optional second sign-in method. It does not create application users: every allowed Google identity is bound to the one existing `admin` record, and password login remains available for recovery.

## Security model

- Only addresses in `GOOGLE_ALLOWED_EMAILS` can complete sign-in.
- The stable Google `sub` claim is stored as the identity key; email is an authorization allowlist, not the primary key.
- The Worker verifies the ID token signature, issuer, audience, expiry, nonce and `email_verified` claim.
- The authorization flow can be started only by a same-origin `POST`; it then uses `state`, a browser-bound HttpOnly cookie and PKCE. Attempts expire after ten minutes and are consumed atomically.
- Google login is an alternative authentication method and does not request the application's TOTP code. Password login continues to require TOTP when TOTP is enabled.
- Removing an address from the allowlist blocks new Google logins but does not revoke an existing application session. Revoke `auth_sessions` separately when immediate logout is required.

## Google Cloud Console

1. Configure the OAuth consent screen and add the administrator as a test user while the app remains in testing mode.
2. Create an OAuth client with application type **Web application**.
3. Add the exact authorized redirect URI. There is no wildcard matching:

```text
http://localhost:8787/api/auth/google/callback
https://your-domain.example/api/auth/google/callback
```

Use separate Google clients for local and production environments when possible. Do not use an OAuth client secret intended for a native or mobile application.

## Local development

Apply the new D1 migration:

```bash
npm run db:migrate:local
```

Add all four values to `.dev.vars` without removing the existing authentication and encryption keys:

```dotenv
APP_ENV=development
GOOGLE_CLIENT_ID=your-google-oauth-web-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-web-client-secret
GOOGLE_REDIRECT_URI=http://localhost:8787/api/auth/google/callback
GOOGLE_ALLOWED_EMAILS=admin@example.com
```

Multiple recovery accounts may be comma-separated. They still map to the same application administrator:

```dotenv
GOOGLE_ALLOWED_EMAILS=primary@example.com,recovery@example.com
```

Restart Wrangler after changing `.dev.vars`, then use the integrated local URL `http://localhost:8787` for the OAuth flow. Do not open `127.0.0.1` when the callback uses `localhost`: the application origin and `GOOGLE_REDIRECT_URI` origin must match exactly so the browser returns the host-only transaction cookie.

## Cloudflare deployment

First apply migrations to the remote D1 database:

```bash
npm run db:migrate:remote
```

Set the non-secret bindings in `[vars]` in `wrangler.toml`:

```toml
GOOGLE_CLIENT_ID = "your-google-oauth-web-client-id"
GOOGLE_REDIRECT_URI = "https://your-domain.example/api/auth/google/callback"
GOOGLE_ALLOWED_EMAILS = "admin@example.com"
```

Upload only the client secret through Wrangler, then deploy:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
npm run deploy
```

The callback origin and path must exactly match `GOOGLE_REDIRECT_URI`. Production callbacks must use HTTPS.

## Disable or rotate

To disable the Google button, remove the three `GOOGLE_*` variables from `wrangler.toml`, delete the secret, and deploy the resulting configuration:

```bash
npx wrangler secret delete GOOGLE_CLIENT_SECRET
npm run deploy
```

Deleting the Google secret does not affect the admin password, saved SSH credentials, TOTP secret or existing application sessions. Rotate the client secret in Google Cloud Console, upload the replacement with `wrangler secret put`, and revoke the old Google secret after verifying sign-in.
