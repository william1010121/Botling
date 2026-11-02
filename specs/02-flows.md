# Architecture Specification: Critical Cross-Boundary Sequences

## 1. Document Context & Purpose

This specification documents the three most critical cross-boundary runtime sequences in **Botling**:
1. **Coordinator/Worker Dispatch-Checkpoint Flow**: Task allocation, process supervision, report settlement, and checkpoint validation across Coordinator, WorkerCore, and Engine processes.
2. **Idle Tidy Memory Consolidation Cycle Flow**: Quiescence detection, memory note maintenance (`memory.md`), and graceful engine process teardown.
3. **Sandbox FrameBroker Permission Approval Gate Flow**: Hardened isolation, origin validation, rate limiting, and out-of-band human authorization for sandboxed iframe components.

---

## 2. Sequence 1: Coordinator/Worker Dispatch-Checkpoint Flow

This flow illustrates how a coordinator bot delegates an asynchronous subagent run, supervises its child process tree, captures its report, and settles the checkpoint under the verified `Worker.tla` protocol.

```mermaid
sequenceDiagram
    autonumber
    actor Coordinator as Coordinator Bot (bot.ts)
    participant WorkerCore as WorkerCore and Ledger (ledger.ts)
    participant EngineAdapter as Engine Adapter (Claude/Codex/ACP)
    participant ProcessTree as Engine Subprocess (CLI/ACP)
    participant DurableStore as Durable Storage (atomic.ts)
    actor Operator as Operator (UI)

    Note over Coordinator,WorkerCore: 1. Task Dispatch and Registration
    Coordinator->>WorkerCore: launch(spec: name, instructions, engine, adapter)
    activate WorkerCore
    WorkerCore->>WorkerCore: Create WorkerLedgerRecord v3 (status: running, op: start, run: 1, rep: none)
    WorkerCore->>DurableStore: writeFileAtomic(worker-ledger.json)
    WorkerCore->>EngineAdapter: spawn(workerRecord)
    activate EngineAdapter

    EngineAdapter->>ProcessTree: exec(engine binary, task arguments)
    activate ProcessTree
    ProcessTree-->>EngineAdapter: PID returned
    EngineAdapter->>WorkerCore: recordProcess(pid, startTime)
    WorkerCore->>DurableStore: Persist processes array (max 8)
    WorkerCore-->>Coordinator: Task Handle (id, run: 1)
    deactivate WorkerCore

    Note over ProcessTree: 2. Task Execution and Streaming
    ProcessTree->>ProcessTree: Execute agent reasoning and tools
    ProcessTree-->>EngineAdapter: Stream chunks, tool output, tokens

    Note over ProcessTree,EngineAdapter: 3. Execution Completion
    ProcessTree->>EngineAdapter: Process exit (code 0) / ACP turnCompleted
    deactivate ProcessTree
    EngineAdapter->>WorkerCore: end(workerId, outcome: done, reportText)
    deactivate EngineAdapter
    activate WorkerCore

    WorkerCore->>WorkerCore: Update record (status: done, rep: pending, tries: 0)
    WorkerCore->>DurableStore: writeFileAtomic(worker-ledger.json)

    alt Policy Ack is none (Claude)
        Note over WorkerCore,Coordinator: Immediate Acknowledgment Policy
        WorkerCore->>Coordinator: deliver(taken, reportText)
        WorkerCore->>WorkerCore: rep: acknowledged, tries: 1
        WorkerCore->>DurableStore: writeFileAtomic(worker-ledger.json)
    else Policy Ack is checkpoint (Codex / Antigravity ACP)
        Note over WorkerCore,Coordinator: Explicit Checkpoint Approval Gate
        WorkerCore->>Coordinator: deliver(queued, reportText)
        WorkerCore->>WorkerCore: rep: dispatching, active: true
        Coordinator->>Operator: Display Worker Result and Evidence Card
        WorkerCore->>WorkerCore: finishReport(completed: true) yields rep: delivered, tries: 1
        WorkerCore->>DurableStore: writeFileAtomic(worker-ledger.json)

        Operator->>Coordinator: Confirm Checkpoint (Approve / Accept)
        Coordinator->>WorkerCore: checkpoint(taskId, outcome: approved, evidence)
        WorkerCore->>WorkerCore: rep: acknowledged, checkpoint recorded
        WorkerCore->>DurableStore: writeFileAtomic(worker-ledger.json)
    end
    deactivate WorkerCore
```

