# Core hot swap

The core (bot engine, Claude/Codex heads, settings, components, plugins) runs in an Electron utility
process (`src/main/core-client.ts`). A hot swap replaces that process with a newer core build while
the app, its windows and the user's conversations stay up. Only the kernel (`src/main`, preloads'
main side, the IPC contract's protocol version) still needs an app restart. A developer build
installed from the chat (`<install-build>`) uses it too when only the core or pages changed (see
"Installing a build without a restart").

## Using it

```sh
cd desktop
npm run core:build                       # builds out/core, out/host/{host.mjs,check-plugin.cjs}, out/web-extractors only
```

Then, in the running app: **Develop → Swap Core from Build**, or `kill -USR2 <main pid>`. The
startup log prints `[core swap] builds come from <dir>`; each swap logs its outcome as
`[core swap] {...}` and in main's audit log.

Where the build comes from:

- Source runs (`npm start`): `desktop/out` by default; `--botling-core-dir=/absolute/out-dir`
  points at another worktree's `out/` (`npm run core:build -- --outdir=/absolute/out-dir`).
- Builds whose package.json embeds `botlingDevTrial: true`: the same flag, given at launch. The
  Develop menu and SIGUSR2 exist only in source runs and dev-trial builds.
- Ordinary packaged builds ignore the flag and have no menu item; the install flow can call
  `installCoreSwap(...).swap({ script })` (exposed for tests as `globalThis.__botlingSwapCore`).

A development build is first copied to `<data>/core-builds/<stamp>/` and run from there, so
rebuilding never changes files under a running core. Only the running copy and the newest are kept.
The initial launch still runs the bundled `out/core/main.cjs`.

## What happens (`src/main/core-swap.ts`, `src/core/hot-swap.ts`)

1. **Self-check.** The new script starts as a second utility process on a scratch data folder
   (`$TMPDIR/botling-core-probe/core-probe-*`; no 1.x import, no clocks, no Doctor CLI check, plugin
   host refused) and must answer `settings.get` and `chat.snapshot` in this app's protocol version
   within 20 s. If not, it is killed and discarded; the running core was never touched.
