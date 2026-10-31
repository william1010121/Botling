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

## Budgets

Sizes are deterministic, so their budgets sit about 20% over the measurement. Times and memory vary by
machine, so their budgets are 2.5 to 5 times the measurement on a laptop. A budget moves only in a reviewed commit that
shows the new measurement; a regression is fixed, not budgeted away. The numbers below are in
`scripts/perf/budgets.json`; the measurements are the latest recorded on an Apple-silicon laptop.

(See the table in the pull request that last changed budgets, and `desktop/.cache/perf/results.json` after a run.)
