[Botling 2: First open / 首次開啟](https://github.com/william1010121/Botling/blob/bot/electron-2-0/docs/first-open.md) — macOS 15 Open Anyway / Windows SmartScreen.

## What's new in 1.19.0

- **Catch-up summaries.** Unread bot replies fold into one Catch-up card with a short summary
  of what finished, what is still running and what waits for you. Any interval between your
  messages can be summarized from its last reply, every bullet links back to the messages it
  came from, and Settings → General → Chat summaries sets thresholds, model and prompt.
- **One-time routines and Codex scheduling.** Routines can run once or every day in a chosen
  time zone, and Codex heads can create, pause and cancel them with `app_routines`.
- **Codex command monitors.** A Codex head can start an approved command, end its turn and be
  woken when the command exits.
- **A general Browser** for ordinary websites, with pinned sites, separate accounts and
  Capture, so the Maintainer can build a tool for one exact website.
- **Report a problem from any card** sends the card's context and a screenshot to the
  Maintainer.
- **Completion verification** can judge each reply and continue unfinished work; it is now
  off by default and shows its verdict per reply when enabled.
- Optional one-hour prompt cache for Claude subagents, faster scoped validation for Codex
  workers, and bots tidying their notes together when you quit.
- The hand-off chip and its Stop buttons over the input box are removed; hand-off dividers
  stay in the chat.
- Fixes for waits on live workers and scheduled retries, decisions handed between heads,
  workers blocking new hand-offs, summary folding, subagent avatars and the pinned strip.

See the [full changelog](https://github.com/william1010121/Botling/blob/v1.19.0/CHANGELOG.md#1190).

## Known limitations

- Hand-offs can no longer be stopped from the chat; they end on their own or with the bot.
- Authenticated Grok replies and sign-in persistence, a second Google account, Gemini's
  nested menu on the real site, live model reactions and interruption recovery still need
  live acceptance. Local fixtures and startup checks do not establish those results.

**Install**

1. On macOS 14 or later (Apple silicon or Intel), download `botling-1.19.0-macOS.zip` below,
   unzip it, and replace the previous app in Applications with **Botling.app**.
2. The app is not notarized: the first time, right-click it → **Open** → **Open**.
3. Install and sign in to the CLI for the head you use: [Claude Code](https://docs.claude.com/en/docs/claude-code)
   (`claude` on your PATH) or Codex (`codex` on your PATH). Node.js (for plugin programs)
   and git (for the plugin library) are recommended.

Existing chats, settings, plugin secrets and web profiles reuse their current storage and
application identity. Keep one installed copy when replacing the app.

See the [README](https://github.com/william1010121/Botling#readme) for what it does and how it works.
