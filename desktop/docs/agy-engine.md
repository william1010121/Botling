# Antigravity ACP integration: isolated review candidate

2026-10-28. Base `0a24538d560bc7843152fe4cb5004a6f22d6737b` (installed .13).
Branch `bot/agy-engine-20261028`, worktree
`/Volumes/My-SSD/botling-work/agy-engine-20261028`.
Supersedes blocked review candidate `85c09565cf34c7992271a120d3d6905e28d9e0c7`.
See `evidence/agy-acp/review-fixes.json` for the exact revised source commit.
No merge, package, installation, restart, push or Claude launch. Installed .13
still has no ACP integration. Independent review and a separately assigned
cumulative integration/package pass remain required.

## Authentication and runtime

The user explicitly authorized one official OAuth login/consent in message
`65E07740-FD39-44C2-B5A0-A2F779EDEE06`. Official ACP 1.4.3 authenticate returned
success, then session/new succeeded. The official browser flow was observed;
no credentials, tokens, codes or account identity were extracted/copied. Subsequent
private test profiles reused this ACP login through the official credential store.
This is distinct from CLI login. The official server may initiate interactive OAuth
when its cache is missing or cannot be refreshed, even from session/new; this is
NOT a silent-only launch guarantee. No reauthentication was performed in this fix pass. No API key, Vertex account or API/Vertex spend
was used. Subscription model smoke calls were made within the authorized scope.

Official distribution and verification are recorded in [the historical
investigation](agy-acp-blocker.md). Production launch pins BOTH server and harness
SHA256 and verifies Apple code signatures. Only macOS arm64 1.4.3 is accepted.
There is no fake executable/hash override in the executable adapter.

Set `BOTLING_AGY_ACP_PATH` to the verified `agy_acp_server.par` in a development
runtime. No installer or downloader was added. A missing/mismatched runtime fails
before process/task launch. Binary distribution is a separate packaging assignment.
The existing cached runtime is under `desktop/.cache/agy-acp-dev/server/`.

For this isolated development checkout, run `node scripts/build-agy-file-helper.mjs`
from desktop/. It uses the existing Apple clang 21.0.0 to build only the small
`src/core/agent/agy-file-helper.c` adapter into that same runtime directory; this
is not an app build/install. The reproduced arm64 helper SHA256 is
`1e6feb57e33dfa1e5ffed2a7a359e6cd15c0df3272293e2ed63ec7af2ffc3403`.
The adapter pins that digest with no override. A different compiler output needs
separate review/pinning, never bypassing verification. Runtime/helper must be
outside the agent workspace, with a canonical non-symlink helper path. Use
`BOTLING_AGY_ACP_PATH=/Volumes/My-SSD/botling-work/agy-engine-20261028/desktop/.cache/agy-acp-dev/server/agy_acp_server.par`
for a separately authorized development core launch targeting another workspace.
The private smoke scripts set the same path directly. Missing helper fails before
ACP launch. No environment/settings were changed on the installed app.

Official arm64 archive (server plus harness):
https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.3-darwin-arm64.zip
Archive SHA256 `c57db0a9b8b712daa9c3c17cdb990a61842ea569f279e8bd79d7aa85a303b20b`;
server/harness digests and signature verification are in `agy-acp.ts`.
No new download or external plugin installation was needed in this pass.

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
process ledger. Cancel, ACP failure, head shutdown clean up
app-owned commands. Commands run under macOS sandbox-exec with workspace/owned-temp
writes only, ACP profile read/write denied, and home reads denied except the
workspace. There is no unsandboxed fallback/escalation. File tools use a pinned native helper with workspace device/inode anchoring,
openat directory traversal and O_NOFOLLOW on every component. Unresolved/existing
symlinks, hardlinked/special files and protected-profile identities are rejected;
existing files are never truncated before fstat. Directory FDs keep the originally
authorized inode if another process renames a directory; they never follow its
replacement into an unrelated target. The workspace root itself must still match
its pinned identity. Both protected path names and identities are denied. This
is inode-capability containment, not a claim that an external actor cannot move
an already authorized inode. Helper children are killed and awaited on cancel. Tools retain explicit one-action approval.
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
- Single agy only. New mixed selections are rejected before startup; persisted
  mixed configurations normalize to single agy, and the UI selects agy exclusively.
- Denial, cancellation, failed tools and unresolved approval cards survive a
  server end_turn response. Bot receives failed completion; report acknowledgement
  does not treat a blocked turn as successful. A fresh turn resets its outcome.

## Honest gates and validation limits

App-managed workers are actually disabled: the head never constructs a worker
manager, worker:true startup is rejected, and the MCP inventory/dispatcher omit
all worker tools even if a delegate is supplied. Offline worker code/tests remain
for future review but are not live acceptance. Live worker approval isolation,
report delivery, cancellation, crash cleanup and restart recovery were NOT tested;
no delegated worker or other engine was launched. Mixed Codex+agy lifecycle is
also unverified and disabled. These are unfinished integration requirements, not
claims of an official ACP protocol limitation.

