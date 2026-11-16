// M3 step 6: the server's own `srv:` summary rows (src/server/replica): the 2 s rule under a running fake turn, the
// §8.2 limits, catch-up by rev (property test over random write sequences), tombstones and their 30-day purge, and no
// secret in the settings row. One server, an in-memory server.db, injected clock and timers.
import { describe, expect, it, vi } from "vitest";
import type { BotView, Event as ContractEvent } from "../../src/contract";
import { decodeWireFrame, encodeWireFrame } from "../../src/protocol/frame";
import { Rows, SECRET_KEY, SettingsRow, SummaryRow, TableRow, TOMBSTONE_KEEP_MS } from "../../src/protocol/table-rows";
import { effectCheckpointSink } from "../../src/server/effects";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import {
  applyRows, deleteRow, emptyTable, ownTableStream, purgedRev, purgeTombstones, putRow, readCatchUp, readTable, settingsRow, SummaryRows,
  tableRev, type TableCopy, type Timers,
} from "../../src/server/replica";
import type { Db, Writer } from "../../src/server/store";
import { settingsView } from "../../src/core/settings";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { memoryStore } from "./server-slots-harness";

// ---------------------------------------------------------------------------------------------
// Fake clock and timers

class FakeClock implements Timers {
  t = 1_000_000;
  private seq = 0;
  private readonly queue = new Map<number, { at: number; run: () => void }>();
  now = () => this.t;
  set(run: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.set(id, { at: this.t + ms, run });
    return id;
  }
  clear(handle: unknown): void { this.queue.delete(handle as number); }
  /** Moves the clock to `to`, running every timer due on the way, in time order. */
  advanceTo(to: number): void {
    for (;;) {
      const next = [...this.queue.entries()].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.queue.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].run();
    }
    this.t = to;
  }
}

function view(id: string, over: Partial<BotView> = {}): BotView {
  return {
    id, name: `Bot ${id}`, role: "manager", avatar: "circle", folder: `/work/projects/${id.toLowerCase()}`, phase: "awake", working: false,
    approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [], ...over,
  };
}

class ViewEngine extends FakeTurnEngine {
  views = new Map<string, BotView>();
  botView(botId: string): BotView | null { return this.views.get(botId) ?? null; }
}

interface Setup {
  db: Db;
  writer: Writer;
  engine: ViewEngine;
  runtime: IntentRuntime;
  live: LiveChannel;
  summary: SummaryRows;
  clock: FakeClock;
  stream: string;
  writes: Array<{ key: string; rev: number; at: number }>;
  logs: string[];
  settle(): Promise<void>;
  row(botId: string): SummaryRow | null;
  close(): void;
}

async function setup(options: { bots?: string[]; shared?: { db: Db; writer: Writer }; clock?: FakeClock; views?: Record<string, BotView> } = {}): Promise<Setup> {
  const { db, writer } = options.shared ?? memoryStore();
  const clock = options.clock ?? new FakeClock();
  const engine = new ViewEngine({ bots: options.bots ?? ["MAIN", "B1"], hold: true });
  for (const [id, v] of Object.entries(options.views ?? {})) engine.views.set(id, v);
  const live = new LiveChannel({ sink: effectCheckpointSink(writer), checkpointIntervalMs: 60_000 });
  const logs: string[] = [];
  const writes: Setup["writes"] = [];
  let summary: SummaryRows | null = null;
  const runtime = new IntentRuntime({
    store: writer, engine, live, log: (line) => logs.push(line), serverEvents: "all", mirrorBotUpdates: true,
    tapHooks: { eventSeen: (event) => summary?.seen(event), eventStored: (tx, event) => summary?.stored(tx, event) },
  });
  summary = new SummaryRows({
    scope: runtime.scope, engine, live, now: clock.now, timers: clock, log: (line) => logs.push(line),
    machine: () => ({ name: "server A", os: "test", versions: { botlingd: "3.0.0-test" }, addresses: [], pluginsDigest: null }),
    onWritten: (key, rev) => writes.push({ key, rev, at: clock.t }),
  });
  await runtime.start();
  const s = summary;
  await runtime.scope.submit((tx) => s.reconcile(tx));
  const stream = ownTableStream(db);
  const settle = async () => {
    for (let round = 0; round < 4; round += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await runtime.scope.submit(() => undefined);
    }
  };
  return {
    db, writer, engine, runtime, live, summary: s, clock, stream, writes, logs, settle,
    row(botId) {
      const row = db.prepare("SELECT body, deleted FROM rows WHERE stream = ? AND key = ?").get(stream, `bot:${botId}`);
      return row && Number(row.deleted) === 0 ? (JSON.parse(String(row.body)) as SummaryRow) : null;
    },
    close() {
      s.close();
      runtime.close();
      engine.close();
      live.close();
    },
  };
}

