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
| `worker` | worker lifecycle and report delivery (`desktop/src/core/worker-core/`) |
| `callin` | @ routing and call-ins between bots (`desktop/src/core/conversations.ts`) |
| `routines` | routines scheduling (`desktop/src/core/routines.ts`); `RoutinesOnce` checks its one-shot `@once` lines of routines.cron (taken out before they run; an app rewrite appends back what scripts appended meanwhile) |
| `datalock` | one core per data folder, `core.lock` (`desktop/src/core/store/data-dir-lock.ts`) |
| `workspace` | plugins' workspace change watch, `workspace.onChange` (`desktop/src/core/workspace.ts`, `core/plugins/index.ts`, `Web/host/src/api.ts`) |
| `approval` | a plugin frame's ask to run a bot's command: only the app page's ApprovalSheet allows (`desktop/src/renderer/plugin-frame-host.ts`, `ApprovalSheet.tsx`, `desktop/src/core/plugins/index.ts`) |
| `folders` | where a bot's session starts, a built-in plugin's `sessions.folder`: the core's cache and file, plugin crashes/off, restart once before the next message (`desktop/src/core/plugins/session-folders.ts`, `core/plugins/index.ts`, `bot.ts` folderMoved) |

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
