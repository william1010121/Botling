// The agent registry (agents.json, A1): one record per agent a bot head hosts, its owner apart from its host,
// move intents written first, retention, reconcile at every start, and the first start's migration from the host books.
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRegistry, AGENTS_CAP, agentId, isDetached, newMoveId, SETTLED_KEEP_MS, type AgentRecord, type HostFacts, type MoveIntent, type StartupHost } from "../../src/core/agent-registry";
import { AgentStore, migrationRecords } from "../../src/core/store/agent-store";
import { INDEX_FORMAT } from "../../src/core/store/subagent-store";
import { safeToken } from "../../src/core/sub-bots";
import type { SubagentRecord } from "../../src/core/subagents";
import type { BotProfile } from "../../src/core/store/workspace";
import { tempDir } from "../helpers";

const A = "AAAAAAAA-0000-4000-8000-000000000001";
const B = "BBBBBBBB-0000-4000-8000-000000000002";
const C = "CCCCCCCC-0000-4000-8000-000000000003";
const codexHost: HostFacts = { botId: A, engine: "codex", sessionId: "coord-1", folder: "/w/a", kind: "codex-thread" };
const claudeHost: HostFacts = { botId: A, engine: "claude", sessionId: "parent-1", folder: "/w/a", kind: "claude-sidechain" };

function sub(id: string, more: Partial<SubagentRecord> = {}): SubagentRecord {
  return { id, description: `Task ${id}`, prompt: `Do ${id}`, status: "running", background: true, startedAt: 800_000_000, steps: [], ...more };
}

function memory(clock = () => 1_000_000) { return new AgentRegistry(null, clock); }

function moveTo(registry: AgentRegistry, record: AgentRecord, botId: string, engine: "claude" | "codex" | "agy" = "claude", end = true): MoveIntent {
  const move: MoveIntent = { id: newMoveId(), agentId: record.id, kind: "owner", from: { owner: { botId: record.owner.botId, engine: record.owner.engine } }, to: { owner: { botId, engine } }, phase: "intent", at: 1 };
  registry.beginMove(move);
  registry.commitMove(move.id);
  if (end) registry.endMove(move.id);
  return move;
}

const startup = (hosts: StartupHost[], bots: string[], now?: number) => ({ hosts, bots: new Set(bots), ...(now ? { now } : {}) });
const host = (facts: HostFacts, list: SubagentRecord[], running = false): StartupHost => ({ ...facts, running, list });

describe("observe", () => {
  it("upserts: the same native record twice is one record, unchanged the second time", () => {
    const r = memory();
    const first = r.observe(codexHost, sub("task-1", { type: "codex-worker" }));
    const rev = first.rev;
    const again = r.observe(codexHost, sub("task-1", { type: "codex-worker" }));
    expect(again).toBe(first);
    expect(again.rev).toBe(rev);
    expect(r.all).toHaveLength(1);
    expect(first).toMatchObject({ nativeId: "task-1", engine: "codex", state: "running", owner: { botId: A, engine: "codex" }, host: { botId: A, engine: "codex", kind: "codex-thread", sessionId: "coord-1" } });
    expect(first.handle).toEqual({ kind: "codex-thread", threadId: null, coordinatorSessionId: "coord-1", run: 1 });
  });

  it("follows the host's status (an app-managed worker that ended a run is idle; a Claude subagent is completed) and learns its thread", () => {
    const r = memory();
    r.observe(codexHost, sub("task-1", { type: "codex-worker" }));
    const ended = r.observe(codexHost, sub("task-1", { type: "codex-worker", status: "completed", result: "done\nmore", execution: { run: 2, ownerSessionId: "coord-1", threadId: "th-9", turnId: null } }));
    expect(ended.state).toBe("idle");
    expect(ended.summary.lastReport).toBe("done\nmore");
    expect(ended.handle).toMatchObject({ threadId: "th-9", run: 2 });
    expect(r.observe(claudeHost, sub("toolu_1", { status: "completed" })).state).toBe("completed");
    expect(r.observe(claudeHost, sub("toolu_2", { status: "failed" })).state).toBe("failed");
  });

  it("gives an id derived once from where it was first seen, which fits the contract and never changes (a move, a reload)", () => {
    const dir = tempDir("agents-id");
    const r = new AgentRegistry(new AgentStore(dir));
    const record = r.observe(codexHost, sub("task-1", { type: "codex-worker" }));
    expect(record.id).toBe(agentId(A, "codex", "task-1"));
    expect(record.id).toMatch(/^ag-[0-9a-f]{24}$/);
    moveTo(r, record, B);
    const reloaded = new AgentRegistry(new AgentStore(dir));
    expect(reloaded.fresh).toBe(false);
    expect(reloaded.byNative(A, "codex", "task-1")?.id).toBe(record.id);
    expect(reloaded.get(record.id)?.owner).toMatchObject({ botId: B, history: [{ botId: A, engine: "codex" }] });
  });
});