### Key Concurrency Guards
1. **PID Reuse Protection**: The process start time (`processStartTime(pid)`) is paired with every PID in `processes` to prevent signalling or terminating recycled OS PIDs.
2. **Atomic Ledger Updates**: Status mutations are serialized through whole-file atomic writes (`writeFileAtomic`), preventing dirty reads during concurrent engine crashes.
3. **Bounded Delivery**: In checkpoint mode, delivery attempts are strictly limited ($tries < 2$). If the coordinator fails to decide within allowable attempts, `rep` transitions to `"unresolved"`, rendering as a failed card in the UI.

---

## 3. Sequence 2: Idle Tidy Memory Consolidation Cycle Flow

The Idle Tidy cycle periodically consolidates conversational context into durable workspace notes (`memory.md`) before terminating idle engine processes to conserve system resources.

```mermaid
sequenceDiagram
    autonumber
    actor Operator as Human Operator
    participant Bot as Bot Instance (bot.ts)
    participant IdleTimer as Idle Timer (scheduleIdle)
    participant Head as AgentHead Process
    participant Storage as Durable Storage (atomic.ts)

    Operator->>Bot: Final conversational prompt for session
    Bot->>Head: Process turn
    Head-->>Bot: Turn completed
    Bot->>IdleTimer: scheduleIdle()
    activate IdleTimer

    Note over IdleTimer: Awaits options.idleMs (e.g. 5 minutes) without incoming user messages

    IdleTimer->>Bot: Trigger sleep()
    deactivate IdleTimer
    activate Bot

    Note over Bot: Safety Precondition Verification: 1. Head running, 2. No turns, 3. No approvals, 4. No subagents, 5. No background work, 6. No outage

    Bot->>Bot: this.tidying = true; this.updated(); (phase: tidying)

    Note over Bot,Head: Maintenance Turn Execution (Hidden from UI)
    Bot->>Head: internal turn: prompts().tidy (maintenance)
    activate Head
    Head->>Head: Extract key decisions and state from session history
    Head->>Head: Consolidate into 4 canonical sections (max 150 lines)
    Head->>Storage: writeFileAtomic(memory.md, consolidatedNotes)
    Head-->>Bot: Tidy reply: OK
    deactivate Head

    Note over Bot,Head: Graceful Head Teardown
    Bot->>Head: head.finish()
    activate Head

    alt Graceful Exit within 5,000ms
        Head-->>Bot: Process exited
        deactivate Head
    else Exit Timeout
        Bot->>Head: head.terminate(1000) [SIGKILL Process Group]
        deactivate Head
    end

    Bot->>Bot: this.tidying = false; this.updated(); (phase: asleep)
    deactivate Bot

    opt Subsequent User Interaction
        Operator->>Bot: New message arrives
        Bot->>Bot: next(): Spawns fresh AgentHead with updated memory.md
    end
```

### Invariants & Failure Handling
- **Non-interruption of In-Flight Work**: If subagents, monitored background commands, or network outages are detected when the timer fires, `sleep()` immediately aborts and re-arms `scheduleIdle()`.
- **Strict Turn Isolation**: The maintenance turn uses `origin: "tidy"`, suppressing chat chip emissions, whiteboard turn indicators, and audio alerts.
- **Tidy Timeout Boundary**: Tidy runs are bound by `options.tidyTimeoutMs` (default: 5 minutes). If an engine hangs during consolidation, the turn is cancelled with `"stopped"` and the head process is killed.

---

## 4. Sequence 3: Sandbox FrameBroker Permission Approval Gate Flow

Interactive cards and third-party plugin panels execute within sandboxed iframes. Untrusted frames are strictly forbidden from initiating privileged commands directly; all requests must traverse the `FrameBroker` gate and the outer `ApprovalSheet` modal.