Native subagent/`subagent_info` execution remains disabled; its inheritance and
cleanup have not been proven. There is no fabricated subagent success event.

Global/external plugins, Claude component-editor/team paths, native workflows,
background monitors and native schedules remain unavailable. This is an explicit
implementation gate, not a statement that ACP lacks all such capabilities. The
built-in HTTP MCP bridge demonstrates the safe tool transport for future adapters.
In-turn steering is unsupported: user messages queue. Native approval modes auto_edit/yolo are unavailable.

The current adapter intentionally keeps the existing usage event shape. Concurrent
Token Flow task543c6570 owns metering identity/event metadata/turn-purpose changes.
No edits here to agent/codex.ts, agent/stream.ts or Bot's usage-handling branch. ACP head/worker usage uses only the existing event fields.
Same-function merge overlap is bot.ts onItem (agy init/recovery), plus nearby
worker/routing logic. Preserve Token Flow metadata during sequential integration;
no unrelated metering redesign is included.

## Review-fix evidence

Both reviewer P1s were reproduced before editing implementation: the dangling
symlink write resolved successfully, and denial + failed tool + end_turn emitted
ok:true. The revised focused set passes 100 tests in 11 files; the final ACP
late-permission/cancellation adjustment also passed its 12-test rerun. Typecheck
passes. No full suite or package build was run.

Current live evidence is saved with the `review-` prefix: head denial is
permission_denied/ok:false, approved helper write exact, same-session load,
active command cancellation, server SIGKILL command cleanup, and production Bot
failed refusal status plus reconstruction/continuation. The first production Bot
attempt correctly failed the denied turn but session/load timed out on restart;
a single bounded retry passed. Both attempts are retained. This indicates a
remaining official-session availability risk; it is not permission to replace a
conversation, replay a task or reauthenticate silently.

Worker/mixed-engine live validation is not included; the actual gates above stay
closed. Full requested integration remains incomplete pending that validation,
independent review and separate integration/package assignment.

## Historical evidence and reproducibility

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

Prior candidate focused run (not acceptance of the review fixes): **90 tests passed in 11 files**, `npm run typecheck` passed,
and `node scripts/core-dev.mjs` passed. No swap/restart followed the core build.

Focused offline tests cover the startup policy state machine, cancellation before
prompt, exact MCP grants, outside/protected writes, process/child cleanup, persisted
worker reports and stale-run isolation, existing resume regression, approval-rule
isolation, engine routing, settings, legacy CLI fail-closed behavior and
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

These are model smoke runs, not offline unit tests. They do not call authenticate or
copy tokens (the official server can still initiate OAuth on missing credentials), never launch Claude, create only owned temporary workspaces, and
approve only their exact benign fixture writes/commands. Run each build only if
it succeeded; do not run a stale bundle after a failed compilation. For the image
probe, copy attachment-fixture.png into the owned cache first; extended_smoke.ts
also supports --crash-only. Binary/token files are not committed.


## Worker contract staging after approved restricted baseline 1c61405

The restricted single-agy baseline remains enabled as reviewed. The next worker
implementation is staged behind the existing gates; this is not full integration.
`agy-workers.ts` now owns pending approvals per task/run/request, checks the exact
input and consumes each answer once. Late events cannot cross terminal/run
boundaries. Resume/cancel tools require the current run, refuse busy steering,
and cannot replace an unacknowledged report. A cleanup operation holds its worker
slot and handback dependency; cleanup failure cannot produce successful completion.

Worker state v2 is bound to its coordinator conversation. Legacy or foreign state
is preserved and refused. Worker ACP/command process identities are captured via
the existing process-start callback before task submission. Restored active state
never starts a job automatically. Explicit continuation requires acknowledgement
of the interruption report and evidence that the recorded process groups are
gone (a different leader start time means the old PID was reused). Missing process
identity remains a recovery blocker. No new PID is killed merely on the basis of
model output. The existing app process ledger remains responsible for crash cleanup.

Report delivery is durably marked before an ACP prompt is submitted. Task/run
mismatches and duplicate queued reports do not create a background turn. After a
crash during delivery, the report is uncertain, not automatically replayed. An
explicit reconciliation UI/API is still needed for that state. Reports remain
data; they do not grant permission or establish acceptance of the user's goal.

Validation at this stage uses offline protocol fixtures plus real owned Node
process groups, not real Codex/agy worker models. This execution worker's governing
rule prohibits delegation to another bot. Consequently no real app-managed worker
was launched, and no live mixed-engine acceptance is claimed. The source gates,
including all Claude routes involving agy, remain closed. A test environment that
permits product-worker lifecycle probes is required for the next live stage; no
new user OAuth/API-key/billing decision is needed for already-authorized tests.