const emit = (s: Setup, event: ContractEvent) => s.engine.emit(event);

describe("summary rows: the 2 s rule", () => {
  it("a running fake turn rewrites its bot's row at most once per 2 s, and at once on a status or waiting change", async () => {
    const s = await setup({ views: { B1: view("B1") } });
    await s.settle();
    expect(s.row("B1")?.status).toBe("idle");
    const writesOf = () => s.writes.filter((write) => write.key === "bot:B1");
    const before = writesOf().length;

    // The turn starts: status idle → running is written at once.
    emit(s, { type: "turn.started", botId: "B1", turnId: "T1", messageId: "M1" });
    emit(s, { type: "bot.updated", bot: view("B1", { working: true }) });
    await s.settle();
    expect(writesOf().length).toBe(before + 1);
    expect(s.row("B1")?.status).toBe("running");
    expect(s.row("B1")?.turn?.turnId).toBe("T1");
    const startAt = s.clock.t;

    // 10 s of text, a delta every 100 ms.
    let cardAt = -1;
    for (let i = 1; i <= 100; i += 1) {
      s.clock.advanceTo(startAt + i * 100);
      emit(s, { type: "turn.delta", botId: "B1", turnId: "T1", messageId: "M1", text: ` word${i}` });
      if (i === 45) {
        // A card arrives mid-turn: waiting changes → written at once, whatever the interval says.
        emit(s, { type: "message.added", botId: "B1", message: { id: "C1", role: "bot", text: "Allow Bash?", time: new Date(s.clock.t).toISOString(), approval: { tool: "Bash", expires: null } } });
        cardAt = s.clock.t;
      }
      await s.settle();
    }
    s.clock.advanceTo(startAt + 12_000);
    await s.settle();

    const turnWrites = writesOf().slice(before + 1);
    expect(turnWrites.length).toBeGreaterThanOrEqual(4);
    // Every write inside the turn is ≥ 2 s after the one before, except the urgent one (the card).
    const all = writesOf().slice(before);
    for (let i = 1; i < all.length; i += 1) {
      if (all[i].at === cardAt) continue;
      expect(all[i].at - all[i - 1].at).toBeGreaterThanOrEqual(2_000);
    }
    expect(all.some((write) => write.at === cardAt && cardAt - startAt < 4_600)).toBe(true);
    // The live text reached the row (its newest line), cut to ≤ 140 characters from the end.
    const row = s.row("B1")!;
    expect(row.status).toBe("waiting");
    expect(row.waiting).toEqual([{ cardId: "C1", cardRev: expect.any(Number), kind: "approval", title: "Allow Bash?" }]);
    expect(row.lines.at(-1)).toMatch(/word100$/);
    expect(row.lines.at(-1)!.length).toBeLessThanOrEqual(140);

    // The turn ends: running/waiting → idle once the card is answered and the turn finished: at once.
    const t0 = s.clock.t;
    emit(s, { type: "message.updated", botId: "B1", message: { id: "C1", role: "bot", text: "Allow Bash?", time: new Date(t0).toISOString(), approval: { tool: "Bash", expires: null }, chosen: 0 } });
    emit(s, { type: "bot.updated", bot: view("B1", { working: false }) });
    emit(s, { type: "turn.finished", botId: "B1", turnId: "T1", messageId: "M1", status: "done", text: "done" });
    await s.settle();
    expect(s.row("B1")?.status).toBe("idle");
    expect(s.row("B1")?.turn).toBeUndefined();
    expect(writesOf().at(-1)!.at).toBe(t0);
    s.close();
  });

  it("changes inside the interval that are not urgent wait for it; the timer writes the last state once", async () => {
    const s = await setup({ views: { B1: view("B1") } });
    await s.settle();
    const t0 = s.clock.t;
    emit(s, { type: "bot.updated", bot: view("B1", { unread: 1 }) });
    await s.settle();
    const first = s.writes.filter((write) => write.key === "bot:B1").length;
    for (let i = 2; i <= 6; i += 1) {
      s.clock.advanceTo(t0 + i * 100);
      emit(s, { type: "bot.updated", bot: view("B1", { unread: i }) });
      await s.settle();
    }
    expect(s.writes.filter((write) => write.key === "bot:B1").length).toBe(first);
    expect(s.summary.pending).toEqual(["B1"]);
    s.clock.advanceTo(t0 + 5_000);
    await s.settle();
    const after = s.writes.filter((write) => write.key === "bot:B1");
    expect(after.length).toBe(first + 1);
    expect(s.row("B1")?.unread).toBe(6);
    s.close();
  });
});

