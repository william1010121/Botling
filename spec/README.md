# spec/

The protocols Botling must keep, written as TLA+ models and checked against the app.
Only the strong model (and people) change this folder. Cheap-model workers may read it, never write it.

## Layout

| Folder | What | Who writes |
|---|---|---|
| `models/<name>/` | `<Name>.tla` + `<Name>.cfg`, model-checked with TLC | strong model |
| `reference/<name>.ts` | the same state machine in TypeScript, action for action | strong model |
| `driver/<name>-driver.ts` | the only door tests use into the app: an interface, no app code | strong model |
| `tests/<name>.spec.test.ts` | conformance tests; import only `driver/`, `reference/`, `traces/`, `fixtures/` | strong model |
| `traces/` | behaviours generated from the models (by script, never by hand) | script |
| `fixtures/` | recorded real inputs (CLI streams) | strong model |

The app side lives in `desktop/spec-adapters/<name>-adapter.ts`: it implements the driver for the real code.
Keep adapters thin (translation only); every change to them is reviewed.

## Models

| Name | Protocol |
|---|---|
| `restart` | restart continuation journal (`desktop/src/core/restart-continuation.ts`) |
| `worker` | worker lifecycle and report delivery (`desktop/src/core/worker-core/`); `WorkerProcess` checks a Claude worker's process under it: the keep-alive, an input closed while background work runs, words held for a closing process and sent to the next one (`desktop/src/core/agent/claude-workers.ts`) |
| `callin` | @ routing and call-ins between bots (`desktop/src/core/conversations.ts`); `RelayedCard` checks the user's answer on a called-in bot's option card, as its guest line or relayed from its own chat: one answer reaches the bot it is for at most once, or the card says it did not; a guest line shows the answer chosen only once the bot has it, and an answer for a bot at work waits in its own chat (`desktop/src/core/server.ts` `answerRelayedCopy`, `answerGuestLine`) |
| `routines` | routines scheduling (`desktop/src/core/routines.ts`); `RoutinesOnce` checks its one-shot `@once` lines of routines.cron (taken out before they run; an app rewrite appends back what scripts appended meanwhile); `RoutineWatch` checks a watch routine (`desktop/src/core/routine-watch.ts`, bot.ts `startWatch`): the storm rule, its runs never overlapping, its state and its command across a crash |
| `datalock` | one core per data folder, `core.lock` (`desktop/src/core/store/data-dir-lock.ts`) |
| `workspace` | plugins' workspace change watch, `workspace.onChange` (`desktop/src/core/workspace.ts`, `core/plugins/index.ts`, `Web/host/src/api.ts`) |
| `approval` | a plugin frame's ask to run a bot's command: only the app page's ApprovalSheet allows (`desktop/src/renderer/plugin-frame-host.ts`, `ApprovalSheet.tsx`, `desktop/src/core/plugins/index.ts`) |
| `folders` | where a bot's session starts, a built-in plugin's `sessions.folder`: the core's cache and file, plugin crashes/off, restart once before the next message (`desktop/src/core/plugins/session-folders.ts`, `core/plugins/index.ts`, `bot.ts` folderMoved) |
| `turns` | a bot's turn schedule: every wake-up through `routeTurn` (your line, a routine, a report, a call-in, the continue note, a follow-up) becomes a turn now, joins the one under way (claude's steer and pause, Antigravity's insert) or waits (queue, deferred, claimHold, settingsHold, swapHold, the tidy); Esc stop and its drain; a folder move's restart held for its own work (`desktop/src/core/bot.ts`); `TurnsAgy` checks it on an Antigravity head (`canStartReport`) |
| `relaypair` | phone pairing and connecting through the relay: one-time offers (TTL, used, claimed by one handshake), handshake, confirm, requests, revoke (`desktop/src/mobile-relay/connector.ts`); `LanPair` checks the home-network PairingStore's files and locks shared with the `pair` command (`desktop/src/mobile-bridge/pairing.ts`) |

## Rules for a model

- Shortest model that states the protocol. No special cases for one bug; if a fix needs one, the model was wrong.
- Every model has a `TypeOK`, at least one safety invariant and one liveness property (with the fairness it needs written out).
- The `.cfg` keeps the state space small enough for CI (under about a minute).
- Each action in the `.tla` has the same name in `reference/<name>.ts` and in the trace lines the app writes.

## Running

```sh
spec/tools/tlc.sh spec/models/restart/Restart.tla   # one model
spec/tools/check-models.sh                          # all models
cd desktop && npm run test:spec                     # conformance tests
```

Trace checking: the app writes `{at, action, state}` lines with `specTrace(model, action, state)`
(`desktop/src/core/spec-trace.ts`) when `BOTLING_SPEC_TRACE` names a folder; tests replay them through `reference/`.
