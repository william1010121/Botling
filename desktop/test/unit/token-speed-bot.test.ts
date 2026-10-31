import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bot, subagentView } from "../../src/core/bot";
import { CodexHead, CodexThreads, type CodexOutput } from "../../src/core/agent/codex";
import { ProcessLedger } from "../../src/core/process/ledger";
import { mainProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { tempDir, until } from "../helpers";

// Replay the real session's outputs through Bot's head callback. Only stdio is replaced:
// permission cards, choose(), coordinator cleanup and the session's RPC decisions are real.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function harness(approvalTimeoutMs = 60_000) {
  const dir = tempDir("token-speed-bot");
  const profile = mainProfile(dir);
  mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"], answerWith: "codex" } }));
  const events: any[] = [];
  const bot = new Bot({ profile, deferStartup: true, welcome: false,
    ledger: new ProcessLedger(join(dir, "ledger.json")),
    headConfig() { throw new Error("No CLI needed for protocol replay"); },
    prompts: () => botPrompts({ profile, engine: "codex" }),
    emit: (event) => events.push(event), log() {},
    approvalTimeoutMs, idleMs: 60_000, interruptGraceMs: 10,
  });
  const head = new CodexHead({ command: process.execPath, cwd: dir, sessionId: "test", resume: false,
    threads: new CodexThreads(join(dir, "threads")), instructions: "Coordinator", workerInstructions: "Worker" },
  { onItem() {}, onExit() {} });
  (bot as any).head = head;
  head.running = true;
  const writes: any[] = [];
  const deliver = (outputs: CodexOutput[]) => {
    for (const output of outputs) {
      if (output.kind === "write") writes.push(output.value);
      if (output.kind === "item") (bot as any).onItem(head, output.item);
    }
    return outputs;
  };
  vi.spyOn(head, "answer").mockImplementation((id, allow, _input, why) => { deliver(head.session.answer(id, allow, why)); });
  const receive = (value: unknown) => deliver(head.session.receive(JSON.stringify(value)));
  const note = (method: string, params: unknown) => receive({ method, params });
  const tool = (name: string, args: unknown, id = 100) => receive({ id, method: "item/tool/call", params: { threadId: "coord", turnId: "ct1", tool: name, arguments: args } });
  const respond = (method: string, result: unknown) => {
    const call = writes.findLast((write) => write.method === method);
    return receive({ id: call.id, result });
  };
  deliver(head.session.start()); respond("initialize", {}); respond("thread/start", { thread: { id: "coord" } });
  deliver(head.session.send("Delegate")); respond("turn/start", { turn: { id: "ct1" } });
  tool("app_handoff", { instructions: "Do the authorized work", name: "Worker" });
  const task = head.session.workerRecords[0]!.id;
  respond("thread/start", { thread: { id: "worker" } }); respond("turn/start", { turn: { id: "wt1" } });
  cleanups.push(async () => { deliver(head.session.stop()); head.running = false; await bot.shutdown({ tidy: false }); });
  return { bot, head, note, task };
}

const usage = (thread: string, last: number, total: number) => ({ threadId: thread, turnId: thread === "coord" ? "ct1" : "wt1", tokenUsage: { last: { outputTokens: last }, total: { outputTokens: total } } });

describe("token speed through the real Bot and Codex session", () => {
  it("the head turn and its worker each get the shared definition, from the same notification stream", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { bot, note, task } = harness();
      const at = (seconds: number) => vi.setSystemTime(2_000_000_000_000 + seconds * 1000);
      at(0); note("turn/started", { threadId: "coord", turn: { id: "ct1" } });
      at(4); note("thread/tokenUsage/updated", usage("coord", 80, 80));
      at(4.2); note("thread/tokenUsage/updated", usage("coord", 80, 80));
      at(10); note("item/completed", { threadId: "coord", turnId: "ct1", item: { type: "commandExecution", id: "x" } });
      at(12); note("thread/tokenUsage/updated", usage("coord", 40, 120));
      // 120 tokens / 6 s: the 4.2 s repeat is no request, and the 6 s of tool time is not counted.
      expect(bot.view().tokenSpeed).toEqual({ tokPerSec: 20, estimated: false, engine: "codex" });

      at(20); note("turn/started", { threadId: "worker", turn: { id: "wt1" } });
      at(22); note("thread/tokenUsage/updated", usage("worker", 100, 100));
      const child = (bot as any).subagents.get(task);
      expect(child.speed).toEqual({ tokens: 100, seconds: 2, timed: 1 });
      expect(subagentView(child, "Main", (bot as any).subagents, "codex").tokenSpeed).toEqual({ tokPerSec: 50, estimated: false });
      // The worker's requests never reach the head's number.
      expect(bot.view().tokenSpeed?.tokPerSec).toBe(20);
    } finally { vi.useRealTimers(); }
  });
});