describe("owners and hosts", () => {
  it("movedIn / movedOut / retained follow the owner, and Settled on the owner's side is the registry's", () => {
    const r = memory();
    const record = r.observe(codexHost, sub("task-1", { type: "codex-worker" }));
    r.observe(codexHost, sub("task-2", { type: "codex-worker" }));
    expect(r.movedIn(B)).toEqual([]);
    expect(r.retained(A, "codex").size).toBe(0);
    moveTo(r, record, B);
    expect(isDetached(record)).toBe(true);
    expect(r.movedIn(B).map((x) => x.nativeId)).toEqual(["task-1"]);
    expect([...r.movedOut(A, "codex").keys()]).toEqual(["task-1"]);
    expect(r.movedOut(A, "claude").size).toBe(0);
    expect([...r.retained(A, "codex")]).toEqual(["task-1"]);
    expect(r.settle(B, "task-1", true)).toEqual({ changed: true });
    expect(r.settle(B, "task-1", true)).toEqual({ changed: false });
    expect(r.settle(A, "task-2", true)).toBeNull();
    expect(r.get(record.id)!.ownerView.settledAt).not.toBeNull();
    // Back: owner = host again; nothing moved out.
    moveTo(r, record, A, "codex");
    expect(r.movedIn(B)).toEqual([]);
    expect(r.retained(A, "codex").size).toBe(0);
    expect(r.get(record.id)!.owner.history.map((h) => h.botId)).toEqual([A, B]);
  });

  it("allows one move at a time, and a pending move keeps the record from trimming", () => {
    const r = memory();
    const record = r.observe(codexHost, sub("task-1", { type: "codex-worker" }));
    const move: MoveIntent = { id: newMoveId(), agentId: record.id, kind: "owner", from: { owner: { botId: A, engine: "codex" } }, to: { owner: { botId: B, engine: "claude" } }, phase: "intent", at: 1 };
    r.beginMove(move);
    expect(r.moving(record.id)).toBe(true);
    expect([...r.retained(A, "codex")]).toEqual(["task-1"]);
    expect(() => r.beginMove({ ...move, id: newMoveId() })).toThrow(/under way/);
    r.endMove(move.id);
    expect(r.moving(record.id)).toBe(false);
    expect(r.get(record.id)!.owner.botId).toBe(A);
  });
});

describe("retention", () => {
  it("keeps at most 2 000 records, dropping the oldest ended ones first", () => {
    const r = memory();
    const records: AgentRecord[] = [];
    for (let i = 0; i < AGENTS_CAP + 10; i++) {
      const rec = r.observe(claudeHost, sub(`toolu_${i}`, { status: "completed" }));
      rec.endedAt = 1_000 + i;
      records.push(rec);
    }
    const running = r.observe(claudeHost, sub("toolu_running"));
    r.save(true);
    expect(r.all.length).toBeLessThanOrEqual(AGENTS_CAP);
    expect(r.get(records[0]!.id)).toBeUndefined();
    expect(r.get(records.at(-1)!.id)).toBeDefined();
    expect(r.get(running.id)).toBeDefined();
  });

  it("drops an ended agent owned elsewhere 7 days after it was settled", () => {
    let now = 10_000_000_000;
    const r = memory(() => now);
    const old = r.observe(codexHost, sub("task-old", { type: "codex-worker" }));
    const recent = r.observe(codexHost, sub("task-new", { type: "codex-worker" }));
    for (const record of [old, recent]) moveTo(r, record, B);
    r.observe(codexHost, sub("task-old", { type: "codex-worker", status: "failed" }));
    r.observe(codexHost, sub("task-new", { type: "codex-worker", status: "failed" }));
    r.settle(B, "task-old", true);
    now += SETTLED_KEEP_MS - 1_000;
    r.settle(B, "task-new", true);
    now += 2_000;
    const books = [host(codexHost, [sub("task-old", { type: "codex-worker", status: "failed" }), sub("task-new", { type: "codex-worker", status: "failed" })])];
    r.reconcile(startup(books, [A, B]));
    expect(r.get(old.id)).toBeUndefined();
    expect(r.get(recent.id)).toBeDefined();
  });
});

