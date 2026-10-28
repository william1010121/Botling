# Review proposal: resume local assembly without recompiling

Status: proposal only. This document is not approval, an executable recovery manifest or an
implemented cross-SHA bypass. The normal `verifyFrozen` exact-SHA check remains unchanged.
Do not run the corrected head against the old frozen root with ordinary `--reuse-built` and
expect it to pass. Reviewer a16f55c6 must approve the exact recovery contract and manifest before
local resume. Any recovery verifier/layout implementation needs focused review before execution.

## Existing evidence to preserve

The packaging evidence records one desktop and one mobile compilation from clean source
`f7860bc9af7211788c74a9fa553abcc767eb81b2`, successful public assembly/signing/verification, and
local failure in electron-builder's second config normalization before native output.
Build root: `/Volumes/My-SSD/botling-work/builds/release-2.0.0-20261029`.

Do not edit COMPILED_PROVENANCE.json, compiled/, the public ASSEMBLY_PLAN or public provenance,
checksums, ZIP, manifest, DMG, unpacked app or acceptance evidence. Preserve the failed local
stage/output too. The correction does not change any version, profile, signing or runtime input.

## Proposed explicit recovery manifest

Store a new operator-owned manifest outside the source checkout and frozen tree. Bind all of:

- schema identifier and scope `local-only-packager-recovery`;
- `compiledSourceSHA`: the full f7860bc9 SHA above;
- `assemblySourceSHA`: the exact clean reviewed integrated correction SHA (not merely this
  worker's branch name, nor a worker SHA if it is subsequently cherry-picked);
- absolute frozen root and SHA-256 of its original COMPILED_PROVENANCE.json;
- complete original source/toolchain/trust/storage fields and compiled inventory digest;
- exact changed-path list with old/new blob IDs and modes, plus SHA-256 of the full binary diff;
- identical compiled-input tree digest at both SHAs, defined below;
- distinct, previously nonexistent recovery stage and output paths, scoped to local only;
- original public artifact SHA-256 values, public provenance/plan digests, and hashes of the
  preserved failed-local evidence, checked before and after recovery;
- exact approval evidence reference and approved manifest SHA-256, supplied by the reviewer/
  coordinator through the existing authorization channel. A self-written `approved:true` does
  not authorize anything.

The only allowed changed paths for this correction are:

```
desktop/scripts/release-variants.mjs
desktop/scripts/release-variants.test.mjs
desktop/docs/release-variants-recovery.md
```

This is an exact path allowlist, not `scripts/**` or a general packaging exception. Only the
first file executes in packaging; review its exact diff as config isolation only. Test/doc
changes cannot authorize runtime changes. Any additional integrated change needs a newly
reviewed manifest; never automatically expand the list. In particular signer, release trust,
package/lock, electron-builder config, builders, app/core/preload/web/report/mobile sources and
resources must remain identical.

## Proposed verification and execution contract

1. Resolve both full SHAs as commits and require the compiled commit to be an ancestor of the
   reviewed assembly commit. Require a clean assembly checkout, including untracked files.
   Enumerate changes with Git rename detection disabled; reject additions/deletions/type/mode
   changes outside the exact allowlist. Bind the changed path records and the binary diff using
   `git diff --no-ext-diff --no-textconv --no-renames --binary --full-index BASE HEAD`.
2. Compute the compiled-input digest at each commit from sorted, NUL-delimited `git ls-tree -rz
   --full-tree SHA` records after excluding ONLY the three allowlisted paths. Keep path, mode,
   object type and blob ID in each record. Equal digests establish that every tracked potential
   compile/runtime/resource input outside the reviewed packaging delta is unchanged; do not
   substitute a hand-maintained list of likely builder entry points. Require all non-SHA source
   fields in COMPILED_PROVENANCE to match the current Node/toolchain, platform, architecture,
   lock, trust and storage contract. Dependency installations stay operator-controlled as in
   the original provenance contract; this does not add a claim that node_modules was attested.
3. Verify the untouched frozen inventory against its ORIGINAL source identity with the existing
   exact `verifyFrozen(root, originalSource)` behavior. Compare its full bytes/modes and core
   sidecar, and bind the original manifest digest to the approved recovery manifest. A separate
   explicit recovery verifier may then return TWO identities: compiled source and assembly
   source. It must never replace the frozen sourceSHA, suppress a normal source mismatch, or
   treat a matching package version as equivalent provenance.
4. After approval, use the corrected packager in a fresh process for ONE local assembly only,
   into the manifest's fresh recovery paths. Do not retry the public branch, overwrite failed
   local directories, or compile again. Key-file preflight, ASAR/native metadata checks,
   external-resource inventory checks, codesign and per-ZIP manifest verification all stay on.
   The local version remains `2.0.0-local-trial.20261029.1`, trial=true, with epoch2 storage.
5. The new local ASSEMBLY_PLAN/VARIANT_PROVENANCE must record `compiledSourceSHA`,
   `assemblySourceSHA`, original compiled-provenance digest and approved recovery-manifest
   digest separately. Native BotlingGitCommit should continue to identify the compiled runtime
   source; record the packaging correction separately, never label old compiled bytes as a new
   runtime build. Recheck frozen and preserved public hashes afterward, then complete local
   ZIP/native/profile/bootstrap acceptance. Installation/publication still require their own
   exact approval and are not implied by recovery approval.

Negative recovery tests required before implementing/executing the exception: wrong base or
assembly SHA, dirty checkout, changed lock/trust/runtime asset, extra changed path, forged diff
or input digest, altered frozen bytes/manifest, changed public artifact, reused recovery path,
and absent/mismatched approval reference. They must fail before build/sign callbacks. A valid
fixture must preserve the original SHA and invoke only one local assembly, with zero compile
callbacks. This proposal intentionally provides no command that silently bypasses the current
source gate.