Before enabling: wire explicit recovery/reconciliation into the app; connect a
Codex/agy transport with independently checked per-worker permissions, scoped
profiles and no native/external delegation fallback; validate real approval
isolation, correlated reports, stale runs, concurrency, cancel/crash/restart and
handback/stop. No Codex adapter or Token Flow source was changed in this stage.

### Subsequent candidate provisioning (review only; no package built)

The candidate must provision the reviewed official arm64 ACP server and harness
plus the pinned file helper outside every agent workspace. Their current verified
local paths and hashes are listed above. Private worker profiles/state belong
under app-managed storage, not the shared workspace or CLI settings. The app's
process ledger must run recovery before worker restoration.

The current helper digest is for the verified clang-produced Mach-O bytes. A
release-signing step can change those bytes: pin/review the actual helper that
will ship, then verify the final embedded artifact before enabling it. Do not
silently relax the digest check or re-sign the pinned Google binaries and assume
the old digests still apply. No downloader, global install, external plugin,
account change, package, merge or app restart was performed here. Model/vision and
native/plugin limitations from the single-head review remain unchanged.

### Offline mixed-engine wiring (2026-10-29; supersedes staging TODOs above)

The staged ACP coordinator now constructs its worker manager and routes agy or
Codex workers through a pinned engine identity. Bot peer routing, selection,
handback/stop and separate saved Codex conversation identity are wired. Mixed
Codex uses a leaf wrapper with single-action approvals and sticky denial/cancel/
failed-tool outcomes; ordinary Codex implementation and metering are unchanged.
Uncertain report delivery has an exact-grant `app_reconcile_report` API (acknowledge
or report-only retry, never task replay). Worker profiles, task/run/request
ownership and recovery contracts remain enforced.

Both source runtime gates remain false, including worker tool inventory/dispatch.
Claude routes involving agy remain blocked even when the offline pair fixture is
active. No live acceptance is claimed. The offline fixtures replace all agent
transports; the worker lifecycle suite additionally uses owned benign Node
process groups, not model agents. See `agy-external-live-validation.md` for the
executor-boundary clarification and the separate pending external procedure.
The procedure requires a permitted live harness; it is not a ready-made or
already-passed live test command. Full integration remains incomplete.


## Disabled main integration — 2026-10-29

Integrated exact agy tip `0f251e02dd2f588271208cb7eceeb32fe8cb7d9d` onto
main baseline `ba7567714da63b8e64802dbba4407659a0de9164`. Reviewed the
post-`1c61405` worker ownership, approval correlation, cleanup/report recovery
and mixed wiring for disabled integration; this is not live enablement acceptance.
Production worker and mixed gates remain source constants returning false,
including all Claude/agy routes. Native headless execution remains blocked.

Conflict resolution retains main's `.16` package metadata, Token Flow import and
subagent output counters. An integration type error exposed the unsupported agy
history attribution boundary: Token Flow now excludes agy legacy worker rows
without relabeling them, retaining saved Claude/Codex history. A focused behavior
test covers this boundary. Notify and Token Flow visual work are not included.

Validation: 94 distinct targeted tests passed (75 agy, 19 existing Token Flow
history/production and subagent presentation tests), plus desktop typecheck and
staged diff whitespace checks. The initial 74-test agy run had two missing-helper
fixture failures; after copying the original fixture and verifying its exact
pinned SHA-256, all 11 MCP tests passed. The initial typecheck failure was fixed
by the attribution guard. Passed unchanged tests were reused, not rerun.
No full suite, package, installation, restart, real model or live worker test ran.
The external live-validation procedure and helper provisioning acceptance remain
prerequisites to a separately authorized enablement/release phase.

## Runtime Settings (2026-10-29 candidate)

Settings → Engines and subagents → Antigravity now accepts an absolute path to
`agy_acp_server.par`. **Save and verify** checks the existing pinned official ACP
1.4.3 server/harness hashes and Apple signatures, executable access, and the pinned
canonical `botling-agy-file-helper` beside them before persisting `agyAcpPath` in
global `settings.json`. A failed save leaves the previous setting untouched. An
empty saved path removes only this preference. **Check active runtime** rechecks
files without executing the runtime, logging in, downloading, or sending a model
request. A successful check is file verification, not connection acceptance.

A nonempty `BOTLING_AGY_ACP_PATH` still overrides the saved preference, even if
invalid; Settings displays the override and never silently falls back. Remove or
correct that environment variable and restart the app to change the override.
The saved preference is read on the next Antigravity configuration/launch without
an app restart; running sessions keep their process. Launch rechecks the runtime
and helper against the actual project location. Settings checks against the app
data directory, so its success does not promise suitability for every project.
The runtime/helper must remain outside the project, with a canonical helper path.

Provisioning remains external: the official macOS arm64 ACP 1.4.3 distribution
and the exact verified Botling helper described above are required, plus the
existing official Google sign-in at connection time. No installer, legacy CLI
fallback, worker/mixed-engine gate, or delegation/permission policy was changed.
