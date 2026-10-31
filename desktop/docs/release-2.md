# Electron 2 release procedure

The authoritative version is `desktop/package.json`, aligned with both version fields in
`desktop/package-lock.json`. Root `VERSION` belongs to the archived Swift 1.x build; do not bump
it to route a 2.x release. `release.yml` handles only `v2.*` and manual dispatch, builds `desktop/`
on macOS, Windows and Linux, and uploads candidate artifacts. It has read-only repository permissions
and never creates a tag, GitHub release, or publication: attaching the artifacts to a release is an
operator step.

## What a release contains

electron-updater (`src/main/updates.ts`) reads the update feed that electron-builder writes. Upload all
of these to the GitHub release `vX.Y.Z`; the feed files are what installed apps look for, so a release
without them cannot be updated to:

| Platform | Installer | Feed |
| --- | --- | --- |
| macOS arm64 | `Botling-2-X.Y.Z-mac-arm64.zip` (the update payload), `.dmg` (first install) | `latest-mac.yml` |
| Windows x64 | `Botling-2-X.Y.Z-win-x64.exe` | `latest.yml` |
| Linux x64 | `Botling-2-X.Y.Z-linux-x86_64.AppImage` (updates itself), `.deb` (cannot) | `latest-linux.yml` |

`node scripts/release-check.mjs --artifacts <dir> --platform mac|win|linux` verifies the files exist and
the feed names this version with checksums that match.

## Signing

- macOS: Developer ID signing and notarization by electron-builder, from the repository secrets `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (the `.p8` text; the workflow writes it to a file), `APPLE_API_KEY_ID` and
  `APPLE_API_ISSUER`. A release build without a certificate must not be published: it cannot update itself.
  Changing the signing identity makes macOS ask once for keychain access on the first launch; a refusal means
  the web AIs need a new sign-in.
- Windows: unsigned for now. The first install shows SmartScreen's warning; updates work.
- Linux: nothing is signed.

## Upgrading from 2.0.x

2.0.x builds used their own updater and a different signing identity. They cannot update to 2.1.0 by
themselves: download 2.1.0 once by hand; after that updates are automatic. The data folder
(`Botling 2 Dev Trial`) is unchanged.
