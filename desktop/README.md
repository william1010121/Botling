# Botling 2.0 desktop (React + TypeScript + Electron)

Status: **Phase 0 spikes done on macOS; Phase 1b done: several bots with 1.x-compatible storage, a
read-only 1.x import, a long-lived claude head per bot with approvals, and a React shell hosting the
reused Web/src chat page.** Not yet a replacement for the Swift app (see "Gaps vs the Swift app").
It lives beside it: nothing under `Sources/` or `Web/` changed, and the Swift app does not use
anything here. Web/src is *bundled from source* into the desktop's chat frame (its packages come
from `desktop/node_modules`), so `cd Web && npm run build` and its output are untouched;
`Web/src/contract.json` is read (for the shared `ccb.save` limit), never written.

## Run it

All bulky things stay on the external drive. Before `npm install` set:

```sh
export npm_config_cache=/Volumes/My-SSD/botling-work/.npm-cache
export electron_config_cache=/Volumes/My-SSD/botling-work/.electron-cache   # note: not ELECTRON_CACHE
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1                                   # Electron tests need no browsers
export TMPDIR=/Volumes/My-SSD/botling-work/tmp
cd desktop && npm install
```

| Command | What it does |
| --- | --- |
| `npm run dev:fake` | Build and open the app with the fake CLI (no usage). |
| `npm run dev` | Same with the real `claude` CLI in harmless mode — `--safe-mode`, no tools, no MCP, no saved session (`BOTLING_HARMLESS=0` makes it a real bot that asks before tools). |
| `npm run build` | Bundle main, preload, core and renderer into `out/` (not committed). |
| `npm test` | Unit tests (vitest, real processes) then Electron end-to-end tests (Playwright). |
| `npm run test:live` | Three short real `claude` turns through the long-lived head (spends a little usage). |
| `npm run typecheck` | `tsc --noEmit`. |

Data goes to `$BOTLING_DATA_DIR`, by default `desktop/.data/` in development (ignored by git) and
`<appData>/Botling 2` when packaged. The core's part is `<data>/core/`, in the Swift app's layout
(below); Electron's own profile, partitions and caches are under `<data>/electron/`. Tests use
throwaway folders in `desktop/.tmp/` (`.tmp/screens/` keeps the screenshots `look.spec.ts` takes).

Import: a **packaged** app imports `~/.claudecodebot` on its first start (read-only). A development
run imports only what `BOTLING_IMPORT_FROM=/path/to/a/1.x/folder` names, so `npm run dev*` and the
tests never read the real folder. Try it on a copy: `BOTLING_IMPORT_FROM=… BOTLING_DATA_DIR=.tmp/try npm run dev:fake`.

Other knobs (all optional): `BOTLING_APPROVAL_TIMEOUT_MS` (default 10 min, as 1.x),
`BOTLING_IDLE_MS` (a head sleeps after 30 min idle), `BOTLING_INTERRUPT_GRACE_MS` (how long Stop
waits for claude before ending the tree, 2 s), `BOTLING_HARMLESS=0` (real tools, CLAUDE.md, MCP and
saved sessions in `npm run dev`), `BOTLING_HARMLESS_TOOLS=Bash` (tools that exist in harmless mode),
`BOTLING_MODEL`, `BOTLING_CLAUDE_PATH`.

