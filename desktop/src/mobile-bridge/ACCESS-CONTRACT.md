# Google sign-in deployment contract — pending flux confirmation

Selected architecture: Cloudflare Access with a dedicated Google IdP. No application OAuth
client, Google SDK, refresh token, client secret, or weather-logger client reuse is introduced.
This source is based on installed 5c2af139. It does not configure Cloudflare or the live profile.

## Counterpart inputs required before deployment

Flux owns Google Cloud and Cloudflare setup. Return these non-secret facts to the coordinator:

- Exact team issuer (`https://TEAM.cloudflareaccess.com`), application AUD (64 hex), Google
  IdP ID, and application/policy IDs. JWKS is derived only as issuer + `/cdn-cgi/access/certs`;
  arbitrary discovery/JWKS URLs and JWT-provided key URLs are never accepted.
- Evidence that this app accepts only the newly configured Google IdP and the single exact
  user-authorized Google email. No domain-wide, Everyone, OTP fallback, or other IdP policy.
  Populate the private account file with the email explicitly supplied in the task; do not
  infer an identity from local Google accounts, git settings, or existing OAuth clients.
- Edge route behavior below, including whether Cloudflare can supply JSON 401 for API
  subrequests. If normalization needs a Worker, flux owns it; origin validation remains required.
  Do not create an Access Bypass rule to make API calls work.
- Access session TTL and logout behavior. App sessions last at most one hour and never beyond
  the assertion or local account grant expiry. Origin checks the Access assertion on every
  request, including again after command-body upload.
- Automation compatibility confirmation: same original bearer endpoint/envelope/token, PLUS
  a user Access credential for the same approved account at the edge. The forwarded signed
  assertion must carry that approved email. Service-token-only identities are NOT admitted.
  If existing automation needs a service principal, stop and obtain an explicit identity/grant
  contract; do not silently enroll it or weaken the edge policy.

No private profile edits, Google/Cloudflare resource creation, app install/restart, or deployment
have been performed by this source change. An App-confirmed install/restart remains required.

## Routes and edge behavior

| Path | Browser behavior | Origin authorization |
| --- | --- | --- |
| `/mobile/*` | Static public login shell; no data or credentials | Exact Host; fixed asset allowlist |
| `GET /api/mobile/login` | Explicit top-level Google/Access login; valid return redirects only to `/mobile/` | Signed allowed Access identity; no session created by GET |
| `POST /api/mobile/session` | Same-origin session bootstrap/resume; no redirects | Signed allowed identity, exact Origin, `X-Botling-Session: 1` |
| `POST /api/mobile/browser/command` | JSON API; never follow IdP redirects | Signed allowed identity + opaque app session + CSRF + exact Origin + bot scope |
| `POST /api/mobile/logout` | Invalidate app sessions, then top-level `/cdn-cgi/access/logout` | Signed allowed identity + app session + CSRF + exact Origin + custom session header |
| `POST /api/mobile/command` | Existing automation endpoint; no cookie-only auth | Existing bearer policy AND signed allowed Access identity when Access enabled; intersect bot grants |
| `/cdn-cgi/access/*` | Cloudflare-owned login/logout endpoints | Cloudflare Access |

Protect ALL `/api/mobile/*` at the edge; preserve public Host and the assertion header to the
TLS-verified loopback backend. Static shell access is not data access. Google redirect belongs
only to top-level login; API requests should return JSON `401 {"error":{"code":"auth_required"}}`
or `403 {"error":{"code":"access_denied"}}`. App-generated failures already have this shape.
The frontend never follows API redirects (`redirect: manual`); unexpected opaque redirects become
an expired-session state, not a fetch to Google. Edge HTML 403 is displayed as edge/account denial,
not as a bot grant failure. A matching protocol envelope with `forbidden` identifies a bot denial.
No CORS support, forwarded-host trust, arbitrary return URL, or tokens in URLs is added.

## Private configuration (owner-only files)

Keep existing origin, listener/TLS, clientsFile, assets and mutation journal. Add only:

```json
"access": {
  "issuer": "https://REPLACE.cloudflareaccess.com",
  "audience": "REPLACE_WITH_EXACT_APP_AUD",
  "accountsFile": "/ABSOLUTE/private/mobile/accounts.json"
}
```

Place one record in that private file, using the explicitly authorized email and a deliberate
expiry in epoch milliseconds. This template is intentionally not an activatable policy:

```json
[{
  "id": "google-owner",
  "email": "REPLACE_WITH_USER_AUTHORIZED_EMAIL",
  "botIds": ["6A0B0000-0000-4000-8000-000000000002"],
  "expiresAt": 0
}]
```

The runtime allows at most one account and exactly Main as its bot grant. Empty policy revokes
access. Account policy is read on each request; invalid/missing policy or unreadable JWKS fails
closed. Keep the stable account ID and mutation journal across renewals. The account email is
accepted only from the signed JWT; a plain `Cf-Access-Authenticated-User-Email` header does nothing.
Google verification is delegated to the dedicated Google-only Access policy, not an assumed
`email_verified` field in Access JWTs. Never paste actual cookies/assertions into reports or logs.

The verifier requires RS256, RSA >=2048, pinned issuer, matching audience, app token type,
nonempty subject/email, expiration, issued-at and optional not-before. JWKS fetches use HTTPS,
no redirects, five-second timeout, 64 KiB limit, five-minute cache and bounded rotation refresh.
It never refreshes from token-supplied URLs. The app session is a random opaque `__Host-` cookie
(Secure, HttpOnly, SameSite=Strict), stored hashed in memory; CSRF values stay only in page memory.
Logout removes all app sessions for the principal and denies the current assertion until expiry
in this running core, then invokes Cloudflare logout. Access handles global token revocation;
its propagation is not instant. A core restart invalidates app sessions; its local assertion
revocation cache is not durable, so edge logout/revocation is essential. JWTs are bearer credentials,
not proof-of-possession tokens; do not claim prevention of all stolen-token replay.

## Mobile behavior and validation gate

The UI replaces manual token entry with explicit Google login and session bootstrap on return or
reload. Draft text is saved in tab-scoped sessionStorage, keyed by a hash of the verified principal;
no tokens, CSRF, cookies, chat snapshots, or email are saved. Different principals cannot restore
one another's drafts. Explicit sign-out clears drafts. Expiry keeps drafts, bot denial keeps the
session, successful refresh clears stale errors, and narrow navigation starts closed. Storage
restrictions can reduce draft retention to memory; physical-device acceptance remains required.

Run only when the coordinator allocates the test slot:

- Focused Access identity/session tests: valid identity, unknown/missing email, forged signatures,
  issuer/audience/expiry/nbf/algorithm, JWKS outage, account revocation, session/CSRF/logout replay.
- Bridge route tests: structured missing-auth errors, origin/CSRF failure, bot 403, Main scope,
  bearer plus Access intersection, mutation ledger replay. Reuse existing TLS/external evidence;
  no new live mutation is authorized for acceptance.
- Mobile tests: return/reload, expiry/reconnect/draft retention, denied bot, no credential storage,
  no overlapping polls, and logout. Then isolated browser viewport interaction at 320×568 and
  390×844 (not only screenshots). Live checks must remain read-only snapshots.
- No full suite, package/build, install, restart, main merge, push, Rust, desktop switching or
  React migration belongs to this worker's current scope.

Official references checked for this design:
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
- https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
