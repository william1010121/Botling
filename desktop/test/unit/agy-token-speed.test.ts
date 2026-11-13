// Antigravity's token speed, through the real AgyAcpProtocol on the clock of a recorded ACP stream.
// ACP reports one usage block per prompt turn and no per-request timing, so the speed is the turn's output (+ thought)
// tokens over the model's own time in that turn: the turn minus the time a tool (with its approval) was open.
// Before this, the sample was the whole wall-clock turn and the 300 s request cap applied to it: every worker turn over
// five minutes (29 of 58 finished agy workers in the user's data) showed "— tok/s" forever, and the rest counted tool
// runs and approval waits as generation.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyAcpProtocol } from "../../src/core/agent/agy-acp";
import { addSample, speedView, type RequestEvent } from "../../src/core/token-speed";

let now = 0;
const clients: AgyAcpProtocol[] = [];
afterEach(() => { clients.splice(0).forEach((c) => c.close()); vi.restoreAllMocks(); });
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

/** A protocol whose turn has been sent at `startMs`; `update`, `ask` and `end` play the server side. */
async function turn(startMs: number) {
  vi.spyOn(Date, "now").mockImplementation(() => now);
  now = 0;
  const frames: any[] = [], items: any[] = [];
  const client = new AgyAcpProtocol({ command: "never-launched", cwd: "/owned", sessionId: "old", resume: false, worker: true } as any, (m) => frames.push(m), (i) => items.push(i), () => undefined);
  clients.push(client);
  const reply = (result: any) => client.receive({ jsonrpc: "2.0", id: frames.findLast((f) => f.method && f.id).id, result });
  const policy = () => reply({ configOptions: [{ id: "mode", currentValue: "default" }] });
  const done = client.send("task", "u1");
  reply({ protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "1.4.3" }, agentCapabilities: { loadSession: true } }); await tick();
  reply({ sessionId: "new" }); await tick();
  policy(); await tick(); policy(); await tick();
  now = startMs; policy(); await tick();
  const prompt = frames.at(-1);
  expect(prompt.method).toBe("session/prompt");
  const update = (at: number, u: any) => { now = at; client.receive({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "new", update: u } }); };
  const ask = (at: number, id: number, toolCallId: string) => {
    now = at;
    client.receive({ jsonrpc: "2.0", id, method: "session/request_permission", params: { sessionId: "new", toolCall: { toolCallId, title: "write", rawInput: {} }, options: [{ kind: "allow_once", optionId: "allow" }, { kind: "reject_once", optionId: "deny" }] } });
  };
  const answer = (at: number, id: number) => { now = at; client.answer(`acp:${id}`, true); };
  const end = async (at: number, result: any) => {
    now = at; client.receive({ jsonrpc: "2.0", id: prompt.id, result }); await done;
    const requests = items.filter((i) => i.kind === "request").map((i) => i.request as RequestEvent);
    expect(requests).toHaveLength(1);
    return { request: requests[0]!, items, speed: speedView(addSample(undefined, requests[0]!.sample, requests[0]!.estimated === true)) };
  };
  /** agy's conversation file, as the turn reads it: the calls written since the last read. */
  const db = (calls: number[][]) => { (client as any).dbUsage = { mark() {}, take: () => (calls.shift() ?? []).map((output, i) => ({ at: null, model: "m", input: 0, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, retry: false, key: `k${i}` })) }; };
  const requests = () => items.filter((i) => i.kind === "request").map((i) => i.request as RequestEvent);
  const finish = async (at: number, result: any) => { now = at; client.receive({ jsonrpc: "2.0", id: prompt.id, result }); await done; };
  return { update, ask, answer, end, db, requests, items, finish };
}

