// Botling 3 exports for bots (src/server/exports, protocol v1 §7.5): chat.json, pins.json, subagents.json, specs.json
// and tasks.json written from server.db in the 2.x format and place. The golden tests drive the same chat through 2.x's
// FileBotStore and through DbBotStore + exports and compare the files; the timing tests use a fake clock (nothing
// sleeps): debounce after commit, at once at turn end, and stale files rewritten at start.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Event as ContractEvent } from "../../src/contract";
import { FileBotStore, type BotStore } from "../../src/core/store/bot-store";
import { HISTORY_LIMIT, type ChatRecord } from "../../src/core/store/records";
import { DbBotStores } from "../../src/server/botstore";
import { BotExports, EXPORT_FILES, type ExportResult } from "../../src/server/exports";
import type { Clock, TimerHandle } from "../../src/server/live/clock";
import { openServerStore, type ServerStore } from "../../src/server/store";

class FakeClock implements Clock {
  private t = 1_000_000;
  private timers: Array<{ at: number; run: () => void; handle: object }> = [];
  now(): number { return this.t; }
  setTimeout(run: () => void, ms: number): TimerHandle {
    const handle = {};
    this.timers.push({ at: this.t + ms, run, handle });
    return handle;
  }
  clearTimeout(handle: TimerHandle): void { this.timers = this.timers.filter((timer) => timer.handle !== handle); }
  get pending(): number { return this.timers.length; }
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.t = due.at;
      due.run();
    }
    this.t = end;
  }
}

