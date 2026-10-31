# Changelog

Botling uses [semantic versioning](https://semver.org): a new feature bumps the minor
version, a fix alone bumps the patch. Each release is a `v<version>` tag; pushing it builds the
app and publishes it on GitHub Releases.

## 2.1.0

A cleanup and infrastructure release. It keeps the "Botling 2 Dev Trial" profile, so your chats and
settings stay where they are. The updater changed, so **2.0.x users must download 2.1.0 by hand from
the release page once**; after that, updates arrive in the app.

### Changed

- **Standard electron-updater replaces about 10k lines of custom update code.** Updates use the
  normal `latest-*.yml` feeds on GitHub Releases.
- **macOS builds are signed with a Developer ID certificate and notarized by Apple.**
- **CI runs on macOS, Linux and the web build.**
- **The Swift code is separated from the desktop app.** The web bundle is no longer committed.
- **Per-subagent storage.** Each subagent keeps a small index plus append-only step files. Existing
  data migrates automatically, and the old file is kept as a `.bak` backup.
- A shared JSON writer helper replaces several copies.

### Removed

- The Japanese, Korean and Simplified Chinese UI. These languages fall back to English.
- Google sign-in from the phone bridge. Paste a token into the token box instead.
- The Token Flow graph view and its `tokenFlow.view` command. Token usage is still recorded in each
  bot's `token-flow-turns.jsonl` ledger, and existing files stay readable.
- Web-page bots, dead code, and dead Antigravity code.

## 2.0.8

A rollup of everything since 2.0.1, and the first build for Linux. It keeps the "Botling 2 Dev
Trial" profile, so your chats and settings stay where they are. Download it by hand from the
release page: this build has no signed update manifest, so the in-app updater does not offer it.

### New

- **Linux (x64) AppImage and .deb.** This is the first Linux build. It is untested on real
  hardware. The Antigravity engine and in-place updates are macOS-only (see Known limitations).
- **Antigravity bots can delegate to app-managed workers**, like Claude and Codex bots, with an
  approval card for every worker file write, command, handoff and checkpoint. Antigravity can
  also hand work to Claude or Codex, and there is no cap on concurrent Antigravity workers.
- **Engine defaults.** Set a primary engine per bot, global defaults for engines and models, and
  the thinking effort per engine, bot and launch.
- **Detailed reports go to a report page.** The chat gets a short conclusion and a link.
- **Codex shows its 5-hour limit** when it reports one.

### Improved

- Antigravity replies are short: three sentences, with long content moved to a report page.
- Antigravity coordination tools run without an approval card, and a chat message to a busy
  Antigravity bot is accepted while it waits on an approval.
- Chat sends are answered before the turn is handed to the agent.
- Closing a terminal tab is quiet when its shell exits.
- Antigravity quota shows as ring cards in every state.

### Fixed

- Recovered worker cleanup obligations are kept after a report checkpoint.
- Blank dependency ids on Antigravity checkpoints are accepted.
- Stale test assertions and the CI release gate for dev-trial builds.

### Known limitations

- Linux: the Antigravity engine (its runtime is a macOS arm64 binary), in-place updates and
  hiding the app (a macOS feature) are off. Claude and Codex engines need their CLIs installed.
- The app is ad-hoc signed and not notarized on macOS, and nothing is signed on Linux.

## 2.0.3

### Fixed

- **Antigravity keeps peer handoff.** In a bot that uses several engines, Antigravity can start
  its own workers and can also hand work to Claude or Codex, like the other engines.
- **Terminal tabs close quietly.** When a shell exits, its tab closes without an error. Closing
  the last tab hides the terminal panel.

## 2.0.2

### New

- **Antigravity bots can delegate to app-managed workers**, like Claude and Codex bots. An
  Antigravity bot now acts as a coordinator and can start workers for research and
  implementation tasks, report checkpoints, and resume or cancel them. Every worker file write
  and command, and every handoff and checkpoint, still asks for your approval in a card, and
  full permission for local tools does not skip it. Delegation between Codex and Antigravity
  bots stays off.

### Fixed

- Antigravity quota shows as ring cards in every state, including while the bot is busy.
- Recovered worker cleanup obligations are kept after a report checkpoint, so a restart cannot
  lose track of a worker process.

## 2.0.1

The first release of the Electron app (Botling 2). It replaces the 1.x Swift app and covers
everything since 1.19.0. It keeps the existing "Botling 2 Dev Trial" profile, so your chats,
settings and web profiles stay where they are.

### New

- **Botling Web.** The app now draws its chat with Botling Web, so the desktop app, the browser
  client and the phone client look and behave the same. Cards and components run in sandboxed
  frames.
- **Three engines.** Claude, Codex and Antigravity (Gemini) can each be a bot's engine. The chat
  header shows every engine in use, and the primary bot can lead a three-engine discussion. The
  Antigravity engine is set up from Settings and checked by Doctor.
- **Model and effort picker.** A compact menu in the composer lists each engine's models and sets
  the effort with a segmented control. Settings find each engine's available models.
- **Terminal tabs.** Each bot has its own terminal tabs. You can drag the panel and resize it.
- **Task cards and a new task panel.** Every piece of work has a card. The panel groups work
  into Running, Waiting, Quiet and To verify, and you can close unverified work by hand. Details
  open in a drawer on narrow windows.
- **Token Flow.** A developer view of where tokens go, by task, with Claude and Codex usage.
- **Reports v2.** Bots build report pages from blocks (documents and slides) in plain language.
- **Chat files.** Type `@` to pick a project file with a preview. Markdown images open in a
  keyboard-friendly preview, and consecutive images group into a gallery. Image previews work
  for files the model reads.
- **Antigravity quota** shows as ring cards (Gemini only, as percent used) in usage settings.
- **Whiteboard** has Waiting and Running lanes, and Notify replaces Decide.
- **Codex** shows reasoning summaries and a thinking timer during quiet turns.
- Cute avatars use the supplied Claude, Codex and Gemini portraits.

### Improved

- Restarting the app after you approve it resumes safe unfinished work.
- Long chats stay fast: history loads in bounded windows and worker history is saved separately.
- Concurrent runs in one conversation show their own live activity.
- Dropped files no longer also paste their text into the composer.
- Ignored questions stay in the list as notes.

### Fixed

- Antigravity quota refreshes correctly after busy turns, and tool errors no longer end a turn.
- Progress reports no longer overwrite unrelated task cards.
- Token Flow keeps run ownership and a stable column layout.
- Several restart, history and update-safety fixes.

### Not included

- Antigravity helpers that take over work from other engines, and the mixed-engine worker
  features. They stay off until they are fully tested.

## Unreleased 1.20.0-dev

### Added

- **Component kit.** A component template that starts with `<meta name="ccb-kit" content="1">`
  gets ready-made blocks drawn like the app (Card, Stat, Ring, Bar, Spark, List, Chips, Button,
  Choices, Empty), written React-style with Preact, hooks and htm and no build step
  (`Web/kit/README.md`). The kit ships with the app and goes inline into the card's page: no
  network, same sandbox. A component that throws or has malformed markup shows an error card and
  sets its pin's status. Templates without the meta are unchanged. The app shell, the chat and the
  kit now share one set of colours (`Web/src/tokens.css`, with a light set for later).
- **Task cards.** Every piece of work in a chat gets a card: your message opens a provisional
  one, the head that starts on it owns it, follow-ups join it, two pieces of work in one
  message split into two cards, and quick answers leave none. Heads keep a card current with a
  hidden `<task name now next blocked state/>` status line (names, follow-ups via `continues`,
  running / waiting / done / stopped); only the owner changes its state. A card the owner never
  marked running is done when its turn ends with nothing of it still at work; one marked
  running with no news for 10 minutes shows **May be stuck** with **Ask it to report**. The
  right panel's **Tasks** section (in place of Now) lists open cards with now/next/blocked,
  helping hand-offs and subagents and **Jump to chat**; waiting and finished cards show under
  Waiting on you and Just done. Each reply of a task carries a chip, Catch-up bullets carry
  chips for the tasks they name, and the left rail shows each bot's running-task count. Cards
  are kept per bot in `tasks.json`.
- **A bot's own @ calls the bot it names.** A line of a bot's reply that starts with `@` and
  another bot's exact name now calls that bot into the chat through the same call-in route as
  your @: it answers there from its own main session (one head), told it is a fellow bot's
  question, not your request or a new permission, and its answer's tags do not act. One bot
  per reply, never itself; each reply is delivered once, across restarts
  (`bot-mentions.json`); at most three calls per chat per message of yours. An @ in prose, in a
  quote or in code stays text.

## 1.19.0

### Added

- **Catch-up summary.** Come back to a chat with more than a few unread bot replies (3 by
  default) and they fold into one Catch-up card behind a short 1–5 bullet summary of what
  finished, what is still running and what waits for your decision. The summary is written by
  an isolated, read-only `codex exec` at medium effort (your Codex login), cached per range,
  and never enters the chat, its archive or the bot's processes; the card expands to every
  message, and a failed summary shows the error with Retry ("Nothing was lost"). Messages now
  count as read only while the window is focused. On by default.
- **Summarize any reply interval.** The last bot reply of each interval between your messages
  has a **Summarize N replies** chip in its footer; the summary uses the same Catch-up card
  and keeps every original message, link and artifact. Historical intervals summarize, expand
  and retry independently. Automatic interval summaries (off by default) write that card when
  your next message closes an interval with at least the threshold of bot replies.
- **Summaries cite their sources.** Each bullet links the messages it came from; clicking one
  opens a read-only viewer of the original conversation with previous/next source navigation,
  who asked or picked what, and saved cards shown read-only (answer them in the chat).
- **Chat summaries settings.** Settings → General → Chat summaries turns unread and interval
  summaries on or off, sets their thresholds (shared default, or adjusted individually), picks
  the summary model and edits the writing prompt shared by all summaries (blank or **Restore
  default prompt** goes back to the built-in one; existing summaries stay as written).
- **Completion verification, judged and shown per reply.** When enabled, a read-only Codex
  judge (default `gpt-6-luna`, medium effort) decides after each reply of either head whether
  the authorized work is complete, waits on you, on a dependency or on a scheduled retry, or
  should continue, and continues an unfinished task. Each checked reply shows a small
  disclosure in its action row, collapsed by default, with the actual model, verdict and
  reason. Settings → Engines and subagents → Completion verification has the on/off switch
  and the verification model (only models that offer medium effort are listed).
- **One-time routines and Codex scheduling.** The Routines panel creates **Once** or **Every
  day** jobs with a time zone; Codex heads get an `app_routines` tool (create, list, pause,
  resume, cancel, with a `request_id` so retries never duplicate a job). Existing
  `routines.cron` files keep working. Botling checks about every 30 seconds while it runs; no
  system crontab or daemon is installed. See `docs/routine-scheduling.md`.
- **App-owned command monitors for Codex.** A Codex head can start an approved command
  (Allow once card) with `app_monitor_start`, finish its turn, and be woken with
  `app_monitor_result` when the command exits; `app_monitor_status` and `app_monitor_cancel`
  check or stop it. Only commands the app started are monitored, and an interrupted command is
  never replayed.
- **A general Browser.** A globe icon in the folded left column (the strip of faces) opens
  ordinary websites, separate from the Web section's AI chat readers: an address bar, back and reload, pinned websites and
  separate accounts (each with its own sign-in storage). **Capture** saves the current page so
  you can ask the Maintainer for a website tool ("What data or action should this website tool
  provide?"); plugins can offer such tools for one exact website (`ccb.browser.registerTool`),
  which run only when you press them, and click on the page only after you allow tool clicks
  for that website and account.
- **Report a problem from a card.** The ⋯ menu of a floating card, an opened pin, a Board tile
  and a card in the chat now has **Report a problem…**: say what's wrong, keep or untick the
  screenshot of the card, and send. It reaches Maintainer the same way a bot's component request
  does, with the card's chat, refresh setting, data time and the screenshot (kept in that bot's
  attachments), and **Sent to Maintainer** confirms it.
- **Claude subagents can keep their prompt cache for an hour.** Settings → Engines and
  subagents → Claude subagents has a "Keep subagents' prompt cache for 1 hour" switch, off by
  default. On, Botling starts `claude` with `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h` (unless
  the app's environment sets it), so a subagent that pauses more than 5 minutes no longer
  writes its whole context again; each cache write costs more than with the 5-minute default.
  It applies when a bot next starts.

### Changed

- **Completion verification is off by default.** New and existing settings without a saved
  choice start with it off: no judge runs, replies get no verification row and nothing is
  continued automatically until you turn it on.
- **Codex workers validate only what they changed.** Hand-offs to app-managed workers carry a
  bounded validation plan: each worker runs the relevant behavior and regression checks for
  its change, and the full suite and packaging are left to one integration pass after the
  changes are combined.
- **On Codex, the Maintainer's component edits go to the Claude component editor.** A Codex
  Maintainer hands template edits to the existing ccb-core Claude editor, with its result
  routed back across wakes and cancellation, instead of being blocked.
- **Bots tidy their notes together when you quit.** Independent bots write their memory at the
  same time before the app quits; bots that share one `memory.md` still write one after
  another.
- **A fast test loop.** `scripts/test-fast.sh` runs the app tests in serial shards spread by
  the last run's timings; `scripts/test-all.sh` is the full reference run, as CI.

### Removed

- **The hand-off chip and panel over the input box.** The "Hand-off 1/6" chip, the list of
  hand-offs under way and their Stop and Stop all buttons are no longer shown in the chat
  (single-chain stopping, added during 1.19 development, went with them). Hand-off dividers
  stay in the chat history, and hand-off budgets are unchanged.

### Fixed

- **No wake while live workers own the rest.** The completion judge no longer continues a head
  just because its running workers have not reported yet: "unfinished but every remaining piece
  is held by a live worker" is a dependency wait. A continue verdict while live workers run is
  checked a second time, and a second dependency-wait answer keeps the head quiet until
  `app_task_result` wakes it. The judge sees the app's own worker records, not launch
  instructions, and a worker starting up no longer gets a duplicate follow-up.
- **Timed waits are not live-worker waits.** A cooldown or scheduled retry ("Waiting for
  scheduled retry"), including a pending routine, is judged against the app's clock and
  scheduler entries instead of being treated as a worker dependency or as unfinished work.
- **Claude subagents count as owners.** A head waiting on its running Agent-tool subagents is
  no longer woken over and over: they are in the judge's live worker snapshot, and their task
  notification is the return path. Stale tracker cards never count.
- **Finished tasks stay finished.** Once a task is judged complete with reported evidence (a
  merged commit), later checks no longer treat it, or the older message that asked for it, as
  work to continue.
- **Loop guard after two.** Two automatic continuations in a row without a new result pause
  the loop ("Automatic continuation paused") instead of three or more.
- **A new hand-off no longer waits behind an earlier worker.** Background workers keep their
  own return route to the head that sent them, so a head can take a new hand-off while an
  earlier app-managed worker is still running.
- **A decision handed between heads is answered once.** Linked copies of a decision card in
  both heads resolve together, earlier answers are never rewritten, and notes are kept.
- **Summaries fold timestamped messages correctly**, and the summary service's unavailable
  message is translated.
- **Every subagent row in the chat shows its owning head's avatar**, in single-head bots too.
- **A floating pin's ⋯ menu closes when ⋯ is clicked again**, including after a data refresh
  redraws it.
- **The pinned strip keeps its + on one row** and its size after keyboard focus or pin
  changes.

## 1.18.0

### Changed

- **One dock over the input box.** The pinned chips are one segmented strip (one border, thin
  dividers, + at the end), and every control there is 32px tall with the same radius, border
  and muted words; a pin's status is its dot's colour. "Answer with" moved into the input box's
  toolbar: + on the left, then Both / Claude / Codex as one segmented control (the chosen one
  raised, with its head's dot) and the ⌥1 ⌥2 ⌥3 hint, send on the right; ⌥1–⌥3 and `@codex`
  work as before. The "Hand-off 1 of 6 · Stop now" line is now a chip at the right of the
  strip (a meter, "Hand-off 1/6", Stop); with hand-offs for several of your messages under way
  it says "3 hand-offs in progress" and opens a panel above the strip listing each one (who to
  whom, its task, running / waiting reply / done, its count). A row opens to the message it
  came from and what the two heads said; Stop all stops them (hand-offs stop together).
- **Fewer tokens per message.** The reactions list no longer goes with every message: a new
  session gets how to react and the newest lines' ids once; after that each message carries only
  its own id and the lines whose reactions changed (about 4.4k characters down to under 100
  when nothing changed). Component usage goes to a session once; a changed library or list then
  sends only what changed (new, changed or dropped components), never the whole list again, and
  the Codex head hears about it too. Both heads behave the same. Settings → Usage → App context
  savings has separate, saved switches for reaction and component deltas, both on by default;
  turning one off sends its full context with the next normal message.
- **Quieter left column.** Bot and group rows no longer show the orange "waiting on you" dot,
  and running subagent rows no longer show a blue dot (the owner head's face is on the row);
  the folded strip drops the orange dot too. Only the unread count (a blue dot when folded)
  is left. "Waiting on you" is still in the hover tip and the chat.
- **Settings look like macOS System Settings.** A searchable sidebar with coloured icons and
  grouped forms with a note under each group, in light and dark. General gains the reminder for
  quiet runs; Usage shows the Claude and Codex 5-hour and weekly limits; the component editor
  moved to the new **Engines and subagents** page, which sets the Claude subagent model and the
  Codex workers' model, effort and Fast mode for every bot (or follows `~/.codex/config.toml`,
  showing what is in effect). Each bot's own settings page can still override them.
- **Subagent rows show their head and model.** In the left column and Settled, each subagent
  row shows which head started it (the head's character in the Cute look, its dot otherwise)
  when the bot has two heads or the row is the other head's. A Claude subagent started with
  "same model" now names the model its own stream reports, then the subagent setting, then the
  Claude head's model, read as a name ("Opus 4.5"); Codex workers no longer borrow the Claude
  subagent setting as their model.
- **The GitHub repository is now `william1010121/Botling`.** README, docs, contributing and
  security links, release notes and `/share` pull requests point at the new name; old
  `ClaudeCodeBot` URLs redirect, and bundle ID, data folder and Swift target names are unchanged.
- **Codex hands work to app-managed workers.** The main conversation finishes its turn after
  handing off a task, so you can keep chatting while an independent worker session runs. Live
  worker cards keep their progress and follow-up history. The app queues completed results and
  wakes the main conversation to report them; an idle conversation shows that it is waiting
  for workers instead of continuing the thinking animation. Existing chats keep their visible
  history; their first upgraded Codex session starts a managed coordinator with saved memory
  and recent conversation context.
- **Updated Cute character art.** Claude and Codex use the supplied transparent portrait pack
  throughout the app, with separate awake, working, waiting and sleepy expressions. Bot hats,
  recipient highlights, the existing work animation and the Original look remain available.
- **Animated, adjustable chat avatars.** Cute avatars blink when idle, type while working
  and wave when done, with static fallbacks and motion paused offscreen or for Reduce Motion.
  Click an avatar to preview the animations. Settings → General saves a chat avatar size from
  32 to 96 px and applies it immediately; sidebar icons and small engine heads keep their size.
- **Message details share one footer.** Work status, emoji reactions and the heads that have
  read a message sit together under its bubble and wrap in narrow chats.

### Added

- **Emoji reactions on chat messages.** Add or remove reactions on your messages and replies
  from either head; they stay with the saved chat. A reaction alone does not wake a head or
  send a message; its context goes with the next normal turn.
- **Grok in the Web section.** Open Grok beside Gemini, ChatGPT and Claude, with its own web
  session and page reader for saved conversations.
- **Pin web conversations.** A web conversation's context menu can pin or unpin it. Pinned
  rows stay first and visible when the list is shortened, and the choice survives a restart.
- **Several Google accounts in Gemini.** A small ⌄ beside Gemini in the left column opens its
  account menu: pick an account to ask a new question in it, add one (it signs in on its own,
  separate website data), or rename or remove one. With more than one account, Gemini's face
  wears the current account's badge, and each question's arrow and small badge show the account
  it was asked in; clicking a question opens it in that account. Your existing Gemini sign-in
  is account 1, kept as it is, and every question from before belongs to it. Removing an added
  account deletes its sign-in on this Mac; its saved conversations stay. With one account,
  nothing changes but the ⌄.
- **Claude and Codex as characters (Bot look: Cute).** With either or both engines enabled,
  Claude (orange hair, orange flower and black ribbon) and Codex (white and lavender hair,
  horns, a knot ornament and elf ears) are drawn as small vector characters. Replies and the
  live work bubble show the engine's character wearing the bot's face as a hat; the live face
  follows the same process as its steps. The expanded and folded left column show the bot's
  face in front with both characters behind it; disabled heads stay asleep and dim. Under Now,
  each head shows whether it is working, awake, waiting for your OK or asleep. In a bot with
  both engines, the tiny heads under your messages highlight that message's recipients; a
  separate small check and tooltip show who has actually read it. Newly delivered heads and
  read checks bounce once, the active work avatar moves gently without restarting on streamed
  updates, and motion stops when work finishes or Reduce Motion is enabled. Settings → General
  → Bot look switches between Cute (the default) and Original at once, without a restart.
  Subagents keep their own look. `CCB_BOT_LOOK=original` draws snapshots in the Original look;
  `CCB_CHIBI_SNAPSHOT=<png>` draws each state at the app's sizes on dark and light.
- **Answer with stays selected.** Clicking Claude, Codex or Both above the input box (or using
  its keyboard shortcut) saves that bot's preference immediately, across sends, chat switches
  and app restarts. Rapid changes keep the latest selection while earlier saves arrive.
  A message starting with `@claude`, `@codex` or `@both` overrides only that message.
- **A bot can run on Codex.** A bot's settings have an Engine row: Claude (as before) or Codex.
  On Codex the bot runs `codex app-server` and works as on Claude: replies, its commands and file
  edits as steps, Allow cards for what Codex asks to do, a message sent while it works joins that
  turn (or stops it, as on Claude), and after a restart it goes on in the same Codex thread.
  Each conversation starts with the app's own approval and sandbox settings (asks before
  stepping outside its folders; in auto mode Codex's own reviewer answers), not those in
  `~/.codex/config.toml`. Both engines read and write the same `memory.md`: switching engine
  while the bot is awake writes a handoff into it before the next message, and the new session
  reads it. On Codex, results stay as local pages (Codex has no Artifact tool), the model is
  Codex's own, and its tokens are counted with the rest (no cost in dollars). A bot can also
  enable both heads and hand work between them, as described below.
- **Web capture: the web bots' traffic, for fixing their page readers.** A Capture button over
  Gemini's, ChatGPT's and Claude's page records the page and the traffic the page itself
  fetched (fetch, XHR, EventSource and WebSocket, watched from inside the page: no certificate,
  no request of the app's own) for up to 3 minutes or 100 MB, with the 5 minutes before it, which
  the app keeps in memory only. A card shows the time, requests, streams and size while it
  records, then what the page reader read and Send to Maintainer, Reveal in Finder and Delete.
  The capture is a private folder, `~/.claudecodebot/captures/<site>/<time>/` (events.jsonl,
  network.har, dom.html, outline.json, screenshot.png, the reader and its output), with
  cookies, sign-in tokens, CSRF values, e-mail addresses and account ids masked before it is
  written and inline scripts removed from the HTML (the screenshot is not masked); the newest
  5 per site are kept, none older than 30 days. A page reader may now also read the traffic
  (`extractNetwork`, with `NETWORK.urls` naming the requests): when both readings agree the
  traffic's Markdown is saved, and when they differ the page's text is saved and the strip shows
  a warning with Re-capture (as it does when the reader finds nothing); once Maintainer's fix
  reads the page, the strip says "Page reader updated · page and traffic agree". Send to
  Maintainer lets Maintainer read the captures folder and hands it the capture with steps: fix
  the reader, write `expected.json`, which you confirm on a card in the right panel's new
  "Captures", and run `ClaudeCodeBot --test-extractor <capture or folder>`, which replays every
  capture (its page with no scripts or network, and its traffic) through the reader and fails on
  a wrong answer or a page/traffic mismatch. The readers shipped with the app still read only the
  page; tested on local fixture pages that mimic each site's traffic, not yet on the real sites.
- **Claude and Codex in one bot, at the same time.** "Engines in this bot" in a bot's settings
  can turn both on. Each head then runs in a process of its own, side by side: every message
  goes to both, and they decide between them who does what (each says early what it takes on,
  and leaves alone what the other took). A head hears the other's replies, with what it did,
  as they come: in its turn when it is working, else with its next message; what it says
  between steps reaches the other at once while both work. A head with nothing to add shows no
  reply. "Answer with" above the input box can still name one head for a message (⌥1 ⌥2 ⌥3, or
  start it with `@codex`, `@claude` or `@both`); the other hears of it with its next message.
  Each reply says which head wrote it ("ClaudeCodeBot · Codex"). Under your lines and the
  replies, small C and X marks show which heads have seen them (in their context), lit as it
  happens. Both work in the same folder and are told so, to say which files they change and
  edit only their part; they share one `memory.md`, change only the lines about their own
  work, and it is tidied once, by one head, when the bot sleeps (both sleep together).
- **The two heads hand work to each other.** A head can hand the other a piece of work by
  ending its reply with `<handoff to="codex" kind="…">…</handoff>` (a task, a review, or asking
  its view): the chat shows "Claude → Codex: …", the other head does it, and its reply goes
  back to the one who handed it. The app counts them for each message you send, as the guard
  against endless back-and-forth: at most 6 hand-offs, of them 2 reviews and 3 discussion
  rounds (adjustable; a switch turns hand-offs off). A line over the input box says where they
  are ("Review round 1 of 2") with Stop now; at the limit a card shows where each head stands
  for you to pick, or the latest version stands (a setting).
- **More of the bot works on Codex.** Codex's own limits (its weekly percentage) show in the
  gear's popover under "Codex", apart from Claude's. In auto mode, a call Codex's reviewer
  refuses shows the same card as auto mode's blocks on Claude, with its reason; allowing it lets
  that command through when Codex runs it again. Words you give instead of allowing reach
  Codex. Codex's own subagents show as subagent rows with their steps. A bot on Codex hands
  publishing to Claude (`<handoff to="claude">`): Claude publishes the Artifact and the link
  comes back. A bot's settings have a Codex model menu, listing what the local Codex offers
  (`model/list`); changing it while awake goes on in the same Codex thread.
  A bot with both heads says "C + X" in the left column, and its panel's "Now" shows each
  head: working, awake or asleep. Codex's limits show only the windows
  Codex reports.

### Fixed

- **Switching web rows keeps the selected conversation.** Picking a provider or Google
  account returns to its current page instead of starting a new question; the selected row
  remains visible alongside pinned rows in a shortened list.
- **Gemini's nested menus stay beside their controls.** A submenu that WebKit places at the
  page's top-left is anchored to its control and kept within the view, then restored on close.
- **Cross-bot replies show their source head.** Relayed replies keep the actual engine and
  source bot's avatar instead of borrowing the receiving chat's head.
- **Codex can dispatch several independent tasks in one turn.** Accepting the first worker
  no longer ends dispatch before the remaining ready tasks have been handed off.
- **An interrupted reply no longer disappears.** When you send another message while the bot
  is still working (or it pauses handed-over work for you, its process dies, or the app quits
  mid-turn), what it had already written and its Worked steps stay in the chat as a bubble
  marked "Interrupted", saved with the chat and archive, instead of the live bubble vanishing.
  If that turn turns out to have finished anyway, its full reply replaces the kept part.
- **A Claude subagent's token speed counts all of its output.** Streamed subagent lines carry
  only the count from when each block ended and the last message is not streamed, so tok/s
  read about 11 times too low. The app now reads each message's final output count from the
  subagent's transcript on its progress and completion notices; counters keep their highest
  value.

- **The chat no longer scrolls sideways.** A long divider label (such as a handoff note) could
  widen the chat past the window and cut off every bubble at the left edge. Divider labels now
  wrap, Markdown tables scroll inside their own block, and a page preview's report flag sits in
  its top-left corner, off the 開啟完整頁面 button.

- **Progress questions keep an in-flight handoff connected.** Writing while one head works
  for the other resets the message's round budget without deleting the pending return route.
  A question to the recipient is answered first, then the handed work resumes with its own
  completion tracking; the progress reply does not count as the completed task. A recipient
  finishing with `<no-reply/>` closes its handoff and gives the initiator one quiet completion
  note, without an empty bubble or a wake loop. Stop now still cancels pending handbacks.

- **Two heads hear a claim before starting together.** Both heads used to get a message to Both at the
  same instant, so neither saw the other's "I'll take X" before starting, and they did the
  same task or one took over everything. Now one head (the one not busy, taking turns when both
  are free) reads the message first; the other gets it together with the first head's opening
  words (or its reply, or after 20 seconds of silence), then both keep working at the same
  time and hear each other mid-turn. Split messages keep the same lead, deadline, attachments
  and read markers. A final reply can supply the claim too; switching back to one engine
  cancels its pending start. Hearing the other head adds context without pausing the user's
  task or breaking later follow-ups. The two-heads rule in the prompt describes this split.

- **Codex's subagents show in the side panel again.** codex-cli 0.163 reports the subagents
  it spawns with `subAgentActivity` items instead of a `spawnAgent` collab call, so none of
  them appeared. Each now gets a row named after its path (`/root/avatar_coverage` →
  "avatar coverage") with its model, its own thread's steps go under it, a message to it
  adds no new row, and it ends when Codex says it completed or was interrupted. Giving a
  completed agent another task restores the same row when its next turn really starts;
  merely messaging an idle agent does not make it look busy. Repeated completion events
  are ignored. A live spawn → command/report → followup → command/report session verified
  that child steps arrive on the parent's connection. Older Codex versions still work the
  old way. In a two-headed bot, both heads' teams now share the native list, detail view,
  and Settled section, including its compact count. Partner steps and status changes update
  the shared chat immediately; the detail badge names its actual owning engine, and settling
  saves to the head that owns the agent. Saved teams
  appear after restart without waking either engine, while each process keeps its own
  liveness and trace state.

### Known limitations

- Hand-offs stop together with **Stop all**; stopping a single row is not implemented.
- Authenticated Grok replies and sign-in persistence, a second Google account, Gemini's nested
  menu on the real site, live model reactions and interruption recovery still need live
  acceptance. Local fixtures, saved-data tests and startup checks do not establish those results.

## 1.15.1

### Fixed

- **A Board card no longer flashes when you drop it.** Let go, a card jumped for a few frames
  (about 0.07 s) to as far past its new place as you had dragged it, then snapped back. Its
  glide into place started from where it was being dragged, measured from its old place; now
  the card is put at its new place under the pointer first, and glides from there.
- **The bundled LaTeX plugin (`ccb-latex`) and the plugins the app writes itself (ccb-core,
  ccb-teams, the component library, ccb-web-extractors) say GPL-3.0-or-later** in their
  package.json, as the app is, not MIT. Component-library and ccb-web-extractors manifests
  already on disk are left as they are.
- **The README's hero picture no longer shows the removed Codex bot.** It is drawn again with
  sample data (`CCB_RAIL_SNAPSHOT` with `CCB_RAIL_HERO=1` draws its left column, and
  `scripts/make-hero.swift` puts it together), and so is the social preview.

## 1.15.0

### Added

- **Gemini as a bot in the left column.** A new "Web" section lists Gemini; picking it shows
  gemini.google.com itself in the chat column (a real web view, with its own sign-in kept over
  restarts). Clicking Gemini (its row, or its face in the folded column) opens a fresh, empty
  question, as "New question" in the right panel does. Each question is a row under it, like a
  bot's subagents, from the moment you send it (titled from what you asked, with a live dot
  until the answer comes); once you have viewed one and moved on, or press its clock, it leaves
  the left column. The right panel's "Questions" keeps every one: click one there to open it and
  list it in the left column again. A bot's link to a saved conversation's file opens Gemini on
  that conversation (from the app's list, else the file's `- URL:` line) instead of the file.
  There is no Chat | Board switch over it (a web site has no Board): the page and its address
  strip start at the top of the column.
  When an answer finishes, the app reads the conversation as text (it never types or clicks on
  the page) and saves it to
  `~/.claudecodebot/web/gemini/<title>.md`; the top strip says "Saved for Main bot · N messages",
  or "Couldn't read this page" when it found nothing, and then saves nothing. "Ask Main bot
  about this" hands the saved file to the main bot, which is told where these files are so it
  can search them. The script that reads the page is a plugin, `ccb-web-extractors`, that
  Maintainer can fix when Gemini changes its page.
  ChatGPT (chatgpt.com) and Claude (claude.ai) are listed under it and work the same way, each
  with its own sign-in (kept inside the view: auth.openai.com, Google, Apple or Microsoft for
  ChatGPT; claude.ai, Google or Apple for Claude), its own folder (`web/chatgpt/`,
  `web/claude/`) and its own page reader (`chatgpt.js`, `claude.js`). They save an answer as
  Markdown: headings, numbered and nested lists, code blocks with their language, tables,
  quotes and links, and math as its `$TeX$`; an answer still being written is not saved as one,
  so its question keeps waiting.
- **LaTeX snippets and live math preview in the web bots.** Typing in Gemini's, ChatGPT's and
  Claude's input boxes works as with the web-laas browser extension, now built into the
  app: `$;a` becomes `$\alpha`, `mk` opens inline math, Tab jumps to the next field, and a card
  above the caret shows the formula as it will look. Formulas in the box and in your sent
  messages are shown typeset when the caret is elsewhere. ⌥⇧L pauses or resumes it (the app
  remembers). MathJax for the preview loads into a page only the first time you type math there,
  and the preview keeps its look on pages whose security policy refuses inline styles. The
  cheat sheet (⌥⇧K) is not included. Rebuilt from a web-laas checkout with
  `scripts/build-web-laas.sh`.
### Removed

- **The built-in Codex reviewer.** The left column's Codex bot ("Read-only reviewer") and `@Codex`
  in a chat, the right panel's Codex review section and "Review with Codex" button with its
  report windows, a bot's "Codex review for subagents" settings and the `<codex-review>` tag,
  and the `ccb.reviewWithCodex` call for components (a component that checks for it turns its
  button off). Bots that want Codex can still run the `codex` CLI themselves, and Settings →
  Doctor still checks it. What the reviewer left in `~/.claudecodebot/codex` and the old
  settings in each bot.json stay on disk, unread.
### Changed

- **ClaudeCodeBot is now licensed GPL-3.0-or-later** (was MIT), as it bundles web-laas
  (GPL-3.0-or-later). Releases up to 1.14.2 stay MIT. Third-party notices for web-laas, MathJax
  and mhchemParser (Apache-2.0) ship in the app's resources.
- **"Said it, didn't do it" is checked by the app, not a Stop hook.** Bots no longer get a Claude
  Code Stop hook in the `--settings` the app passes them (`ClaudeCodeBot --stop-guard` is gone,
  and so is `--include-partial-messages`); the bot's permissions and tools are otherwise the
  same. Instead, once a turn's reply has shown, the app itself hands Haiku only that reply's
  words and asks for one word, yes or no: no transcript, no tools. It doesn't ask at all while
  background work the app is tracking (a command, a subagent, a wake-up or cron job) will still
  wake the bot, or when the reply asks you to pick (`<choices>`). A yes sends the bot one
  follow-up in the same chat ("Your last message promises work you have not done… do it now or
  start a background task"), and the reply to that follow-up is not checked again; anything you
  write in the meantime goes first and the follow-up is dropped. The reply shows the moment the
  turn ends, as before, and what the bot then does comes as a second reply. The check doesn't
  depend on the engine, so it can cover other engines' bots too, and with a one-word answer it
  takes about 3–4 seconds instead of 6–8.
- **A subagent's view reads like its work log.** Clicking a subagent (its row in the left
  column, or a background-work chip) showed its conversation as chat bubbles with every run of
  tool calls folded to "Worked · 5 steps". Now it is read only, as in the approved design: a
  header "Main › Review PR #7" with a "Claude subagent" badge and its model (the one its Agent
  call asked for, else the bot's subagent model); what the bot sent it (its task, and each
  later SendMessage message) as a compact box "From Main · 15:58", in order; its work one
  monospace line per step ("• Run git diff main...HEAD --stat", a spinner on the one under
  way), a command's output (or a long read or edit) folded until you click its line; and what it
  said, its report at the end, in prose. No input box.
- **In a subagent's view, each run of steps folds to one "N steps" line.** A long stretch of
  work between two things the subagent said (or a message from its bot) no longer fills the
  screen with 20 lines: it folds to "› 15 steps", the same line and fold as the main chat's
  process, and a click opens it to the lines as before (it stays open over updates). The run
  under way stays in sight the way the main chat shows a turn at work: its latest steps, the
  current one spinning, with "N steps so far · M earlier hidden" above them.
- **CI checks only that it builds and the fast tests pass.** Tests that run real programs (sh,
  git, node and the plugin host, the app) or WebKit are marked `.integration`, and ones that wait
  on real time `.wallClock`; both skip themselves when `CI` is set and still run locally with
  `swift test`. CI is two jobs (Web, Swift) with timeouts, runs tests serially, and cancels a
  branch's older run; the release runs the same fast set before building the app.

### Fixed

- **A Gemini question is no longer lost when you move on before it is answered.** Its row
  used to appear only once Gemini answered, so starting a new question (or opening another
  row) in the meantime dropped it. Now the row is made as soon as the page shows the question,
  even before Gemini gives the conversation an address; the page you leave keeps running behind
  the new one until the answer is read and saved into that row, whether you are on another
  question or another bot. A question still waiting when its page closed (or the app quit) is
  read again from its conversation's address, and one whose page closed before it had an
  address becomes that conversation's row once a page shows the same question.
- **Saved Gemini conversations keep math and lists readable.** Each formula was saved three
  times over (`Ω(nlog⁡n)\Omega(n \log n)Ω(nlogn)`, KaTeX's MathML, TeX and drawn text); now
  once, as its TeX: `$\Omega(n \log n)$` in a line, `$$…$$` on its own. A list item's
  paragraph was saved as a lone "-", a blank line, then its text; now `- text`. Conversations
  saved before are fixed the next time their page is read.

- **A component's Command line is run before it is delivered.** The component shot (the check
  Maintainer and the component editor run before handing a component over) now runs the
  about.md `Command:` line once, exactly as the chat does (the user's zsh, in `--folder` or else
  the plugin folder, a 30-second limit), and lists a failure as a problem with the shell's own
  words. A line such as `Command: python3 script.py [repo_dir]` used to pass and then show "The
  command failed" on the card (`zsh: no matches found: [repo_dir]`). The editor's and
  Maintainer's instructions and PLUGINS.md now say the line is executed verbatim: optional
  arguments are described in about.md's prose, not in the line.

- **A subagent its bot sends more work with SendMessage shows at work again, with the message.**
  When a bot resumed a finished subagent (or queued a message for one still running), the
  resumed run's `task_started` and `task_notification` name the SendMessage call, not the Agent
  call that started it, so the app either made a second, empty row for it or nothing at all; its
  own row stayed "done", and opening it did not show what the bot had sent. Now the SendMessage
  call is matched to the subagent by the agentId or name it was sent to (or the agentId in the
  result): that row is at work again until the resumed run's notification, the turn gets a
  background-work icon for it, and its conversation shows the bot's message, under the bot's
  name, where it came, with what the subagent did after it below. One the app does not know
  (sent off before it restarted) gets a row from what the message says.
- **A subagent that finishes always gets reported, and no empty bubble shows.** CSIT sent a
  subagent off to merge two tests ("做完我再回報"); it finished and handed back a report that
  said only "pending", the bot answered `<no-reply/>`, and claude's result line for the
  task-notification that followed (no turn ran, no words) drew an empty grey bubble. The user
  heard nothing until asking 40 minutes later. Now a result line for no turn is not a reply, a
  wake that ends with nothing to show draws no bubble, and when a finished (or failed)
  subagent's work went unsaid the app asks the bot once to report it — and if it still says
  nothing, a notice says the subagent finished, with its report. A hand-back's report is also
  what its card shows now, instead of "delivered to you as a message". The briefing says
  `<no-reply/>` is only for interim notifications, never for a subagent that finished.
- **A bot's reply that says "here is the card" shows the card under it.** A bot that keeps a
  card up to date (`<show name="study-progress" id="progress">…</show>`) and was asked for the
  latest one answered "最新進度卡如下…", but the app put the new data into the card with that id
  in a message from the day before, far up the chat, and nothing was drawn under the words. Now
  a `<show id="…">` in a reply with words draws the card there and the old one gives way (one
  card per id; the old reply's words stay); a reply that is only the update still changes the
  card where it is, adding no bubble.
- **A reply's hover toolbar no longer covers the card in it, and the reply has one flag.**
  Hovering a reply that shows a component (a study-progress card) put the reply's toolbar
  (reply / make into component / flag) right on top of the card's own pin bar, a second flag
  (the card's Report) over the card's bottom-right corner, on its content, and the card's name
  as a tooltip poking out of the reply's edge. The card's bar now sits left of the toolbar, by
  as many buttons as the toolbar has; Report is in the card's ⋯ menu instead of a flag over
  it; and the card's frame is named for VoiceOver without a hover tooltip.
- **/share puts the community-feature label on the pull request, or says why it couldn't.**
  ClaudeCodeBot had no `community-feature` label, so `gh pr create --label` was refused and the
  pull request was opened again without it, while the checklist had shown "✓ Label" and the
  Release planner, which lists open pull requests with that label, never showed it. Now a
  refused label is made on ClaudeCodeBot (`gh label create`; "already exists" is fine) and the
  pull request is opened with it; when GitHub still refuses it, the pull request goes without
  and the reply quotes GitHub's answer. The checklist marks the label "!", not ✓, since it is
  only known once the pull request opens.

## 1.14.2

### Fixed

- **A component a bot shows with no data no longer puts an error in your chat.** A bot that
  wrote `<show name="git-diff"></show>` for a component it is meant to fill (no `Command:` line
  in its usage, only a `Board command:`, which the chat never runs) left a red "Nothing to show
  / This component was shown without data…" card in the middle of its reply. Now nothing is
  drawn there, the bot is told with your next message that the tag was empty and needs its
  JSON, and its component briefing says so up front.
- **The blue dashed drop outline around the chat always goes away.** Dragging a file over the
  chat outlines the window; when the drop landed on a part of the page that takes it itself
  (the report box's pictures), or the drag left the window or was cancelled without the page
  hearing a `dragleave`, the outline stayed for good. It now also clears on any drop or
  `dragend` (heard on the window before any part can stop it), on leaving the window, when the
  window loses focus, when the mouse moves with no button held, and after a moment with no
  drag over the page.
- **Cards that refresh by themselves run only while you can see them.** A pin refreshed every
  few seconds or minutes (its pin menu) was rerun by the app's timer in every chat, whether or
  not anything showed it: a release-progress pin floating in a project's chat kept running
  `git status` every 5 s while another chat was open or the window was minimized, keeping
  fseventsd busy. Chat cards (`Refresh: every Ns`, `<show refresh="2s">`) and floating pins
  trusted the page's own visibility, which a covered window does not always change. Now one
  rule gates them all: the window is shown (not minimized, not hidden, not fully covered, from
  its occlusion state), the card's chat or Board is the one showing, and the card, chip, opened
  pin, Board tile or floating card is scrolled into view. A pin whose only sign on screen is its
  chip refreshes at the pin's own pace. Seen again after longer than its interval, a card
  refreshes once right away, then on its timer.
- **A result page that sets no dark colours is readable again in its window.** The window that
  opens a local page (a bot's `.bot/artifacts/*.html` report) drew the page see-through over its
  near-black background, so a page with default or light-theme text (black or `#222` on no
  background of its own) showed dark text on dark, with only its light code chips visible. The
  page now gets the canvas a browser gives it: white for a page that declares no dark support,
  dark for one that sets `color-scheme: dark` or styles itself for dark mode. Markdown files,
  drawn by the app's own viewer, stay as they were.
- **Bots can publish reports as claude.ai Artifacts again.** Claude Code leaves its Artifact
  tool out of `claude -p` sessions unless `CLAUDE_CODE_ARTIFACT` is set, so a bot told to
  publish reports as Artifacts (Permissions → Reports and results) had no such tool, even with
  Artifact in its allowed tools: it said the tool was missing and wrote a local HTML page. Every
  bot and team is now launched with `CLAUDE_CODE_ARTIFACT=1`, unless the app's own environment
  sets it (say to `0`). A live test checks the tool is in the session's tool list.

- **A card that refreshes no longer goes blank for a moment on each run.** A component with a
  Command whose template does not call `ccb.onData` (a `Refresh: every 2s` card, a
  `<show … refresh="2s">`, a pin refreshing every few seconds) got a new frame with each new
  data, and a new frame is empty while it loads: about 0.1 s of nothing in the chat, the opened
  pin and the floating card, and an empty dark cell on the Board. Pinned, floating and Board
  copies also replaced their whole body unless the frame took live data. Now every surface keeps
  the frame on screen and draws the new data in a hidden frame right over it; once that has
  loaded and painted it takes the old one's place in one step (newer data while it loads replaces
  it; after 2 s it shows anyway). Frames that call `ccb.onData` still keep their frame and just
  get the data.

- **The window no longer slides off its edges in the main bot's chat.** The right panel's
  overview did not scroll, so with a long "Waiting on you" list (the main bot gathers every
  bot's questions) it grew taller than the window. The row of columns grew with it and was
  centred, which pushed the rail's and the chat's tops off the window, hid the input box below
  its bottom and left the rail's search bar floating with a gray box above it. The overview now
  scrolls, and each of the three columns is exactly as tall as the window and drawn from its
  top, so no column's content can move the others. `CCB_WINDOW_SNAPSHOT` draws the whole window
  with `CCB_WINDOW_WAITING` things waiting and fails when a column leaves the window; a test
  runs it with 1, 14 and 40.

- **A bot called in with @ answers even while a background agent of its own is at work.** A bot
  that had finished its turn but left a subagent (or a background command) running counted as
  busy, so a call-in or group turn waited up to 5 minutes behind a "…" and then gave up with
  "Did not answer this time: X (busy)". That wait was there so the subagent's report, which comes
  back as a turn of its own, would not be taken for the group's reply. Now the call-in line is
  sent with an id and claude says when it is queued and when its turn starts
  (`command_lifecycle`): only that turn's reply goes to the group. A report turn that comes first
  shows in the bot's own chat as usual, and after a timeout only the late group reply is dropped,
  not a report that arrived before it.

## 1.14.1

### Added

- **What you typed but did not send stays in each bot's input box.** Switching bots used to
  empty the box (the page cleared it whenever another chat's state came in), so a half-written
  message was lost. Now the input box keeps a draft per chat (a bot, a group, the main bot's
  "Make a wish" box alike, one mechanism) with its caret: switching away keeps it, coming back
  puts it back, sending clears it. Drafts survive a restart in `drafts.json` in the app's folder;
  the page tells the app a moment after typing stops (and at once on switching, leaving the box
  or sending), not on every key. While an input method is composing, only the committed text is
  kept. Attached files and the reply target were already kept per bot. Undo starts fresh with
  each chat's draft, so it never brings back another bot's text.
- **Board tiles go anywhere on the grid, and dragging is smooth.** A tile used to be put before or
  after another and the Board then packed everything toward the left and the top, so tiles
  jumped around and gaps closed by themselves; a drag also measured every other tile on every
  pointer event and a drop moved the tile in the page, loading its component again. Now each tile
  keeps its own cell (`place` in pins.json: its top-left column and row) and a drop puts it on any
  cells it fits, gaps and all. While dragging, the tile follows the pointer by its transform once
  a frame (nothing else is laid out, no component is drawn again, nothing is measured), and a
  ghost snapped to the grid shows where it lands: blue on free cells, amber where it would swap or
  push, with those tiles outlined; near the Board's edge it scrolls. The rule, one for every drop:
  on free cells it goes there; on cells of exactly one tile that fits in the cells it left, the two
  swap; otherwise it goes there and what it overlaps is pushed straight down (and what those then
  overlap). Resizing a tile (its corner and edges, or its size menu) keeps its top-left cell and
  pushes what it now overlaps down the same way. Nothing ever moves up or sideways. A Board saved
  before keeps exactly the look it had: tiles without a place get the cells the packed Board gave
  them, and those are saved the first time the Board is shown. The Add tile follows the last tile
  instead of filling a gap. In a 3 s drag over a 12-tile Board, time in the drag handler per pointer
  event fell from about 0.1-0.4 ms to 0.015-0.06 ms and style recalculations from about 760 to
  about 230 (one per frame instead of one per event).

- **ClaudeCodeBot speaks your language (for 1.14.0).** Settings → General → Language picks
  English, 繁體中文, 简体中文, 日本語 or 한국어; "System default" (the default) follows the Mac's
  preferred languages and falls back to English. The app's own words change at once, without a
  restart: menus, the settings window, the left column and right panel, Codex reviews, the chat
  page's labels and buttons ("Worked · 5 steps", "Open ›", subagent cards, pins, the background-work
  row, the spec panel), placeholders such as "Message <bot>…" and the notices the app writes. What
  bots write, components, file paths and your own data are never translated.
- **Bots reply in the language you picked (a prompt rule change).** Every bot's, temporary team's and
  Codex chat's briefing used to say "Reply in the user's language (match the language of their
  latest message)"; it now says to reply in the language chosen in Settings by default, and still in
  yours when you write in another language. Changing the language tells bots that are already awake
  with their next message. Snapshots take `--language <code>` (or `CCB_LANGUAGE`).

- **A floating pin can show in every bot's chat.** A floating card's ⋯ has "Show in all bots":
  the card then floats in the corner of every chat (Main, project bots, Maintainer, Codex), with a
  small globe and its own bot's name in its header. It stays that bot's pin: its Command runs in
  that bot's folder and refreshes once on its interval, not once per chat, and where it sits and
  its size are kept with it. "Only in <bot>" takes it back to its own chat; unpinning it, stopping
  it floating or removing its bot takes it out of every chat. Cards shown in all bots stack first
  in their corner, then the chat's own, and count toward the two floating cards a chat shows; when
  a chat already has two, "Show in all bots" says which chat has no room.

- **Results go to a claude.ai Artifact by default.** Reports, comparisons, screenshots and
  previews the bots make for you are published as one private claude.ai Artifact page and linked
  in the reply; anything sensitive (secrets, personal data, work you asked to keep local) still
  becomes a local HTML page, and so does a result when the Artifact tool is unavailable. A reply's
  Artifact links show as cards with an Open button that opens them in your browser, where you are
  signed in, and the Results list marks them with a Safari icon. Settings → Permissions → Reports
  and results picks where results go: Artifact with sensitive ones local (the default), always a
  local HTML page, or always an Artifact. Changing it tells bots that are already awake. Bots and
  temporary teams may now use the Artifact tool without asking (not when results stay local).
- **Pick any refresh interval for a pin.** A pin's refresh menu keeps its four choices (When
  shown, Every [15] [min], Every [5] [sec], Only on ↻), and in the two "Every" rows the number
  and the unit are typed right in place, from 2 seconds to 24 hours: Return or leaving the field
  keeps it and checks that row, and clicking the row's words picks it as it shows. The row in the
  pin's unit shows its own interval ("Every [30] [sec]", "Every [2] [min]"), and the pin refreshes
  on it after a restart too. A number out of range or not a whole number is said under the row and
- **Monitors and scheduled wake-ups show in the background-work row.** A bot's Monitor (a watch
  that wakes it on each event) counts as waiting while it watches, with its description and how
  long it has run; it is done when its source ends or its time runs out, an error when its script
  fails. A wake-up it scheduled (ScheduleWakeup, as in /loop) or a cron job (CronCreate) waits too,
  saying when it fires: "20 分後", "每天 09:00 · 18 小時後", "每 30 分鐘 · 12 分後". A fired wake-up or
  one-shot job is done ("已觸發"); a deleted job (CronDelete) or a stopped loop leaves the list. In
  the list each waiting kind has its own mark (an eye, an alarm clock, circling arrows); the row
  keeps its four icons. A bot with a wake-up or cron job pending stays up for it (they live in
  its session), and one cut off by a restart is told about it like other background work.
- **Pick any refresh interval for a pin.** A pin's refresh menu keeps its quick choices (When
  shown, Every 15 min, Every 5 sec, Only on ↻) and adds "Custom…": it opens "Every [n] [sec / min]"
  right in the menu; Set or Return keeps it, from 2 seconds to 24 hours. The pin then says its
  own interval ("Every 30 sec", "Every 2 min"), shown checked in the menu, and refreshes on it
  after a restart too. A number out of range or not a whole number is said under the box and
  nothing changes. The Pin dialog takes the same intervals.
- **All the background work is on the latest message, with subagents on their own.** Instead of
  icons under each reply that started something, the chat's latest message (yours or the bot's)
  carries one row for all of the chat's background work, and it moves down as messages arrive.
  Up to four icons with counts, each only when there is one: subagents still working (a small
  bot head), other work still waiting (an hourglass: background commands), done (✓)
  and failed (✕, also stopped or interrupted). Pressing an icon opens the list grouped by those
  four and filtered to the one pressed, with tabs to see all or another kind; pressing a task
  still shows its last lines of output.

- **Changing a built component is one step, and you can see it happen.** Once a component is
  built, what you type in its panel's "Ask for changes…" is the change: the next version is built
  right away, with no Build press, and Maintainer is told so plainly (it no longer sometimes waits
  for Build). Only a request that could mean two different things gets one question, shown with
  answers to pick; picking one carries the change on. The panel says "Maintainer 正在改…（v3）"
  with the time since you sent it, then "已更新成 v3" once that version is in the library, or why
  it was not made; its steps follow the same version. While a change is under way Build is hidden
  and what you type is queued, shown as such, and sent together as the next version. Rebuilding
  stays as a quiet "重新建置". A draft still waits for Build it, and says so under its box.

- **Float a pin in a corner.** A pin's menu has "Float in corner" / "Stop floating": the pin shows
  as a small card (about 280×160) in the top-right corner over the chat and the Board, in
  whichever bot's chat you are in, so you can watch something live (a release build) without
  asking. Click its head to fold it to one line (title and status); drag it to another corner (it
  snaps); drag its inner corner to resize it. It never covers the input box, and in a window
  narrower than 640px it shows only as that line. It refreshes like the pin (its seconds, or
  `Refresh: every 5s`), keeps a live frame (`ccb.onData`), and reruns only while the window is
  shown. At most two float at once; kept in pins.json (older files still load).
- **"Make into component" starts with a brief from the bot that wrote the reply.** A read-only
  copy of that bot's session (`claude --resume … --fork-session`, its own model, out of the chat;
  the bot is not woken or held up) tells Maintainer what the component is for, your message that
  led to the reply, each data field and whether a command can get it (the exact command) or only
  a bot can (explanations, advice). Without a brief (no session left, or no answer within two
  minutes) Maintainer still gets your message with the reply.
- **Components list their fields in two groups.** about.md has "From command" and "Optional (bot
  only)" fields, the template draws without the optional ones, and a `Board command:` line
  suggests how a command gets the rest; in the chat the bot still fills it.
- **A bot-filled component pinned to the Board becomes live.** Pinning it (also from under the
  reply it was made from) has Maintainer add a Command from its Board command, so the same
  component refreshes on the Board (↻ or its Refresh interval, once you allow the command); until
  then the pin shows the bot's data with "Making it live…".
- **Components keep their own state.** A component can call `ccb.save(data)` to keep new data
  for itself, so a todo list's ticks and new items stay: in the chat message (chat.json) or on
  its pin (pins.json; a pin keeps its own copy), also after a restart. Saving does not answer the
  card, lock it or wake the bot, and the frame is not reloaded; the bot gets each component's
  latest saved data with your next message. A card whose data comes from a command does not
  save (it shows what the command prints). Documented in PLUGINS.md; a sample todo component is
  in `Examples/components/todo`. `ccb.load()` resolves to the data it keeps.
- **Live cards.** A component with a Command can refresh itself: an about.md line
  `Refresh: every 2s` (or a bot's `<show name="x" refresh="2s">`; at least 1s, at most 1h) runs
  the command again every 2 seconds while the card is on screen, pausing when it is scrolled away
  or the window is hidden. A template that calls `ccb.onData(fn)` gets each new data without its
  frame reloading. A pin can also refresh every few seconds (its refresh menu, or "sec" when
  pinning).
- **Bots update a card in place.** `<show name="x" id="build">…</show>` names a card; a later
  `<show>` with the same id replaces that card's data where it is instead of adding a new one
  (a reply with nothing else adds no empty bubble).

### Fixed

- **Doctor shows each CLI's path with ~ for your home folder** (the full path in its tooltip).
- **Logic reads structure, not wording (hardcode audit, Medium: matching, display text, special
  cases, prompts, tests).** A background subagent's id and output file, and whether it went to the
  background, come from claude's structured result (the words only for results without one); a
  subagent's name from its call, not its activity line; a restart's reason is kept typed, not
  parsed back from its divider. memory.md's four sections have one definition shared by the prompt,
  the app and its panels; headings a bot wrote in its own words are read by place, and placeholder
  words ("無", "none") are no longer listed. Tool-result pictures leave no "(image)" line behind.
  A routine's name ends at "Name: " (a task starting with a URL keeps it whole). A component made
  from a reply is no longer matched to a "similar" library one by English keywords: that is
  Maintainer's call. Plugin validation and Codex sign-in go by exit status; the main window is found
  by what it holds, not its title; `engines.ccb` ranges are read as npm semver ranges (upper
  bounds, `||`, hyphen ranges); the Deck migration edits JSON fields, not text; a pin's chip line
  comes from its data's shape, not a list of field names; built-in plugins declare the files they
  bundle in their own build.json; which views a bot gets (Board, specs, settings, reviews) is its
  profile's capabilities. Older component-editor files are known by fixed hashes of what each
  build wrote.
- **Prompt rule changes.** Bots are told memory.md's headings from the same list the app reads and
  to leave an empty section empty (no "none" line). Maintainer's component messages carry an action
  id in their header ("(Component spec <id>; action: change)"), and its instructions dispatch on
  those ids rather than on phrases like "Change it now"; its generic rules no longer name
  github-ci, the 組件使用統計 card or "every commit's whole diff". The design flow (Artifact
  quickstart, intent "design") is worded once for the bots' and Maintainer's prompts.

- **A bot you call in with @ keeps the work in its own chat.** It always answered from its own
  main session, but its own chat showed nothing, so the subagent it sent looked detached. Now its
  own chat and archive keep what it was asked (with the chat it came from) and its reply, with
  the steps and background work of that turn (not counted unread: you saw it where you asked).
- **Limits and tables have one source (hardcode audit, medium: sync, limits, numbers, names).**
  Swift now writes the limits the chat page shares with it (Board sizes and their names, floating
  card bounds, panel heights, refresh intervals, `ccb.save`'s limit, picture extensions, the `/name`
  grammar) into `Web/src/contract.json`; the page reads them from there and `WebContractTests`
  fails when the file is out of date (`CCB_WRITE_WEB_CONTRACT=1 swift test --filter
  WebContractTests` writes it). The menus' "2 floating" and "24 h" words come from those limits.
  One list each for: a task's end state (a "done" or "cancelled" task now counts as ended
  everywhere), the app's own plugin manifests (version and `engines.ccb` from the plugin API),
  plugin permissions and their install words, the folders tools are looked for in (gh is found in
  `~/.local/bin` everywhere; the login shell is the user's own, not always zsh), avatar shapes,
  where chats and components sit on disk (snapshots copy every chat file), Maintainer's status line
  and who can be reviewed, and file types a result window reads as text. Group chats and call-ins
  share one reply handler and one history length. Codex reviews and /share compare with the
  repository's default branch (`origin/HEAD`, else `init.defaultBranch`, else main/master)
  instead of assuming main. Instructions say the real limits (command output and time, Detail
  values, `ccb.save`, Board sizes, project search depth, esbuild now the version the app builds
  with). Named, documented values replace bare numbers: plugin host timings, component-shot waits,
  recent tool calls (the oldest go first instead of all at once), untracked diff lines (the rest
  is counted), the spec panel (a change is matched by its request id, not the clock), the
  network probe (follows `ANTHROPIC_BASE_URL`), the main window for screenshots (the registered
  one, not any window wider than 600), the plugin host's exit (after stdout drains), the viewer's
  KaTeX stylesheet (from ccb-latex's manifest) and test paths (`CCB_TEST_APP`). Developer mode
  guesses the app's source by the running build's commit, not by a name in Package.swift.

- **A call auto mode blocked for a subagent says which subagent asked.** The card used to read like
  the bot's own ("Auto mode blocked `Bash`"), with no sign one of its background subagents made the
  call. It now says "Subagent “<its task>”: auto mode blocked …", with a "Subagent · <task>  Open ›"
  row on top that opens that subagent. The call's owner is read from claude's stream (the tool call's
  `parent_tool_use_id`), not from any wording.
- **Allowing a subagent's blocked call goes to that subagent (an app-to-bot message change).** The
  app used to tell the bot "(App: The user allowed `…` (Bash), which auto mode blocked. It is allowed
  now: run it again as it was, then carry on.)", so the bot re-ran a command that was never its own and
  the subagent never heard. For a subagent's call it now says "…which auto mode blocked for your
  subagent "<task>" (named `<name>`). It is allowed now. It was the subagent's call, not yours: do not
  run it yourself; tell that subagent (SendMessage) to run it again as it was and carry on." "Don't
  allow" names the subagent the same way. The bot's own blocked calls get the same words as before.
- **No empty "Worked · 1 step" bubble after `<no-reply/>`.** A turn the app started (passing an allow
  on, say) that ended with only `<no-reply/>` left a bubble with steps and no words, which looked like
  the bot had stopped. Such a turn now shows nothing, as a background wake-up's `<no-reply/>` already
  did; a turn you started still always shows, and one that left background work running keeps its bubble.
- **Background work no longer wakes empty bubbles.** When a subagent stops while still waiting on
  its own background work (or reports something interim), claude starts a turn of the bot's own;
  its "(still waiting…)" reply used to show as a bubble each time, with the background row jumping
  under it. A turn the bot starts itself (a background task's notification woke it, even one that
  came while it was busy) may now answer just `<no-reply/>`: no bubble, nothing unread, and the
  background row stays on the reply that started the work while its chips still update. Bots are
  told to answer that way when a notification has nothing new for you and to report real news as
  usual. A turn you started always shows (the tag is just taken out). A notification without its
  tool call is no longer dropped.
- **The app reads what Claude Code reports, not its wording.** Four things depended on matching
  Claude Code's English sentences, so a reworded message would silently break them; they now read
  the structured fields Claude Code sends alongside:
  - Scheduled wake-ups, cron jobs and their cancelling come from each call's structured result
    (when it fires, the job id, a stopped loop), not from "Next wakeup scheduled…" or "Cancelled job…".
  - A call auto mode blocked is recognised by the result's own kind ("automode-blocked"), so a check
    that gave no verdict never shows a permission card, whatever the words. The words are still
    read for the reason shown and for subagents' calls, which carry no kind.
  - A turn or subagent lost to the network is recognised by an API error with no answer from the
    API (no HTTP status), not by keywords such as "timeout" or "network"; "Connection lost
    mid-response" now counts too, and a refusal by the API's safeguards no longer looks like one.
    Keywords remain only for a process's stderr and a background subagent's report.
  - A component request is closed only by Maintainer's explicit answer to that request's id
    (`<component-declined id="…">`), or by the component arriving or changing. A reply that merely
    named the component ("still looking into toast") used to close it and tell the bot Maintainer
    would not do it.
- **Finished background work is cleared when you write again.** Done, failed and stopped work
  (the ✓ and ✕ counts) piled up and carried over to every new message. It now stays only until
  your next message; what is still running carries over to the bot's newest reply. Replies before
  your latest message also stop showing their finished subagents' cards while folded (unfolding
  still lists them), so an old "Stopped" card no longer sits next to the new one.
- **The background row never jumps under your own message.** Sending a message briefly moved the
  row (e.g. "✓ 2 ✕ 1") under your bubble; it now goes only under the bot's latest reply.
- **The stop guard catches a next step the bot says it is starting.** A reply ending "下一步照先前
  說好的，開始做 1.14.0 的多國語言。" ended the turn without the work: Haiku read it as a mere
  suggestion. Haiku's instructions now say a next step the bot states it is starting is a promise
  even right after a report of finished work, while a question, an offer ("要做的話跟我說"), or
  work already handed to a background task or subagent that will report back is not; Haiku now
  names what work is left and who will do it before it answers.
- **A card's slow scan finishes when you open another chat.** A card whose button runs its
  component's Detail command for fresh data (the disk usage card's 重新整理, a scan of about a
  minute) seemed to stop when you switched chats: the scan's result went only to the card's page,
  never into the card, so coming back showed the old data and Ran time (2.3 GB free instead of
  27 GB), even when the scan had finished and the card had updated before you left. A template now
  calls `ccb.runDetail(values, {save: true})` for such a button: the result becomes the card's
  data, kept on its pin or spec too, the card shows it running (in the chat, on the Board and
  pinned), it finishes into the card wherever you are meanwhile, and pressing it or ↻ again while
  it runs starts no second run.

- **A floating pin shows only in its own bot's chat.** A pin floated in one bot's chat (say,
  ClaudeCodeBot's release progress) also floated over every other bot's chat, the main bot's
  included. It now floats only where it was floated, unless shown in all bots, and the two-card
  limit is per chat.

- **A floating pin and an opened pin look the same, and fit their content.** Both now have one
  header: the component's icon, its own name from its about.md ("發版進度卡", not the folder name
  "release-progress"), its status, ↻ and ⋯ (and collapse above the input box), with the same
  spacing, type, border and corners. Both are as tall as the component's content, up to a limit,
  and scroll past it, so a short component no longer leaves an empty area under it; a height you
  dragged an opened pin to is now that limit. A floating pin is wide enough by default for a card
  to show its full layout instead of its compact one (as wide as the window allows); one you
  resized keeps its width, and its height becomes its limit. Board tiles are unchanged.

- **A long chat redraws faster while a bot works.** Each update the page compared every message
  that shows a component against the whole components text (~180 KB) again; a 500-message chat
  spent 25-45 ms of every streamed step on that. It now compares the components once per update
  (a step or a new reply redraws in about 10 ms there).
- **Step pictures take less room and load when you look.** A big screenshot a tool call gave
  back is kept as JPEG when that is clearly smaller (PNGs with see-through parts stay PNG), with a
  small copy (640 px) that the step shows; clicking it opens the full picture. A step's pictures
  load only once you open it, so opening a chat no longer reads every screenshot in it. Pictures
  kept before are converted once in the background (in a test copy: 30.9 MB of step pictures
  became 22.9 MB, plus 5.0 MB of small copies).
- **A chat with many components opens without freezing.** Every component in a chat's history
  was built when the chat opened, so a 500-message chat with 16 components froze for about
  3 seconds before the first one showed (and again on each switch back to it). A component in the
  chat is now built only once it scrolls within about 1500 px of view; until then it holds its
  place at the height it last had (remembered across launches), and one above the view that grows
  keeps what you are reading where it is. In that chat, opening it now freezes for about 0.2 s,
  and a component at the bottom shows in about 0.5 s. Pins, the Board and floating pins are built
  at once as before. A command card in the history no longer runs its command when the chat
  opens; it runs once you scroll near it, and its `refresh` waits for that too.
- **Web page preview cards show a picture instead of running the page.** Every 「網頁預覽卡片」
  loaded its whole page (scripts, charts, video) in the chat each time it was drawn. The app now
  takes a picture of each page once, offscreen and one page at a time, and the card shows that;
  the page itself runs only when you open it. A page written again gets a new picture, and until
  a picture is ready the card shows the page as before. Pictures are kept in the app's caches
  folder (at most 400). A preview card nobody edited is updated to the new one.
- **A streaming reply sends the chat only what changed.** Each update while a bot worked sent the
  page the whole chat (every message and all components' text, some 180 KB of it alone), which
  the page then parsed and compared message by message. Now only the messages that are new or
  different are sent, and the rest are kept as they were; components and the chat's other state
  are sent only when they change. While a bot works, the chat is updated at most ten times a
  second, always with the latest state.

- **A Board card can be dropped between two others.** While a card was dragged, the others
  jumped as soon as the pointer touched one, and a card it had just passed over was ignored when
  the pointer came back, so after overshooting there was no way to land between A and B. The
  others now stay put while you drag, a blue line in the gap shows where the card will go, and
  letting go puts it there: over a card's left half (top half in one column) before it, over its
  right half after it, and over a gap beside the nearest card.

- **Board cards move and resize with the mouse.** A card was moved by HTML drag and drop from
  its small grip, but its component's frame covers the whole card, so the drop landed in the
  frame and the card never moved. A card is now dragged with the pointer, by its grip or a grab
  bar along its top edge: it follows the mouse, takes another card's place as you pass over it,
  and stays there. Besides the corner, a card's right and bottom edges resize it one way, still
  cell by cell from 1×1 to 4×4. A moved card keeps its component instead of loading it again.

- **A new component reaches the bots with its usage.** Maintainer's editor writes a component's
  template.html first and its about.md seconds later; the library picked the folder up in
  between, so every bot was told "Components were updated" with an empty usage for it (and the
  bot that asked for it was woken with nothing to go on), and when about.md landed nobody heard
  again. A new component now joins the library once its about.md is there (or after a minute
  without one), and an about.md that arrives late counts as a change.

- **Maintainer reports in plain words.** After building a component a bot asked for, Maintainer
  wrote to you about versions, tags, script checks, guessed APIs and pixel sizes, without saying
  where the component was. Its report is now one or two plain sentences: what it made and where
  you will see it (handed back to the bot that asked, which shows it in its own chat); a doubt is
  mentioned only when you need to do something about it.
- **What a button does no longer depends on what it says.** Whether "Always allow" on a tool
  question or a blocked call saves a permanent allow now comes from the button's own action
  (allow once, always allow, don't allow), carried with it to the page, instead of its wording, so
  renaming or translating the buttons cannot change a permission. A component spec's samples
  carry what they are (test run, this reply, this page): which one the preview shows first is
  decided once, in the app, and a sample of Maintainer's that happens to be called "Test run" is
  no longer overwritten by a run; specs saved before keep working. A routine's time picker shows
  for any every-day routine by reading its schedule, not its description, and a group chat says
  who did not answer by what went wrong, not by the "(busy)" words.

## 1.11.0

### Added

- **A bot can't end its turn on a promise.** Every bot now has a Claude Code Stop hook (only in
  the `--settings` the app passes it; your own settings files are untouched). When a turn is
  about to end, the app (`ClaudeCodeBot --stop-guard`) has Haiku read the last reply; one that
  promises work nothing will trigger ("接下來我會確認…", "I'll check and report back") sends the
  bot back to do it now, or to start a background task that will wake it. Replies that ask you
  something (a `<choices>` block included), and turns with background tasks or subagents still
  running, end as before without the check; a stop the hook already sent back once is never
  sent back again, and any error or a check slower than 15 seconds lets the turn end. The check
  runs Haiku without tools or hooks, adds about 6–8 seconds to the end of each turn, and costs
  about $0.0003.
- **Replies show as soon as they are written, not after the Stop hook.** A bot's reply now
  appears the moment its last message ends (claude's `stop_reason: "end_turn"`, read from
  `--include-partial-messages`), about 7 seconds before the stop guard lets the turn end; the bot
  shows as working until then. When the guard sends it back to do the work, what it then says
  comes as a second reply. Notifications to other parts of the app (tags like `<team>`, a
  finished component, the handoff report) still happen once, when the turn really ends, and
  what you write in those seconds waits for that end instead of interrupting it. Turns whose
  reply a plugin's `afterReply` hook changes still show at the end.
- **Release planner: vote on shared features with 👍, and pick the next version.** With
  developer mode on, Settings → Release planner lists the open PRs labelled
  `community-feature`, most 👍 first (other reactions are not votes; a tie puts the older PR
  first), read with `gh pr list` in the developer project's folder. The 👍 button on a row is a
  vote: a 👍 reaction on that PR as you, seen on GitHub too; clicking a title opens the PR. The
  repo's owner (admin or maintainer, from `gh repo view`) also gets a checkbox per PR and a
  "Next version" row: "Send to <project>" hands the picks to the developer project's manager,
  which merges each one whose tests pass, writes the release notes under Unreleased, and brings
  back any that conflict or fail. Picks are kept in `release-plan.json`, and PRs no longer open
  drop out. Without gh or a sign-in it says what to run. `CCB_RELEASES_SNAPSHOT=out.png` draws
  it with sample PRs (`CCB_RELEASES_OWNER=0`: as a voter).
- **Share a feature you built with /share (developer mode).** In the chat of the project that
  is ClaudeCodeBot's source, /share lists your features (local branches with commits upstream's
  main lacks) and checks the one you pick: up to date, a privacy check for keys, tokens and your
  home folder's path in what it adds, and a GitHub fork as origin. When nothing fails, "Open pull
  request" pushes the branch to your fork and runs `gh pr create` to william1010121/ClaudeCodeBot
  with the `community-feature` label (left for the owner to add when you may not), so others can
  vote on it with 👍. `/share <branch>` goes straight to that branch's checklist.
- **Pin bots to the top of the left column.** Right-click a project or bot and choose Pin (or
  Unpin), or click the pin glyph that shows at the row's end on hover. Pinned rows sit in a
  "Pinned" section above Chats, in the order they were pinned, and come first in the folded
  strip (⌃⌘S) too, with a short line under them. Pins are kept in settings.json
  (`pinnedBots`) across launches; a removed bot's pin is dropped, and so are ids of bots that
  are gone when the app opens.
- **Search bots (⌘K).** A search field at the top of the left column keeps, as you type, the
  rows whose name or project folder name contains what you typed (ignoring case and accents);
  Enter opens the first, Esc empties it and puts the cursor back in the input box. Nothing kept
  says "No bots match". ⌘K works from anywhere, the input box included, and opens a folded
  column first. `CCB_RAIL_PINS_SNAPSHOT=out.png` draws both.
- **Drag to resize pinned components; components lay themselves out for any size.** A Board tile
  shows a handle over its bottom-right corner on hover: drag it to any size from 1×1 to 4×4 cells
  (snapping cell by cell, no wider than the Board's columns), and the tile and its component follow
  the drag. A pin opened above the input box has a grab bar along its top edge: drag it taller or
  shorter (double-click: back to its content's height), and the component then fills that height.
  Both are kept per pin in pins.json (`size` is any `WxH` up to `4x4`; the old `s`/`m`/`l` and the
  five fixed sizes still load; `panelHeight` for the panel). The size button and ⋯ menu offer every
  size as a 4×4 picker, with the sizes an about.md `Sizes:` line names marked as hints; that line
  is now optional and only sets the size a new pin starts at. Components are told their real size:
  `ccb.size` is `{w, h, name, px: {width, height}}` (`name` the nearest of small, wide, tall, large,
  xlarge, so `<html data-size>` templates keep working), `ccb.onSize` runs on every resize (cells
  or pixels, while dragging too), and `#ccb-root` is a CSS container (a size container on the Board
  and in a sized panel), so container queries and plain responsive CSS just work. The component
  editor's instructions (ComponentPrompts), PLUGINS.md and the Maintainer now ask for one responsive
  layout (CSS grid auto-fill columns, container queries, a summary when short, the key number when
  tiny) instead of a layout per size. `CCB_SNAPSHOT_JS` runs a script in a `--snapshot` page before
  the picture is taken.
- **A bot hears back about the component it asked for.** Once Maintainer builds a component a bot
  asked for with `<component name="…">`, hands over one already in the library (`<give-component>`,
  or the app does so at once when the library has it), or changes one the bot already has, the bot
  is woken with the component's usage and what the user had asked it, and answers that with
  `<show>` from its own data; its chat gets a short line ("Maintainer added 今日對話次數 (…) to
  your components."). When Maintainer replies naming the request without doing it, the bot is
  told what Maintainer said and tells the user, instead of waiting. A request made while the bot's
  list is full arrives once one is taken off. A new version of a component made from a reply
  (Build it) is filled again by the bot that wrote the reply, its old data set aside meanwhile.

### Fixed

- **A component made from a reply stops spinning once it is built, and lines up with the reply.**
  When Maintainer handed the build to a background agent, the component landed (and was added
  to the bot) while Maintainer's turn went on, so its preview under the reply kept a spinner
  until Maintainer replied again (and the name it started under was never cleared when the
  build was renamed). A spec's component is now marked done the moment it is in the library,
  under both names. The reply's bubble now spans the column like the
  component's tile under it, so the two share one right edge instead of the bubble stopping short.

- **A component made from a reply is filled in by the bot that wrote the reply.** A reply
  listing 12 features made into a component showed only 4 of them under it: Maintainer wrote the
  data as a short example. Now Maintainer's first-version request starts with what the component
  is for, in the asker's own words (a bot's `<suggest-component>` text, or what the user typed),
  with the reply after it as context, and Maintainer builds only the component (template.html,
  and about.md with its data format), no data sample. Once it is in the library and added, the
  app asks the bot that wrote the reply, in a quiet app turn, to draw it for that reply with
  `<show name="…">`, from its own reply in full; that answer is not a new message, its `<show>`
  becomes the reply's component. The turn waits until the bot is free (nothing it is doing is
  interrupted; what you say meanwhile waits for it). The chip under the reply says "Filling in ·
  <bot>" meanwhile, and the spec's steps gain "Filled by <bot>". Components with live data (a
  Command) work as before. `CCB_SPEC_STATE=filling|filled` draws both.

## 1.10.1

### Fixed

- **A restart no longer costs each bot a handoff turn.** A plugin update, a model, effort or
  subagent-model switch, auto mode and a folder Maintainer may read used to make every awake
  bot write a handoff into memory.md, stop, and spend another turn reading it back on a new
  session. Now the bot is only marked; just before its next real message (yours, a relay, a
  group turn) it stops and goes on in the same conversation with `claude --resume <session>`
  (on the new `--model`, plugins and settings), then gets the message: no handoff, no memory
  read back, and the prompt cache stays warm. An idle bot costs nothing, and several changes
  make one restart. As before, it never restarts while a turn runs, a question waits or a
  subagent works in the background (a model switch no longer ends them either); the message
  then goes to the running process and the restart waits for a later one. `--resume` keeps the
  session's first system prompt (a new `--append-system-prompt` is ignored; checked with claude
  2.1.304), so the message after a restart carries the wake briefing as it is now (components,
  projects, Codex rules). Without claude's transcript of the session
  (`~/.claude/projects/…/<session>.jsonl`) it falls back to the handoff, which now also carries
  that briefing; if claude exits when resumed, the message wakes a fresh session that reads
  memory and the recent chat. The divider says "Restarted → …" for a resume, "Handoff → …" for
  the fallback.
- **The app and Maintainer no longer fight over component-editor.md.** Every launch rewrote
  `ccb-core/claude/agents/component-editor.md` whenever it differed from the app's text, so an
  edit by Maintainer was undone, the plugin changed, and every awake bot handed off (twice).
  The app now remembers what it last wrote (`~/.claudecodebot/component-editor.json`) and
  writes the file only over its own text (or 1.10.0's); an edited file is left alone and
  Maintainer's chat asks once per edit: "Keep the edited version" or "Use the app's version".
  Maintainer is told not to edit the file. Its model is a setting (Settings › Plugins ›
  Component editor: Haiku, Sonnet or Opus, default Sonnet) instead of a fixed Haiku, and its
  prompt gains Maintainer's "Make it look good" line. Plugin changes count by what a Claude
  part's files hold, so a file written again with the same bytes, or a change outside the
  Claude part (package.json, the web part), restarts no bot.
- **A call auto mode blocks gets a permission card instead of "edit your settings file".** When
  Claude Code's auto mode classifier refuses a bot's tool call ("[Irreversible Local
  Destruction]", "[Self-Modification]"…), the bot's chat now shows the usual card for that very
  call: the command, file or site, and the classifier's reason, with "Allow once", "Always allow
  this command" (or this file, this site) and "Don't allow". Allowing it adds a permission rule
  for exactly that call to the running session (`apply_flag_settings`) and tells the bot to run
  it again; "always" keeps the rule for the bot (listed with its always-allowed tools in Settings,
  passed in `--settings` from then on). "Don't allow" tells the bot to carry on without it. The
  app reads claude's `permission_denied` frame, or the tool result's wording on older versions;
  deny rules, safety checks and the classifier's "no verdict" get no card. Bots are told not to
  ask you to edit `.claude/settings.local.json` for a blocked call.
- **An open question's buttons show at once instead of a folded "Answered".** The app leaves an
  unanswered question's empty answer out of what it sends the chat, and the chat took that for
  answered, so a new question (a permission card among them) showed folded until clicked.

## 1.10.0

### Added

- **Pins above the input box are small status icons.** Each pinned component's chip is now its
  icon with a short status beside it (a count, a temperature, a hash; about 14 characters) and a
  coloured dot for its tone, with its name and whole summary line in the tooltip; chips are 28px
  tall and at most 132px wide, so several fit on a row. A component gives its icon with an
  about.md line `Icon: chart.pie.fill` (an SF Symbol, drawn by the app and tinted like the chip)
  or `Icon: 📊`; without one the chip has a generic widget icon. A pinned copy (its sheet or Board
  tile) sets its chip with `ccb.setStatus({text, tone})` (tone `good`, `warning`, `bad` or
  `neutral`; `null` clears it), kept in pins.json; without it the chip shows its summary cut
  short. A command waiting for your OK shows "Allow?", a failed one "Failed" in red.
  ComponentPrompts (the component editor), PLUGINS.md and the Maintainer describe both.

### Changed

- **Components in the chat are wide and frameless, like a Board tile.** A reply that shows a
  component (`<show>`, a command's card, a result page's preview) now takes the whole message
  column instead of shrinking to a narrow card, and the component runs edge to edge across the
  bubble, which is its frame: a command's card loses its border, and the report flag floats over
  the component's bottom-right corner on hover instead of taking a column beside it. A component
  made from a reply ("Make into component") is drawn under it the same width, on a tile of its
  own. In the chat a component is drawn at its widest size: the widest in its about.md's `Sizes:`
  line (4×2 when listed; of two as wide, the taller), still 2×2 without the line. It is told so
  with `ccb.size`, `<html data-size="4x2">` and `ccb.surface` / `<html data-surface="chat">`.
  ComponentPrompts (the component editor), PLUGINS.md and the Maintainer now say a component
  draws no card of its own in the chat either (no border, background or radius, at most about
  12px padding), only as tall as its content there. With the Board, an opened pin and the chat
  all frameless, they give one rule for every surface: `.card { border: 0; background: none;
  border-radius: 0; padding: 12px; box-sizing: border-box }`, plus
  `html[data-surface="board"] .card { height: 100% }` to fill a Board tile.
- **An opened pin is its component, like a Board tile.** Clicking a pin's chip above the input
  box no longer shows a card in a card: the header row (name, command, "Updated 3:32", ↻, ⋯,
  collapse) and the padding are gone, the component's frame fills the panel and its rounded
  corners clip it. ↻, ⋯ and collapse float over the top-right corner as a small pill on hover or
  keyboard focus (and while its command runs); the ⋯ menu starts with the name, when it last ran
  and its command. Components are told: `ccb.surface` is `"pinned"` and
  `<html data-surface="pinned">` there, and the page stays as tall as its content.
  ComponentPrompts, PLUGINS.md and the Maintainer say to draw no card of one's own there either.

### Fixed

- **A component in a reply sits inside its bubble.** A reply showing a component, a command's
  card or a result page's preview pulled it 16px past the bubble's padding on both sides, so the
  preview card (held to 480px) stuck out past the bubble's left edge and rounded corner and left a
  gap on the right. Each now spans the bubble inside its padding, inset like the text on both
  sides, with its frame rounded (12px); the preview card fills that width (an unedited shipped
  card is upgraded), a command card's header lines up with the text, and a component made from a
  reply is inset 16px in its tile the same way. The wide reply also reaches the input box's right
  edge: its Reply / Make into component buttons float over its top-right corner on hover instead
  of taking a column beside it.
- **An opened pin's controls no longer cover its content.** On hover the ↻ ⋯ collapse pill
  sat over the component's top-right corner, hiding the first row's right-aligned time, and the
  report flag hid the last row's time at the bottom right. The pill now shows just above the
  panel's top-right corner, and Report this component… is in its ⋯ menu instead of a flag. The
  panel's body clips the component to its rounded corners (with clip-path, which WebKit needs for
  a frame), so the bottom-left corner's border no longer looks broken.

- **A plugin update no longer cuts off a bot's background work.** When a plugin's Claude part
  changed (Maintainer editing ccb-core, say), every awake bot handed off and restarted as soon as
  no turn was under way, even with a subagent still at work in the background, which ended that
  subagent; and the changed part dropped out while it was checked again, so one edit made two
  handoffs (the first without the plugin at all). A bot now waits until it is free — no turn and
  no subagent at work — and loads the new plugins once, however many changes came in meanwhile;
  a part being checked is not a change of its own; and a bot whose session already has the
  current plugins does not hand off.
- **A narrow window no longer cuts off the left column or the right panel.** The rail, the chat
  and the right panel always add up to the window's width: a panel that wants more room than is
  left (Make into component spread wide in a half-screen window) narrows, down to 340pt, then
  the chat gives up some of its 480pt, instead of the whole window's content running off both
  edges. Spread wide but squeezed below 720pt, the component panel stacks Preview above its
  progress, as when narrow. Chat | Board now sits in a bar of its own above the chat, so
  messages no longer scroll under it.
- **A bot waiting on a background subagent no longer keeps saying "still running".** A subagent
  that watches its own long job (a Monitor, a background command) stops each time that job
  reports, and claude then wakes the bot with "is waiting on its own background work" — every
  30 seconds or so. Each wake was a turn of its own whose few words ("Still transcribing.")
  showed as a new reply. Such a turn now shows nothing and leaves nothing unread; the subagent
  stays running in its card until it really reports, and that report, or anything you ask in
  between, still gets its answer.
- **A component made from a reply shows that reply.** Make into component took the last shell
  command the bot ran while writing the reply (such as `head -c 200000 CHANGELOG.md`) as the
  component's data source, and Maintainer saw only the reply's first 1,500 characters, so a reply
  that summed up every release in Chinese became a card of the raw English CHANGELOG. Now
  Maintainer gets the whole reply and the words of each result page it links (up to 12,000
  characters each), and is told the reply's own content is the data: all of it goes in the
  "This reply" sample, drawn under the reply and in Edit spec's preview. A Command is optional,
  only when live data that changes is clearly wanted; the command the bot ran is passed as a hint,
  and a component whose about.md has a Command no longer runs it under a reply whose spec has none.
  The component editor and PLUGINS.md say a Command is only for live data.

## 1.9.0

### Added

- **The Board is a widget grid.** Like home-screen widgets, the Board is split into square cells
  (as many columns of at least 150px as its width holds, rows as tall as a column is wide, so
  about 150–170px; fewer columns in a narrow window, never wider than it) and each pinned card
  takes 1×1 small, 2×1 wide, 1×2 tall, 2×2 large or 4×2 extra wide (as many columns as there are,
  when fewer). Cards pack densely, the Add component tile is one cell, and a card's size button
  (and its ⋯ menu) offers the sizes its component has a layout for. The old S, M and L become 1×1,
  2×2 and 4×2; a new pin starts at 2×2, or the component's first size when it has no 2×2.
- **A Board tile is its component, like a widget.** The header row (name, size, "Updated 10:42",
  ↻, ⋯) and the padding are gone: the component's frame fills the whole tile and the rounded
  corners clip it. Its controls (a grip to drag it by, the size, ↻ and ⋯) float over the
  top-right corner as a small pill on hover or keyboard focus, and stay in sight while its
  command runs; the ⋯ menu now starts with the name, when it last ran and its command, and the
  arrow keys and Escape work in it. Allow and run, a failed command and the wait still fill the
  tile without hovering. Components are told where they are: `ccb.surface` is `"board"` and
  `<html data-surface="board">` on the Board (`"chat"` in the chat), and there the page is the
  tile's height. ComponentPrompts, PLUGINS.md and the Maintainer say a component on the Board
  draws no card of its own: no border, background or radius, at most about 12px padding, and
  it fills the tile.
- **Components lay out per size.** about.md may say `Sizes: 1x1, 2x1, 2x2` (missing: 2x2 only).
  The template reads `ccb.size` (`{w, h, name}`, name `small`, `wide`, `tall`, `large` or
  `xlarge`), `<html data-size="2x1">` for CSS, and `ccb.onSize(fn)` hears a resize; the card keeps
  its frame when resized. In the chat a component is drawn 2×2 (or its largest size). Maintainer,
  the component editor and PLUGINS.md say to give each size its own layout: small the one key
  number or status, wide a short row or list, tall a vertical list, large the full view.

- **What a bot says between tool calls folds with its steps.** A finished reply shows only its
  final answer, under one folded "Worked · 2 notes · 4 steps" line. Opened, the bot's words before
  and between tool calls show as its own quieter text (markdown), in order, with each run of tool
  calls between them folded to a "3 steps" chip that opens to those calls, and a hairline sets them
  off from the reply; each reply remembers whether you opened it. While the bot works, the whole
  process stays in sight (earlier calls fold, the ones under way show) and folds once the turn
  ends. A turn that said nothing between calls keeps the single "Worked · N steps" line. The same
  holds in saved chats, and in group chats and called-in bots, whose replies now keep their steps
  and show them live as well.
- **Components load details on demand.** A component's about.md may add a line
  `Detail command: git show --patch --stat {hash}` beside its `Command:`. The template then calls
  `await ccb.runDetail({hash: "2aed630"})`, which runs that template in the same folder as the
  Command, with the same 60-second limit, 1 MB cap and stopping of everything it started, and
  resolves to the output (parsed when it is JSON, else the text) or rejects with an Error saying
  why. So a component like 提交紀錄 lists commits up front and fetches one commit's diff when it is
  opened, instead of embedding every diff and going over the limit. Each `{name}` is filled with
  one single-quoted argument that may hold only letters, digits and `. _ / -` (at most 200, not
  starting with `-`); a missing or extra value is refused. The card's **Allow and run** shows and
  allows the Detail command along with the Command; one that is not allowed, or whose about.md
  line changed since, never runs (the card asks again), and it can be taken back in Settings →
  Permissions. Maintainer and the component editor are told how to use it.
- **Settings → Doctor checks Claude Code and Codex.** A new section in the settings window
  shows, for each CLI, a green, orange or red dot, its version, where it was found (the same
  lookup bots use), how it is signed in (`claude auth status`, `codex login status`; no tokens
  spent) and the latest version on npm when online. Claude Code needs 2.1.111 or later
  (`--effort xhigh`), Codex 0.99.0 or later (`codex exec --ephemeral`). When something is wrong
  a one-line fix (`npm i -g …@latest`, `claude update`, `claude auth login`, `codex login`) can
  be copied. Every check runs off the main thread with a 10-second limit; **Run again** repeats
  them. At launch a quick local check puts a red dot on the gear if Claude Code is missing, too
  old or signed out.
- **Markdown files open formatted.** A `.md` or `.markdown` file opened in its own window
  (a result, an attachment) is drawn with the chat's Markdown and LaTeX instead of as raw text:
  headings, lists, quotes, tables, code, `$…$` and `$$…$$` typeset, links opening like the
  chat's, pictures beside the file shown. Raw HTML in the file is shown as text, never run. The
  **Source** button at the top right shows the text as written. Files in Big5 read right too.
- **Fold the right panel into a strip of icons.** The button at the window's top right (or
  ⌃⌘I) shrinks the right panel to 56 points, the mirror of the left one: the bot's face with
  its status dot (hover for what its Now card says), then an icon per section it would show
  (Waiting on you, Codex review, Results and Settled with a count), and the bot's settings at
  the bottom. Click an icon and that section pops out beside the strip; the chat does not move.
  The choice is remembered, and other views can fold it for a while without changing it.