describe("summary rows: §8.2 limits", () => {
  it("≤ 5 waiting items, ≤ 3 lines × 140 characters, names only, and the row passes the schema", async () => {
    const s = await setup({ views: { B1: view("B1", { folder: "/a/very/private/place/projects/kitchen" }) } });
    await s.settle();
    for (let i = 0; i < 8; i += 1) s.engine.addCard("B1");
    for (let i = 0; i < 10; i += 1) s.engine.addLine("B1", { role: i % 2 ? "bot" : "user", text: `${"long words ".repeat(40)} #${i}` });
    emit(s, { type: "bot.updated", bot: view("B1", { folder: "/a/very/private/place/projects/kitchen", name: "x".repeat(200) }) });
    await s.settle();
    await s.summary.flush();
    const row = s.row("B1")!;
    expect(SummaryRow.safeParse(row).success).toBe(true);
    expect(row.waiting.length).toBe(5);
    expect(row.lines.length).toBe(3);
    for (const line of row.lines) expect(line.length).toBeLessThanOrEqual(140);
    expect(row.lines.at(-1)).toMatch(/…$/);
    expect(row.folderName).toBe("kitchen");
    expect(JSON.stringify(row)).not.toContain("/a/very/private");
    expect(row.status).toBe("waiting");
    s.close();
  });
});

describe("summary rows: tombstones", () => {
  it("bot.removed leaves a tombstone, catch-up carries it, and it is purged after 30 days (clock injected)", async () => {
    const s = await setup({ views: { B1: view("B1"), MAIN: view("MAIN", { role: "main", folder: "" }) } });
    await s.settle();
    expect(s.row("MAIN")?.folderName).toBeNull();
    const cursor = tableRev(s.db, s.stream);
    s.engine.botSet.delete("B1");
    emit(s, { type: "bot.removed", botId: "B1" });
    await s.settle();
    expect(s.row("B1")).toBeNull();
    const parts = readCatchUp(s.db, s.stream, cursor);
    expect(parts.flatMap((part) => part.rows)).toEqual([{ key: "bot:B1", rev: cursor + 1, deleted: true }]);
    for (const part of parts) for (const r of part.rows) expect(TableRow.safeParse(r).success).toBe(true);
    // Something newer, so the tombstone is not the top row.
    emit(s, { type: "bot.updated", bot: view("MAIN", { role: "main", folder: "", unread: 3 }) });
    await s.settle();
    s.clock.advanceTo(s.clock.t + TOMBSTONE_KEEP_MS - 1_000);
    expect(await s.summary.purge()).toBe(0);
    s.clock.advanceTo(s.clock.t + 2_000);
    expect(await s.summary.purge()).toBe(1);
    expect(s.db.prepare("SELECT count(*) AS n FROM rows WHERE stream = ? AND key = 'bot:B1'").get(s.stream)!.n).toBe(0);
    expect(purgedRev(s.db, s.stream)).toBe(cursor + 1);
    // A reader still at the old cursor (it never saw the tombstone) gets the whole table and drops B1.
    const stale: TableCopy = { rev: cursor, rows: new Map([["bot:B1", { rev: 1, body: {} }]]) };
    const caught = applyRows(stale, readCatchUp(s.db, s.stream, cursor));
    expect(caught.rows.has("bot:B1")).toBe(false);
    expect(sameTable(caught, readTable(s.db, s.stream))).toBe(true);
    s.close();
  });

  it("at a restart, rows of bots the engine no longer has are tombstoned; views come from the srv: entries", async () => {
    const shared = memoryStore();
    const clock = new FakeClock();
    const a = await setup({ shared, clock, bots: ["MAIN", "B1", "B2"], views: { MAIN: view("MAIN", { role: "main" }), B1: view("B1"), B2: view("B2") } });
    emit(a, { type: "bot.updated", bot: view("B1", { name: "Renamed" }) });
    await a.settle();
    await a.summary.flush();
    a.close();
    // B2 went while the server was down; the engine knows no view of B1 (only the srv: entry does).
    const b = await setup({ shared, clock, bots: ["MAIN", "B1"], views: { MAIN: view("MAIN", { role: "main" }) } });
    expect(b.row("B2")).toBeNull();
    expect(b.db.prepare("SELECT deleted FROM rows WHERE stream = ? AND key = 'bot:B2'").get(b.stream)!.deleted).toBe(1);
    expect(b.row("B1")?.name).toBe("Renamed");
    expect(b.db.prepare("SELECT body FROM rows WHERE stream = ? AND key = 'machine'").get(b.stream)).toBeTruthy();
    b.close();
  });
});

