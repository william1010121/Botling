# Botling mobile client

Phone-browser client, isolated from Electron and the desktop composer. Provides chat/project
navigation, text chat with refreshing replies, per-chat drafts, reply-to, engine selection,
question choices/free-text answers, task status, and an Add-to-Home-Screen manifest.
Rich cards, local files and attachments remain desktop-only. No service worker stores private
conversations or credentials. Offline drafts survive within the open tab, not a page reload.

## Build and checks

From the repository root, after `desktop/scripts/link-deps.sh`:

```
node desktop/mobile/build.mjs
node desktop/node_modules/typescript/bin/tsc --noEmit -p desktop/mobile/tsconfig.json
cd desktop
node node_modules/vitest/vitest.mjs run --config mobile/vitest.config.ts --maxWorkers=1
```

The standalone bundle is `desktop/mobile/dist/`. Serve it under `/mobile/` on the same private
HTTPS origin as the authenticated command endpoint. It has no dependency on Electron preload.
The application is not deployed, and this directory does not start any production server.

## Backend integration contract — required, not implemented here

The inspected base revision (`dba3814`) has the transport-agnostic `Core.receive` and Electron IPC,
**no authenticated browser HTTP server**. Consequently the client is not yet phone-connected
to a running Botling. Backend integration must be supplied by the server owner, not by exposing
Electron IPC or the entire core command set to the network.

Default endpoint: `POST /api/mobile/command` (editable path, same origin only).

- HTTPS, on a user-authorized private origin; HTTP is accepted only at localhost for development.
- Request: `Authorization: Bearer <access token>`, `Content-Type: application/json` and the existing
  `{v: 10, id: <UUID>, cmd: ...}` request envelope from `desktop/src/contract/index.ts`.
- Response: existing `{v: 10, id, ok: true, result}` or `{v: 10, id, ok: false, error: {code, message}}`.
  Send results must contain `messageId` and nullable `turnId`; question results must contain
  `accepted: boolean` (false does not count as success). Match the request id. No redirects. Return 401/403 for missing/expired/unauthorized credentials.
- Authenticate and authorize each request (including per-bot access). Allowlist only
  `chat.snapshot`, `chat.send`, `chat.choose`, `chat.answer`; validate with the core contract.
  Core approval enforcement must remain intact. Tokens must be issued/revoked through an
  authenticated local setup flow; this client does not create or discover tokens.
- `chat.snapshot` returns the existing snapshot, including selected chat messages/tasks,
  bot summaries and `pendingFiles`. Absence of `botId` selects Main. The mobile client polls once
  every five seconds after completion, never overlapping in one active subscription, and stops
  polling while hidden/offline. Snapshot reads should not clear desktop unread state.
- Client credentials are in memory only, never URLs/localStorage/cookies. Serve API responses
  with `Cache-Control: no-store`; don't log bearer tokens or message bodies. Serve the client
  with a `frame-ancestors 'none'` CSP header (the HTML includes its other CSP directives).
- Ambiguous mutations are not automatically retried. Request ids correlate responses; the client
  does **not** assume the core deduplicates sends. It retains the draft and asks the user to check
  chat before a manual retry. **The bridge must durably deduplicate mutation request IDs per
  authenticated client before dispatch, and replay the recorded response for duplicate IDs.**
  Browser/network layers can replay requests independently of application code: the synthetic
  socket-drop browser check produced two stored messages from one UI action. The exact layer
  responsible was not instrumented in that initial check. Do not enable live writes without
  backend deduplication and a lost-response integration test.
- Desktop-queued attachments block mobile sends, to avoid accidentally sending someone else's
  staged files. Concurrent staging after the snapshot remains a backend race: the bridge should
  atomically reject mobile `chat.send` when pending files exist, or add a separately reviewed
  text-only send contract. No shared core contract changes are made by this branch.

For a phone, `localhost` refers to the phone, not the computer. A private HTTPS route to the
computer and a running Botling are required. Merely opening the static page cannot connect it.
Home-screen installation depends on the browser; no offline chat or push delivery is claimed.

## Review gate

No merge, main ref changes, package/install/restart or deployment is included. Claude code review
and resolution of its findings are required before integration. That review is coordinator-owned;
this worker cannot delegate to another agent.

## Lightweight browser fixture

After building mobile, run `node desktop/mobile/fixture-server.mjs` from the repository root.
It binds an ephemeral loopback port, prints its URL, and accepts the non-secret token
`fixture-token`. It uses synthetic in-memory chats only; never point it at user data.
`/uncertain` deliberately stores a message then drops the socket (no deduplication), to expose
the delivery-ambiguity boundary. It prints mutation request IDs for diagnosis, never tokens.
Stop the process when finished. This is a test fixture, not the missing production bridge.

## CI handoff (observed toolchain; no live credentials)

Observed local runtime: **Node 24.13.0, npm 11.6.2, macOS arm64**. No Linux/Windows CI run
was performed. `desktop/package-lock.json` is npm lockfile version 3, SHA-256
`6d83a432c28a34ffc4d683c65ac95629852c5e92ac707e1ea210b014a7c27141`.
Its root package version is `2.0.0-dev.20261026.3`; `desktop/package.json` currently says
`2.0.0-dev.20261026.11` (pre-existing, unchanged by mobile work).

Locked and installed versions agree: React/react-dom 19.3.0; zod 4.6.7; esbuild 0.28.2;
TypeScript 5.9.3; Vitest 4.1.12; jsdom 27.0.0; @types/node 24.13.6;
@types/react and @types/react-dom 19.3.0.

On CI, use the desktop lockfile directly rather than the SSD-specific `link-deps.sh` helper.
Proposed setup (not executed in this task): pin Node 24.13.0/npm 11.6.2, then run
`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --prefix desktop --no-audit --no-fund`.
The mobile checks themselves do not use Electron, native agents, API keys, accounts or macOS
frameworks. Normal package-registry access is needed for installation.

Run gates **sequentially**, not as parallel jobs, from the repository root:

```
GOMAXPROCS=1 node desktop/mobile/build.mjs
node desktop/node_modules/typescript/bin/tsc --noEmit -p desktop/mobile/tsconfig.json
cd desktop
node node_modules/vitest/vitest.mjs run --config mobile/vitest.config.ts --maxWorkers=1
```

- Build bundles only `desktop/mobile/dist/`, targets Safari 16/Chrome 110 syntax, and copies the
  HTML, manifest and SVG icon. The TypeScript config is strict with ES2023/DOM libraries.
- Tests use fake HTTP responses plus one jsdom React test. There are 13 authored transport
  cases and one same-chat polling regression. No live credentials or network server required.
- Imports depend on `desktop/src/contract/` and `Web/src/contract.json`; checkout the whole
  repository, not only `desktop/mobile`. No shared files or lockfile changes are needed.
- Browser acceptance can additionally use the loopback fixture described above, with a
  separately supplied browser runner. The ego-browser acceptance sequence is not a portable
  CI automation script and no Playwright suite is claimed.
- CI cannot prove real phone connectivity, TLS, token issuance/revocation, backend access control,
  deduplication, the atomic pending-file guard, or mobile Safari keyboard/install behavior.
  Those remain backend/live-device integration gates. See `VALIDATION.md` for checks actually run
  and the final regression pass held during Rust's exclusive validation slot.
