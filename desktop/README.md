# Botling 2.0 desktop (React + TypeScript + Electron)

Status: **Phase 0 spikes done on macOS; Phase 1b done: several bots with 1.x-compatible storage, a
read-only 1.x import, a long-lived claude head per bot with approvals, and a React shell hosting the
reused Web/src chat page. Phase 2a done: 1.x's generated instructions (checked string for string
against the Swift code), sleep/wake/tidy as 1.x, steering a running reply, the reply tags (choices,
no-reply, task cards, reactions), Agent-tool subagents, the chat archive and a project lock. Phase 2b
done: a Codex head (`codex app-server`, as a coordinator with app-managed workers), and Claude and
Codex as two heads of one bot (claim, hand-offs with their budgets, shared decisions), with the
Codex prompts checked string for string against the Swift code. Phase 3a done: two-head timing as
1.x (Claude hears the other head mid-turn; a message steers a Codex turn), routines (routines.cron and
app-owned schedules, Codex's `app_routines`), command monitors, Catch-up and interval summaries, and
components (the library, `<show>` cards with the full `ccb` API, commands after Allow, pins and the
Board). Phase 3b done: plugins (the library, on/off and settings, secrets sealed with Electron
safeStorage, the existing Node plugin host as its own untrusted process with hooks, commands and
routines, plugin panels in sandboxed frames, the import of 1.x's library), Maintainer (component and
plugin requests, `<install>` asking first, its instructions and the component editor checked against
the Swift strings), pausing handed-over work for your message as 1.x, and a deterministic hand-off e2e.
Phase 4a mostly done: the chat page on its own origin with plugins' web parts in it, attachments,
Settings in React, and the main bot's world (Add project, `<new-project>`, the project list it wakes
with, inbox delivery, "Waiting on you" and the right panel); the built-in browser / web chats are not
started.**
Not yet a replacement for the Swift app (see "Gaps vs the Swift app").
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
| `npm run test:live:codex` | One real Codex turn and one real two-head claim (three turns; Codex gets a throwaway `CODEX_HOME` with a copy of `auth.json` only). |
| `npm run test:live:3a` | Phase 3a's real checks: claude hearing a message mid-turn, a monitored command through `codex app-server`'s `command/exec`, a Catch-up summary by `codex exec` (same throwaway `CODEX_HOME`). |
| `npm run typecheck` | `tsc --noEmit`. |

Since Phase 3b the build also writes `out/host/host.mjs` (Web/host/src/host.ts, bundled as Web/build.mjs
bundles it for 1.x) and `out/host/check-plugin.cjs` (the plugin check, the command Maintainer runs).

Data goes to `$BOTLING_DATA_DIR`, by default `desktop/.data/` in development (ignored by git) and
`<appData>/Botling 2` when packaged. The core's part is `<data>/core/`, in the Swift app's layout
(below); Electron's own profile, partitions and caches are under `<data>/electron/`. Tests use
throwaway folders in `desktop/.tmp/` (`.tmp/screens/` keeps the screenshots `look.spec.ts` takes).

Import: a **packaged** app imports `~/.claudecodebot` on its first start (read-only). A development
run imports only what `BOTLING_IMPORT_FROM=/path/to/a/1.x/folder` names, so `npm run dev*` and the
tests never read the real folder. Try it on a copy: `BOTLING_IMPORT_FROM=… BOTLING_DATA_DIR=.tmp/try npm run dev:fake`.