describe("summary rows: the start reads the srv: log only for what it lacks", () => {
  /** A second start on the same server.db, with the statements it ran on `entries` noted. */
  async function restartReading(engineViews: Record<string, BotView>): Promise<string[]> {
    const shared = memoryStore();
    const clock = new FakeClock();
    const a = await setup({ shared, clock, bots: ["MAIN", "B1"], views: { MAIN: view("MAIN", { role: "main" }), B1: view("B1") } });
    for (let i = 0; i < 20; i += 1) emit(a, { type: "bot.updated", bot: view("B1", { unread: i }) });
    await a.settle();
    await a.summary.flush();
    a.close();
    const queries: string[] = [];
    const prepare = shared.db.prepare.bind(shared.db);
    const spy = vi.spyOn(shared.db, "prepare").mockImplementation((sql: string) => { if (/FROM entries/.test(sql)) queries.push(sql); return prepare(sql); });
    try {
      // The second start: its reconcile (run inside setup) is what is noted.
      const b = await setup({ shared, clock, bots: ["MAIN", "B1"], views: engineViews });
      b.close();
    } finally { spy.mockRestore(); }
    return queries;
  }

  it("with a view of every bot from the engine, no bot.updated entry is read (the stream holds one per change of a bot)", async () => {
    const queries = await restartReading({ MAIN: view("MAIN", { role: "main" }), B1: view("B1") });
    expect(queries.filter((sql) => sql.includes("bot.updated"))).toEqual([]);
  });

  it("a bot the engine has no view of is read from the newest entries", async () => {
    const queries = await restartReading({ MAIN: view("MAIN", { role: "main" }) });
    expect(queries.filter((sql) => sql.includes("bot.updated"))).toHaveLength(1);
  });

  it("the settings come back from the newest settings entry: a bot's face colour survives a restart", async () => {
    const shared = memoryStore();
    const clock = new FakeClock();
    const a = await setup({ shared, clock, views: { B1: view("B1") } });
    for (const color of ["#111111", "#AB12CD"]) emit(a, { type: "settings.updated", settings: { ...settingsView({}), botColors: { B1: { avatar: "circle", color } } } });
    await a.settle();
    a.close();
    const b = await setup({ shared, clock, views: { B1: view("B1") } });
    await b.settle();
    expect(b.row("B1")?.face).toEqual({ avatar: "circle", color: "#AB12CD" });
    b.close();
  });
});

describe("summary rows: settings", () => {
  it("no secret settings in the settings row (key scan at every depth)", async () => {
    const keysOf = (value: unknown): string[] => {
      const keys: string[] = [];
      const scan = (inner: unknown) => {
        if (Array.isArray(inner)) inner.forEach(scan);
        else if (inner && typeof inner === "object") for (const [key, deeper] of Object.entries(inner)) { keys.push(key); scan(deeper); }
      };
      scan(value);
      return keys;
    };
    // The filter alone, with secrets at every depth.
    const dirty = {
      language: "en", relayToken: "t0k3n", apiKey: "k", nested: { privateKey: "p", ok: 1, list: [{ password: "x", fine: true }] },
      vapidPrivate: "v", recoveryCode: "r", clientSecret: "s", passphrase: "q", credentials: { a: 1 },
    };
    const clean = settingsRow(dirty);
    expect(keysOf(clean).filter((key) => SECRET_KEY.test(key))).toEqual([]);
    expect(keysOf(clean)).toEqual(expect.arrayContaining(["language", "nested", "ok", "list", "fine"]));
    for (const secret of ["t0k3n", '"k"', '"p"', '"x"', '"v"', '"r"', '"s"', '"q"']) expect(JSON.stringify(clean)).not.toContain(secret);
    expect(SettingsRow.safeParse(clean).success).toBe(true);
    expect(() => putRow(memoryStore().db, "srv:x", "settings", dirty)).toThrow(/refused/);

    // The real settings view, through the event tap: the row is written in the event's transaction, and scanned.
    const s = await setup({ views: { B1: view("B1") } });
    const settings = { ...settingsView({}), botColors: { B1: { avatar: "circle", color: "#12AB34" } } };
    emit(s, { type: "settings.updated", settings });
    await s.settle();
    const body = JSON.parse(String(s.db.prepare("SELECT body FROM rows WHERE stream = ? AND key = 'settings'").get(s.stream)!.body));
    expect(keysOf(body).filter((key) => SECRET_KEY.test(key))).toEqual([]);
    expect(body.appTheme).toBe("dark");
    expect(SettingsRow.safeParse(body).success).toBe(true);
    // The settled face colour reaches the bot's summary.
    emit(s, { type: "bot.updated", bot: view("B1", { unread: 1 }) });
    await s.settle();
    s.clock.advanceTo(s.clock.t + 3_000);
    await s.settle();
    expect(s.row("B1")?.face).toEqual({ avatar: "circle", color: "#12AB34" });
    s.close();
  });
});