const roots: string[] = [];
const temp = (prefix: string) => { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const uuid = (n: number) => `B0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const line = (n: number, extra: object = {}): ChatRecord => ({ id: uuid(n), role: n % 2 ? "user" : "bot", text: `line ${n}`, date: 800_000_000 + n, ...extra } as ChatRecord);
const step = (id: string, extra: object = {}) => ({ id, kind: "tool" as const, tool: "Read", title: id, failed: false, done: true, ...extra });

/** JSON with every object's keys sorted, so key order does not count. */
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])]));
  return value;
}
const readSorted = (path: string) => JSON.stringify(sorted(JSON.parse(readFileSync(path, "utf8"))));

let server: ServerStore;
let stores: DbBotStores;
let exports: BotExports;
let clock: FakeClock;
let results: ExportResult[];
let errors: unknown[];

let dataDir: string;

/** Opens server.db in `dataDir` (the same file again after `close`), the bot stores and the exports. */
async function open(options: { wire?: boolean } = {}) {
  server = await openServerStore(dataDir);
  results = []; errors = [];
  exports = new BotExports({
    openReader: () => server.openReader(),
    clock,
    settled: (botId) => stores.settled(botId),
    onError: (_botId, error) => errors.push(error),
    onExported: (result) => results.push(result),
  });
  stores = new DbBotStores(server, options.wire === false ? {} : { onCommitted: (botId, directory) => exports.committed(botId, directory) });
}

async function close() {
  exports.close();
  await stores.durable().catch(() => {});
  await stores.close();
  await server.close();
}

beforeEach(async () => { clock = new FakeClock(); dataDir = temp("botling-exports-db-"); await open(); });
afterEach(async () => { await close(); });

/** The same chat, applied to any BotStore: lines (with displays and keys 2.x does not know), pins, specs, subagents with steps, edits. */
function script(store: BotStore) {
  const lines = Array.from({ length: 6 }, (_, i) => line(i + 1));
  lines[1] = line(2, { displays: [{ component: "botling.chart", data: { points: [1, 2, 3] } }], futureKey: { kept: true } });
  store.saveMessages(lines);
  store.saveList("pins.json", [{ id: "pin-1", component: "botling.board", size: "3x2", data: { a: 1 } }]);
  store.saveList("specs.json", [{ id: "spec-1", title: "Plan", body: "do it" }]);
  store.saveList("tasks.json", [{ id: "task-1", title: "old task" }]);
  store.stageSubagentLine("sa-1", { k: "step", step: step("s1") });
  store.stageSubagentLine("sa-1", { k: "step", step: step("s2") });
  const long = "p".repeat(60_000); // longer than the index keeps
  store.commitSubagents([
    { id: "sa-1", description: "first", prompt: long, status: "running", background: false, startedAt: 1, steps: [step("s1"), step("s2")] },
    { id: "sa-2", description: "second", prompt: "", status: "completed", background: true, startedAt: 2, result: "ok" },
  ]);
  // Edits: a line changed, one inserted, one removed; a subagent finished and one removed; a pin's data saved.
  const next = [lines[0], { ...lines[1], text: "edited" }, line(99), lines[2], lines[4], lines[5], line(7)];
  store.saveMessages(next);
  store.commitSubagents([{ id: "sa-1", description: "first", prompt: long, status: "completed", background: false, startedAt: 1, endedAt: 9, toolCount: 2 }], new Set(["sa-1"]));
  store.saveList("pins.json", [{ id: "pin-1", component: "botling.board", size: "3x2", data: { a: 2 } }]);
}

function expectSameExports(fileDir: string, dbDir: string) {
  for (const name of EXPORT_FILES) {
    const twoX = join(fileDir, name), three = join(dbDir, name);
    expect(existsSync(three), name).toBe(existsSync(twoX));
    if (!existsSync(twoX)) continue;
    expect(readSorted(three), name).toBe(readSorted(twoX));
    // The same writer: the same bytes, too.
    expect(readFileSync(three, "utf8"), name).toBe(readFileSync(twoX, "utf8"));
  }
}

describe("golden: exports equal what 2.x's file store writes", () => {
  it("a scripted chat (lines, displays, pins, specs, tasks, subagents, edits) exports the same files in the same place", async () => {
    const twoX = temp("botling-exports-2x-"), three = temp("botling-exports-3x-");
    script(new FileBotStore(twoX));
    script(stores.open("bot-1", three));
    await exports.turnEnded("bot-1");
    expectSameExports(twoX, three);
    expect(JSON.parse(readFileSync(join(three, "subagents.json"), "utf8")).subagents[0].prompt).toHaveLength(50_000);
  });

  it("only the newest HISTORY_LIMIT lines, like chat.json", async () => {
    const twoX = temp("botling-exports-2x-"), three = temp("botling-exports-3x-");
    const many = Array.from({ length: HISTORY_LIMIT + 25 }, (_, i) => line(1000 + i));
    new FileBotStore(twoX).saveMessages(many);
    stores.open("bot-1", three).saveMessages(many);
    await exports.turnEnded("bot-1");
    expectSameExports(twoX, three);
    expect(JSON.parse(readFileSync(join(three, "chat.json"), "utf8"))).toHaveLength(HISTORY_LIMIT);
  });

  it("a cleared chat and an emptied subagent index are written empty, like 2.x", async () => {
    const twoX = temp("botling-exports-2x-"), three = temp("botling-exports-3x-");
    for (const store of [new FileBotStore(twoX), stores.open("bot-1", three)]) {
      store.saveMessages([line(1), line(2)]);
      store.commitSubagents([{ id: "sa-1", description: "x", prompt: "", status: "completed", background: false, startedAt: 1 }]);
    }
    await exports.turnEnded("bot-1");
    for (const store of [new FileBotStore(twoX), stores.open("bot-1", three)]) {
      store.saveMessages([]);
      store.commitSubagents([]);
    }
    await exports.turnEnded("bot-1");
    expectSameExports(twoX, three);
    expect(readFileSync(join(three, "chat.json"), "utf8")).toBe("[]");
  });

  it("a part never stored writes no file (2.x writes none either)", async () => {
    const three = temp("botling-exports-3x-");
    stores.open("bot-1", three).saveMessages([line(1)]);
    const result = await exports.turnEnded("bot-1");
    expect(result?.written).toEqual(["chat.json"]);
    for (const name of ["pins.json", "subagents.json", "specs.json", "tasks.json"]) expect(existsSync(join(three, name)), name).toBe(false);
  });
});

describe("when exports are written", () => {
  it("debounced after commit: one export debounceMs after the first commit; commits in the window join it", async () => {
    const dir = temp("botling-exports-3x-"), store = stores.open("bot-1", dir);
    store.saveMessages([line(1)]);
    await stores.durable();
    expect(exports.pending("bot-1")).toBe(true);
    clock.advance(300);
    store.saveMessages([line(1), line(2)]);
    await stores.durable();
    expect(clock.pending).toBe(1); // joined, not restarted
    clock.advance(199);
    expect(existsSync(join(dir, "chat.json"))).toBe(false);
    clock.advance(1);
    expect(results).toEqual([{ botId: "bot-1", written: ["chat.json"] }]);
    expect(JSON.parse(readFileSync(join(dir, "chat.json"), "utf8"))).toEqual([line(1), line(2)]);
    // A later commit starts a new window.
    store.saveMessages([line(1), line(2), line(3)]);
    await stores.durable();
    expect(exports.pending("bot-1")).toBe(true);
    clock.advance(500);
    expect(results).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dir, "chat.json"), "utf8"))).toHaveLength(3);
  });

  it("nothing is scheduled before the commit: exports come from server.db, never from the stores' caches", async () => {
    const dir = temp("botling-exports-3x-"), store = stores.open("bot-1", dir);
    store.saveMessages([line(1)]);
    expect(exports.pending("bot-1")).toBe(false); // submitted, not committed
    exports.exportNow("bot-1", dir);
    expect(existsSync(join(dir, "chat.json"))).toBe(false); // nothing committed yet
    await stores.durable();
    clock.advance(500);
    expect(JSON.parse(readFileSync(join(dir, "chat.json"), "utf8"))).toEqual([line(1)]);
  });

  it("a write that did not change an export does not rewrite it", async () => {
    const dir = temp("botling-exports-3x-"), store = stores.open("bot-1", dir);
    store.saveMessages([line(1)]);
    store.saveList("pins.json", [{ id: "p" }]);
    await stores.durable();
    clock.advance(500);
    expect(results.at(-1)?.written).toEqual(["chat.json", "pins.json"]);
    store.saveSetting("unread", 2);
    await stores.durable();
    clock.advance(500);
    expect(results.at(-1)?.written).toEqual([]);
  });

  it("at turn end: at once, after the bot's writes in flight committed, and the debounce timer is dropped", async () => {
    const dir = temp("botling-exports-3x-"), store = stores.open("bot-1", dir);
    store.saveMessages([line(1)]);
    await stores.durable();
    expect(clock.pending).toBe(1);
    store.saveMessages([line(1), line(2)]); // still in flight when the turn ends
    const finished = { type: "turn.finished", botId: "bot-1", turnId: "t-1", messageId: uuid(2), status: "done", text: "line 2" } as ContractEvent;
    const result = await exports.feed(finished);
    expect(result?.written).toEqual(["chat.json"]);
    expect(JSON.parse(readFileSync(join(dir, "chat.json"), "utf8"))).toEqual([line(1), line(2)]);
    expect(exports.pending("bot-1")).toBe(false);
    expect(exports.feed({ type: "turn.delta", botId: "bot-1", turnId: "t-1", messageId: uuid(2), text: "x" } as ContractEvent)).toBeNull();
  });

  it("close writes the exports still waiting for their timer", async () => {
    const dir = temp("botling-exports-3x-");
    stores.open("bot-1", dir).saveMessages([line(1)]);
    await stores.durable();
    exports.close();
    expect(JSON.parse(readFileSync(join(dir, "chat.json"), "utf8"))).toEqual([line(1)]);
  });

  it("an export that fails is reported and the next one tries again", async () => {
    const parent = temp("botling-exports-3x-"), dir = join(parent, "bot");
    writeFileSync(dir, "a file where the folder should be");
    stores.open("bot-1", dir).saveMessages([line(1)]);
    await stores.durable();
    clock.advance(500);
    expect(errors).toHaveLength(1);
    rmSync(dir);
    stores.open("bot-1", dir).saveMessages([line(1), line(2)]);
    await stores.durable();
    clock.advance(500);
    expect(JSON.parse(readFileSync(join(dir, "chat.json"), "utf8"))).toHaveLength(2);
  });
});

describe("at start: stale exports are rewritten", () => {
  it("rewrites missing, older, hand-edited or broken files and leaves current ones alone", async () => {
    await close();
    await open({ wire: false }); // writes without exports, as if botlingd stopped before exporting
    const dir = temp("botling-exports-3x-"), store = stores.open("bot-1", dir);
    store.saveMessages([line(1), line(2)]);
    store.saveList("pins.json", [{ id: "p", data: 1 }]);
    store.saveList("specs.json", [{ id: "s" }]);
    store.commitSubagents([{ id: "sa-1", description: "x", prompt: "", status: "completed", background: false, startedAt: 1 }]);
    await stores.durable();
    writeFileSync(join(dir, "chat.json"), JSON.stringify([line(1)])); // older
    writeFileSync(join(dir, "pins.json"), JSON.stringify([{ id: "p", data: 1 }])); // current
    writeFileSync(join(dir, "subagents.json"), "{ broken"); // unreadable
    // specs.json missing
    const twoX = temp("botling-exports-2x-");
    const reference = new FileBotStore(twoX);
    reference.saveMessages([line(1), line(2)]);
    reference.saveList("pins.json", [{ id: "p", data: 1 }]);
    reference.saveList("specs.json", [{ id: "s" }]);
    reference.commitSubagents([{ id: "sa-1", description: "x", prompt: "", status: "completed", background: false, startedAt: 1 }]);

    const fresh = new BotExports({ openReader: () => server.openReader(), clock });
    try {
      const started = fresh.start([{ botId: "bot-1", directory: dir }]);
      expect(started).toEqual([{ botId: "bot-1", written: ["chat.json", "subagents.json", "specs.json"] }]);
      expectSameExports(twoX, dir);
      // A second start finds everything current.
      expect(fresh.start([{ botId: "bot-1", directory: dir }])).toEqual([{ botId: "bot-1", written: [] }]);
      expect(clock.pending).toBe(0); // at start: written at once, no timer
    } finally { fresh.close(); }
  });

  it("the files are never read back: a hand edit changes nothing stored and the next export replaces it", async () => {
    const dir = temp("botling-exports-3x-"), store = stores.open("bot-1", dir);
    store.saveMessages([line(1)]);
    await exports.turnEnded("bot-1");
    writeFileSync(join(dir, "chat.json"), JSON.stringify([line(50)]));
    await close();
    await open();
    const again = stores.open("bot-1", dir);
    expect(again.loadMessages().records).toEqual([line(1)]);
    again.saveMessages([line(1), line(2)]);
    await exports.turnEnded("bot-1");
    expect(JSON.parse(readFileSync(join(dir, "chat.json"), "utf8"))).toEqual([line(1), line(2)]);
  });
});
