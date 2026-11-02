# Architecture Specification: Data Models, State Machines & Formal Verification

## 1. Document Context & Purpose

This specification defines the core data contracts, state machines, invariants, and formal verification models of **Botling**. Specifically, it covers:
1. **`WorkerLedgerRecord` v3**: The canonical durable record for all background and delegated AI worker tasks.
2. **State Projections**: The deterministic mapping functions from core ledger state to UI and subsystem views.
3. **Formal Verification Models (TLA+)**:
   - `Worker.tla`: Concurrency, lifecycle, cancellation, and report handoff invariants.
   - `Restart.tla`: Crash resilience, shutdown continuation journaling, and at-most-once recovery semantics.

---

## 2. Canonical Worker Data Model: `WorkerLedgerRecord` v3

Worker state in Botling is unified under a single source of truth: `<member store>/worker-ledger.json` (`desktop/src/core/worker-core/ledger.ts`). It is written exclusively by `WorkerCore` at state transition boundaries (launch, end, report settlement, owner change, crash recovery) using atomic file writes (`writeFileAtomic`).

```typescript
export interface WorkerLedgerRecord {
  v: 3;
  id: string;                                   // Task UUID
  engine: "claude" | "codex" | "agy";          // Engine runtime
  adapter: "claude-process" | "codex-thread" | "agy-acp" | "component-editor";
  name: string;                                 // Worker label
  instructions: string;                         // Initial prompt instructions
  type: string | null;                          // Subagent classification type
  ownerSessionId: string;                       // Coordinator session ID
  run: number;                                  // Monotonically increasing run count
  segment?: number;                             // Post-restart run segment counter
  status: WorkerStatus;                         // Core status
  report: WorkerReportRecord;                   // Delivery & checkpoint status
  conversationId: string | null;                // Engine-level session/thread handle
  processes: ProcessIdentity[];                 // Tracked PIDs (max 8, sorted oldest to newest)
  owner?: WorkerOwner;                          // Associated owner metadata
  createdAt: number;                            // Creation epoch timestamp
  runStartedAt: number | null;                  // Active run start timestamp
  endedAt: number | null;                       // Termination timestamp
  interruptedBy?: "quit" | "restart" | "crash"; // Reason for interruption
  recovery?: "required";                        // Indicates orphaned process verification needed
  cleanup?: "pending" | "failed";               // Asynchronous process tree cleanup status
  engineData: Record<string, unknown>;          // Engine-private opaque state
}

export interface WorkerReportRecord {
  state: ReportState;                           // Report delivery state
  text: string | null;                          // Final report prose
  status: RunStatus | null;                     // Terminal run outcome
  attempts: number;                             // Delivery attempts to coordinator
  checkpoint?: ReportCheckpoint;                // Checkpoint outcome & evidence
}

export interface ReportCheckpoint {
  outcome: string;                              // Outcome disposition (e.g. accepted, rejected)
  evidence: string;                             // Supporting evidence string
  dependencyTaskId?: string;                    // Associated dependency task ID
}
```

---

## 3. Worker State Vocabulary & Status Projections

The tuple `(status, report.state, cleanup)` uniquely defines the worker state. All external views (`WorkerInfo.state`, `subagents.json`, `agents.json`, and the chat chip) are pure projections (`desktop/src/core/worker-core/status.ts`).

### 3.1 Vocabulary Definitions

| Type | Allowed Values | Semantic Meaning |
|---|---|---|
| `WorkerStatus` | `new` | Initialized record; has never launched a process. |
| | `running` | Child process or engine thread is actively executing. |
| | `done` | Engine exited successfully with a completed result. |
| | `failed` | Engine exited with an error, exception, or non-zero code. |
| | `stopped` | Explicitly aborted by user or coordinator stop command. |
| | `interrupted` | Abnormally terminated by host restart, crash, or SIGKILL. |
| `ReportState` | `none` | No report is owed (while running, stopped, or new). |
| | `pending` | Run ended; report is waiting for coordinator pickup. |
| | `dispatching` | Report is being transferred (e.g. Antigravity `beginReport`). |
| | `delivered` | Coordinator received report; awaiting checkpoint decision. |
| | `acknowledged` | Fully settled (policy `none` at delivery; policy `checkpoint` after review). |
| | `unresolved` | Coordinator exceeded max delivery attempts without deciding. |
| | `routed` | Ownership transferred to another bot; report emitted for routing. |

### 3.2 Projection Matrix

```mermaid
flowchart LR
    LedgerState["Ledger Record<br/>(status, report.state, cleanup)"]

    LedgerState -->|"workerState()"| WorkerInfoState["WorkerInfo.state<br/>('idle' | 'running' | 'reportPending' | 'failed' | 'stopped' | 'interrupted')"]
    LedgerState -->|"subagentStatus()"| SubagentRowState["subagents.json<br/>('running' | 'completed' | 'failed' | 'stopped')"]
    LedgerState -->|"agentState()"| AgentJsonState["agents.json<br/>('idle' | 'running' | 'reportPending' | 'completed' | 'failed' | 'stopped' | 'interrupted')"]
    LedgerState -->|"chipStatus()"| ChatChipState["Chat Chip<br/>('running' | 'completed' | 'failed' | 'interrupted' | 'killed')"]
```

