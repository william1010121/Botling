# Botling 2 dev trial — 2026-10-26

Version: **2.0.0-dev.20261026.1**, macOS arm64 (Apple Silicon), macOS 13 or later.
This is a local development trial, not a formal release or an installed upgrade.

## 開始試用 / First open

1. 在可寫入的外接工作碟建立新的 trial 資料夾。將 DMG 中的 **Botling 2.app**、**Launch Dev Trial.command**、本說明一起複製進去；不要在掛載的唯讀 DMG 內啟動。ZIP 使用者先解壓 app，另將交付的捷徑與說明放在旁邊。不需安裝到 Applications，也不要取代原本的 app。
2. 確認來源後，由你手動開啟 **Launch Dev Trial.command**。捷徑直接執行這份 app，資料、Electron profile、暫存及獨立 Claude/Codex 設定皆放在同層 **trial-data/**；不複製登入憑證，也不自動匯入 1.x 聊天。首次真模型使用可能需要在這份獨立設定登入。
3. 先用 **trial-data/projects/** 下的新空資料夾試用。舊專案的寫入仍受原有專案鎖與授權保護；不要為試用改用真實工作資料。1.x 資料位置只保留既有的唯讀專案鎖檢查，沒有關閉保護。
4. 若 macOS 攔下未公證 app，在「系統設定 → 隱私權與安全性」對這份 app 選「仍要打開」。若捷徑被攔，於 Terminal 執行 `/bin/sh "/完整路徑/Launch Dev Trial.command"`。不要全域停用 Gatekeeper。包是 ad-hoc 簽名，沒有 Apple Developer ID 或公證。

Copy all three items into a new writable folder on your work volume, then manually run the shortcut. Do not replace an installed app or launch from the mounted image. The shortcut keeps data, temporary files and CLI settings under its sibling `trial-data/`, with no credential copying or automatic 1.x import. Start with a new empty project. The existing project-lock and approval protections remain. If macOS blocks this trusted local copy, use its app-specific Privacy & Security → Open Anyway flow.

If opened directly without the shortcut, this artifact still disables automatic import and uses the separate **Botling 2 Dev Trial** application-data profile. However, the shortcut is required to keep all trial state on the work volume and isolate Claude/Codex configuration. Closing the app keeps trial data; nothing deletes it automatically.

## 已知問題 / Known limitations

- **啟動、切回視窗或焦點切換時可能掉字／漏第一個字元。**先點輸入框再打字，送出前核對內容；這不是已修好的保證。舊輸入路徑保留。新的 stable editor host 尚未啟用，獨立 input adapter 提交不在這份包內，延後後續版本。
- Recovery/counter 的窄案例已觀察到儲存成功；歷史完整 recovery → restart → counter 流程未在此版本重驗。保留恢復資料，不自動刪除備份。
- **沒有 live self-update。** Production trust remains `publicKey: null`, so verified installation fails closed. The unchanged default version check may read release metadata; that does not enable installation. Obtain any later trial manually.
- This build is intentionally named **unsigned-updates**; app and DMG have local ad-hoc Apple signatures, not a production update signature or notarization.
- This trial does not claim a current full GUI/native focus/IME/packaged-update test pass. Its delivery evidence lists the exact non-GUI and artifact checks performed. No focus-stealing test is required for this limited trial.

Import is optional later: leave this shortcut unchanged for isolated trial use. A separate manual launch may explicitly set `BOTLING_IMPORT_FROM` to a chosen **copy** of 1.x data; the importer is read-only and project locking remains enabled. No import, install, shared-app restart, publishing or deletion is performed by this delivery.
