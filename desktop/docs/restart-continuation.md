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

- Claude resumes the original session with `--resume`. Native child-agent execution has no independently verified recovery contract and stays paused.
- Codex resumes the mapped coordinator thread. Interrupted coordinator turns and managed workers first read their original thread and reconcile the recorded turn.
  A completed worker reports existing evidence without rerunning. A confirmed interrupted turn with no unresolved tool items resumes the same task/run/thread.
  Missing turns, incomplete tool outcomes, report-delivery uncertainty, and component-editor children stay paused.
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
