# Antigravity engine

Implementation base: `0a24538d560bc7843152fe4cb5004a6f22d6737b`
(`2.0.0-dev.20261028.13`). This branch is not installed or merged.

Select **Antigravity** in the bot's own Settings → Engines. It runs alone;
selecting Claude or Codex switches back. Set a model ID from `agy models`
in the Antigravity model field (saved on leaving the field), or leave it empty
for the CLI default. The bot's reasoning-effort setting also applies.
`BOTLING_AGY_PATH` optionally selects the CLI executable; the default is `agy`.
Existing CLI authentication is required. Botling does not log in, update the
CLI, change global settings or import Claude/Codex permission overrides.

## Supported

- Dedicated NDJSON input/output adapter; streamed text and tool activity.
- Errors, terminal status and explicit soft-denial handling. A CLI `SUCCESS`
  containing `denied_actions` is a failed/blocked Botling turn, never completion.
- Per-step token accounting (the CLI's result counters are cumulative).
- Persistent multi-turn process and actual `conversation_id` persistence.
- Model/effort restart, app restart and cancellation resume by conversation ID.
- Process-group termination through Botling's existing process-tree adapter;
  cancelled-process output is ignored. A platform daemon that independently
  detaches is outside the existing adapter's process-group boundary.
- Task/chat engine attribution, engine selection and per-bot model configuration.

## Explicit limitations

The upstream headless protocol cannot answer interactive tool approval requests.
It rejects `control_request` / `control_response` input. Botling sends neither,
never supplies bypass flags, and does not create allow rules. A non-review
`init` is rejected and the process terminated; this is a runtime check, not an
OS sandbox. The CLI emits `init` after a first prompt is submitted, so this
check is not a pre-execution permissions handshake. Existing CLI allow/deny
rules remain authoritative. The CLI may permit workspace operations itself.

Shared-engine chats and peer handoffs are gated. Botling-managed workers and
Claude plugin injection are unavailable: delegated team/component/plugin/new
bot/project requests cannot silently start a Claude worker. Native Antigravity
subagent execution, when used by the CLI, is not mapped to Botling's managed
worker lifecycle; only exposed tool activity is shown. No app worker routing
protocol is claimed. Image input is rejected rather than silently discarded.
Model discovery is via the existing CLI; the UI accepts its model IDs.
Subscription quota and monetary cost are not available through this adapter.

Agy-specific prompts are isolated from the Claude/Codex prompts. App request
handlers retain their existing authorization checks for supported requests.

## Protocol evidence

Official contract checked 2026-10-28:
https://antigravity.google/docs/cli/headless/

The locally installed CLI produced:

- Input: `{"event":"user","message":{"content":"..."}}`.
- Output: `init`, `step_update` (`agent_response`, `tool`), `result`.
- Tool fields: `tool_info.name`, `parameters`, `output`, optional `error`.
- Command refusal: `status: "SUCCESS"`, empty response, and
  `denied_actions: [{"action":"command","display_name":"RunCommand"}]`.
- A read-file tool followed by a refused `printf` command; no allow rule or
  bypass flag was used. The refusal notice was also sent on stderr.

The initial attempted Claude-shaped stdin invocation failed before a turn.
The corrected native event protocol ran successfully. No CLI compatibility
was inferred merely from the shared `stream-json` option name.

## Focused verification

From `desktop/`, after linking the existing dependencies:

```sh
node scripts/core-dev.mjs
./node_modules/.bin/tsc --noEmit -p tsconfig.json
./node_modules/.bin/vitest run test/unit/agy.test.ts test/unit/agy-core.test.ts test/unit/agy-settings.test.ts
```

Explicit opt-in live smoke (uses the existing account, a private temporary
folder, model `gemini-3.8-flash-medium`, and benign prompts; never changes
account permissions):

```sh
BOTLING_LIVE_AGY=1 BOTLING_AGY_PATH=/path/to/agy ./node_modules/.bin/vitest run test/live/agy.test.ts
```

The live smoke passed: two turns remembered a marker; a new process resumed
that marker; file tool activity was observed; a command was refused and
surfaced as failure; cancellation exited without late output. This smoke's
refusal assertion is intentionally account-policy-dependent: if a user has
already allowlisted the command, it must not be described as a refusal test.

Regression checks passed for existing engine switching, engine permissions,
settings dropdowns and engine avatars. The settings UI test selects agy alone,
saves a model ID, displays limits, and switches back to Codex. Core tests cover
settings persistence, process restart, blocked delegation, refusal and stop/resume.
No full suite, package build, install, app restart or push was run.

## Integration

Review and integrate the entire commit together: contract, renderer and core
must all recognize the new engine. Do not swap only this core into an older UI.
`agyModel` is an optional response field for compatibility; the stored
`agyConversation` belongs only to agy and is cleared on an intentional engine
switch/new session. Existing Claude/Codex prompts and permission flags remain
unchanged. Changes touch engine unions in task/subagent presentation, but no
Whiteboard implementation or Rust migration.

Native packaged GUI verification and the cumulative packaging pass remain
with the coordinator. The local React interaction test is not packaged-app
visual acceptance.
