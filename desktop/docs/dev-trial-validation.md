# Development trial delivery evidence — 2026-10-26

User reduced acceptance to a development trial with known bugs; this is not formal 2.0 release acceptance.

- Version: **2.0.0-dev.20261026.1**, macOS arm64, minimum macOS 13.
- Source/build commit: **363e2bf5cf705594e1e7b37960dc92b50eb5c7bb**, on `bot/codex-phase5c-integration`.
- The new stable-editor boundary remains dormant. Input-owner `a7254dd0` is deliberately not integrated. Existing input routing and sandbox/author/approval/project-lock checks remain.
- Embedded trial metadata disables default 1.x import and uses a separate normal-launch profile. The supplied manual shortcut places app data, temporary files and separate CLI settings beside it; it copies no credentials. See [first open and limitations](dev-trial.md).
- Production update trust remains null. Explicit `--unsigned-updates`; no live self-installation. Default version checks are unchanged. App and DMG are ad-hoc signed, not notarized.

## Checks actually run

- New isolation regression before the change: **4 failed / 2 passed**. Causes: normal packaged import fallback, no separate trial profile and no supplied shortcut.
- Current typecheck: **passed**.
- Current focused non-GUI checks: **38 passed across seven files**: trial isolation 6, packaged environment 3, dormant boundary/main security 17, trace preload 4, actual built Node-core project locks 3 and read-only importer 5. Lifecycle's other 12 cases were intentionally excluded, not counted as passes. All fixtures are synthetic; no real CLI, user data or Electron app ran.
- One serial `npm run dist:mac -- --unsigned-updates`: **passed**; build completed at **2026-10-26 02:35:15 Taipei**. No publish/install action.
- App deep/strict and DMG strict `codesign --verify`: **passed**, signatures report `adhoc`.
- `hdiutil verify`: **passed**. ZIP CRC and bundle-only layout: **passed**.
- ASAR: current trial/version/unsigned metadata, fresh build byte matches, required core/preload/renderer/plugin host and 20 font files present; no tests, maps or node_modules. Main/core/preload literal requires have no unexpected non-builtin dependency. Hardened Electron fuse checks passed.
- DMG offline full archive test passed; main app payload, executable, Info.plist, CodeResources, instructions and shortcut match the build exactly. No Applications install link. Initial 7zip stdout comparison included a 201-byte alternate stream; selecting main file streams with `-sns-` resolved the diagnostic without changing source/artifact or rebuilding. Both original and corrected evidence remain.

## Explicit gaps

- One requested read-only mount attempt (`hdiutil attach -readonly -nobrowse -noautoopen`) failed with **Permission denied**. It was not retried. Offline archive inspection completed instead; mounted app verification is not claimed.
- **No startup/runtime, GUI, full suite, native focus/IME, 20-round composer, packaged relaunch or live updater validation on this build.** User's no-interruption restriction and runtime STOP remain intact. Prior runtime results are not attributed to this build.
- Known launch/focus input loss (E3) is accepted for this trial, not fixed. Click the composer and check the text before sending. The historical complete recovery-to-restart-to-counter flow remains unverified; the earlier narrow persistence evidence is not a substitute.
- Installed App Management behavior remains the accepted partial limitation. No real installed app or /Applications copy was modified or restarted.

## Artifacts

Directory: `desktop/.cache/dist/dev-trial-20261026.1/`. DMG contains app + first-open instructions + manual shortcut; ZIP contains only the app, with instructions/shortcut delivered beside it. Keep them together in a writable trial folder on the work volume.

- `Botling-2-2.0.0-dev.20261026.1-mac-arm64-unsigned-updates.dmg`: 131292544 bytes; SHA-256 `edbaf5abbdadfbe5f1227eb7588e9e89c26ae482f178f226eb768354f0922fed`.
- `Botling-2-2.0.0-dev.20261026.1-mac-arm64-unsigned-updates.zip`: 126949358 bytes; SHA-256 `39cf6fa51563862754d7f5c809e396b40047a8bf3c6726a272e1f78568353ec7`.

`SHA256SUMS.txt` also covers `DEV-TRIAL.md` and `Launch Dev Trial.command`.
Raw check logs, original mount failure, stream diagnosis and artifact hashes: `desktop/.cache/evidence/dev-trial-20261026/`.
