// Snapshot entries stored as diffs (src/server/log/log-store.ts, plan db-compaction D1) and D0 (a redraw of the state the
// log already holds stores nothing): round trips with the hash, baseline cadence, reads from the middle of a chain, eviction
// across a baseline, a corrupt diff, an old database, rollbacks, and who may read `entries.body`.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Event as ContractEvent } from "../../src/contract";
import { canonicalJson, GENESIS_HASH, type Entry, type Message, type StreamId } from "../../src/protocol";
import { TxScope } from "../../src/server/effects/scope";
import { EventTap } from "../../src/server/effects/tap";
import {
  appendEntries, ensureStream, evictEntries, hashEntry, LogHub, readEntries, readStream, sameAsStored, verifyStream,
} from "../../src/server/log";
import { MAX_DIFFS_PER_BASE } from "../../src/server/log/log-store";
import { migrate, MIGRATIONS, type Db } from "../../src/server/store";
import { openDb } from "../../src/server/store/sqlite";
import { FakeFe, quickStore, type QuickStore } from "./server-log-helpers";

const A = "bot:alpha" as StreamId;
const stores: QuickStore[] = [];
const hubs: LogHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  for (const store of stores.splice(0)) await store.close();
});
async function setup(...streams: StreamId[]) {
  const store = quickStore();
  stores.push(store);
  await store.submit((db) => { for (const stream of streams) ensureStream(db, stream); });
  return store;
}

const TIME = "2026-11-14T00:00:00.000Z";
const FILLER = "lorem ipsum dolor sit amet ".repeat(30); // a body well over the smallest size that is diffed
const line = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, role: "bot", text: `${FILLER}${text}`, time: TIME, ...extra });
const upd = (id: string, text: string, extra?: Record<string, unknown>) => ({ kind: "message.updated", body: { botId: "alpha", message: line(id, text, extra) } });
const raw = (db: Db, stream: string) => db.prepare("SELECT seq, kind, okey, base, length(body) AS n, hash FROM entries WHERE stream = ? ORDER BY seq").all(stream);
const readAll = (db: Db, stream: string, from = 1) => readEntries(db, stream, from, { maxEntries: 100_000, maxBytes: 1e12 });

