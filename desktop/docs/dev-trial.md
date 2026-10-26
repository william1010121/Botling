# Botling 2 dev trial — 2026-10-26

Version: **2.0.0-dev.20261026.1**, macOS arm64 (Apple Silicon), macOS 13 or later.
This is a local development trial, not a formal release or an installed upgrade.

## 開始試用 / First open

1. 在可寫入的外接工作碟建立新的 trial 資料夾。將 DMG 中的 **Botling 2.app**、**Launch Dev Trial.command**、本說明一起複製進去；不要在掛載的唯讀 DMG 內啟動。ZIP 使用者先解壓 app，另將交付的捷徑與說明放在旁邊。不需安裝到 Applications，也不要取代原本的 app。
2. 確認來源後，由你手動開啟 **Launch Dev Trial.command**。捷徑直接執行這份 app，資料、Electron profile 與暫存放在同層 **trial-data/**；Claude/Codex 使用你自己的 `~/.claude`、`~/.codex`（與 1.x 相同），並預設匯入 1.x（`~/.claudecodebot`）的資料。（下一版起；2026-10-26.1 的捷徑仍是獨立設定、不匯入。）
3. 與 1.x 相同，專案不會因為 1.x 也開著而變成唯讀；聊天裡只會出現一則提示。
4. 若 macOS 攔下未公證 app，在「系統設定 → 隱私權與安全性」對這份 app 選「仍要打開」。若捷徑被攔，於 Terminal 執行 `/bin/sh "/完整路徑/Launch Dev Trial.command"`。不要全域停用 Gatekeeper。包是 ad-hoc 簽名，沒有 Apple Developer ID 或公證。

Copy all three items into a new writable folder on your work volume, then manually run the shortcut. Do not replace an installed app or launch from the mounted image. The shortcut keeps data and temporary files under its sibling `trial-data/`; from the next build it uses your own `~/.claude` and `~/.codex` and imports 1.x (`~/.claudecodebot`) by default, as 1.x would. A project 1.x also has open stays writable (a notice only). If macOS blocks this trusted local copy, use its app-specific Privacy & Security → Open Anyway flow.

If opened directly without the shortcut, it uses the separate **Botling 2 Dev Trial** application-data profile and (from the next build) imports 1.x by default. The shortcut keeps the trial's own state on the work volume. Closing the app keeps trial data; nothing deletes it automatically.

## CLI launch requirements (source fix for the next cumulative build)

Claude and Codex are external installations, not bundled with Botling. Finder/LaunchServices may
provide only `/usr/bin:/bin:/usr/sbin:/sbin`; the core now searches the inherited absolute PATH
entries first, then stable user install directories (`~/.local/bin`, `~/.npm-global/bin`, Volta,
asdf/mise shims, nvm current, fnm default and Nix profiles), Homebrew and system directories.
The expanded PATH also reaches the CLI's subprocesses: npm entry points need a separately
installed `node` interpreter. In particular, macOS Nix's `/etc/profiles/per-user/<account>/bin`
is included. No shell startup files are sourced and no credentials or CLI configuration are copied.

For an installation outside these locations, the installed app launcher may supply an absolute
`BOTLING_CLAUDE_PATH` and/or `BOTLING_CODEX_PATH`; explicit paths are authoritative and do not
fall back to another CLI if broken. Supply a PATH containing `node` as well for a custom npm/Node
installation. The launcher's HOME must identify the intended user; CLI symlink targets, Node and
the bot's working directory must exist and be accessible. No user shell command is required for
the standard install locations above.

Keep the existing `BOTLING_DATA_DIR`, `BOTLING_IMPORT_FROM`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`
and `TMPDIR` values when integrating this fix. Executable discovery does not change login state:
an isolated trial config still requires its own existing login. The imported development launcher
also requires its external volume, referenced app binary and `core/import.json` to be available.
This source change does not edit that installed launcher, import data, install or restart the app.

Source validation on 2026-10-26: the two head regressions first failed with `spawn claude ENOENT`
and `spawn codex ENOENT`. After the fix, 45 targeted checks across CLI launch, stream handling,
Codex protocol, catch-up, trial launch and packaged environment tests passed; TypeScript checking
passed. With the real installed binaries, minimal GUI PATH and synthetic config directories,
`claude --version` returned `2.1.310 (Claude Code)` and `codex --version` returned `codex-cli 0.163.0`.
The explicit npm Codex entry point changed from exit 127 (`env: node: No such file or directory`)
to exit 0. These are background startup checks, not evidence of live model access or of this fix
being installed in the running app. Cumulative integration and packaging remain separate work.

## 已知問題 / Known limitations

- **啟動、切回視窗或焦點切換時可能掉字／漏第一個字元。**先點輸入框再打字，送出前核對內容；這不是已修好的保證。舊輸入路徑保留。新的 stable editor host 尚未啟用，獨立 input adapter 提交不在這份包內，延後後續版本。
- Recovery/counter 的窄案例已觀察到儲存成功；歷史完整 recovery → restart → counter 流程未在此版本重驗。保留恢復資料，不自動刪除備份。
- **沒有 live self-update。** Production trust remains `publicKey: null`, so verified installation fails closed. The unchanged default version check may read release metadata; that does not enable installation. Obtain any later trial manually.
- This build is intentionally named **unsigned-updates**; app and DMG have local ad-hoc Apple signatures, not a production update signature or notarization.
- This trial does not claim a current full GUI/native focus/IME/packaged-update test pass. Its delivery evidence lists the exact non-GUI and artifact checks performed. No focus-stealing test is required for this limited trial.

Import: from the next build the trial imports 1.x by default; set `BOTLING_IMPORT_FROM` to a chosen **copy** of 1.x data to import that instead. The importer is read-only. No import, install, shared-app restart, publishing or deletion is performed by this delivery.
