# Antigravity integration — blocked, not ready to ship

Follow-up: see [transport feasibility](agy-transport-feasibility.md). An isolated
SDK development install and offline policy checks are now complete; official
ACP is an additional candidate for existing subscription authentication. The
older investigation below predates that authorization and evidence.

Base: `0a24538d560bc7843152fe4cb5004a6f22d6737b` (installed .13).
Isolated branch: `bot/agy-engine-20261028`. Never merged or installed.

Review of `71cf40c` demonstrated that init validation happened too late: a child
could emit `always-proceed` and execute the submitted task before being killed.
The old successful live smoke did not establish a permission boundary. It is
superseded and its executable test has been removed.

## Current behavior

AgyHead.start and send now fail before spawning any executable or submitting
any task, including configured/fake executables. There is no bypass switch.
Backend engine selection rejects agy; the UI disables its toggle with an
explanation. Previously saved agy bots retain configuration and can select
another engine. Full agy integration is NOT delivered.

The retained protocol decoder requires validated init before any event, poisons
itself on invalid init, rejects duplicate init and changed conversation IDs,
and recognizes both request-review and strict. Decoder validation does not
confer runtime execution authority. Soft-denied SUCCESS remains a failure;
approval responses and direct image blocks remain explicitly rejected.

Unexpected exits and blocked startup preserve the existing conversation ID and
persist agyRecovery {sessionId, state: "resume-required", reason}. No immediate
replay occurs. The next explicit message and app restart retain the same ID.
Intentional new-session clears recovery and identity; valid init clears recovery.

## Why the CLI cannot presently be enabled

Official documentation reviewed 2026-10-28:

- https://antigravity.google/docs/cli/headless/ — streamed user tasks trigger
  execution; approval control messages and non-text blocks are rejected.
- https://antigravity.google/docs/cli/modes/ — plan is a planning instruction,
  not containment; modes do not replace explicit policy.
- https://antigravity.google/docs/sandbox/ — terminal sandboxing alone does not
  establish whole-execution containment; availability and configuration matter.
- https://antigravity.google/docs/settings?tab=cli — strict asks even for reads
  despite allow rules. It must not be downgraded to request-review.

No documented immutable per-execution tool policy flag or pre-task handshake
was found in these documents or local CLI help. Reading mutable settings or
sending a harmless probe cannot establish the necessary guarantee. No settings,
login, permissions, global instructions, or installed dependencies were changed.

## Official alternative and remaining implementation

https://antigravity.google/docs/sdk/policies/ documents LocalAgentConfig policies
with default deny, explicit allows and per-tool approval callbacks. This is a
candidate transport for mapping Botling's approvals/refusals before execution.
https://antigravity.google/docs/sdk/overview/ documents custom tools, MCP,
subagents and multimodal input: an app-owned bridge could expose existing worker
APIs through custom tools/MCP, without Claude plugin flags or global prompts.

The local Python environment has no google.antigravity package. The SDK documents
Gemini API key or Vertex/ADC authentication; reuse of the existing agy CLI login
is not established. This task prohibits installation/new authentication, so no
SDK runtime or authorization callback smoke was attempted. Next step is a
separately authorized isolated SDK dependency and verification of an existing
supported credential path (never collecting credentials in chat). Alternative:
a supported CLI immutable policy/approval API, or independently validated
whole-execution containment covering every tool, child and sidecar.

Mixed-head routing, app-managed worker lifecycle/delegation and native
subagent_info visibility remain unimplemented app work, NOT inherent protocol
limitations. They must be completed and tested after a safe transport is chosen.
Neither model configuration nor CLI presence makes this engine usable.

## Focused evidence

The startup race and three decoder regressions all failed on the previous code;
the race wrote the task marker before termination. The failed-resume regression
also failed against the prior bot.ts because agyConversation was deleted.
The new tests cover pre-spawn rejection, decoder state/policy, conversation
identity through another explicit message and Bot reconstruction from disk (the
app restart path), and disabled selection. All 23 focused tests below and the
TypeScript check passed.
Run from desktop:

```
npx vitest run test/unit/agy-review.test.ts test/unit/agy.test.ts test/unit/agy-core.test.ts test/unit/agy-settings.test.ts test/unit/process-tree.test.ts test/unit/engine-permissions.test.ts
npx tsc --noEmit -p tsconfig.json
```

Process-tree tests use benign Node fixtures with active children, including
SIGTERM-resistant children. They are general group-cleanup evidence only: no
real agy tool/subagent cancellation or detached sidecar cleanup is established.
There is no active agy subprocess to cancel in the blocked adapter. No full
suite, package, installed-app restart, real agent smoke or native preview is
claimed for this revision. Review this safety correction together with 71cf40c;
do not release the earlier runnable adapter alone.
