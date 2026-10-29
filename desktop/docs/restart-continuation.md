# Explicit restart continuation

An approved restart update now prepares `restart-continuation.json` before the installer starts its helper.
Ordinary quit, crash recovery, and hot swap do not grant restart continuation authorization.

The core holds new turns. At shutdown it takes a fresh checkpoint, so completed and cancelled turns are excluded.
It records original chat, engine, session, user-message and handoff identities, queued turns, and Codex worker task/run/thread identities.
The checkpoint becomes ready only after shutdown persistence succeeds. A failed install cancels preparation and releases held turns.

On boot, after the existing update activation gate, each entry is claimed durably before provider I/O.
Claims are never automatically retried. A crash during dispatch leaves a reconciliation notice instead of another prompt.
The next boot cannot replay a dispatched entry. Failed session resumes cannot silently start replacement conversations.
Queued messages retain their original turn and message IDs; interrupted replies use a new transport turn attached to the original user task.

## Provider behavior

- Claude resumes the original session with `--resume`. Resumable native children are reconciled from their original parent/agent transcript.
  At a confirmed tool-result boundary, the app sends one recovery note to the original parent, naming exact agent IDs for `SendMessage`.
  Descendants stay with their original launchers. This is automatic parent-mediated recovery, not an app-owned standalone native-child process.
  Existing child UI/task identities survive new provider call IDs; rows become running only when provider events confirm a resumed run.
  Built-in Explore/Plan agents are provider-defined one-shot agents. Missing IDs, missing checkpoints and ambiguous launcher chains stay paused.
- Codex resumes the mapped coordinator thread. Interrupted coordinator turns and managed workers first read their original thread and reconcile the recorded turn.
  A completed worker reports existing evidence without rerunning. A confirmed interrupted turn with no unresolved tool items resumes the same task/run/thread.
  Missing turns, incomplete tool outcomes and report-delivery uncertainty stay paused.
- App-managed component-editor children resume automatically through the existing Claude transport and authoritative Maintainer role definition.
  The app preserves task ID, run, session UUID, assignment and permissions. It checks the current run's acknowledged tool-result checkpoint first.
  A confirmed final result is returned without another child prompt. Missing definitions, pending approvals or unresolved tools never fall back to a generic worker.
- Antigravity coordinator continuation uses the existing ACP `session/load` capability gate and original session ID.
  Managed ACP children remain paused because their execution/cleanup reconciliation contract is not yet implemented.
- Monitored commands and uncertain callback delivery are never replayed.

Pending permissions, unknown prompt delivery, running tools, paused/deferred work, and unsupported children produce explicit notices.
The original conversation identity and permission-request text remain available; stale process approval handles are not automatically approved.
No operating-system process is claimed to survive restart.

## Integration contract

`Bot.restartEntries()` uses every `Bot.peers` entry when available, with a fallback for the older single `partner` baseline.
Merge the three-engine lifecycle implementation's all-peer startup, hold, and shutdown loops intact.
This branch changes only restart snapshot/adoption, strict resume handling, and the associated installer/boot hooks.
It does not change engine selection or cross-engine routing.

Validation uses fake core processes and provider protocol fixtures. No live model calls or packaged restart were performed.
Real-provider acceptance still needs a separately authorized restart, including provider transcript status after interruption and mixed-peer child cleanup.

## Claude recovery evidence and remaining bounds

This closes an implementation gap; Claude does support child continuation.
The installed CLI reported `2.1.311`; its local help exposes `--resume`. No model prompt was issued to inspect it.
The official [native subagent documentation](https://code.claude.com/docs/en/sub-agents#resume-subagents) describes same-session `SendMessage` recovery by agent ID, preserved tool boundaries, one-shot Explore/Plan agents, and refusal to auto-resume user-cancelled agents.
The [SDK documentation](https://code.claude.com/docs/en/agent-sdk/subagents#resume-subagents) requires retaining the parent session and child agent ID.

The local reader checks session/agent ownership and the acknowledged tool-result ID in the latest child run.
Unpaired calls, denied/failed tools, later prompts, unreadable transcripts and ambiguous completion block execution.
It currently reads the canonical project transcript location, with a 16 MiB bound. Rotated/noncanonical or larger transcripts require explicit reconciliation.
A final `end_turn` with text is reusable evidence. Missing completion status is not guessed from prose.

A blocked native entry shows `Restart continuation paused` with the child ID/reason. Its parent session remains saved.
Original assignments and tool history remain in subagent details; recovery identities also remain in the restart journal.
An ambiguous component-editor shows its original child row as interrupted with the exact blocker. Neither path claims a live process survived.

Follow-up validation includes same-session native-parent boot dispatch and duplicate boot, native identity/launcher continuity, and a fake-process editor transport exercising `--resume`, completed-before-crash and unresolved-tool outcomes.
These tests prove app dispatch/reconciliation, not a real Claude model choosing the instructed `SendMessage` or performing child work.
Real native-provider continuation, transcript compatibility, and installed app restart remain acceptance work; no ACP worker gate was changed.
