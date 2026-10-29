# Antigravity managed delegation readiness

This change prepares coordinator delegation behind the existing release gates.
It does not enable production workers or mixed engines. Both source gates remain
false. There is no environment or settings override in production.

## Implemented contract

When the worker gate is enabled, the generated coordinator prompt reuses Codex's
scope, authorization, dispatch, isolation and bounded-validation rules. It adapts
transport-specific instructions to ACP's available tools. The coordinator exposes
worker tools only. Execution workers receive a separate prompt with project,
language, report and research-only boundaries; they receive no worker tools.

`app_task_checkpoint` uses `task_id`, `run`, `outcome`, `evidence` and optional
`dependency_task_id`. Outcomes match Codex: `complete`, `waiting_user`,
`waiting_dependency`, `blocked`. The dependency must be another active task.
The bridge requires an exact single-action approval, including for checkpoints.
Full permission for local tools does not bypass worker-tool approval.

A delivered report requires a checkpoint or same-task continuation. Independent
handoffs do not resolve it. One omitted decision causes one reconciliation turn;
a second omission retains an unresolved dependency and emits an error. Decisions
and reconciliation counts persist. Restart never replays uncertain delivery.
Acknowledging uncertain delivery does not accept the task. Stale report completions
cannot consume a newer worker run. Cancellation and process recovery guards remain. Reconstructed recovery-required
tasks retain their dependency and worker slot even after a checkpoint. Cancellation
must verify recorded process disappearance or fail. Missing registration is not
evidence of cleanup.

The only `bot.ts` change passes the separate worker prompt into the ACP config.
This may overlap another branch by filename; it does not touch stream rendering.

## Bounded live validation

The historical checklist remains in `agy-external-live-validation.md`. This task
explicitly authorized non-destructive product-provider probes, superseding that
document's historical executor-classification uncertainty for this run only.

The opt-in harness is outside normal test discovery:

```sh
BOTLING_VALIDATE_AGY_DELEGATION=1 \
BOTLING_AGY_ACP_PATH=/absolute/verified/agy_acp_server.par \
./node_modules/.bin/vitest run --config test/provider-validation/vitest.config.mts
```

Run from `desktop/`. It verifies the pinned runtime and helper, checks keychain
metadata without reading credentials, and uses private workspace/profile folders.
Only the test module replaces capability gates. It starts at most two workers,
uses a 90-second bound per observation, denies every model tool request and closes
all workers in `finally`. It does not approve writes or change authentication.

Two exploratory runs observed real ACP denial, correlated reports and saved-session
continuation. Their independent process observer was ineffective, so they are not
release acceptance evidence. The corrected observer saw authentication-related
stderr and stopped. Its two recorded process groups were absent after cleanup.
The authentication detector is conservative: its signal alone does not establish
that a new login is required. Keychain metadata presence does not establish a
usable session either. Do not repeat automatically or change credentials.

## Evidence still required before enabling

| Check | Current evidence | Next bounded action |
| --- | --- | --- |
| Generated policy, inventory, report decisions | Offline regressions | Review the source and focused tests |
| Real agy denial/report/resume | Exploratory observations; incomplete final probe | Confirm existing official ACP authentication, then rerun isolated probe |
| Accepted coordinator handoff and checkpoint | Approval-bound offline bridge | Exercise real coordinator through explicit per-action approval cards |
| One allowed marker write and replay rejection | Offline ownership/grant checks | Explicitly approve only the named scratch write; deny stale/replayed requests |
| Active-command cancel and crash recovery | Offline process-group checks | Approve one bounded scratch command, cancel it, verify descendants and reconstruction |
| Uncertain report delivery and restart | Durable offline tests | Induce bounded delivery interruption; confirm report-only reconciliation |
| Mixed Codex/agy isolation and handback | Offline only; separate mixed gate stays closed | Not required for agy-only activation; validate separately before enabling mixed routes |

If official ACP authentication actually requires login, the user must complete
that official ACP flow. CLI login alone is insufficient. This change supplies no
login automation. Allow-path probes require exact per-action approval; this harness
must not silently grant it. After those checks, independent evidence review and a
separate capability-enabling change remain required. No package or installation
is part of this implementation.

## Activation-readiness follow-up

Review defect P2 is fixed in `1b020ac`: recovery obligations survive task
assessment, occupy concurrency slots and block cancellation until disappearance
is verified. Real process-group and missing-registration regressions reproduce
both cases. Neither capability gate changed.

The pinned server's shipped source has no dedicated read-only auth-status method.
Its supported `/usage` command is read-only and bypasses model execution, but it
requires an initialized session. `session/new` can initiate interactive login
when cached authentication is unavailable. The probe therefore checks metadata
first and never calls `authenticate`. The probe now matches the pinned server's
explicit interactive-login notices, including split chunks, instead of generic
OAuth/browser wording. It retains the valid process observer.

At the bounded follow-up, `security find-generic-password -s gemini -a
antigravity-acp` returned 44 with output suppressed. The default fallback token
file did not exist (existence only). Runtime verification passed; zero provider
processes or model tasks started. This is a fresh-process prerequisite failure,
not a claim that every currently running ACP session is signed out.

The required next auth action is to provide an existing official ACP setup usable
by a fresh isolated process. If none exists, the user must explicitly perform the
official ACP login themselves; this probe must not initiate it or copy credentials.
After metadata succeeds, the harness checks read-only `/usage`, then two-worker
denial/report/resume behavior and no replay of an uncertain report after manager
reconstruction. The new status/reconstruction checks remain unexecuted while the
metadata prerequisite fails.

The allow/cancel/reconcile checks also need a candidate-backed staging UI with
production Bot approval callbacks and a human-operated card. The standalone
Vitest manager has no displayed card, and the installed app keeps the production
worker gate closed. No current app-tool connector can inject this isolated head's
permission request. Calling `grant`, `answer(true)` or `Bot.choose` from the test
would fabricate user approval, so it is not an authorized alternative.

In that isolated staging UI, the exact interactions are: Allow once for the
private marker write; Allow once for a bounded private command followed by Cancel;
and Allow once for the task/run-specific `app_reconcile_report` retry and report
checkpoint. No such card was emitted or accepted in this run. These steps require
a test UI/session, not installing or restarting the shared app. Mixed-provider
checks are separate and are not prerequisites for agy-only activation while the
mixed gate remains false.
