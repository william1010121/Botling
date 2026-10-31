# Performance and resource budgets

`npm run perf` (in `desktop/`) builds the core, writes synthetic data folders in the real file shapes
(`scripts/perf/synth.mjs`: `chat.json`, `projects.json`, `subagents.json` plus `subagents/<id>.jsonl`), starts
the core on each over its stdio transport the way main does, and prints what it measured. It never reads or
writes real bot data (`BOTLING_*` is cleared, `HOME` and the data folder are under `desktop/.cache/perf/`).
CI runs it as the `Performance budgets` job (ubuntu) and fails when a number goes over its budget in
`scripts/perf/budgets.json`. `npm run perf -- --only=chat500` runs one scenario; `--no-check` prints without failing.

## What is measured

| Key | Meaning |
| --- | --- |
| `startupMs` | core spawn until the first `chat.snapshot` is answered (the main chat included) |
| `firstSnapshotMB` | that answer's size, i.e. what the renderer must parse on launch |
| `openChatMs`, `openChatMB` | a later `chat.snapshot` of the main bot (the best of three): window or bot opened |
| `coreRssMB` | resident memory of the core process once idle |
| `loadMs`, `heapMB` | reading `chat.json`, and the JS heap that chat holds (in-process, `--expose-gc`) |
| `viewsMs` | turning every line into what the renderer receives (`messageView`) |
| `appendSaveMs`, `appendViewMs` | the core's per-message cost on that chat: one `chat.json` rewrite, one view |

## Scenarios

- `empty`: a new install.
- `bots50`: 50 bots of 200 lines, plus a 40-entry subagent index with 200-step files per bot.
- `chat500`: the 500 lines `chat.json` keeps, each answer with 10 tool steps of 6 KB (a long coding session, 16 MB).
- `chat5k`, `chat20k`: a chat file that grew past the cap (kept in memory, and sent whole, until the next write trims the file).

## History paging

A chat snapshot carries only the newest page of the chat: lines are added from the newest back until about 1 MiB of
what the renderer receives is reached (at least 6 lines, `src/core/history-page.ts`). `ChatSnapshot.history` says
whether older lines wait. The chat page asks for them with a `loadHistory` action when the reader scrolls past the
top or jumps to a line it does not hold (a quoted reply, a task link); the shell sends `chat.history` (the page before a
line, or back to a given line with `until`) and puts the page in front of the loaded lines. Events about a line older
than the loaded ones are ignored until its page is loaded. The mobile bridge allows `chat.history` (read-only, same bot
scope as `chat.snapshot`). The whiteboard and the task chips read the newest lines, which are always loaded.

## Measurements

Apple-silicon laptop, before and after paging (sizes are exact, times are the best of a few runs):

| Scenario | Snapshot before | after | Open chat before | after | Core RSS before | after |
| --- | --- | --- | --- | --- | --- | --- |
| `chat500` (16.6 MB chat file) | 16.6 MB | 1.0 MB | 62 ms | 4 ms | 366 MB | 184 MB |
| `chat5k` | 3.9 MB | 1.0 MB | 20 ms | 7 ms | 238 MB | 213 MB |
| `chat20k` | 10.2 MB | 1.0 MB | 57 ms | 10 ms | 343 MB | 335 MB |
| `bots50` | 2.8 MB | 2.8 MB | 13 ms | 12 ms | 528 MB | 528 MB |

Not changed by paging, and worth a look next: `bots50`'s snapshot is almost all `subagentRows` of the other bots (about 56 KB
each); a chat file's first start cost includes the one-time monthly archive written for a chat older than the archive
(`chat20k` startup); `appendSaveMs` is a full `chat.json` rewrite per message (59 to 94 ms on `chat500`).

## Budgets

Sizes are deterministic, so their budgets sit about 40% over the measurement. Times and memory vary by
machine, so their budgets are 2.5 to 5 times the measurement on a laptop. A budget moves only in a reviewed commit that
shows the new measurement; a regression is fixed, not budgeted away. The numbers are in `scripts/perf/budgets.json`;
`desktop/.cache/perf/results.json` has the last run.
