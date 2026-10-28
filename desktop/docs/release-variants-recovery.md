# Reviewed local-only recovery, without another compilation

Implemented by `scripts/release-recovery.mjs`. Execution still requires review of the FULL
integrated correction and externally approved manifest/attestation bytes. Approval of the
config isolation commit alone does not approve the recovery verifier or a local assembly.
The normal package/reuse commands retain their exact-SHA gate. This standalone recovery entry
has no compile branch, public variant switch, base-SHA override or automatic cleanup/retry.

The only supported production compiled base is
`f7860bc9af7211788c74a9fa553abcc767eb81b2`. Do not edit or relabel its
COMPILED_PROVENANCE.json or compiled/ tree. The existing public-production, stage-local and
local-trial-preserving directories remain intact, including failure evidence.

## Fixed records and external approval

After integrating the complete correction into a clean checkout, select its final 40-character
assembly SHA. Prepare a new manifest OUTSIDE both checkout and frozen root. Then obtain an
external approval record for the exact manifest bytes and final assembly SHA. Both files must
be canonical regular files owned by the invoking UID, mode 0600, under canonical owned parents
not writable by group/others. Symlink paths are refused. The caller passes BOTH file SHA-256
pins through the trusted operator/reviewer channel; do not derive trust from a record's own
`approved` field or a self-authored reference. The code never creates approval records.

The manifest has exactly these fields (unknown fields, including self-hashes, are rejected):

| Field | Value / computation |
| --- | --- |
| schema | 1 |
| scope | `local-only-packager-recovery` |
| variant | `local` |
| compiledSourceSHA | Full fixed f7860bc9 SHA above |
| assemblySourceSHA | Final clean reviewed integrated commit |
| diffSHA256 | Full base-to-final binary diff digest from `recoverySourceEvidence` |
| compiledInputsSHA256 | Matching tracked-input digest from that helper |
| changedFiles | Exact helper records: path and before/after mode/blob IDs (null for absence) |
| frozenRoot | Canonical absolute existing frozen root |
| compiledManifestSHA256 | SHA-256 of untouched original COMPILED_PROVENANCE.json bytes |
| preservedTrees | Exactly public-production, local-trial-preserving and stage-local keys, each with its `preservedTreeDigest` |
| stage | Canonical, previously nonexistent recovery staging directory |
| output | Canonical, previously nonexistent recovery output directory |

The external approval record has exactly:

| Field | Required value |
| --- | --- |
| schema | 1 |
| action | `assemble-local-recovery` |
| manifestSHA256 | SHA-256 of final manifest FILE BYTES, not canonicalized JSON |
| assemblySourceSHA | Same final integrated assembly SHA |
| compiledSourceSHA | Same fixed compiled SHA |
| variant | `local` |
| explicitApproval | true, recorded only after external approval |
| reviewer | Nonempty external reviewer identifier |
| recordId | Nonempty external approval/evidence identifier |

The approval FILE BYTES have a separate SHA-256 supplied by the trusted operator. There is no
self-reference: manifest contains neither its own hash nor approval information. The approval
record references the manifest hash; CLI pins reference both files. The assembly SHA is a
parameter in these external records, not a constant requiring a post-approval source patch.

Read-only exported helpers `recoverySourceEvidence(desktop, compiledSHA, assemblySHA)` and
`preservedTreeDigest(root)` compute the exact values; they neither approve nor package. Final
source/diff pins must be recomputed after cherry-picking/integration, not copied from the worker
branch. Do not use placeholders or invent an approval record in order to get a passing check.

## Source and path contract

The exact changed-path allowlist is:

```
desktop/scripts/release-variants.mjs
desktop/scripts/release-variants.test.mjs
desktop/scripts/release-recovery.mjs
desktop/scripts/release-recovery.test.mjs
desktop/docs/release-variants-recovery.md
```

The full diff includes the verifier itself. It is hashed with `git diff --no-ext-diff
--no-textconv --no-renames --binary --full-index BASE HEAD`. Git replacement objects are disabled.
Both SHAs must resolve exactly, with the compiled SHA an ancestor. No caller may expand the
allowlist. Tracked-input digests are SHA-256 over sorted NUL-terminated `git ls-tree -rz
--full-tree SHA` records excluding ONLY these five exact paths. Path, blob ID and Git mode are
included. All other tracked source/assets/config/trust/lock files must be identical.