In the fake CLI (`npm run dev:fake`) a message can start with a directive: `/tool ls -la` (asks to run
it: try Allow once / Don't allow), `/tool:WebFetch https://x` (a tool that can be "always" allowed),
`/slow` (streams until Stop), `/stubborn` (ignores Stop and SIGTERM: the tree is killed), `/card`,
`/crash`, `/resume` (says which session it runs and whether it was resumed).

## Architecture as built

```
┌────────── app page: app://botling/index.html (sandbox, contextIsolation, no Node) ──────────────┐
│ React chrome (App.tsx): left column of bots (BotRow), header, banners                          │
│ WorkspaceStore (epoch/seq, resync, every bot + the shown chat) · Client (ids, cancel)          │
│ payload.ts: contract views → the ChatState that ChatPayload.swift builds                       │
│  └─ chat frame: app://botling/chat.html (same origin, own CSP, no bridge)                       │
│      Web/src/main.ts unchanged (markdown, KaTeX via ccb-latex, steps, choices, footer…)        │
│      + chat-frame/entry.ts: webkit.messageHandlers shim → postMessage to the app page;          │
│        Phase 0 cards in their bubbles + CardBroker; Stop button; Escape                         │
│        └─ card frames: <iframe sandbox="allow-scripts" src="botling-card://card/<bot>/<msg>/<card>">│
└──────────────── preload: botling.post(envelope) / botling.subscribe(fn) only ──────────────────┘
                 │ ipc "botling:post" / "botling:message"
┌──────────────── main (thin) ─────────────────────────────────────────────────────────────────────┐
│ sender = the app window's main frame · zod · allow-list · request ids scoped per window          │
│ protocols: app:// (APP_CSP; chat.html gets CHAT_CSP) · botling-card:// (card CSP)                │
│ frames: chat.html only as the app page's child, put there by it; cards only from the app page or │
│ the chat page; anything else (a card navigating itself) is refused · accounts (persist:account-*)│
└──────────────── utilityProcess (parentPort) — same code runs on stdio under plain Node ──────────┘
┌──────────────── core (trusted) ──────────────────────────────────────────────────────────────────┐
│ Core: validates again, routes by bot · first start: read-only import of a 1.x folder            │
│ Bot (bot.ts), one per bot: chat.json/bot.json in 1.x's format · one turn at a time · approvals   │
│   ClaudeHead (agent/head.ts): one long-lived `claude -p --input-format stream-json` per bot,     │
│   own process group, --session-id then --resume, --permission-prompt-tool stdio; stream.ts parses│
│ ProcessLedger: ends heads a crashed core left · JobStore (Phase 0, not wired yet)               │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Files: `src/contract/` (the typed contract), `src/core/` (core process: `server.ts` routes,
`bot.ts`, `agent/head.ts` + `agent/stream.ts`, `store/` (records, BotStore, layout, importer),
`agent/runner.ts` = Phase 0's per-turn runner, kept), `src/main/`, `src/preload/`, `src/renderer/`
(React shell, `payload.ts`, `avatars.ts`, `chat-frame/`), `test/unit`, `test/e2e`, `test/live`,
`test/fixtures/fake-claude.mjs` (a stand-in CLI with a per-turn and a long-lived mode),
`test/fixtures/swift-data.ts` (a synthetic 1.x folder).

### Data layout (the Swift app's, `Workspace.Layout`)

```
<core>/main/                chat.json, bot.json, subagents.json, tasks.json, … and the main bot's
                            working folder (memory.md, routines.cron)
<core>/projects.json        Workspace.Project rows {id, name, folder (file URL), avatar, job?}
<core>/projects/<ID>/       each project's or bot's chat files
<core>/bots/<ID>/           a bot of its own's working folder (.bot/memory.md, …)
<core>/settings.json        AppSettings (kept, not used yet)
<core>/import.json          2.0: what the import brought over (its presence = done)
<core>/<bot>/head.json      2.0: {sessionId, started} — the claude session the head resumes
```

Formats follow Swift's `JSONEncoder` as 1.x uses it: dates are **seconds since 2001-01-01**
(`deferredToDate`), UUIDs upper case, URLs as `file://` strings, nil fields left out. 2.0 keeps
every key it does not know as it was, and adds its own (`turnID`, `state`, `cards`, `error`), which
1.x's decoder ignores. Message ids are UUIDs (1.x fails a whole chat.json on one bad id).

### The contract (`src/contract/index.ts`, protocol version 2)

- Envelopes: `request {v, id, cmd}`, `cancel {v, cancel}`, `response {v, id, ok, result|error}`,
  `event {v, epoch, seq, event}`. `v` is `PROTOCOL_VERSION` (2); another version gets
  `unsupported_version`, not a guess.
- Every hop validates with zod (`strictObject`: unknown fields are errors, so smuggled ids fail).
- Error codes: `bad_request, unsupported_version, forbidden, not_found, conflict, cancelled,
  core_unavailable, internal`. Exactly one response per request id, including cancelled ones.
- Cancellation cancels the *request* (e.g. `turn.await` stops waiting); `turn.stop` is the
  separate, explicit way to stop work.
- `epoch` is new each time the core starts; `seq` is gapless within an epoch. The renderer applies
  events after its snapshot, buffers those that arrive while a snapshot is in flight, and takes a
  new snapshot on a gap or a new epoch.
- Commands: `chat.snapshot {botId?}` (every bot + that bot's chat), `chat.send`, `chat.choose`
  (a button on a question: what it does comes from its `action`, never its words), `chat.read`,
  `turn.stop`, `turn.await`, `card.save`, `card.action`, `card.html` (main only), `accounts.list`,
  `site.open`. All chat commands name their `botId`.
- Events: `bot.updated` (phase asleep/awake, working, approvals, unread, problem), `message.added`,
  `message.updated`, `turn.started`, `turn.delta`, `turn.steps`, `turn.finished`, `card.updated`,
  `card.acted`. Chat events name their `botId`.
- An approval is a `MessageView` with `choices` (actions `allowOnce`/`alwaysAllow`/`deny`) and
  `approval {tool, expires}`; the reused chat page draws it as its usual choice buttons.


## Spike verdicts

| # | Spike | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Card isolation | **Pass (macOS)** | `test/e2e/cards.spec.ts` |
| 2 | CLI streaming + stop | **Pass (macOS, fake and real `claude` 2.1.310)** | `test/unit/core.test.ts`, `test/e2e/chat.spec.ts`, `test/live/claude.test.ts` |
| 3 | Multi-account sessions | **Pass (macOS, synthetic site)** | `test/e2e/accounts.spec.ts` |
| 4 | Windows process-tree termination | **Unverified** (design + untested code) | `src/core/process/tree.ts` |
| 5 | Durable worker/routine recovery | **Pass (macOS, single machine)** | `test/unit/durable.test.ts` |

**1 — Card isolation.** A hostile card (`sandbox="allow-scripts"`, served from `botling-card://`
under a CSP with `connect-src/frame-src/form-action 'none'`) was checked to: have an opaque origin;
see no `botling`, `require` or `process`; get `SecurityError` reading `parent.botling`,
`parent.document`, `top.location`, cookies and `localStorage`; get `null` from `window.open`; fail
to navigate the top frame; fail to `fetch` `file:`, `app:`, another card's URL and `http:`; fail to
nest a frame of the app; and fail to navigate *itself* to another card's URL (main blocks frame
navigations the app did not start — otherwise it would inherit this frame's identity). The broker
refused messages with smuggled `messageId/cardId/botId`, raw contract envelopes, non-JSON saves;
the core refused a well-formed `ccb.action('runShell')` as `forbidden`. The victim card's data and
the chat were unchanged, and no window opened. A legitimate card's `ccb.save` went renderer →
main → core, was persisted, and came back after a restart; its `ccb.action('say')` worked.
*Not covered yet:* the real component library (`ccb.answer`, `runDetail`, `open`, `status`,
commands — see the Swift `components.ts`), Board/pins, size/scroll behaviour, Windows/Linux.

**2 — Streaming + stop.** The core runs one `claude -p --output-format stream-json --verbose
--include-partial-messages` per turn (prompt on stdin, `--session-id` then `--resume`), each in a
new process group. Deltas become `turn.delta` events. `turn.stop` closes the turn's gate first
(nothing it prints afterwards reaches anyone), emits `turn.finished{stopped}` with exactly the text
delivered so far, then SIGTERMs the group and SIGKILLs it after 1.5 s. Verified with a fake CLI
that ignores SIGTERM and has a helper child that also ignores it: all pids gone, no events for the
turn afterwards. Also verified: a crashing CLI fails the turn; reloading the window neither stops
nor re-sends the turn; a core killed mid-reply leaves the reply marked *Interrupted* (not re-sent)
and the next core ends the orphaned CLI group through the ledger. Real `claude`: a short "OK" turn
streamed and finished; a long turn stopped mid-stream with its whole group gone (2 real calls total).
*Gap:* a descendant that calls `setsid()` itself escapes the group (same as the Swift app today).
*Note:* the real CLI still reads the user's `~/.claude` settings and `CLAUDE.md` (the live test
answered in Chinese), as the Swift app does.

**3 — Accounts.** Two `persist:account-<id>` partitions kept separate persistent cookies,
`localStorage` and IndexedDB, and still had them after a full app restart; the app's own session
had none; a site page had no `botling`/`require`; an unknown account id is refused. Cookies need
`Max-Age`/`Expires` to persist (session cookies do not, by design), and main flushes the cookie
store on quit. *Not covered:* real sites, OAuth (plan: system browser + PKCE), importing WebKit
data (expect re-login), service workers, downloads.

**4 — Windows process trees (unverified, nothing ran on Windows).** Interface:
`ProcessTreeAdapter.spawn(...) → ManagedProcess.terminate({graceMs}) → {killed, forced}`.
macOS/Linux: `PosixGroupAdapter` (process groups; verified on macOS only). Windows today:
`WindowsTreeAdapter` — `taskkill /PID <pid> /T`, then `/T /F` after the grace period. Its weakness is
that `/T` follows parent links at kill time, so a child whose parent already exited is missed.
Plan for the real implementation:
1. A tiny signed helper (`botling-job.exe`, Rust or C, ~200 lines) or an N-API addon that creates a
   Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, starts the CLI suspended
   (`CREATE_SUSPENDED`), assigns it to the job, resumes it, and relays stdio. Every descendant is
   in the job regardless of reparenting; closing the job handle (or the helper dying with the core)
   ends them all, which also replaces the POSIX ledger on Windows.
2. Polite stop first: send the CLI a stdin control message (claude's `control_request`
   `interrupt`) or `GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT)` to a `CREATE_NEW_PROCESS_GROUP`
   child; then `TerminateJobObject` after the grace period.
3. Nested jobs work on Windows 8+; if the CLI creates its own job with breakaway, document it.
4. Verify on a Windows 11 x64 VM: the same `process-tree`, `core` and e2e stop tests, plus
   `claude.cmd`/`.exe` resolution (no `shell: true`), paths with spaces, and Defender-held files for
   the atomic rename retry in `atomic.ts`.

**5 — Durable jobs.** `JobStore` (JSON + `writeFileAtomic` + `withFileLock`, portable Node, no
`flock`): `pending → claimed (persisted before dispatch) → delivered`; a claim whose core is gone
becomes `delivery_uncertain` at the next start and is never re-sent; only the claiming run can
confirm delivery. With real processes and SIGKILL: killed after claim → that job uncertain, the
rest delivered once; killed between deliver and confirm → delivered exactly once, marked
uncertain; three cores racing over 60 jobs → each delivered exactly once; a writer killed at 15
random moments never left a torn file; a dead holder's lock is broken, a live one's respected; an
unreadable store is reported, never treated as empty. *Not covered:* sleep/resume, DST and cron
(the Swift `ScheduledRoutines` semantics still need porting), network filesystems, Windows
(`rename` over an open file), pid reuse beyond the start-time check. The store is not yet wired to
routines or workers in the core.

## Phase 1b: what was built and how it was checked

| Piece | What it does | Evidence |
| --- | --- | --- |
| Storage (`store/records.ts`, `bot-store.ts`, `workspace.ts`) | Every bot's chat in 1.x's files and layout; unknown keys kept; a chat file that cannot be read is reported on the bot (`problem`) and never written over | `test/unit/importer.test.ts` ("Swift formats"), `core.test.ts` (unreadable file) |
| Import (`store/importer.ts`) | First start with an empty folder: copies the main bot's and each project's/bot's chat files, memory.md/routines.cron of the main bot and of bots of their own (whose folder moves into 2.0's `bots/<ID>/`), projects.json and settings.json; writes `import.json` last | `importer.test.ts`: the synthetic source is made **read-only** and compared by hash *and mtime* before/after; bad JSON, a line 1.x would not decode, Maintainer and `web/` are reported as skipped; a second start does not import again; `e2e/bots.spec.ts` |
| Long-lived head (`agent/head.ts`, `agent/stream.ts`, `bot.ts`) | One `claude -p --input-format stream-json` per bot in its folder; `--session-id` then `--resume` (kept in `head.json`, also across app restarts); a resume claude no longer has falls back to a new session and re-sends the message once; tool calls become steps; approvals; Stop = close the gate, `interrupt`, and end the tree if claude does not end the turn within 2 s; a crashed head fails its turn and is restarted (1 s, 2 s, 4 s, then on the next message); an idle head sleeps (stdin closed) after 30 min; quitting ends running trees at once | `test/unit/head.test.ts` (10 cases), `core.test.ts` (stubborn stop = SIGKILL of the whole group, crash, core crash + ledger, quit during a turn) |
| Approvals | `can_use_tool` → a chat line with Allow once / Always allow *tool* (not for Bash, Write, Edit, …) / Don't allow; the pick's `action` decides; no answer in 10 min = no; "always" is saved in bot.json `alwaysAllowed` (1.x's key); open approvals are closed ("No longer needed") when a turn ends, a head dies or the app restarts — never answered later | `head.test.ts`, `e2e/approvals.spec.ts` |
| React shell + reused chat page | Left column (bots, asleep faces, working dot, approval and unread badges, import note); header (name, Writing… / Waiting for your answer / Awake / Asleep); the Web/src chat page in a frame, fed by `payload.ts`; Stop in the input box and on Escape; Phase 0 cards in their bubbles | `e2e/chat.spec.ts`, `cards.spec.ts`, `bots.spec.ts`, `payload.test.ts`; screenshots `desktop/.tmp/screens/{approval,streaming,stopped,imported-main,imported-blog}.png` |
| Real `claude` 2.1.310 | Short reply on a head that stays alive: **pass**. Stop mid-reply, nothing after: **pass**. Approval: the first run asked for `echo …`, which claude runs without asking (read-only), so no approval came and the test timed out; changed to `mkdir …` (denied, so nothing is made) but **not re-run**, to stay within three real calls | `test/live/claude.test.ts` |

Real-world format check: the importer's reader and `messageView` were run once on a *copy* of one
small real 1.x bot folder (36 lines; roles user/bot/notice/divider; keys like `displays`,
`backgroundTasks`, `sourceID`): 0 lines dropped, 0 views failing the contract. The copy was deleted;
nothing from it is committed.

### Decisions (Phase 1b)

- **2.0 keeps 1.x's formats and layout** instead of a new schema, so the import is a checked copy,
  2.0's folder stays readable by 1.x-shaped code, and fixtures are shared. 2.0-only keys sit beside
  1.x's. The contract's views are built from these records in the core (`messageView`).
- **Import is a copy, read-only, once.** Only text files are copied (≤ 50 MB each, written fresh
  with 2.0's permissions). Attachments, archives, result pages, screenshots and claude's sessions
  stay where they are (messages keep pointing at them); Maintainer, plugins, web AIs, teams and
  routines' state are not imported yet (listed as skipped). A project manager keeps working **in
  the user's project folder**, as in 1.x, so its `.bot/memory.md` is shared with 1.x — running both
  apps on the same project at once is not supported. Bots of their own move into 2.0's folder, so
  1.x's copy is never written.
- **Sessions resume across sleeps and restarts** (`head.json`), unlike 1.x, which starts a fresh
  session on each wake and briefs it from memory.md. Cheaper to build now; the memory briefing and
  tidy-before-sleep are a gap (below).
- **Stop** keeps Phase 0's guarantees (gate first, nothing after, tree ended if needed) but asks
  claude first (`interrupt`), so the session and the head survive a normal Stop. A plain interrupt
  also ends background tasks — what Stop should do. (1.x has no Stop button; it steers with
  `interrupt` + `send_now` when you write again.)
- **One turn at a time per bot**: a message while a reply is written is refused (`conflict`), as in
  Phase 0. Steering a running turn (1.x) is a gap.
- **The chat page runs in a same-origin frame**, not mounted into the React page: its CSS and DOM
  assume they own `body`, and it needs inline styles for KaTeX (`style-src 'unsafe-inline'`) and a
  `blob:` module for its plugin loader, which the app page's CSP does not allow. It has no bridge;
  it talks to the app page with `postMessage` (both check `event.source` and origin), and only
  `card.save`/`card.action` requests are taken from it. Its `webkit.messageHandlers` is a small
  shim, so Web/src runs **unchanged**.
- **Web/src is bundled from source** by `build.mjs`; markdown-it, KaTeX and CodeMirror are
  desktop dependencies at Web's pinned versions (resolved with esbuild `nodePaths` and tsconfig
  `paths`). `tsc` now type-checks the Web/src files the frame uses too.
- **Approval card = the page's own choice buttons** (1.x draws the same message), so there is no
  React approval component. The React chrome shows the count and status.
- **Avatars** are 1.x's shapes and colours as SVG data URLs (`avatars.ts`); asleep bots close their eyes.
- **The reply line appears when it has words**; until then the page's typing bubble shows the live
  steps. Text before and after an approval stays in one bubble above the card (1.x moves earlier
  words into a step) — simple, slightly different.
- **Packaged builds import `~/.claudecodebot`; development runs only import `BOTLING_IMPORT_FROM`**,
  so no test or dev run touches real data.
- **Fake CLI**: keeps the per-turn mode (Phase 0's `AgentTurn` still has a test) and adds a
  long-lived mode with directives (`/tool`, `/slow`, `/stubborn`, `/crash`, `/resume`, …) and
  `FAKE_CLAUDE_FORGET` for a lost session.

## Gaps vs the Swift app (1.x)

Not in 2.0 yet, roughly in order of how much they matter:

- **Codex head and two-head bots** (CodexAgentProcess, hand-offs, rounds, Answer with), and
  **app-managed workers**.
- **Subagents**: their steps, rows in the left column, their own view; `subagents.json` is imported
  and kept but not shown or updated. Background tasks (`backgroundTasks` chips).
- **Prompts and memory**: 2.0 sends a short system prompt (who it is, where memory.md is). 1.x's
  Prompts.swift (wake briefing with recent chat, tidy-before-sleep, inbox delivery, project briefing
  for the main bot, results rule, choices rule, component rules) is not ported. No chat archive.
- **Routines** (routines.cron, ScheduledRoutines → `JobStore`), Catch-up generation (the button is
  hidden), task cards (`tasks.json` kept, not shown), group chats and @ call-ins, feedback relays.
- **Components and plugins**: the component library, `<show>` displays (imported `displays` are not
  drawn), pins/Board/floating cards, specs, Maintainer, the plugin host and its plugins other than
  ccb-latex (bundled), `/` commands.
- **Composer**: steering while a reply runs, attachments (`+` does nothing; dropped files are
  ignored), replies to a message, drafts across restarts, reactions, @ mentions.
- **Settings** (model, effort, auto mode, language — the page is in English; `settings.json` is
  imported and kept), spending and rate limits, Doctor, updates.
- **Browser / web AIs, community share, release planner, screenshots of components.**
- Attachment pictures from imported chats do not load (the chat page's CSP has no `file:`; a
  protocol that serves only attachment folders is the plan).

## Decisions made in Phase 0 (and why)

- **Electron 44.9.3, zod 4.6.7, vitest 4.1.12** (not newer majors): Electron 45.0.0 was 4 days old;
  44.7.0 was first picked for age, then bumped to the patched 44.9.3 because `npm audit` flagged a
  high-severity advisory. Same for zod/vitest. React 19.3.0, TypeScript 5.9.3 (as `Web/`),
  esbuild 0.28.2 (as `Web/`), Playwright 1.64.0.
- **Core as an Electron `utilityProcess`**, not `child_process` with `ELECTRON_RUN_AS_NODE`: it
  survives renderer reloads/crashes, does not need the RunAsNode fuse (which packaged builds should
  turn off), and talks over `parentPort`. The same core runs under plain Node over stdio JSON lines
  (like `Web/host`), which is how the unit tests drive it.
- **zod for runtime validation** on every hop rather than hand-written guards: one schema gives the
  type and the check. Cost: ~0.7 MB per bundle; `zod/mini` is an option later.
- **Cards load from a custom `botling-card://` URL, not `srcdoc`**: a `srcdoc` frame inherits the
  app's CSP, which forbids inline script; a separate URL gets its own strict CSP header. Still
  `sandbox="allow-scripts"` (opaque origin).
- **Card identity comes from the frame, never the message**, and messages are strict, so a card
  cannot claim another card or bot. The core re-checks that the card exists and decides what an
  action means (only `say` exists now).
- **Main blocks every frame navigation the app's page did not start**, which closes "card navigates
  itself to another card's URL".
- ~~**One CLI process per turn**~~ — superseded in Phase 1b by the long-lived head; the per-turn
  runner (`agent/runner.ts`) is kept and tested but the core no longer uses it.
- **`npm run dev` uses the real CLI in "harmless" mode** (`--safe-mode`, no MCP, no saved session,
  no tools unless `BOTLING_HARMLESS_TOOLS`); `BOTLING_HARMLESS=0` is a real bot. The fake CLI is the
  default everywhere else.
- **Data root**: `BOTLING_DATA_DIR`, Electron's userData/sessionData moved under it. A packaged
  build uses `<appData>/Botling 2`, separate from `~/.claudecodebot`, imported read-only on first start.
- **No React state library**: `useSyncExternalStore` over a small store is enough for one view.
- **Closing the window does not stop work** on macOS (the core keeps running); quitting stops the
  core, which stops its turn and ends the tree.
- Kept `desktop/` independent of `Web/`'s build (its own `package.json`, `node_modules`, esbuild
  script). Since Phase 1b the chat itself is Web/src's page with its own chat.css; the React
  chrome's colours (`src/renderer/styles.css`) are Theme.swift's.

## What's next (proposed)

1. **Run the live approval test once** (`npm run test:live -- -t "asks before"`, one real call).
2. **Prompts and memory**: port the wake briefing (memory.md + recent chat), tidy-before-sleep and
   inbox delivery from Prompts.swift/Bot.swift; decide fresh-session-per-wake (1.x) vs resume.
3. **Subagents and background tasks**: parse `task_started`/`task_notification` and
   `parent_tool_use_id` into Subagent records (subagents.json), rows under the bot, their view.
4. **Steering**: a message during a turn → `send` + `interrupt {send_now}` as 1.x does.
5. **Composer parity**: attachments (a main-owned file picker + a protocol serving attachment
   folders), replies, drafts, reactions.
6. **Settings** (React): model, effort, language (pass `lang` to the page), auto mode; then the
   right panel (tasks, subagents) in React.
7. **Codex head** (app-server JSON-RPC) behind the same Bot/head interface; then workers.
8. **Routines** on `JobStore` (app running only, as decided); Catch-up generation.
9. Card API (`ccb.answer`, `runDetail`, …) and the component library through the broker.
10. **Windows 11 VM**: run the suite; Job Object helper; native vs WSL CLI backend switch
    (decided: native host, swappable backend).

Packaging (not done): electron-builder `dir` target for a macOS dev build, Electron fuses
(RunAsNode off, NodeOptions off, cookie encryption on, ASAR integrity, only-load-from-ASAR), code
signing/notarization, then Windows installer signing.

## Risks

- **Windows is entirely unverified**: process trees, paths, `claude` resolution, atomic rename,
  WSL vs native (a product decision — see below).
- **Card API breadth**: the spike covers save/action only; the existing component library uses
  more, and every new capability is a new hole to check.
- **Descendants that escape the process group** (`setsid`) survive Stop on macOS/Linux, as today.
- **Lock staleness**: a live lock holder stalled past 10 s can have its lock broken; transactions
  are tiny, but a frozen process (debugger, SIGSTOP) could in theory cause a double claim.
- **Bundle size / memory**: not measured. The unpacked Electron 44 runtime is ~310 MB on macOS arm64 (before packaging/compression).
- **Real sites and OAuth**: some providers refuse embedded browsers; WebKit cookies will not carry
  over (users re-login).
- **Linux**: the Chromium sandbox needs user namespaces or the SUID helper; Wayland window
  placement/tray limits. Not tried.
- **The real CLI reads the user's settings, hooks and CLAUDE.md** (same as 1.x). Fine for the app;
  live tests now use `--safe-mode`, but user permission rules (and claude's own read-only command
  allowances) still apply, which is why an `echo` was never asked about.
- **A manager shares its project's `.bot/memory.md` with 1.x**: both apps on one project at once
  can interleave edits.
- **The chat page is app code with `style-src 'unsafe-inline'`** (KaTeX) and runs agent markdown
  (raw HTML off, as in 1.x). A markdown-it or KaTeX bug that lets HTML through would run with the
  chat page's rights (no bridge, but it can `postMessage` the app page, which takes only card
  saves/actions and the page's own actions from it). Cards stay in their sandboxed frames.
- **Bundle size**: the chat page bundle is ~1.5 MB (CodeMirror, markdown-it, zod); fine for a
  desktop app, not measured for memory.

## Needs the user

Decided already (for the user, in Phase 1b): Windows native host with a swappable native/WSL CLI
backend; Linux experimental; routines run only while the app runs; 2.0 has its own data folder and
imports `~/.claudecodebot` read-only on first launch; the chat view reuses Web/src first, React
for the chrome.

Still open:
- One real `claude` call to confirm the approval round trip (the fake CLI and 1.x's identical
  protocol code cover it, but 2.0's has not seen a real `can_use_tool` yet).
- Fresh session per wake (1.x, with a memory briefing) or resume the last one (2.0 now)?
- Should a 2.0 project manager work in the project folder (shared `.bot/memory.md` with 1.x, as
  now) or keep its notes in 2.0's folder while both apps exist?
- A Windows 11 machine or VM for spike 4.
