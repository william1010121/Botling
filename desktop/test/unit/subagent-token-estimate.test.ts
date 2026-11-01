import { describe, expect, it } from "vitest";
import { AgyWorkers, type AgyWorkerHead } from "../../src/core/agent/agy-workers";
import { parseLine, type StreamItem } from "../../src/core/agent/stream";
import { ClaudeRequestTracker, computeTokenSpeed, speedView, addSample } from "../../src/core/token-speed";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The real CLI sends a subagent's progress as complete `assistant` lines (parent_tool_use_id set);
// its partial stream_events carry the main conversation only. Every claim below uses that shape.
const assistant = (parent: string, id: string, content: unknown[], output: number) =>
  ({ type: "assistant", parent_tool_use_id: parent, message: { id, model: "claude-x", usage: { output_tokens: output }, content } });

describe("Claude subagent without stream_events", () => {
  it("still gets an (estimated) token speed from its assistant lines", () => {
    const tracker = new ClaudeRequestTracker();
    tracker.observe({ type: "user", parent_tool_use_id: "toolu_c", message: {} }, 1_000);
    const text = "x".repeat(2_000); // ~500 tokens; the line's stale count says 40
    const out = [
      ...tracker.observe(assistant("toolu_c", "m1", [{ type: "text", text }], 40), 6_000),
      ...tracker.observe({ type: "user", parent_tool_use_id: "toolu_c", message: {} }, 6_100),
    ];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ scope: "toolu_c", estimated: true, sample: { complete: true, startMs: 1_000, endMs: 6_000 } });
    expect(out[0]!.sample.outputTokens).toBeGreaterThanOrEqual(400);
    expect(speedView(addSample(undefined, out[0]!.sample, true))?.estimated).toBe(true);
    expect(computeTokenSpeed([out[0]!.sample]).tokPerSec).toBeGreaterThan(50);
  });
  it("does not double count when the scope also streams real events", () => {
    const tracker = new ClaudeRequestTracker();
    const ev = (event: unknown) => ({ type: "stream_event", parent_tool_use_id: "toolu_c", event });
    const out = [
      ...tracker.observe(ev({ type: "message_start", message: { id: "m1", usage: { output_tokens: 1 } } }), 1_000),
      ...tracker.observe(ev({ type: "message_delta", usage: { output_tokens: 90 } }), 2_000),
      ...tracker.observe(ev({ type: "message_stop" }), 3_000),
      ...tracker.observe(assistant("toolu_c", "m1", [{ type: "text", text: "y".repeat(4_000) }], 40), 3_001),
      ...tracker.observe({ type: "user", parent_tool_use_id: "toolu_c", message: {} }, 3_100),
    ];
    expect(out).toHaveLength(1);
    expect(out[0]!.sample.outputTokens).toBe(90);
  });
  it("flushes the last message when the subagent ends", () => {
    const tracker = new ClaudeRequestTracker();
    tracker.observe({ type: "user", parent_tool_use_id: "toolu_c", message: {} }, 0);
    tracker.observe(assistant("toolu_c", "m9", [{ type: "text", text: "z".repeat(1_200) }], 10), 3_000);
    const out = tracker.observe({ type: "system", subtype: "task_notification", tool_use_id: "toolu_c", status: "completed" }, 3_500);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ scope: "toolu_c", estimated: true });
  });
});

describe("subagent output-token estimate", () => {
  it("is not left at the stale count of a long message", () => {
    const items = parseLine(JSON.stringify(assistant("toolu_c", "m1", [{ type: "text", text: "x".repeat(2_000) }], 40)));
    const out = items.find((item): item is Extract<StreamItem, { kind: "subagentOutput" }> => item.kind === "subagentOutput");
    expect(out?.tokens).toBeGreaterThanOrEqual(400);
  });
  it("keeps the reported count when it is the larger one", () => {
    const items = parseLine(JSON.stringify(assistant("toolu_c", "m1", [{ type: "text", text: "hi" }], 300)));
    expect(items.find((item) => item.kind === "subagentOutput")).toMatchObject({ tokens: 300 });
  });
});

describe("Antigravity worker", () => {
  it("reports its output tokens like Claude and Codex workers do", () => {
    const home = mkdtempSync(join(tmpdir(), "botling-agy-tokens-"));
    const events: any[] = [];
    let handlers: any;
    const manager = new AgyWorkers({ command: "not-executed", cwd: home, acpHome: home, sessionId: "owner", resume: false, systemPrompt: "x", workerInstructions: "y" } as any,
      (item) => events.push(item), () => {}, (_config, h) => { handlers = h; return { start() {}, send() {}, answer() {}, async terminate() { return { killed: [], forced: false }; } } as AgyWorkerHead; });
    return manager.tool("app_handoff", { instructions: "task" }).then(async (accepted) => {
      handlers.onItem({ kind: "init", sessionId: "11111111-2222-4333-8444-555555555555" });
      handlers.onItem({ kind: "usage", totalCost: 0, tokens: { input: 5, output: 321, cacheRead: 0, cacheWrite: 0 } });
      expect(events.find((e) => e.kind === "subagentOutput")).toMatchObject({ id: accepted.task_id, tokens: 321 });
      await manager.close();
    });
  });
});