const tool = (id: string, at: number, ms: number, t: Awaited<ReturnType<typeof turn>>) => {
  t.update(at, { sessionUpdate: "tool_call", toolCallId: id, title: "run_command", kind: "execute", status: "pending", rawInput: {} });
  t.update(at + ms, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", rawOutput: "ok" });
};
const usage = (output: number, thought: number) => ({ inputTokens: 20_000, outputTokens: output, thoughtTokens: thought, cachedReadTokens: 0, cachedWriteTokens: 0 });

describe("Antigravity token speed (ACP: one usage block per turn)", () => {
  it("on the recorded usage-speed stream: tokens over the model's time, the tool's run taken out", async () => {
    const lines = readFileSync(join(__dirname, "..", "fixtures", "worker-streams", "agy", "usage-speed.jsonl"), "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l));
    const promptLine = lines.find((l) => l.d === "in" && JSON.parse(l.l).method === "session/prompt");
    const t = await turn(promptLine.t);
    let result: any;
    for (const line of lines.filter((l) => l.d === "out" && l.t >= promptLine.t)) {
      const message = JSON.parse(line.l);
      if (message.method === "session/update") t.update(line.t, message.params.update);
      else if (message.method === "session/request_permission") { t.ask(line.t, message.id, message.params.toolCall.toolCallId); t.answer(line.t + 1, message.id); }
      else if (message.result?.usage) result = { line, message };
    }
    const { request, speed } = await t.end(result.line.t, result.message.result);
    // 112 output + 983 thought tokens; the turn ran 3815 → 10608 ms, botling_read_file 6968 → 6987 ms.
    expect(request.sample.outputTokens).toBe(1095);
    expect(request.sample.segmentsMs).toEqual([6968 - 3815, 10608 - 6987]);
    expect(speed!.tokPerSec).toBeCloseTo(1095 / 6.774, 6);
    expect(speed!.estimated).toBe(true);
  });

  it("a worker turn longer than five minutes, mostly tool runs, still gets its speed (it showed — tok/s)", async () => {
    // The shape of the user's untimed agy workers: 300–3500 s turns of many tool rounds, 20k–100k output tokens.
    const t = await turn(1_000);
    tool("a", 21_000, 180_000, t);   // model 20 s, then a 3 min build
    tool("b", 221_000, 240_000, t);  // model 20 s, then a 4 min test run
    const { speed } = await t.end(481_000, { stopReason: "end_turn", usage: usage(2_000, 10_000) }); // model 20 s
    expect(speed).toEqual({ tokPerSec: 12_000 / 60, estimated: true });
  });

  it("an approval's wait is not generation", async () => {
    const t = await turn(0);
    t.update(5_000, { sessionUpdate: "tool_call", toolCallId: "w", title: "write", kind: "edit", status: "pending", rawInput: {} });
    t.ask(5_001, 7, "w");
    t.answer(605_000, 7); // the user answered ten minutes later
    t.update(606_000, { sessionUpdate: "tool_call_update", toolCallId: "w", status: "completed", rawOutput: "ok" });
    const { request, speed } = await t.end(611_000, { stopReason: "end_turn", usage: usage(500, 500) });
    expect(request.sample.segmentsMs).toEqual([5_000, 5_000]);
    expect(speed!.tokPerSec).toBe(100);
  });

  it("parallel tools: the model waits while any of them is open", async () => {
    const t = await turn(0);
    t.update(1_000, { sessionUpdate: "tool_call", toolCallId: "p", title: "a", status: "pending" });
    t.update(2_000, { sessionUpdate: "tool_call", toolCallId: "q", title: "b", status: "pending" });
    t.update(30_000, { sessionUpdate: "tool_call_update", toolCallId: "p", status: "completed" });
    t.update(50_000, { sessionUpdate: "tool_call_update", toolCallId: "q", status: "failed" });
    const { request } = await t.end(53_000, { stopReason: "end_turn", usage: usage(100, 0) });
    expect(request.sample.segmentsMs).toEqual([1_000, 3_000]);
  });

  it("a model stall over five minutes is not timed; a cancelled turn is not timed", async () => {
    const stalled = await turn(0);
    tool("a", 10_000, 1_000, stalled);
    const { speed } = await stalled.end(400_000, { stopReason: "end_turn", usage: usage(100, 100) });
    expect(speed).toBeNull();
    const cancelled = await turn(0);
    const { request } = await cancelled.end(9_000, { stopReason: "cancelled", usage: usage(100, 100) });
    expect(request.sample.complete).toBe(false);
  });

  it("a turn that ended with its usage after a failed tool is timed, as a Claude or Codex request is", async () => {
    const t = await turn(0);
    t.update(2_000, { sessionUpdate: "tool_call", toolCallId: "x", title: "run", status: "pending" });
    t.update(3_000, { sessionUpdate: "tool_call_update", toolCallId: "x", status: "failed", rawOutput: "boom" });
    const { speed, items } = await t.end(5_000, { stopReason: "max_tokens", usage: usage(400, 0) });
    expect(items.at(-1)).toMatchObject({ kind: "result", ok: false });
    expect(speed!.tokPerSec).toBe(100);
  });

  it("a worker's speed shows while its run is under way, not only when it ends (agy workers showed — tok/s all run)", async () => {
    // A worker's run is ONE prompt turn: with only the turn's usage block, its row had no speed until the run ended,
    // while a Claude or Codex worker's shows after its first request. agy's conversation file has each call as it is
    // written, so every model segment that ends at a tool round is timed with the calls written in it.
    const t = await turn(0);
    t.db([[2_000], [], [1_000]]);
    tool("a", 20_000, 60_000, t);                 // model 0 → 20 s (2000 tokens), tool 20 → 80 s
    const live = t.requests();
    expect(live).toHaveLength(1);
    expect(live[0]!).toMatchObject({ scope: null, estimated: true, sample: { outputTokens: 2_000, segmentsMs: [20_000], complete: true } });
    expect(speedView(addSample(undefined, live[0]!.sample, true))).toEqual({ tokPerSec: 100, estimated: true });
    tool("b", 90_000, 10_000, t);                 // model 80 → 90 s, no call written yet: its time waits for its tokens
    expect(t.requests()).toHaveLength(1);
    await t.finish(110_000, { stopReason: "end_turn", usage: usage(1, 1) }); // model 100 → 110 s, 1000 tokens
    const all = t.requests();
    expect(all).toHaveLength(2);
    expect(all[1]!.sample).toMatchObject({ outputTokens: 1_000, segmentsMs: [10_000, 10_000], complete: true });
    // The turn's usage is every call it wrote, read live or at its end.
    expect(t.items.find((i) => i.kind === "usage")).toMatchObject({ tokens: { output: 3_000 } });
    const totals = all.reduce((sum, r) => addSample(sum, r.sample, true), undefined as any);
    expect(speedView(totals)).toEqual({ tokPerSec: 3_000 / 40, estimated: true });
  });
});