Other knobs (all optional): `BOTLING_APPROVAL_TIMEOUT_MS` (default 10 min, as 1.x),
`BOTLING_IDLE_MS` (a head tidies and sleeps after 30 min idle), `BOTLING_TIDY_TIMEOUT_MS` (the tidy
turn's limit, 5 min), `BOTLING_QUIT_TIDY_MS` (how long an awake bot may tidy when the app quits, 15 s;
0: no tidy), `BOTLING_1X_DIR` (1.x's data folder, to see whether 1.x has a project open; packaged
builds use `~/.claudecodebot`, development runs only what this names), `BOTLING_1X_PROCESS` (a regex
for 1.x's command line, default `…/Contents/MacOS/botling`), `BOTLING_LANGUAGES` (system languages,
set by main, for the reply language when settings.json names none), `BOTLING_INTERRUPT_GRACE_MS` (how long Stop
waits for claude before ending the tree, 2 s), `BOTLING_HARMLESS=0` (real tools, CLAUDE.md, MCP and
saved sessions in `npm run dev`), `BOTLING_HARMLESS_TOOLS=Bash` (tools that exist in harmless mode),
`BOTLING_MODEL`, `BOTLING_CLAUDE_PATH`, and for Codex heads `BOTLING_CODEX_PATH` (default `codex`),
`BOTLING_CODEX_MODEL`, `BOTLING_CODEX_EFFORT` (low … xhigh), `BOTLING_CLAIM_WAIT_MS` (how long the second
head waits for the lead's first words, 20 s as 1.x), `BOTLING_FAKE_CODEX` (the fake app-server, set by
main for `dev:fake`), `BOTLING_ROUTINE_TICK_MS` (how often routines are checked, 30 s as 1.x; 0: never),
`BOTLING_COMPONENT_SCAN_MS` (how often the component library is looked at for changes, 1.5 s),
`BOTLING_SUMMARY_TIMEOUT_MS` (a Catch-up summary's limit, 60 s), `BOTLING_PLAIN_SHELL=1` (component
commands run with `/bin/sh -c` instead of 1.x's login shell `zsh -lc`; the tests set it so they never
read the user's shell files). A real Codex head reads the user's own `~/.codex` (or `CODEX_HOME`) like 1.x; the
thread's approval policy and sandbox are always said explicitly. Since Phase 3b: `BOTLING_NODE_PATH`
(the Node that runs the plugin host; default: the core's own runtime — under Electron, Electron run as
Node, development only), `BOTLING_GIT_PATH` (git for the plugin library; default: Homebrew's, then
`/usr/bin/git` only when the developer tools are installed), `BOTLING_MOCK_KEYCHAIN=1` (safeStorage
uses Chromium's mock keychain: the e2e tests set it, so they never touch the login keychain),
`BOTLING_TEST_SEAL_KEY` (a headless core — the unit tests — seals secrets with this key instead of
safeStorage; without it and without Electron, secrets cannot be kept).

A bot gets two heads from bot.json's `heads` key in 1.x's format (`{"engines":["claude","codex"],
"answerWith":"both"}`, kept by the import), or with the `heads.set` command (there is no Settings page
yet). A bot whose `engine` is `codex` has a Codex head only.

In the fake CLI (`npm run dev:fake`) a message can start with a directive: `/tool ls -la` (asks to run
it: try Allow once / Don't allow), `/tool:WebFetch https://x` (a tool that can be "always" allowed),
`/slow` (streams until Stop), `/stubborn` (ignores Stop and SIGTERM: the tree is killed), `/card`,
`/crash`, `/resume` (says which session it runs and whether it was resumed), `/choices`, `/task`,
`/team` (a request 2.0 cannot do), `/react <message id>`, `/agent` (a subagent that reads a file and
reports), `/bgagent` and `/bgagent:silent` (a background subagent that reports later in claude's own
turn, which says something or only `<no-reply/>`). App notes in a message (`(App: …` paragraphs) are
not echoed; the tidy note is answered `OK` after writing the memory file it names.
`FAKE_CLAUDE_INPUT=<file>` logs every message the fake reads (what claude would see). Both fakes also
take `/say <text>` (reply exactly that, e.g. a `<handoff>` tag) and `/solo <words>` (with two heads, the
head that hears the other's words first says only `<no-reply/>`), and answer work the other head
hands over ("Did it: <task>"; `/handoff:claude <task>` as the task hands it on) and hand-backs
("Done: <reply>"); since Phase 3b handed-over `/slow …` works until interrupted (Codex: until steered,
then "Answered you: …"), the resume note is answered "Carried on: finished the handed work.", and work
the app hands over ("(From the main bot) …", Maintainer's jobs) is answered "On it." without echoing its
tags. `FAKE_CODEX_WORKER_GATE=<file>`: a worker reports only once that file exists. Since Phase 3a: `/linger <words>` (says "Thinking it over." before a tool call, takes
`FAKE_CLAUDE_LINGER_MS`, then "You said: …", with "(heard mid-turn: N)" when the other head's words
came meanwhile); the other head's words that arrive while a turn runs are read into it (logged with
`midTurn: true`), or — `FAKE_CLAUDE_NO_ABSORB=1`, what real claude did for a text-only turn — answered
in a turn of their own (`<no-reply/>` after `FAKE_CLAUDE_NOTE_MS`); messages sent with a `uuid` get
`command_lifecycle` queued/started lines.

The fake Codex (`test/fixtures/fake-codex.mjs`) speaks app-server's JSON-RPC: `/tool <cmd>` (asks
first), `/slow`, `/choices`, `/worker <task>` (an app-managed worker that reports after
`FAKE_CODEX_WORKER_MS`; `/slowworker`, `/failworker` in the task), report turns that record an
`app_task_checkpoint` (`/nocheckpoint` in the report: none), and a tidy done through a worker.
`FAKE_CODEX_INPUT=<file>` logs every turn input, steer, report and thread start. Since Phase 3a:
`/monitor <cmd>` (app_monitor_start; `command/exec` really runs the command, `command/exec/terminate`
ends it; the `app_monitor_result` wake answers "Monitor <status>, exit <code>: <stdout>"), `/routine
<json>` (app_routines with those arguments), and `exec …` as Catch-up runs it (bullets citing the last
three messages; `FAKE_CODEX_EXEC_LOG`, `FAKE_CODEX_EXEC_FAIL=1`, `FAKE_CODEX_EXEC_MS`).

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
│ Bot (bot.ts), one per bot: chat.json/bot.json/tasks.json/subagents.json in 1.x's format ·       │
│   one turn at a time (steered) · approvals · reply tags (reply.ts) · tasks.ts · subagents.ts ·    │
│   prompts.ts + briefing.ts (Prompts.swift, wake/tidy, archive) · store/lock.ts (project lock)     │
│   ClaudeHead (agent/head.ts): one long-lived `claude -p --input-format stream-json` per bot,     │
│   own process group, --session-id then --resume, --permission-prompt-tool stdio; stream.ts parses│
│   or CodexHead (agent/codex.ts): one `codex app-server` per bot (CodexSession = the protocol),    │
│   a coordinator with app_handoff workers; codex-threads/<session> keeps the thread and workers   │
│   two heads: the primary Bot + a partner Bot (partner-<engine>/), lines mirrored into one chat;  │
│   heads.ts: hand-off tags, the Conductor (budgets, hand-backs, the limit card), notes            │
│ routines.ts (routines.cron + scheduled-routines.json, the 30 s clock) · catchup.ts (summaries)   │
│ components/ (library, commands after Allow, pins, pictures by token) · agent/monitors.ts         │
│ ProcessLedger: ends heads a crashed core left · durable/ (atomic files, locks; JobStore spike)  │
│ plugins/ (registry, sealed secrets, host client) · maintainer.ts (Maintainer's desk, installs)   │
└──────────────┬───────────────────────────────────────────────────────────────────────────────────┘
               │ JSON-RPC lines on stdio, every message checked (host-client.ts)
┌──────────────┴─ plugin host (untrusted): Web/host/src/host.ts unchanged, own process group ─────────┐
│ every enabled plugin's program part; allow-listed environment (no BOTLING_*, no secrets but each   │
│ plugin's own, in its spec); may ask only bots.list / routines.add / bots.create (refused: no bots  │
│ yet) and notify / bots.send (needs "bots"); restarted after 300 ms, the plugin it ran is blamed    │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
Secrets: the core asks main (`{botling:"seal"}` on its port) to seal/open with safeStorage; only sealed
bytes reach <core>/plugin-secrets.json. Plugin panels: the app page frames the plugin's web part at
botling-card://page/<token> (sandboxed, PANEL_CSP: inline + blob: scripts, no network).
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
<core>/<bot>/partner-<engine>/   the other head of a two-head bot: its own chat.json (its lines, also
                            in the shared chat.json), subagents.json, bot.json — as 1.x
<core>/codex-threads/<session>   1.x's: the Codex thread a bot session is; .previous-threads,
                            .managed (the tool schema the thread was made with), .workers.json
                            (CodexManagedWorkerRecord: task id, name, instructions, thread, run, …),
                            .monitors.json (CommandMonitor: command, state, exit code, output, wake)
<working folder>/routines.cron, scheduled-routines.json   1.x's: the bot's routines (main: <core>/main/;
                            a project: <project>/.bot/; scheduled-routines.json beside routines.cron)
<core>/<bot>/pins.json      1.x's: the bot's pinned components
<core>/plugins/<plugin>/components/<name>/   the component library (template.html, about.md, …);
                            ccb-components first. The first launch imports 1.x's (text files only)
<core>/approved-commands.json   1.x's format: component commands the user allowed, by folder
                            (2.0 does not import 1.x's: it asks again)
<core>/catchup-summaries.json   1.x's format: ≤ 200 summaries by range (1.x keeps it in ~/.claudecodebot)
<core>/plugins/             1.x's: the plugin library (a git repo once Maintainer gets work): plugins'
                            folders, ccb-components, ccb-core (the component editor agent), PLUGINS.md,
                            and Maintainer's notes (.bot/memory.md)
<core>/plugins.json         1.x's format: disabled, settings (never a secret one), failures, installed
<core>/plugin-secrets.json  2.0: plugins' secret settings, sealed by safeStorage (base64), 0600
<core>/plugin-data/<name>/  1.x's: a program part's storage (ccb.storage)
<core>/component-editor.json    1.x's: hashes of the editor file the app wrote / you chose to keep
<core>/install-staging/     1.x's: a fetched plugin until you answer Install / Don't install
<core>/projects/DEC0DE00-…/     Maintainer's chat files (1.x's fixed id)
```

bot.json keys 2.0 now writes too: `heads` and `engine` (1.x's); since Phase 3a `routineRuns` (when
each routines.cron job last ran) and `components` (its own list). Chat lines keep 1.x's `displays`
(name, data, at, command, savedAt, id, refresh). Chat lines carry 1.x's `engine`,
`to`, `seenBy` and `decisionID` (and choices their `id`).

Formats follow Swift's `JSONEncoder` as 1.x uses it: dates are **seconds since 2001-01-01**
(`deferredToDate`), UUIDs upper case, URLs as `file://` strings, nil fields left out. 2.0 keeps
every key it does not know as it was, and adds its own (`turnID`, `state`, `cards`, `error`), which
1.x's decoder ignores. Message ids are UUIDs (1.x fails a whole chat.json on one bad id).

### The contract (`src/contract/index.ts`, protocol version 8)

Version 8 (Phase 4a, the main bot's world) adds: main-only `projects.pick` (main's folder picker, then
`projects.add`, which the page may not send: it never names a path), core `projects.add`, `waiting.list`,
`waiting.ignore`, event `waiting.updated` and the snapshot's `waiting` (`{items: [{botId, text,
messageId}], doing: {botId: "In progress" line}}`). Version 7 (Phase 4a) added attachments (`files.pick`
in main, `files.add`, `files.data`, `files.remove`, `attachment.file`, event `files.updated`,
`chat.send` with files only, `chat.answer.images`), plugins' web parts for the chat page (`plugins.web`,
`plugins.loaded`, `plugins.failed`, `plugins.notice`, `plugins.file`) and, without a version bump,
Settings (`settings.get`, `settings.set`, `bot.settings`, `bot.configure`, event `settings.updated`).

Version 6 (Phase 3b) adds: `plugins.list`, `plugins.enable`, `plugins.setting`, `plugins.secret` (a
value goes in, never comes back), `plugins.command`, `plugins.panel` (a panel's web part and settings),
`plugins.call` (a panel's `host.call`; the plugin comes from the frame), event `plugins.updated`, the
snapshot's `plugins`, `card.page.panel`, and `chat.send`'s `stoppedBy` (a plugin's beforeSend stopped the
message: `turnId` is null, `messageId` the notice).

Version 5 (Phase 3a) adds: `routines.list`, `routines.change` and event `routines.updated`;
`catchup.retry`, `catchup.interval`, event `catchup.updated` and the snapshot's `catchUp` /
`intervalSummaries`; `MessageView.displays`, the snapshot's `components` (the library), `pins`,
`floating`, `pinChoices`, events `pins.updated` and `components.updated`; `component.command`,
`component.detail`, `component.save`, `pin.add`, `pin.change`, `pin.arrange`, `pin.command`,
`pin.shown`; main-only `card.page` (a component frame's page) and core-only `card.image` (a picture by
token).

Version 4 (Phase 2b) adds: `chat.send.to` (both, or one head), `heads.set`, `heads.answerWith`,
`handoff.stop`, `rounds.stop`; event `heads.updated`; `BotView.heads`; `MessageView.engine / to /
seenBy / decisionId`; the snapshot's `runs` (every turn under way, with its head and steps) and
`heads` (answerWith, the rounds line, the hand-offs). Below is the Phase 1b description.

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
(`rename` over an open file), pid reuse beyond the start-time check. Phase 3a's routines use the same
atomic files and locks with 1.x's scheduled-routines.json and its claim → dispatch → fired contract
(`core/routines.ts`); the JobStore class itself stays a spike.

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
- ~~**Sessions resume across sleeps and restarts**~~ (superseded in Phase 2a: a new session per wake, as 1.x) (`head.json`), unlike 1.x, which starts a fresh
  session on each wake and briefs it from memory.md. Cheaper to build now; the memory briefing and
  tidy-before-sleep are a gap (below).
- **Stop** keeps Phase 0's guarantees (gate first, nothing after, tree ended if needed) but asks
  claude first (`interrupt`), so the session and the head survive a normal Stop. A plain interrupt
  also ends background tasks — what Stop should do. (1.x has no Stop button; it steers with
  `interrupt` + `send_now` when you write again.)
- ~~**One turn at a time per bot**: a message while a reply is written is refused~~ (superseded in
  Phase 2a: it steers the reply, see below).
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

## Phase 2a: what was built and how it was checked

| Piece | What it does | Evidence |
| --- | --- | --- |
| Generated instructions (`core/prompts.ts`) | Prompts.swift for a Claude head: system prompt (main, manager, bot of its own; language and results rule from settings.json, else the system language), headsRule, wake, tidy, handoff, resume; the app leads and notes | `unit/prompts.test.ts`: **13 configurations × 6 strings equal, character for character**, to strings the Swift code wrote (`test/fixtures/prompts-golden.json`), and the **48 SHA-256 digests** ClaudePromptCompatibilityTests freezes (read from the Swift test file at test time) |
| Wake briefing, archive, reactions (`core/briefing.ts`) | `Bot.recentChat` (last 20 lines, 600 characters, options and picks, files), `Bot.archiveEntry` + a markdown file a month in the bot's `archive/` (a chat from before is archived once), `ReactionContext.intro/update` | Same golden file: equal for the same messages (the stamp follows the locale: checked with en-GB, 12-hour, as the Swift run had) |
| Reply tags (`core/reply.ts`) | ReplyParser: code is masked; `<choices>` (last block wins), `<no-reply/>`, `<task …/>`, standalone `<reaction …/>`, `<show>` (kept in 1.x's `displays`, not drawn yet), decision refs, `<end>/<block>`, every request tag | `unit/reply.test.ts`: **21 replies parsed exactly as Swift parsed them** (body, choices, tasks, reactions, displays, requests, signals, saysNoReply, saysNothing) |
| Task cards (`core/tasks.ts`) | TaskBook: a card per message, claimed by the first words, kept by a tool, named/moved by `<task>` lines, `continues=`, joins, quick answers dropped, settled when the turn ends; tasks.json in 1.20's format; chips under replies ("Now: …", "Waiting on you: …", "May be stuck") | `unit/reply.test.ts`: an 18-step scenario gives **the same cards** as Swift's TaskBook; `unit/lifecycle.test.ts`; `e2e/phase2a.spec.ts`; screenshot `task-chip.png` |
| Acting on tags (`core/bot.ts`) | Choices are buttons; a pick (or typed answer) goes back as the user's message *replying to the question* (1.x's "(Replying to …)" line); `<no-reply/>` hides claude's own turns; a silent turn after a finished subagent is asked once to report (`Bot.reportNote`), then the app says it; reaction-only replies show no line; other requests are taken out and a notice says 2.0 cannot do them yet; tags never flash while streaming | `unit/lifecycle.test.ts` (choices, answer, task, team notice, reactions, no-reply + report), `e2e/phase2a.spec.ts`, screenshot `choices.png` |
| Sleep/wake/tidy | After `idleMs` with nothing under way (no turn, approval, waiting message, running subagent) the tidy turn runs (hidden, approvals refused), then stdin is closed; the next message starts a **new session** whose first message is wake line + recent lines + reactions intro + the words (1.x's order). The app starting is a wake; quitting tidies awake idle bots (bounded) | `unit/head.test.ts` (tidy text sent, memory file written, new session, exact briefing), `e2e/phase2a.spec.ts` (header "Tidying its notes…", screenshot `tidying.png`) |
| Steering | A message during a user's reply with no approval open and no subagent at work: the reply so far stays as a cut-off bubble, the two parts go as one (`(I sent this in parts…)`), then `interrupt` (message first, as 1.x); otherwise it waits and goes when the turn ends | `unit/lifecycle.test.ts`, `unit/core.test.ts`, `e2e/phase2a.spec.ts` (`steering.png`), **live**: real claude cut the counting turn and answered both parts in one reply |
| Subagents (`core/subagents.ts`, `agent/stream.ts`) | TraceBook's rules: Agent/Task calls, `task_started`, lines with `parent_tool_use_id`, structured launch results, `task_notification` (hand-back report, "still waiting"); subagents.json in 1.x's format (40 ended kept); steps carry status and tool count; `subagent.view` + the page's own subagent view (back button); a background one keeps the bot awake; claude's own reporting turn is shown | `unit/stream.test.ts`, `unit/lifecycle.test.ts`, `e2e/phase2a.spec.ts`, screenshots `subagent-running.png`, `subagent-view.png` |
| Project lock (`core/store/lock.ts`) | A manager takes `<project>/.bot/botling.lock` (pid, start time, host); a live holder elsewhere — or a running 1.x whose projects.json lists the folder — leaves the bot read-only with a banner; a dead holder's lock is taken over; tried again on each send | `unit/lifecycle.test.ts` (two cores, stale lock, a 1.x stand-in process), `e2e/phase2a.spec.ts` (`locked-project.png`) |
| Contract v3 | `chat.answer`, `chat.react`, `subagent.view`, `chat.send.replyTo`, `chat.choose.text`; events `message.removed`, `tasks.updated`, `subagent.updated`; `tidying` phase; step status/count; message reactions/replyTo | `unit/contract.test.ts`, the rest |

Tests: unit 109 (vitest), e2e 19 (Playwright/Electron), all green. Live (real `claude` 2.1.310,
harmless mode): 3 calls this phase — steering passed; the "choices" check twice: claude, given the app
prompt but **no tools** (harmless), wrote fake `<invoke>` tool calls as text for minutes (stopped by
the test). Harmless mode now leaves the app prompt out again; that check runs only with
`BOTLING_LIVE_REAL_BOT=1` (real tools), not run.

### How the golden strings are made

`Tests/ClaudeCodeBotCoreTests/DesktopPromptGoldenExport.swift` (a Swift test that runs only when
asked) writes them (since Phase 2b also the Codex prompts, the heads rules, HeadTags samples, the
notes between the heads and five Conductor runs). After changing Prompts.swift, ReplyParser.swift, TaskCards.swift or the briefing
code (since Phase 3a also CatchUp.swift's prompt/instructions/arguments and ComponentKnowledge), in this worktree:

```sh
CCB_DESKTOP_PROMPT_EXPORT=$PWD/desktop/test/fixtures/prompts-golden.json TZ=UTC \
  swift test --scratch-path /Volumes/My-SSD/botling-work/swift-build --filter DesktopPromptGoldenExport