describe("snapshot entries stored as diffs", () => {
  it("round trips bit-identical, hash included, and most rows really are diffs", async () => {
    const store = await setup(A);
    const sent: Entry[] = [];
    await store.submit((db) => {
      for (let i = 0; i < 30; i++) sent.push(...appendEntries(db, A, [upd("m1", "word ".repeat(i + 1), { turnId: `t${i % 3}` })]));
      sent.push(...appendEntries(db, A, [{ kind: "turn.started", body: { botId: "alpha", turnId: "t9", messageId: "m1" } }]));
    });
    const rows = raw(store.db, A);
    expect(rows.filter((r) => r.base !== null).length).toBeGreaterThan(20);
    expect(rows.every((r) => r.kind === "message.updated" ? r.okey === "m:m1" : r.okey === null)).toBe(true);
    const diffBytes = rows.filter((r) => r.base !== null).reduce((sum, r) => sum + Number(r.n), 0);
    const fullBytes = sent.filter((e) => e.kind === "message.updated").reduce((sum, e) => sum + canonicalJson(e.body).length, 0);
    expect(diffBytes * 10).toBeLessThan(fullBytes);
    const read = readAll(store.db, A);
    expect(read.unreadable).toBeUndefined();
    expect(read.entries).toEqual(sent);
    for (const [index, entry] of read.entries.entries()) expect(canonicalJson(entry.body)).toBe(canonicalJson(sent[index].body));
    expect(verifyStream(store.db, A)).toMatchObject({ ok: true });
  });

  it("reads from the middle of a chain, with small pages, and from a fresh connection", async () => {
    const store = await setup(A);
    const sent: Entry[] = [];
    await store.submit((db) => { for (let i = 0; i < 40; i++) sent.push(...appendEntries(db, A, [upd(i % 2 ? "m1" : "m2", "word ".repeat(Math.floor(i / 2) + 1))])); });
    const reader = store.openReader();
    for (const from of [1, 2, 7, 20, 33, 40]) {
      expect(readAll(reader, A, from).entries).toEqual(sent.slice(from - 1));
      const page = readEntries(reader, A, from, { maxEntries: 3, maxBytes: 1e12 });
      expect(page.entries).toEqual(sent.slice(from - 1, from + 2));
    }
  });

  it("objects do not mix: two objects and two streams each hang on their own baseline", async () => {
    const store = await setup(A, "bot:beta" as StreamId);
    await store.submit((db) => {
      for (let i = 0; i < 6; i++) {
        appendEntries(db, A, [upd("m1", `a${i}`), upd("m2", `b${i}`)]);
        appendEntries(db, "bot:beta" as StreamId, [{ kind: "message.updated", body: { botId: "beta", message: line("m1", `c${i}`) } }]);
      }
    });
    for (const stream of [A, "bot:beta" as StreamId]) {
      expect(verifyStream(store.db, stream)).toMatchObject({ ok: true });
      for (const row of raw(store.db, stream)) {
        if (row.base === null) continue;
        const base = store.db.prepare("SELECT okey, base FROM entries WHERE stream = ? AND seq = ?").get(stream, row.base);
        expect(base).toMatchObject({ okey: row.okey, base: null });
      }
    }
  });

  it("baseline cadence: at most 200 diffs per baseline, and a new baseline once the diffs outweigh one whole body", async () => {
    const store = await setup(A);
    // Tiny changes: the count limit decides.
    const huge = "z".repeat(40_000); // a body so big that 200 tiny patches stay below its size: only the count limit can cut the chain
    await store.submit((db) => { for (let i = 0; i < 2 * MAX_DIFFS_PER_BASE + 5; i++) appendEntries(db, A, [{ kind: "message.updated", body: { botId: "alpha", message: { id: "m1", role: "bot", text: huge, time: TIME, chosen: i % 7 } } }]); });
    const baselines = raw(store.db, A).filter((r) => r.base === null).map((r) => Number(r.seq));
    expect(baselines[0]).toBe(1);
    for (let i = 1; i < baselines.length; i++) expect(baselines[i] - baselines[i - 1]).toBeLessThanOrEqual(MAX_DIFFS_PER_BASE + 1);
    expect(baselines).toHaveLength(3); // 1, 202, 403: exactly MAX_DIFFS_PER_BASE diffs hang on each baseline
    expect(baselines[1] - baselines[0]).toBe(MAX_DIFFS_PER_BASE + 1);
    expect(raw(store.db, A).filter((r) => r.base !== null)).not.toHaveLength(0);
    expect(verifyStream(store.db, A)).toMatchObject({ ok: true });

    // Big changes: total diff bytes pass the baseline's size long before 200 diffs.
    const other = "bot:gamma" as StreamId;
    await store.submit((db) => {
      ensureStream(db, other);
      for (let i = 0; i < 20; i++) appendEntries(db, other, [{ kind: "message.updated", body: { botId: "gamma", message: line("m1", "", { answer: `${i}`.repeat(200) }) } }]);
    });
    const rows = raw(store.db, other);
    expect(rows.filter((r) => r.base === null).length).toBeGreaterThan(3);
    let sinceBase = 0;
    let baseSize = 0;
    for (const row of rows) {
      if (row.base === null) { baseSize = Number(row.n); sinceBase = 0; } else { sinceBase += Number(row.n); expect(sinceBase).toBeLessThanOrEqual(baseSize); }
    }
    expect(verifyStream(store.db, other)).toMatchObject({ ok: true });
  });

  it("small bodies, other kinds, and the srv: stream are stored whole", async () => {
    const srv = "srv:server1" as StreamId;
    const store = await setup(A, srv);
    await store.submit((db) => {
      for (let i = 0; i < 4; i++) appendEntries(db, A, [{ kind: "message.updated", body: { botId: "alpha", message: { id: "tiny", role: "bot", text: `${i}`, time: TIME } } }]);
      for (let i = 0; i < 4; i++) appendEntries(db, A, [{ kind: "turn.started", body: { botId: "alpha", turnId: `t${i}`, messageId: "tiny" } }]);
      for (let i = 0; i < 4; i++) appendEntries(db, srv, [{ kind: "message.updated", body: { botId: "alpha", message: line("m1", `${i}`) } }]);
    });
    expect(raw(store.db, A).every((r) => r.base === null)).toBe(true);
    expect(raw(store.db, srv).every((r) => r.base === null)).toBe(true);
    expect(raw(store.db, srv).every((r) => r.okey === "m:m1")).toBe(true);
    expect(readAll(store.db, srv).entries).toHaveLength(4);
  });

  it("a rolled-back append leaves the writer's cache honest: the next diff hangs on what is stored", async () => {
    const store = await setup(A);
    await store.submit((db) => { appendEntries(db, A, [upd("m1", "one")]); appendEntries(db, A, [upd("m1", "one two")]); });
    await store.submit((db) => {
      db.exec("SAVEPOINT s");
      appendEntries(db, A, [upd("m1", "one two THREE (rolled back)")]);
      db.exec("ROLLBACK TO s");
      db.exec("RELEASE s");
    });
    await store.submit((db) => { appendEntries(db, A, [upd("m1", "one two four")]); });
    expect(readStream(store.db, A)!.head).toBe(3);
    const read = readAll(store.db, A);
    expect(read.unreadable).toBeUndefined();
    expect((read.entries[2].body as { message: { text: string } }).message.text).toBe(`${FILLER}one two four`);
    expect(verifyStream(store.db, A)).toMatchObject({ ok: true });
  });

  it("a restart (a cold cache) continues the chain from the table", async () => {
    const store = await setup(A);
    await store.submit((db) => { for (let i = 0; i < 5; i++) appendEntries(db, A, [upd("m1", "word ".repeat(i + 1))]); });
    const baseBefore = raw(store.db, A).at(-1)!.base;
    // A second connection has no cache: a writer that reopened the file.
    const file = store.db.path;
    const db2 = openDb(file);
    db2.exec("PRAGMA busy_timeout = 5000");
    try {
      db2.exec("BEGIN IMMEDIATE");
      appendEntries(db2, A, [upd("m1", "word ".repeat(9))]);
      db2.exec("COMMIT");
    } finally { db2.close(); }
    const rows = raw(store.db, A);
    expect(rows.at(-1)!.base).toBe(baseBefore); // it hung on the same baseline: the chain was rebuilt from the rows
    expect(readAll(store.db, A).unreadable).toBeUndefined();
    expect(verifyStream(store.db, A)).toMatchObject({ ok: true });
  });
});