The verifier also checks actual worktree bytes against tracked Git blob IDs, executable bits,
and regular canonical paths; this catches changes hidden by assume-unchanged/skip-worktree.
Tracked symlinks/submodules and untracked/ignored source inputs are rejected. Only these ignored
non-input dependency/generated-output trees are excluded from the untracked check:
`desktop/node_modules`, `Web/node_modules`, `desktop/out`, `desktop/mobile/dist`, `desktop/.cache`,
`desktop/dist`, `desktop/test-results`, `desktop/playwright-report`. There are no source-tree
wildcard exceptions. Dependency installations remain operator-controlled, as in the original
lock/tool-version provenance; this is not a new attestation of every node_modules byte.

Original frozen provenance is verified under its ORIGINAL compiled SHA, including complete
inventory bytes/modes and storage sidecar. All other source fields must match current Node,
platform/architecture, lock digest, tool versions, public trust and storage contract.

Recovery stage/output must be disjoint, outside the ENTIRE frozen root and checkout, and must
not overlap either operator record. Their real parents must already exist, be canonical and
owned, and not group/world-writable. Symlink parents/noncanonical paths and existing destinations
are refused. Paths are checked again immediately before exclusive mkdir (mode 0700). Do not
remove or rename failed local directories to make ordinary --reuse-built work. Builder caches
are confined to the new recovery output, not inherited cache paths in preserved trees.

## Complete preservation on success and failure

Before signer preflight or builder invocation, the verifier checks both pinned records, approval,
local-only scope, both SHAs, complete diff/input digests, actual worktree, paths, original frozen
manifest/inventory and all three preserved trees. Each preserved-tree digest includes root and
nested directories with modes, file bytes/size/mode, and symlink target text/mode. Legal relative
app symlinks resolving within their own tree are recorded without traversal; escaping/dangling
links and nonregular nodes are refused. There are NO ignored files or volatile exclusions in
these preserved trees. Thus all public artifact bytes and all failed-local evidence are bound.

After preflight the checks run again before assembly. After assembly they run before ZIP
signing. They run again on both SUCCESS AND FAILURE, independently rechecking frozen/preserved
trees even if source/approval validation already fails. Any mutation prevents completion;
errors retain original failures plus postcheck failures. No cleanup, rollback, second compile
or automatic retry occurs. Retain outputs for review. Operator must prevent concurrent writers;
the verifier detects observed differences, not a malicious writer that changes and restores
bytes entirely between checks.

The local version/profile remain `2.0.0-local-trial.20261029.1` / true. Existing signing-key
preflight, ASAR/native metadata checks, external-resource hashes, native codesign and ZIP
manifest verification remain enabled. SOURCE_COMMIT.txt, native BotlingGitCommit and sourceSHA
identify COMPILED f7860bc9. Local ASSEMBLY_PLAN/VARIANT_PROVENANCE additionally contain a recovery
record with both SHAs, diff/input/original-manifest digests and the exact approval record/pins.
RECOVERY_COMPLETE.json is written only after successful final checks. It is not installation or
publication approval; local native/profile/bootstrap acceptance is still required.

## Candidate-worker commands after full review

First run focused checks in the integrated checkout:

```sh
node --test scripts/release-recovery.test.mjs scripts/release-variants.test.mjs scripts/release-sign.test.mjs scripts/release-check.test.mjs
```

With the externally reviewed absolute paths and pins supplied as operator variables, read-only
validation (no private key read, no new directories, no build/sign callbacks) is:

```sh
node scripts/release-recovery.mjs --check \
  --manifest "$REVIEWED_MANIFEST" --manifest-sha256 "$REVIEWED_MANIFEST_SHA256" \
  --approval "$OPERATOR_APPROVAL" --approval-sha256 "$OPERATOR_APPROVAL_SHA256"
```

Only after approval of this exact recovery, remove `--check` and add
`--key-file "$APPROVED_KEY_FILE"`. This invokes ONE local assembly and separate native/ZIP signing;
it never compiles. Do not run it as part of implementation validation. There is no production
CLI base-SHA override; the verifier's injectable test policy exists only for disposable Git
fixtures. The normal exact-SHA verifier is unchanged.
