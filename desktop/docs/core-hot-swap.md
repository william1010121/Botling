# Core hot swap

The core (bot engine, Claude/Codex heads, settings, components, plugins) runs in an Electron utility
process (`src/main/core-client.ts`). A hot swap replaces that process with a newer core build while
the app, its windows and the user's conversations stay up. Only the kernel (`src/main`, preloads'
main side, the IPC contract's protocol version) still needs an app restart.

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

## Tests

```sh
npm run build
./node_modules/.bin/vitest run test/unit/core-swap.test.ts test/unit/core-client-swap.test.ts \
  test/unit/core-hot-swap.test.ts test/unit/component-editor-core.test.ts
```

Headless: fake utility processes, and the built core over stdio with the fake CLIs. No windows.