#### Exact Projection Formulas
- **`showsFailed(r)`**:
  $$\text{cleanup} = \text{"failed"} \lor (\text{report.state} = \text{"unresolved"} \land \text{status} \in \{\text{"done"}, \text{"failed"}\})$$
- **`reportOwed(state)`**:
  $$\text{state} \in \{\text{"pending"}, \text{"dispatching"}, \text{"delivered"}\}$$
- **Chat Chip (`chipStatus`)**:
  1. If `showsFailed(r)` $\to$ `failed`
  2. If `status == "running"` $\to$ `running`
  3. If `status == "done"` $\to$ `completed`
  4. If `status == "failed"` $\to$ `failed`
  5. If `status == "interrupted"` $\to$ `interrupted`
  6. Otherwise (`stopped`, `new`) $\to$ `killed`

---

## 4. State Machine Specifications

### 4.1 Worker Lifecycle State Machine

```mermaid
stateDiagram-v2
    [*] --> New: Initial Registration

    New --> Running: Handoff or Launch
    Running --> Done: End (success)
    Running --> Failed: End (error or exit code)
    Running --> Stopped: StopWorker or Cancel
    Running --> Interrupted: App Crash or Host Restart

    Done --> Running: Send (Follow-up run)
    Failed --> Running: Send (Follow-up run)
    Stopped --> Running: Send (Recovered and not pending cleanup)
    Interrupted --> Running: Send (After process recovery confirmed)

    state Stopped {
        [*] --> CleanupPending
        CleanupPending --> CleanupDone: Process tree gone
        CleanupPending --> CleanupFailed: SIGKILL timeout or PID alive
    }

    state Interrupted {
        [*] --> RecoveryRequired
        RecoveryRequired --> RecoveryConfirmed: Stale PID verification
    }
```

### 4.2 Worker Report Delivery State Machine

The report delivery lifecycle manages handover from the worker to the coordinator conversation. Delivery adheres to one of two policies:
- **`Ack = "none"` (Claude)**: Immediate acknowledgment upon single delivery.
- **`Ack = "checkpoint"` (Codex, Antigravity)**: Coordinator must review evidence and emit an explicit checkpoint (`app_task_checkpoint`) within at most 2 delivery attempts.

```mermaid
stateDiagram-v2
    [*] --> None: Worker Running or Stopped
    None --> Pending: Run Ends (done or failed)

    Pending --> Routed: Bot Ownership Transferred (SetOwner)
    Pending --> Acknowledged: Deliver taken (Ack is none)

    Pending --> Dispatching: BeginReport (port queues turn)
    Dispatching --> Delivered: FinishReport (turn completed)
    Dispatching --> Pending: RetryUncertain (crash or timeout, tries < 2)
    Dispatching --> Unresolved: RetryUncertain (tries >= 2)
    Delivered --> Acknowledged: Checkpoint (Coordinator approval)
    Delivered --> Unresolved: Delivery timeout (max tries exceeded)

    Acknowledged --> [*]
    Unresolved --> [*]
    Routed --> [*]
```

---

## 5. Formal Verification with TLA+

Botling's core distributed concurrency protocols are formally specified and verified using TLA+ model checking (TLC).

### 5.1 Worker Lifecycle Protocol (`Worker.tla`)

- **Specification Location**: `spec/models/worker/Worker.tla`
- **Config**: `spec/models/worker/Worker.cfg`
- **Driver / Conformance Test**: `spec/driver/worker-driver.ts`, `spec/tests/worker.spec.test.ts`
- **Real-world Component**: `desktop/src/core/worker-core/core.ts`

#### Model State Variables
- `wk`: Function mapping each worker slot $x \in Workers$ to its record:
  - `status`, `run`, `rep`, `tries`, `queued`, `active`, `cleanup`, `recovery`, `stale`, `op`, `pend`, `owned`.
- `crashes`: Bounded counter ($0 \dots MaxCrash$) of host crash events.

#### Verified Safety Invariants

