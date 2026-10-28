# Botling 2.0.0

Electron desktop release for **macOS Apple silicon (arm64)**. Intel, Windows and Linux assets
are not included. This draft must be reviewed against the final integrated candidate before publication.

## Install

Download `Botling-2-2.0.0-mac-arm64.dmg`, open it and drag **Botling 2.app** to Applications.
Alternatively unpack `Botling-2-2.0.0-mac-arm64.zip`. Keep one installed production copy.
The app uses ad-hoc Apple signing and is **not notarized**. If macOS blocks this trusted download,
use the app-specific System Settings → Privacy & Security → Open Anyway flow; do not disable
Gatekeeper globally. See [first-open guidance](https://github.com/william1010121/Botling/blob/v2.0.0/docs/first-open.md).

The ZIP has a separate Ed25519 `.zip.manifest.json` for authenticated in-app updates. This updater
signature is independent of Apple signing. Update checks are enabled by default with a Settings
opt-out; automatic installation requires matching embedded release trust.

## Existing data

The production profile is `~/Library/Application Support/Botling 2`. Existing production data is
reused; **Dev Trial data is not automatically moved or merged**. The trial shortcut's explicit data
override still targets its trial data: launch from Applications for the normal production profile.
A fresh profile imports supported 1.x data from `~/.claudecodebot` without modifying the source.
Retain the original data and attachments. Web sign-ins and plugin secrets require reauthentication.
See [migration and release details](https://github.com/william1010121/Botling/blob/v2.0.0/desktop/docs/release-2.md).

Claude and Codex require separately installed, authenticated CLIs. Antigravity requires its pinned
external ACP/helper runtime configured in Settings; it is not ready out of the box. Live service
availability depends on the user's installations and accounts.

Final feature notes and known limitations must be reconciled with the integrated 2.0.0 changelog
and clean-user acceptance before this draft is published.
