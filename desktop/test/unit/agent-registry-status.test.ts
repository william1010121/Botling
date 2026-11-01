// agents.json's state and the row status through status.ts (shared-core spec 3.4, slice S4a): an app-managed worker's
// registry state is agentState of the ledger state its subagents.json record stands for, the row status is
// subagentStatus; Claude's own sidechains and other subagents keep the old rule. No state changes.
import { describe, expect, it } from "vitest";
import { rowStatus, stateFor, type AgentHostKind, type AgentState } from "../../src/core/agent-registry";
import { isWorkerType } from "../../src/core/agent/workers";
import type { SubagentStatus } from "../../src/core/subagents";

/** stateFor before S4a: the oracle. */
function legacyState(record: { status: SubagentStatus; type?: string }, kind: AgentHostKind): AgentState {
  if (record.status === "running") return "running";
  if (record.status === "completed") return kind !== "claude-sidechain" && isWorkerType(record.type) && record.type !== "ccb-core:component-editor" ? "idle" : "completed";
  return record.status;
}

/** rowStatus before S4a: the oracle. */
function legacyRow(state: AgentState): "running" | "completed" | "failed" | "stopped" {
  if (state === "running") return "running";
  if (state === "failed") return "failed";
  if (state === "idle" || state === "completed" || state === "reportPending") return "completed";
  return "stopped";
}

const STATUSES: SubagentStatus[] = ["running", "completed", "failed", "stopped"];
const TYPES = [undefined, "general-purpose", "claude-worker", "codex-worker", "agy-worker", "ccb-core:component-editor", "codex"];
const KINDS: AgentHostKind[] = ["claude-sidechain", "claude-process", "codex-thread", "agy-acp"];
const STATES: AgentState[] = ["running", "idle", "reportPending", "completed", "failed", "stopped", "interrupted", "lost"];

describe("registry state through status.ts", () => {
  it("stateFor: every status × type × host kind as before", () => {
    for (const status of STATUSES)
      for (const type of TYPES)
        for (const kind of KINDS) {
          const record = { status, ...(type ? { type } : {}) };
          expect(stateFor(record, kind), `${status}/${type}/${kind}`).toBe(legacyState(record, kind));
        }
  });

  it("a worker that ended a run is idle (it takes a follow-up); the component editor's is completed", () => {
    expect(stateFor({ status: "completed", type: "codex-worker" }, "codex-thread")).toBe("idle");
    expect(stateFor({ status: "completed", type: "claude-worker" }, "claude-process")).toBe("idle");
    expect(stateFor({ status: "completed", type: "ccb-core:component-editor" }, "codex-thread")).toBe("completed");
    expect(stateFor({ status: "completed", type: "general-purpose" }, "claude-sidechain")).toBe("completed");
  });

  it("rowStatus: every registry state as before", () => {
    for (const state of STATES) expect(rowStatus(state), state).toBe(legacyRow(state));
  });
});
