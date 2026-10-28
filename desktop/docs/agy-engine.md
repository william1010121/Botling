# Antigravity ACP integration: isolated review candidate

2026-10-28. Base `0a24538d560bc7843152fe4cb5004a6f22d6737b` (installed .13).
Branch `bot/agy-engine-20261028`, worktree
`/Volumes/My-SSD/botling-work/agy-engine-20261028`.
Source commit: `8b57c78f847b95e195d8538b85817ba8e52ae6b7`.
No merge, package, installation, restart, push or Claude launch. Installed .13
still has no ACP integration. Independent review and a separately assigned
cumulative integration/package pass remain required.

## Authentication and runtime

The user explicitly authorized one official OAuth login/consent in message
`65E07740-FD39-44C2-B5A0-A2F779EDEE06`. Official ACP 1.4.3 authenticate returned
success, then session/new succeeded. The official browser flow was observed;
no credentials, tokens, codes or account identity were extracted/copied. Subsequent
private test profiles reused this ACP login through the official credential store.
This is distinct from CLI login. No API key, Vertex account or API/Vertex spend
was used. Subscription model smoke calls were made within the authorized scope.

Official distribution and verification are recorded in [the historical
investigation](agy-acp-blocker.md). Production launch pins BOTH server and harness
SHA256 and verifies Apple code signatures. Only macOS arm64 1.4.3 is accepted.
There is no fake executable/hash override in the executable adapter.

Set `BOTLING_AGY_ACP_PATH` to the verified `agy_acp_server.par` in a development
runtime. No installer or downloader was added. A missing/mismatched runtime fails
before process/task launch. Binary distribution is a separate packaging assignment.
The existing cached runtime is under `desktop/.cache/agy-acp-dev/server/`.

## Before-task boundary

The legacy `AgyHead`/headless CLI stays unconditionally blocked. Its strict/init
parser tests remain, but an init line never authorizes legacy execution.

The new `AgyAcpHead`:

1. Pins the official executable artifacts, builds a private app-owned GEMINI_HOME,
   selects personal OAuth only, suppresses inherited hooks/global MCP, marks the
   workspace untrusted for hooks, and uses a restricted environment. It does not
   change the user's CLI/global settings, permission rules or instructions.
2. Sends initialize and session/new or session/load with an explicit builtin
   inventory containing only `finish`. Native shell/file mutation, native
   subagents, workflows, scheduling, browser agents and image generation are NOT
   exposed. There is no fallback to native tools when an app tool is refused.
3. Awaits the pinned agent/version, session identity, model/effort selection and
   explicit `default` approval-mode acknowledgements BEFORE sending a prompt.
   Interrupt, timeout, malformed/premature success, bad mode, failed auth and
   failed resume do not release queued prompts.
4. Connects only the built-in loopback HTTP MCP endpoint `botling`. For each
   action, the app records an exact tool+arguments grant ONLY after the user's
   matching Allow once card. The bridge consumes it once, checks expiry and
   revocation, and refuses calls without it—even a direct call to its endpoint.
   ACP MCP's observed nested/flattened arguments are checked for consistency.
5. Does not import shared Always allow rules. ACP cards offer Allow once / Don't
   allow only; arbitrary questions/workspace-trust options are cancelled rather
   than reinterpreted as an approval. No persistent ACP allow-always is sent.

This is an app-controlled action gate, not a claim that mutable settings or a
harmless model prompt alone establishes safety. Pinning/source inspection
establishes the native inventory and policy construction; offline fixtures and
real deny/allow/cancel smoke establish the actual transport and tool path.

## Why native commands remain disabled

A benign native run_command created a separate process group. ACP session/cancel
stopped it, but terminating the ACP server's group left that command alive.
The test explicitly killed its own orphan afterwards. Evidence:
[evidence/agy-acp/native-exit-failure.json](evidence/agy-acp/native-exit-failure.json).
This is a demonstrated limitation, not a conjecture or a passing cleanup test.

Botling's MCP command tool owns its process group and registers it in the existing
process ledger. Cancel, ACP failure, head shutdown and worker shutdown clean up
app-owned commands. Commands run under macOS sandbox-exec with workspace/owned-temp
writes only, ACP profile read/write denied, and home reads denied except the
workspace. There is no unsandboxed fallback/escalation. File tools reject outside
workspace and protected-profile paths. Tools retain explicit one-action approval.
Commands time out at 120 seconds; output is bounded. Deliberately daemonizing
commands can escape the existing process-group mechanism; no claim of arbitrary
hostile-process containment is made. Native execution is not used to bypass these
limits. Tools needing additional folders/home credentials must report the denial.

## Implemented app behavior

- Engine selection and stored model configuration; available-account model IDs
  are validated by ACP. `low`, `medium`, `high` effort are supported; xhigh/max fail
  explicitly. Blank model uses the account default.
- Streamed text, tool activity/results, errors, turn completion, single-action
  approval/refusal, token usage through the existing event shape, image blocks.
