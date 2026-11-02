# Architecture Decision Records (ADR)

This directory documents the foundational architectural decisions for **Botling 2**. Each record captures the business and technical context, forces, explicit architectural decisions, trade-offs, and rejected alternatives for critical system boundaries.

## ADR Index

| ADR ID | Title | Status | Date | Primary Component | Verified Contract / Spec |
|---|---|---|---|---|---|
| [ADR-0001](0001-three-process-architecture.md) | Three-Process Architecture (Main, UtilityProcess, Sandboxed Renderer) | Accepted | 2026-10-25 | Electron Main, Core, Renderer | Process supervision & PTY boundary |
| [ADR-0002](0002-ledger-v3-single-source-of-truth.md) | Ledger v3 as the Single Source of Truth for Worker State | Accepted | 2026-11-01 | `desktop/src/core/worker-core/` | `spec/models/worker/Worker.tla` |
| [ADR-0003](0003-sandbox-frame-broker-and-approval-sheet.md) | Zero-Trust Sandbox Frame Broker and Top-Level ApprovalSheet | Accepted | 2026-10-30 | `desktop/src/renderer/`, `Web/` | FrameBroker rate & command isolation |
| [ADR-0004](0004-multi-engine-abstraction.md) | Unified Multi-Engine Abstraction (Claude, Codex, Antigravity) | Accepted | 2026-11-02 | `desktop/src/core/app-tools/`, `agent/` | Contract suite & dynamic tool golden |

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
- **Formal Verification**: Where state machines involve concurrent operations, race conditions, or process recoveries, state transition models are checked via TLA+ under `spec/models/`.