describe("reconcile at start", () => {
  type Case = { rule: string; arrange: (r: AgentRegistry) => { id?: string; move?: MoveIntent }; hosts: StartupHost[]; bots: string[]; expect: (r: AgentRegistry, out: ReturnType<AgentRegistry["reconcile"]>, ctx: { id?: string; move?: MoveIntent }) => void };
  const worker = (id: string, more: Partial<SubagentRecord> = {}) => sub(id, { type: "codex-worker", ...more });
  const cases: Case[] = [
    {
      rule: "1. a move cut short before it committed is dropped and the owner stays",
      arrange: (r) => { const rec = r.observe(codexHost, worker("t1")); const move: MoveIntent = { id: newMoveId(), agentId: rec.id, kind: "owner", from: { owner: { botId: A, engine: "codex" } }, to: { owner: { botId: B, engine: "claude" } }, phase: "intent", at: 1 }; r.beginMove(move); return { id: rec.id, move }; },
      hosts: [host(codexHost, [worker("t1", { status: "stopped" })])], bots: [A, B],
      expect: (r, out, ctx) => { expect(r.pendingMoves).toEqual([]); expect(out.resend).toEqual([]); expect(r.get(ctx.id!)!.owner.botId).toBe(A); },
    },
    {
      rule: "1. a committed move has its notices sent again (and stays pending until they are)",
      arrange: (r) => { const rec = r.observe(codexHost, worker("t1")); const move: MoveIntent = { id: newMoveId(), agentId: rec.id, kind: "owner", from: { owner: { botId: A, engine: "codex" } }, to: { owner: { botId: B, engine: "claude" } }, phase: "intent", at: 1 }; r.beginMove(move); r.commitMove(move.id); return { id: rec.id, move }; },
      hosts: [host(codexHost, [worker("t1", { status: "stopped" })])], bots: [A, B],
      expect: (r, out, ctx) => { expect(out.resend.map((m) => m.id)).toEqual([ctx.move!.id]); expect(r.get(ctx.id!)!.owner.botId).toBe(B); },
    },
    {
      rule: "1. a notified move is dropped",
      arrange: (r) => { const rec = r.observe(codexHost, worker("t1")); const move = moveTo(r, rec, B, "claude", false); r.setPhase(move.id, "notified"); return { id: rec.id, move }; },
      hosts: [host(codexHost, [worker("t1", { status: "stopped" })])], bots: [A, B],
      expect: (r, out) => { expect(r.pendingMoves).toEqual([]); expect(out.resend).toEqual([]); },
    },
    {
      rule: "2. one in a host book but not the registry is added, owned by its host",
      arrange: () => ({}), hosts: [host(claudeHost, [sub("toolu_new", { status: "completed" })])], bots: [A],
      expect: (r, out) => { const rec = r.byNative(A, "claude", "toolu_new")!; expect(out.added).toEqual([rec.id]); expect(rec.owner.botId).toBe(A); expect(rec.state).toBe("completed"); },
    },
    {
      rule: "3. gone from the host book: kept as lost when owned elsewhere",
      arrange: (r) => { const rec = r.observe(codexHost, worker("t1")); moveTo(r, rec, B); return { id: rec.id }; },
      hosts: [host(codexHost, [])], bots: [A, B],
      expect: (r, _out, ctx) => { expect(r.get(ctx.id!)!.state).toBe("lost"); },
    },
    {
      rule: "3. gone from the host book: dropped when its host owns it",
      arrange: (r) => ({ id: r.observe(codexHost, worker("t1")).id }),
      hosts: [host(codexHost, [])], bots: [A],
      expect: (r, out, ctx) => { expect(r.get(ctx.id!)).toBeUndefined(); expect(out.dropped).toEqual([ctx.id]); },
    },
    {
      rule: "4. its host bot is gone: lost, and the owner is told",
      arrange: (r) => { const rec = r.observe(codexHost, worker("t1")); moveTo(r, rec, B); return { id: rec.id }; },
      hosts: [], bots: [B],
      expect: (r, out, ctx) => { expect(r.get(ctx.id!)!.state).toBe("lost"); expect(out.hostLost.map((x) => x.id)).toEqual([ctx.id]); },
    },
    {
      rule: "5. its owner bot is gone: back to its host, which is told",
      arrange: (r) => { const rec = r.observe(codexHost, worker("t1")); moveTo(r, rec, C); return { id: rec.id }; },
      hosts: [host(codexHost, [worker("t1", { status: "completed" })])], bots: [A],
      expect: (r, out, ctx) => { const rec = r.get(ctx.id!)!; expect(rec.owner.botId).toBe(A); expect(rec.owner.history.at(-1)).toMatchObject({ botId: C, moveId: "owner-removed" }); expect(out.ownerReverted.map((x) => x.from.botId)).toEqual([C]); },
    },
    {
      rule: "6. it was running and its host is not: interrupted",
      arrange: (r) => ({ id: r.observe(codexHost, worker("t1")).id }),
      hosts: [host(codexHost, [worker("t1", { status: "stopped" })], false)], bots: [A],
      expect: (r, out, ctx) => { expect(r.get(ctx.id!)!.state).toBe("interrupted"); expect(out.interrupted).toEqual([ctx.id]); },
    },
    {
      rule: "6. except Antigravity, whose workers restore themselves",
      arrange: (r) => ({ id: r.observe({ ...codexHost, engine: "agy", kind: "agy-acp" }, sub("agy-1", { type: "agy-worker" })).id }),
      hosts: [host({ ...codexHost, engine: "agy", kind: "agy-acp" }, [sub("agy-1", { type: "agy-worker", status: "stopped" })], false)], bots: [A],
      expect: (r, _out, ctx) => { expect(r.get(ctx.id!)!.state).toBe("running"); },
    },
  ];
  for (const c of cases) {
    it(c.rule, () => {
      const r = memory();
      const ctx = c.arrange(r);
      const out = r.reconcile(startup(c.hosts, c.bots));
      c.expect(r, out, ctx);
    });
  }

  it("botRemoved applies rules 4 and 5 at once", () => {
    const r = memory();
    const hosted = r.observe(codexHost, sub("t1", { type: "codex-worker" }));
    moveTo(r, hosted, B);
    const owned = r.observe({ ...codexHost, botId: C }, sub("t2", { type: "codex-worker" }));
    moveTo(r, owned, A);
    const own = r.observe(claudeHost, sub("toolu_x"));
    const out = r.botRemoved(A, (id) => id !== A);
    expect(out.hostLost.map((x) => x.id)).toEqual([hosted.id]);
    expect(out.ownerReverted.map((x) => x.record.id)).toEqual([owned.id]);
    expect(r.get(owned.id)!.owner.botId).toBe(C);
    expect(r.get(own.id)).toBeUndefined();
  });
});

