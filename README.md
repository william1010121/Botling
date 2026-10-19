# Deck（指揮台，暫名）

PRD: `../prd/PRD.md` · Design: https://claude.ai/artifact/2kmnVNyueZX2yMxH4gNqyX

Chat: bot replies render markdown (headings, lists, tables, code, quotes); `![說明](file://…)`
shows an image or plays a video (mp4, mov) inline, click an image to see it large. Attach images
or files with 「+」, drag-and-drop, or paste (screenshots too); they are copied into the bot's own
`attachments/` folder and images go to Claude directly. Hover a line (or right-click) to reply to
it; the reply shows the quote and the bot gets it too. The component team's row in the left
column opens its page: each request, what it is doing right now, and what it said.

M6: components. Parts of the chat are HTML templates in `~/.deck/components/<name>/`
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
DECK_IDLE_SECONDS=30 swift run Deck              # nap after 30 s instead of 50 min
swift test                                       # unit tests (fake claude)
DECK_LIVE=1 swift test --filter Live             # real claude, ~6 min
DECK_SNAPSHOT=/tmp/deck.png swift run Deck       # render a PNG of the UI and quit
DECK_COMPONENT_SNAPSHOT=/tmp/c.png swift run Deck # render the choices template in a web view
```