- **Each bot has its own components.** Every component sits on Maintainer's shelf (the shared
  library, no longer capped); each bot has its own list of at most 20, kept in its `bot.json`.
  A bot's wake-up briefing has the full usage only of its own components ("N / 20 yours") and
  one line for each of the others, so it knows they exist. Asking with `<component name=…>`
  now says which bot asked: one already in the library goes straight onto that bot's list;
  otherwise Maintainer first looks for a suitable one (`<give-component bot=…>`), else builds
  it, and the app adds it to the asker's list once it lands. A bot at 20 gets nothing new until
  the user picks one to take off its list (`<take-component bot=…>`). A `<show>` of a library
  component the bot lacks still draws, and adds it to the bot's list while there is room. The
  usage card's delete button ("刪除組件：name") now takes the component off that bot's list
  only; deleting it from the library is up to Maintainer. The / menu offers the bot's own
  components first, then the library's, marked "library". On the first start existing bots
  get the components they have used (by `component-usage.json` and the cards in their chat)
  plus choices and 網頁預覽卡片.
- **Pin components to a bot.** Hover a component in the chat for pin, ↻ and ⋯. Pin asks how it
  should refresh (when shown, every N minutes, or only when you press ↻), shows the command that
  redraws it, and offers Undo. The + chip opens a picker of the components this bot has drawn,
  then its own others that have a Command (those with a Command are marked; the others pin as
  their last drawing). Pins are kept per bot
  in `pins.json` beside its chat, with their order, size, refresh and last output. A pinned
  command runs only once you have allowed it for the bot's folder, as in the chat.
