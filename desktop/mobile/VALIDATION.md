# Mobile validation evidence — 2026-10-28

Base: `dba3814ee25225b6a694f9e6c307701a3e278b43` (main at worktree creation).
Branch: `bot/mobile-client-20261028-night`.
Scope: new files under `desktop/mobile/` only; no production backend or desktop edits.

## Executed

- Standalone mobile esbuild bundle succeeded (no desktop build/package).
- Mobile-only TypeScript check passed before the final response-validation and same-chat fix.
- Initial transport suite: **10 passed**, single Vitest worker, 162 ms. This was before adding the
  native-fetch receiver, malformed-result and unaccepted-answer regressions.
- First Vitest invocation selected no files because the desktop config excludes mobile. Added
  a mobile-specific config, then the ten tests passed. No full-suite run.
- Actual built bundle exercised in ego-browser, against a synthetic loopback HTTP fixture:
  valid bearer login; bot/project navigation; Main/Research draft preservation; text send and
  refreshed bot reply; question choice; desktop pending-file send blocking; token rejection;
  disconnect clears conversation/token and leaves localStorage/sessionStorage empty.
- Untrusted `<img ... onerror>` message rendered as literal text, with zero image elements.
- 390×844 viewport: document width 390, composer send bottom 832. Screenshot captured and
  visually inspected. 320×568: document width 320 and send visible. 390×430: send visible.
  The short viewport simulates reduced space; it is not physical iPhone keyboard testing.
- Fault injection stored a message and dropped the response: draft retained, further sends
  blocked until user acknowledges checking chat. Initial one-click check later showed two
  matching stored messages; exact replay layer was not instrumented. A follow-up single direct
  browser fetch produced one stored message and a network error. These observations do not
  establish at-most-once delivery; backend mutation-id deduplication is a hard prerequisite.
- Browser testing exposed native `fetch` being called with the transport as its receiver;
  fixed by invoking a local function reference. Login, send and all subsequent browser flows
  passed with that fix. A focused unit regression was then added.
- Source inspection found opening the already-selected chat invalidated its polling generation
  without creating a new effect. Fixed; a focused React/jsdom regression was added.
- Source inspection found mutation result bodies were not validated. Added send-result schema
  and accepted-answer validation; malformed/declined results no longer acknowledge success.

## Pending after resource-slot handoff

The Rust worker acquired the exclusive heavy-validation slot. No further build, typecheck or
runner batch was started after that notice. The final additions above still require:

```
node desktop/mobile/build.mjs
node desktop/node_modules/typescript/bin/tsc --noEmit -p desktop/mobile/tsconfig.json
cd desktop
node node_modules/vitest/vitest.mjs run --config mobile/vitest.config.ts --maxWorkers=1
```

Expected test scope is 13 transport cases plus one React polling regression; this is a count
of authored tests, **not a claim that the newly added tests passed**. Request to coordinator
for the next bounded slot was sent. Reuse prior browser evidence except where changes require
rechecking mutation acknowledgements / same-chat polling.

## Integration blockers

1. No authenticated HTTP bridge exists in the inspected main. Required endpoint, authentication,
   allowlist, snapshot, result, deduplication and queued-file contracts are in `README.md`.
   Live Botling/phone connectivity was not tested and is not ready merely from this bundle.
2. Claude code review and findings resolution must precede any merge. This worker cannot
   delegate to Claude under its execution-ownership rule; review remains coordinator-owned.
3. No physical iOS/Safari, home-screen install, TLS route, live approvals, attachments or rich
   desktop cards were validated. No public deployment, package/install/restart or main change.

## Evidence locations

- Isolated screenshot: `desktop/mobile/evidence/phone-390.png` (ignored, not in commit).
- Explicitly user-approved exact retry also saved:
  `/Users/guoshengwei/tool/MacOSApp/ClaudeCodeBot/.bot/artifacts/mobile-client-phone-390.png`.
  The original shared screenshot write was rejected by automatic review; the exact retry was
  performed only after explicit Allow relayed by the coordinator. No shared source was edited.
