# Plugin 一鍵 Update 設計(一頁)

分支 `bot/v3-plugin-update`,worktree `/Volumes/My-SSD/botling-work/v3-plugin-update`。程式路徑縮寫:`src/` = `desktop/src/`。

## 現況(已經有的零件,不重做)

- `src/core/plugin-store.ts` + `plugins/catalog.ts`:官方 catalog(`index.json`,每個 plugin 記 `version`、`commit`、資料夾 `sha256`)。`state: "update"` 就是「有新版」。下載的是**那個 commit 的 tarball**,資料夾 `folderHash` 必須等於 index 的 `sha256`,才會進安裝卡。
- `plugins/versions.ts`:library 裡同名 plugin 版本 ≥ 內建版 → library 版取代內建版(app 之後出更新的內建版會自動贏回來)。
- `server/replica/plugin-rows.ts` + `plugin-grant-carry.ts`:registry 變動 → `plugin:<name>` row(`codeHash`、`files.web`)→ 非內建 plugin 的 grant 在「新版不要求更多」時帶過去(audit `plugin.carry`)。
- `renderer/shell/row-loader.ts`:row 的 `codeHash`/`files.web` 變了 → 只換那個 plugin(`Kernel.swap`),bytes 用 `files.web` 的 sha256 驗證。FE build manifest 只釘 `src/renderer/plugins/*`(shell 自己的 in-page plugin);其他 web part 本來就是 frame。
- host:registry rescan → `Plugins.sync` → host `load`(只重載有變的 plugin)。

缺的只有:(1) 一鍵(不走安裝卡、不比權限)、(2) 內建 plugin 的更新版不能保住內建權限、(3) 開著的 panel / 底部面板 frame 更新後不重載。

## 1. 「新版」從哪來

只有一個來源:**catalog index 裡的版本 > 目前在跑的版本**(對內建與已安裝一視同仁)。`PluginStore.stateOf` 已經這樣判斷;不新增第二種來源:
- 內建 plugin 在更新的 app bundle 裡出現 = 換 app(不是這個功能)。library 裡的 dev 副本(`devCopy`)永遠不被取代。
- 內建 plugin 的「更新」= 把 catalog 版裝進 library;`versions.ts` 讓它取代內建版,內建版留在 app 內原封不動(Remove 即退回)。

## 2. 沒有 code-hash 白名單,信任怎麼成立

信任 = **來源 + 完整性 + 綁定**,不是「某個 hash 在清單裡」:
1. 來源:HTTPS 的官方 catalog(`pluginIndexURL` 只給測試),下載該 commit 的 tarball。
2. 完整性:展開後資料夾 `folderHash` == index 的 `sha256`,並通過 `checkPlugin` / `minAppVersion` / `engines`。
3. 綁定:安裝時 registry 在 `plugins.json` 記下 `revisions[name] = sha256`。**內建 plugin 的 library 更新版**只有在「資料夾目前的 `folderHash` 仍 == 該 sha256」時才算 `builtIn: true`(保有 `owns: ["note"]`、`app`/`studio`/`sessions` seam、內建 grant);任何人改了資料夾裡一個 byte,下一次 rescan 它就變回普通 library 副本(失去內建權限,走一般 grant)。stat 簽名(size / mtime / ctime)沒變就沿用上次結果,不重算。
   - 不放寬 `versions.ts`:同名 library 副本本來就能取代內建版;「保有內建權限」是**額外**的、只給 catalog 驗過的那一份。

## 3. 活換:host 與開著的 frame

按下 Update(`plugins.storeInstall` 加 `direct: true`):下載 → 驗證 → 直接 `MaintainerDesk.installNow` → `registry.noteInstalled(name, source, sha256)` → rescan:
- host:`hostSpecs()` 的 `main`/`fingerprint` 變 → `Plugins.sync` → host 重載這個 plugin,**不重啟 app**。(已知:已在跑的 host part 在 row 追上之前會被 `serverPartAllowed` 擋一下,§18.3 讓 shared host 重啟一次;見 follow-up。)
- row:`PluginHashCache` 重算 `codeHash`、`files.web` → botlingd 寫 row → 視窗收到 → `RowLoader` 換 web part(pinned 的 in-page hash 對不上就改走 frame)。
- 開著的 frame:`plugins.panel` 回來的 `source` 在 `usePluginFrame` 裡是一次性的。新增 `renderer/plugin-stamp.ts`:載入時記 `version|replacesBuiltIn|builtIn`(不含 code hash:更新一定換版本;同版本不同內容只會是 library 裡的 dev 副本,本來就不重載),每個 `plugins.updated` 比對,變了就重取 source、換 frame URL(不用關再開)。底部面板共用 `usePluginFrame`,同樣重載(Terminal 的 host 重載本來就會關掉 shell)。

## 4. grant:這個功能不碰

使用者決定(2026-11-16):安裝按一次(安裝卡)就全部放行,之後更新直接換,不比對權限、不問第二次(plugin 都是開源的)。所以這個功能**完全不讀寫 grant**,也不改 grant 相關程式(`plugin-grant-carry.ts`、`plugin-rows.ts` 的 grant 段原封不動;grant 與 code hash 脫鉤由另一條分支 `bot/v3-plugin-trust` 做)。
- 按 Update(`direct: true`)= 驗證通過(來源 + 完整性)就 `installNow`,沒有安裝卡、沒有權限比較。
- 內建 plugin 的更新版仍是 `builtIn: true`(只要檔案 == catalog 驗過的 sha256),所以 row 的 `author` 仍是 `builtin`;reconcile 對 `author: builtin` 的既有行為(照舊給 grant)不是這個功能寫的。
- 與 `bot/v3-plugin-trust` 合併時的接點:兩邊都不改同一段 grant 程式;此分支只改 `core/plugins/registry.ts`(`revisions`、`builtIn` 判定)、`maintainer.ts`、`plugin-store.ts`、renderer frame 重載。

## 不做 / follow-up

- host 更新順序:先寫 row 再 sync,避免已在跑的 plugin 更新時 shared host 重啟一次(這個「擋一下」來自 grant 綁 hash 的檢查 `serverPartAllowed`;`bot/v3-plugin-trust` 讓 grant 與 hash 脫鉤後會自然消失,合併後再確認)。
- 主動通知(badge 已有:Plugins 分頁 `Updates (n)`)。
- 主題套用(`main.ts` 的 live theme apply)搬進 settings plugin:不小,列 follow-up。
- 更新底部面板的 frame 會丟掉它的畫面狀態(Terminal 的 buffer)。