describe("size effect on a synthetic stream", () => {
  it("a sub-agent view with a rolling window of 500 steps and a growing reply stores far less than whole bodies", async () => {
    const store = await setup(A);
    const step = (i: number) => ({ id: `st${i}`, kind: "tool", tool: "Bash", title: `run command ${i}`, detail: `detail of step ${i} `.repeat(3), output: `output of step ${i} `.repeat(6), failed: false, done: true });
    let steps: ReturnType<typeof step>[] = [];
    let full = 0;
    await store.submit((db) => {
      for (let i = 0; i < 400; i++) {
        steps = [...steps, step(i)].slice(-500);
        const subagent = { id: "sa1", title: "Reviewer", owner: "alpha", status: "running", type: null, model: null, outputTokens: i * 11, prompt: "review this change", steps, result: i > 300 ? "result text ".repeat(i - 300) : null, startedAt: TIME, endedAt: null };
        const [entry] = appendEntries(db, A, [{ kind: "subagent.updated", body: { botId: "alpha", subagent } }]);
        full += canonicalJson(entry.body).length;
      }
    });
    const stored = Number(store.db.prepare("SELECT sum(length(body)) AS n FROM entries WHERE stream = ?").get(A)!.n);
    console.log(`size effect: whole bodies ${full} bytes, stored ${stored} bytes (${(100 * stored / full).toFixed(2)}%)`);
    expect(stored * 20).toBeLessThan(full);
    const read = readAll(store.db, A);
    expect(read.unreadable).toBeUndefined();
    expect(read.entries).toHaveLength(400);
    expect(verifyStream(store.db, A)).toMatchObject({ ok: true });
  }, 180_000);
});

