# Private mobile bridge (review required)

Protocol v10, `POST /api/mobile/command`, same-origin bearer authentication. Mobile assets are
served at `/mobile/`; only the public application shell is unauthenticated. Every data/command
request needs a current token and an explicit bot grant. There is no default HTTP listener, public bind,
CORS, reverse-proxy trust or file endpoint.
No listener starts unless the local owner supplies `BOTLING_MOBILE_CONFIG`, or creates the
owner-only `<selected core data>/mobile/config.json` opt-in before core startup.
Bearer tokens are the only sign-in. A `google` field left in an older config file is ignored.

The core adapter allows snapshot/send/choose/answer only. Existing boot-activation checks,
plugin before-send hooks and question/approval semantics run through core `handle` unchanged.
Snapshot does not invoke `chat.read`, and exposes only selected chat data and authorized bot
summaries, not global settings, plugin information, other bots' waiting lists or web sessions.
Send returns the existing `{messageId, turnId: string|null}`; choose/answer preserve
`{accepted: boolean}`, including false. Mobile answers cannot carry images.
The phone is told of changes over the event stream (below) and then reads the snapshot; polling remains the fallback.

The pending-file check MUST execute in the core event loop with no await/IPC/defer before
`handle(chat.send)`, whose current synchronous prefix consumes pending files. This protects
against files staged after the previous snapshot. Files staged after dispatch remain queued
for the next desktop send. A Rust adapter must preserve this atomic boundary explicitly.

## Durable mutation semantics

`mobile-mutations/` in the core data directory stores one owner-only record per authenticated
client ID + request ID. A lock and atomic fsync/rename claim the ID before dispatch. Reuse with
a different canonical command gets `conflict`; a completed outcome (including declined answers
and errors) is replayed. Parallel duplicates get a pending/conflict response while the first runs.
After loss of the HTTP response, reconnect/retry with the SAME ID gets the saved outcome.
After a crash between core side effects and result persistence, pending remains uncertain and
will NEVER dispatch again. This is at-most-once dispatch, not exactly-once delivery. Check chat
manually; a new request ID is a new operation and may duplicate a prior message.

Do not delete journals to resolve uncertainty. No TTL/pruning is applied: deleting records would
allow delayed duplicate requests to execute. Storage grows with mutations. Keep client IDs
stable when reissuing a token for the same client. Secure/back up this directory with core data;
it contains outcomes, but not bearer tokens or command text. Power-loss guarantees depend on
the existing core atomic-file implementation (directory fsync is best-effort, especially Windows).

See [LOCAL-SETUP.md](LOCAL-SETUP.md) for the inert config template, offline preflight,
startup prerequisites and device acceptance checklist.

## Local setup for later authorized activation

These are setup instructions, not evidence that a phone can connect. No config was enabled,
live token issued, app installed/restarted or public route deployed by this change.

1. Integrate the mobile frontend commits `32da511` / `f595687` and bridge only after Claude review.
   Build `desktop/mobile/dist` in the assigned validation slot. Its absolute path is `assets` below.
2. Use public origin `https://botling-bridge.driseam.com` with the Mac's private HTTPS listener
   `127.0.0.1:8443` and local Cloudflare Tunnel connector. The upstream certificate SAN must match
   the public hostname, and its issuer must be trusted by the connector; the phone separately
   verifies the public edge certificate. Wait for flux-k8s to confirm the connector/trust scheme
   before creating production credentials/config. Flux owns Tunnel/rate-limit configuration; Cloudflare Access is not used;
   app bearer/bot checks remain unchanged. No router port-forward, CA or device trust change.
3. In a user-owned private directory (`chmod 700`), run the local setup command:

   ```sh
   node desktop/src/mobile-bridge/setup.mjs issue /absolute/private/clients.json phone /absolute/private/phone-token.txt 6A0B0000-0000-4000-8000-000000000002
   ```

   This grants Main only for 30 days. Append specific bot IDs for other projects. The random token
   is written once to a 0600 file, never printed. Transfer it privately to the phone's in-memory
   token field; do not put it in URLs, logs or shared screenshots. There is no token recovery endpoint.
   Revoke with `node desktop/src/mobile-bridge/setup.mjs revoke /absolute/private/clients.json phone`.
   Revocation applies to subsequent API requests (including replay), not commands already dispatched.
