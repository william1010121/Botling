# Changelog

ClaudeCodeBot uses [semantic versioning](https://semver.org): a new feature bumps the minor
version, a fix alone bumps the patch. Each release is a `v<version>` tag; pushing it builds the
app and publishes it on GitHub Releases.

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