- **Pinned chips above the input box.** One chip per pin with a one-line summary of its data;
  click it and the full component rises from the bottom (↻, ⋯, Esc to close). Drag chips to
  reorder; right-click one to unpin, move it or change how it refreshes.
- **Board view per bot.** Chat | Board at the top of the chat (⌃⌘B) shows every pin as a card,
  sized S, M or L, with Refresh all, Add component, drag to reorder, and ⋯ to resize or unpin. A
  slim input box stays at the bottom, and the right panel folds to its strip while it shows.
- **Make a reply into a component.** A bot reply's hover column has "Make into component"
  between Reply and Not right (an HTML result card has it in its hover toolbar). Pressed, the
  reply goes to Maintainer, which infers the spec and builds the first version right away, with
  no questions (its best guesses), or reuses a library component that already fits; it goes on
  that bot's list. Under the reply a quiet chip says "Building… · name", then the finished
  component itself shows there; the chat says where it went. The right panel does not open by
  itself: the component's **Edit spec** opens its workspace there (live preview with switchable
  sample data, data fields, command with Test run and its output checked against the fields,
  folder, refresh, bots, a similar library component, "Anything to add?" and a side conversation
  with Maintainer; your edits blue, Maintainer's purple), and Build it there makes a new version.
  A reply that already is a component says "Add to another bot…" and opens the panel to pick
  the bots. Nothing runs by itself: a component whose command you haven't allowed in that folder
  shows the usual inline "Allow and run" with the exact command and folder, and Test run goes
  through the same allow flow. Specs are kept per bot in `specs.json` beside its chat.