4. Write a 0600 config file owned by the account running the core, for example:

   ```json
   {
     "origin": "https://botling-bridge.driseam.com",
     "host": "127.0.0.1",
     "port": 8443,
     "certFile": "/absolute/private/server-cert.pem",
     "keyFile": "/absolute/private/server-key.pem",
     "clientsFile": "/absolute/private/clients.json",
     "assets": "/absolute/checkout/desktop/mobile/dist"
   }
   ```

   Keep the private key owner-only. For persistent opt-in, put config.json in the selected core
   data directory's private `mobile/` directory (0700); config.json and clients.json must be 0600.
   Main supplies this core data directory from the actual selected app profile (`<profile>/core`).
   An explicit `BOTLING_MOBILE_CONFIG` overrides discovery; an explicitly empty value disables it.
   Missing default config means disabled; malformed/insecure config fails closed without fallback.
   Discovery never exports its path into the environment, so another selected profile does not
   inherit it. Probe cores always skip mobile. No settings.json or global environment changes.
   A future Rust migration must preserve this profile-local opt-in and override precedence.
5. On the phone, open `https://botling-bridge.driseam.com/mobile/`, enter the token, check the expected
   Main/project content, then test a harmless send and a question response. Verify desktop unread
   is unchanged by snapshots, and desktop queued attachments block sending. Verify revocation.
   Actual phone DNS/firewall/TLS trust and Safari keyboard/home-screen behavior remain unverified.

## Bounded checks

From `desktop/`, with linked existing dependencies and the coordinator's validation slot:

```sh
node node_modules/vitest/vitest.mjs run --config src/mobile-bridge/vitest.config.ts
node node_modules/typescript/bin/tsc --noEmit -p src/mobile-bridge/tsconfig.json
```

Tests use temporary synthetic credentials/data and one ephemeral loopback HTTPS server. They
cover socket response loss, persisted replay, parallel duplicate claims, changed-command conflict,
crash uncertainty, client separation, authentication/revocation, Origin/Host, route/command/bot
allowlists, snapshots and the atomic no-yield queue boundary. They do not start a live core/agent,
claim physical phone access, or replace a cumulative integration test against real core hooks.

## Core handover and mobile approvals (2026-10-28)

Probe cores (BOTLING_CORE_PROBE=1) skip the bridge before reading configuration or
creating a listener. During normal startup only EADDRINUSE is retried, on the same server:
250, 500, 1000, 2000, 4000, 4000, 4000 ms (eight attempts, 15.75 seconds of waiting).
A successful listen ends retries. Core shutdown cancels retries and pending listen, stops
accepting connections and closes active connections before core teardown. Invalid config,
TLS or other bind errors fail closed; exhaustion reports unavailability without endless timers.

User decision 2026-10-28, message 42FBCEBB-A352-4A4C-A3A3-71120F245F1B:「允許手機核准」.
A token holder may choose tool permissions (permissionTool), auto-mode denial overrides
(denialAsks), and App questions including install confirmations. This uses the existing
core handle/Bot.choose checks: valid unexpired/unrevoked token, explicitly allowed bot,
activated core, existing open question and valid choice; tool permissions additionally need
an outstanding approval. Accepted:false remains false. No new bypass or bot grant is added.
The regression uses controlled approval callbacks, never a real tool approval or installer.

## Local Cloudflare Tunnel compatibility

Public browser origin and private listener port are independent. For the coordinated deployment,
use public origin `https://botling-bridge.driseam.com` with `host: "127.0.0.1", port: 8443`.
The connector runs on the Mac; the cluster cannot route the home LAN. It must connect using HTTPS,
set TLS server name to `botling-bridge.driseam.com`, and verify the upstream certificate against
its configured trusted issuer. Preserve HTTP Host `botling-bridge.driseam.com`, browser Origin
`https://botling-bridge.driseam.com`, and Authorization unchanged. Do not rewrite Host to
`127.0.0.1:8443`, trust forwarded headers, or disable TLS verification. The port separation changes
only listener configuration; exact Host/Origin, HTTPS, private bind and bearer/bot checks remain.

Use `/mobile/` with its trailing slash and `/api/mobile/command`. This is HTTP snapshot polling,
not WebSocket/SSE. Public edge authentication may add protection but never replaces the app token.
Cloudflare account/token/DNS/tunnel resources are owned by flux-k8s; this code does not provision
them or install/start cloudflared. Certificate issuance/trust and device access remain deployment
acceptance tasks. No root process or privileged port is needed for the local listener.

## One-time pairing

`GET /api/mobile/core` is public and secret-free: `{ app, coreId, protocol, pairing: { ttlSeconds } }`.
The Core ID is random, kept in `<data>/mobile/core-id.json`.