describe("eviction across a baseline", () => {
  it("the first kept row of an object becomes a baseline, and nothing reads wrong afterwards", async () => {
    const store = await setup(A);
    const sent: Entry[] = [];
    await store.submit((db) => {
      for (let i = 0; i < 12; i++) sent.push(...appendEntries(db, A, [upd("m1", "wa ".repeat(i + 1)), upd("m2", "wb ".repeat(i + 1))]));
    });
    const before = raw(store.db, A);
    expect(before.find((r) => r.seq === 11)!.base).not.toBeNull(); // hangs on a baseline that goes
    await store.submit((db) => evictEntries(db, A, 10));
    const after = raw(store.db, A);
    for (const okey of ["m:m1", "m:m2"]) {
      const first = after.find((r) => r.okey === okey)!;
      expect(first.base).toBeNull();
      for (const row of after.filter((r) => r.okey === okey && r.base !== null)) expect(row.base).toBeGreaterThanOrEqual(Number(first.seq));
    }
    const read = readAll(store.db, A, 11);
    expect(read.unreadable).toBeUndefined();
    expect(read.entries).toEqual(sent.slice(10));
    expect(verifyStream(store.db, A)).toMatchObject({ ok: true });
    // and it goes on: the writer continues the re-based chain
    await store.submit((db) => { appendEntries(db, A, [upd("m1", "after the eviction")]); });
    expect(readAll(store.db, A, 11).unreadable).toBeUndefined();
    expect(verifyStream(store.db, A)).toMatchObject({ ok: true });
    const last = raw(store.db, A).at(-1)!;
    expect(last.base === null || store.db.prepare("SELECT 1 FROM entries WHERE stream = ? AND seq = ?").get(A, last.base)).toBeTruthy();
  });

  it("evicting past every row of an object leaves no dangling diff; the next write starts a baseline", async () => {
    const store = await setup(A);
    await store.submit((db) => { for (let i = 0; i < 6; i++) appendEntries(db, A, [upd("m1", `x${i}`)]); });
    await store.submit((db) => evictEntries(db, A, 6));
    await store.submit((db) => { appendEntries(db, A, [upd("m1", "fresh")]); });
    expect(raw(store.db, A)).toHaveLength(1);
    expect(raw(store.db, A)[0].base).toBeNull();
    expect(readAll(store.db, A, 7).entries).toHaveLength(1);
  });
});

