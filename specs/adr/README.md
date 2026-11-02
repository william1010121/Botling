# Architecture Decision Records (ADR)

This directory documents the foundational architectural decisions for **Botling 2**. Each record captures the business and technical context, forces, explicit architectural decisions, trade-offs, and rejected alternatives for critical system boundaries.

## ADR Index

| ADR ID | Title | Status | Date | Primary Component | Verified Contract / Spec |
|---|---|---|---|---|---|
| [ADR-001](001-three-process-electron-topology.md) | Three-Process Electron Topology (Main, Core Daemon UtilityProcess, Sandboxed Renderer) | Accepted | 2026-10-25 | Electron Main, Core, Renderer | Process supervision & PTY boundary |
| [ADR-002](002-multi-engine-head-and-worker-unification.md) | Multi-Engine Head and Worker Unification (Claude Code, OpenAI Codex, Google Antigravity ACP) | Accepted | 2026-11-02 | `desktop/src/core/app-tools/`, `agent/` | Contract suite & dynamic tool golden |
| [ADR-003](003-sandboxed-plugin-and-card-frames.md) | Sandboxed Plugin and Card Frames (Zero-Trust FrameBroker and Top-Level ApprovalSheet) | Accepted | 2026-10-30 | `desktop/src/renderer/`, `Web/` | FrameBroker rate & command isolation |
| [ADR-004](004-file-first-memory-and-session-warm-cache.md) | File-First Memory and Session Warm Cache Architecture | Accepted | 2026-11-02 | `desktop/src/core/session/`, `.bot/` | `specs/tla/BotSessionLifecycle.tla` |

---

## Architectural Decision Framework

The project follows the Michael Nygard / MADR standard for architectural decision recording:
- **Title & Metadata**: Descriptive numbering and explicit status tracking.
- **Context & Forces**: The historical problem, constraints, observed production failures, and driving factors.
- **Decision**: The chosen technical architecture, interface contracts, state machines, and system boundaries.
- **Consequences**:
  - Positive outcomes (improvements, safety invariants, decoupling).
  - Trade-offs, overheads, and potential limitations.
  - Rejected alternatives with concrete rationale for rejection.

## Relationship to Specifications & Verification

- **System Context & Container Topology**: Detailed in `specs/00-overview.md`.
- **Data Schemas & State Invariants**: Detailed in `specs/01-data-and-state.md`.
- **Cross-Boundary Execution Flows**: Detailed in `specs/02-flows.md`.
- **Formal Verification**: Where state machines involve concurrent operations, race conditions, or process recoveries, state transition models are checked via TLA+ under `specs/tla/` and `spec/models/`.
