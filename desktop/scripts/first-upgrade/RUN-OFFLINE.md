# Reviewed offline bootstrap — preparation, not execution authorization

`offline-cli.mjs` is the executable entrypoint. It has real prepare, status,
launch and rollback actions; no action has been run against the installed app
or real profile in this assignment. The old `cli.mjs` and online contract are
historical planning work, not the path for this installation. This document
supersedes OFFLINE-MAINTENANCE.md's suggested protected-OS prerequisite.

## Operational prerequisite

The user must first approve installation, gracefully quit Botling through its
normal UI, wait for app/core/children to finish, and keep every old app copy and
profile-writing tool closed until maintenance ends. The adapter never quits or
signals the installed app. It checks actual executable/argument/open-file paths,
refuses incomplete/uncertain observations, and repeats checks at transaction
boundaries and while waiting for snapshot/activation. Its own helper is matched
by the owner's PID file, exact script/executable path, process start identity,
and restricted transaction-tool descendants; numeric PID alone is not exempted.

Old .18 ignores the new cooperative gate. A deliberate or accidental concurrent
relaunch can race a process scan. No claim of arbitrary-process exclusion is
made. Before activation, the adapter compares persistent-profile bytes before
copy, the actual owner's snapshot, and live profile bytes after copy; mismatch
invalidates the transaction. An arbitrary transient writer is still outside the
accepted manual no-relaunch prerequisite. No separate OS environment is required.

## Build only the reviewed standalone runtime

The runtime contains the owner's existing authenticated installer and offline
maintenance hooks; the bootstrap contains no replacement snapshot/swap engine.
It must be built from the final reviewed clean owner/cumulative source commit.
This focused bundle is not an app package or full-suite build.

```sh
node desktop/scripts/first-upgrade/build-runtime.mjs \
  '/ABSOLUTE/REVIEWED/CHECKOUT' \
  'FULL_40_CHARACTER_REVIEWED_COMMIT' \
  '/ABSOLUTE/REVIEWED/OUTPUT/offline-runtime.mjs'
```

Validated owner revision: `822c73415dc2d6dd6d318bb53e291db960ceb18d`.
The build prints runtimePath and runtimeSha256. Inspect the output and source
before adding that digest to the plan. Never load an adapter supplied by the
candidate, a mutable external dependency, or an unreviewed arbitrary module.
Runtime exports are statically bundled; only Node built-ins remain external.

## Exact plan input for this requested upgrade

Replace the candidate/runtime placeholders and confirm architecture (matching
native Node and the approved artifact). User paths are explicit plan inputs,
not defaults in the product or adapter.

```json
{
  "appPath": "/Users/guoshengwei/Applications/Botling 2.app",
  "dataDir": "/Users/guoshengwei/Library/Application Support/Botling 2 Dev Trial",
  "candidatePath": "/ABSOLUTE/REVIEWED/CANDIDATE/Botling 2.app",
  "current": "2.0.0-dev.20261029.18",
  "currentAsarSha256": "260f2c24e67955b9fd48795bc695725529c4d6e1d8c444b6e15e3258cecd8259",
  "arch": "arm64",
  "candidateZipSha256": "REVIEWED_ZIP_SHA256",
  "candidateDevTrial": true,
  "runtimePath": "/ABSOLUTE/REVIEWED/OUTPUT/offline-runtime.mjs",
  "runtimeSha256": "REVIEWED_RUNTIME_SHA256"
}
```

```sh
node desktop/scripts/first-upgrade/offline-cli.mjs plan \
  '/ABSOLUTE/upgrade-input.json' \
  '/ABSOLUTE/REVIEWED/CHECKOUT/desktop/release-config.json' \
  > '/ABSOLUTE/upgrade-plan.json'
```

The plan binds all inputs and the approved DER-SPKI Ed25519 fingerprint
`1a423f6b0027da46675d0df7a63dfc43b11a3f2bdef1264027b66049dbb8f0c1`.
A plan is not approval. Do not create an approved execution file or run the
following commands until the user explicitly authorizes installation.

## Later approved execution template — DO NOT RUN IN THIS ASSIGNMENT

Approval file for prepare (substitute the plan digest only after approval):

```json
{
  "action": "prepare",
  "planSha256": "REVIEWED_PLAN_DIGEST",
  "explicitApproval": true,
  "manualWindowAccepted": true
}
```

Use an absolute trusted Node executable and a clean environment. HOME must match
both the invoking user's account and the pinned ordinary profile. The helper
additionally applies the owner's own environment allowlist at actual spawn.

```sh
env -i HOME='/Users/guoshengwei' USER='guoshengwei' LOGNAME='guoshengwei' \
  PATH='/usr/bin:/bin:/usr/sbin:/sbin' \
  '/ABSOLUTE/TRUSTED/node' \
  desktop/scripts/first-upgrade/offline-cli.mjs prepare \
  '/ABSOLUTE/upgrade-plan.json' \
  '/ABSOLUTE/REVIEWED/CHECKOUT/desktop/release-config.json' \
  '/ABSOLUTE/prepare-approval.json'
```

Prepare validates installed .18 bytes, identities and quiescence, acquires the
owner's durable maintenance gate, authenticates the signed ZIP, stages with the
same trial profile pin, verifies the actual snapshot and pauses after activation.
It prints `awaiting-operator`, transaction ID and retained root, then keeps the
foreground writer monitor running while waiting for an approval-file path on
stdin. Keep that terminal open. It never infers launch permission or reports a
paused transaction as successfully installed.

