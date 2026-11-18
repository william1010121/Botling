# Margin comments (旁註) in the Note tab: design

(Kept in `src/` so the build leaves it behind: only `dist/`, `package.json` and `skills/` ship.)

User's words (2026-11-16): they want to answer *inside* the Note, but not really *in* it, "something like a comment".
Settled design (design duel `.bot/design-duel/20261116-38d1fa`, A-v2): select a passage or a cell and ask; the box opens
beside the passage; the bot's answer is a comment card in a right-hand margin column tied to the passage by a thin
line; follow-ups happen in a floating window (drag, minimise, pin back, collapse); the card keeps a summary.

## How a question reaches the bot and the answer comes back (the choice)

Options looked at:

| Option | Verdict |
|---|---|
| `ccb.composer.insertQuote` (what 問 did) | puts a quote in the chat's draft; the user still has to write and send, and no reply is tied to the passage. Stays as the box's "改為引用到對話". |
| `api.bots.send(botId, text, { as: "user" })` (reading-coach) | needs the `bots` permission, which Note does not have. Not taken: it would widen what Note may do. |
| `api.bots.send(botId, text)` (a message **of the plugin**) | **taken.** No permission (`requested()` checks `bots` only for `as: "user"` and `bots.interrupt`); the chat shows it as the Note's message and wakes the bot, as for every plugin. |
| `api.workers.start` | a worker has no chat context and the answer would not be in the chat. Not taken. |

So, with the permissions Note already has (`files`) and the events every plugin may hear:

1. The frame calls `ccb.host.call("marginAsk", { rid, question, anchor })`. The program part (`src/margin.ts`) saves the
   thread, then sends `〔Note 旁註 c-0001〕 …` with the quote (first line `> 〔Note #id · Fork › Route〕`, the same line a 問
   quote has), the scope, the question and the one instruction that matters: *start the reply with `〔回答 c-0001〕`*.
2. The bot answers in the chat as usual (so the answer is also there) and starts with the tag.
3. `turnFinished` (the reply) is matched to the question: by the id the reply names, else by the only question waiting
   whose line was in the chat before the turn began (`messagePosted` marks that; reading-coach's rule, tightened so a
   reply to an older turn is not taken). Two questions waiting and no tag: neither is answered (nothing is guessed).
4. The thread is updated, `marginChanged` is emitted to the bot's frames, the frame asks `marginList` and redraws the card.

The bot sees the format in the message itself; `skills/note/SKILL.md` also describes it.

## Storage: beside the Note, never in it

Plugin storage key `margin:<botId>` = `{ seq, threads[] }`; `margin:bots` = bots with a question waiting (so a restart
still hears the answer). Not note.md, not note.db cells (the Note's text is never touched by a question or an answer;
a test pins that no `write` happens). A thread: `id` (`c-0001`, never reused), `anchor` `{ cell, label, kind: text|lines|cell,
scope: selection|cell|note, quote }`, `turns[]` `{ rid, q, a|null, qAt, aAt, seenAt, messageId }`, `folded`.
Limits: 200 threads per bot, 50 turns per thread, question 4 000 and quote 4 000 characters, answer 30 000; no new question
once the bot's book is past 1 MB (UTF-8 JSON) or 10 questions wait (storage.json is one file rewritten on every save); control
characters are dropped (answers too); ids from outside are checked (`c-\d{4,}`, request id `[A-Za-z0-9_-]{1,64}`) and looked up in an
array, never used as keys.

Safety: a request id makes a retry (double tap, repeated call) answer with the same thread and send nothing again; a
message that cannot be sent removes the thread again and the frame keeps the box with the reason; a follow-up while the
last question is unanswered is refused.

## Finding the passage again

