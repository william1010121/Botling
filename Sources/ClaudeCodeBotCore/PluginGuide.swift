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
          the user's answer calls `ccb.answer(number or text)` (once: it locks the card; for state that changes, see `ccb.save` below). Do not load outside resources. Check `event.isComposing` before sending on Enter.
          Pictures back: `ccb.answer({ text, images })`, where images come from `await ccb.pickImage({ multiple: true })` (from a click; `[]` if cancelled),
          `await ccb.readImage(file)` for a pasted or dropped File, or data: URLs; each picture has `dataURL` for a thumbnail. The bot receives the text
          and the pictures as files saved in the chat's attachments folder, listed like a message's attachments.
          Pictures shown: data may name local pictures by file path; load them with `img.src = ccb.image(path)` (file: URLs do not load in the frame).
          Codex review: `ccb.reviewWithCodex({ scope, commit, spec })` (from a click) has Codex review the chat bot's repository once, read-only.
          scope: "uncommitted", "lastCommit", "branch" (against main or master, only when on another branch) or "commit"; a `commit` hash implies "commit"
          and must be in the repository. `spec` (optional): a .md/.txt/.html file in the bot's folder or home that Codex checks the change against point by point.
          The report shows in the right column and a line in the chat; a call that does not check out is ignored.
          Data from a command: about.md's `Command: <command>` line fills the component with what it prints (run in the bot's folder after the user
          presses "Allow and run" on the card; JSON output is the data, other output one string; at most 1 MB and 60 seconds). It is optional,
          only for live data that changes: most components draw the data a bot gives them with `<show>`, and one made from a bot's reply shows that reply.
          Details on demand: when the data would be too big to give at once (every commit's whole diff), keep the Command's output small and add
          `Detail command: git show --patch --stat {hash}` to about.md. `await ccb.runDetail({ hash: "2aed630" })` (from a click) runs it with each
          `{name}` filled in as one quoted argument, in the same folder with the same limits, and resolves to its output (parsed if JSON, else text);
          it rejects with an Error when not allowed yet, a value is missing, extra or not allowed (only letters, digits and `. _ / -`, at most 200,
          no leading `-`), or the command fails. The card's Allow covers both commands; editing the Detail command line asks the user again.
          Refreshing by itself: about.md's `Refresh: every 2s` line (or a bot's `<show name="x" refresh="2s">`, which wins) makes a card
          whose data comes from a command run it again every 2 seconds (at least 1s, at most 1h; "5s", "1.5s", "1m" and "500ms" read too),
          but only while the card is on screen: it pauses while scrolled away or while the window is hidden, and waits for each run to end.
          A pin can also be set to refresh every few seconds (its refresh menu), which runs whether or not it is on screen.
          Live data: each run normally draws the frame anew; `ccb.onData((data) => redraw(data))` instead keeps the frame (its scroll,
          what is open, a chart's animation) and calls you with each new data, also set as `ccb.data` (returns a function that stops it).
          Use it for anything that refreshes: a "test progress + CPU" card is a Command printing JSON such as
          `{"passed":120,"failed":2,"total":300,"cpu":37}`, a `Refresh: every 2s` line, and a template that draws once and updates in `onData`;
          the bot can also keep a card up to date itself with `<show name="build" id="build">` (below).
          Board sizes: a pinned component is a card on the bot's Board in square cells (about 150–170px, like home-screen widgets). The user
          drags its bottom-right corner (or picks in its size menu) to any size from 1x1 to 4x4 cells, and can drag an opened pin's panel taller.
          So write ONE responsive layout that adapts to any width and height, like a responsive web page, not a layout per size: CSS grid with
          auto-fill columns (`repeat(auto-fill, minmax(140px, 1fr))`), container queries (`#ccb-root` is a size container on the Board, an
          inline-size one elsewhere: `@container (max-height: 200px) { … }`), collapse to a summary when short and to the key number when tiny.
          `ccb.size` is `{ w, h, name, px: { width, height } }` (w and h in cells, name the nearest of "small", "wide", "tall", "large" or
          "xlarge", px the frame's real size in pixels), `<html data-size="2x1">` is there for CSS, and `ccb.onSize((size) => redraw(size))`
          runs on every resize, while dragging too (returns a function that stops it), for what CSS cannot do. about.md's `Sizes: 2x2` line is
          optional: only a hint for the size a new pin starts at (missing: 2x2); any size can still be picked.
          On the Board the component is the whole tile, like a home-screen widget: no header, the app's controls (size, ↻, ⋯) float over
          the top-right corner on hover. There `ccb.surface` is "board" and `<html data-surface="board">` is set, so
          drop your own card frame: no border, no background (transparent, or the tile's), no border-radius, no outer padding beyond about
          12px, and fill the tile.
          In the chat a component is drawn at its widest size (the widest in `Sizes:`, so 4x2 when listed; 2x2 without the line) across the
          whole width of the reply, edge to edge, with its report flag floating over its bottom-right corner on hover. There `ccb.surface`
          is "chat" and `<html data-surface="chat">` is set; the reply's bubble (or, under a reply, a tile like the Board's) is its frame,
          so draw no card frame there either (same rules), only let it be as tall as its content.
          A pin opened from its chip above the input box is frameless the same way: `ccb.surface` is "pinned" and `<html data-surface="pinned">`
          is set, the panel gives the corners and background and its controls (↻, ⋯, collapse) show just above the panel on hover, so nothing
          covers the component (Report is in that ⋯ menu), but the page is as tall as its content (as in the chat) until the user drags the panel's top edge to a height of their own, when
          it fills that height as on the Board.
          So a component never draws a card frame of its own, and one rule covers every surface:
          `.card { border: 0; background: none; border-radius: 0; padding: 12px; box-sizing: border-box; }` with
          `html[data-surface="board"] .card { height: 100%; }` to fill a Board tile.
          Pin chip: a pinned component also shows as a small chip above the input box, an icon with a short status (its name in the tooltip).
          about.md's `Icon: chart.pie.fill` (an SF Symbol name) or `Icon: 📊` (one emoji) gives the icon (missing: a generic one).
          `ccb.setStatus({ text: "3 new", tone: "good" })` sets the status: a short value (about 14 characters show) and a tone, "good", "warning",
          "bad" or "neutral" (a coloured dot on the icon unless neutral); text alone is fine, `ccb.setStatus(null)` clears it. Without it the chip
          shows the start of a summary of the data. Only a pinned copy (opened from its chip, or its Board tile) sets the chip, which keeps the last status.
          State of its own: `await ccb.save(data)` keeps `data` (anything JSON can hold but null, at most 256 KB as JSON) as this
          component's data from now on, so a todo list's ticks and new items stay. It is kept where the component is drawn from: in
          the chat message (the bot's folder's chat.json, that message's `displays[i].data`) or on its pin (pins.json, the pin's
          `data`; a pin starts as a copy of the message's data and keeps its own from then on), so it draws with it again, also
          after a restart. `ccb.data` becomes the saved data and the frame is not reloaded for it (keep your own DOM up to date,
          then save). Saving does not answer: the card is not locked, the bot is not woken, and nothing shows in the chat; the bot
          gets every component's latest saved data with the user's next message, and can read it from chat.json/pins.json.
          It rejects with an Error when the data cannot be kept, or where nothing is kept: a card whose data comes from a command
          (its `Command:` line, or a `<show command=…>`) shows what the command prints, so it does not save; nor do previews.
          Save after each change (a tick, an added item); a `<show>` of the component in a new reply starts from the data the bot gives it.
          `await ccb.load()` resolves to the data kept last (the same as `ccb.data`, which is already the saved data when the frame starts).
          Updating a card: a bot's `<show name="build" id="build">JSON</show>` names its card; a later `<show>` with the same id (in any later
          reply in that chat) replaces that card's component and data where it is, instead of drawing a new card (a reply with nothing else
          in it adds no message). The bot's new data replaces what the user saved on it.
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