For `launch` or `rollback`, enter the path of a separate approval file in the
running prepare terminal. Do not start a second adapter concurrently. The file must contain the same plan digest, that exact action,
`explicitApproval:true`, `manualWindowAccepted:true`, and the returned
`transactionId`. The foreground watcher remains active during the operator
pause and through the resulting commit/rollback. After an interrupted adapter
only, standalone `launch`/`rollback` use the same command template with the new
action and its approval file; they revalidate the pause and start a new watcher.
These actions call the owner's permit API; they do not invoke
`open`, .18 legacy installation, online restart, or independent rollback code.
`status PLAN.json TRUST.json [TRANSACTION_UUID]` reads active state or validates
the retained terminal record for that transaction after an adapter interruption.

Launch rechecks live/snapshot bytes and quiescence before permission. Rollback
is explicit and does not open the restored app. A dead helper at the verified
operator pause can resume through the owner's API. Ambiguous interrupted stages
remain retained for explicit recovery inspection; never delete a maintenance
marker, infer success from helper disappearance, or retry prepare over it.
An action's acknowledgement is not a terminal commit/rollback receipt.

## Focused tests

```sh
node --test desktop/scripts/first-upgrade/offline-adapter.test.mjs \
  desktop/scripts/first-upgrade/offline-processes.test.mjs \
  desktop/scripts/first-upgrade/offline-watch.test.mjs
BOOTSTRAP_TEST_RUNTIME='/ABSOLUTE/REVIEWED/OUTPUT/offline-runtime.mjs' \
  node --test desktop/scripts/first-upgrade/offline-transaction.test.mjs
```

The transaction test uses real VerifiedInstaller signing/staging/snapshot and
owner offline hooks with throwaway keys, dummy app executables and temporary
profiles. It blocks LaunchServices in owned scripts and signals only its own
tracked helper to test interruption; it never inspects or touches the installed
app/profile. These fixture tests do not certify packaged Electron quit/flush or
live process census on this host. Those remain separately authorized acceptance.

## Validation in this revision

Owner runtime built from clean `822c73415dc2d6dd6d318bb53e291db960ceb18d`.
Eight real transaction tests cover authenticateLocalBuild → signed stageLocal →
actual snapshot → paused activation; prelaunch rollback; failed candidate
restoration; writer refusal; changed persistent bytes; post-launch invalidation;
and paused-helper interruption/resume. Additional focused tests cover approval,
continuous watcher latching, census parsing/identity, real symlink aliases and
persistent snapshot policy. Live native census and packaged acceptance remain
unrun; source preparation is not installation approval.

Approved runtime artifact used for the sandbox checks:
`desktop/scripts/first-upgrade/.generated/offline-runtime.mjs` (ignored generated
output), SHA-256
`ad1b6c36c13f9f8871191a11537c59916feb8785498cba630f05cc3ff4e0323a`.
Current validation: 21 focused adapter/census/watcher checks and 8 real transaction
checks passed. The two revocation cases assert that even a written storage receipt
does not return startup authorization or permit a success report. Earlier profile
and receipt writes are not claimed undone; invalidated generations remain retained.

The final cumulative signed candidate path and ZIP digest are not yet supplied.
Fill those only from the separately approved package; do not substitute the
synthetic fixture ZIP or treat this source runtime as a release package.

## Ownership follow-up to review R1/R2

`process-ownership.mjs` installs process-local wrappers before loading the unchanged
reviewed runtime. Only explicit approved-runtime async scopes register children;
other callers pass through without authority. Each registration comes from the
actual ChildProcess handle, with exact argument vector, parent PID, UID and OS
start identity. A five-second stdin gate holds that child before executing the
command. The shell disables startup/function injection without changing UID.
PID-scoped native inspection attests the gate; active censuses must
accept before release. A rejected or stalled census closes/expires the gate
without executing its target. The watcher is never disabled.

This covers direct verification commands and first/resumed transaction helpers
before helper.pid publication. A resume can temporarily observe only the exact
previous helper PID captured from its owner record, for at most five seconds;
the returned helper identity is the newly attested child, not that old number.
Publication of a different PID is rejected. Helper argv must equal the owner's
recorded transaction invocation, and its script digest must remain unchanged.

macOS may briefly expose `(sh)` during spawn; it is retried a bounded number of
times while the gate remains closed and is never accepted as executable identity.
The `/usr/bin/lipo` Xcode shim is resolved once with `xcrun --find lipo`, then that
concrete executable is invoked and attested directly. No basename/path wildcard
is added to admit verification tools. A known exited child's missing argv or OS
zombie row is reconciled only against its registered PID/parent/UID/start identity.
Unknown siblings, changed arguments/parent/start identity and unregistered same-tool
processes remain refused. Helper-root matching now requires attested full identity
and full argv; unknown shell descendants are not granted helper authority.

Additional checks: three required probes failed on 346eccce before the fix; nine
bounded native sandbox ownership tests cover actual lipo/PlistBuddy fixture reads,
foreground census overlap with helper publication/resume, unknown sibling refusal,
and a gate timeout with no target effects. The eight real transaction tests now
also run staging/helper handoff through this ownership layer. All native process
observations in these tests are PID-scoped to the test process and its own fixture
children; no live app/profile census or installation was performed. The standalone
runtime artifact and its approved SHA-256 are unchanged.

Ownership follow-up validation: 41 focused checks passed (3 regression probes,
9 native ownership tests, 21 existing adapter/census/watcher checks, and 8 real
transaction tests). The approved runtime was reused unchanged.
