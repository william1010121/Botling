# Changelog

ClaudeCodeBot uses [semantic versioning](https://semver.org): a new feature bumps the minor
version, a fix alone bumps the patch. Each release is a `v<version>` tag; pushing it builds the
app and publishes it on GitHub Releases.

## 1.5.0

### Added

- **Result pages show in the chat.** A new component, 「網頁預覽卡片」, draws a one-page HTML
  result as a small live preview with its title and a button to open it full-size in its own
  window. Links to pages in an `artifacts` folder (results from teams and bots) become such cards
  by themselves; bots can also show one with `<show name="網頁預覽卡片">{"path": …}</show>`.
- **/ for components and commands.** Type / at the start of a word in the input box to pick an
  app command (`/design`) or one of the chat's components; for a component the bot is told you
  mean it and how it is used. @ is only for bots now.
- **@ a bot into any chat.** In a bot's own chat, @ lists the other bots (Main bot, Maintainer,
  projects); the one you name reads the chat and answers there, under its own name and face, and
  picks on its line go back to it. The chat's own bot still gets your line.
- **Several components in one reply.** Every `<show>` in a reply is drawn, in order, where it
  was written; older replies that lost theirs are mended when loaded.
- **Feedback carries a picture.** Marking a reply "Not right" sends a screenshot of the chat
  around it, and you can paste or drop your own pictures into the feedback box.
- **Auto-approve safe actions** (Settings, on by default): bots run in Claude Code's auto mode,
  so harmless commands no longer ask; risky ones are still blocked or asked about.

### Changed

- Designing chat components goes to Maintainer and the component library; `/design` gives a
  Claude Design link on claude.ai instead of a local page.

### Fixed

- Finished subagents no longer look active in the left column; they show a check and leave the
  list after 10 minutes, and ones left over from before a restart stay gone.

## 1.4.0

### Added

- **See what bots do.** Each reply folds the steps behind it (tool calls with what went in and
  came out); the turn under way shows its steps live. Subagents a bot sends off show as cards in
  the chat and under the bot in the left column; click one to watch its conversation.
- **Bots hand work to subagents by default.** Managers give building, fixing and research to
  subagents and stay free to answer you. A bot stays awake while one works, and in a group chat
  it waits for it to report before answering the group.
- **Projects from chat.** The main bot adds folders as projects; `folder/*` means every folder
  inside, `folder/**` every project below. One card asks for all of them.
- **Settings** (gear at the bottom of the left column): today's API cost and tokens per bot, the
  last 30 days, the daily budget, plugins and developer mode. Tokens are counted from 1.4.0 on.
- **A daily budget.** Once today's is used up, routines, handed-over work and teams wait (a card
  offers more for today), never your own messages.
- **Ignore an item** waiting on you with ×; Settings can show it again.
- **Unread counts** in the left column, and chats ordered by their latest message.
- **Developer mode** (Settings, off by default), for working on ClaudeCodeBot itself: one
  project is its source; its manager may install a new build after you confirm (one that does
  not come up within 90 seconds is rolled back), look at the app's window, and gets replies you
  mark "Not right".

### Changed

- You come first: writing to a bot busy with handed-over work or a routine pauses that work; it
  answers you, then carries on. Adding to a message before the bot answers asks again with all of it.
- A wake-up brings the chat's last 20 lines, and every message is archived by month for bots to search.
- Every bot has the same tools; bots outside a project folder ask before running commands.
- Component reports take pictures.

### Fixed

- The left column no longer redraws in a loop that froze the app.
- A relay line no longer draws two borders.

## 1.3.0

### Changed

- **Group chats like a messenger.** Instead of one group of everyone, make as many groups as you
  like (+ next to Groups in the left column), name them and tick who is in each: the main bot,
  Maintainer, projects or bots. Right-click a group, or use the button in its panel, to rename it
  or add and take out members; delete it from the same menu. In a group, `@name` reaches only its
  members; without the main bot, the first member takes greetings. A removed bot leaves its groups,
  and a group with nobody left goes away.
- **Each bot's news stays in its own chat.** Project reports and questions, routine results and
  tool questions show where the bot said them, with a dot in the left column, instead of being
  copied into one place. Maintainer asks to read a folder in its own chat. The app's own lines
  (installs, plugin updates, team results, new and removed bots) go to the main bot's chat, and
  its panel lists everything waiting on you again.
- The 1.2.0 group chat is put away: its notices go back to the main bot's chat.

## 1.2.0

### Added

- **Group chat.** A "Group" row under the main bot: you and every bot in one conversation.
  Write without @ and every bot reads it in turn (the main bot first, then projects and bots),
  each seeing what the ones before it said, and answers only if it has something to add. Write
  `@name` (completed as you type) to talk to one bot, `@Maintainer` included. Picking an option
  on a bot's line answers that bot. Each bot answers from its own session, but the exchange shows
  only in the group chat. A bot busy with its own chat misses that message (a line says so when
  you named it), and one that does not answer in time is skipped, so the group never hangs.
  Other bots' lines reach each bot as quotes, not instructions, and only the main bot or a bot
  you named can start teams, bots or installs from the group. Bot names that would pass for the
  main bot, Maintainer, a project or "User" are refused.

### Changed

- **The main bot's chat is the main bot's only.** Project reports and questions, team results,
  plugin notices, install and folder questions now go to the group chat (existing ones move there
  once). "Waiting on you" moved to the group chat's panel.
- **Links open outside the chat.** Web links open in your default browser; local result pages
  and pictures open in a window of their own instead of the right column.

## 1.1.0

### Added

- **Bots of their own.** A bot that is not a project's manager (a morning news bot, a reading
  coach), with its own row in the left column, memory, inbox and `routines.cron`, in a folder
  under `~/.claudecodebot/bots/`. Make one with **New bot** at the bottom of the left column, by
  asking the main bot or Maintainer (they add `<new-bot name="…">job</new-bot>` to a reply), or
  from a plugin with `ccb.bots.create({ name, job })` (needs the `bots` permission; it returns
  `created: true` the first time, and a bot you removed is not made again). Right-click one to
  remove it; its folder stays on disk. Such a bot may search and read the web, and asks before
  running commands.
- **Answered questions fold up.** Once you pick an option, the question shrinks to one line with
  what you picked; click it to see every option again.
- **Bots ask before using a tool they may not use.** Instead of being refused quietly (for
  example publishing to claude.ai), a bot shows *Allow once / Always allow / Don't allow* in its
  chat, with the actual command or path shown; a project manager's question also shows in the
  main chat. Commands and file edits (Bash, Write, Edit) are asked every time; other tools can be
  always allowed, listed in the bot's Settings where you can take them back. A question nobody
  answers in 10 minutes counts as "Don't allow", so a routine at night does not hang.

### Fixed

- The chat no longer jumps after you send a message or pick an option: it stays at the bottom
  while components size themselves, and a redrawn component keeps its height.
- Local result pages (and .txt, .md, .csv, .json) without a declared charset showed Chinese as
  mojibake; valid UTF-8 is now read as UTF-8, and pages that declare Big5 or GBK load as before.
- A plugin's `ccb.routines.add` with a job that already exists no longer adds it twice.
- Reply tags written inside code (a bot explaining the syntax) are no longer acted on.
- Data shown in a component can no longer end the component's script early.
- "Waiting on you" in the main bot's panel now lists Maintainer's questions too.

## 1.0.0

The first release: the main bot, one manager per project, temporary teams, routines, the web chat
with Markdown and LaTeX, and plugins (web, program and Claude parts) kept by the Maintainer.
