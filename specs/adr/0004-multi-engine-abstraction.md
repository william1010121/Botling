# ADR 0004: Unified Multi-Engine Abstraction (Claude, Codex, Antigravity)

## Status
- **Status**: Accepted
- **Decided Date**: 2026-11-02 (Design approved in `design-20261102/provider-layer.md`; contract suites merged in `37da800d` and `8eb88adc`)
- **Deciders**: Project Lead & Botling Architecture Team

---

## Context
Botling coordinates three distinct foundational AI execution engines:
1. **Anthropic Claude Code CLI**: Node.js CLI driven via stdio process piping and in-process Model Context Protocol (MCP) server endpoints.
2. **OpenAI Codex**: Headless `app-server` communicating via bidirectional JSON-RPC (`thread/start`, dynamic function calling, `turn/steer`).
3. **Google DeepMind Antigravity**: Agent Client Protocol (ACP) server with structured tool bridges.

Historically, each engine was implemented as an independent vertical silo (`core/agent/head.ts` + `claude-workers.ts`, `core/agent/codex.ts`, and `core/agent/agy-acp.ts` + `agy-workers.ts`). This triplicate implementation created severe architectural instability:

1. **Bug Recurrence and Synchronization Overhead**:
   A bug fixed in one engine's stream parser or worker lifecycle had to be manually re-diagnosed and patched in the other two engines. Identical bugs (such as empty reply bubble handling, tool failure classification, or premature turn completion) were repeatedly fixed three separate times.

2. **Divergent Coordinator-Worker Tooling**:
   Coordinator tools (`app_handoff`, `app_send_message`, `app_cancel_task`, `app_task_checkpoint`, `app_routines`) were defined separately in three locations with slight variations in parameter naming, schema descriptions, and error handling.

3. **Codex Thread Invalidation Fragility**:
   In Codex, dynamic tools provided during `thread/start` determine `MANAGED_TOOL_SIGNATURE`. Any arbitrary or unplanned change to tool wording or schema parameters invalidated existing active coordinator threads, triggering unintended and disruptive thread restarts.

4. **Fragmented Skill Integration**:
   Capabilities such as `SKILL.md` definitions could only be loaded natively by engines supporting specific CLI arguments, leaving other engines unable to share project-level skills.

---

## Decision
We establish a **Unified Provider Abstraction Layer** that centralizes common domain logic (state machines, tool registries, accounting, report delivery) while reducing individual engines to thin transport adapters:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Centralized Shared Core                         │
│  - WorkerCore State Machine & Operation Lock                           │
│  - Single Truth Ledger (worker-ledger.json v3)                         │
│  - AppToolsRegistry (Single authoritative tool definitions)            │
│  - Unified Token Accounting & classifyRun Settlement                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
       ┌────────────────────────────┼────────────────────────────┐
       ▼                            ▼                            ▼
┌──────────────┐             ┌──────────────┐             ┌──────────────┐
│ ClaudeAdapter│             │ CodexAdapter │             │  AgyAdapter  │
│  - Stdio CLI │             │  - JSON-RPC  │             │  - ACP RPC   │
│  - In-proc   │             │  - dynamic   │             │  - Agy MCP   │
│    appMcp    │             │    Tools     │             │    Bridge    │
└──────┬───────┘             └──────┬───────┘             └──────┬───────┘
       │                            │                            │
       ▼                            ▼                            ▼
  Claude Code                  OpenAI Codex                 Antigravity
    CLI Proc                    app-server                   ACP Engine
```

### 1. Single App Tools Registry (`desktop/src/core/app-tools/registry.ts`)
- **Authoritative Definition**:
  All coordinator and worker tools (`app_handoff`, `app_send_message`, `app_cancel_task`, `app_task_checkpoint`, `app_reconcile_report`, `app_routines`, `app_monitor_*`) are defined once with standardized parameter validators and schemas.
- **Multi-Format Rendering**:
  The registry dynamically generates:
  - `McpTool` schemas for Claude's in-process `appMcp` and Antigravity's `AgyMcpBridge`.
  - `CodexDynamicTool` schemas for Codex's `thread/start`.
- **Golden Byte-Level Protection**:
  To guarantee that `MANAGED_TOOL_SIGNATURE` is never inadvertently mutated, dynamic Codex tool output is locked against a golden fixture (`desktop/test/fixtures/app-tools/codex.json`). Any schema modification must be deliberately planned and coordinated.

### 2. Thin Engine Adapters (`WorkerAdapter` & `HeadSession`)
- Individual engines are stripped of state machine logic, token accounting, and retry policies.
- An engine adapter is strictly responsible for:
  - Spawning the child process or connecting to the daemon socket.
  - Translating raw CLI chunks or JSON-RPC notifications into normalized events (`WorkerEvent` and `StreamItem`).
  - Handling cancellation signals (SIGINT, SIGKILL, `thread/stop`).
  - Providing confirmed process exit verification (`ManagedProcess.gone/endTree`).

### 3. Capability Negotiation (`ProviderCapabilities`)
Features and integration points are negotiated through an explicit capability matrix:
- **Skills (`SkillCatalog`)**:
  Claude and Codex workers consume skills natively via folder flags; Codex coordinator and Antigravity lack native flags and instead receive a synthetic, read-only `app_skill` tool pointing to the common `SKILL.md` repository catalog.
- **Token Accounting**:
  Unified token consumption calculates prompt, completion, cache-read, and cache-write tokens into a standardized billing summary regardless of underlying engine metrics.

### 4. Shared Contract-Driven Conformance Suites
To prevent regressions across engines, all three adapters are validated against identical behavioral contract test suites:
- `worker-core-contract.test.ts`: Runs workers against real recorded execution streams, verifying transition validity.
- `head-stream.test.ts`: Tests Claude, Codex, and Antigravity heads across identical scenario streams (turn completion, failed tools, steering, interrupts, permission requests, and exit).
- **Fault Injection Switches**: Test harnesses include deliberate failure switches (`WORKER_CONTRACT_BUG`, `HEAD_CONTRACT_BUG`) that must reliably fail tests when injected, proving the contract assertions are non-vacuous.

---

## Consequences

### Positive
- **Elimination of Triple Maintenance**: Fixing a bug or adding a new system feature (such as worker limit settings or routine cron execution) is implemented once in `WorkerCore` or `AppToolsRegistry`.
- **Zero Semantic Drift**: All three engines adhere to identical run classification rules, report handoff guarantees, and status vocabularies.
- **Predictable Codex Stability**: Strict signature locking prevents accidental thread restarts while allowing clean tool evolution.

### Negative & Trade-offs
- **Adapter Indirection**: Slight abstraction layer overhead; engine-specific unique features must either be abstracted into the capability model or exposed via typed `engineData` payloads.
- **Schema Rigidity**: Updating tool definitions requires ensuring compatibility across both MCP and OpenAI function-calling schema constraints simultaneously.

### Considered Alternatives
- **Maintain Separate Silos (Historical Approach)**:
  - *Description*: Retaining bespoke implementations in `claude-workers.ts`, `codex.ts`, and `agy-workers.ts`.
  - *Rejection Reason*: Unacceptable operational cost. Historical git analysis showed 40%+ of developer time was spent re-fixing identical bugs across multiple engines.
- **Universal External Proxy / Lowest-Common-Denominator Gateway**:
  - *Description*: Routing all engine communications through an external proxy that maps everything to OpenAI REST API format.
  - *Rejection Reason*: Destroys native advanced capabilities, such as Anthropic prompt caching, local ACP state machine integration, and Codex persistent thread context.
