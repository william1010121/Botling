# App-owned routine scheduling

The Routines panel can create **Once** or **Every day** jobs. Codex coordinators
have a bot-scoped `app_routines` dynamic tool. Existing `routines.cron` files,
comments, paused lines, cron matching and legacy same-day catch-up remain supported.
No system crontab, shell permission, background daemon, or OS wakeup is installed.
Botling checks approximately every 30 seconds while running; sleep and app closure
delay dispatch. This is scheduling an instruction, not monitoring a command's exit.

## Codex operations

Use the tool directly, including on the otherwise execution-free coordinator.
Workers do not receive it. Storage paths come from the bot's AgentLaunch, never
tool arguments; both engine heads use the owning bot's routine directory.

```json
{"operation":"create","kind":"once","at":"2026-10-25T09:00:00+08:00","timezone":"Asia/Taipei","task":"Review: inspect the saved report","request_id":"review-2026-10-25"}
{"operation":"create","kind":"recurring","cron":"0 9 * * 1-5","timezone":"Asia/Taipei","task":"Standup: summarize pending decisions","request_id":"weekday-standup-v1"}
{"operation":"list"}
{"operation":"pause","id":"<returned id>"}
{"operation":"resume","id":"<returned id>"}
{"operation":"cancel","id":"<returned id>"}
```

Create returns a persisted UUID, status, request_id and schedule. Reuse request_id
with the identical creation payload after ambiguous transport failure; even after
firing/cancellation it returns the same record. A different payload with that key
fails with an actionable error. New independent work needs a new request_id.
Cancellation preserves the record/key. Fired/cancelled/uncertain records cannot
be rearmed. To reschedule, cancel the old pending/paused ID, then create with a
new request_id. A failure creating the replacement leaves the old job cancelled.
The native UI also retains one request_id while retrying a failed Add.

List includes legacy IDs prefixed `cron:`; pause/resume/cancel work on those too.
Their identity remains the cron+task line, so external edits change their IDs;
refresh list after editing. Legacy direct-file edits retain their historical
behavior and do not participate in the new store's locking protocol.

## Time and recovery

- Once: `at` must be a future ISO-8601 instant with seconds and explicit Z/UTC
  offset. A bare local time is rejected, including DST-ambiguous local times.
  The optional IANA timezone is for display; the offset determines the instant.
  Default display timezone is the system timezone at creation. Moving the system
  timezone does not move the instant. An overdue pending job runs at the next
  check, including after restart or after resuming a paused overdue job.
- New recurring: five cron fields and a saved IANA timezone (local at creation
  if omitted). Catch up only the latest matching minute **today in that zone**,
  after creation/resume or last claim. No backlog from prior days. A repeated
  DST wall-clock minute is two distinct instants and can trigger twice; a skipped
  wall-clock minute does not exist. Explicitly choose a once instant if only one
  occurrence is intended.
- Legacy cron: continues to use Calendar.current / current local timezone and
  the existing persisted routineRuns baseline. No migration or reinterpretation.

## State, cancellation, and failure semantics

`scheduled-routines.json` is app-owned beside the bot's routines.cron, shared by
native UI, Codex, and the workspace scheduler. A separate advisory lock serializes
read/modify/atomic-write transactions across store instances/processes. Version,
record identity and schedule validation reject corrupt/unsupported documents;
errors do not silently reset them. Mutation success is returned only after saving.
The file is not an agent-editable scheduling interface.

- `pending`: saved, waiting for its time; `due`: computed from pending and the
  current check time, not a claim that the task is already executing.
- `paused`: no trigger until resumed. `cancelled`: no future trigger. Cancellation
  that wins the lock before a claim prevents dispatch even with a stale UI snapshot.
- Scheduler atomically saves `claimed` **before** entering the message router.
  Another tick, scheduler instance or restart cannot claim the same job/occurrence.
- `fired`: the once trigger was passed to Bot's message router. This is **not**
  successful task completion, nor proof the agent started. Launch/permission/task
  failures and queued work are shown in chat. There is no automatic retry.
  Recurring records return to pending with their last claim and dispatch timestamp.
- A crash or final-save failure between claim and recorded dispatch leaves
  `delivery_uncertain` (stored as claimed). It is not retried or rearmed. Check chat
  and deliberately create a replacement if needed. An already claimed job cannot
  be cancelled as if delivery had been prevented.
- Cancellation cannot recall already routed/queued work or stop an active agent.
  Cancelling an already fired once job returns its truthful fired state.
- If persistence fails before claiming, no message is routed; the UI/tool surfaces
  the error. Corruption never causes an empty replacement state to be written.

This provides durable scheduling and **at-most-once trigger attempts**, not
transactional exactly-once execution. A process crash after claiming but before
routing, or after routing to an in-memory queue but before execution, can lose an
attempt. Atomic file replacement is not a guarantee against disk/power loss. The
existing Bot route/task lifecycle is unchanged. Old Codex tool schemas migrate to
a fresh internal coordinator thread using the existing signature mechanism;
worker records and previous thread lineage remain preserved.

## Validation boundaries

Focused Swift tests cover native workspace trigger delivery via FakeLauncher,
restart/overdue behavior, persistent cancellation/pause, stale snapshots, a claimed
crash window, corruption/storage failure, idempotency, saved timezone and distinct
DST-offset instants, 40 concurrent claims, legacy comments/IDs, dynamic-tool schema,
actual JSON-RPC replies, persisted IDs, retry, invalid IDs and worker-thread denial.
The app target is built by swift test. These are deterministic store/protocol and
fake-agent checks, not a live Codex scheduling conversation or an installed app UI
acceptance run. No production app installation/restart is required by this change.

Recorded regression evidence for this implementation:

- On base `0106814` plus the discovery test, `coordinatorDiscoversFirstClassRoutineTool`
  fails because the tool is absent (`efe6c91`).
- Replaying the old recurring calculation (`lastClaim ?? baseline`, without the
  resume baseline maximum) makes `resumeAfterPriorFireSkipsOccurrencesWhilePaused`
  fail: it catches up a paused occurrence and blocks the following occurrence.
  The saved final source was restored byte-for-byte after this replay.
- The final compatibility selection reports 133 tests across 14 suites passing;
  one opt-in live migration/export probe is skipped. It includes localization
  completeness and app-target linking. No installed/live UI or live Codex model
  scheduling acceptance is claimed.

Integration should cherry-pick the regression commit then the feature commit into
an isolated integration worktree based on current main. Preserve concurrent work
in Bot.swift, CodexAgentProcess.swift and Prompts.swift: this change owns routine
state, bot-scoped launch context, the app_routines tool and routine instructions,
not continuation judgments, worker ownership, routing or monitor behavior. No
README, version, release, shared checkout or installation change belongs here.
