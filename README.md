# Deck（指揮台，暫名）

PRD: `../prd/PRD.md` · Design: https://claude.ai/artifact/2kmnVNyueZX2yMxH4gNqyX

P7 (v2): external plugins. Settings → 插件 → 加插件 takes a git URL, npm name or .zip/.tgz URL
(or a folder you pick, trusted as is); bots can ask with `<install>來源</install>`. Deck fetches
and checks it, then shows a card (source, author, license, permissions, MCP servers) and installs
only after 「安裝」 (committed to the library). Plugin MCP tools are allowed for every bot;
`secret` settings live in the keychain and reach bots as environment variables (`env`).
`contributes.panels` + `deck.panels.register` add pages to the right column. Subprocess work
runs on GCD threads, never on Swift's cooperative pool.

P6 (v2): plugins from your own projects. Deck 維護 asks before reading a folder outside the
plugin library (`<need-folder>`): a question in the main chat, remembered in
`~/.deck/folders.json`; once allowed it restarts with read access and carries on. Live
acceptance: 「把 laas-copy 做成 Deck 插件」 → Deck 維護 made `deck-laas` (GPL, kept as its own
plugin), checked, committed and tagged it; typing `;a` in the input box gives `\alpha`.

P5 (v2): Deck 維護. The plugin library (`~/.deck/plugins`) is a git repo, and 「Deck 維護」 is a
built-in project whose folder is that library (its row in the left column shows up only while
it is awake, working, or has news). Reports beside a component, `<component>` and `<plugin>`
tags, and hot-reload failures go to its inbox. It edits, bumps the version, runs
`Deck --check-plugin`, commits and tags `<name>--v<version>`; small template edits can go to the
`deck-core:component-editor` agent (Haiku). The v1 component team is gone. Hot reload keeps
the last version that worked when a new one breaks (or its package.json stops parsing) and
hands the error to Deck 維護. Settings → 插件: right-click for 退回上一版 / 移除 (both as git
commits). `DECK-PLUGINS.md` in the library documents the plugin API.

P4 (v2): Claude parts. A plugin's `deck.claude` folder is a standard Claude Code plugin
(skills, agents, MCP). Once it passes `claude plugin validate --strict` (re-run whenever its
files change), every bot and temporary team starts with `--plugin-dir` for it. Temporary teams
are now the agents in plugins' `claude/agents/*.md`; the defaults live in the `deck-teams`
plugin (`~/.deck/teams` moves there; the old folder is kept as `teams.v1-backup`). When Claude
parts change, awake bots hand over and restart once free (「交接 → 載入新插件」); sleeping bots
get them on their next wake.

P3 (v2): the plugin host. Plugins with a program part (`deck.host`, an ES module exporting
`activate(deck)`) run in one Node process (`Web/host/` → `Resources/host/host.mjs`), started
only when such a plugin is on. Deck and the host speak JSON-RPC, one message per line on
stdin/stdout. A program part can hook `beforeSend` (change or stop what you send) and
`afterReply`, list and message bots, listen to replies, add routines (crontab lines in a bot's
routines.cron), keep data (`~/.deck/plugin-data/<name>/`), register commands, answer its web
part's `host.call`, and post a line in the main bot's chat. If the host dies it is back within a
second; a plugin that fails to load is turned off, and one that throws or crashes the host 3
times in 10 minutes is turned off too. Without Node, program parts are off and Settings says so.

P2 (v2): plugins for Deck itself. A plugin is a folder with an npm `package.json` plus a `deck`
field (`web`, `styles`, `permissions`, `contributes.commands/settings/components`), in
`~/.deck/plugins/<name>/` or shipped in the app (`Web/plugins/` → `Resources/plugins/`; a library
plugin of the same name replaces a shipped one). A web part exports `activate(deck)` and can add
markdown-it plugins, change drawn messages, register components and commands, and hook the input
box (keys, CodeMirror extensions, a popover at the caret). One that throws is turned off and
reported in the main bot's chat until its files change. Edits reload live. LaTeX is now the
built-in `deck-latex` plugin; the component library is the `deck-components` plugin
(`~/.deck/components` moves into it). Settings → 插件 turns plugins on/off and shows their
settings. `Deck --check-plugin <folder>` checks the manifest, runs npm build/test, validates a
Claude part, and loads the web part once offscreen.

