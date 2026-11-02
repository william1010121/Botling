# ADR 004: File-First Memory and Session Warm Cache Architecture

## Status
- **Status**: Accepted
- **Decided Date**: 2026-11-02 (Formally verified in `specs/tla/BotSessionLifecycle.tla`)
- **Deciders**: Project Lead & Botling Architecture Team

---

## Context
Botling operates as an autonomous, multi-agent software engineering assistant across local repositories. In this operating environment, state management faces several competing challenges:

1. **Human Auditability and Git Compatibility**:
   Developers require transparency into what an AI agent remembers, what decisions it made, and what routines are configured. Proprietary cloud databases or opaque binary files (such as SQLite blobs) prevent git-based diffing, branch switching, code review, and manual correction.

2. **Cold Start Latency vs. Turn Performance**:
   Re-reading and parsing repository state, directory trees, routines, and historical notes from disk on every chat turn incurs unacceptable latency ($> 800\text{ms}$ cold start overhead).

3. **Concurrent Multi-Writer Hazards**:
   Multiple background subagents or concurrent application windows operating on the same workspace directory can overwrite memory notes simultaneously, causing file truncation, lost context, or corrupted JSON configurations.

4. **Resource Exhaustion Under Workspace Switching**:
   Developers frequently open and switch between multiple project repositories. Keeping unbounded CLI engine processes and full conversation trees resident in memory leads to memory exhaustion and system beachballing.

---

## Decision
We establish a **File-First Memory Architecture** backed by an in-memory **Session Warm Cache** with single-writer lock protection and formal TLA+ verification:

```
┌────────────────────────────────────────────────────────┐
│             Git-Tracked Local Filesystem               │
│  - .bot/memory.md (4 canonical headings, <= 150 lines) │
│  - .bot/routines/ (Deterministic JSON routines)        │
│  - .bot/inbox/    (Inter-agent async task queues)      │
│  - core.lock      (Exclusive single-writer lock)       │
└───────────────────────────▲────────────────────────────┘
                            │ Atomic File I/O (writeFileAtomic)
                            ▼
┌────────────────────────────────────────────────────────┐
│               Session Warm Cache Layer                 │
│  - Resident BotSessionState & EngineSessionHandle      │
│  - status: "cold" | "warming" | "warm" | "evicting"    │
│  - cacheDirty: boolean (Tracks modified memory notes)  │
│  - LRU eviction bounded by MaxWarmSessions             │
└───────────────────────────▲────────────────────────────┘
                            │ Zero-Latency Turn Dispatch
                            ▼
┌────────────────────────────────────────────────────────┐
│             Live Engine Coordinator Head               │
│  - Claude Code / OpenAI Codex / Antigravity ACP        │
│  - Immediate turn execution without cold-start CLI boot│
└────────────────────────────────────────────────────────┘
```

### 1. File-First Storage Standard (`.bot/memory.md`)
- **Canonical Structure**:
  All long-term project context is preserved in plain markdown with four mandatory headings:
  1. `# Current status`: Current project milestones and operational state.
  2. `# In progress`: Active subagents, ongoing refactors, and incomplete goals.
  3. `# Waiting on you`: Action items, code reviews, and human approval blockers.
  4. `# Decided`: Architectural decisions, technical constraints, and trade-offs.
- **Strict Budget Invariant**:
  `.bot/memory.md` must remain strictly under 150 lines. The background idle tidy routine consolidates notes when this limit is approached.
- **Atomic Persistence**:
  Disk writes utilize whole-file atomic replacement (`writeFileAtomic`) via unique temporary files and atomic POSIX rename, ensuring half-written files are impossible on crash.

### 2. Workspace Single-Writer Data Lock (`core.lock`)
- To prevent split-brain writes and file corruption from multiple running instances, each active workspace requires exclusive ownership of `core.lock`.
- The lock record contains the owning PID and epoch timestamp. Stale locks from crashed instances are safely reclaimed through PID liveness checks.

### 3. Session Warm Cache Lifecycle
The warm cache maintains active session state in memory across four discrete lifecycle states:
- **`cold`**: No session state in memory. Disk files must be parsed before turn execution.
- **`warming`**: Lock acquired. Memory notes (`.bot/memory.md`) and routines are read from disk; live engine session handle is primed.
- **`warm`**: Fully primed. Turn dispatches execute with zero cold-start delay ($< 15\text{ms}$).
- **`evicting`**: Memory pressure or idle timeout triggers cache eviction. If `cacheDirty` is `true`, modified memory notes and checkpoints are atomically flushed to disk before releasing memory and dropping the lock.

### 4. Formal Verification with TLA+ (`specs/tla/BotSessionLifecycle.tla`)
The protocol is formally specified and verified using the TLC model checker across all reachable states:
- **`SingleWriterIntegrity`**: Memory modifications strictly require holding `core.lock`.
- **`CacheConsistency`**: Clean warm cache always matches persisted disk storage.
- **`NoExecutionWhileCold`**: Turns can only execute within a primed, warm session.
- **`NoDirtyDataLost`**: Eviction guarantees dirty state is flushed to disk before returning to cold.
- **`MemoryBudgetBound`**: Number of simultaneously warmed sessions strictly respects `MaxWarmSessions`.

---

## Consequences

### Positive
- **Human Transparency & Version Control**: Developers can inspect, edit, or commit agent memory notes using standard Git tooling.
- **Sub-50ms Turn Latency**: Cached session handles eliminate repetitive CLI process boot overhead during multi-turn chats.
- **Crash Safety**: Atomic writes and dirty-state flushing prevent data corruption across application restarts or hard crashes.
- **Guaranteed Memory Bounds**: LRU eviction bounded by `MaxWarmSessions` prevents unbounded memory growth across multiple workspaces.

### Negative & Trade-offs
- **Line Limit Constraints**: 150-line memory budget forces regular consolidation and pruning of older details.
- **Lock Contention**: Opening the same project in multiple windows results in read-only access for secondary windows until the primary window releases the lock.

### Considered Alternatives
- **Embedded SQLite / DuckDB Database**:
  - *Description*: Storing session history and memory notes in a local SQL database file.
  - *Rejection Reason*: Cannot be diffed, merged, or reviewed cleanly in git commits or pull requests; violates the file-first principle.
- **Stateless Cold-Start Architecture**:
  - *Description*: Re-spawning CLI processes and reading all files on every single user prompt.
  - *Rejection Reason*: Unacceptable interactive latency (1–3 seconds overhead per turn).
