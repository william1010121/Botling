# Cutting a Botling 3 release

A Botling 3 release is built, signed and notarized by `.github/workflows/release.yml` when a tag `v<x.y.z>-v3` is
pushed (for example `v3.2.2-v3` for version 3.2.2). The workflow's `plan` job reads the tag
(`desktop/scripts/release-check.mjs --print-plan`) and picks the line; Botling 2 tags (`v2.*`) behave as before.

## Why the tag ends in `-v3`

Botling 3 sets `updater.channel = "v3"` and `allowPrerelease = true` (`desktop/src/main/updates.ts`). With a channel
set, electron-updater 6.8.11 (`GitHubProvider.getLatestVersion`) takes only a release whose tag's pre-release part is
that channel, and then reads `v3-mac.yml` from it. A tag like `v3.2.2` is skipped and the check says "No published
versions on GitHub". `desktop/test/unit/v3-update-channel.test.ts` runs the real provider against a fake feed to show
both cases. The app's own version stays `3.2.2`; only the tag carries the suffix (the app's release page link adds it:
`releaseUrl(version, channel)`).

## Why Botling 2 is not affected

- The release is marked **pre-release** and never **Latest**. Botling 2 reads the Latest release's `latest-mac.yml`
  (GitHub's `/releases/latest` skips pre-releases), so it keeps seeing the newest 2.x release.
- The v3 release holds no `latest-mac.yml`; the publish job refuses a v3 release that does, and checks afterwards that
  GitHub says the release is a pre-release and not Latest.
- A 2.x dev trial (a pre-release build on channel `dev`) only takes a tag of its own channel.

## What the v3 build is

- macOS arm64 only: `Botling-3-<v>-mac-arm64.zip`, `.dmg`, `v3-mac.yml`, `SHA256SUMS.txt`. No Windows or Linux build,
  no `botling-agent` assets (its install script downloads from tag `v<version>`).
- Packaged with `npm run dist:mac:v3` (`electron-builder.v3.config.cjs`) and `BOTLING_V3_VERSION` = package.json's
  version. `desktop/scripts/package.mjs` refuses a release build (`BOTLING_RELEASE_BUILD=1`) where they differ.
- `botlingDevTrial`: `desktop/package.json` keeps `true` for the Botling 2 dev-trial profile, which only the 2.x main
  reads. The v3 config packs `botlingDevTrial: false` and its own DMG layout (the Applications link), so a v3 release is
  never a trial whatever package.json says.
- Signing and notarization use the same secrets as Botling 2: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. A tag build without them fails.

## Steps

1. On `main` (CI green): bump `desktop/package.json` and `desktop/package-lock.json` (both `version` fields) to `3.x.y`
   and add a `## 3.x.y` section to `CHANGELOG.md` (the workflow copies it into the release notes).
2. `git tag v3.x.y-v3 && git push origin main v3.x.y-v3`.
3. The workflow builds, signs, notarizes, verifies and creates a **draft pre-release** with the assets.
4. Look at the draft, edit the notes, then publish it as a pre-release that is not Latest:
   `gh release edit v3.x.y-v3 -R william1010121/Botling --draft=false --prerelease --latest=false`.
