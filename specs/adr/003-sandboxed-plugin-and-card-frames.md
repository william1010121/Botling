# ADR 003: Sandboxed Plugin and Card Frames (Zero-Trust FrameBroker and Top-Level ApprovalSheet)

## Status
- **Status**: Accepted
- **Decided Date**: 2026-10-30 (Security model established; finalized with FrameBroker and ApprovalSheet contracts on 2026-11-02)
- **Deciders**: Project Lead & Botling Architecture Team

---

## Context
Botling supports dynamic extensibility through interactive web plugins, whiteboard cards, HTML report previews, and custom UI components rendered directly within the desktop application. Because these components can be authored by third parties, imported from repositories, or generated dynamically by LLMs, their execution environment is treated as **untrusted**.

Allowing untrusted web frames direct or ambient access to host execution capabilities introduces critical security hazards:

1. **Identity Spoofing via IPC / postMessage**:
   In naive postMessage architectures, messages declare their own sender metadata (e.g. `{ plugin: "system-admin", command: "exec" }`). An untrusted or compromised iframe can forge this metadata to impersonate privileged components.

2. **Self-Authorization & Privilege Escalation**:
   If an untrusted component is permitted to trigger or approve its own permission prompts, malicious code could automatically simulate clicks, bypass user review, and gain arbitrary shell execution rights.

3. **Denial-of-Service / IPC Flooding**:
   An unthrottled iframe could spam hundreds of host calls per second, freezing the desktop client or exhausting OS file descriptors and process limits.

4. **Clickjacking & Accidental Double-Clicks**:
   Rapidly presenting a confirmation dialog can trick users into clicking "Allow" if the dialog appears immediately under a clicking mouse cursor (clickjacking / double-click race).

---

## Decision
We enforce a strict **Zero-Trust Sandbox Model** where untrusted web components are physically isolated, communication is mediated by a validating broker (`FrameBroker`), and all privileged operations require explicit human confirmation through an out-of-frame modal (`ApprovalSheet`), with runtime permission revocation:

```
┌────────────────────────────────────────────────────────┐
│          Untrusted Sandboxed Iframe (origin: null)     │
│  - <iframe sandbox="allow-scripts">                    │
│  - Attempts privileged operation                       │
└───────────────────────────┬────────────────────────────┘
                            │ window.parent.postMessage()
                            ▼
┌────────────────────────────────────────────────────────┐
│         FrameBroker (desktop/src/renderer/)            │
│  1. Match event.source === frame.contentWindow         │
│  2. Assert event.origin === "null"                     │
│  3. Token bucket rate limit (20 burst, 10/sec)         │
│  4. Command scope validation (ownsCommand)             │
│  5. Return `needsApproval` structure                   │
└───────────────────────────┬────────────────────────────┘
                            │ needsApproval
                            ▼
┌────────────────────────────────────────────────────────┐
│    Top-Level React App Shell (ApprovalSheet.tsx)       │
│  - Rendered OUTSIDE any iframe in native app shell     │
│  - Displays raw shell command & working directory      │
│  - Enforces 350 ms hardware arming delay               │
│  - User explicitly clicks "Allow and run"              │
└───────────────────────────┬────────────────────────────┘
                            │ client.call("component.approve")
                            ▼
┌────────────────────────────────────────────────────────┐
│              Core Host Execution Gate                  │
│  - Verifies approved parameters match pending ask      │
│  - Records grant with scope and TTL in memory          │
│  - Executes command in tracked process group           │
│  - Revokes grant on scope change, timeout, or user act │
└────────────────────────────────────────────────────────┘
```

### 1. Hardened Iframe Isolation
- All untrusted components, plugin panels, and HTML cards are mounted inside sandboxed iframes:
  `<iframe sandbox="allow-scripts">` without `allow-same-origin`.
- The browser enforces an opaque origin (`origin: "null"`). The frame has no access to `localStorage`, cookies, indexedDB, or native Electron preload scripts.

