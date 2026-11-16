# botling.pin-area (Pin 區), design note

Phase 1 of the Pin area: a strip of cards above the chat, a floating panel per card, `@card` routing. Phases 2 and 3 are built on
the seams listed at the end; they need no rework of what is here.

## Decision: plugin, not core

A plugin. Everything the feature owns (cards, the thread, the rules, the strip, the panel) is the plugin's. The core got **two small
general hooks** (not pin-specific, tested, each useful to any plugin):

| Hook | What | Where |
|---|---|---|
| `page.slots.topArea` | an empty slot above the message list (`#top-area`, takes no room when empty) | `Web/src/{plugins,main}.ts`, `chat.html` (both copies) |
| `ccb.composer.mentionSource(fn)` | rows after a single `@` in the input box, before the bots'; a row may carry its own `insert`; a source that throws offers nothing; a name typed in full needs no list | `Web/src/{composer,plugins,main}.ts` |

Everything else uses what exists: `hooks.beforeSend`, `events` (`messagePosted`, `turnStarted`, `turnFinished`), `replyTags`
(`pin-card`, `pin-say`), `chat.setData` (permission `cards`: only for this, built-in only), plugin `storage`, `ui.expose`,
`ccb.messages.{userText,afterRender}`, `ccb.page.{slots,onState,post,language}`.

## What a bot can newly do

Exactly: pin and unpin its **own** cards and rewrite a card's status line (`<pin-card>`), and answer inside a card's thread
(`<pin-say>`). Nothing else. It cannot read the user's cards (it learns a user-pinned card's `p-0001` id only from the header of a message
the user wrote into it), cannot take down a user's card, and touches only its own book (`tag.bot.id`).

Rules in `model.ts` (not in prose): a bot may *make* a card only for `state="wait"` or a `run` with `min="10"` or more; at most 3 open
(not done) bot cards; at most 8 cards in all (the oldest done card makes room); 30 tags per bot per minute; text cleaned to one line
(`oneLine`), at most 40 characters of title and 120 of status.

## Data model (`src/model.ts`)