Local setup prints a pairing link: `node out/mobile-bridge/pair.cjs <data>/mobile https://ORIGIN BOT_ID...`
gives `https://ORIGIN/mobile/#pair=<secret>&core=<coreId>` (render it as a QR). The secret is in the
fragment, valid 5 minutes, usable once, and only its SHA-256 is stored (`pairing-offers.json`, mode 0600).
The page checks `coreId` against the descriptor, then `POST /api/mobile/pair { secret, deviceId }` returns a
bearer token. That token is an ordinary client (explicit bots, 30 days) in `paired-clients.json`, merged
with the clients file; pairing the same device again replaces its session. Unknown, used and expired codes
all answer 401; past five wrong guesses in a minute they answer 429 for the rest of the window, but a
valid code is never refused (it has 256 bits; the limit is about noise, not guessing).

### Phone settings, devices and the command line

Settings > Phone (desktop) makes the code as a QR picture for the bots you tick, and lists and revokes
paired phones; the same store is used by `node out/mobile-bridge/pair.cjs devices <data>/mobile` and
`... revoke <data>/mobile DEVICE_ID`. Only the desktop (a renderer command to the core) lists or revokes:
a paired phone cannot see or end another phone's session. Revoking takes effect on the phone's next
request; an open event stream ends within 15 seconds. Hand-issued tokens in the clients file are not
listed; edit that file to revoke them.

### Routes

`config.json` may name how the core is reached, in the order a phone should try:

```json
{ "origin": "https://botling-bridge.example", "originKind": "tunnel",
  "routes": [{ "kind": "lan", "origin": "https://botling.home.arpa" }, { "kind": "tailscale", "origin": "https://mac.tailnet.ts.net" }] }
```

`origin` is the first route (`originKind` defaults to `tunnel`); `routes` adds up to five more (`lan`,
`tailscale`, `tunnel`; HTTPS origins, no path). Nothing is discovered or set up: each name must already
reach this listener (DNS, Tailscale Serve, tunnel) with a certificate valid for it. The bridge accepts
each as `Host` and checks `Origin` against the host asked, so data requests stay same-origin; only
`GET /api/mobile/core` may be read from another listed route (CORS for exactly those origins), which is how
a phone probes. `GET /api/mobile/core` now also returns `routes: [{ kind, origin }]`. A pairing link made
for one route that is opened on a later one hops to the first listed route that answers with the same Core
ID, once (`&hop=1`); the secret is sent only to a route that proved it. After pairing, a token belongs to
one origin unless the phone follows the core to another listed route (next section).

### Moving a signed-in session between routes

When it signs in, the phone pins the core id and the routes that core itself listed (`mobile/routes.ts`
`RouteBook`). If a request gets no answer at all (no connection, not an HTTP error), it asks every listed
route for the public descriptor (no token, no credentials) and moves to the first, in the core's order,
that answers with the pinned core id. Only then does the token go there. A host that is not in the list, or
answers as another core, never receives it. A read is repeated on the new route; a send is not (it may have
arrived): it is reported as unconfirmed and the next call uses the new route. The page keeps its own origin, so
`/api/mobile/command`, `/ticket` and `/events` accept requests whose `Origin` is another listed route, with
CORS for exactly those origins (preflight allows `Authorization`, `Content-Type`, `X-Botling-Generation`; no
credentials). Pairing stays same-origin. The phone does not switch back to a better route by itself yet.

### Event stream tickets

`EventSource` cannot send headers, so the token must not go in its URL. `POST /api/mobile/ticket` with
the bearer token returns `{ ticket, expiresAt }` (30 seconds, single use, held in memory, bound to that
phone, at most 64 outstanding). `GET /api/mobile/events?ticket=T` redeems it (anything else in the query,
or a bearer token, is refused) and opens `text/event-stream`: `retry`, `event: ready`, then a `: ping`
every 15 seconds, closing when the session is revoked or expires. At most 16 streams at once. The core
tells the stream when something changed: `event: changed`, with no content at all (a counter only), at most
about every 250 ms (a burst is one notice), and only for changes in bots that phone may read or that belong to
no bot. The phone then reads with a normal, checked snapshot request. `mobile/events.ts` (`watchEvents`) is the
client half: a new ticket for every connection, growing waits after a drop, stops for good when the session is
gone. While the stream is up the phone's polling slows to 30 seconds (a safety net); without it, 2.5 seconds.