P1 (v2): the chat is a web page. Messages and the input box are drawn by `Web/` (TypeScript:
markdown-it, KaTeX, CodeMirror 6) inside a WKWebView; the Swift side sends the chat as JSON
(`ChatPayload`) and handles what the page sends back (send, choose, reply, files, component
reports). LaTeX: `$…$`, `$$…$$`, `\(…\)`, `\[…\]` in bot replies and your own messages, with
Pandoc's rule so `$5 和 $10` stays text. The built page is committed in
`Sources/Deck/Resources/web`, so `swift build` needs no npm.

```bash
cd Web && npm install && npm run build   # rebuild the page after editing Web/src
cd Web && npm test                       # web tests (vitest + jsdom)
```

Chat: bot replies render markdown (headings, lists, tables, code, quotes); `![說明](file://…)`
shows an image or plays a video (mp4, mov) inline, click an image to see it large. Attach images
or files with 「+」, drag-and-drop, or paste (screenshots too); they are copied into the bot's own
`attachments/` folder and images go to Claude directly. Hover a line (or right-click) to reply to
it; the reply shows the quote and the bot gets it too. The component team's row in the left
column opens its page: each request, what it is doing right now, and what it said.

M6: components. Parts of the chat are HTML templates in `~/.deck/components/<name>/` (since P2: `~/.deck/plugins/deck-components/components/<name>/`)
(`template.html` + `about.md`), drawn in a small web view; 「choices」 ships built in. Hover a
component for its report button: say what to change and the component team (Haiku) edits the
template; Deck reloads it without a restart, marks it 「已更新」, and keeps the previous version
(`template.prev.html`) for 「退回上一版」. Bots can ask too with `<component name="x">…</component>`,
and draw any component with `<show name="x">{json}</show>`. A template answers through one call,
`deck.answer(index)` for an option or `deck.answer("text")` for the user's own words; Deck closes
the question either way, so most changes need only the template. Every bot gets each
component's whole `about.md` when it wakes, and awake bots get the new usage with their next
message when a component changes. While a change is in progress the
left column shows a temporary 「組件」 row.

M5: temporary teams. For a wish that belongs to no project, the main bot ends its reply with
`<team name="research">task</team>`; Deck starts that team in `~/.deck/runs/<time>-<name>/`,
and its one reply (a result page) comes back to the main bot's chat. Teams are markdown files in
`~/.deck/teams/` (research and prototype to start); edit them freely. Result pages open in the
widened right column.

M4: routines. Each bot keeps its jobs in a crontab-format file it edits itself
(`~/.deck/main/routines.cron`, `<project>/.bot/routines.cron`): one job per line,
`分 時 日 月 週 名稱：要做的事`, where the task is a one-line prompt or `@file` to follow; a leading
`#` pauses it. Ask a bot in chat to add, remove, pause or re-time one; the settings sub-page edits
the same file (switch, time for daily jobs, 「加一個」, right-click to delete). The main bot starts
with 「每日摘要」 at 08:15, written from managers' memory.md without waking them. Deck checks every
30 s; a time missed while the Mac slept or Deck was closed runs once later that day, and a job
first seen after its time starts the next day. When each job last ran stays in Deck's settings.

M3: reporting. A bot that needs a decision ends its reply with a `<choices>` block
(`* recommended | cost`, `- other | cost`); Deck draws buttons and sends the picked label back
as the user's answer. A manager's question, and its result for work the main bot handed over,
also appear as a notice in the main bot's chat (without waking the main bot); picking there
answers the manager, and both chats show the pick. Open questions feed 「等你」 and the Dock badge.

M2: one manager per project folder. 「加專案」 picks a folder; its manager works there and keeps
its notes in `<project>/.bot/` (memory.md, inbox.md, and a `.gitignore` of `*`). Managers may
use Read/Write/Edit/Glob/Grep/Bash in their folder. The main bot answers status questions from
managers' memory.md without waking them, and hands work over by appending to their inbox.md,
which Deck relays and which wakes the manager. 「等你」 in the right column comes from each
manager's 「等你決定的事」 section.

M1: the main bot. It wakes on a message into a fresh `claude` session that reads
`~/.deck/main/memory.md`, and after 50 idle minutes writes memory.md and exits (its face
closes its eyes). Switching model in the right column's settings writes a handoff, stops,
and restarts on the new model.

```bash
swift run Deck                                   # the app
.build/debug/Deck --check-plugin <folder>        # deck plugin check
DECK_IDLE_SECONDS=30 swift run Deck              # nap after 30 s instead of 50 min
swift test                                       # unit tests (fake claude)
DECK_LIVE=1 swift test --filter Live             # real claude, ~6 min
DECK_SNAPSHOT=/tmp/deck.png swift run Deck       # render a PNG of the UI and quit
```