One `Book` per bot in plugin storage `pins:<botId>` (index `pins:bots`, so a restart republishes every chat's cards):
`{ seq, pins: Pin[], removed: Removed[] }`. A `Pin` has `id` (`p-0001`, never reused), `botKey` (the bot's own name for it), `origin`
(`user`|`bot`), `title`, `handle` (what follows `@`), `state` (`wait`|`run`|`done`), `status`, `prev` (the line before the last rewrite,
shown as "原本"), `source` (`bot`|`app`|`user`: who vouches for the status line), `step`, `waitingSince`, `thread: Turn[]`,
`updates: Update[]` (the "N 則更新" log), `msgRef`, `seenAt`. `fit()` keeps the book under 600 000 JSON bytes (older answers go first;
an open turn never).

The page draws `viewOf(book)` (order wait, run, done), published with `chat.setData` after every save and again after a restart.

## Flows

- **A bot pins / updates**: `<pin-card id="k" title="…" state="wait|run|done" step="2/5" min="30">status</pin-card>` → `applyCardTag` →
  `applyUpdate` (the single reducer). `unpin="yes"` takes down a card the bot made.
- **The user pins**: the 釘選 button on any message → `pinMessage` (a pin per message id, state `run`, source `user`). 取消釘選 and 釘回
  (the last 3 removed cards are kept). A done card the user opened and closed goes by itself (`unpin by:"seen"`, refused for a card that is
  not done) with the line 「…看過了，已取消釘選」 and 釘回.
- **`@card words`** (main input box or the card's own box): both end in `beforeSend`. `route()` finds `@handle` / `@p-0001` at the start
  of the text in *that chat's* book, writes the words into the thread as an open turn, and returns the text the bot gets:
  `〔Pin p-0001 · title〕\nwords\n\n（Pin 卡片：回覆請用 <pin-say id="p-0001">…</pin-say>，…）`. The user's bubble shows `@title words`
  (`userText` reads the header back with `parseAsk`). One path, so nothing is sent twice; the same words to the same card within 3 s
  are dropped (`false`).
- **The answer** is matched back by `<pin-say id>`: to that card's oldest unanswered question whose line is in the chat (two
  questions before an answer each get theirs); with nothing waiting it is a turn of its own (the core has already taken it out of the
  chat, so it is never dropped). A turn that used `<pin-say>` leaves the rest of its reply to the chat. With no tag, the one card with an open turn whose line was in the chat before the
  bot's turn began takes the plain reply; with two waiting nothing is guessed. Receipts: 已送出 (written) → bot 已看到 (`turnStarted`
  after `messagePosted` showed the line).
- A routed message that never reached the chat (stopped by another plugin) is forgotten after 2 minutes, so it cannot hold an answer.

## Page part (`src/ui.ts`, `src/web.ts`, `src/pin-area.css`)

The strip: one row per card, faded (`.pt-fd`, opacity .36) until hover or keyboard focus; waiting rows always clear with an orange
left border and dot; hover grows a second line. The panel: floating, right, 420 px, slides in 0.2 s / out 0.14 s, the chat yields
(`body.pt-panel-open`, ≥ 900 px); status rewritten in place with 原本, step bars with 剩 N 步, source tag, the thread with receipts, a folded
"N 則更新", its own input. Esc / outside click close; ⌘1–3 toggle the first three cards. All text goes in with `textContent`. Motion honours
`prefers-reduced-motion`. Colours are the chat page's tokens. Classes are prefixed `pt-` (`botling.board` also uses `#pin-area`).

## Phase 2 (worker news, automatic routing, the cards briefing)

**What a bot can newly do, in addition to the list above** (nothing else was added to the bot):
1. `<pin-card worker="w-1 w-2">`: a card follows up to 4 of the bot's own workers or sub bots (`Pin.from`). A tag with only the link changes no status.
2. `<pin-say id="p-0001" move="yes">`: the user's last plain line (the one this turn answers) and this answer go into that card, once per line.
3. It reads a note, `〔Pin 區現況〕`, appended to a plain message of a chat that has cards: title, id, state, status. Cards the user pinned are in it.

**Worker news.** `events.workerDone` (any worker run end of that bot; `workerReport` is only for plugin-started workers) calls `news()`;
a sub bot's reply comes from `messagePosted` of the sub bot, and counts only while `workspace.bots()` says its parent is the book's bot
(checked at the moment of use, cached 60 s). `applyNews` rewrites the status line in place (keeping 原本) and logs to `updates[]`, which the card
shows in its folded "N 則更新". Rules: a done card ignores news; a waiting card only logs; a failed / stopped / interrupted worker turns a
running card into wait; a completed worker never makes a card done (the bot says that). A worker that ended before the card named it is replayed (`ends`, 50 kept).
Limit: plugins see only a worker's run end, not its progress.

**Automatic routing.** `beforeSend` appends the briefing (`withBriefing`) to a plain message; `userText` strips it, so the bubble is the user's words.
`messagePosted` remembers that line (`lastLine`), `turnStarted` binds it to the turn (`turnLine`). With `move="yes"` the host calls `takeAuto`: a turn
with `via: "auto"` goes into the card, the answer is stored in it, and `chat.decorate(botId, tracesOf(book))` folds the chat line behind a
one-line trace 「→ 放進 X 的卡片 · 移回聊天 · 改到…」. A `<pin-say>` of any kind marks the turn `saidInTurn`, so the rest of the reply stays in the chat.
**Undo** (`moveBack` / `moveTo` in the host, one tap each): the turn is marked `moved`, the line comes back, and the trace shows the bot's answer under it,
so nobody asks twice; the correction (`Book.fixes`, 3 kept) goes into the next briefing so the bot learns. Wrong guesses cost one tap.
Bounds: 120 traces, 4 `from` per card, 3 fixes. Every plain message in a chat with cards carries about 1 KB of note.

## Not yet, and the seams left

| Later | Seam |
|---|---|
| **Phase 3**: 「你不在時」 digest incl. other bots' waiting items | `Pin.waitingSince` (set when a card starts waiting, cleared when it stops); `pins:bots` lists every bot with a book; `viewOf` carries `waitingSince`. |
| worker progress (not only the run end) | needs a plugin event for a worker's progress; the app has none. |

Not covered: the phone / web bundle (the page slots and `chat.setData` are the desktop chat frame's; `Web/src/chat.html` has the slot
too, the mobile page has no plugin host for it yet). Every send of every chat now makes one round trip to the plugin host (`beforeSend`
is a hook of the whole chat, answered at once for a bot with no cards).

## Standards check (docs/code-standards.md, 13 items)

1. **Paths**: n/a, no path is read or compared.
2. **Symlink-safe files**: n/a, only the plugin's own `storage.json` through `api.storage`.
3. **Keys from data**: done. Attributes read with `Object.hasOwn` (`own()`); cards found by `find` on arrays, ids by `isId` / `isKey`; no
   object is indexed by a bot's or the user's text. `readBook` drops `constructor` / `__proto__` ids. Tests: `model.test.ts`, `host.test.ts`.
4. **Text from a peer / user / bot**: done. `oneLine` / `clean` once at the door (control characters out, one line, `〔〕` out); the page
   uses `textContent`. Test: `ui.test.ts` (markup stays text).
5. **Secrets**: n/a, none handled; errors name no content.
6. **Sizes**: done. JSON-escaped UTF-8 bytes (`bytesOf`) against `MAX_BOOK_BYTES`; per-field caps; `fit()` tested on CJK + escapes.
7. **Ids from outside as a path part**: n/a (no path); ids still checked by pattern (`p-\d{4,}`, `[A-Za-z0-9_-]{1,64}`).
8. **UI and retries**: done. Per-card in-flight send guard (released when the thread grows or after 4 s), duplicate words within 3 s
   dropped in the host, a card is pinned once per message id. Tests in `ui.test.ts`, `host.test.ts`.
9. **Authority at use**: done. The bot id comes from the tag (`tag.bot.id`) and the message (`message.bot.id`), the book is re-read at
   every use; `by:"seen"` is re-checked against the card's state in the host. Phase 2: news goes only to the book of the event's own bot;
   a sub bot's parent is checked when its reply arrives; `moveBack` / `moveTo` re-read the book and the turn's `via`.
10. **Fail closed**: done. A bad tag, an unknown state, a missing id, a full strip, a rejected `setData` drop or refuse; nothing throws out
    of an event or tag handler. Phase 2: an unknown worker id, a `worker=` that is not an id, a `move` with no line to move, or a full
    trace list drops quietly (the line stays in the chat).
11. **Tests**: done. `model.test.ts`, `host.test.ts`, `ui.test.ts`, `web.test.ts`, `mention-source.test.ts`. No mutation run (the reviewer's).
12. **Before review**: base is `main` at branch time; the kernel goldens were stale on main (a `botling.deps` entry and a `hostState`
    field were already missing) and are regenerated here, so their diff has that drift too.
13. **Test budget**: at most 2 `remote-test.sh` runs, no `--typecheck`; locally `npm run build` only.