| Invariant Name | Mathematical Formula | Architectural Guarantee |
|---|---|---|
| **`OneLiveRun`** | $\forall x: wk[x].status = \text{"running"} \implies \neg wk[x].stale$ | No worker starts a new run while a previous process of that worker is still active. |
| **`StaleIsGuarded`**| $\forall x: wk[x].stale \implies (wk[x].recovery \lor wk[x].cleanup = \text{"pending"})$ | Any unconfirmed/stale process forces a cleanup barrier or recovery check before further execution. |
| **`OwedOnlyEnded`** | $\forall x: wk[x].rep \in \{\text{"pending"}, \text{"dispatching"}, \text{"delivered"}\} \implies wk[x].status \in \{\text{"done"}, \text{"failed"}\}$ | Reports are only generated and owed for terminated runs. |
| **`NoFalseFailed`** | $\forall x: wk[x].status = \text{"done"} \land Chip(wk[x]) \neq \text{"completed"} \implies (wk[x].cleanup = \text{"failed"} \lor wk[x].rep = \text{"unresolved"})$ | A successfully completed run never displays as failed in the UI unless its cleanup failed or report was unresolved. |
| **`OneTerminal`** | $[][\forall x: wk[x].status \in Ended \land wk'[x].run = wk[x].run \implies wk'[x].status = wk[x].status]_{vars}$ | A run's terminal status (`done`, `failed`, `stopped`, `interrupted`) is immutable for that run index. |
| **`NoStaleOp`** | Enforces that an asynchronous cancel/stop requested for run $R$ never cancels a subsequent run $R+1$. | Eliminates the critical race condition patched in commit `3910341f`. |
| **`ReportAtMostOnce`**| Enforces delivery limit ($tries < MaxShows$) and verifies reports are never presented after ownership handover. | Prevents duplicate report turns or cross-bot leakages. |

#### Verified Liveness Properties
- **`RunEnds`**: $\forall x: wk[x].status = \text{"running"} \leadsto wk[x].status \in Ended$ (Under weak fairness, any running worker eventually reaches a terminal state).
- **`ReportSettles`**: $\forall x: wk[x].rep = \text{"pending"} \leadsto wk[x].rep \in \{\text{"delivered"}, \text{"acknowledged"}, \text{"unresolved"}, \text{"routed"}, \text{"none"}\}$ (Every pending report eventually settles).

---

### 5.2 Restart Continuation Protocol (`Restart.tla`)

- **Specification Location**: `spec/models/restart/Restart.tla`
- **Config**: `spec/models/restart/Restart.cfg`
- **Driver / Conformance Test**: `spec/driver/restart-driver.ts`, `spec/tests/restart.spec.test.ts`
- **Real-world Component**: `desktop/src/core/restart-continuation.ts`, `Core.prepareRestart`

#### Protocol Mechanics
When the app initiates a restart or experiences a crash, tasks in flight must be either safely resumed or held back with an explicit user notice.

```mermaid
flowchart TD
    subgraph OldInstance["Old App Instance (Shutdown)"]
        Prepare["Prepare Restart<br/>(phase = preparing)"]
        Snapshot["Snapshot In-Flight Bots<br/>(entry = pending)"]
        BeginShutdown["Begin Participant Shutdown<br/>(Bots + PluginHost)"]
        Settle["Wait for Participants to Settle<br/>(ok | failed)"]
        Ready["Ready Journal<br/>(phase = ready)"]
    end

    subgraph CrashOrExit["Process Boundary / Potential Crash"]
        DiskJournal[("Durable Journal File<br/>restart-journal.json")]
    end

    subgraph NewInstance["New App Instance (Recovery on Boot)"]
        Boot["Boot & Read Journal"]
        CheckReason{"Evaluate Reason(b)"}
        Claim["Claim Entry<br/>(mine = true)"]
        Deliver["Deliver Continuation<br/>(sent += 1)"]
        Dispatch["Dispatch to Engine<br/>(entry = dispatched)"]
        Block["Block Entry & Notify<br/>(told = reason, entry = blocked)"]
    end

    Prepare --> Snapshot
    Snapshot --> BeginShutdown
    BeginShutdown --> Settle
    Settle --> Ready
    Ready --> DiskJournal
    BeginShutdown -.->|"Crash during shutdown"| DiskJournal
    DiskJournal --> Boot
    Boot --> CheckReason
    CheckReason -->|"Reason is none"| Claim
    Claim --> Deliver
    Deliver --> Dispatch
    CheckReason -->|"Reason is not none"| Block
```

#### Verified Invariants in `Restart.tla`

1. **`AtMostOnce`**:
   $$\forall b \in Bots: sent[b] \le 1$$
   No bot continuation is ever delivered more than once across arbitrary crashes and restarts.
2. **`OnlyRealWork`**:
   $$\forall b \in Bots: sent[b] > 0 \implies (busy[b] \land \neg own[b] \land stop[b] = \text{"ok"})$$
   A bot only resumes if it actually had work in flight, had no internal blocker, and its old instance shut down cleanly.
3. **`ConfirmedOnly`**:
   $$\forall b \in Bots: entry[b] \in \{\text{"claimed"}, \text{"dispatched"}\} \implies phase = \text{"ready"}$$
   No continuation is attempted from an incomplete or unconfirmed journal.
4. **`OthersNeverBlock`**:
   $$\forall b \in Bots: told[b] \neq \text{"none"} \implies Cause(b, told[b])$$
   A failure in one participant (e.g. a plugin host or an unrelated bot) never blocks another cleanly shut down bot.
5. **`BlockedIsTold`**:
   $$\forall b \in Bots: entry[b] = \text{"blocked"} \implies told[b] \neq \text{"none"}$$
   Every held-back task is paired with an explicit reason communicated to the operator.
