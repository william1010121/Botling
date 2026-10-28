# Actively blocked: shared transaction bridge

Follow-up inspection: 2026-10-29. No production adapter has been completed.
The implementation authorization is sufficient; the blocker is a missing API,
not a request for permission to write source.

Read-only owner checkout inspected:
`/Volumes/My-SSD/botling-work/mobile-hot-apply-20261029`, HEAD
`2b9b9dc0a72e68e65dbe91b28fceb31133638106`.
`update-install.ts` has no owner worktree changes at inspection. Owner test
changes were not edited or copied. No new bridge artifact was found in the
shared artifact directory at inspection.

## Exact handoff to owner eb85fb09

Implement/export the semantics in adjacent `transaction-bridge.d.ts`, or return
an equivalent minimal API plus pinned commit/export paths. This file is a
proposed interface only. In particular, `armAndQuit` must consolidate the prior
bootstrap's separated validate/restart/transfer/quit operations; those separated
mock ports cannot establish atomic process identity or crash-safe ownership.
Do not implement another snapshot/swap/recovery engine.

Required response, bounded to five facts:

1. Export path/signature for acquisition before `stageLocal`, and what mechanism
   excludes both existing .18 writers and ordinary .18 relaunches. If the old
   process does not honor that mechanism, state unsupported rather than return
   a fictional successful lease.
2. Export path/signature binding kernel parent identity throughout helper wait,
   not merely before `restart(number)`, and preventing premature snapshot while
   the old core/children still write. Define exact scope of child completion.
3. Existing .18 approved quit transport/address discovery, authentication and
   plan binding; or state no externally callable authorized transport exists.
   Source callback `app(op='quit')` alone is not an external endpoint.
4. Atomic helper handoff result/error semantics, durable lookup and unarmed-only
   release. Identify how a driver crash immediately after spawn is recovered
   without releasing exclusion or discarding active staging. Provide explicit
   clean-environment injection at helper spawn, not an inherited-env promise.
5. Pinned owner commit and isolated sandbox test entrypoint for actual snapshot,
   restore and interrupted recovery. No live profile/app paths in test fixtures.

## Observed gaps at the inspected revision

- `update-install.ts:285`: `stageLocal` enters `stageSource`.
- `update-install.ts:294`: staging already calls `recoverUpdates(dataDir, appPath)`;
  exclusion therefore has to start before staging, not only before restart.
- `update-install.ts:348`: public restart accepts a numeric PID only.
- `update-install.ts:368`: detached `/bin/sh` receives that PID and inherits the
  bootstrap environment. No parent start identity/profile claim argument.
- `SWAP_SCRIPT` waits with `kill -0 "$parent"`, then snapshots the profile;
  observing PID exit does not alone establish all profile writers have exited,
  prevent PID reuse, or prevent ordinary relaunch during the snapshot.
- `main.ts:152`: Electron single-instance locking exists, but the reviewed code
  exposes no external lease transfer/participation interface. A separate new
  lockfile cannot be assumed to interoperate with Chromium's lock.
- `main.ts:193`: internal quit callback schedules `app.quit()`. It is reached
  through `core-client.ts` / core app requests, not an exported bootstrap method.
  No OS quit/signalling fallback has been introduced.

These are observed interface limitations. Whether the owner can safely extend
coordination to an already running .18 is unresolved; the adapter must not
pretend updating only the candidate adds cooperation to the old process.

## Concrete sandbox acceptance once available

Run the owner API from a child bootstrap subprocess with fixture app/profile and
an owned dummy parent/child endpoint. Keep LaunchServices disabled and every
process confined to test fixtures. Required scenarios:

- Competing bootstrap and competing ordinary launch cannot become profile writers
  during acquisition, parent drain, snapshot or restore.
- Parent writes a final marker on approved graceful quit and child writes its own
  final marker before exit; the actual snapshot contains both. Reject ambiguous
  writers; do not substitute mocked snapshot callbacks.
- Reused PID/different start identity cannot arm, quit the replacement, or start
  the snapshot. Dummy endpoint supplies only the app's graceful quit action.
- Candidate writes incompatible profile content then exits: existing transaction
  restores original app and preboot profile bytes; retains failure evidence.
- Terminate only the owned dummy bootstrap at before-stage/after-stage/after-arm/
  after-quit boundaries; fresh process lookup/recovery resolves ownership and
  never discards a live helper. Exercise existing recovery after helper crash
  around data/app renames using owner-provided failure seams.
- Failed snapshot leaves original app/data intact. Failed restore retains both
  recoverable generations and blocks startup. Commit precludes rollback.
- Driver with hostile inherited env cannot propagate import/data/Node/DYLD
  overrides. Ordinary later launch resolves the same signed trial profile.

Existing `desktop/test/unit/update-install.test.ts` has real shell/filesystem
coverage: `A5 restores flushed pre-boot data after incompatible startup writes
and crash` (line 342), `A1 records early rename failure` (331), and A4 recovery
(373). Those tests do not exercise the absent bridge and were not rerun or
copied into this worktree. Previous 26 dummy tests remain orchestration evidence
only. This follow-up makes no new runtime-test or installation-readiness claim.
