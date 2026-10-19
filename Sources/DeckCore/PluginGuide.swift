import Foundation

/// DECK-PLUGINS.md: how to write a Deck plugin. Written into the plugin library on launch.
enum PluginGuide {
    static func text(builtIns: String) -> String {
        #"""
        # Deck 插件

        這個資料夾是 Deck 的插件庫（git repo）。一個插件一個資料夾。Deck 會監看這裡，檔案一變就重新檢查、熱更新。
        App 內建插件的原始檔在：\#(builtIns)（唯讀；要改就整個複製過來，同名的會蓋過內建的）。

        ## 資料夾

        ```
        <名稱>/
        ├── package.json        npm 格式＋deck 欄位（必要）
        ├── src/                原始碼（建議：TypeScript，用 esbuild 打包）
        ├── dist/web.js         網頁部分：在對話畫面裡跑（ES module）
        ├── dist/host.mjs       程式部分：在插件主機（Node）裡跑（ES module）
        ├── claude/             Claude 部分：標準 Claude Code 插件（.claude-plugin/plugin.json、skills/、agents/、.mcp.json）
        ├── components/         組件：<組件名>/template.html＋about.md
        └── test/
        ```

        ## package.json

        ```json
        {
          "name": "deck-example",
          "displayName": "範例",
          "version": "1.0.0",
          "description": "一句話說它做什麼。",
          "engines": { "deck": "^2.0.0" },
          "deck": {
            "permissions": ["composer", "messages"],
            "web": "dist/web.js",
            "host": "dist/host.mjs",
            "styles": ["dist/style.css"],
            "claude": "claude",
            "contributes": {
              "commands": [{ "id": "example.run", "title": "跑一下", "key": "cmd+shift+e" }],
              "settings": {
                "example.on": { "type": "boolean", "default": true, "title": "開" },
                "example.mode": { "type": "enum", "options": ["a", "b"], "default": "a", "title": "模式" }
              },
              "components": "components"
            }
          }
        }
        ```

        - name：小寫英文、數字、- . _。version：semver。
        - 權限：composer、messages、network、files、exec、bots、claude。
        - 設定型別：boolean、enum（要有 options）、string、number。Deck 會在設定頁自動生出控制項。
        - 路徑都是插件資料夾裡的相對路徑。

        ## 網頁部分（dist/web.js）

        ```ts
        export function activate(deck) {
          // 回傳的函式在停用時呼叫（可以不回傳）
        }
        ```

        `deck` 有：
        - `deck.composer`：`element`、`view`（CodeMirror 6 的 EditorView）、`getText()`、`insert(text)`、
          `addExtension(ext)`（掛 CodeMirror extension）、`showPopover(htmlOrElement)`（游標旁的浮動框）、
          `onKeyDown(handler)`（回傳 true 表示吃掉這個鍵）。以上都回傳 dispose 函式。
        - `deck.codemirror`：`{ state, view, commands }`，用這份，不要自己打包 CodeMirror（版本要一致）。
        - `deck.messages.use(markdownItPlugin)`：加 markdown-it 外掛。`deck.messages.afterRender((element, message) => …)`：訊息畫好後改 DOM。
        - `deck.components.register(name, (root, data, answer) => …)`：bot 用 `<show name="name">JSON</show>` 叫出來的組件。
        - `deck.commands.register(id, run)`、`deck.commands.execute(id)`；manifest 裡有 key 的指令會綁快捷鍵。
        - `deck.settings.get(key)`、`deck.settings.onChange(key, fn)`。
        - `deck.host.call(method, params)`：呼叫自己的程式部分（它用 `deck.web.handle` 回應）。
        - `deck.notify(text)`：在主 bot 對話裡加一行。

        網頁部分要打包成單一 ES module（esbuild --bundle --format=esm）。出錯會被停用；如果之前有能用的版本，Deck 會繼續用那一版。

        ## 程式部分（dist/host.mjs，Node）

        ```ts
        export function activate(deck) { … }
        ```

        - `deck.hooks.beforeSend(m => …)`：送出前，回傳新文字、`{...m, text}`，或 `false` 攔下。
        - `deck.hooks.afterReply(m => …)`：bot 回覆顯示前，回傳新文字。
        - `deck.bots.list()`（Promise）、`deck.bots.send(botId, text)`、`deck.bots.onReply((bot, reply) => …)`。主 bot 的 id 是 "main"。
        - `deck.routines.add(botId, "分 時 日 月 週", "名稱：要做的事")`。
        - `deck.storage.dir`、`deck.storage.get(key)`、`deck.storage.set(key, value)`。
        - `deck.commands.register(id, run)`、`deck.web.handle(method, fn)`、`deck.settings.get/onChange`、`deck.notify(text)`。
        - console.log 會進 stderr，不會干擾 Deck。一個插件 10 分鐘內出錯 3 次會被停用。

        ## Claude 部分（claude/）

        標準 Claude Code 插件。`.claude-plugin/plugin.json` 要有 name、version、description、author。
        過了 `claude plugin validate --strict` 才會用 `--plugin-dir` 交給每個 bot 和臨時團隊。
        - skills/<名稱>/SKILL.md：bot 用得到的技能。
        - agents/<名稱>.md：臨時團隊（frontmatter：name、title、model、tools、description；內文是它的角色說明）。

        ## 組件（components/<名稱>/）

        - template.html：一段 HTML（可以有 style 和 script），畫在深色背景 #1B1B1F 上。資料在 `window.deck.data`；
          使用者回答呼叫 `deck.answer(數字或文字)`。不要載入外部資源。按 Enter 送出前檢查 `event.isComposing`。
        - about.md：給 bot 看的用法。第一行一句話說這是什麼，接著是資料格式（附範例 JSON）和回答時 bot 會收到什麼。

        ## 檢查和上線

        1. 改檔，升 version。
        2. 跑 `deck plugin check`（Deck 維護的說明裡有實際指令）：檢查 package.json、跑 npm build／test、驗 Claude 部分、在看不見的對話畫面裡載入一次網頁部分。
        3. `git add <插件>`、`git commit -m "<插件>: <做了什麼>"`、`git tag <插件>--v<版本>`。
        4. Deck 熱更新；主 bot 對話裡會出現「插件更新了」。

        退回：設定頁的插件列表右鍵「退回上一版」，Deck 會用 git 把那個插件放回上一個版本。

        """#
    }
}