// ---------------------------------------------------------------------------------------------
// Catch-up property test (tables.ts alone)

function sameTable(a: TableCopy, b: TableCopy): boolean {
  if (a.rows.size !== b.rows.size) return false;
  for (const [key, row] of a.rows) {
    const other = b.rows.get(key);
    if (!other || JSON.stringify(other.body) !== JSON.stringify(row.body)) return false;
  }
  return true;
}

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x1_0000_0000;
  };
}

const summaryBody = (n: number, random: () => number): SummaryRow => ({
  name: `bot ${n}`, face: null, role: "bot", parent: null, folderName: null, engine: "claude", model: null,
  status: (["idle", "running", "waiting", "error", "stopped"] as const)[Math.floor(random() * 5)],
  waiting: [], unread: Math.floor(random() * 50), lastAt: null, lines: [`line ${Math.floor(random() * 1e6)}`.repeat(1 + Math.floor(random() * 10)).slice(0, 140)],
});

describe("summary rows: catch-up by rev (property)", () => {
  it("catch-up from any rev gives a table equal to the store's at `to` (random write sequences, purges, small frames)", () => {
    const seeds = 40;
    let checks = 0;
    let wholeBatches = 0;
    let multiPart = 0;
    for (let seed = 1; seed <= seeds; seed += 1) {
      const random = rng(seed * 7919);
      const { db } = memoryStore();
      const stream = ownTableStream(db);
      db.prepare("INSERT INTO streams (stream, owner, logId, head, state) VALUES (?, 'self', 'inc-00000001', 0, 'live')").run(stream);
      let now = 1_000_000;
      const history: TableCopy[] = [emptyTable()];
      const steps = 30 + Math.floor(random() * 120);
      for (let step = 0; step < steps; step += 1) {
        now += Math.floor(random() * 3 * 24 * 3600 * 1000);
        db.exec("BEGIN IMMEDIATE");
        const choice = random();
        const key = random() < 0.85 ? `bot:B${Math.floor(random() * 12)}` : random() < 0.5 ? "settings" : `audit:a${Math.floor(random() * 5)}`;
        const body = key.startsWith("bot:") ? summaryBody(step, random) : key === "settings" ? { theme: step % 3 } : { act: "device.pair", at: now };
        if (choice < 0.6) putRow(db, stream, key, body);
        else if (choice < 0.9) deleteRow(db, stream, key, now);
        else purgeTombstones(db, stream, now);
        db.exec("COMMIT");
        history.push(readTable(db, stream));
      }
      const final = readTable(db, stream);
      const to = tableRev(db, stream);
      // Readers at every earlier state (and one ahead of the owner, as after a restore of the owner).
      const readers = [...history, { rev: to + 5, rows: new Map([["bot:ghost", { rev: to + 5, body: {} }]]) }];
      for (const reader of readers) {
        for (const frame of [{}, { rowsLimit: 3 }, { frameBytes: 6 * 1024 }]) {
          const parts: Rows[] = readCatchUp(db, stream, reader.rev, frame);
          expect(parts.length).toBeGreaterThan(0);
          expect(parts.every((part, i) => part.more === (i < parts.length - 1) && part.to === to)).toBe(true);
          if (parts[0].after === 0 && reader.rev !== 0) wholeBatches += 1;
          if (parts.length > 1) multiPart += 1;
          const caught = applyRows(reader, parts);
          expect(sameTable(caught, final)).toBe(true);
          expect(caught.rev).toBe(to);
          checks += 1;
        }
      }
    }
    expect(wholeBatches).toBeGreaterThan(0);
    expect(multiPart).toBeGreaterThan(0);
    expect(checks).toBeGreaterThan(seeds * 3 * 30);
  });

  it("a batch that starts above the reader's rev is a gap; an unchanged body takes no new rev", () => {
    const { db } = memoryStore();
    const stream = ownTableStream(db);
    db.prepare("INSERT INTO streams (stream, owner, logId, head, state) VALUES (?, 'self', 'inc-00000001', 0, 'live')").run(stream);
    db.exec("BEGIN IMMEDIATE");
    const random = rng(3);
    const body = summaryBody(1, random);
    expect(putRow(db, stream, "bot:B1", body)).toBe(1);
    expect(putRow(db, stream, "bot:B1", body)).toBeNull();
    expect(putRow(db, stream, "bot:B2", summaryBody(2, random))).toBe(2);
    expect(() => putRow(db, stream, "bot:B3", { ...body, lines: ["a", "b", "c", "d"] })).toThrow(/refused/);
    db.exec("COMMIT");
    expect(() => applyRows(emptyTable(), readCatchUp(db, stream, 1))).toThrow(/cannot follow/);
  });
});

