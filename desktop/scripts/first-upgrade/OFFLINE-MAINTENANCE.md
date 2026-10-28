# Offline maintenance preparation — exact limits and decision

This supersedes the online bridge proposal; do not wait for an online .18 API.
No live adapter is claimed. Read-only review used owner commit
f91e790a0e35764afb14ed135a9c00a9b0b2aa52 and its corrective evidence JSON.
The coordinator's review reference 55223fa4 is not a resolvable Git object in this
repository; no additional changes or review acceptance are inferred from it.

## Concrete operator flow to review before installation

1. Review a signed cumulative candidate, its ZIP SHA-256 and the input-bound
   plan from cli.mjs. Pin current .18 ASAR, approved key fingerprint, architecture,
   target `/Users/guoshengwei/Applications/Botling 2.app` and profile
   `/Users/guoshengwei/Library/Application Support/Botling 2 Dev Trial`.
   Validate signed `botlingDevTrial=true`, ordinary launch profile, package/core
   storage contracts and the candidate's maintenance gate before approval.
2. After separate explicit install approval, the user gracefully quits Botling
   through its normal UI. The adapter must not kill it, invoke legacy install,
   or assume the UI disappearing proves the core/children have drained.
3. Establish the chosen offline window before any authentication extraction,
   staging/recovery, backup or profile mutation. The strict option is a trusted
   maintenance boot/session in which the original user's apps, login agents and
   relevant background services cannot run. Simply switching accounts is NOT
   sufficient. The alternative normal-session manual window requires the user
   to keep .18, copies of it and all profile-writing tools closed; this is a
   procedural assumption, not technical exclusion.
4. Verify canonical app/profile paths and filesystem identity. Obtain a complete
   process census with kernel start identity, UID, executable identity/path,
   core/child ancestry and profile arguments/open-file associations. Verify no
   matching app, core or possible profile writer exists. Unknown identity,
   inaccessible process details, unresolved descendants or a changed census
   means refusal, not permission. A zero result once is not a durable guarantee.
5. Acquire a durable candidate-recognized maintenance record bound to app/profile
   filesystem identities and plan/transaction ID before stageLocal can recover
   or mutate anything. Repeat writer checks before snapshot, activation and
   launch, and monitor the entire window. On any new/uncertain writer stop
   advancing; invalidate an in-progress snapshot and retain recovery state.
   Detection is fail-stop evidence only: it cannot undo a write that raced a copy.
6. Authenticate using the approved key and existing authenticateLocalBuild;
   pass InstallProfilePin to existing VerifiedInstaller staging. Use only the
   existing transaction engine to create the quiescent snapshot and activate.
   Do not patch signed metadata, synthesize snapshot receipts or use HotTransaction
   as a substitute: whole-bundle hot exchange does not snapshot the profile.
7. Persist `activated-awaiting-operator-launch`, with old app, completed snapshot
   and maintenance ownership retained. No automatic open, app execution or
   failure-path reopen. Candidate ordinary startup must refuse while this record
   exists, even when the stored epoch is already compatible.
8. Operator explicitly chooses launch or rollback against that transaction.
   Launch uses the transaction's single-use capability and verified same profile,
   minimal environment and startup fence. Healthy boot commits using the existing
   receipt; candidate failure restores app AND profile through existing recovery.
   Recovery after maintenance-process interruption remains offline and never
   assumes a missing PID permits releasing protection. Only terminal durable
   commit/restoration clears maintenance state. Operator decides when to reopen.

## Unavoidable decision, not a renewed online API request

Choose the supported operational guarantee before implementation acceptance:

- Strict quiescence: arrange a trusted maintenance boot that excludes the target
  login session and all relevant writers, and confirm a supported Node/macOS
  maintenance runtime. This requires user action beyond merely quitting the app.
- Same-session manual window: accept that old .18 does not honor the maintenance
  record; continuous process detection can refuse/abort but cannot guarantee a
  consistent snapshot against an arbitrary concurrent writer. Such a mode must
  never be presented as guaranteed safe under concurrent .18 relaunch.

This assignment authorizes source preparation, not taking either action now.
No offline environment has been established or tested on the user's machine.

## Minimal shared-engine changes still needed for this offline flow

These are distinct from the unsupported online bridge. Shared owner retains all
snapshot/activation/rollback code; bootstrap only supplies orchestration.

1. Extend checkStorageStartup's early read-only gate to reject an active durable
   maintenance record unconditionally (including compatible epochs), except a
   transaction-bound explicit launch capability. Consult it before real Electron
   profile/log initialization. Refuse ambiguous recovery state. Candidate-only
   gate does NOT exclude old .18.
2. Expose an offline mode of the existing VerifiedInstaller transaction that does
   not require a fake/dead parent PID, snapshots after external quiescence proof,
   and pauses durably after activation before executing the candidate. Existing
   SWAP_SCRIPT starts the executable immediately after rename and can reopen on
   failure; passing a dummy PID to restart is not an offline API.
3. Expose explicit launch/rollback/resume of that same transaction ID and clean
   helper environment. Every error after activation must retain state; no implicit
   launch on failure or helper exit. Reuse existing snapshot and recovery routines,
   with failure seams for subprocess crash tests. No duplicate transaction engine.

No exported API at f91e790a provides these semantics. Consequently implementing
an apparently executable adapter now would either bypass them, duplicate the
owner's transaction, or silently auto-launch. This revision does none of these.

## Evidence and reproducible focused check

```sh
node desktop/scripts/first-upgrade/offline-gate-probe.mjs \
  /Volumes/My-SSD/botling-work/mobile-hot-apply-20261029
```

Two real API observations passed against pinned, unchanged source, bundled only
into a disposable fixture: unknown-epoch first hop refused without changing the
fixture profile; compatible epoch passed despite a proposed maintenance marker.
The latter proves a new marker alone is ineffective, not that such a marker is
already a supported protocol. No real app/profile read or write was performed.

Source trace: update-install.ts SWAP_SCRIPT snapshots after the parent wait,
renames both app generations, then immediately starts the candidate. Recovery
uses the existing profile snapshot. No offline pause/export exists. Corrective
owner evidence reports selected A5 actual snapshot/restore and A4 recovery tests;
those results are reused as owner evidence, not rerun or called adapter coverage.
Actual offline snapshot/crash/recovery tests cannot exercise a nonexistent pause
API. Once added, test real fixture files and owned subprocesses at snapshot,
activation, waiting-for-operator, launch, failed boot and interrupted restoration;
verify profile byte restoration and absence of implicit launches at each point.

No installation, quit, signals, live process census, profile backup/mutation,
restart, full suite, package build, merge or push occurred.
