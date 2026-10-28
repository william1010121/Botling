# Bridge validation handoff — 2026-10-28

Base dba3814, isolated branch bot/mobile-bridge-20261028. Mobile frontend contract read from
32da511/f595687; no frontend edits/cherry-picks. No Rust/composer/performance implementation edits.

Executed before commit:
- `node --check desktop/src/mobile-bridge/setup.mjs`: passed.
- TypeScript `transpileModule` syntax-only pass: zero diagnostics. This is NOT a typecheck.
- `git diff --check`: passed for tracked edits; staged diff checked again at commit.
- Inspected owner diffs: Rust edits are confined to desktop/rust-backend; composer server.ts
  hunks change send completion and files.data, neither overlaps the new method/import. Its
  pending.take remains synchronous. No performance persistence hunks touched.
- Exact previously rejected setup/dependency command retried only after relayed user Allow.
  Existing lockfile cache was verified first; link-deps output showed links only, no install.

Authored, NOT RUN while the exclusive heavy-validation queue remains assigned elsewhere:
- 7 focused tests: durable replay/reopen, changed-payload rejection, distinct client IDs,
  pending crash safety, overlapping claims, declined-answer replay, core adapter grants and
  snapshots, actual Core hook/handle/send queue guard and activation check, loopback HTTPS
  auth/revoke/origin/host/command/bot/routes plus lost-response persisted replay.
- Local bridge tsconfig includes the real Core through the integration test; a bounded
  typecheck may traverse its dependency graph. No full build or suite is requested.

Next assigned validation slot, sequentially from desktop:
```
node node_modules/vitest/vitest.mjs run --config src/mobile-bridge/vitest.config.ts
node node_modules/typescript/bin/tsc --noEmit -p src/mobile-bridge/tsconfig.json
```
Do not describe authored assertions as observed passing behavior. The core integration test
uses the actual hook/handle/send prototype with controlled bot/pending/plugin boundaries; it
is not a live-agent E2E test. HTTPS test creates temporary synthetic credentials/certificate,
with certificate checking disabled ONLY in its loopback test client.

Remaining acceptance gates: execute/fix the focused tests and typecheck in the assigned slot;
Claude review and findings resolution before merge; cumulative integration with frontend,
composer and Rust as separately authorized; actual private TLS/DNS/firewall/phone connectivity,
real approval flows and live token revocation verification. No physical phone, live account,
public deployment, app package/install/restart, main merge or push was performed.

## Lifecycle correction and user decision — awaiting allocated validation

Claude approved a34cf2 integration but identified probe binding and missed port handover.
Correction adds probe skip, bounded EADDRINUSE backoff on one server and core-shutdown
cancellation. Auth forwarding is unchanged; explicit user decision allows mobile approvals
(message 42FBCEBB-A352-4A4C-A3A3-71120F245F1B).

Authored NOT RUN: six lifecycle cases (probe no listen, transient recovery, shutdown retry
cancellation, in-flight/active close, bounded permanent failure, non-retryable/config failure)
and three table-driven approval cases using actual Core.handle/Bot.choose/decideDenial with
controlled side-effect callbacks. Each approval case checks invalid token, wrong bot, absent
question, invalid index, inactive core, accepted choice and settled-choice rejection; tool
permission also checks an open-looking question without a live approval. Together with the
original seven, the focused suite has sixteen cases. No test/typecheck was run for this
correction while quota backend506574ee holds the serial slot.

After explicit allocation, run the same two commands above sequentially, single worker and
no file parallelism (already in vitest.config.ts). The original loopback HTTPS case requires
sandbox listen permission; any EPERM must use normal approval, not a bypass. Reuse the prior
seven-test/typecheck result only for a34cf2, not as evidence for this correction. Claude review
of the corrected exact commit and separately authorized real-phone acceptance remain gates.