### 2. Host-Enforced Identity via `FrameBroker` (`desktop/src/renderer/frame-broker.ts`)
- **True Source Binding**:
  Messages received via `window.addEventListener("message")` are verified against registered target window references (`event.source === target.frame.contentWindow`).
  Self-declared sender IDs inside message payloads are strictly ignored.
- **Opaque Origin Assertion**:
  `FrameBroker` rejects any incoming message where `event.origin !== "null"`.
- **Token Bucket Rate Limiting**:
  Each registered frame is assigned a token bucket (`RATE = { burst: 20, perSecond: 10 }`). Any frame exceeding this budget is rejected with an explicit refusal log.
- **Command Ownership Isolation**:
  A plugin frame can only invoke commands belonging to its own registered prefix (`ownsCommand(plugin, message.id)`). Calling commands belonging to another plugin is refused immediately.

### 3. Out-of-Frame Approval via `ApprovalSheet` (`desktop/src/renderer/ApprovalSheet.tsx`)
- **Privilege Separation**:
  Sandboxed frames, preview panels, and chat bubble buttons cannot approve their own commands. If an unapproved command is requested, the backend returns a `needsApproval` response describing the exact executable command, folder path, and detail inspect command.
- **Native Host Dialog**:
  The `ApprovalSheet` is mounted strictly in the top-level React root DOM, completely outside the reach of any iframe.
- **Anti-Clickjacking Arming Delay**:
  To protect against accidental clicks or automated trigger exploits, the "Allow and run" button is disabled for an arming delay of `ARM_MS = 350ms` upon appearing.
- **Exact Parameter Verification**:
  When the user clicks "Allow and run", the top-level app issues `component.approve` (or `pin.approve` / `spec.approve`). The Core validates that the command, directory, and flags match the pending request byte-for-byte before dispatching execution.

### 4. Deterministic Permission Revocation
- **TTL and Scoped Grants**:
  Granted permissions are stored in memory with explicit expiration timestamps (TTLs).
- **Automatic Revocation**:
  When an operator switches workspaces, closes a session, or initiates an explicit revocation, grants are cleared immediately from the Core permissions table.
- **Event Notification**:
  `PermissionRevokedEvent` notifies active frames when previously granted permissions expire or are revoked by the operator.

---

## Consequences

### Positive
- **Absolute Sandbox Confinement**: Malicious or buggy plugin code cannot forge identity, access host storage, or execute unapproved shell commands.
- **Full Operational Transparency**: The end-user always inspects the actual shell command, working directory, and parameters in plain text before authorizing execution.
- **Resilience Against UI Exploits**: Out-of-frame rendering and the 350ms arming delay eliminate programmatic self-approval and clickjacking vectors.

### Negative & Trade-offs
- **Human-in-the-Loop Friction**: Commands not covered by project-level pre-authorization rules pause execution until the user manually reviews and approves the dialog.
- **IPC Protocol Rigidity**: Adding new RPC methods between plugins and host requires registering them through `ui.expose` and validating parameter schemas in `Web/src/frame-protocol.ts`.

### Considered Alternatives
- **Direct Preload Script Exposure (`window.botling.approve()`)**:
  - *Description*: Injecting an approval function directly into the iframe's JavaScript environment.
  - *Rejection Reason*: Critical security failure. Any script running inside the iframe could invoke `approve()` programmatically without user knowledge.
- **Webview Tag with Node Integration**:
  - *Description*: Using Electron's `<webview>` tag with selective Node.js primitives.
  - *Rejection Reason*: Deprecated and discouraged by Electron security guidelines; significantly larger attack surface compared to standard `<iframe sandbox>`.
- **Origin-Based Domain Whitelisting**:
  - *Description*: Hosting plugins on local localhost ports (e.g. `http://localhost:4000`) and checking `event.origin`.
  - *Rejection Reason*: Incurs local port contention, firewall prompt warnings, and complexity compared to standard opaque origin (`null`) sandboxing.
