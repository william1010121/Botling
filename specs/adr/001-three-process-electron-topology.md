# ADR 001: Three-Process Electron Topology (Main, Core Daemon UtilityProcess, Sandboxed Renderer)

## Status
- **Status**: Accepted
- **Decided Date**: 2026-10-25 (Architecture baseline established during 2.0 migration; reaffirmed 2026-11-02)
- **Deciders**: Project Lead & Botling Architecture Team

---

## Context
Botling is a desktop AI developer assistant that coordinates multi-turn, multi-agent AI execution across several backend engines (Anthropic Claude Code CLI, OpenAI Codex headless server, and Google DeepMind Antigravity ACP). In addition to conversational AI turns, the application manages interactive native PTY terminals, local git worktrees, file watching, cron routines, MCP servers, and dynamic web plugins/cards.

During early versions and prototype iterations, monolithic and standard dual-process Electron topologies introduced severe operational liabilities:

1. **Main Process Event-Loop Starvation**:
   Running heavy Node.js tasks—such as AST parsing, TLA+ TLC model checking, massive JSON-RPC stream decoding, and concurrent child process pipe management—inside the Electron Main process blocked the Chromium UI event loop. This caused window beachballing, frozen text inputs, and dropped native menu events.

2. **Unbounded Crash Blast Radius**:
   A fatal error or out-of-memory (OOM) fault inside an AI worker subprocess, CLI stream parser, or user plugin script could bring down the entire application process, instantly terminating all open terminal sessions, destroying active workspace state, and closing user windows.

3. **Remote Code Execution (RCE) via Web Views**:
   The desktop client displays dynamic UI cards, web components, and third-party plugin panels. If the presentation renderer layer possessed direct Node.js integration (`nodeIntegration: true`), any Cross-Site Scripting (XSS) vulnerability or untrusted HTML injected via LLM output would immediately yield arbitrary host shell execution.

---

## Decision
We decouple Botling into a strict **Three-Process Topology** separating native window management, core business logic, and untrusted presentation:

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron Main Process                    │
│  - BrowserWindow & Native macOS Menus / System Tray         │
│  - Process Supervisor (`core-client.ts`)                    │
│  - Native PTY Terminal Spawning (`node-pty`)                │
│  - Auto-Updater (`electron-updater`) & Native File Dialogs  │
└──────────────┬───────────────────────────────▲──────────────┘
               │ MessagePort / IPC             │ IPC Preload Bridge
               ▼                               │ (contextIsolation: true)
┌───────────────────────────────┐  ┌───────────┴──────────────┐
│     Core UtilityProcess       │  │      Renderer Shell      │
│  - Head & Worker Orchestration│  │  - React 19 UI Shell     │
│  - WorkerCore State Machine   │  │  - FrameBroker Router    │
│  - Ledger v3 (Single Truth)   │  │  - ApprovalSheet Dialog  │
│  - AppToolsRegistry & MCP Host│  │  - Terminal UI View      │
│  - Cron & Routine Scheduler   │  └───────────┬──────────────┘
│  - Git Worktree Management    │              │ postMessage RPC
└───────────────────────────────┘              ▼
                                   ┌──────────────────────────┐
                                   │ Sandboxed Plugin Iframes │
                                   │  - origin: "null"        │
                                   │  - Zero Node.js Access   │
                                   └──────────────────────────┘
```

### 1. Electron Main Process (`desktop/src/main/`)
- **Responsibilities**:
  - Owns native operating system interactions: `BrowserWindow`, macOS Dock/Menu management, native open/save dialogs, notification dispatch, and updater signing verification (`electron-updater`).
  - Spawns and manages native PTY sessions via `node-pty`.
  - Acts as the **Process Supervisor**: forks and supervises the Core process using Electron's `utilityProcess.fork()` (`desktop/src/main/core-client.ts`).
  - Implements crash recovery: if the Core utility process exits unexpectedly, the Main process captures exit diagnostics, logs the crash reason, and attempts coordinated rehydration without destroying existing OS window handles.

### 2. Core UtilityProcess (`desktop/src/core/`)
- **Responsibilities**:
  - Operates as a headless, dedicated Node.js runtime process isolated from both the UI renderer and the native window manager.
  - Hosts the AI coordinator and worker lifecycle (`Bot`, `WorkerCore`, `HeadSession`, `AppToolsRegistry`).
  - Executes local background tasks: scheduled cron routines (`routines.cron`), git repository indexers, workspace worktree maintenance, and local MCP server adapters.
  - Manages durable state persistence: atomic commits to `worker-ledger.json` (v3), `bot.json`, `.bot/memory.md`, and profile configuration.
  - Communicates with Electron Main and the Renderer over isolated `MessageChannelMain` MessagePort connections and structured IPC endpoints.

### 3. Renderer Shell (`desktop/src/renderer/` & Sandboxed Iframes)
- **Responsibilities**:
  - Pure presentation layer running React 19 and TypeScript in Chromium.
  - Configured with strict defense-in-depth isolation: `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`.
  - Interfaces with the desktop host strictly through typed preload APIs (`window.botling`).
  - Houses the top-level security boundaries: `ApprovalSheet.tsx` (the only component authorized to approve privileged shell operations) and `FrameBroker.ts`.
  - Sandboxes third-party plugins, whiteboard cards, and HTML previews inside `<iframe sandbox="allow-scripts">` with opaque origins (`origin: "null"`).

---

## Consequences

### Positive
- **Guaranteed UI Responsiveness**: Heavy agent activities (TLA+ model checking, large worktree diffs, multi-worker CLI stream parsing) run in the Core UtilityProcess, keeping the React UI thread completely unblocked.
- **Fault Containment**: A crash, uncaught exception, or memory leak in an AI engine or background parser terminates only the UtilityProcess; the desktop UI remains intact, reporting an intelligible reconnection banner rather than crashing to the desktop.
- **Robust Security Perimeter**: Untrusted code or user-provided web artifacts cannot break out of their opaque iframe sandbox to access Node.js APIs or the host filesystem.

### Negative & Trade-offs
- **IPC Overhead & Latency**: Every command, query, and event passing between the UI, Main, and Core must be serialized (structured clone or JSON). High-frequency token streaming requires batched IPC transfers to avoid overhead.
- **Asynchronous Protocol Complexity**: Synchronous cross-process calls are prohibited. All cross-boundary workflows must handle network/IPC timeouts, disconnects, and eventual reconciliation.

### Considered Alternatives
- **Monolithic Main Architecture (Single Process)**:
  - *Description*: Running all AI engine orchestration, state machines, and file operations directly in Electron Main.
  - *Rejection Reason*: Unacceptable risk of UI freezing during long-running tasks, and fatal errors instantly destroy the entire application.
- **Renderer-Heavy Architecture (Node Integration in React)**:
  - *Description*: Running core logic directly inside the Chromium Renderer process with `nodeIntegration: true`.
  - *Rejection Reason*: Severe security hazard. Any XSS vulnerability in rendered markdown, preview frames, or plugin panels immediately translates into unauthenticated host shell execution.
- **Web Workers inside Renderer**:
  - *Description*: Running background tasks inside Web Workers in the browser process.
  - *Rejection Reason*: Web Workers lack access to native operating system primitives, child process execution, and PTYs required for CLI orchestration.