describe("the first start (migration)", () => {
  function profile(dir: string, id: string, more: Partial<BotProfile> = {}): BotProfile {
    const storeDir = join(dir, "projects", id);
    mkdirSync(storeDir, { recursive: true });
    return { id, name: id.slice(0, 4), role: "manager", avatar: "x", folder: join(dir, "folder"), memoryPath: ".bot/memory.md", storeDir, tools: [], job: null, problem: null, ...more };
  }
  const index = (file: string, rows: unknown[]) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify({ format: INDEX_FORMAT, subagents: rows })); };

  it("adopts every host book's index: Claude, a Codex worker, an Antigravity partner's worker, and a sub bot's hand-off", () => {
    const dir = tempDir("agents-migrate");
    const claude = profile(dir, A);
    const codex = profile(dir, B);
    writeFileSync(join(codex.storeDir, "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex", "agy"] } }));
    const subBot = profile(dir, C, { parent: A, handoff: safeToken("toolu_moved"), role: "bot", job: "j" });
    writeFileSync(join(claude.storeDir, "head.json"), JSON.stringify({ sessionId: "parent-session", started: true }));
    index(join(claude.storeDir, "subagents.json"), [
      { id: "toolu_run", description: "Running one", prompt: "p", status: "running", background: true, startedAt: 800_000_000, agentID: "agent-7" },
      { id: "toolu_moved", description: "Moved one", prompt: "p", status: "stopped", background: false, startedAt: 800_000_001, endedAt: 800_000_100 },
      { id: "toolu_nested", description: "Nested", prompt: "p", status: "completed", background: false, startedAt: 800_000_002, parentID: "toolu_run" },
    ]);
    index(join(codex.storeDir, "subagents.json"), [
      { id: "task-c1", description: "Codex worker", prompt: "p", status: "completed", background: true, startedAt: 800_000_000, type: "codex-worker", execution: { run: 3, ownerSessionId: "coord", threadId: "th-1", turnId: null } },
    ]);
    index(join(codex.storeDir, "partner-agy", "subagents.json"), [
      { id: "agy-1", description: "Agy worker", prompt: "p", status: "running", background: true, startedAt: 800_000_000, type: "agy-worker", runtime: { engine: "agy" }, execution: { run: 1, ownerSessionId: "conv", threadId: "agy-session", turnId: null } },
    ]);
    const records = migrationRecords([claude, codex, subBot]);
    const by = (id: string) => records.find((record) => record.nativeId === id)!;
    expect(records.map((record) => record.nativeId).sort()).toEqual(["agy-1", "task-c1", "toolu_moved", "toolu_run"]);
    expect(by("toolu_run")).toMatchObject({ engine: "claude", state: "interrupted", owner: { botId: A, engine: "claude" }, host: { botId: A, engine: "claude", kind: "claude-sidechain" },
      handle: { kind: "claude-sidechain", parentSessionId: "parent-session", toolUseId: "toolu_run", agentId: "agent-7" } });
    expect(by("toolu_moved").succeededBy).toEqual({ kind: "subBot", botId: C });
    expect(by("task-c1")).toMatchObject({ engine: "codex", state: "idle", host: { botId: B, engine: "codex", kind: "codex-thread" }, handle: { kind: "codex-thread", threadId: "th-1", coordinatorSessionId: "coord", run: 3 } });
    expect(by("agy-1")).toMatchObject({ engine: "agy", state: "interrupted", host: { botId: B, engine: "agy", kind: "agy-acp" }, handle: { kind: "agy-session", sessionId: "agy-session", run: 1 } });
    // The native files are only read.
    expect(JSON.parse(readFileSync(join(claude.storeDir, "subagents.json"), "utf8")).subagents).toHaveLength(3);
    // Adopted once: a registry with them saved reads them back and is no longer fresh.
    const store = new AgentStore(dir);
    const registry = new AgentRegistry(store);
    expect(registry.fresh).toBe(true);
    expect(registry.adopt(records)).toBe(4);
    expect(registry.adopt(records)).toBe(0);
    expect(new AgentRegistry(new AgentStore(dir)).all).toHaveLength(4);
  });

  it("a broken agents.json is moved aside and rebuilt (deleting it is always safe)", () => {
    const dir = tempDir("agents-broken");
    writeFileSync(join(dir, "agents.json"), "{not json");
    const logs: string[] = [];
    const registry = new AgentRegistry(new AgentStore(dir, (line) => logs.push(line)));
    expect(registry.fresh).toBe(true);
    expect(logs.join("\n")).toMatch(/moved to .*agents\.json\.broken-/);
  });
});
