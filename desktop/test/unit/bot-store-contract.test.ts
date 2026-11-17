// The BotStore interface, the same assertions against 2.x's files and Botling 3's server.db rows; then what only the
// db store promises (row diffs by id and revision, read-your-writes before commit, failures, the .jsonl tail rule).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOT_STORES, useBotStores } from "../bot-store-impls";
import { HISTORY_LIMIT, type ChatRecord } from "../../src/core/store/records";
import { SubagentStore } from "../../src/core/store/subagent-store";
import { DbBotStores, type BotStoreBackend } from "../../src/server/botstore";
import { openServerStore, type Db, type ServerStore } from "../../src/server/store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const folder = () => { const root = mkdtempSync(join(tmpdir(), "botling-botstore-folder-")); roots.push(root); return root; };
const uuid = (n: number) => `A0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const line = (n: number, extra: object = {}): ChatRecord => ({ id: uuid(n), role: n % 2 ? "user" : "bot", text: `line ${n}`, date: 800_000_000 + n, ...extra } as ChatRecord);
const step = (id: string, extra: object = {}) => ({ id, kind: "tool" as const, tool: "Read", title: id, failed: false, done: true, ...extra });
const base = { description: "", prompt: "", status: "completed", background: false, startedAt: 1 };

describe.each(BOT_STORES)("$name store", (impl) => {
  useBotStores();

  it("an empty bot reads as empty", () => {
    const store = impl.open(folder());
    expect(store.loadMessages()).toEqual({ records: [], dropped: 0 });
    expect(store.loadSettings()).toEqual({});
    expect([store.loadUnread(), store.loadModel(), store.loadAlwaysAllowed()]).toEqual([0, null, []]);
    for (const name of ["pins.json", "specs.json", "tasks.json", "subagents.json"] as const) expect(store.loadList(name)).toEqual([]);
    expect(store.loadHead()).toBeNull();
    expect(store.readSubagentSteps("nobody")).toEqual({ runs: [], steps: [] });
  });

  it("chat lines keep every key, their order and the newest HISTORY_LIMIT; edits, inserts and removals read back", async () => {
    const dir = folder(), store = impl.open(dir);
    const lines = Array.from({ length: 5 }, (_, i) => line(i + 1));
    lines[2] = line(3, { futureKey: { kept: true }, seenBy: ["claude"] });
    store.saveMessages(lines);
    expect(store.loadMessages().records).toEqual(lines);
    // Edit one, insert one in the middle, remove one, append one.
    const next = [lines[0], { ...lines[1], text: "edited" }, line(99), lines[2], lines[4], line(6)];
    store.saveMessages(next);
    expect(store.loadMessages().records).toEqual(next);
    expect(impl.open(dir).loadMessages().records).toEqual(next);
    await impl.reopen();
    expect(impl.open(dir).loadMessages()).toEqual({ records: next, dropped: 0 });
    // Only the newest HISTORY_LIMIT lines are kept.
    const many = Array.from({ length: HISTORY_LIMIT + 20 }, (_, i) => line(1000 + i));
    impl.open(dir).saveMessages(many);
    await impl.reopen();
    expect(impl.open(dir).loadMessages().records).toEqual(many.slice(-HISTORY_LIMIT));
  });

  it("lines 1.x would not decode are counted as dropped and left out", async () => {
    const dir = folder(), store = impl.open(dir);
    store.saveMessages([line(1), { id: "m-1", role: "user", text: "x", date: 1 } as ChatRecord, line(2)]);
    await impl.reopen();
    expect(impl.open(dir).loadMessages()).toEqual({ records: [line(1), line(2)], dropped: 1 });
  });

  it("settings: one key at a time, the others kept; undefined removes a key; typed readers validate", async () => {
    const dir = folder(), store = impl.open(dir);
    store.saveSetting("unread", 3);
    store.saveSetting("alwaysAllowed", ["WebFetch", 7, "Bash(npm test)"]);
    store.saveSetting("model", "opus");
    store.saveSetting("futureKey", { kept: true });
    store.saveSetting("gone", 1);
    store.saveSetting("gone", undefined);
    expect(store.loadSettings()).toEqual({ unread: 3, alwaysAllowed: ["WebFetch", 7, "Bash(npm test)"], model: "opus", futureKey: { kept: true } });
    await impl.reopen();
    const again = impl.open(dir);
    expect([again.loadUnread(), again.loadModel(), again.loadAlwaysAllowed()]).toEqual([3, "opus", ["WebFetch", "Bash(npm test)"]]);
    again.saveSetting("model", "not a model!");
    again.saveSetting("unread", -2);
    expect([again.loadUnread(), again.loadModel()]).toEqual([0, null]);
    // A returned object is a copy: changing it changes nothing stored.
    again.loadSettings().unread = 50;
    expect(again.loadUnread()).toBe(0);
  });

  it("lists and the head session round-trip", async () => {
    const dir = folder(), store = impl.open(dir);
    store.saveList("pins.json", [{ id: "p", text: "pinned" }]);
    store.saveList("specs.json", [{ id: "s" }, { id: "t" }]);
    store.saveList("tasks.json", []);
    store.saveHead({ sessionId: "S1", started: false });
    expect(store.loadHead()).toEqual({ sessionId: "S1", started: false });
    store.saveHead({ sessionId: "S1", started: true, promptHash: "h" });
    await impl.reopen();
    const again = impl.open(dir);
    expect(again.loadList("pins.json")).toEqual([{ id: "p", text: "pinned" }]);
    expect(again.loadList("specs.json")).toEqual([{ id: "s" }, { id: "t" }]);
    expect(again.loadList("tasks.json")).toEqual([]);
    expect(again.loadHead()).toEqual({ sessionId: "S1", started: true, promptHash: "h" });
  });

  it("subagents: the index without steps, steps appended per subagent, unchanged ids keep their entry, removed ones lose their steps", async () => {
    const dir = folder(), store = impl.open(dir);
    store.stageSubagentLine("a", { k: "step", step: step("a1") as any });
    store.stageSubagentLine("a", { k: "patch", id: "a1", set: { output: "out" } as any });
    store.stageSubagentLine("b", { k: "step", step: step("b1") as any });
    store.saveList("subagents.json", [{ id: "a", ...base, steps: [step("a1")], previousRuns: [] }, { id: "b", ...base }]);
    expect(store.loadList("subagents.json")).toEqual([{ id: "a", ...base }, { id: "b", ...base }]);
    expect(store.readSubagentSteps("a").steps).toEqual([{ ...step("a1"), output: "out" }]);
    // Only "b" is marked changed: "a" keeps the entry it had.
    store.stageSubagentLine("a", { k: "run", run: { prompt: "first", status: "completed" } });
    store.stageSubagentLine("a", { k: "step", step: step("a2") as any });
    store.commitSubagents([{ id: "b", ...base, status: "failed" }, { id: "a", ...base, status: "running" }], new Set(["b"]));
    expect(store.loadList("subagents.json")).toEqual([{ id: "b", ...base, status: "failed" }, { id: "a", ...base }]);
    const history = store.readSubagentSteps("a");
    expect(history.runs).toEqual([{ run: { prompt: "first", status: "completed" }, steps: [{ ...step("a1"), output: "out" }] }]);
    expect(history.steps).toEqual([step("a2")]);
    await impl.reopen();
    const again = impl.open(dir);
    expect(again.loadList("subagents.json")).toEqual([{ id: "b", ...base, status: "failed" }, { id: "a", ...base }]);
    expect(again.readSubagentSteps("a").steps).toEqual([step("a2")]);
    // "b" leaves the list: its steps go with it; a later subagent of the same id starts empty.
    again.commitSubagents([{ id: "a", ...base }]);
    expect(again.readSubagentSteps("b")).toEqual({ runs: [], steps: [] });
    again.stageSubagentLine("b", { k: "step", step: step("b9") as any });
    again.commitSubagents([{ id: "a", ...base }, { id: "b", ...base }]);
    expect(again.readSubagentSteps("b").steps).toEqual([step("b9")]);
    await impl.reopen();
    expect(impl.open(dir).readSubagentSteps("b").steps).toEqual([step("b9")]);
    expect(impl.open(dir).loadList("subagents.json")).toEqual([{ id: "a", ...base }, { id: "b", ...base }]);
  });

  it("flushSubagents appends the staged steps without touching the index", async () => {
    const dir = folder(), store = impl.open(dir);
    store.commitSubagents([{ id: "w", ...base }]);
    store.stageSubagentLine("w", { k: "step", step: step("s1") as any });
    store.flushSubagents();
    await impl.reopen();
    const again = impl.open(dir);
    expect(again.readSubagentSteps("w").steps).toEqual([step("s1")]);
    expect(again.loadList("subagents.json")).toEqual([{ id: "w", ...base }]);
  });
});

// ── db only ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const servers: ServerStore[] = [];
const dataDirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function server(): Promise<ServerStore> {
  const dir = mkdtempSync(join(tmpdir(), "botling-botstore-db-"));
  dataDirs.push(dir);
  const store = await openServerStore(dir);
  servers.push(store);
  return store;
}
/** A backend that counts the row writes (`run`) of every command. */
function counting(store: ServerStore) {
  const runs: string[] = [];
  const backend: BotStoreBackend = {
    openReader: () => store.openReader(),
    submit: (command) => store.submit((db, context) => command(new Proxy(db, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key);
        return (sql: string) => {
          const statement = target.prepare(sql);
          return { ...statement, run: (...params: Parameters<typeof statement.run>) => { runs.push(sql.split(" ")[0]); return statement.run(...params); } };
        };
      },
    }) as Db, context)),
  };
  return { backend, runs };
}

describe("DbBotStore", () => {
  it("diffs chat lines by id and revision: an append writes one row, an edit one row, unchanged lines nothing", async () => {
    const db = await server(), { backend, runs } = counting(db), hosts = new DbBotStores(backend);
    const store = hosts.open("bot", folder());
    const lines = Array.from({ length: HISTORY_LIMIT }, (_, i) => line(i));
    store.saveMessages(lines);
    await store.durable();
    expect(runs.length).toBe(HISTORY_LIMIT);
    runs.length = 0;
    store.saveMessages(lines);
    await store.durable();
    expect(runs).toEqual([]);
    // Appending at the limit: the new line is put and the oldest deleted.
    const more = [...lines, line(HISTORY_LIMIT)];
    store.saveMessages(more);
    await store.durable();
    expect(runs.sort()).toEqual(["DELETE", "INSERT"]);
    runs.length = 0;
    const edited = more.slice(-HISTORY_LIMIT);
    edited[10] = { ...edited[10], text: "edited" };
    store.saveMessages(edited);
    await store.durable();
    expect(runs).toEqual(["INSERT"]);
    const reader = db.openReader();
    try {
      const revs = reader.prepare("SELECT rev, COUNT(*) AS n FROM rows WHERE stream = 'chat:bot' GROUP BY rev ORDER BY rev").all();
      expect(revs).toEqual([{ rev: 1, n: HISTORY_LIMIT - 1 }, { rev: 2, n: 1 }]);
      // The log's read model (`messages`) is not touched.
      expect(reader.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    } finally { reader.close(); }
    await hosts.close();
  });

  it("an unchanged subagent entry is not rewritten; changedIds limits what is re-encoded", async () => {
    const db = await server(), { backend, runs } = counting(db), hosts = new DbBotStores(backend);
    const store = hosts.open("bot", folder());
    const list = Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, ...base }));
    store.commitSubagents(list);
    await store.durable();
    runs.length = 0;
    list[5] = { ...list[5], status: "running" };
    store.commitSubagents(list);
    await store.durable();
    expect(runs).toEqual(["INSERT"]);
    runs.length = 0;
    store.commitSubagents(list);
    await store.durable();
    expect(runs).toEqual([]);
    await hosts.close();
  });

  it("reads its own writes before they commit; durable() resolves once they are committed", async () => {
    const db = await server(), hosts = new DbBotStores(db);
    const store = hosts.open("bot", folder());
    store.saveMessages([line(1)]);
    store.saveSetting("unread", 2);
    store.stageSubagentLine("w", { k: "step", step: step("s") as any });
    store.commitSubagents([{ id: "w", ...base }]);
    expect(db.writer.queued).toBeGreaterThan(0);
    const other = hosts.open("bot", folder());
    expect(other.loadMessages().records).toEqual([line(1)]);
    expect(other.loadUnread()).toBe(2);
    expect(other.readSubagentSteps("w").steps).toEqual([step("s")]);
    await store.durable();
    expect(db.writer.queued).toBe(0);
    const reader = db.openReader();
    try {
      expect(reader.prepare("SELECT COUNT(*) AS n FROM rows WHERE stream = 'chat:bot'").get()).toEqual({ n: 1 });
      expect(reader.prepare("SELECT unread FROM bots WHERE botId = 'bot'").get()).toEqual({ unread: 2 });
    } finally { reader.close(); }
    await hosts.close();
  });

  it("a failed commit fails the bot's store: durable() rejects and the next save throws", async () => {
    const db = await server();
    let fail = false;
    const hosts = new DbBotStores({
      openReader: () => db.openReader(),
      submit: (command) => fail ? Promise.reject(new Error("disk full")) : db.submit(command),
    });
    const store = hosts.open("bot", folder());
    store.saveSetting("unread", 1);
    await store.durable();
    fail = true;
    store.saveSetting("unread", 2);
    await expect(store.durable()).rejects.toThrow("disk full");
    expect(() => store.saveMessages([line(1)])).toThrow("disk full");
    expect(() => hosts.open("bot", folder()).saveHead({ sessionId: "s", started: true })).toThrow("disk full");
    // Other bots are not affected.
    fail = false;
    const other = hosts.open("other", folder());
    other.saveSetting("unread", 1);
    await other.durable();
    await hosts.close();
  });

  it("the steps tail keeps the same lines as the .jsonl reader for any byte bound", async () => {
    const db = await server(), hosts = new DbBotStores(db);
    const dir = folder();
    const files = new SubagentStore(dir), store = hosts.open("bot", dir);
    for (let i = 0; i < 60; i++) {
      const text = { k: "step" as const, step: step(`s${i}`, { output: "x".repeat((i * 37) % 300) }) as any };
      files.stage("w", text);
      store.stageSubagentLine("w", text);
      if (i % 7 === 0) { files.flush(); store.flushSubagents(); }
      if (i === 30) await store.durable(); // part committed, part in flight
    }
    files.flush();
    store.flushSubagents();
    const bounds = [1, 50, 120, 333, 1000, 4096, 9000, 1_000_000];
    const compare = () => { for (const max of bounds) expect(store.readSubagentSteps("w", max)).toEqual(files.readSteps("w", max)); };
    compare();
    await store.durable();
    compare();
    // Exact line boundaries, too.
    const lines = files.readSteps("w").steps.length;
    expect(lines).toBe(60);
    await hosts.close();
  });

  describe("chat rows are parsed once", () => {
    const chatKey = (db: ServerStore, id: string) => {
      const reader = db.openReader();
      try { return String(reader.prepare("SELECT key FROM rows WHERE stream = 'chat:bot' AND key = ?").get(id)?.key); } finally { reader.close(); }
    };

    /** The lines persisted by one host, then a fresh host (its cache empty) that will read them. */
    async function persisted(count: number) {
      const db = await server(), { backend, runs } = counting(db);
      const first = new DbBotStores(backend);
      const lines = Array.from({ length: count }, (_, i) => line(i));
      const writer = first.open("bot", folder());
      writer.saveMessages(lines);
      await writer.durable();
      await first.close();
      return { db, backend, runs, lines, hosts: new DbBotStores(backend) };
    }
    const countsOfLines = () => {
      const parse = vi.spyOn(JSON, "parse"), stringify = vi.spyOn(JSON, "stringify");
      return {
        chatParses: () => parse.mock.calls.filter(([text]) => typeof text === "string" && text.startsWith('{"seq":')).length,
        recordStringifies: () => stringify.mock.calls.filter(([value]) => value !== null && typeof value === "object" && "role" in (value as object)).length,
      };
    };

    it("a fresh load parses each stored row once and stringifies none; the records are the saved ones", async () => {
      const { lines, hosts } = await persisted(40);
      const counts = countsOfLines();
      try {
        const store = hosts.open("bot", folder());
        const loaded = store.loadMessages();
        expect(loaded.records).toEqual(lines);
        expect(counts.chatParses()).toBe(40);
        expect(counts.recordStringifies()).toBe(0);
        // Loading again hands out copies of the same lines.
        const again = store.loadMessages();
        expect(again.records).toEqual(lines);
        expect(counts.chatParses()).toBeLessThanOrEqual(80);
      } finally { vi.restoreAllMocks(); }
      await hosts.close();
    });

    it("a record the caller changed does not change what the store holds; saving the original lines writes nothing", async () => {
      const { lines, hosts, runs } = await persisted(5);
      const store = hosts.open("bot", folder());
      const first = store.loadMessages().records;
      (first[2] as { text: string }).text = "scribbled";
      first.pop();
      expect(store.loadMessages().records).toEqual(lines);
      runs.length = 0;
      store.saveMessages(lines);
      await store.durable();
      expect(runs).toEqual([]);
      // The edit the caller made is one write.
      store.saveMessages(first);
      await store.durable();
      expect(runs.sort()).toEqual(["DELETE", "INSERT"]);
      await hosts.close();
    });

    it("a save before any load does not keep the parsed lines (they are parsed again from their text when loaded)", async () => {
      const { lines, hosts, runs } = await persisted(6);
      const store = hosts.open("bot", folder());
      runs.length = 0;
      store.saveMessages(lines);
      await store.durable();
      expect(runs).toEqual([]);
      const held = [...(store as unknown as { state: { messages: Map<string, { parsed?: unknown }> } }).state.messages.values()];
      expect(held).toHaveLength(6);
      expect(held.every((row) => row.parsed === undefined)).toBe(true);
      expect(store.loadMessages().records).toEqual(lines);
      await hosts.close();
    });

    it("a row whose seq and record are cut from the stored text but whose record text is spaced is not rewritten while unchanged, and an edit writes one row", async () => {
      const { db, lines, hosts, runs } = await persisted(4);
      const spaced = chatKey(db, lines[1].id);
      await db.submit((tx) => {
        const stored = JSON.parse(String(tx.prepare("SELECT body FROM rows WHERE stream = 'chat:bot' AND key = ?").get(spaced)?.body)) as { seq: number; record: unknown };
        // The head is the compact one chatBody writes, so the record's own text is taken as stored, spaces and all.
        tx.prepare("UPDATE rows SET body = ? WHERE stream = 'chat:bot' AND key = ?").run(`{"seq":${stored.seq},"record":${JSON.stringify(stored.record, null, 2)}}`, spaced);
      });
      const store = hosts.open("bot", folder());
      expect(store.loadMessages().records).toEqual(lines);
      runs.length = 0;
      store.saveMessages(lines);
      await store.durable();
      expect(runs).toEqual([]);
      store.saveMessages(lines.map((l, i) => i === 1 ? { ...l, text: "edited" } : l) as ChatRecord[]);
      await store.durable();
      expect(runs).toEqual(["INSERT"]);
      await hosts.close();
    });

    it("a stored line that is not in the canonical form, or has an extra key, is not rewritten while it is unchanged, and an edit writes exactly one row", async () => {
      const { db, lines, hosts, runs } = await persisted(4);
      // Row 1: the same data with spaces in it. Row 2: an extra key beside seq and record (a hand-made row).
      const spaced = chatKey(db, lines[1].id), extra = chatKey(db, lines[2].id);
      await db.submit((tx) => {
        const pick = (key: string) => JSON.parse(String(tx.prepare("SELECT body FROM rows WHERE stream = 'chat:bot' AND key = ?").get(key)?.body)) as { seq: number; record: unknown };
        const a = pick(spaced), b = pick(extra);
        tx.prepare("UPDATE rows SET body = ? WHERE stream = 'chat:bot' AND key = ?").run(JSON.stringify(a, null, 2), spaced);
        tx.prepare("UPDATE rows SET body = ? WHERE stream = 'chat:bot' AND key = ?").run(JSON.stringify({ ...b, note: "x" }), extra);
      });
      const store = hosts.open("bot", folder());
      expect(store.loadMessages().records).toEqual(lines);
      runs.length = 0;
      store.saveMessages(lines);
      await store.durable();
      expect(runs).toEqual([]);
      const edited = lines.map((l, i) => i === 1 ? { ...l, text: "edited" } : l) as ChatRecord[];
      store.saveMessages(edited);
      await store.durable();
      expect(runs).toEqual(["INSERT"]);
      await hosts.close();
    });
  });
});