2. **Drain.** Main holds renderer requests that change something (reads, `turn.stop`, `turn.await`,
   `handoff.stop`, `rounds.stop` still pass; see `PASS_WHILE_DRAINING`). The core emits
   `core.swap {phase: "draining"}` (the shell shows "Updating Botling's core…"), and every bot
   stops beginning turns: anything that arises inside the core (routines, hand-offs, reports,
   messages) waits in the bot's queue. Turns under way, Claude subagents and Codex workers
   (including Maintainer's component editor) get up to 2 minutes (`SWAP_TIMEOUT_MS`).
3. **Late turns.** A bot still busy then is stopped at a tool-call boundary: when no tool call is
   out, or 30 s later at the latest (`SWAP_BOUNDARY_MS`). It is the normal Stop (the reply line says
   stopped; the session goes on) and it is marked to carry on.
4. **Handover.** `<core data>/swap-handover.json` lists, per head, the session it resumes
   (`head.json`'s claude session; for Codex the same session id names `codex-threads/<id>`), whether
   it was cut off, and its waiting turns. Chats and session files are flushed. `core.swap
   {phase: "updating"}` follows.
5. **Switch.** Main holds every request, ends the old core (after a drain it does not run the
   sleep tidy, which would end the sessions; heads close politely, then their trees; Codex
   workers and component-editor processes end with their head), and starts the new script on the
   real data. It must answer `settings.get` within 30 s. The new core takes the handover once
   (stale after 15 min): each head's next start uses `--resume <session>` / `thread/resume` with no
   wake briefing; cut-off heads immediately get `CONTINUE_NOTE` ("…continue exactly where you
   stopped…"); waiting turns follow in order; background work that was cut off is told with the
   next message. Main then releases the held requests to the new core. The new epoch makes every
   window take a fresh snapshot, which clears the updating line.

Typical idle swap: about a second plus the new core's start.

## Failure and rollback

| Failure | Result |
| --- | --- |
| Missing files, self-check fails/times out/protocol mismatch | Discarded; nothing else happens |
| Drain errors or times out at the transport level | `undrain`: the old core lets its queues go, held requests go to it |
| New core does not answer after the switch | It is stopped, the handover is written back, the previous script starts again (it resumes the sessions the same way), held requests go there. `rolledBack: false` only if that fails too; the normal crash-restart loop then applies |
| One swap already running | `{ok: false, stage: "busy"}` |

## Known limits

- Temporary teams' and group chats' own runs end with the old core, as at quit.
- Steering and pause notes that were pending inside a head (`pendingNote`, `queuedNote`) are not carried.
- A Codex worker or component editor still running at the timeout ends with the old core; its
  record says it was interrupted and resumable by task id (the existing restart path), and the
  coordinator gets the carry-on note.
- Main and the IPC protocol version cannot be swapped; a core speaking another protocol fails the self-check.
- Real `claude --resume` / `codex app-server thread/resume` across a swap is exercised only with the
  fake CLIs in tests; a live check is still to do.

## Installing a build without a restart (`<install-build>`)

When the developer project's bot ends a reply with `<install-build path="…/Botling 2.app">…</install-build>`
(`src/core/self-update.ts`), main first compares the new bundle with the running one
(`src/main/hot-install.ts`) and the card says which way it will install, before you confirm:

- **Expected: hot-apply: core, chat page** (button *Install and hot-apply*): the kernel is the same.
- **Expected: restart (kernel changed: main process)** (button *Install and restart*): as before.

### What counts as kernel

Only an app restart can replace these, so any difference means a restart:

| Kernel piece | Where |
| --- | --- |
| main process | `out/main/**` in app.asar (main also carries the IPC contract and `PROTOCOL_VERSION`) |
| preloads | `out/preload/**`: a window's preload path is fixed when it opens, and main reads it through Electron's archive cache of the app.asar it started from, so a new one never takes effect without new windows |
| package.json | every field except `version` and `description` (e.g. `main`, `botlingDevTrial`) |
| native modules | any `*.node` file, in either build |
| other app files | anything in app.asar outside the known folders |
| Electron | `Contents/Frameworks/**` hashed in full, except code signatures and the helper apps' Info.plist and executables (they carry the app's version and are re-signed with it; only their presence counts) |
| executable | `Contents/MacOS/*` (presence only, same reason) |
| Info.plist | its values minus the per-build ones (`CFBundleShortVersionString`, `CFBundleVersion`, git commit/dirty, copyright, `ElectronAsarIntegrity`) |
| app resources | the rest of `Contents/Resources` (icons, `.lproj`), outside app.asar |

The swappable parts: **core** (`out/core`, `out/host`, `out/web-extractors`), **chat page**
(`out/renderer` files the chat origin serves: `chat.html`, `chat.js`, `chat.css`, `frame.css`, KaTeX)
and **shell** (the rest of `out/renderer`). Source maps are ignored.

Uncertain is a restart too: a bundle that cannot be read completely, another bundle id, the running
bundle's app.asar or Info.plist changed on disk since this process started (someone copied a build
over it), a previous hot install that could not put the old bundle back, or a run that is not a
packaged app bundle. The confirm compares again; if the answer is no longer what the card said (the
build was rebuilt meanwhile), nothing is installed and the bot is told to ask again.

Bundles are read with Electron's `original-fs` (app.asar parsed as the plain file it is), never
through Electron's archive cache, which keeps serving the running app.asar.

### The hot path, in order

1. **Copy** the changed parts out of the new bundle to `<data>/hot-builds/<stamp>/` (the layout of
   `out/`), every file checked against the fingerprints the decision used. The chat page and the
   shell share `out/renderer`, so either copies the whole renderer. The running process only ever
   loads these copies, never the path being replaced. Copies from an earlier run are removed at start.
2. **Install on disk** the verified way: the running bundle is moved to
   `<data>/core/self-update/backups/Botling-2-<version>-<stamp>.hot.app` (the running process keeps
   its open files), the new one is copied in with `ditto` and must have the same fingerprints. If
   not, the old one is moved back. The newest two `.hot.app` backups are kept.
3. **Core swap** (above) to `<copy>/core/main.cjs`; plugin hosts started afterwards come from the
   same copy's `host/host-utility.mjs`.
4. **Chat page**: main serves pages from `<copy>/renderer` (with `no-store`, HTTP cache cleared) and
   reloads the native chat page.
5. **Shell**: reloaded; it must show `.shell[data-ready="1"]` within 30 s.

The version the running app reports (`app.getVersion()`) stays the launched one until the next start.

### Rollback

| Failure | Result |
| --- | --- |
| Copying fails (or the build changed since it was compared) | Nothing installed |
| Installing on disk fails | The old bundle is moved back; nothing applied |
| Core self-check / drain / start fails | The core swap's own rules keep or bring back the old core; the old bundle is put back on disk |
| Shell does not come up | Renderer folder back and reloaded, core swapped back, old bundle back on disk |
| The old bundle cannot be put back | Reported as **restart required** (the next launch starts the new build); every later install restarts |

### What the bot and you are told

Main sends its report to whichever core runs at the end; that core posts it in the main chat and to
the bot that asked:

- `Botling installed <new> (was <old>) for <bot> without restarting — hot-applied: core, chat page. …`
- `The new build <new> could not be hot-applied: the new core failed its self-check (…). <old> keeps running. The app on disk was put back to <old>.`
  (or `… restart required …`). Failures count toward the two-in-a-row pause, as restarts do.
- After a restart install: `Botling restarted on <new> (was <old>), installed for <bot> — restarted (kernel changed: main process).`

This works for ordinary packaged builds, not only dev-trial ones: it takes only the path from the
card the user confirmed (main validates it again), never a folder from argv.

## Tests

```sh
npm run build
./node_modules/.bin/vitest run test/unit/core-swap.test.ts test/unit/core-client-swap.test.ts \
  test/unit/core-hot-swap.test.ts test/unit/component-editor-core.test.ts \
  test/unit/hot-install.test.ts test/unit/self-update.test.ts
```

Headless: fake utility processes, and the built core over stdio with the fake CLIs. No windows.