describe("a corrupt diff", () => {
  async function filled() {
    const store = await setup(A);
    const sent: Entry[] = [];
    await store.submit((db) => { for (let i = 0; i < 8; i++) sent.push(...appendEntries(db, A, [upd("m1", "word ".repeat(i + 1))])); });
    return { store, sent };
  }
  const diffSeq = (store: QuickStore, n: number) => Number(raw(store.db, A).filter((r) => r.base !== null)[n].seq);

  it("a diff that does not apply: nothing from it on is handed out, verifyStream says so", async () => {
    const { store, sent } = await filled();
    const seq = diffSeq(store, 2);
    store.db.prepare("UPDATE entries SET body = ? WHERE stream = ? AND seq = ?").run('[{"op":"remove","path":"/nope"}]', A, seq);
    const read = readAll(store.db, A);
    expect(read.unreadable).toBe(seq);
    expect(read.entries).toEqual(sent.slice(0, seq - 1));
    expect(verifyStream(store.db, A)).toEqual({ ok: false, seq, reason: "hash" });
  });

  it("a diff that applies but rebuilds the wrong body is caught by the hash", async () => {
    const { store, sent } = await filled();
    const seq = diffSeq(store, 3);
    store.db.prepare("UPDATE entries SET body = ? WHERE stream = ? AND seq = ?").run('[{"op":"replace","path":"/message/text","value":"forged"}]', A, seq);
    const read = readAll(store.db, A);
    expect(read.unreadable).toBe(seq);
    expect(read.entries.map((e) => e.seq)).toEqual(sent.slice(0, seq - 1).map((e) => e.seq));
    expect(JSON.stringify(read.entries)).not.toContain("forged");
  });

  it("a damaged baseline breaks the diffs that hang on it, not the entries before it", async () => {
    const { store } = await filled();
    store.db.prepare("UPDATE entries SET body = ? WHERE stream = ? AND seq = 1").run(canonicalJson({ botId: "alpha", message: line("m1", "tampered") }), A);
    const read = readAll(store.db, A);
    expect(read.unreadable).toBe(2);
  });

  it("a writer that finds a broken chain (cold cache) starts a new baseline instead of hanging a diff on it", async () => {
    const { store } = await filled();
    // The newest row is made to say something else: its object's state, as the table now rebuilds it, is not what was hashed.
    const last = Number(raw(store.db, A).at(-1)!.seq);
    store.db.prepare("UPDATE entries SET body = ? WHERE stream = ? AND seq = ?").run('[{"op":"append","path":"/message/text","value":"X"}]', A, last);
    const db2 = openDb(store.db.path);
    try {
      db2.exec("PRAGMA busy_timeout = 5000");
      db2.exec("BEGIN IMMEDIATE");
      // The new text extends what the broken chain rebuilds, so a writer that trusted it would store a tiny diff.
      appendEntries(db2, A, [upd("m1", `${"word ".repeat(last - 1)}XY`)]);
      db2.exec("COMMIT");
    } finally { db2.close(); }
    expect(raw(store.db, A).at(-1)!.base).toBeNull();
    expect(readAll(store.db, A, last + 1).entries).toHaveLength(1);
  });

  it("the hub gives the reader a snap instead of the bad entry", async () => {
    const { store } = await filled();
    const hub = new LogHub(store);
    hubs.push(hub);
    const seq = diffSeq(store, 1);
    store.db.prepare("UPDATE entries SET body = ? WHERE stream = ? AND seq = ?").run('[{"op":"remove","path":"/nope"}]', A, seq);
    const fe = new FakeFe("fe");
    const logId = readStream(store.db, A)!.logId;
    fe.forceCursor(A, { logId, seq: 0 }, GENESIS_HASH);
    const reader = hub.attach(fe.receive);
    expect(await reader.sub(A, fe.cursor(A))).toEqual({ ok: true });
    const kinds = fe.frames.map((frame) => frame.t);
    expect(kinds).toEqual(["batch", "snap"]);
    const batch = fe.frames[0] as Extract<Message, { t: "batch" }>;
    expect(batch.to).toBe(seq - 1);
    expect((fe.frames[1] as Extract<Message, { t: "snap" }>).seq).toBe(8);
    expect(JSON.stringify(fe.frames)).not.toContain('"path":"/nope"');
    expect(fe.violations).toEqual([]);
  });
});

