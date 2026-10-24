<div align="center">

<img src="docs/images/icon.png" width="128" height="128" alt="Botling icon">

# Botling

Formerly ClaudeCodeBot (the repository moved from `william1010121/ClaudeCodeBot`; old links redirect). Releases up to 1.15.1 still ship as `ClaudeCodeBot.app`; existing data stays in `~/.claudecodebot`. See [naming and compatibility](docs/botling-rename.md).

**A team of Claude Code and Codex agents on your Mac, in one chat.**

Give a bot two heads, Claude and Codex, that split the work and hand it to each other. Send real
work to background subagents and Codex workers running in parallel, see the results as live
components you can pin, and change the app itself with plugins. All local, on the `claude` and
`codex` CLIs you already have.

[![Latest release](https://img.shields.io/github/v/release/william1010121/Botling?label=release&color=4c8bf5)](https://github.com/william1010121/Botling/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/william1010121/Botling/total?color=4c8bf5)](https://github.com/william1010121/Botling/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/william1010121/Botling/ci.yml?branch=main&label=CI)](https://github.com/william1010121/Botling/actions/workflows/ci.yml)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)
<br>
[![macOS 14+](https://img.shields.io/badge/macOS-14%2B-black?logo=apple&logoColor=white)](#requirements)
[![Swift 6.2](https://img.shields.io/badge/Swift-6.2-F05138?logo=swift&logoColor=white)](Package.swift)
[![Built with Claude Code](https://img.shields.io/badge/Built%20with-Claude%20Code-D97757?logo=claude&logoColor=white)](https://docs.claude.com/en/docs/claude-code)

[**Download**](https://github.com/william1010121/Botling/releases/latest) ·
[Quick start](#quick-start) ·
[Features](#features) ·
[Plugins](#plugins--components) ·
[Changelog](CHANGELOG.md)

<br>

<img src="docs/images/hero.png" alt="Botling: the left column with the main bot and a project; the main bot's chat with math, a table, a result page preview and a decision; the project's right panel" width="900">

</div>

## Why

- **Two heads, one chat.** A bot can run on Claude, on Codex, or on both at once; the heads
  decide who does what and hand work and reviews to each other.
- **A team that works while you talk.** Real work goes to background subagents and app-managed
  Codex workers running in parallel, so the bot is never too busy to answer you.
- **"Done" can be checked.** Turn on completion verification and, after a reply, a separate
  judge model checks whether the work it promised was actually finished, and sends the bot back
  to work when it was not.
- **Catch up at a glance.** Unread replies fold into a short summary when you come back, and any
  stretch between your messages can be summarized, each point linked to the messages it came from.
- **Answers you can see.** Charts and cards drawn right in the chat, one click from becoming a
  pinned chip or a Board tile.
- **An app that changes itself.** Plugins hot-reload, and in developer mode the bot works on
  Botling's own source.
- **Nothing leaves your Mac but the models.** It drives the `claude` and `codex` CLIs you
  already have; chats and memory are plain markdown files.
- **In your language.** The app speaks English, 繁體中文, 简体中文, 日本語 and 한국어, and bots
  reply in the language you pick.

## Features

<table>
<tr>
<td width="50%" valign="top">

### 1. A background subagent team

Real work (building, fixing, researching) is handed to subagents that run in the background and
in parallel, so the bot stays free to talk to you. Subagents that change code work in a git
worktree of their own and merge when their tests pass. The right panel shows each one running,
then settled, and a dropped network does not lose them: they carry on where they stopped.

On Codex, the bot hands tasks to **app-managed workers**: independent Codex sessions the app
tracks. The conversation finishes its turn right after handing off, worker cards keep their
progress and follow-ups, and the app wakes the conversation to report each result. Each
subagent row shows which head started it and its model; Settings → **Engines and subagents**
sets the Claude subagent model and the Codex workers' model, effort and Fast mode (or follows
`~/.codex/config.toml`).

The chat's latest message carries one row for **all background work**: subagents, background
commands, Monitors that watch for events, and scheduled wake-ups or cron jobs (with when they
fire). Press an icon to see the list and each task's last lines of output.

</td>
<td width="50%" valign="top">

<img src="docs/images/right-panel.png" alt="The right panel: what the bot is doing now, its results and the subagents it settled">

</td>
</tr>
<tr>
<td valign="top">

<img src="docs/images/component.png" alt="A test-summary component under a bot's reply, drawn from a CLI command">

</td>
<td valign="top">

### 2. Components, pins and a Board in the chat

Bots draw small HTML components (charts, cards, test summaries) inside their replies, fed by
their own data or a CLI command (`<show name="…" command="git diff --stat">`). Cards can be
**live** (`Refresh: every 2s`), updated in place by id, and keep their own state
(`ccb.save(data)`, so a todo list's ticks survive a restart).

Pin one above the input box as a status chip, **float** it in a corner over every chat to watch
a build, or lay pins out on a per-bot **Board**: a widget grid where each tile keeps its own
cell, and a drop swaps or pushes tiles down instead of reshuffling everything.

</td>
</tr>
<tr>
<td valign="top">

### 3. One click turns a reply into a component

Press **Make into component** on any reply (or the suggestion chip a bot adds when it sees
something you will ask for again). The bot that wrote the reply writes a brief, and the
Maintainer builds the first version from it, reusing a library component when one already does
the job. The spec panel beside the chat shows the fields, a test run, and each change as it
happens.

</td>
<td valign="top">

<img src="docs/images/make-component.png" alt="A test-run reply made into a component: the test-summary card under the reply, and its spec beside it, added to Main bot">

</td>
</tr>
<tr>
<td valign="top">

<img src="docs/images/design.png" alt="A /design request answered with a link to a Claude Design with three directions to pick from">

</td>
<td valign="top">

### 4. `/design` gives you a Claude Design to pick from

Say `/design` (or ask for designs to choose from) and the bot makes a
[Claude Design](https://claude.ai) and replies with its shareable claude.ai link. Pick one and
the Maintainer builds that one into the app.

</td>
</tr>
<tr>
<td valign="top">

### 5. Plugins and developer mode: change the app itself

Plugins change the app VS Code style (the input box, how messages are drawn, panels, hooks,
skills and MCP servers) and **hot-reload** when their files change, keeping the last good version
if a new one breaks. Ask the Maintainer to write one for you. Turn on **developer mode** and the
bot works on Botling's own source: builds, installs (with rollback) and fixes what you
mark "Not right"; send the change back upstream as a [pull request](CONTRIBUTING.md).

</td>
<td valign="top">

<img src="docs/flowcharts/flow-5-plugins.png" alt="How plugins flow: the Maintainer edits the plugin library, the app hot-reloads it and hands it to every bot">

</td>
</tr>
<tr>
<td valign="top">

<img src="docs/images/local-doctor.png" alt="Settings, Doctor: the Claude Code and Codex CLIs found on this Mac, their versions and how each is signed in">

</td>
<td valign="top">

### 6. Everything stays on your Mac

Botling drives the `claude` CLI already signed in on your Mac: no server, no account of
its own. Chats, memory, routines and the plugin library are plain markdown and text files in
`~/.claudecodebot`; each project's notes live in its git-ignored `.bot/` folder. **Doctor**
shows which `claude` (and `codex`) the bots use and how each is signed in.

</td>
</tr>
</table>

### Claude and Codex in one bot

- **Pick an engine per bot.** A bot's settings have an Engine row: Claude (`claude` stream-json)
  or Codex (`codex app-server`), each with its own model menu. Both read and write the same
  `memory.md`, so switching engines keeps what the bot knows.
- **Or turn on both heads.** Every message goes to both; one head reads it first and says what
  it takes on, then both work side by side in the same folder and hear each other mid-turn.
  **Answer with** in the input box's toolbar picks Both, Claude or Codex for a message
  (⌥1 ⌥2 ⌥3, or start it with `@both`, `@claude` or `@codex`), and the choice is saved per bot.
- **Hand-offs.** A head can hand the other a task, a review or a question with
  `<handoff to="codex" kind="…">`; the reply goes back to the head that asked. Each of your
  messages allows at most 6 hand-offs (2 reviews, 3 discussion rounds; adjustable), and each one
  leaves a divider in the chat.
- **Completion verification** (off by default). When a reply ends, a read-only `codex exec`
  judge looks at it and decides whether the authorized work is done, waiting on you or on a
  dependency, or should continue; a bot that stopped early is sent back to finish. The verdict
  sits under the reply as a small disclosure. Settings → Engines and subagents → Completion
  verification turns it on and picks the judge model.
- **Characters.** In the Cute look (the default), Claude and Codex are drawn as small animated
  characters that blink, type while working and wave when done; Settings → General sets the
  chat avatar size (32–96 px) or switches back to the Original look. Under each message, small
  heads show who it went to and who has read it, and both you and the heads can add **emoji
  reactions**.

### Also

- **A main bot and one manager per project.** The main bot answers "how is X going?" from each
  manager's `memory.md`, hands work over through project inboxes, and calls up a temporary
  research or prototype team for anything else. Make bots of your own too.
- **Bots that sleep.** Each bot is a long-lived `claude` process that naps after 50 idle minutes,
  writing down what matters first, and wakes when you or a routine need it.
- **Decisions as buttons**, with a recommended option and what each one costs; tool permission
  asks (Allow once / Always / Don't allow) in the chat, with Claude Code's auto mode on by default.
- **Results as claude.ai Artifacts.** Reports, comparisons and previews are published as a
  private claude.ai Artifact and linked in the reply as a card; anything sensitive stays a local
  HTML page. Settings → Permissions → Reports and results picks the rule. Codex has no Artifact
  tool, so a Codex head keeps results as local pages or hands publishing to Claude.
- **Web bots: Gemini, ChatGPT, Claude and Grok.** The left column's **Web** section opens each
  site in the chat column with its own sign-in (several Google accounts for Gemini). When an
  answer finishes, the app reads the conversation as Markdown into `~/.claudecodebot/web/`, so
  the main bot can search it. LaTeX snippets and live math preview (web-laas) work in their
  input boxes, and **Capture** records a page's traffic so the Maintainer can fix a page reader.
- **A general Browser.** The globe in the folded left column browses any website, with pinned
  sites and separate accounts. **Capture** a page to ask the Maintainer for a website tool,
  which plugins then offer as a button for that site.
- **Catch-up and interval summaries.** Come back to more than 3 unread bot replies and they fold
  into a Catch-up card with a 1–5 bullet summary of what finished, what is running and what
  waits for you; the card opens to every original message. A **Summarize** chip under the last
  reply of each stretch between your messages does the same on demand, or automatically when
  you send your next message (off by default). Each point links its sources, opened in a
  read-only view of the conversation. The summaries are written by a read-only `codex exec`
  outside the chat; Settings → General → Chat summaries sets thresholds, model and prompt.
- **A rich chat**: Markdown, LaTeX, tables, images, videos, attachments, replies, group chats,
  result pages as preview cards, and an input box that works with CJK input methods.
- **Call in any bot with `@name`.** It answers in your chat and keeps the work, with its steps,
  in its own chat too.
- **Drafts that stay.** What you typed but did not send stays in each bot's input box across
  switches and restarts.
- **Five languages.** Settings → General → Language: English, 繁體中文, 简体中文, 日本語 or 한국어
  (or follow the Mac), switched at once without a restart. Bots reply in it too; what bots write
  and your own data are never translated.
- **Routines**: one-time or daily jobs in the Routines panel, and the crontab-style
  `routines.cron` per bot, which bots edit when you ask; Codex heads schedule through the app's
  own `app_routines` tool.
- **Report a problem** from any card's ⋯ menu: it goes to the Maintainer with a screenshot of
  the card.
- **Usage at a glance**: today's tokens per bot, the Claude and Codex 5-hour and weekly limits,
  a daily budget, per-bot model and effort, and **Doctor** to check your Claude Code and Codex
  installs. Settings look like macOS System Settings, with a searchable sidebar.
- **Panels that fold**: the left column into a strip of faces, the right panel into icons. Pin
  bots and web conversations to keep them on top.

## Install

1. Download the latest `botling-<version>-macOS.zip` from
   [**Releases**](https://github.com/william1010121/Botling/releases/latest).
2. Unzip it and drag **Botling.app** to `/Applications`.
3. The app is ad-hoc signed, not notarized. The first time, right-click it → **Open** → **Open**.

The build is universal (Apple silicon and Intel). What the changelog lists under **Unreleased**
is on `main` but not in a release yet; build from source to try it.

### Requirements

| | Version | |
|---|---|---|
| macOS | 14 Sonoma or later | required |
| [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI | **2.1.111** or later, signed in | required: every bot is a `claude` process |
| [Codex](https://github.com/openai/codex) CLI | **0.99.0** or later, signed in | recommended: Codex heads and workers, the completion verification judge and chat summaries |
| Node.js | any current LTS | recommended: plugins with a program part |
| git | | recommended: the plugin library's history |

**Settings → Doctor** checks both CLIs the way bots find them: version against the minimum, how
each is signed in (no tokens spent), and the latest release on npm, with a one-line fix to copy
when something is off.

## Quick start

1. Open Botling. If the gear at the bottom of the left column has a red dot, open
   **Settings → Doctor** and fix what it lists (usually `claude auth login`).
2. Say hello to the **Main bot**: "What can you do?"
3. Click **Add project** and pick a folder, or ask the main bot: "Add `~/code/my-app` as a project."
4. Ask for work: "In my-app, fix the failing tests." The main bot hands it to that project's
   manager, which reports back in its own chat (an unread count shows in the left column).
5. To add Codex, open a bot's settings (right of its chat) and turn on **Engines in this bot**:
   Claude, Codex or both. Then pick who answers with **Answer with** in the input box.
6. Make a group with **+** next to Chats, or a bot of your own with **New bot**.

Your data lives in `~/.claudecodebot` (chats, memory files, routines, the plugin library). Each
project's own notes live in `<project>/.bot/`, which is git-ignored.

## How it works

![Architecture](docs/flowcharts/flow-7-architecture-v2.png)

- **The shell** is SwiftUI: the left column lists the main bot, your groups, projects and bots;
  the right column shows what is going on, what waits for you, results and settings.
- **The chat** in the middle is a web page (TypeScript, markdown-it, KaTeX, CodeMirror 6) in a
  `WKWebView`, which is also where plugins' web parts run.
- **Each head** is one long-lived process: Claude runs as
  `claude -p --input-format stream-json --output-format stream-json`, Codex as
  `codex app-server`. A two-headed bot runs both side by side. Bots talk back through a few tags
  in their replies (`<choices>`, `<team>`, `<show>`, `<component>`, `<plugin>`, `<install>`,
  `<handoff>`), which the app turns into buttons, teams, hand-offs and requests.
- **The app keeps the books**: it tracks subagents, Codex workers, background commands and
  hand-off budgets itself, and runs the completion verification judge after each reply.
- **Memory** is plain markdown: `memory.md` with four sections, an `inbox.md` per project, and
  `routines.cron`. Bots stay inside the one-hour prompt-cache window while awake and write their
  memory before they sleep.

More detail: [docs/PRD.md](docs/PRD.md) (the app) and [docs/PRD-v2.md](docs/PRD-v2.md) (plugins).

## Plugins & components

Plugins change the app itself, VS Code style. A plugin is a folder in
`~/.claudecodebot/plugins/` with an npm `package.json` whose `ccb` field declares up to three parts:

- a **web part** that changes the input box, how messages are drawn, components and right-column panels;
- a **program part** in a Node plugin host (hooks such as `beforeSend`, commands, routines, storage);
- a **Claude part** (skills, agents, MCP servers) handed to every bot with `--plugin-dir`.

```json
{
  "name": "ccb-example",
  "version": "1.0.0",
  "engines": { "ccb": "^2.0.0" },
  "ccb": {
    "permissions": ["composer"],
    "web": "dist/web.js",
    "contributes": {
      "commands": [{ "id": "example.run", "title": "Run it", "key": "cmd+shift+e" }]
    }
  }
}
```

```js
// dist/web.js (an ES module)
export function activate(ccb) {
  ccb.composer.onKeyDown((event) => { /* … */ });
  ccb.messages.use((md) => { /* a markdown-it plugin */ });
  ccb.commands.register("example.run", () => ccb.notify("Hello from a plugin"));
}
```

The full API (web part, program part, Claude part, components, panels, settings and secrets) is
in the `PLUGINS.md` the app writes into the plugin library on launch. Check a plugin with:

```bash
/Applications/Botling.app/Contents/MacOS/botling --check-plugin path/to/plugin
```

Or ask the Maintainer to write it for you; it can also turn one of your own projects into a
plugin, asking before it reads the folder. **External plugins** from git, npm or a zip are
installed only after you approve a card listing their source, license, permissions and MCP
servers. Secrets go to the macOS keychain.

## Developer mode & contributing

Botling can work on itself. Turn on **Settings → Developer mode** (off by default) and pick
the project that is your Botling checkout. Its manager may then install a new build of the
app after you confirm (a build that does not come up within 90 seconds is rolled back), look at
the app's window, and receives the replies you mark "Not right" in any chat.

In that project's chat, **`/share`** checks a feature branch you built (up to date, no keys,
tokens or home-folder paths, a fork as origin) and opens a pull request labelled
`community-feature`. **Settings → Release planner** lists those pull requests, most 👍 first:
the 👍 button votes, and the repository's owner picks the next version's features and hands
them to the developer project's manager to merge.

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for the PR flow, and
[SECURITY.md](SECURITY.md) to report a vulnerability.

## Build from source

Swift 6.2 (Xcode 26) is needed. The web chat is prebuilt and committed in
`Sources/ClaudeCodeBot/Resources`, so `swift build` does not need npm.

```bash
git clone https://github.com/william1010121/Botling.git botling
cd botling
swift run botling          # build and run a debug build
scripts/make-app.sh              # or build dist/Botling.app and its zip (version from VERSION)
SINGLE_ARCH=1 scripts/make-app.sh   # faster: this Mac's architecture only
```

Working on the chat surface, plugins or tests:

```bash
cd Web && npm ci && npm test && npm run build        # chat surface, built-in plugins, plugin host
scripts/test-fast.sh                                 # app tests, split over several serial processes (~15 s)
scripts/test-fast.sh Conductor --skip Live           # only test ids matching a regex
scripts/test-all.sh                                  # reference run: full build, all tests in one serial process, as CI
CCB_LIVE=1 swift test --filter Live                  # acceptance tests with the real claude (costs tokens)
CCB_SNAPSHOT=/tmp/chat.png swift run botling   # render a sample chat to a PNG and quit
```

The app tests use a fake claude. `scripts/test-fast.sh` rebuilds only the test bundle (and the
app when `Sources/ClaudeCodeBot` changed), then runs every test in shards that each run serially,
spread by last run's timings (`.build/test-timings.json`, logs in `.build/test-shards/`). The
tests share the main actor, so one process running them in parallel (`swift test` without
`--no-parallel`) lets one test's blocking work starve another's short wait; use the scripts.

| Path | What |
|---|---|
| `Sources/ClaudeCodeBotCore` | Bots and their Claude and Codex processes, hand-offs, completion verification, workspace, routines, components, web bots, plugin registry, plugin host client, installer |
| `Sources/ClaudeCodeBot` | The SwiftUI app and the web view bridge |
| `Web/src` | The chat surface (TypeScript), with its five locales in `Web/src/locales` |
| `Web/host` | The Node plugin host |
| `Web/plugins` | Built-in plugins (`ccb-latex`) |
| `docs/` | Product docs, flowcharts and README images |

The screenshots in this README are drawn by the app's own snapshot mode (`CCB_SNAPSHOT`,
`CCB_RAIL_SNAPSHOT`, `CCB_RIGHT_SNAPSHOT`, `CCB_SPEC_SNAPSHOT`,
`CCB_SETTINGS_SNAPSHOT`) with sample data; `scripts/make-hero.swift` puts the hero picture
together from them.

## Versioning & releases

Botling uses [semantic versioning](https://semver.org); the current version is in
[`VERSION`](VERSION) and every change is in [CHANGELOG.md](CHANGELOG.md). Pushing a `v<version>`
tag runs the [release workflow](.github/workflows/release.yml), which tests, builds the universal
app and publishes it on [GitHub Releases](https://github.com/william1010121/Botling/releases).

## License

[GPL-3.0-or-later](LICENSE) © william1010121: you may redistribute and modify Botling under
the GNU General Public License, version 3 or (at your option) any later version. Releases up to
and including 1.14.2 were MIT-licensed.

The built-in plugins bundle KaTeX, markdown-it and CodeMirror (all MIT). The web bots' LaTeX
snippets and live preview are [web-laas](https://github.com/william1010121/web-laas)
(GPL-3.0-or-later), which bundles MathJax and mhchemParser (Apache-2.0); their notices ship in
the app as
[`web-laas/THIRD_PARTY_NOTICES.txt`](Sources/ClaudeCodeBot/Resources/web-laas/THIRD_PARTY_NOTICES.txt),
rebuilt by `scripts/build-web-laas.sh`.

Botling is an independent project and is not affiliated with Anthropic or OpenAI.
