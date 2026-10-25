# 首次開啟 Botling 2 / First open

## 繁體中文

請從 [Botling 官方 Releases](https://github.com/william1010121/Botling/releases) 下載 **2.x** 版本。尚未經 Apple 公證或建立 Windows 發行者信譽的版本，首次開啟時可能被系統攔下；以下操作只適用於你確認來源可信的這份下載。

### macOS 15（Sequoia）

1. 解壓縮，將 **Botling 2.app** 拖入「應用程式」（`/Applications`）。先退出下載檔或磁碟映像中的副本，再開啟「應用程式」中的 Botling 2。
2. 若看到 Apple 無法驗證開發者或無法檢查惡意軟體的提示，關閉提示，前往 **系統設定 → 隱私權與安全性**，向下捲至「安全性」。
3. 在 Botling 2 的封鎖訊息旁按 **仍要打開（Open Anyway）**，依提示驗證身分，再按「打開」。若找不到按鈕，重新嘗試開啟 app，隨即回到此頁。macOS 15 請使用此設定頁面的流程。

替代方式：確認下載來源可信、app 已放在上述位置後，於終端機執行以下**只針對這個 app** 的指令，再開啟它：

```sh
xattr -dr com.apple.quarantine "/Applications/Botling 2.app"
```

這會移除這份 app 的下載隔離標記，不會全域停用 Gatekeeper。若系統明確偵測到惡意軟體，請不要繞過提示；重新從官方來源下載。受管理電腦的政策可能不允許覆寫。

### Windows

若看到 Microsoft Defender SmartScreen 的 **Windows protected your PC**，確認是官方下載的安裝程式後，按 **More info（其他資訊）→ Run anyway（仍要執行）**，再完成安裝。若沒有「仍要執行」，請遵循電腦管理員政策。Windows 版本尚待實機驗證。

### 後續更新

版本檢查預設開啟。下載必須通過內嵌 Ed25519 公鑰驗證版本、SHA-256 與大小；只有按 **Download and verify → Restart to update** 才會更新。上一版保留至新版成功啟動，啟動失敗則還原。若顯示未設定更新信任金鑰，請到官方 release 頁手動下載；首次安裝的信任仍須自行確認。唯讀磁碟或 App Translocation 中的副本，請先移到「應用程式」。目前自動安裝僅支援 macOS。

## English

Download a **2.x** build from [Botling Releases](https://github.com/william1010121/Botling/releases). Builds without Apple notarization or established Windows publisher reputation may be blocked on first open. Only use these steps for a download whose source you trust.

### macOS 15 (Sequoia)

1. Extract the download and move **Botling 2.app** into **Applications** (`/Applications`). Quit any copy running from the download or mounted image, then open the Applications copy.
2. If macOS cannot verify the developer or check the app for malicious software, dismiss the message and go to **System Settings → Privacy & Security**. Scroll to **Security**.
3. Click **Open Anyway** beside the Botling 2 message, authenticate if asked, and confirm **Open**. If the button is missing, try opening the app again and return to this page promptly. Use this Settings flow on macOS 15.

Alternative: after confirming the download's source and moving the app to that exact location, run this command in Terminal, then open the app:

```sh
xattr -dr com.apple.quarantine "/Applications/Botling 2.app"
```

This removes quarantine only from that app; it does not disable Gatekeeper globally. Do not bypass an explicit malware detection. Download a fresh copy from the official source. Managed devices may prohibit an override.

### Windows

If Microsoft Defender SmartScreen shows **Windows protected your PC**, confirm the installer came from the official release, then select **More info → Run anyway** and finish installation. If Run anyway is unavailable, follow your administrator's policy. Windows builds still need testing on a Windows machine.

### Later updates

Update checks are on by default. A download must pass embedded Ed25519 verification of its version, SHA-256 and size. Installation requires **Download and verify → Restart to update**. The previous app remains until the new version boots; a failed boot rolls back. If update trust is unconfigured, download manually from the official release page. You must establish trust in the initial download yourself. Move read-only or App Translocation copies into Applications first. Self-installation currently supports macOS only.

References: [Apple: Safely open apps on your Mac](https://support.apple.com/en-us/102445), [Microsoft: SmartScreen first-run guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app#step-6-handle-smartscreen-for-new-apps).
