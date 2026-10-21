# Changelog

ClaudeCodeBot uses [semantic versioning](https://semver.org): a new feature bumps the minor
version, a fix alone bumps the patch. Each release is a `v<version>` tag; pushing it builds the
app and publishes it on GitHub Releases.

## Unreleased

### Added

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
