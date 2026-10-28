# Two release variants from one compilation

Implementation for the 2026-10-29 2.0.0 release. These commands are for the candidate worker
**after all corrections are integrated, reviewed and cumulative validation is authorized**.
They are not evidence that compilation, packaging, signing or installation has happened.
Install and publication still require explicit user approval.

Use a clean, isolated candidate checkout on macOS arm64 with dependencies linked via
`scripts/link-deps.sh`. Commit all corrections first. The source package and lock must declare
stable `2.0.0`, `botlingDevTrial: false`, storage `{version:1,epoch:2}` and configured Ed25519 trust.
The checkout's `out/` and `mobile/dist/` must be exclusively owned; compile replaces both.
Do not run tests that rebuild or remove these directories concurrently (R01 owns that repair).

From `desktop/`, select an unused absolute release root outside the checkout (parent exists):

```sh
node --test scripts/release-sign.test.mjs scripts/release-variants.test.mjs scripts/release-check.test.mjs
node scripts/release-check.mjs --tag v2.0.0 --trust
export BOTLING_RELEASE_KEY_FILE='/absolute/path/to/operator-owned-ed25519.pkcs8.pem'
node scripts/release-sign.mjs preflight
node scripts/package.mjs --release-variants /Volumes/My-SSD/botling-work/builds/release-2.0.0-20261029 --sign-manifests
```

The last command compiles desktop and mobile once each, freezes their complete inventory,
then separately assembles/signs public and local ASAR/native bundles, ZIPs and DMGs. It invokes
the existing signer separately for each exact ZIP and verifies each signed manifest. It never
publishes, installs or changes user data. CSC_LINK/CSC_NAME/BOTLING_RELEASE_KEY must be unset;
Apple signing is ad-hoc. Select the private key by absolute file path using
`BOTLING_RELEASE_KEY_FILE` or `--key-file /absolute/path/to/key.pem` (the flag takes precedence).
Do not put PEM bytes in this variable or copy the key to the legacy default. The selected
file must be a readable, non-symlink regular file, owned by the invoking UID with exactly
0600 permissions on POSIX. The signer validates the opened file descriptor too, rejects
symlink substitution/nonregular files, and checks an Ed25519 key against committed public trust.

When signing is requested, or a key file is explicitly selected, variants runs the signer's
silent `preflight` subprocess **before creating the compilation root or running either builder**,
and before reuse assembly. Only that subprocess reads private bytes; the parent forwards a
path and suppresses raw child errors. A matching key exits zero with no output; failure is
nonzero with a fixed sanitized diagnostic, never PEM, path, OpenSSL details or an exception
stack. The key is reopened and revalidated for each later manifest signature, so preflight is
not a guarantee against subsequent removal/replacement. No key bytes are stored in provenance.
Without `--sign-manifests` ZIP manifests are not signed or emitted, even when preflight runs.
Standalone `release-sign.mjs sign <version> <zip> --key-file <absolute-path>` uses the same checks.
Standalone signing preserves CI's existing `BOTLING_RELEASE_KEY` PEM-secret input when no file
input is selected; combining both input forms is rejected. With neither input, the legacy
`~/.botling-release/ed25519.key` remains the default and now uses the same safe file checks.

For a review pause between compilation and assembly, keep the path-only environment variable
above set and use instead:

```sh
node scripts/package.mjs --compile-only /Volumes/My-SSD/botling-work/builds/release-2.0.0-20261029
node scripts/package.mjs --reuse-built /Volumes/My-SSD/botling-work/builds/release-2.0.0-20261029 --variant public --sign-manifests
node scripts/package.mjs --reuse-built /Volumes/My-SSD/botling-work/builds/release-2.0.0-20261029 --variant local --sign-manifests
```

These are alternatives, not six sequential commands. Reuse never compiles. It requires the
same clean SHA, lock digest, Node/platform/architecture, dependency tool versions, public-key
fingerprint, complete compiled file bytes/modes and core storage sidecar. Failure stops; it
never silently recompiles or relabels old output. Compilation roots and variant stages/outputs
cannot overwrite prior work; after a failed assembly preserve evidence, review it, and remove
only that failed stage/output explicitly before retrying reuse. Do not delete the frozen root.
Provenance is an operator-local audit record, not a cryptographic attestation against a writer
who can replace both compiled bytes and the inventory. Dependency installations must remain
operator-controlled and unchanged; tool versions and the lock are recorded, not every installed
node_modules byte. Changes to any reviewed source revision invalidate reuse.

Outputs are `public-production/` (`2.0.0`, false) and `local-trial-preserving/`
(`2.0.0-local-trial.20261029.1`, true). Both retain bundle ID and `Botling 2.app` root.
Each has its pre-sign ASSEMBLY_PLAN, SOURCE_COMMIT, VARIANT_PROVENANCE, SHA256SUMS and distinct
ZIP/DMG names. When requested, each ZIP has its own verified Ed25519 manifest. The staged
package metadata is written before electron-builder computes AppInfo or creates ASAR; the
native full prerelease version is set before signing. afterPack verifies actual ASAR/native
version, profile, update auth, package/core storage and every shipped out/ file hash; afterSign
verifies the app seal. Before signing, the actual `Contents/Resources/mobile` and `report`
trees are also checked against the frozen inventory through the official extraResources
`from`/`to`/`filter` mappings. This includes token-flow.css, KaTeX fonts and all three external
report documents. Exact relative file lists, sizes, SHA-256 and permission bits (including
special bits) must match; missing/extra files, extra empty directories and symlinks at any
component from appOutDir through each mapped tree are rejected. Mapping traversal, overlapping
destinations, missing approved filter matches and unsupported glob syntax fail closed. Only
explicit filters and basename `*` used by the current config are supported; there are no
volatile-file exclusions inside mapped resource trees. Electron-owned resources outside those
mapping roots remain covered by the normal native package/signature checks, not this compiled
resource inventory. No signed app is patched. Public DMG uses Applications; local DMG contains
only app and LOCAL-UPGRADE.md, with no sibling trial-data launcher.

One compilation is possible because main reads trial metadata from packaged package.json and
version from app.getVersion(); builders embed the shared public key and epoch2 sidecar, not
variant version/profile constants. Review this assumption if builders/runtime readers change.
The focused tests use throwaway fake builder outputs; they do not substitute for real assembly.

After assembly run the unchanged public gate:

```sh
node scripts/release-check.mjs --tag v2.0.0 --trust --artifacts /Volumes/My-SSD/botling-work/builds/release-2.0.0-20261029/public-production
```

The local prerelease intentionally cannot pass public checkMetadata. Its manifest is checked
with unchanged checkArtifact during signing. Candidate acceptance must still inspect both
ZIP-contained native/ASAR versions, codesign and exact storage/trust metadata, exercise synthetic
clean production startup and trial profile/bootstrap acceptance, and verify current profile pin
without weakening verifyProfilePin/update authorization. Actual ZIP SHA/runtime SHA belong in
the later exact offline plan; do not invent them or treat this document as install approval.
