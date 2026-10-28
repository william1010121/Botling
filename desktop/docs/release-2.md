# Electron 2 release procedure

The authoritative version is `desktop/package.json`, aligned with both version fields in
`desktop/package-lock.json`. Root `VERSION` belongs to the archived Swift 1.x build; do not bump
it to route a 2.x release. `release.yml` now handles only `v2.*` and manual dispatch, builds
`desktop/`, and uploads candidate artifacts. It has read-only repository permissions and never
creates a tag, GitHub release, or publication. The Swift/Web CI jobs remain legacy coverage;
the desktop job adds typecheck, unit, report and mobile isolation checks. Live/e2e and clean-user
acceptance remain separate operator gates; green CI is not certification of those behaviors.

## Trust provisioning — blocked until the owner supplies the existing identity

`release-config.json` intentionally still has `publicKey: null`. Neither CI nor packaging may
silently generate a new trust root or use `--unsigned-updates` for a production release.
The owner must supply/approve the intended Ed25519 public SPKI PEM (including its final newline)
and arrange access to the matching private PKCS8 PEM. Commit only that public key to
`desktop/release-config.json` **before** building. Provision the private PEM as GitHub Actions
secret `BOTLING_RELEASE_KEY` through the owner's approved secret channel; never put it in Git,
logs, reports or release assets. If an identity already serves users, preserve it. If no identity
exists, choosing and generating one requires a separate explicit owner decision.

The signature binds ZIP digest, byte count and version. `release-sign.mjs` checks that the private
key matches the committed public key; `release-check.mjs --artifacts dist` independently verifies
the manifest signature and bytes. Missing trust fails before dependency install. The secret is
available only to the final signing step, after build/tests. Missing or mismatched signing material
fails without uploading candidates. Runtime update signature enforcement is unchanged.

Apple signing is separate: the prepared workflow uses **ad-hoc Apple code signing**, with no
Developer ID certificate or notarization. This does not replace the mandatory Ed25519 updater
signature. An owner request for Developer ID/notarization needs a separate credential-backed
workflow change and notarization/stapling acceptance. Do not describe the current assets as
notarized, Gatekeeper approved, or unsigned-updates.

Read-only provisioning audit, 2026-10-29: repository Actions secrets and environments both list
zero entries. Organization secrets, other key locations and macOS keychains have not been
certified. No keys or settings were changed by this preparation.

## Production profile and migration

`botlingDevTrial: false` selects the normal Applications-link DMG and bundled renderer/preload.
With no explicit data override, macOS opens `~/Library/Application Support/Botling 2`, distinct
from `Botling 2 Dev Trial`, source `.data`, and a launcher's sibling `trial-data`. Existing
`Botling 2` data is reused. This metadata change neither moves nor deletes any profile.
Do not launch the production app through the old trial shortcut if you want the normal profile:
explicit `BOTLING_DATA_DIR` / updater data arguments remain supported and take precedence.

A fresh production profile imports from `~/.claudecodebot` through the existing read-only 1.x
importer (or an explicitly chosen `BOTLING_IMPORT_FROM`). Existing target projects/chat/import
record prevent first-start import. The source stays intact. Web sign-ins and plugin keychain
secrets do not transfer; reauthenticate them. Projects and attachments can still refer to original
paths, so retain the old data. This is not a Dev Trial-to-production merge. If trial history must
be retained, stop and agree a backed-up migration procedure before first production launch;
do not point the 1.x importer at a trial profile or overwrite an existing production profile.
No live profile, importer or persistence behavior is changed by this work.

## Candidate and publication gates

1. Integrate all owners on one clean reviewed commit: TokenFlow's mobile CSS filter, deterministic
   bundles, task/persistence and other agreed changes. Confirm the 2.0.0 changelog/release scope.
   This preparation does not own those fixes or certify their inclusion.
2. Complete trust provisioning above. Run the authorized cumulative checks and one macOS arm64
   package pass. Verify ZIP bundle identity `io.github.william1010121.Botling2`, version 2.0.0,
   embedded production metadata/trust, Apple signatures, ordinary DMG contents and mobile assets.
   Test fresh-profile first open/import, dev override rejection and verified update/restart using
   synthetic data; preserve real user data. Do not infer package acceptance from source unit tests.
3. After explicit coordinator/user authorization, push the reviewed commit. Manual dispatch on
   that exact ref can prepare candidates before tagging. A separately authorized `v2.0.0` tag
   invokes the same candidate workflow. No v1 tag invokes this workflow. A branch dispatch must
   still be mapped to its recorded source SHA; do not label arbitrary branch assets as released.
4. Check `SOURCE_COMMIT.txt` against the reviewed commit/tag; verify `SHA256SUMS.txt` and the signed
   ZIP manifest after downloading the workflow artifact. Use these exact files in a **draft**
   GitHub release titled `Botling 2.0.0`, tag `v2.0.0` targeting that exact commit:
   - `Botling-2-2.0.0-mac-arm64.zip`
   - `Botling-2-2.0.0-mac-arm64.zip.manifest.json`
   - `Botling-2-2.0.0-mac-arm64.dmg`
   - `SHA256SUMS.txt` and `SOURCE_COMMIT.txt` for provenance.
   Attach individual files, not the enclosing Actions artifact ZIP. Never upload `dist/*`.
5. Use `.github/release-notes.md` after reviewing it against actual cumulative acceptance. Resolve
   all blockers before creating the draft; publishing the draft is a separate explicit approval.
   The custom updater reads published GitHub releases, so draft assets alone are not live updates.

macOS arm64 is the only proposed platform. Intel, Windows and Linux are not certified here.
Claude/Codex require external installed and authenticated CLIs. Antigravity requires the separately
provisioned pinned ACP/helper runtime and Settings setup; do not claim out-of-box availability.
