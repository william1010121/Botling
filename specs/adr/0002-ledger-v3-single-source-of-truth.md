# ADR 0002: Ledger v3 as the Single Source of Truth for Worker State

## Status
- **Status**: Accepted
- **Decided Date**: 2026-11-01 (Design finalized in `shared-core-spec.md`; formally verified in `Worker.tla` on 2026-11-02)
- **Deciders**: Project Lead & Botling Architecture Team

---

## Context
In previous revisions of Botling (v1.x through early v2.3), worker lifecycle state, task ownership, and completion reporting were fragmented across multiple mutable storage locations:
- `subagents.json` on disk,
- `agents.json` on disk,
- `tasks.json` on disk,
- Independent in-memory tracking structures inside each engine (`ClaudeWorkers`, `CodexHead`, and `AgyWorkers`).

This fragmented, multi-writer design led to critical operational anomalies:

1. **State Divergence & Status Flip-Flops**:
   Different subsystems maintained competing vocabularies (e.g. `cleanup-failed` in Antigravity, `killed` in Codex, `reportPending` in WorkerInfo, and `busy`/`completed`/`failed` in UI chips). A worker could be recorded as `done` in the engine memory while remaining `running` in `subagents.json`, or prematurely marked `failed` while its report was still in transit.

2. **Race Conditions & Lost Updates**:
   Concurrent async operations (e.g. stopping an active run while launching a follow-up, or receiving an out-of-order CLI exit signal while writing a checkpoint) wrote directly to separate JSON files without locking. Unserialized file overwrites caused silent record corruption, truncated histories, and dangling process trees.

3. **Inability to Formally Verify Transitions**:
   Because state transitions were scattered across hundreds of lines of glue code in three distinct engines, edge cases (such as app restart during report dispatch or SIGKILL timeouts) could not be mathematically modeled or exhaustively verified.

---

## Decision
We establish **`worker-ledger.json` (Format Version 3)** as the **absolute single source of truth** for all background worker execution state, governed exclusively by a centralized state machine (`desktop/src/core/worker-core/`):

### 1. Single Writer & Canonical Ledger Model
- **Single File Ownership**:
  Each bot member maintains exactly one authoritative ledger file on disk: `<member store>/worker-ledger.json` (the primary coordinator head uses `profile.storeDir/worker-ledger.json`; partner engines use `profile.storeDir/partner-<engine>/worker-ledger.json`). There is strictly one writer process per ledger.
- **Atomic Persistence**:
  The ledger is written exclusively via atomic file replacement (`writeFileAtomic`). Writes occur only upon discrete state transitions (run launch, state transition, report handoff, process confirmation, cleanup settlement); high-frequency token streams and deltas are never written to the ledger.
- **Bounded Bounded History**:
  The ledger retains a sliding window of up to 200 historical records, garbage-collecting only terminal, fully settled records with no active child processes.

### 2. Strict State & Report Lifecycle Vocabulary
All legacy transient statuses are consolidated into a standardized, orthogonal type system (`worker-core/status.ts`):

```ts
/** Canonical primary worker execution status */
export type WorkerStatus =
  | "new"          // Registered, pending startup
  | "running"      // Child process active, executing turns
  | "done"         // Turn ended normally with valid output
  | "failed"       // Process crashed or terminated with error
  | "stopped"      // Explicitly cancelled by coordinator or user
  | "interrupted"; // Terminated by application quit, restart, or crash

/** Orthogonal coordinator report delivery lifecycle */
export type ReportState =
  | "none"         // No report owed (running or cancelled before execution)
  | "pending"      // Run ended; waiting for coordinator turn to claim report
  | "dispatching"  // In transit to coordinator
  | "delivered"    // Received by coordinator; awaiting decision/checkpoint
  | "acknowledged" // Closed out; report settled
  | "unresolved"   // Checkpoint failed or expired without resolution
  | "routed";      // Routed to an external owning bot
```

Anomalous states (such as process cleanup failure or crash during execution) are modeled as explicit structural fields rather than primary statuses:
- `recovery: "required"` (forces process verification before any follow-up run can start),
- `cleanup: "pending" | "failed"` (records child process termination state),
- `interruptedBy: "quit" | "restart" | "crash"` (identifies root cause of interruption).

### 3. Read-Only Functional Projections
- External files (`subagents.json`, `agents.json`) and UI state models are strictly **read-only functional projections**:
  ```ts
  subagents = projectSubagents(ledger.records);
  agents = projectAgents(ledger.records);
  uiChips = projectWorkerChips(ledger.records);
  ```
- No component is permitted to mutate `subagents.json` or `agents.json` directly.

### 4. Per-Worker Single Operation Locking
`WorkerCore` executes every mutation on a worker (start, steer, stop, cancel, cleanup, recovery) sequentially under an exclusive per-worker lock:
- Any concurrent follow-up while an operation is pending is rejected with `busy`.
- Stale queued operations bind to their target run index; if a run completes or is superseded before a queued operation acquires the lock, it is immediately discarded as stale (`NoStaleOp`).

### 5. Formal Verification with TLA+
The state machine is formally modeled in TLA+ (`spec/models/worker/Worker.tla`) and verified using the TLC model checker across 30,000+ distinct states, proving four core safety invariants and liveness under weak fairness:
- `OneLiveRun`: At most one active process per worker.
- `NoFalseFailed`: A successful turn with content is never misclassified as failed.
- `NoStaleOp`: Superseded operations never execute against newer runs.
- `ReportAtMostOnce`: Reports are never duplicated or lost during restarts.

---

## Consequences

### Positive
- **Deterministic State Consistency**: Eliminates all status flip-flops and out-of-sync race conditions between backend processes and UI visual indicators.
- **Resilient Crash Recovery**: On app launch or restart, any uncompleted run in `worker-ledger.json` is cleanly transitioned to `interrupted` with `recovery: "required"`, ensuring old zombie processes are killed before new runs spawn.
- **Formal Verification Guarantees**: Proved mathematically in TLA+ and validated in CI against real CLI stream recordings.

### Negative & Trade-offs
- **Migration & Adapter Refactoring**: Required updating all engine-specific workers (`ClaudeWorkers`, `CodexHead`, `AgyWorkers`) to operate as passive adapters feeding `WorkerCore` rather than managing their own independent states.
- **Bounded Retention Limit**: Retaining only 200 records means long-lived sessions prune ancient completed workers, requiring persistent archiving for historical audits.

### Considered Alternatives
- **Relational / SQLite Database**:
  - *Description*: Storing worker state in an embedded SQLite database (`worker.db`).
  - *Rejection Reason*: Unnecessary binary dependency, not easily inspectable or diffable in Git worktrees, and complicates manual debugging compared to human-readable JSON.
- **Full Event Sourcing (Event Store with Replay)**:
  - *Description*: Storing an append-only sequence of fine-grained events without snapshot ledgers.
  - *Rejection Reason*: Excessive architectural overhead for a desktop application. Snapshotting canonical records with an atomic ledger provides equal reliability with significantly lower code complexity.
