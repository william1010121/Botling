// Real atomic files, fake time, no CLI processes. Drive the normal parsed-item boundary.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot } from "../../src/core/bot";
import type { CodexItem } from "../../src/core/agent/codex";
import { BotStore } from "../../src/core/store/bot-store";
import { mainProfile } from "../../src/core/store/workspace";
import { ProcessLedger } from "../../src/core/process/ledger";
import type { SubagentRecord } from "../../src/core/subagents";

const roots: string[] = [];
const bots: Bot[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const bot of bots.splice(0)) await bot.shutdown({ tidy: false });
  vi.clearAllTimers(); vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(primary?: Bot) {
  const root = mkdtempSync(join(tmpdir(), "botling-subagent-persistence-")); roots.push(root);
  const profile = mainProfile(root);
  const events: unknown[] = [];
  const log = vi.fn();
  const bot = new Bot({ profile, primary, engine: primary ? "codex" : "claude", deferStartup: true, welcome: false,
    headConfig() { throw new Error("No CLI in persistence tests"); }, prompts() { throw new Error("No turn"); },
    ledger: new ProcessLedger(join(root, "ledger.json")), emit: event => events.push(event), log,
    approvalTimeoutMs: 100, idleMs: 100, interruptGraceMs: 100,
  });
  bots.push(bot);
  const folder = primary ? join(primary.profile.storeDir, "partner-codex") : profile.storeDir;
  const file = join(folder, "subagents.json");
  const disk = (): SubagentRecord[] => JSON.parse(readFileSync(file, "utf8"));
  const send = (item: CodexItem) => (bot as unknown as { onSubagentItem(item: CodexItem): boolean }).onSubagentItem(item);
  const start = () => send({ kind: "subagentStarted", id: "worker", description: "Worker", type: "codex-worker", prompt: "Work", background: false });
  const text = (value: string) => send({ kind: "subagentText", parent: "worker", text: value });
  return { bot, file, disk, send, start, text, log, events };
}
function writes() {
  const original = BotStore.prototype.saveList;
  const completed: number[] = [];
  const spy = vi.spyOn(BotStore.prototype, "saveList").mockImplementation(function (this: BotStore, name, list) {
    original.call(this, name, list);
    if (name === "subagents.json") completed.push(statSync(join(this.directory, name)).size);
  });
  return { completed, spy };
}
it("coalesces progress without postponing the first deadline, preserving records and run history", async () => {
  const f = fixture();
  const archived: SubagentRecord = { id: "old", description: "Old", prompt: "Old prompt", status: "completed", background: false, startedAt: 0,
    steps: [{ id: "old-step", kind: "text", title: "Keep this", done: true, failed: false }],
    previousRuns: [{ prompt: "Earlier", status: "completed", steps: [], startedAt: 0, result: "Keep history" }], extra: { keep: true } };
  f.bot.subagents.list.push(archived);
  f.start();
  const w = writes();
  for (let i = 0; i < 20; i++) { f.text(`delta-${i}`); await vi.advanceTimersByTimeAsync(20); }
  expect(w.completed).toHaveLength(0);
  expect(f.disk().find(row => row.id === "worker")!.steps).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(w.completed).toHaveLength(1);
  expect(f.disk()).toEqual(f.bot.subagents.list);
  expect(f.disk()[0]).toEqual(archived);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(w.completed).toHaveLength(1);
});
it.each(["completed", "failed", "stopped"])("persists %s and pending progress before returning, with no delayed rewrite", async status => {
  const f = fixture(); f.start(); const w = writes();
  f.text("Final evidence");
  f.send({ kind: "subagentEnded", id: "worker", status, summary: "Final report" });
  expect(f.disk()[0]).toMatchObject({ status, result: "Final report", steps: [{ title: "Final evidence" }] });
  expect(w.completed).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5_000); expect(w.completed).toHaveLength(1);
});
it("keeps execution identity and tool events synchronous; duplicate token counts do not write", async () => {
  const f = fixture(); f.start(); const w = writes();
  f.send({ kind: "subagentOutput", id: "worker", counter: "run", tokens: 12 });
  f.send({ kind: "subagentOutput", id: "worker", counter: "run", tokens: 12 });
  f.send({ kind: "subagentExecution", id: "worker", execution: { run: 1, threadId: "t", turnId: "u", ownerSessionId: "s" } });
  expect(f.disk()[0]).toMatchObject({ outputTokenCounters: { run: 12 }, execution: { threadId: "t" } });
  f.send({ kind: "toolUse", id: "read", tool: "Read", title: "Read", detail: "file", parent: "worker", input: {} });
  expect(f.disk()[0]!.steps.at(-1)?.id).toBe("read");
  expect(w.completed).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(1_000); expect(w.completed).toHaveLength(2);
});
it("flushes both heads before core handover and cancels their pending timers", async () => {
  const f = fixture(); const p = fixture(f.bot); f.bot.partner = p.bot;
  f.start(); p.start(); f.text("primary"); p.text("partner"); const w = writes();
  f.bot.flushForSwap();
  expect(f.disk()[0]!.steps[0]!.title).toBe("primary");
  expect(p.disk()[0]!.steps[0]!.title).toBe("partner");
  expect(w.completed).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(5_000); expect(w.completed).toHaveLength(2);
});
it("flushes on shutdown and leaves no delayed subagent write", async () => {
  const f = fixture(); f.start(); f.text("shutdown"); const w = writes();
  await f.bot.shutdown({ tidy: false });
  expect(f.disk()[0]!.steps[0]!.title).toBe("shutdown");
  expect(w.completed).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5_000); expect(w.completed).toHaveLength(1);
});
it("retains dirty progress after a failed timer write and retries the latest state", async () => {
  const f = fixture(); f.start(); f.text("first");
  const original = BotStore.prototype.saveList;
  let failures = 1;
  const spy = vi.spyOn(BotStore.prototype, "saveList").mockImplementation(function (this: BotStore, name, list) {
    if (name === "subagents.json" && failures-- > 0) throw new Error("disk unavailable");
    original.call(this, name, list);
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(f.disk()[0]!.steps).toHaveLength(0);
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("save failed"));
  f.text("latest"); await vi.advanceTimersByTimeAsync(1_000);
  expect(f.disk()[0]!.steps.map(step => step.title)).toEqual(["first", "latest"]);
  expect(spy).toHaveBeenCalledTimes(2);
});
it("surfaces terminal and handover write failures and preserves the dirty state for recovery", () => {
  const f = fixture(); f.start(); f.text("pending");
  const original = BotStore.prototype.saveList;
  const spy = vi.spyOn(BotStore.prototype, "saveList").mockImplementation(function (this: BotStore, name, list) {
    if (name === "subagents.json") throw new Error("disk unavailable");
    original.call(this, name, list);
  });
  expect(() => f.send({ kind: "subagentEnded", id: "worker", status: "completed", summary: "done" })).toThrow("disk unavailable");
  expect(f.disk()[0]!.status).toBe("running");
  expect(() => f.bot.flushForSwap()).toThrow("disk unavailable");
  spy.mockRestore(); f.bot.flushForSwap();
  expect(f.disk()[0]).toMatchObject({ status: "completed", result: "done", steps: [{ title: "pending" }] });
});

it("bounds failed retries and flushes dirty progress after shutdown failure", async () => {
  const f = fixture(); f.start();
  const original = BotStore.prototype.saveList;
  const spy = vi.spyOn(BotStore.prototype, "saveList").mockImplementation(function (this: BotStore, name, list) {
    if (name === "subagents.json") throw new Error("disk unavailable");
    original.call(this, name, list);
  });
  for (let i = 0; i < 50; i++) f.text(`delta-${i}`);
  await vi.advanceTimersByTimeAsync(30_500);
  expect(spy).toHaveBeenCalledTimes(5);
  await expect(f.bot.shutdown({ tidy: false })).rejects.toThrow("disk unavailable");
  const attempts = spy.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(spy).toHaveBeenCalledTimes(attempts);
  spy.mockRestore(); await f.bot.shutdown({ tidy: false });
  expect(f.disk()[0]!.steps).toHaveLength(50);
});

// Opt-in single-job comparison: 81 generated records ~25 MB, six text deltas over 300 ms.
// Run at original and changed source with the same test file; no live profile is read or modified.
it.skipIf(process.env.BOTLING_PERSISTENCE_MEASURE !== "1")("representative persistence write-volume measurement", async () => {
  const f = fixture(); f.start();
  // Seed retained history after start's existing trim policy; measure persistence, not retention.
  const history = "h".repeat(310_000);
  for (let i = 0; i < 80; i++) f.bot.subagents.list.push({ id: `old-${i}`, description: "Archived", prompt: "History", status: "completed", background: false, startedAt: 0,
    steps: [{ id: `step-${i}`, kind: "text", title: history, done: true, failed: false }] });
  f.send({ kind: "subagentExecution", id: "worker", execution: { run: 1, threadId: "t", turnId: "u", ownerSessionId: "s" } });
  const initialBytes = statSync(f.file).size; const w = writes();
  for (let i = 0; i < 6; i++) { f.text(`progress-${i}`); await vi.advanceTimersByTimeAsync(50); }
  await vi.advanceTimersByTimeAsync(200);
  expect(f.disk()).toEqual(f.bot.subagents.list);
  expect(f.disk()).toHaveLength(81);
  const result = { initialBytes, updates: 6, writes: w.completed.length, bytesWritten: w.completed.reduce((sum, bytes) => sum + bytes, 0), records: 81 };
  console.log("PERSISTENCE_MEASUREMENT", JSON.stringify(result));
  expect(result.writes).toBe(process.env.BOTLING_PERSISTENCE_EXPECT === "baseline" ? 6 : 1);
});
