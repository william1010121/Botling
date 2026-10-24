# Botling 2.0 desktop (React + TypeScript + Electron)

Status: **Phase 0 spikes done on macOS, Phase 1 started.** This is not a usable replacement for the
Swift app. It lives beside it: nothing under `Sources/` or `Web/` changed, and the Swift app does not
use anything here. `Web/src/contract.json` is read (for the shared `ccb.save` limit), never written.

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
| `npm run dev` | Same with the real `claude` CLI — no tools, no MCP, no saved session (`BOTLING_HARMLESS=0` lifts that). |
| `npm run build` | Bundle main, preload, core and renderer into `out/` (not committed). |
| `npm test` | Unit tests (vitest, real processes) then Electron end-to-end tests (Playwright). |
| `npm run test:live` | Two short real `claude` turns (spends a little usage). |
| `npm run typecheck` | `tsc --noEmit`. |

Data goes to `$BOTLING_DATA_DIR`, by default `desktop/.data/` in development (ignored by git) and
`<appData>/Botling 2` when packaged. Electron's own profile, partitions and caches are put under it
too. Tests use throwaway folders in `desktop/.tmp/`. Nothing touches `~/.claudecodebot`.

## Architecture as built

```
┌────────────────────── renderer (sandbox, contextIsolation, no Node) ─────────────────────┐
│ React chat (App.tsx) · ChatStore (epoch/seq, resync) · Client (ids, cancel)               │
│   └─ card frames: <iframe sandbox="allow-scripts" src="botling-card://card/<msg>/<card>"> │
│        CardBroker: accepts postMessage only from a registered frame, opaque origin,        │
│        strict schema; identity = which frame sent it, never what the message says         │
└──────────────── preload: botling.post(envelope) / botling.subscribe(fn) only ─────────────┘
                 │ ipc "botling:post" / "botling:message"
┌──────────────── main (thin) ─────────────────────────────────────────────────────────────────┐
│ checks sender = the app window's main frame at app://botling/ · zod-validates · allow-list   │
│ of renderer commands · scopes request ids per window · answers accounts.list / site.open     │
│ protocols: app:// (renderer files, strict CSP) · botling-card:// (card HTML + runtime, CSP   │
│ with no network/frames/forms) · blocks popups, <webview>, downloads, permissions, top-frame  │
│ navigation away from app://, and any frame navigation not started by the app                 │
│ account windows: persist:account-<id> partitions, sandboxed, no preload                     │
└──────────────── utilityProcess (parentPort) — same code runs on stdio under plain Node ──────┘
┌──────────────── core (trusted) ──────────────────────────────────────────────────────────────┐
│ validates everything again · owns chat.json (atomic writes) · one agent turn at a time       │
│ AgentTurn: spawns claude -p --output-format stream-json --include-partial-messages in its    │
│ own process group, streams deltas; stop() closes the gate first, then ends the group         │
│ ProcessLedger: ends agent groups a crashed core left · JobStore: durable claim → deliver     │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Files: `src/contract/` (the typed contract), `src/core/` (core process), `src/main/` (Electron
main), `src/preload/`, `src/renderer/` (React), `test/unit`, `test/e2e`, `test/live`,
`test/fixtures/fake-claude.mjs` (a stand-in CLI with `normal|slow|stubborn|card|crash` modes).

### The contract (`src/contract/index.ts`)

- Envelopes: `request {v, id, cmd}`, `cancel {v, cancel}`, `response {v, id, ok, result|error}`,
  `event {v, epoch, seq, event}`. `v` is `PROTOCOL_VERSION` (1); another version gets
  `unsupported_version`, not a guess.
- Every hop validates with zod (`strictObject`: unknown fields are errors, so smuggled ids fail).
- Error codes: `bad_request, unsupported_version, forbidden, not_found, conflict, cancelled,
  core_unavailable, internal`. Exactly one response per request id, including cancelled ones.
- Cancellation cancels the *request* (e.g. `turn.await` stops waiting); `turn.stop` is the
  separate, explicit way to stop work.
- `epoch` is new each time the core starts; `seq` is gapless within an epoch. The renderer applies
  events after its snapshot, buffers those that arrive while a snapshot is in flight, and takes a
  new snapshot on a gap or a new epoch.
- Commands now: `chat.snapshot, chat.send, turn.stop, turn.await, card.save, card.action,
  card.html (main only), accounts.list, site.open`. Events: `message.added, turn.started,
  turn.delta, turn.finished, card.updated, card.acted`.

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

## Decisions made (and why)

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
- **One CLI process per turn** (`-p`, prompt on stdin, `--resume`) instead of the Swift app's
  long-lived `--input-format stream-json` process: simpler stop semantics for the spike. The
  long-lived mode (approvals over `--permission-prompt-tool stdio`, `interrupt` with `send_now`,
  background subagents) is the next step and needs the same gate + tree-kill.
- **`npm run dev` uses the real CLI in "harmless" mode** (no tools, no MCP, no saved session) until
  tool approvals exist; the fake CLI is the default everywhere else.
- **Data root**: `BOTLING_DATA_DIR`, Electron's userData/sessionData moved under it. A packaged
  build would use `<appData>/Botling 2`, separate from `~/.claudecodebot` (migration is a decision
  for later; see below).
- **No React state library**: `useSyncExternalStore` over a small store is enough for one view.
- **Closing the window does not stop work** on macOS (the core keeps running); quitting stops the
  core, which stops its turn and ends the tree.
- Kept `desktop/` independent of `Web/`'s build (its own `package.json`, `node_modules`, esbuild
  script). Chat tokens/rules are copied from `Web/src/chat.css` into `src/renderer/styles.css` with
  a note to change them there first; avatars and markdown are not ported yet.

## What's next (proposed)

Phase 1 (contract and boundaries):
1. Port the real `ccb` card API (`answer`, `open`, `status`, `runDetail`, size/hover, pins) on top
   of the broker, with per-action authorization in the core; run the existing component library
   through it and list what does not work.
2. Long-lived claude session per bot with `--permission-prompt-tool stdio`: approvals as contract
   events/commands, decided and expired in the core.
3. Contract for bots/heads/workers/routines; port `ScheduledRoutines` semantics onto `JobStore`;
   generate the contract's JSON Schema so the Swift app (1.x) and fixtures can share it.
4. Decide data migration from `~/.claudecodebot` (read-only import + backup first).
5. Windows 11 VM: run the whole suite; build the Job Object helper.

Phase 2 (UI): sidebar + multi-bot, markdown/KaTeX/CodeMirror reuse from `Web/src`, avatars,
settings, i18n (reuse `Web/src/locales`), Board/pins — still with HTML cards in sandboxed frames.

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
- **The real CLI reads the user's settings, hooks and CLAUDE.md** (same as 1.x). Fine for the app,
  but tests that use the real CLI are not hermetic.

## Needs the user

- Windows: native vs WSL as the primary path (changes the process/shell adapter and testing).
- Linux: experimental only, or a named distro + X11/Wayland level?
- Must routines run while the app is fully quit (launch agent / Task Scheduler / systemd user unit)?
- Data: import from `~/.claudecodebot` on first run, or start fresh beside it?
- A Windows 11 machine or VM for spike 4.
