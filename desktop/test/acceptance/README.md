# Botling 3 M1 acceptance harnesses

Test-only harnesses for the M1 acceptance checks. They run the **built** botlingd (`out/server/main.cjs`) with the
fake engine (`test/fixtures/fake-claude.mjs`) and no window, under plain Node or Electron as Node
(`ELECTRON_RUN_AS_NODE=1`). They are not part of `npm run test:unit` or `test:changed` (they live outside
`test/unit/` and use their own vitest config), because some of them run for many minutes.

```sh
cd desktop
npm run build                       # once; never while a harness runs (the build replaces out/)
npx vitest run --config test/acceptance/vitest.config.mts test/acceptance/<file>.test.ts
```

Each harness writes a JSON report to `$V3_ACCEPT_REPORT_DIR` (default: `<os tmp>/botling-v3-accept`) and deletes its
temp data. Temp data goes under the external work volume when it is mounted (`testRoot`), except check 6, which
uses the OS temp folder (the internal disk) on purpose.

| Check | File | What it measures | Knobs |
|---|---|---|---|
| 1 isolation | `isolation.test.ts` | 2.x bundles' source maps list no `src/server`, `src/fe-link`, `src/main-v3`, `src/protocol`; botlingd refuses a 2.x-shaped folder and leaves it untouched; main-v3 refuses the 2.x dev folder; the 2.x core exits 75 on a folder botlingd holds | — |
| 2 crash botlingd | `crash-botlingd.test.ts` | runs × commands from a fe-link client with a durable outbox, botlingd SIGKILLed at random points and restarted; lost / applied twice / shown failed / not sent / missing in the core's copy | `V3_ACCEPT_RUNS` (20), `V3_ACCEPT_COMMANDS` (200), `V3_ACCEPT_KEEP=1` keeps the folders of runs with anomalies |
| 3 window independence | `window-independence.test.ts` | a main-v3 window starts a turn and goes away mid-turn; `status --json` shows it running; it finishes; the saved cursor resumes gapless; a new window shows the reply once | `V3_ACCEPT_RUNS` (3), `V3_ACCEPT_WORDS` (400) |
| 4 crash mid-turn | `crash-midturn.test.ts` | SIGKILL mid-turn: one interrupted, text missing (chars and ms), not restarted, window shows connecting, never "not sent" | `V3_ACCEPT_RUNS` (5), `V3_ACCEPT_WORDS` (1200) |
| 5 exports | `exports.test.ts` | chat.json / pins.json / … from botlingd vs 2.x FileBotStore (same records) and vs the 2.x core (same script) | — |
| 6 latency | `latency.test.ts` (+ `commit-timer.cjs` preload) | commit p50/p95/p99 on the internal disk at several command rates, ack delay, load; live frames per second per connection with several bots streaming | `V3_ACCEPT_RATES` (20,100,250,500), `V3_ACCEPT_PHASE_MS` (8000) |
| 9 content path | `content.test.ts` | a ~100 MB video through botlingd + main-v3 ContentProtocol: first ranges, seeks, a rewritten file's old line | `V3_ACCEPT_VIDEO` (use this file instead of making one with ffmpeg) |

Every harness takes `V3_ACCEPT_RUNTIME=electron` to run botlingd under Electron as Node instead of plain Node, and
`V3_ACCEPT_REPORT_DIR`. (The knobs are not named `BOTLING_*` because `test/setup-env.ts` clears those.)

Typical durations on a loaded machine: check 2 about 25 min for 20 × 200, check 4 about 2 min, check 6 about 1 min,
check 9 about 1 min, the rest under 30 s.

## Botling 3 M2 (m2-brief §5): the page harnesses under `web-v3/`

Build first: `npm run build && node web-v3/build.mjs`. The page harness (`web-v3/page-harness.ts`, and
`two-servers/pdf-peer.test.ts`) refuses to start when `web-v3/dist` is older than any file its build read
(`web-v3/page-fresh.ts`, from the `sources` list `web-v3/build.mjs` writes to `web-v3/dist.inputs.json`).
Browsers come from `PLAYWRIGHT_BROWSERS_PATH` (headless Chromium and WebKit, nothing downloaded); `V3_ENGINES=chromium,webkit`
picks engines. Per-check files and numbers: `.bot/artifacts/v3-m2/acceptance.md`.

| Check | File | Knobs |
|---|---|---|
| 2 airplane mode on the page | `web-v3/airplane.test.ts`: runs × commands, each run a fresh data folder, profile and pairing, with seeded offline toggles, reloads, browser SIGKILLs and botlingd SIGKILLs; 0 accepted lost, 0 applied twice, 0 shown "not sent"/"lost"; run 1 also times send → delivered (check 7) | `V3_ACCEPT_RUNS` (20), `V3_ACCEPT_CMDS` (100), `V3_ACCEPT_SPEED_CMDS` (50), `V3_ACCEPT_SEED` |
| 3, 4 (page part), 5, 6, 8 | `web-v3/page`, `content`, `player`, `upload`, `pdf`, `relay`, `sw`, `idb-storage`, `session-vectors` | see each file's header |
