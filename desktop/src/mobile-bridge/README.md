# Private mobile bridge (review required)

Protocol v10, `POST /api/mobile/command`, same-origin bearer authentication. Mobile assets are
served at `/mobile/`; only the public application shell is unauthenticated. Every data/command
request needs a current token and an explicit bot grant. There is no HTTP listener, public bind,
CORS, reverse-proxy trust, cookie authentication, file endpoint or network token-issuance route.
No listener starts unless the local owner supplies `BOTLING_MOBILE_CONFIG` before core startup.

The core adapter allows snapshot/send/choose/answer only. Existing boot-activation checks,
plugin before-send hooks and question/approval semantics run through core `handle` unchanged.
Snapshot does not invoke `chat.read`, and exposes only selected chat data and authorized bot
summaries, not global settings, plugin information, other bots' waiting lists or web sessions.
Send returns the existing `{messageId, turnId: string|null}`; choose/answer preserve
`{accepted: boolean}`, including false. Mobile answers cannot carry images.
Streaming remains the frontend's five-second snapshot polling, not a new SSE/WebSocket route.

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
2. Choose the computer's specific LAN/VPN IPv4 (10/8, 172.16/12, 192.168/16 or 100.64/10), a
   port, and an HTTPS hostname reachable privately from the phone. Loopback works only on the
   computer. Do not port-forward to the internet. The certificate SAN must match the hostname,
   and its issuing CA must be trusted by both devices. Provision certs using your existing local
   certificate workflow; this bridge never creates a CA or changes device trust settings.
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
     "origin": "https://botling.home.arpa:8443",
     "host": "192.168.1.20",
     "port": 8443,
     "certFile": "/absolute/private/server-cert.pem",
     "keyFile": "/absolute/private/server-key.pem",
     "clientsFile": "/absolute/private/clients.json",
     "assets": "/absolute/checkout/desktop/mobile/dist"
   }
   ```

   Keep the private key owner-only. Set `BOTLING_MOBILE_CONFIG` to this absolute config path in
   the environment of the core at its next separately authorized launch. No config means disabled.
   A future launcher/Rust migration must explicitly preserve this opt-in environment/config path.
5. On the phone, open `https://botling.home.arpa:8443/mobile/`, enter the token, check the expected
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