describe("an existing database", () => {
  it("rows written before v15 stay readable, and new writes of the same object continue from them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "botling-v14-"));
    const db = openDb(join(dir, "server.db"));
    try {
      db.exec("PRAGMA journal_mode = WAL");
      migrate(db, MIGRATIONS.filter((m) => m.version <= 14));
      db.exec("BEGIN IMMEDIATE");
      ensureStream(db, A);
      db.exec("COMMIT");
      // Old rows: written by the pre-v15 insert (whole bodies, no okey / base columns).
      const old: Entry[] = [];
      db.exec("BEGIN IMMEDIATE");
      db.exec("DROP INDEX IF EXISTS entries_by_okey");
      const insert = db.prepare("INSERT INTO entries (stream, seq, logId, hlc, kind, body, slot, hash) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)");
      let prev: string = GENESIS_HASH;
      const row = readStream(db, A)!;
      for (let i = 1; i <= 3; i++) {
        const content = { stream: A, logId: row.logId, seq: i, hlc: { ms: 1000 + i, c: 0 }, kind: "message.updated", body: { botId: "alpha", message: line("m1", `old ${i}`) } };
        const hash = hashEntry(prev, content);
        insert.run(A, i, row.logId, canonicalJson(content.hlc), content.kind, canonicalJson(content.body), hash);
        old.push({ ...content, hash } as Entry);
        prev = hash;
      }
      db.prepare("UPDATE streams SET head = 3, headHash = ? WHERE stream = ?").run(prev, A);
      db.exec("COMMIT");
      expect(migrate(db)).toEqual([15]);
      expect(db.prepare("SELECT count(*) AS n FROM entries WHERE okey IS NOT NULL OR base IS NOT NULL").get()!.n).toBe(0);
      expect(readAll(db, A).entries).toEqual(old);
      expect(verifyStream(db, A)).toMatchObject({ ok: true });
      db.exec("BEGIN IMMEDIATE");
      for (let i = 0; i < 5; i++) appendEntries(db, A, [upd("m1", `new ${i} `.repeat(i + 1))]);
      db.exec("COMMIT");
      const rows = raw(db, A);
      expect(rows.slice(0, 3).every((r) => r.okey === null && r.base === null)).toBe(true);
      expect(rows[3].base).toBeNull(); // the first new write is a baseline: old rows have no object key to hang on
      expect(rows[4].base).toBe(4);
      const read = readAll(db, A);
      expect(read.unreadable).toBeUndefined();
      expect(read.entries.slice(0, 3)).toEqual(old);
      expect(verifyStream(db, A)).toMatchObject({ ok: true });
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("D0: a redraw of the state the log already holds is not stored", () => {
  async function tapSetup() {
    const store = quickStore();
    stores.push(store);
    const scope = new TxScope(store);
    const tap = new EventTap({ scope, serverEvents: "all", mirrorBotUpdates: true });
    const stored: Array<{ seq: number }> = [];
    return { store, scope, tap, stored };
  }
  const botView = (overrides: Record<string, unknown> = {}) => ({
    id: "alpha", name: "Bot alpha", role: "manager", avatar: "circle", folder: "/work/projects/alpha", phase: "awake", working: false,
    approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [], ...overrides,
  });
  const subagent = (overrides: Record<string, unknown> = {}) => ({
    id: "sa1", title: "Reviewer", owner: "alpha", status: "running", type: null, model: null, prompt: "go", steps: [], result: null,
    startedAt: TIME, endedAt: null, ...overrides,
  });
  const count = (store: QuickStore, stream: string, kind: string) => Number(store.db.prepare("SELECT count(*) AS n FROM entries WHERE stream = ? AND kind = ?").get(stream, kind)!.n);
  const srvStream = (store: QuickStore) => `srv:${String(store.db.prepare("SELECT value FROM meta WHERE key = 'serverId'").get()!.value)}`;
  const send = async (scope: TxScope, tap: EventTap, ...events: ContractEvent[]) => {
    for (const event of events) tap.event(event);
    await scope.submit(() => undefined);
  };

  it("message.updated: identical is skipped, a changed line is stored, and the line's rev keeps its entry", async () => {
    const { store, scope, tap } = await tapSetup();
    const m = (text: string): Message => line("m1", text) as unknown as Message;
    await send(scope, tap, { type: "message.added", botId: "alpha", message: m("one") } as unknown as ContractEvent);
    await send(scope, tap, { type: "message.updated", botId: "alpha", message: m("one") } as unknown as ContractEvent);
    await send(scope, tap, { type: "message.updated", botId: "alpha", message: m("one") } as unknown as ContractEvent);
    expect(count(store, "bot:alpha", "message.updated")).toBe(0);
    await send(scope, tap, { type: "message.updated", botId: "alpha", message: m("two") } as unknown as ContractEvent);
    await send(scope, tap, { type: "message.updated", botId: "alpha", message: m("two") } as unknown as ContractEvent);
    expect(count(store, "bot:alpha", "message.updated")).toBe(1);
    expect(store.db.prepare("SELECT rev FROM messages WHERE botId = 'alpha' AND msgId = 'm1'").get()!.rev).toBe(2);
    // back to an earlier text is a change again
    await send(scope, tap, { type: "message.updated", botId: "alpha", message: m("one") } as unknown as ContractEvent);
    expect(count(store, "bot:alpha", "message.updated")).toBe(2);
    expect(verifyStream(store.db, A)).toMatchObject({ ok: true });
  });

  it("a skipped message.updated still reaches the content index, against the entry that holds the line", async () => {
    const store = quickStore();
    stores.push(store);
    const scope = new TxScope(store);
    const seen: Array<{ stream: string; seq: number }> = [];
    const tap = new EventTap({ scope, hooks: { lineStored: (_tx, _event, entry) => { seen.push({ stream: entry.stream, seq: entry.seq }); } } });
    const message = line("m1", "x") as unknown as Message;
    await send(scope, tap, { type: "message.added", botId: "alpha", message } as unknown as ContractEvent);
    await send(scope, tap, { type: "message.updated", botId: "alpha", message } as unknown as ContractEvent);
    expect(seen).toEqual([{ stream: A, seq: 1 }, { stream: A, seq: 1 }]);
  });

  it("bot.updated: identical views are skipped in the bot's stream and in srv:, a changed one is stored, unread always follows", async () => {
    const { store, scope, tap } = await tapSetup();
    const update = (overrides?: Record<string, unknown>) => ({ type: "bot.updated", bot: botView(overrides) }) as unknown as ContractEvent;
    await send(scope, tap, update());
    await send(scope, tap, update(), update());
    expect(count(store, "bot:alpha", "bot.updated")).toBe(1);
    expect(count(store, srvStream(store), "bot.updated")).toBe(1);
    await send(scope, tap, update({ unread: 3 }));
    await send(scope, tap, update({ unread: 3 }));
    expect(count(store, "bot:alpha", "bot.updated")).toBe(2);
    expect(count(store, srvStream(store), "bot.updated")).toBe(2);
    expect(store.db.prepare("SELECT unread FROM bots WHERE botId = 'alpha'").get()!.unread).toBe(3);
    // the column was changed by someone else; the next identical event puts it back
    store.db.prepare("UPDATE bots SET unread = 0 WHERE botId = 'alpha'").run();
    await send(scope, tap, update({ unread: 3 }));
    expect(count(store, "bot:alpha", "bot.updated")).toBe(2);
    expect(store.db.prepare("SELECT unread FROM bots WHERE botId = 'alpha'").get()!.unread).toBe(3);
  });

  it("subagent.updated: identical is skipped, any change is stored; the srv: stream and the bot's stream decide on their own", async () => {
    const { store, scope, tap } = await tapSetup();
    const update = (overrides?: Record<string, unknown>) => ({ type: "subagent.updated", botId: "alpha", subagent: subagent(overrides) }) as unknown as ContractEvent;
    await send(scope, tap, update(), update(), update({ status: "completed" }), update({ status: "completed" }));
    expect(count(store, "bot:alpha", "subagent.updated")).toBe(2);
    expect(verifyStream(store.db, A)).toMatchObject({ ok: true });
  });

  it("a skipped event that rolled back with its command is stored on the next try", async () => {
    const { store, scope, tap } = await tapSetup();
    const update = (overrides?: Record<string, unknown>) => ({ type: "bot.updated", bot: botView(overrides) }) as unknown as ContractEvent;
    await send(scope, tap, update());
    await expect(scope.submit((tx) => { tap.event(update({ unread: 9 })); tx.exec("SELECT 1"); throw new Error("the command fails"); })).rejects.toThrow();
    // the changed view never got in; the same view again is a change, not a repeat
    expect(count(store, "bot:alpha", "bot.updated")).toBe(1);
    await send(scope, tap, update({ unread: 9 }));
    expect(count(store, "bot:alpha", "bot.updated")).toBe(2);
    expect(sameAsStored(store.db, "bot:alpha", "bot.updated", { bot: botView({ unread: 9 }) })).toBe(true);
    expect(sameAsStored(store.db, "bot:alpha", "bot.updated", { bot: botView({ unread: 1 }) })).toBe(false);
    expect(sameAsStored(store.db, "bot:alpha", "turn.started", { botId: "alpha" })).toBe(false);
  });
});

describe("only log-store.ts reads or writes entries.body", () => {
  const SRC = join(__dirname, "..", "..", "src");
  // Known readers that decode by hand; each is to switch to readEntries (plan db-compaction D1, with bot/v3-slow-restart).
  // store/compaction.ts: the one-time prune sizes rows and scans the whole `srv:` bot.updated / settings.updated bodies (always stored whole).
  const KNOWN = new Set(["server/replica/summary.ts", "server/store/compaction.ts"]);
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|mts)$/.test(name)) out.push(full);
    }
    return out;
  }
  it("no other file selects `body` from entries or changes it", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file).replaceAll("\\", "/");
      if (rel === "server/log/log-store.ts" || KNOWN.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const sql of text.match(/(?:SELECT|UPDATE|INSERT INTO|DELETE FROM)[^"`;]*\bentries\b[^"`;]*/g) ?? []) {
        if (/\bbody\b/.test(sql)) offenders.push(`${rel}: ${sql.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
