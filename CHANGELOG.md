# Changelog

ClaudeCodeBot uses [semantic versioning](https://semver.org): a new feature bumps the minor
version, a fix alone bumps the patch. Each release is a `v<version>` tag; pushing it builds the
app and publishes it on GitHub Releases.

## Unreleased

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

- **What a bot says between tool calls is in sight.** Its words before and between tool calls
  stay in the steps area above the reply, but no longer hide in the folded list: they show as
  its own quieter text (markdown), in order, with each run of tool calls between them folded to
  a "3 steps" chip that opens to those calls. A hairline sets them off from the reply. A turn
  that said nothing between calls keeps the single "Worked · N steps" line. The same holds while
  the bot works (earlier calls fold, the ones under way show), in saved chats, and in group
  chats and called-in bots, whose replies now keep their steps and show them live as well.
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
