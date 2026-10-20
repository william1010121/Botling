import Foundation

/// PLUGINS.md: how to write a ClaudeCodeBot plugin. Written into the plugin library on launch.
enum PluginGuide {
    static func text(builtIns: String) -> String {
        #"""
        # ClaudeCodeBot plugins

        This folder is ClaudeCodeBot's plugin library (a git repo). One folder per plugin. ClaudeCodeBot watches it; whenever a file changes it re-checks and hot-updates.
        The sources of the plugins built into the app are in: \#(builtIns) (read-only; to change one, copy the whole folder here; a plugin with the same name overrides the built-in one).

        ## Folder

        ```
        <name>/
        ├── package.json        npm format + a ccb field (required)
        ├── src/                source (recommended: TypeScript, bundled with esbuild)
        ├── dist/web.js         web part: runs in the chat view (ES module)
        ├── dist/host.mjs       program part: runs in the plugin host (Node) (ES module)
        ├── claude/             Claude part: a standard Claude Code plugin (.claude-plugin/plugin.json, skills/, agents/, .mcp.json)
        ├── components/         components: <component name>/template.html + about.md
        └── test/
        ```

        ## package.json

        ```json
        {
          "name": "ccb-example",
          "displayName": "Example",
          "version": "1.0.0",
          "description": "One sentence on what it does.",
          "engines": { "ccb": "^2.0.0" },
          "ccb": {
            "permissions": ["composer", "messages"],
            "web": "dist/web.js",
            "host": "dist/host.mjs",
            "styles": ["dist/style.css"],
            "claude": "claude",
            "contributes": {
              "commands": [{ "id": "example.run", "title": "Run it", "key": "cmd+shift+e" }],
              "settings": {
                "example.on": { "type": "boolean", "default": true, "title": "On" },
                "example.mode": { "type": "enum", "options": ["a", "b"], "default": "a", "title": "Mode" },
                "example.token": { "type": "string", "title": "API token", "secret": true, "env": "EXAMPLE_TOKEN" }
              },
              "components": "components",
              "panels": [{ "id": "today", "title": "Today", "icon": "calendar" }]
            }
          }
        }
        ```

        - name: lowercase letters, digits, - . _. version: semver.
        - Permissions: composer, messages, network, files, exec, bots (talk to bots, make new ones), claude.
        - Setting types: boolean, enum (needs options), string, number. ClaudeCodeBot generates the controls in Settings.
        - Settings with `secret: true` (passwords, tokens) are stored in the macOS Keychain; the web part cannot read them, the program part can with settings.get;
          those with `env` become environment variables of the bot processes, and MCP servers read them in .mcp.json as `${EXAMPLE_TOKEN}`.
        - panels: panels in the right column (at most 3 icons are shown; the rest go under "More"). icon is an SF Symbol name.
        - All paths are relative to the plugin folder.

        ## Web part (dist/web.js)

        ```ts
        export function activate(ccb) {
          // a returned function is called on deactivation (returning one is optional)
        }
        ```

        `ccb` has:
        - `ccb.composer`: `element`, `view` (CodeMirror 6 EditorView), `getText()`, `insert(text)`,
          `addExtension(ext)` (adds a CodeMirror extension), `showPopover(htmlOrElement)` (a floating box by the cursor),
          `onKeyDown(handler)` (return true to swallow the key). All of these return a dispose function.
        - `ccb.codemirror`: `{ state, view, commands }`; use this one and do not bundle your own CodeMirror (versions must match).
        - `ccb.messages.use(markdownItPlugin)`: adds a markdown-it plugin. `ccb.messages.afterRender((element, message) => …)`: changes the DOM after a message is drawn.
        - `ccb.components.register(name, (root, data, answer) => …)`: a component the bot calls up with `<show name="name">JSON</show>`. `answer(index)`, `answer(text)`, or `answer({ text, images: [{ name, base64 }] })` to send pictures back.
        - `ccb.panels.register(id, (root) => …)`: draws a panel declared in contributes.panels (runs in a separate page in the right column that loads only this plugin).
        - `ccb.commands.register(id, run)`, `ccb.commands.execute(id)`; commands with a key in the manifest get a keyboard shortcut.
        - `ccb.settings.get(key)`, `ccb.settings.onChange(key, fn)`.
        - `ccb.host.call(method, params)`: calls your own program part (which answers with `ccb.web.handle`).
        - `ccb.notify(text)`: adds a line to the main bot's chat.

        The web part must be bundled into a single ES module (esbuild --bundle --format=esm). On errors it is disabled; if an earlier version worked, ClaudeCodeBot keeps using that one.

        ## Program part (dist/host.mjs, Node)

        ```ts
        export function activate(ccb) { … }
        ```

        - `ccb.hooks.beforeSend(m => …)`: before sending; return new text, `{...m, text}`, or `false` to stop it.
        - `ccb.hooks.afterReply(m => …)`: before a bot reply is shown; return new text.
        - `ccb.bots.list()` (Promise), `ccb.bots.send(botId, text)`, `ccb.bots.onReply((bot, reply) => …)`. The main bot's id is "main".
        - `ccb.bots.create({ name, job, avatar? })` (Promise of the bot, with `created: true` the first time): makes a bot of its own (its own row in the left column, memory, inbox and routines.cron, in a folder under ~/.claudecodebot/bots/); `job` is what it is for, in a few sentences. Needs the "bots" permission.
          Calling it again with the same name returns the bot this plugin made (`created: false`; its job is not changed), so it is safe in `activate`. It throws if another plugin or the user already has a bot by that name, or if the user removed this plugin's bot (it is not made again).
          A bot that needs no code of its own does not need a plugin: the main bot or Maintainer makes one with a <new-bot> tag. Example, a morning news bot from a plugin:
          `const bot = await ccb.bots.create({ name: "Morning news", job: "Every morning, collect the top 5 tech news stories and summarize each in one line." }); if (bot.created) await ccb.routines.add(bot.id, "0 8 * * *", "Morning news: Send today's summary");`
          (Add routines only when `created`, so a time the user changed or a job they deleted is not put back.)
        - `ccb.routines.add(botId, "minute hour day month weekday", "Name: what to do")`. Adding exactly the same job again does nothing.
        - `ccb.storage.dir`, `ccb.storage.get(key)`, `ccb.storage.set(key, value)`.
        - `ccb.commands.register(id, run)`, `ccb.web.handle(method, fn)`, `ccb.settings.get/onChange`, `ccb.notify(text)`.
        - console.log goes to stderr and does not disturb ClaudeCodeBot. A plugin that fails 3 times within 10 minutes is disabled.

        ## Claude part (claude/)

        A standard Claude Code plugin. `.claude-plugin/plugin.json` needs name, version, description, author.
        Only after it passes `claude plugin validate --strict` is it given to every bot and temporary team with `--plugin-dir`.
        - skills/<name>/SKILL.md: skills the bots can use.
        - agents/<name>.md: temporary teams (frontmatter: name, title, model, tools, description; the body is its role description).

        ## Components (components/<name>/)

        - template.html: a piece of HTML (may include style and script), drawn on the dark background #1B1B1F. The data is in `window.ccb.data`;
          the user's answer calls `ccb.answer(number or text)`. Do not load outside resources. Check `event.isComposing` before sending on Enter.
          Pictures back: `ccb.answer({ text, images })`, where images come from `await ccb.pickImage({ multiple: true })` (from a click; `[]` if cancelled),
          `await ccb.readImage(file)` for a pasted or dropped File, or data: URLs; each picture has `dataURL` for a thumbnail. The bot receives the text
          and the pictures as files saved in the chat's attachments folder, listed like a message's attachments.
          Pictures shown: data may name local pictures by file path; load them with `img.src = ccb.image(path)` (file: URLs do not load in the frame).
          Codex review: `ccb.reviewWithCodex({ scope, commit, spec })` (from a click) has Codex review the chat bot's repository once, read-only.
          scope: "uncommitted", "lastCommit", "branch" (against main or master, only when on another branch) or "commit"; a `commit` hash implies "commit"
          and must be in the repository. `spec` (optional): a .md/.txt/.html file in the bot's folder or home that Codex checks the change against point by point.
          The report shows in the right column and a line in the chat; a call that does not check out is ignored.
          Data from a command: about.md's `Command: <command>` line fills the component with what it prints (run in the bot's folder after the user
          presses "Allow and run" on the card; JSON output is the data, other output one string; at most 1 MB and 60 seconds).
          Details on demand: when the data would be too big to give at once (every commit's whole diff), keep the Command's output small and add
          `Detail command: git show --patch --stat {hash}` to about.md. `await ccb.runDetail({ hash: "2aed630" })` (from a click) runs it with each
          `{name}` filled in as one quoted argument, in the same folder with the same limits, and resolves to its output (parsed if JSON, else text);
          it rejects with an Error when not allowed yet, a value is missing, extra or not allowed (only letters, digits and `. _ / -`, at most 200,
          no leading `-`), or the command fails. The card's Allow covers both commands; editing the Detail command line asks the user again.
          Board sizes: a pinned component is a card on the bot's Board in square cells (about 150–170px, like home-screen widgets): 1x1 small,
          2x1 wide, 1x2 tall, 2x2 large, 4x2 xlarge. about.md's `Sizes: 1x1, 2x1, 2x2` line lists the sizes it has a layout for (missing: 2x2 only);
          the card's size button offers those. Give each size its own layout: small = the one key number or status, wide = a short row or list,
          tall = a vertical list, large = the full view. `ccb.size` is `{ w, h, name }` (name "small", "wide", "tall", "large" or "xlarge"),
          `<html data-size="2x1">` is there for CSS, and `ccb.onSize((size) => redraw(size))` runs when the user resizes the card (returns a
          function that stops it). In the chat a component is drawn 2x2 (or its largest size).
          On the Board the component is the whole tile, like a home-screen widget: no header, the app's controls (size, ↻, ⋯) float over
          the top-right corner on hover. There `ccb.surface` is "board" and `<html data-surface="board">` is set (in the chat: "chat"), so
          drop your own card frame: no border, no background (transparent, or the tile's), no border-radius, no outer padding beyond about
          12px, and fill the tile, e.g. `html[data-surface="board"] .card { border: 0; background: none; border-radius: 0; padding: 12px; height: 100%; }`.
          A pin opened from its chip above the input box is frameless the same way: `ccb.surface` is "pinned" and `<html data-surface="pinned">`
          is set, the panel gives the corners and background and its controls (↻, ⋯, collapse) float over the top-right corner on hover, but the
          page is as tall as its content (as in the chat). Drop the frame on both with `html:not([data-surface="chat"]) .card { … }`.
        - about.md: usage notes for the bots. The first line says in one sentence what it is, followed by the data format (with an example JSON) and what the bot receives when the user answers.

        ## Check and release

        1. Edit the files, bump version.
        2. Run `ccb plugin check` (Maintainer's instructions have the actual command): checks package.json, runs npm build/test, validates the Claude part, and loads the web part once in an invisible chat view.
        3. `git add <plugin>`, `git commit -m "<plugin>: <what you did>"`, `git tag <plugin>--v<version>`.
        4. ClaudeCodeBot hot-updates; a "Plugin … updated" line appears in the main bot's chat.

        Reverting: right-click the plugin in the plugin list in Settings and choose "Revert to previous version"; ClaudeCodeBot uses git to put that plugin back to its previous version.

        ## Outside plugins

        Install from a git URL, an npm package, or a .zip/.tgz URL: "Add plugin" in Settings, or a bot adds `<install>source</install>` to its reply.
        ClaudeCodeBot fetches and checks it first, then asks the user with a card listing the source, author, license, permissions and MCP servers; only "Install" puts it into the plugin library and commits it.
        Folders the user picked themselves are trusted directly. MCP tools (`mcp__plugin_<name>_<server>`) are automatically allowed for the bots.

        """#
    }
}