describe("summary rows: row kinds this version does not know (plan change N4)", () => {
  it("are kept, caught up and passed on verbatim, never refused or dropped, and left alone by the summary writer", async () => {
    const s = await setup({ views: { B1: view("B1") } });
    await s.settle();
    // `plugin:` has been a known kind since M5-13a, so its body must now pass PluginRow; `future-kind` stays the unknown one.
    const plugin = {
      codeHash: "sha256:abc",
      manifest: { tier: "read", reads: ["bots"], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
      author: "user", files: [], grants: {},
    };
    const future = ["any", { json: true }, 3];
    const base = tableRev(s.db, s.stream);
    // As a newer server (or a newer version of this one) would have written them.
    s.db.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 0)").run(s.stream, "plugin:notes", base + 1, JSON.stringify(plugin));
    s.db.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 0)").run(s.stream, "future-kind", base + 2, JSON.stringify(future));
    s.db.prepare("INSERT INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, ?, ?, 1)").run(s.stream, "plugin:gone", base + 3, JSON.stringify({ deletedAt: s.clock.t }));
    // Catch-up carries them, the frame passes the wire schema, a reader keeps them as they are.
    const parts = readCatchUp(s.db, s.stream, base);
    for (const part of parts) expect(Rows.safeParse(part).success).toBe(true);
    expect(parts.flatMap((part) => part.rows)).toEqual([
      { key: "plugin:notes", rev: base + 1, body: plugin },
      { key: "future-kind", rev: base + 2, body: future },
      { key: "plugin:gone", rev: base + 3, deleted: true },
    ]);
    const encoded = encodeWireFrame(parts[0], "peer", { local: false });
    expect(encoded.ok).toBe(true);
    const wire = encoded.ok ? decodeWireFrame(encoded.text, "peer", { local: false }) : null;
    expect(wire?.ok).toBe(true);
    expect(wire?.ok && (wire.message as Rows).rows).toEqual(parts[0].rows);
    const copy = applyRows(readTable(s.db, s.stream), parts);
    expect(copy.rows.get("plugin:notes")?.body).toEqual(plugin);
    expect(copy.rows.get("future-kind")?.body).toEqual(future);
    // A whole-table catch-up (reader below the purge mark) keeps them too.
    expect(applyRows(emptyTable(), readCatchUp(s.db, s.stream, 0)).rows.get("plugin:notes")?.body).toEqual(plugin);
    // The summary writer's restart pass, its purge and later writes leave them alone.
    await s.runtime.scope.submit((tx) => s.summary.reconcile(tx));
    emit(s, { type: "bot.updated", bot: view("B1", { unread: 9 }) });
    await s.settle();
    s.clock.advanceTo(s.clock.t + 3_000);
    await s.settle();
    expect(await s.summary.purge()).toBe(0);
    const kept = readTable(s.db, s.stream);
    expect(kept.rows.get("plugin:notes")?.body).toEqual(plugin);
    expect(kept.rows.get("future-kind")?.body).toEqual(future);
    expect(kept.rows.get("plugin:notes")?.rev).toBe(base + 1);
    // Only its size is checked: an unknown kind past a table row is refused like an oversize known row.
    expect(TableRow.safeParse({ key: "plugin:big", rev: 1, body: "x".repeat(40_000) }).success).toBe(false);
    s.close();
  });
});