By the id of its cell in note.db (`notes.outline`, asked once per text, only when a comment has an id), then by its text
(first line of the quote). Passage still there: the card lines up with it. Cell there but the quote edited: card marked
原文已改, anchored to the cell. Gone: card at the bottom marked 原文找不到 (still readable, deletable). In a route that
is not shown: hidden until that route is shown. Highlight: the CSS Custom Highlight API for a text quote in a drawn line
(no DOM change), else a soft bar on the line(s) / a frame on the cell.

## The frame (src/ui-margin.js, src/ui-margin-css.js)

* **Ask**: a selection inside the line being edited, or across lines (the editor's own multi-line selection), shows a small
  問 Bot button above it; a cell's existing 問 button (and a branch's) opens the box for the whole cell. The box (first question) is a
  card **right under the passage's cell, in the flow of the note** (the cells below move down; nothing in the margin until
  an answer exists; `placeDraft()` puts it back after every render); scope tabs 選取文字 / 整個 cell / 整份 Note on one row
  with 改為引用到對話 / 取消 / 送出 (no explanatory line under them), ⌘↵ sends, Esc closes. The answer then appears as a card in the margin (narrow frame: under the note).
  `render()` empties the doc, so `placeDraft()` also hands the typing focus back to the box if it had it (`d.focused`), and the fade-in
  (`nm-enter`) is a one-off class, removed after it ends, so a re-insert never replays it (the screen must not flicker). Tests: test/ui-margin-askbox.test.js.
* **Answering…**: the card shows a spinner and "bot 還在回答…", with 不等了 (drops the question; a late reply stays in the chat).
* **Read**: question, answer as small Markdown (paragraphs, lists, code, links through the note's link opener), time,
  "不會寫進 Note"; open as a popover (see below), 複製, 刪除 (two presses), 存成 cell (the only way an answer enters the note: a new
  cell after the passage's cell, one undo step).
* **Follow up**: 在視窗追問 opens the floating window (drag by the bar, minimise, 釘回側欄, collapse); the card shows a stub
  "視窗追問中". The window position is per mount, not stored.
* **Opening a comment** (2026-11-18): the card in the margin is always a one-line pill (state chip, first question, chevron); pressing it opens
  the comment as a popover (`.nm-float`, `position: fixed`, a child of the frame, not of the rail) over its own pill: same card, shadow and
  header (旁註 + chip), body that scrolls, action row (在視窗追問 / 複製 / 存成 cell / 刪除 / 收起) that stays in view. It takes no room (the
  rail, the note and the other pills do not move; no clear-and-redraw), is at most as tall as the visible frame minus a bottom margin
  (`FLOAT_BOTTOM_SAFE`: the app's floating status bar lies over the frame and its height cannot be read from inside it), follows its pill on
  scroll, and closes on 收起, Esc and a press outside. One popover at a time; open / closed is not stored (the old `folded` flag is no longer
  used by the frame; the host still keeps it and `marginFold` still answers). Keyboard: opening it moves the focus into the card
  (`tabindex=-1`); closing it from inside hands the focus back to the pill's chevron; an answer arriving rebuilds the card but keeps the focus
  and the scroll position. A comment whose pill leaves the rail (its route is not shown) closes with it and does not come back by itself.
* Cards sit in `.nm-rail` (a node of its own; `render()` never rebuilds it, so a typed question survives a redraw), tops
  are stacked so they never overlap, and elbow lines join each card to its passage. Colours are the note's `--n-*` tokens
  (light/dark follow the app).

## Not done / limits

* Answers render a small Markdown subset (no tables or images inside an answer).
* The window position and open / closed state are not remembered across a reload; all threads are.
* A reply is matched to a question while the Note's plugin host is running; the bots with a question waiting are kept
  across a restart, but a reply that came while the app was off is not recovered.
* The highlight is the exact quote only when it is one run of plain text in a drawn line; otherwise the whole line.
* Geometry (cards lining up in a wide frame) is checked with headless screenshots, not unit tests (jsdom has no layout).
* `package.json` version / description were not bumped: kernel and settings goldens pin `1.19.1`; bump with those at merge.
