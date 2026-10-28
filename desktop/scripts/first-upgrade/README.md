# First upgrade from installed .18 — preparation only

Status: **blocked for production execution**. The isolated driver implements the
reviewable plan and orchestration contract, with dummy-endpoint failure tests.
It is not an install-ready bootstrap. `cli.mjs` accepts only `plan`; it does not
load a runtime, send signals, call a quit endpoint, write the profile, stage,
back up, migrate, or restart. No API implementation was copied from another owner.

## Exact command template (read-only planning)

From this worktree root, create a review input outside the live profile:

```json
{
  "appPath": "/Users/guoshengwei/Applications/Botling 2.app",
  "dataDir": "/Users/guoshengwei/Library/Application Support/Botling 2 Dev Trial",
  "candidatePath": "/ABSOLUTE/REVIEWED/CANDIDATE/Botling 2.app",
  "current": "2.0.0-dev.20261029.18",
  "currentAsarSha256": "260f2c24e67955b9fd48795bc695725529c4d6e1d8c444b6e15e3258cecd8259",
  "arch": "arm64",
  "candidateZipSha256": "REPLACE_WITH_REVIEWED_SIGNED_ZIP_SHA256",
  "candidateDevTrial": true
}
```

Architecture is an explicit input: verify the eventual candidate and running app
match it; do not infer architecture from the shell under Rosetta. The command
below requires replacing candidate path/hash. It refuses the placeholders.

```sh
node desktop/scripts/first-upgrade/cli.mjs plan \
  '/ABSOLUTE/upgrade-input.json' \
  '/ABSOLUTE/REVIEWED/CHECKOUT/desktop/release-config.json'
node --test desktop/scripts/first-upgrade/driver.test.mjs
```

The output is an input-bound plan, **not a filesystem verification receipt**.
The two user paths are explicit inputs for this upgrade, not product defaults.
The plan binds the approved Ed25519 key by SHA-256 of DER SPKI:
`1a423f6b0027da46675d0df7a63dfc43b11a3f2bdef1264027b66049dbb8f0c1`.
Only the public key is read. It is never obtained from the candidate manifest.
An execution approval must explicitly authorize the exact plan digest, after the
following production dependencies are resolved. There is deliberately **no live
installation command** to approve or run in this revision.

## Required runtime bridge; no substitute installer

`execute` is exported for synthetic tests and later audited binding. Its ports
are trusted code, not JSON assertions, environment overrides or candidate plugins.
The bridge must be built from a pinned, reviewed cumulative source revision and
its complete dependency graph, with the executable artifact digest reviewed
before loading. Do not dynamically import a user-supplied adapter or run candidate
application code to obtain metadata. A lease object or `true` in a fixture is
not production evidence.

Bind these exact reviewed interfaces (source review at `2b9b9dc`):

- `desktop/src/main/hot-auth.ts:authenticateLocalBuild(path, target, key, fs, run, arch)`.
  Use real Node fs and bounded execFile; return its copied authenticated ZIP.
- `desktop/src/main/update-install.ts:VerifiedInstaller(options)`;
  `stageLocal(authenticated.zip, authenticated.version)` followed by
  `restart(actualParentPID)`. Do not call `.18` legacy replace/install-build,
  patch `.18` trust, manufacture receipts, or implement a parallel swap helper.
- Inspect the authenticated extracted bundle, including package `botlingDevTrial`,
  embedded key, actual architecture, ZIP hash and `packagedDataDir` ordinary
  launch selection. Require the signed trial package to select exactly the
  approved data directory without inherited `BOTLING_DATA_DIR`.
- `removeAuthenticationScratch` removes only the authentication API's validated
  scratch root, never the staged installer root or live target/profile.

### Unresolved safety interfaces

1. `acquireExclusive` must establish canonical non-symlink app/profile identity,
   installed ASAR hash/version and current running app identity, enumerate all
   profile writers, and exclude concurrent launches/writers until transaction
   completion or recovery. A bootstrap-only lock that .18 ignores is insufficient.
   The existing helper waits for one numeric PID and has no profile lease API.
2. `inspect` must query live PID **and kernel start identity**, executable/bundle,
   profile and exclusion status. `withValidatedParent` must protect that identity
   across restart handoff; comparing two `ps` observations is not an atomic
   guarantee. `restart(number)` alone cannot express this contract. No stale PID
   from a review input is accepted.
3. `transferToInstaller` must preserve exclusion if the bootstrap crashes or quit
   fails. `approvedGracefulQuit` must use the existing explicitly approved app
   install/quit flow against that same process/profile, never OS signals or the
   legacy replacement flow. The `.18` endpoint and its authorization must be
   verified read-only before binding it. No external quit bridge is supplied here.
4. The owner must close early startup/profile-write fencing and provide reviewed
   same-profile snapshot, precommit restoration and crash recovery evidence for
   the final cumulative candidate. Native hash classification is owned by
   `eb85fb09`; do not edit/copy its worktree. These remain dependencies, not
   switches a user can set to bypass checks.
5. The helper inherits its spawn environment. The eventual external invocation
   must have a reviewed minimal environment: no NODE_OPTIONS, DYLD injection,
   Electron mode overrides, BOTLING_DATA_DIR/import/1x overrides or test knobs.
   Preserve only explicitly reviewed HOME/TMPDIR/PATH and needed account paths;
   do not modify profile configuration to achieve this. The current CLI never
   spawns the installer. Launch-environment validation is not implemented.

## Failure ownership and evidence

Before helper arm, authentication/stage/identity failures release the lease and
invoke installer discard. After successful `restart`, never discard its journal
or release protection merely because transfer/quit failed. Return `helper-armed`,
never `installed`; completion requires the installer's commit/recovery evidence.
Do not automatically retry or force-quit after an ambiguous arm failure.

Source trace at `2b9b9dc` shows SWAP_SCRIPT waits for parent exit before snapshot,
keeps previous.app, prepares a sibling profile restore, and commits by receipt.
That is source evidence only, not validation of real process shutdown, exclusion,
crash durability or recovery. Existing review artifact reports 107 focused passes;
these were **not rerun** and are not attributed to this driver.

This revision runs only 26 Node synthetic tests: plan/trust/input binding, missing
approval/runtime, profile mismatch, absent exclusion, failed authentication and
metadata, production-profile rejection, missing safety review, staging failure,
PID reuse, failed atomic identity check, restart failure, transfer/quit failures,
ordering, and rejection of CLI live execution. They use dummy methods, no real
profile or app, and do **not** simulate actual filesystem snapshot/restoration.
A separate authorized integration pass must test candidate failure restoration,
interrupted recovery, same-profile competing process exclusion, environment,
and subsequent ordinary launches with the final signed artifact.

No full suite, package build, installation, restart, signals, real profile backup,
configuration mutation, private-key access, push or tag was performed.
