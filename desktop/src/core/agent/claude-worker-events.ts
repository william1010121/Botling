// A Claude process's stream items as WorkerEvents, one copy for every adapter that runs `claude` for a worker (its
// app-managed workers, claude-workers.ts, and the Maintainer's component editor, component-editor.ts). What is the
// adapter's own (its session, the end of its run, its approvals table, steered words) stays with it.
import { costDelta, type WorkerEvent } from "../worker-core";
import type { StreamItem } from "./stream";

export class ClaudeStreamEvents {
  /** The streamed text block: "open" while its chunks come; "closed" once a tool call on its own line closed it. */
  private chunks: "none" | "open" | "closed" = "none";
  /** claude reports its process's cost so far: each usage becomes the spend since the last. */
  private cost = { last: 0 };

  /** A run starts: no text block is open. */
  newRun() { this.chunks = "none"; }
  /** A new process: its cost counts from zero again. */
  newProcess() { this.chunks = "none"; this.cost = { last: 0 }; }

  /** The event for `item`; null: not one of these (init, result, command, …: the adapter's own). */
  event(item: StreamItem): WorkerEvent | null {
    switch (item.kind) {
      case "textBlock": this.chunks = "none"; return { type: "textBreak" };
      case "delta": this.chunks = "open"; return { type: "textDelta", text: item.text };
      case "assistantText": {
        // claude streams a block's chunks, then sends its whole message. A message that also carries a tool call gives
        // the call first, which closed the block: its words are shown already.
        const shown = this.chunks === "closed";
        this.chunks = "none";
        return shown ? null : { type: "textWhole", text: item.text, phase: null };
      }
      case "toolUse":
        if (this.chunks === "open") this.chunks = "closed";
        return { type: "toolUse", id: item.id, tool: item.tool, title: item.title, detail: item.detail, input: item.input };
      case "toolResult": this.chunks = "none"; return { type: "toolResult", id: item.id, output: item.output, failed: item.failed };
      case "permission":
        return { type: "permission", nativeId: item.requestId, tool: item.tool, summary: item.summary, input: item.input,
          ...(item.safetyCheck ? { safetyCheck: item.safetyCheck } : {}), ...(item.noAlways ? { noAlways: true } : {}) };
      case "permissionCancelled": return { type: "permissionCancelled", nativeId: item.requestId };
      case "permissionDenied": return { type: "permissionDenied", toolUseId: item.toolUseId, tool: item.tool, reason: item.reason, confirmed: item.confirmed };
      case "connectionLost": return { type: "connectionLost" };
      case "rateLimits": return { type: "rateLimits", engine: item.engine, limits: item.limits };
      case "usage": return { type: "usage", tokens: item.tokens, cost: costDelta(this.cost, item.totalCost) };
      case "request": { const { scope: _scope, ...request } = item.request; return { type: "request", request }; }
      case "measurement": { const { run: _run, ...measurement } = item.measurement; return { type: "measurement", provider: item.provider ?? "claude", measurement }; }
      default: return null;
    }
  }
}