```

### Decisions (Phase 2a)

- **Sleep/wake as 1.x** (the user's call): a new session per wake, primed by the wake briefing
  (which tells claude to read memory.md — 1.x's Claude path; the file is not inlined), the tidy turn
  before sleeping and before quitting. head.json is still written but no longer resumed across
  sleeps or app starts. A crash mid-run still restarts with `--resume` (Phase 1b's choice; 1.x would
  wake a new session) — the session is alive and the briefing would only repeat it.
- **Steering as 1.x where it is simple**: the merge path is 1.x's (`Bot.merging`). Where 1.x hands the
  message to claude at once (approval open, subagent at work) or ~~pauses claude's own work for it
  (`pauseNote`)~~ (done in Phase 3b), 2.0 queues it until the turn ends — nothing is lost and no turn is cut that 1.x would
  keep. If the interrupt lands on the merged turn (the first ended on its own just before), it is
  sent again once.
- **One bubble per reply** stays (Phase 1b): 2.0's reply text has every text block of the turn, so
  1.x's "lift tags written before a tool call" is not needed.
- **Unsupported requests are visible**: rather than silently dropping `<team>`, `<new-bot>`, … a
  notice says nothing happened.
- **Project lock**: 1.x code is not changed, so 1.x is detected (running app + its projects.json).
  A project bot's chat files stay in 2.0's folder; only `.bot/` (memory, archive) is shared. The
  archive of a project bot is the project's `.bot/archive/` as in 1.x, so both apps' lines can land
  in it (not at the same time).
- **No app prompt in harmless mode** (see the live finding above).
- **Language**: settings.json `languageChoice`, else the system's preferred languages
  (`AppLanguage.preferred`), else English — as 1.x.

## Phase 2b: what was built and how it was checked

| Piece | What it does | Evidence |
| --- | --- | --- |
| Codex prompts (`core/prompts.ts`, `prompts-codex-text.ts`) | Prompts.swift with `engine: .codex`: the Codex note, local report rules, the delegation policy, Codex wake/tidy/handoff/resume, the worker instructions; each head's heads rule | `unit/prompts.test.ts`: **11 Codex configurations × 7 strings** and 4 heads rules (limits, hand-offs off) equal to strings the Swift code wrote (`prompts-golden.json` `codexPrompts`, `headsRules`) |
| Two-head pieces (`core/heads.ts`) | `HeadTags.parse` (`<handoff to kind decision>`), the notes one head gets about the other, the Conductor: per user message 6 hand-offs / 2 reviews / 3 discussion rounds, hand-backs, the limit card (Go with … / One more round) or "use doers", Stop of one chain | `unit/heads.test.ts`: 7 tag samples, 12 notes and **5 Conductor runs, action for action and record for record**, as Swift ran them (`prompts-golden.json` `heads`) |
| Codex head (`agent/codex.ts`) | `CodexSession` (CodexAgentProcess.swift's): initialize → thread/start (on-request, workspace-write, reviewer user, coordinator: no shell, no native subagents, the 7 app tools) or thread/resume + inject_items; turns, `turn/steer`, `turn/interrupt`; command/file/permission approvals (a refusal's reason goes in as a steer); commentary as steps, the final answer as the reply; `CodexHead` runs it in its own process group | `unit/codex.test.ts`: **real codex-cli 0.163.0 lines** (recorded for the Swift tests, `codex-recordings.json`) replayed: hello, an approval answered and one taken back, a patch as a Write step, steering, interrupt (also before the turn has an id), finish, resume |
| App-managed workers | `app_handoff` → a worker thread (worker instructions, own model), its steps under its subagent row, `app_send_message` (steer, or a new run of the same session), its end → a report turn on the coordinator with `app_task_result`, `app_task_checkpoint`, one hidden reconciliation turn then the evidence as an error; records in `codex-threads/<s>.workers.json` (a worker at work when the app stopped reports `interrupted`); Stop of the app cancels workers | `unit/codex.test.ts` (5 cases), `unit/two-heads.test.ts` (start, steps, report, records, subagents.json), `e2e/heads.spec.ts` (`codex-worker-running.png`, `codex-worker-report.png`) |
| Codex in the bot (`core/bot.ts`) | Codex wake briefing (memory snapshot inlined, chat as history), approvals, Stop, the tidy handed to a worker (the bot sleeps after its report says OK), no sleep while workers run | `unit/two-heads.test.ts` ("a Codex head", 4 cases) |
| Two heads (`core/bot.ts`) | A primary Bot and a partner Bot (1.x's `partner-<engine>/`), lines in one chat; a message to both: the lead (free, taking turns) first, the other with its reply or its first words (`headWords`), or after `claimWaitMs`; parts of a held message join it; `<no-reply/>` from the head with nothing to add shows nothing; a message for one head reaches the other as a note; each head hears the other's replies (with its next message, or at once when it is Codex at work: `turn/steer`); seen marks; hand-offs carried by the conductor, the rounds line, the limit card; shared decisions (`decision=` on a hand-off, `<decision-ref/>`, one pick dispatched once to the head that asked); `heads.set`, the saved Both/Claude/Codex | `unit/two-heads.test.ts` (7 cases: claim and taking turns, release on words and on the wait, no-reply and one-head messages, hand-off and hand-back, the budget card and One more round, a decision answered once, a restart); `unit/payload.test.ts`; `e2e/heads.spec.ts` |
| The app | Labels "Main bot · Claude/Codex", "to Codex", seen marks, the composer's Both/Claude/Codex switch (saved), several turns at once (Stop stops all), a rounds line with Stop now, "Claude & Codex" beside the name | `e2e/heads.spec.ts`, screenshots `heads-both.png`, `heads-codex-only.png`, `heads-handoff.png`, `codex-worker-*.png` (looked at) |

Tests: unit 165 (vitest), e2e 21 (Playwright/Electron), all green. Live (Phase 2b, 3 real calls of
the 4 allowed): `npm run test:live:codex` once — a Codex head (real `codex app-server` 0.163.0,
throwaway `CODEX_HOME` with a copy of `auth.json` only, removed afterwards) answered "hello" and wrote
its thread files; with both heads, real claude (harmless mode) led ("你好呀！👋": harmless claude still
reads the user's language setting) and real Codex got the message with Claude's reply and answered
"Hi!". Both passed.

### Decisions (Phase 2b)

- **Two heads as 1.x builds them**: a partner Bot with its own process, turns, approvals and files
  (`partner-<engine>/`), its lines the same records in the shared chat. Each head keeps its own
  queue and steering rules; the primary owns the chat, the task cards, the conductor and the decisions.
- ~~**Codex messages during a Codex turn wait**~~ (superseded in Phase 3a: they steer into it, and claude hears the other head mid-turn) for the turn (as 2.0's claude does when it cannot
  merge) instead of 1.x's `turn/steer` into the turn; the other head's words *do* steer into a
  Codex turn under way. Claude hears the other head with its next message (1.x also sends it
  mid-turn; claude's stream-json would make that a turn of its own).
- **A pick on a question asked by one head goes to that head** (`to`), not to both; a shared
  decision's pick goes once to the head that asked (1.x's `resolveDecision`).
- **Stop stops every turn under way** (both heads); Stop of a Codex turn interrupts the coordinator
  only, its workers go on (as 1.x).
- **The coordinator gets 1.x's 7 tools unchanged** (so the policy text and the tool stamp match);
  ~~`app_routines` and `app_monitor_*` answer that 2.0 cannot do them yet~~ (done in Phase 3a). The component-editor role is
  refused (no Maintainer in 2.0).
- **No auto mode yet**: Codex's reviewer is always the user (approvals in the chat).
- **Each head tidies itself** before it sleeps (1.x lets one head tidy the shared memory file).
- **The rounds line is drawn by the React chrome**: this checkout's chat page receives `rounds` and
  `handoffs` (as ChatPayload sends them) but does not draw them; the hand-off panel is not drawn yet.
- **Live Codex runs never touch `~/.codex`**: a throwaway `CODEX_HOME` with only `auth.json`.

## Phase 3a: what was built and how it was checked

| Piece | What it does | Evidence |
| --- | --- | --- |
| Two-head timing (`core/bot.ts`) | As 1.x: the other head's words (its first words, what it says between tool calls, its reply) reach a head **at work at once** — Codex as `turn/steer`, claude as a message written to its stdin (sent with a `uuid`). If claude reads it only after its turn ended (`command_lifecycle` "started"), that turn is the app's (`<no-reply/>` shows nothing, words show), and a message of ours sent meanwhile waits for it. A message from you while **Codex** works on anything but handed-over work joins its turn (`turn/steer`): one reply, which moves below your new line; your two messages' task cards join | `unit/two-heads.test.ts` ("timing as 1.x", "Claude hears the other head mid-turn", "words claude reads only after its turn ended…"), `unit/stream.test.ts`; **live**: real claude queued a message written mid-turn (text-only turn) and answered it in a turn of its own, with `command_lifecycle` queued/started — exactly the path 2.0 handles |
| Routines (`core/routines.ts`) | Routines.swift + ScheduledRoutines.swift: routines.cron (local time, `routineRuns`, first sight counts from now, a missed time runs once later that day; 1.x's old bot.json routines move into it; the main bot starts with the daily summary); app-owned schedules in 1.x's scheduled-routines.json — once (an instant with an explicit offset) or recurring (cron in an IANA zone, catching up only today), request ids for retries, **claimed and written before dispatch**, `fired` after, a claim nobody confirmed shown as `delivery_uncertain` and never sent again, pause/resume (resume skips what passed while paused)/cancel, corrupt files reported (in the chat, once) and never written over. The core checks every 30 s while the app runs; a divider "Name · 08:15", then 1.x's prompt to the bot's first head. Codex's `app_routines` uses the same store; a Routines panel in the header lists, pauses, resumes and cancels | `unit/routines.test.ts` (**19 cases ported from RoutineTests/ScheduledRoutineTests**: same inputs, same answers, plus DST folds and gaps), `unit/routines-core.test.ts` (a cron job runs once; a schedule claimed, dispatched, fired; a dead claim stays uncertain; a broken file; Codex's tool), `e2e/phase3a.spec.ts` (`routines.png`) |
| Command monitors (`agent/monitors.ts`, `agent/codex.ts`) | CommandMonitor.swift: `app_monitor_start/status/cancel` (only from the owning turn; 16 active, 128 kept), an **Allow once card that outlives the turn** (Codex ends its turn at once), then `command/exec` with the sandbox said explicitly (workspace-write, network off, 8 KB per stream), one `app_monitor_result` wake (the reply is "Monitor result: …" if the turn says nothing); Don't allow or Stop cancels and suppresses the wake; records in 1.x's codex-threads/<session>.monitors.json; after a restart a running or waiting command is `interrupted` (never run again) and reported, a wake mid-dispatch `uncertain` with a recovery note | `unit/routines-core.test.ts` (allow → run → wake once; deny → nothing), `unit/codex.test.ts` (restore/reconcile, owning turn, Stop); **live**: real `codex app-server` ran `command/exec` with exactly these parameters (exit 3, stdout kept) |
| Catch-up (`core/catchup.ts`) | CatchUp.swift + Workspace+CatchUp.swift: more than 3 unread replies fold into a summary when you open the chat; with `intervalSummaryEnabled` each closed interval is summarized by itself; the footer summarizes any interval; one isolated read-only `codex exec` per range (1.x's arguments, its JSON schema, events checked: only words, a finished turn), cached per range and language in catchup-summaries.json (over restarts), failures say why and Retry runs them again; settings.json's thresholds, model and writing preferences; the page's own Catch-up cards draw it (task chips included) | `unit/catchup.test.ts` (**prompt, instructions in 5 languages, arguments, schema, key and ranges equal to Swift's**, golden export extended), `unit/catchup-core.test.ts`, `e2e/phase3a.spec.ts` (`catchup.png`); **live**: real `codex exec` (gpt-6-luna, throwaway `CODEX_HOME`) wrote bullets citing the messages |
| Components (`core/components/`, `bot.ts`) | The library from `<core>/plugins/*/components` (imported from 1.x, text files only; rescanned every 1.5 s; about.md's Command/Detail command/Refresh/Sizes/Icon lines); each bot's list (bot.json `components`) and what it is told — the whole briefing at a wake, only changes later (**ComponentKnowledge equal to Swift's**); `<show>` cards (and `id=` updates in place), `ccb.save` kept in the line (and the bot told with your next message), an empty card said once, a component's answer sent as your words; commands only in the core, only after **Allow and run for exactly the command, folder and Detail command the card showed** (approved-commands.json), `zsh -lc` in the bot's folder, 60 s / 1 MB, the whole group ended; Detail commands with checked values only (`{save: true}` too); `ccb.image` pictures by token only; pins in 1.x's pins.json (chips with `ccb.setStatus`, the Board with sizes and places, ccb.save on a pin, refresh when shown / every N / on ↻ for pins in view, float in a corner), the header's Board button | `unit/components.test.ts`, `unit/components-core.test.ts`, `unit/importer.test.ts`, `e2e/components.spec.ts` (a hostile probe in a component frame: opaque origin, no bridge, no parent document, no storage), screenshots `component-card.png`, `component-command-ask.png`, `component-command-ran.png`, `component-board.png`, `component-pin-chip.png` (looked at) |
| Component frames in the reused page (`chat-frame/component-frames.ts`, `main.ts`) | Web/src draws a component in `<iframe sandbox="allow-scripts" srcdoc=…>`; a srcdoc frame would inherit the chat page's CSP (no inline script), so the page is handed to main (`card.page`, through the app page) and served from `botling-card://page/<token>` under its own CSP (inline script and style only; images data:/blob:/botling-card:; no network, frames, forms or workers); still sandboxed. Web/src's own listener remains the in-page broker (it finds a frame by its window); the app page paces a frame's calls (20, then 10/s) and turns them into contract commands the core checks again | `e2e/components.spec.ts`, `e2e/cards.spec.ts` (Phase 0's isolation tests still pass) |

Tests: unit 217 (vitest), e2e 25 (Playwright/Electron), all green. Live (Phase 3a, 4 real calls):
`npm run test:live:3a` once (claude mid-turn, codex `command/exec` — no model call —, Catch-up's
`codex exec`), then the claude check once more because the first run's console output was lost (it
now also writes `BOTLING_LIVE_REPORT`). Codex used a throwaway `CODEX_HOME` with a copy of `auth.json`
only, deleted afterwards.

### Decisions (Phase 3a)

- **Two-head timing as 1.x** (the user's call): claude hears the other head mid-turn, written to its
  stdin; a message to a Codex head at work steers into its turn. ~~Where 1.x pauses handed-over work for
  your message (`pauseNote`), 2.0 still queues it.~~ (Paused as 1.x since Phase 3b.) The steered reply moves below your new line (1.x
  shows the reply at the end too); your two messages' task cards join (1.x leaves the first as it was).
- **Routines run only while the app runs** (decided earlier). 2.0 locks scheduled-routines.json with
  its own lock file (`…botling2.lock`), not 1.x's `flock`: the project lock keeps the two apps off one
  bot. The main bot's routine prompt has 1.x's project list without inboxes, Maintainer and teams
  (2.0 has none of them yet).
- **No auto mode yet**, so a monitored command always asks (Allow once), as 1.x does without it.
- **Component commands**: 1.x's approvals model (per folder and command, remembered), but 2.0 starts
  with none: 1.x's approved-commands.json is not imported (a trust decision the user makes again).
- ~~**A bot with no component list that drew none gets the library (up to 20)**~~ (superseded in Phase 3b: as 1.x, with Maintainer): 2.0 has no Maintainer
  to give it any, so without this a fresh bot would only know one line of each.
- **Components' pictures** go to frames by token (`botling-card://image/<token>`) for paths the data
  names that exist and are images; the frame never sees or asks for a path.
- **Catch-up** keeps its cache in 2.0's folder; arriving at a chat is opening it in the app (2.0 does
  not yet track window focus as 1.x does).

## Phase 3b: what was built and how it was checked

| Piece | What it does | Evidence |
| --- | --- | --- |
| Plugin library (`core/plugins/manifest.ts`, `registry.ts`) | Plugins.swift's `PluginRegistry`: `<core>/plugins/<name>/package.json` read every 1.5 s; the same check (`ccb plugin check` without the browser parts) word for word, npm semver ranges for `engines.ccb`, fingerprints by file date and size, plugins.json in 1.x's format (disabled, settings, failures by fingerprint, installed); a plugin that broke stays off until its files change (said once; Maintainer is asked to fix it); a program part that crashes the host three times in ten minutes, or fails to load, is turned off; a folder that later fails the check is handed to Maintainer | `unit/plugins.test.ts` (the check and the ranges **ported from PluginTests.swift**, on/off and settings, the broken-plugin and crash rules) |
| Secrets (`core/plugins/secrets.ts`, `main/core-client.ts`) | A setting marked `secret` is sent once (`plugins.secret`) and sealed by **Electron safeStorage** (the OS keychain's key) in main — the core has no safeStorage, so it asks main over its own port; `plugin-secrets.json` (0600) holds only sealed bytes; values are opened once at start and live only in the core's memory; they go to the plugin's own program part (its spec) and, when the setting names an `env`, to bots' processes for MCP servers; a page only learns whether one is set | `unit/plugins.test.ts` (no plain text in the file, reopened after a restart, another key cannot open it), `unit/plugin-host.test.ts` (never in a view, in plugins.json or on a page), `e2e/plugins.spec.ts` (real safeStorage with Chromium's mock keychain) |
| Plugin host (`core/plugins/host-client.ts`, `index.ts`) | PluginHost.swift's client around **Web/host/src/host.ts unchanged** (bundled to out/host/host.mjs): its own process group, in plugin-data/, an allow-listed environment (no BOTLING_*, FAKE_*, ELECTRON_*), stderr kept to 8 KB; every line it sends is checked (shape, 4 MB at most), hooks time out after 5 s (the message goes as it is), commands and panel calls after 60 s, loading after 30 s; it is restarted 300 ms after it dies and the plugin it was running is blamed. What it may ask: `bots.list`, `routines.add` (routines.cron, kept once), `notify` (the main bot's chat), `bots.send` and `bots.create` (both need the `bots` permission; creating bots is refused for now); browser tools are ignored | `unit/plugins.test.ts` (a host that sends junk, a smuggled key, a 5 MB line; the environment; restart and blame), `unit/plugin-host.test.ts` (**PluginHostTests.swift's cases** with the real host: beforeSend changes and stops, afterReply, onReply, notify, storage, routines.add, a plugin failing to load, commands, a killed host coming back, quitting ends it, permissions) |
| Hooks in the chat (`core/server.ts`, `bot.ts`) | Your message goes through `beforeSend` first (a plugin can change it or stop it: a notice says so and `chat.send` answers `stoppedBy`); a reply that showed goes through `afterReply` (the shown line is updated) and to `bots.onReply`; enabled plugins' Claude parts go to claude heads as `--plugin-dir` (not in harmless mode) | `unit/plugin-host.test.ts`, `unit/maintainer.test.ts` (Maintainer's head gets `--plugin-dir …/ccb-core/claude`) |
| Plugins panel and plugin panels (`renderer/Plugins.tsx`, `panel-page.ts`, `main/card-page.ts`) | The rail's **Plugins** button: each plugin on/off, its parts, permissions and source, settings (boolean, enum, text, number; secrets as a password field that never shows the value), its commands, what is broken and why. A plugin's **panel** runs its web part in a sandboxed frame (`botling-card://page/…`, opaque origin, PANEL_CSP: inline and `blob:` scripts, no network, frames, forms or workers) with a small `ccb` (panels, settings, notify, commands, `host.call` to its own program part — the plugin comes from the frame, calls are paced) | `e2e/plugins.spec.ts` (a command's result, a setting, a secret sealed, a panel asking its program part; the panel can reach neither the app's document, storage, bridge nor the network), screenshots `plugins-panel.png`, `plugin-panel-frame.png` (looked at) |
| Maintainer (`core/maintainer.ts`, `maintainer-text.ts`) | 1.x's built-in bot (fixed id, diamond, last in the left column) working in the plugin library with **1.x's instructions**, the `ccb-core:component-editor` agent and PLUGINS.md, all **equal to the strings the Swift code wrote**; the library's own files as 1.x writes them (ccb-components, ccb-core, the editor following the app unless edited); the library becomes a git repo before Maintainer's first job; Maintainer's check command is 2.0's own check (`out/host/check-plugin.cjs`) | `unit/maintainer.test.ts` (instructions with and without check/shot commands, editor agent on two models, PLUGINS.md, the three manifests, the ask notes — golden export extended), the check command run for real |
| Requests (`maintainer.ts`, `bot.ts`) | `<component>`: Maintainer gets "X wants a new component …" or "X's request for the component …" with how full the asking bot's list is and an id to decline by; one already in the library goes on the bot's list at once; a new one is given when it lands in the library, a change when its files change after Maintainer's reply; `<give-component>`, `<take-component>`, `<component-declined>` from Maintainer; the asking bot is woken with 1.x's note and the chat says what happened. `<plugin>` goes to Maintainer as "X's request for Botling: …". `<install>` fetches (a folder or a git URL) into install-staging/, checks it and **asks in the main bot's chat** (Install / Don't install, 1.x's question text); only Install copies it into the library, commits it and records where it came from; a question left open by a restart is closed. A bot drawing a library component gets it on its list; a new bot starts with the built-ins (both as 1.x) | `unit/maintainer.test.ts` (each flow through the core), `e2e/plugins.spec.ts` (`install-ask.png`, `maintainer-request.png`, looked at) |
| Import (`store/importer.ts`) | The plugin library's text files (plugins' manifests, bundled code, Claude parts, components; not node_modules, .git or binary files), Maintainer's chat and notes, plugins.json **without settings a plugin declares secret** (1.x's secrets live in its keychain and are never read), component-editor.json | `unit/importer.test.ts` (the source untouched; a secret key in an old plugins.json does not come over; the value appears in no file) |
| Pausing for your message (`bot.ts`) | 1.x's `Bot.pausing`: a message while a head works on something you did not start (handed-over work, a routine, a report, claude's own turn), with no approval open and no foreground subagent: its words so far stay cut off, your message goes with 1.x's pause note (claude: interrupt; Codex, handed-over work only: `turn/steer`), and once you are answered the head gets 1.x's resume note on the same hand-off, whose reply still goes back. Stop or a head that dies drops it | `unit/two-heads.test.ts` (both heads) |
| Hand-off e2e | `heads.spec.ts` raced a 1.5 s worker timer against the card's "running" check; the fake app-server now takes `FAKE_CODEX_WORKER_GATE` and the test opens the gate after it saw the card running; closing skips the quit tidy | ran 14 times under a 12-process CPU load (5 with the final version): all passed |

Tests: unit 239 (vitest), e2e 27 (Playwright/Electron), typecheck, all green; no helper process left
after a run. Live (Phase 3b, 2 real CLI calls, no Codex): `claude plugin validate --strict` on the
ccb-core Claude part 2.0 writes (no model call): **passed** (only directory-listing warnings: README,
license, icon — the same files 1.x writes); one `claude -p` turn (haiku, `--tools ""`, no MCP, no
saved session, in a throwaway folder) to see the editor agent through `--plugin-dir`: inconclusive —
with no tools it lists no agent types (not repeated, to stay within the budget).

### Decisions (Phase 3b)

- **The plugin host is untrusted** and runs as a plain Node process beside the core (1.x's script, its
  protocol unchanged), not inside it: its own process group, an allow-listed environment, every message
  checked, a short list of requests. It still runs plugins' code with the user's rights (as 1.x: "permissions
  are only declared, not sandboxed"); all program parts share one host, so a plugin could claim another's
  name in a request — the checks are about the core's internals, not about plugins from each other.
- ~~**Third-party web parts do not run in the chat page.**~~ (Superseded in Phase 4a: the chat page has its own origin and runs them.) The chat page shares the app page's origin, so a
  plugin there could reach the app's bridge. Panels run in sandboxed frames instead; a web part's
  composer, markdown and component hooks (`ccb.composer`, `ccb.messages`, `ccb.components`) do nothing
  there. ccb-latex stays bundled. Web parts' stylesheets are not loaded.
- **Secrets are sealed with safeStorage by main**, opened once by the core and kept in memory; a headless
  core without a test key keeps none. 1.x's keychain items are not read (a secret is entered again).
- **`bots.send` needs the `bots` permission** (1.x lets any plugin send as the user); `bots.create` is
  refused until 2.0 can make bots.
- **Maintainer is always there**, as in 1.x; it is a Claude-head bot by default. Its `<need-folder>`
  requests get a "not yet" note. The Codex Maintainer's component-editor role stays refused.
- **Installs ask in the main bot's chat** with 1.x's question; only a folder or a git URL can be
  fetched for now. Its last line points at the rail's Plugins button (2.0 has no Settings window).
- **A new bot starts with the built-in components only and gets more from Maintainer** (1.x), replacing
  Phase 3a's stopgap of giving a fresh bot the whole library.
- **Pausing as 1.x** (the user's parity question): 1.x's behaviour is safe to copy — it never interrupts
  a turn waiting on an approval or a foreground subagent, keeps the cut-off words, and resumes the same
  hand-off with its budget — so 2.0 now does the same instead of queueing.
- **Afterreply hooks see the shown text** (tags already acted on) and change the line after it showed;
  1.x holds the reply back until the hook answers (2.0 streams replies as they come).

## Phase 4a: what was built and how it was checked

| Piece | What it does | Evidence |
| --- | --- | --- |
| Chat page on its own origin (`main/main.ts`, `renderer/chat-frame/`) | The chat page is served from `botling-chat://chat` (its own CSP), not the app page's origin, so nothing in it reaches the bridge; plugins' web parts run in it as in 1.x (markdown, composer and component hooks, stylesheets and fonts served by the chat origin only when a manifest names them, `host.call`, `notify`, the last version that loaded when a new one fails) | `unit/phase4a.test.ts` (specs, secrets never in them, fallback, served files), `e2e/phase4a.spec.ts` (a web part runs; `parent.document` and the bridge are blocked) |
| Attachments (`core/attachments.ts`) | The `+` picker (main's dialog: the page never names a path), pasted and dropped files, a message with files only; kept in the bot's attachments folder with 1.x's names; listed for the head as 1.x's `(Attachments: …)`; pictures as base64 blocks to claude and `localImage` to Codex; a component's answer may bring pictures; the chat may load only files of its own lines or waiting ones | `unit/phase4a.test.ts` (5 cases), `e2e/phase4a.spec.ts` |
| Settings (`renderer/Settings.tsx`, `core/settings.ts`) | 1.x's settings.json keys (unknown keys kept) and bot.json: language, bot look (Cute) and avatar size, summaries, subagents' model and cache, Codex workers, results, the component editor's model; per bot heads, model, effort, subagents' and Codex's model, given to new heads | `unit/phase4a.test.ts` (2 cases), `e2e/phase4a.spec.ts` |
| Projects (`core/projects.ts`, `server.ts`) | Workspace.swift's `addProject` (a projects.json row in 1.x's format, `.bot/` with its `.gitignore`, the next free shape, placed before Maintainer; a folder that is a project already gives that project) and `proposeProjects` for `<new-project>`: `/*` and `/**` (outermost folders with a project marker, 5 deep, build folders skipped), one "Add as project?" card (1.x's words), missing, too-broad (`/`, home, Botling's own folder) and existing folders said; Add makes them and hands each its task; the left column's **Add project** opens main's folder picker | `unit/projects.test.ts` (helpers; add, order, restart; the card, Add and Don't add), `e2e/phase4a.spec.ts` (Add project, picking the same folder again) |
| The main bot's wake note and inboxes | The main bot wakes (and routines start) with 1.x's project list: each project's and bot's memory and inbox file and an open question in its chat; its claude head gets every bot's `.bot/` as `--add-dir`; after each of its replies what it wrote into an `inbox.md` goes to that bot as handed-over work and the file is emptied | `unit/projects.test.ts` (the exact list in the wake message, delivery, `--add-dir` only for the main bot), `unit/head.test.ts`, `unit/routines-core.test.ts` |
| What waits on you, the right panel (`renderer/RightPanel.tsx`) | 1.x's `refreshWaiting`: each bot's latest open question, else its memory's "Waiting on you"; the main bot's questions; ignoring as 1.x (settings.json `ignoredWaiting`, the last 200). Looked at again after chat changes and every 5 s (memory files). The right panel: the bot, its Now card (a manager's first "In progress" line), and for the main bot "Waiting on you" (opens that chat; × ignores); an orange dot on bots with something waiting | `unit/projects.test.ts`, `e2e/phase4a.spec.ts`, screenshot `waiting-on-you.png` (looked at) |

Tests: unit 262 (vitest), e2e 31 (Playwright/Electron), typecheck, all green (the full e2e suite three
times in a row after the fix below); no helper process left after a run.

E2e flake found and fixed on the test side: in about one full run in two, a message typed right after
the window opened never left — Playwright's `fill` landed in the input box and was gone again before
Return (seen in Phase 4a's earlier commit too, so not new). The chat frame now marks the chat it shows
(`<html data-chat>`), `launch()` waits for it, and `say()` fills again until the box holds the words.
Why the words go (the page taking its first states while CodeMirror reads the typed text) is not
pinned down; whether a person typing in the first second can lose words is unverified.

### Decisions (Phase 4a)

- **Plugins' web parts run in the chat page again** (as 1.x), now that the page has an origin of its
  own; the Phase 3b decision (panels only) is superseded. The chat origin serves a plugin's files only
  when its manifest names them.
- **Settings keep 1.x's keys** in settings.json and bot.json; settings 2.0 cannot act on yet
  (completion verification, reminders) are kept and shown, not used. The contract stayed at v7 for them.
- **A project is added only by you**: the page cannot name a folder (`projects.add` is not a renderer
  command); "Add project" goes through main's picker, `<new-project>` through a card you answer.
- **An inbox is emptied only after its bot took the text** (1.x empties it first): a bot that cannot
  take it now (read-only, locked) keeps it for the next reply.
- **2.0 has no teams or web AIs**, so the project list leaves out their lines and the
  `<open-question>` note; the briefing is otherwise 1.x's string.
- **The right panel is always shown** beside the chat (hidden below 860 px); 1.x's collapsed strip
  and its Results / Settled sections are not built.

## Gaps vs the Swift app (1.x)

Not in 2.0 yet, roughly in order of how much they matter:

- **Codex / two heads, still missing**: managed workers' cross-head return routes (a worker's report
  for handed-over work going back to the other head) and task cards' "helps" links; Codex's native
  subagents (off in a coordinator anyway); the component-editor role; auto mode (Codex's reviewer);
  rate limits and token use; images in Codex messages; the model list (`model/list`) and model/effort
  settings UI, switching a head's model (the handoff/resume prompts are ported, unused); completion verification (PromiseCheck)
  of either head; drawing the hand-off panel; a one-head bot's `<handoff to="claude">` for publishing
  (a notice says it cannot).
- **Subagents**: rows in the left column and the right panel's list, SendMessage resumes, background
  commands/Monitors (`backgroundTasks` chips), the interrupted-work note on wake, token speed.
- **Prompts**: the main bot's wake note has no teams or web AIs (2.0 has neither); the handoff/resume
  prompts are ported but unused (no model switch yet). Codex-only prompts are not ported.
- **Requests**: teams, new bots (projects: done in Phase 4a), `<open-question>`, `<need-folder>`, component specs and suggestions, open
  questions, @ call-ins (a notice says so). (Components, plugins and installs: done in Phase 3b.)
- The right panel's Tasks list (chips only), group chats, feedback relays, completion verification
  (`<end>/<block>` are parsed, not judged); claude's own scheduling tools (CronCreate, ScheduleWakeup)
  as background-task chips; 1.x's Settings → Routines page (2.0 has the header's small panel; the
  `addRoutine` UI for a new daily job is missing); Catch-up on window focus (only on opening a chat).
- **The main bot's world, still missing**: teams, making bots of their own ("New bot"), removing a
  project or bot, pinning bots, group chats, the right panel's Results and Settled, its collapsed
  strip, the Dock count.
- **Components and plugins, still missing**: component specs ("Make into component"), reports, revert and
  version history, the `/` component menu, "Show in all bots" floats (each chat floats its own), "making
  it live" (a Board command handed to Maintainer), SF Symbol icons (emoji icons work),
  `ccb.open` of pages (pictures open in the page's lightbox),
  the plugin library's revert/remove and version history in the app, installs from npm or archives,
  `claude plugin validate` before a Claude part is used, plugins' MCP tools on the allowed list,
  browser tools (no browser yet), the component editor's model setting (sonnet unless settings.json
  says), Maintainer reading other folders, component shots, the Codex Maintainer's editor role, and a
  packaged build's Node for the plugin host (development uses Electron run as Node).
- **Composer**: drafts across restarts, @ mentions; words typed in the first second after the window
  opens may be lost (an e2e race, see Phase 4a). (Attachments, steering, replies to a message and
  reactions are in.)
- **Settings**: auto mode, spending and rate limits, Doctor; the React chrome's own words are English
  (the chat page follows the language setting).
- **Packaging and updates** (electron-builder, fuses, signing, notarization, an updater).
- **Windows** (nothing has run there; see spike 4).
- **Browser / web AIs** (Phase 4a item 5, not started), community share, release planner, screenshots
  of components.

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

## What's next (proposed, after Phase 4a)

1. **Built-in browser / web chats** (1.x's web AIs, Phase 4a's last item) in account partitions
   (spike 3's sessions), and the main bot's `webBriefing`.
2. **Teams and bots of their own** ("New bot", `<team>`, removing), the right panel's Results and
   Settled, subagent rows in the left column.
3. **Maintainer, rest** and **packaging / Windows** as below.

## What was next after Phase 3b (kept for reference)

1. **Settings UI** (React) on the contract that exists: plugins (move the rail panel there), language,
   models/effort, auto mode, Catch-up, routines, heads, permissions; the component editor's model.
2. **Attachments**: a main-owned picker, a protocol serving attachment folders, pictures in answers
   (components' `pickImage` too), images to Codex.
3. **Maintainer, rest**: component specs ("Make into component"), reports, revert/history, component
   shots, `<need-folder>`, the Codex Maintainer's editor role.
4. **Main bot's world**: project list + inboxes in its wake note and routines, inbox delivery, teams,
   new bots/projects.
5. **Browser / web chats** (1.x's web AIs) in account partitions (spike 3's sessions).
6. **Packaging and updates** (electron-builder, fuses, signing/notarization, an updater; a Node for the
   plugin host once RunAsNode is off — bundled, or the host as a utilityProcess started by main), then
   **Windows** (spike 4: Job Objects; zsh-less command shells for components and monitors).

## What was next before Phase 3a (kept for reference)

1. **Live checks still open**: the approval round trip (`npm run test:live -- -t "asks before"`) and
   the app prompt as a real bot (`BOTLING_LIVE_REAL_BOT=1 … -t "choices block"`, in a throwaway folder).
2. **Main bot's world**: project list + inboxes in its wake note, inbox delivery, then teams,
   new bots/projects (the requests that now only get a notice).
3. **Background work**: commands and Monitors as chips, subagent rows in the left column, the
   right panel (Tasks, Subagents) in React.
4. **Composer parity**: attachments (a main-owned file picker + a protocol serving attachment
   folders), drafts.
6. **Settings** (React): model, effort, language (pass `lang` to the page), auto mode; then the
   right panel (tasks, subagents) in React.
7. ~~Codex head~~ (done in 2b); next for heads: model list and settings, worker return routes,
   the hand-off panel, monitors.
8. **Routines** on `JobStore` (app running only, as decided); Catch-up generation.
9. Card API (`ccb.answer`, `runDetail`, …) and the component library through the broker.
10. **Windows 11 VM**: run the suite; Job Object helper; native vs WSL CLI backend switch
    (decided: native host, swappable backend).

Packaging (not done): electron-builder `dir` target for a macOS dev build, Electron fuses
(RunAsNode off, NodeOptions off, cookie encryption on, ASAR integrity, only-load-from-ASAR), code
signing/notarization, then Windows installer signing.

## Risks

- **Component commands run with the user's rights** once allowed (as in 1.x): the approval is per
  folder and exact command text; a Detail command's values are restricted to letters, digits and
  `. _ / -`, single-quoted. A template the user allowed can still be changed on disk later; the Detail
  command is re-read and must match what was allowed, the Command line likewise (the card asks again).
- **Monitors run through `codex app-server`'s `command/exec`** with an explicit workspace-write sandbox
  and network off; their whole process belongs to the app-server's tree (ended with the head).

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

Decided by the user for Phase 2a: fresh session per wake with the 1.x briefing and tidy; project
bots keep using the project's `.bot/memory.md` with a lock; sending during a reply steers it.

Decided by the agent in Phase 2b (the user was away; each can be changed): Codex messages during a
Codex turn wait rather than steer; claude hears the other head only with its next message; Stop
stops both heads; a pick goes to the head that asked; each head tidies itself; routines/monitors
tools answer "not yet".

Decided by the user for Phase 3a: two-head timing as 1.x (claude hears the other head mid-turn; a
message to a busy Codex head steers its turn). Decided by the agent in Phase 3a (the user was away;
each can be changed): ~~handed-over work is still queued behind your message, not paused~~ (paused as 1.x since Phase 3b); 2.0 asks
again for component commands 1.x had allowed; a fresh bot gets the library (up to 20) since there is
no Maintainer; scheduled-routines.json uses 2.0's own lock file; monitors always ask (no auto mode).

Decided by the agent in Phase 3b (the user was away; each can be changed): pausing for your message as
1.x (it was judged safe to copy); third-party web parts run only as sandboxed panels, not in the chat
page; `bots.send` needs the `bots` permission; secrets sealed by safeStorage and entered again after the
import; Maintainer always present with a Claude head; installs only from folders and git URLs for now;
a new bot starts with the built-in components only (as 1.x).

Decided by the agent in Phase 4a (the user was away; each can be changed): plugins' web parts run in the
chat page on its own origin; a project is added only through main's picker or a card you answer; an
inbox is emptied only once its bot took the text; the right panel is always shown (no collapsed strip);
the project list leaves out teams and web AIs.

Still open:
- One real `claude` call to confirm the approval round trip, and one as a real bot (tools on) to
  see the app prompt's choices/task lines from real claude.
- Is a 15 s tidy on quit acceptable (1.x waits for it), or should quitting skip it?
- A Windows 11 machine or VM for spike 4.
- ~~Plugins' web parts in the chat itself (composer and markdown hooks) need the chat page on an origin
  of its own (no path to the app's bridge); worth doing before third-party web parts are allowed there.~~ (Done in Phase 4a.)
- Should `bots.send` without the `bots` permission stay refused (2.0) or be allowed (1.x)?