- **Bots may suggest a component.** A bot can end a reply with
  `<suggest-component name="…">short draft</suggest-component>` (now in the bots' prompt rules);
  the app only adds a "Suggested component · name ›" chip. Nothing runs or is built until you
  press it; then its first version is built as above. Maintainer answers with
  `<component-spec id="…">JSON</component-spec>`.

### Fixed

- **Choice buttons no longer go missing when a bot keeps working after asking.** A reply made of
  several parts (words with `<choices>`, then a tool call such as saving its memory, then a short
  last line) showed no buttons: claude's result holds only the words after the last tool call,
  so the question in the earlier part was lost. Every app tag in the turn's earlier parts
  (`<choices>`, `<show>`, `<component>`, `<team>`, `<new-bot>`, `<plugin>`, `<install>`,
  `<install-build>`, `<new-project>`, `<need-folder>`, `<app-screenshot>`, `<open-question>`,
  `<codex-review>`, `<give-component>`, `<take-component>`, `<suggest-component>`,
  `<component-spec>`) now counts as part of the reply, in chats, group chats, call-ins and
  handoffs: one choices card at the end of the reply (the last block wins when there are
  several), requests acted on, and the step list keeps the words without the raw tags, so the
  saved chat and archive match what was shown and a pick goes back to the bot as usual.

## 1.8.0

### Added

- **Component usage is counted.** Each component card made for a new message (a bot's
  `<show>`, a `<choices>` block, a linked result page's preview card) adds one use to
  `~/.claudecodebot/component-usage.json`, with the bot and time, so rarely used components can
  be found. Reopening or redrawing a chat does not count again.
- **A quieter / menu and at most 20 components.** A bare "/" offers only the app's commands;
  components show once you type a letter after it, in up to 5 small, flat rows without tags.
  Maintainer makes no new component when there are already 20; it asks which one to delete
  first, and bots see "N / 20 installed". More than 20 already there still all load.
- **Fold the left column into a strip of faces.** The button beside the window's lights (or
  ⌃⌘S) shrinks the bot list to 56 points: faces only, a dashed ring while one works, an
  orange ring and "!" when its connection is stuck, an orange dot when it waits on you, a blue
  dot for unread lines. Hover a face for its name and status; the choice is remembered.
- **Tool steps show pictures.** When a tool call gives back an image (a Read of a .png, a
  screenshot), the step's OUT box shows it, fit to the box's width; click it to see it full
  size. The bot keeps the pictures as files beside the chat, so chat.json stays small.
- **Pick what Codex reviews.** "Review with Codex" asks first: uncommitted changes, the last
  commit, the branch against main or master, or one of the last 10 commits, and optionally a
  spec file (.md, .txt, .html; the bot's latest pages are offered) that Codex checks the change
  against point by point. The card says what was reviewed ("main...feature · 3 files · spec:
  plan.md") and Codex's verdict in a line or two; Run again keeps the scope and spec. With no
  changes in the scope Codex does not run and the card says "No changes to review", not "Clean".
- **Components can start a Codex review.** `ccb.reviewWithCodex({scope, commit, spec})` reviews
  the chat bot's repository once; the app checks the commit and spec and ignores a bad call.

### Fixed

- **The / menu is wide enough to read.** It was a narrow box that cut a command to "/des…"
  and its description after a few words. It is now about 360 points wide, up to the composer's
  width, with each name whole and its description on a second faint line that wraps.
- **Tables size their columns by what is in them.** A short column (a version, a name) gets
  its natural width, up to 40%, before a long text column takes the rest, and a cell never
  breaks inside a word, so "v1.6.0" no longer wraps as "v1. / 6. / 0". Cells line up at the top.
- **Choices after a handoff are buttons again.** The reply a bot gives right after a handoff
  (switching model or effort, loading new plugins) showed its `<choices>` block as plain text;
  it is now read like any reply, so the choices are buttons and `<show>` components are drawn.

## 1.7.1

1.7.0 was tagged but never published as a GitHub Release, so 1.7.1 is the first release with
its features: see [1.7.0](#170) below for what is new.

### Fixed

- The app no longer quits with SIGPIPE when the plugin host exits before any bot has woken.
- A bot no longer tidies itself away in the moment between a background subagent finishing
  and the turn where it reports back: a subagent ending restarts the idle countdown.

## 1.7.0

### Added

- **Codex reviews your work.** Codex is a global bot in the left column under Maintainer: it
  keeps no memory, each message is one fresh read-only `codex exec`, and @Codex calls it into
  any bot's chat to read that chat's folder. A project's right column has Review with Codex,
  which opens a report (in the column, or full size in a window): findings by file with the
  diff around each, filters, pick and send to the bot, mark fixed or skipped, run again, and
  copy as Markdown.
- **A subagent review loop.** Each bot can have Codex review its subagents' work: findings go
  back through the bot to the same subagent (with SendMessage), and Codex looks again until it
  is clean or the round limit is reached, where a card asks Fix once more or Accept as is. Per
  bot: Off, Ask each time or Always, the most fix rounds, and which severities go back.
  Subagent rows show their loop's round.
- **Carrying on after the network drops.** A turn or subagent cut off by a connection error
  shows 網路中斷 and waits instead of tidying up. When the network is back within 50 minutes,
  the same session carries on and cut-off subagents are continued; later than that, they
  start over in their worktree with their prompt.
- **A reminder about quiet runs.** A run with no new step for 15 minutes gets a reminder in
  its chat (`stallReminderMinutes` in settings.json).
- **A usage card.** The gear opens with today's tokens and, for subscription accounts, a ring
  each for the 5-hour and weekly limits: the share used and when it starts over. The numbers
  come from the rate-limit events claude reports while a bot runs (nothing is polled); an
  old reading says "as of N min ago", and with an API key the rings are hidden. No cost is
  shown.

### Changed

- **Settling a subagent instead of hiding it.** Each subagent row has one icon: a blue dot
  while it works, and a clock that settles it, badged with how it ended (a check when done, a
  cross when stopped, an orange ! when it failed). Settling moves the row to a new Settled
  section in the right column, where a click opens its conversation and the arrow brings it
  back. Settling never stops a subagent; rows hidden in 1.6 show as settled.
- **One decision, one choices card.** When the main bot brings up a decision a project is
  already asking in its own chat, it shows that project's card instead of writing a new one;
  an answer on either copy goes to the project and both show it.
- **Interrupting a bot no longer stops its background subagents.** Only the turn stops; the
  subagents keep working and still report back.
- **Bots may message their own subagents** with SendMessage without asking first.
- **Bot settings:** Model, Subagent model and Thinking effort are dropdowns in one card.

### Fixed

- Videos and audio beside artifact pages play, in the preview card and in the full window.

## 1.6.0

### Added

- **Components can take data from a CLI command.** `<show name="…" command="git diff --stat">`
  (or a `Command:` line in a component's about.md) fills the component with what the command
  prints, run in the bot's project folder: JSON output is the data, anything else one string.
  The first time, the card asks you to allow that command for that folder; it then runs with a
  60-second limit and a 1 MB output cap, says why it failed if it did, and has a refresh button.
- **Components can send pictures back.** `ccb.answer({text, images})` sends words with pictures,
  and `ccb.pickImage()` / `ccb.readImage(file)` get them; the bot receives them like a message's
  attachments. Component data may also name local pictures, shown with `ccb.image(path)`. The
  shipped choices component gets an "Other" box that takes words and pictures.
- **Hide a subagent's row** in the left column with ✕. A running subagent keeps working and
  still reports back; the row stays hidden across restarts.
- **Bot settings: Subagent model and Thinking effort.** Each bot can pick the model its
  subagents use and how hard it thinks (low to max). Changing either restarts an awake bot.
- **A new Settings.** The gear opens quick switches (today's cost and tokens, auto-approve,
  developer mode) and a full settings window (also ⌘,) with Usage, Permissions, Plugins and
  Developer mode. Permissions lists the component commands you allowed, each with Forget.

### Changed

- **Feedback reports fold.** A "Not right" report handed to a bot shows as a short card with
  your words and the screenshot; the full report is one click away.
- **Subagent rows** list running ones first, then the newest; past four, Show more lists the
  rest and Show less folds them back.
- **The @ menu is shorter.** A bare @ offers Main bot and Maintainer (or a group's members);
  @ plus letters searches every bot, and @@ lists them all.
- **Maintainer hands every component request to a background component editor** and reviews
  and commits the results one at a time. The editor's instructions are refreshed when the app
  starts, so existing installs get the new ones.

### Removed

- The daily budget. Spending is still tracked and shown in Settings, but nothing waits on it.

### Fixed

- Security fixes from review: Allow runs exactly the command and folder the card showed (a
  command changed since is never run), a timeout or output overflow kills the command's whole
  process group, and only the chat page itself, not a component, can press Allow.
- Components no longer reload and flicker whenever the chat redraws, including while a
  subagent runs.
- A component's "Updated" label no longer wraps onto two lines.
- Pictures sent with a refused permission are kept and passed on to the bot, and pictures
  answering a group or called-in bot's question show in the chat.

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
