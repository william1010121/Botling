# Subagent presentation parity (2.x source change)

## Baseline and ownership

Worktree `/private/tmp/botling-2x-subagent-presentation`, branch
`bot/2x-subagent-presentation`, based on clean cumulative trial HEAD
`07dc3b4f45da0ad85afcd05936c7e59a3455c9a2` (documented build source
`363e2bf5cf705594e1e7b37960dc92b50eb5c7bb`). The separate Electron worktree was
at `595c38ef540d3a5a561c5e7982d781ebe67c1984` with pre-existing edits; it was
read only. The original source checkout also had pre-existing 1.x edits, which
were left alone.

The installed `/Applications/Botling 2 Dev Trial.app` reports
`2.0.0-dev.20261026.1`; its launcher points to the installed `Botling 2.app`
and its imported `development-data` profile on My-SSD. Neither entrance,
profile, credentials, nor running app was changed. No integration, packaging,
installation, or restart was performed.

The read-only 1.x references were the source available at 1.x `main`
`1d50952f3fdf9abdb8d0e6e0dcc13df025993767`, particularly
`Sources/ClaudeCodeBot/SidePanels.swift` (`SubagentOwnerMark`),
`Sources/ClaudeCodeBotCore/Bot.swift` (`subagentOwnerMark`),
`Trace.swift`, `StreamEvent.swift`, and `CodexAgentProcess.swift`.
The installed 1.x app reports `1.19.10-dev`; its bundled chat JavaScript
contains the standalone-card, worker-waiting and subagent-speed renderers.
This does not establish an exact Git build commit for that installed 1.x app.

## Observed regression and restored behavior

| Surface | Recent 1.x | Trial baseline | This change |
| --- | --- | --- | --- |
| Subagent navigation rows | Parent's 24-point face; C/X badge in Original, owning character in Cute; single-head bots also have an owner mark | Plain 16-point C/X letters for two-head bots; no owner identity for a single head | Restore the parent face and chosen look in active rows and Settled, including its folded-panel flyout; emit owner identity for single-head bots |
| Child detail header | Child engine/model, captured effort/service tier, reported output throughput | Core/contract/payload drop runtime and output counters; type-based engine guess labels native Codex children Claude | Carry child metadata through the validated contract, snapshot and updates to the existing renderer; keep unavailable values unknown |
| Live child metadata | Claude's own message model/output; Codex worker session response and attributable thread counters | Claude child model/usage ignored; Codex worker totals only used for aggregate accounting | Capture those explicit child observations for presentation; accepted turn overrides update effort, without changing launch arguments or policy |
| Parent idle while children work | Waiting-for-workers line; composer usable and no thinking animation | Renderer exists, but desktop never supplies the waiting flag | Supply it from running child count only while the parent/guest is idle |
| Standalone task cards | Visible outside Worked folds/live tail; correct Open ID and status | Already uses this renderer | Preserve it, with desktop-payload rendering regression coverage for both engines, later history, and stop/failure |

Absolute output snapshots keep the highest value per child message/thread;
repeats do not add twice. Counts never use coordinator input/cache usage or
text length. Missing/malformed data remains unknown; ended throughput freezes
at the actual end time. Runtime metadata does not complete a task, change its
owner, or infer success. Settling a running task only changes its list placement.
The existing running/completed/failed/stopped semantics remain intact.

Only `desktop/` source, tests, test dependency metadata and this note changed.
No shared `Web/`, Swift 1.x, plugin library/component extension, CLI executable
resolution, tool definitions, permissions, or authorization policy changed.

## Bounded validation

Before implementation, the six initial presentation boundary tests all failed:
missing child runtime/output fields, wrong native Codex engine label, and
missing waiting flag. Additional regression-first checks failed for missing
avatar images, both single-head owner identities, and Codex worker metadata.
Raw failure reports remain in this worktree's ignored `desktop/.cache/`.

Final focused command (from worktree root):

```sh
node desktop/node_modules/vitest/vitest.mjs run \
  test/unit/subagent-presentation.test.ts test/unit/subagent-rendering.test.ts \
  test/unit/codex.test.ts test/unit/stream.test.ts \
  test/unit/payload.test.ts test/unit/contract.test.ts --root desktop
```

Result: **53 passed across 6 files**. New presentation tests include real Bot
views with isolated temporary stores, strict contract parsing, reload/counter
idempotence, rendering the production chat page in jsdom, open/close actions,
streaming/folding/history, single-head owner marks, and active/Settled/folded
panel avatar and action behavior.

`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` from `desktop/`
passed. `git diff --check` passed. The new test-only dependency is exact
`jsdom@27.0.0` (the existing Web test version); `npm ls --package-lock-only
--all --offline --json` reported no dependency problems after npm generated
the lockfile.

All tests were background Node/jsdom checks. No Electron window/pixel test,
live CLI session, full suite, package build, or shared runtime validation was
run. Those runtime/integration checks remain for the separately assigned
cumulative integration pass. Actual runtime fields are displayed only when
reported by that child; missing CLI telemetry continues to show unknown.