```mermaid
sequenceDiagram
    autonumber
    participant Frame as Sandboxed Iframe (origin: null)
    participant FrameBroker as FrameBroker (frame-broker.ts)
    participant CardBroker as CardBroker (broker.ts)
    participant Preload as Preload Bridge (contextBridge)
    actor Operator as Human Operator
    participant ApprovalSheet as ApprovalSheet (UI Modal)
    participant CoreServer as Core Daemon (desktop/src/core/)

    Frame->>FrameBroker: postMessage(ccb: action, name: run, value: cmd)
    activate FrameBroker

    Note over FrameBroker: Security Gate 1: Source and Origin Checks
    FrameBroker->>FrameBroker: Verify event.source matches registered FrameTarget
    FrameBroker->>FrameBroker: Assert event.origin === null (opaque sandboxed origin)

    Note over FrameBroker: Security Gate 2: Token Bucket Rate Limiting
    FrameBroker->>FrameBroker: allow(target)? (Burst: 20 tokens, Rate: 10 tokens/sec)

    alt Rate Limit Exceeded or Invalid Origin
        FrameBroker->>FrameBroker: refuse(reason, target)
        FrameBroker-->>Frame: postMessage(ccb: reply, ok: false, error: Refused)
    else Security Checks Passed
        FrameBroker->>CardBroker: receive(target, data)
        deactivate FrameBroker
        activate CardBroker

        Note over CardBroker: Security Gate 3: Schema Validation
        CardBroker->>CardBroker: CardMessage.safeParse(data) (Strips/refuses unauthorized approve flags)
        CardBroker->>Preload: postCommand(component.command, payload)
        deactivate CardBroker
        activate Preload

        Preload->>CoreServer: IPC command: component.command
        activate CoreServer

        Note over CoreServer: Permission Policy Check
        CoreServer->>CoreServer: Check permission whitelist and engine bypass flags

        alt Command Requires Human Approval
            CoreServer-->>Preload: Response: needsApproval (ApprovalAskView)
            deactivate CoreServer
            Preload-->>ApprovalSheet: Mount Modal with certified command, folder, detail
            activate ApprovalSheet

            Note over ApprovalSheet,Operator: Out-of-Band Modal Presentation
            ApprovalSheet->>Operator: Display Approval Sheet (Command details, cwd, risks)
            Operator->>ApprovalSheet: Click "Allow and run"

            Note over ApprovalSheet: Security Invariant: Uses Core-certified values, never unverified frame payloads
            ApprovalSheet->>Preload: postCommand(component.approve, certifiedPayload)
            deactivate ApprovalSheet
            activate Preload

            Preload->>CoreServer: IPC command: component.approve
            activate CoreServer
            CoreServer->>CoreServer: Execute command in tracked process group
            CoreServer-->>Preload: Execution Result
            deactivate CoreServer
        else Pre-approved or Whitelisted
            CoreServer->>CoreServer: Execute command
            CoreServer-->>Preload: Execution Result
        end

        Preload-->>CardBroker: Result
        deactivate Preload
        activate CardBroker
        CardBroker-->>Frame: postMessage(ccb: reply, ok: true, value: result)
        deactivate CardBroker
    end
```

### Security Architecture Invariants
1. **Opaque Origin Enforcement**: Any `MessageEvent` where `event.origin !== "null"` is immediately rejected. This ensures frames cannot impersonate the host or access local storage/cookies.
2. **Source Identity Pinning**: Messages are authenticated strictly by comparing `event.source` with the target iframe's `contentWindow` recorded during registration. No payload-supplied identity is trusted.
3. **Non-bypassable Approval UI**: The `ApprovalSheet` is rendered by the top-level application shell outside the iframe's DOM tree. A sandboxed card cannot synthetically click or dismiss the approval dialog.
4. **Certified Escalation Arguments**: When `cardApprove` issues `component.approve`, it reads arguments exclusively from the `ApprovalAskView` emitted by the Core server, ignoring any parameters sent by the requesting iframe.