- Session/load on subsequent wakes/app reconstruction. Failed resume retains
  agyConversation and agyRecovery; no replacement session or automatic replay.
  Engine switching retains agy identity. Intentional new chat clears it.
- At most two explicitly selected engines, including Codex+agy or Claude+agy.
  Partner routing and hand-back/limit-card choices use the actual pair. Existing
  Claude/Codex prompt golden tests remain unchanged/passing.
- App-owned ACP workers through MCP app_handoff, app_send_message and
  app_cancel_task. Dedicated sessions, per-run permission IDs, visible subagent
  activity/results, task association, correlated later report turns, capped
  concurrency, process-ledger registration and cancellation. Worker sessions and
  pending reports persist atomically; reports clear only after the matching run's
  coordinator prompt completes. Interrupted workers are not silently restarted.
  Workers cannot create nested workers. Worker completion is not goal acceptance.

## Honest gates and validation limits

Native subagent/`subagent_info` execution is disabled, not falsely mapped to a
completed worker. `subagent_info` belongs to the old CLI event stream; native ACP
subagent inheritance/cleanup has not been proven. App-controlled workers emit the
app's existing subagent lifecycle events instead. Their routing, persistence,
approval/refusal and cancellation were tested with offline child fixtures; no
live delegated worker or other engine was launched by this execution worker.

Global/external plugins, Claude component-editor/team paths, native workflows,
background monitors and native schedules remain unavailable. This is an explicit
implementation gate, not a statement that ACP lacks all such capabilities. The
built-in HTTP MCP bridge demonstrates the safe tool transport for future adapters.
In-turn steering is unsupported: user messages queue; busy-worker follow-ups
return an explicit error. Native approval modes auto_edit/yolo are unavailable.

The current adapter intentionally keeps the existing usage event shape. Concurrent
Token Flow task543c6570 owns metering identity/event metadata/turn-purpose changes.
No edits here to agent/codex.ts, agent/stream.ts or Bot's usage-handling branch. ACP head/worker usage uses only the existing event fields.
Same-function merge overlap is bot.ts onItem (agy init/recovery), plus nearby
worker/routing logic. Preserve Token Flow metadata during sequential integration;
no unrelated metering redesign is included.

## Evidence and reproducibility

`docs/evidence/agy-acp/` contains sanitized login and probe outcomes. Real tests:

- Official authentication + session/new.
- Native file denial, pending-command cancellation, MCP denial/cancellation and
  workspace hook trust rejection: markers absent. Native forced-exit cleanup
  FAILED and led to the disabled native-command path above.
- Implemented ACP head: refused write absent; approved write exact; process-restart
  continuation same session; active app-owned command stopped on cancellation.
- Selected model + medium effort, red-image input recognized as Red, usage emitted.
- Unexpected SIGKILL of ACP: app-owned active command stopped. The sandbox version
  is recorded separately in sandbox-crash-smoke-results.json.
- Production Bot selection/cards/denial/reconstruction probe is recorded in
  bot-smoke-results.json (passed).

One initial initialize attempt exceeded the original 30-second limit. The bound
was raised to 60 seconds; subsequent initialization/resume probes succeeded.
The first Bot probe inspected an internal permission field instead of the public
approval view; its card timed out and correctly denied the action. The fixture
was corrected and the actual public card selection/reconstruction probe passed.
A failed rebuild was detected; output from its stale smoke bundle is not counted
as final sandbox validation. The fresh separately named final bundle was rerun.

Final focused run: **90 tests passed in 11 files**, `npm run typecheck` passed,
and `node scripts/core-dev.mjs` passed. No swap/restart followed the core build.

Focused offline tests cover the startup policy state machine, cancellation before
prompt, exact MCP grants, outside/protected writes, process/child cleanup, persisted
worker reports and stale-run isolation, existing resume regression, approval-rule
isolation, engine pair routing, settings, legacy CLI fail-closed behavior and
existing permission/prompt contracts. Typecheck and a core-only bundle validate
wiring. No full suite, packaging, installed native UI preview or live mixed-engine
worker run was performed.

To reproduce the head/Bot probes from desktop/, with the already-authenticated
pinned runtime in `.cache/agy-acp-dev/server/`:

```sh
./node_modules/.bin/esbuild docs/evidence/agy-acp/head_smoke.ts --bundle --platform=node --format=esm --outfile=.cache/agy-acp-dev/head-smoke-review.mjs
node .cache/agy-acp-dev/head-smoke-review.mjs
./node_modules/.bin/esbuild docs/evidence/agy-acp/bot_smoke.ts --bundle --platform=node --format=esm --packages=external --outfile=.cache/agy-acp-dev/bot-smoke-review.mjs
node .cache/agy-acp-dev/bot-smoke-review.mjs
```

These are model smoke runs, not offline unit tests. They never authenticate or
copy tokens, never launch Claude, create only owned temporary workspaces, and
approve only their exact benign fixture writes/commands. Run each build only if
it succeeded; do not run a stale bundle after a failed compilation. For the image
probe, copy attachment-fixture.png into the owned cache first; extended_smoke.ts
also supports --crash-only. Binary/token files are not committed.
