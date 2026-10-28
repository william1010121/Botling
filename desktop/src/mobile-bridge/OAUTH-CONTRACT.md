# App-owned mobile Google OAuth

This candidate replaces the unshipped Cloudflare Access implementation. No Access application,
IdP headers, edge login redirects, service account, or Google/cloud reconfiguration is required.
The existing HTTPS Tunnel forwards `/mobile/` and `/api/mobile/` unchanged to the private listener.
Only the app shell is public; every snapshot and mutation still requires authorization.

## Private deployment input (integration step, not performed by this candidate)

Add `google: { "credentialsFile": "<absolute owner-only credential JSON path>" }` to the existing
selected-profile mobile configuration. Keep TLS, clientsFile, assets, host and port unchanged.
The supplied credentials live outside the repo at `~/.botling-mobile-auth/google-oauth-client.json`;
expand `~` to an absolute path in config. The file must be owned by the current OS user and have
no group/world permission bits (0600). No secret, Google token or session is written to logs or repo.

Expected private JSON fields are `client_id`, `client_secret`, `project_id`, `redirect_uri`,
`javascript_origin`, and `allowed_emails` (exactly one lowercase email). Preserve the user's supplied
single-account allowlist. Both the origin and callback must match the selected bridge exactly:

- origin: `https://botling-bridge.driseam.com`
- callback: `https://botling-bridge.driseam.com/api/mobile/auth/google/callback`

The server requires Google's signed `email_verified: true` and exact membership in this local
allowlist. Google's consent-screen **Testing** audience is not the server allowlist.
All Google browser sessions grant **Main only**; the policy is reread on each session operation,
including after a command body has arrived. An invalid configuration fails closed.
The existing bearer clients retain their own bot ACL and expiration; they do not require Google login.
Omitting `google` leaves automation working and browser auth unavailable (503).

## Routes and security behavior

| Route | Contract |
| --- | --- |
| GET `/api/mobile/login` | Start Google authorization-code flow, S256 PKCE, nonce and random state; no arbitrary return URL |
| GET `/api/mobile/auth/google/callback` | Validate one-time browser-bound state, exchange code at pinned Google endpoint, verify ID token, rotate session; 303 to `/mobile/` |
| POST `/api/mobile/session` | Exact same-origin + `X-Botling-Session: 1`; return existing session metadata/CSRF, never create a session from an unsigned header |
| POST `/api/mobile/browser/command` | Opaque cookie, exact Origin and CSRF; existing command/bot/ledger gates |
| POST `/api/mobile/logout` | Exact Origin, session marker, cookie and CSRF; revoke all current sessions of this principal and clear flow/session cookies |
| POST `/api/mobile/command` | Existing independent bearer authentication and bot ACL; no Google requirement |

Public shell assets and top-level login/callback GETs allow cross-site navigation; private APIs do not. Cookies use `__Host-`, Secure,
HttpOnly, Path=/, SameSite=Lax (Google's top-level return must carry the transaction cookie).
Sessions are random opaque identifiers, stored only as SHA-256 lookup keys in memory, with
separate random CSRF tokens. Session lifetime is at most one hour and no later than ID-token expiry;
transactions expire after ten minutes. Both collections are bounded and pruned. Restart requires
sign-in again; it cannot restore a revoked/stale session. An in-progress code is consumed before
network awaits, so concurrent callbacks and replay fail closed. Logout or transaction expiry during
exchange also prevents a late callback from restoring a session.

JWT validation pins Google's HTTPS JWKS endpoint, RS256 and RSA >=2048; checks signature, issuer,
audience/authorized party, expiry/issued-at/not-before, nonce, subject and verified email. JWKS
fetches are bounded, timed out, cached for at most five minutes and rate-limited. Expired keys are
not used during outages. Token exchange follows no redirects and never requests offline access;
Google access/refresh tokens are not stored. No ID token enters the browser.

API authentication failures are JSON 401/403/503, never Google redirects. Callback errors return
only a fixed error code to `/mobile/`, with no authorization code, token or provider error text.
Responses are no-store with no-referrer and nosniff. Browser draft text stays in tab-scoped storage
under the verified principal; login/reload/expiry/denial/offline retain it. Sign-out clears it.
If storage is unavailable, drafts survive only while that page remains loaded.

## Validation and remaining acceptance

Focused synthetic tests exercise the real handler with a loopback HTTP fixture, generated RSA keys
and a mock Google exchange enforcing the PKCE challenge. Production still uses the HTTPS server.
These tests are not a live Google/phone acceptance claim. Existing bearer mutation replay and
core approval gates remain in place. No live send, approval, account change or deployment is needed
for these checks.

Integration must opt in the private config, include both server and mobile assets in the cumulative
candidate, and run its separately authorized packaging/deployment pass. Afterwards verify a real
Google round trip, deny a different account, reload/expire/logout and retain the unsent draft through
login. Real phone keyboard/layout/Add-to-Home-Screen behavior remains separate device acceptance.

Protocol reference: https://developers.google.com/identity/openid-connect/openid-connect

Focused verification on 2026-10-28: 27 mobile tests; 26 OAuth security tests plus 1 HTTP handler
integration test; 19 startup/bearer bridge tests, all passing (73 distinct tests). Both desktop
and mobile TypeScript checks pass. The handler's return-page regression and the OAuth
logout-during-exchange tests were rerun after their fixes; unchanged startup/bearer/mobile
results were reused. No package build, live Google exchange, installation or restart was run.
