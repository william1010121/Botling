// src/fe-link storage: the desktop's node:sqlite file (fe-link/sqlite-storage.ts) keeps exactly what the in-memory
// storage keeps for the same operations, survives a close and reopen, and a wiped file makes a new origin epoch.
// Also the outbox rules that need no socket: cmd.skipped and lost outcomes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyOps, emptyState, FeLink, MemoryFeStorage, Outbox, SerialWriter, type StorageOp } from "../../src/fe-link";
import { SqliteFeStorage } from "../../src/fe-link/sqlite-storage";
import { FakeClock, FakeServer, flush, react } from "./fe-link-harness";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempFile = () => { const dir = mkdtempSync(join(tmpdir(), "fe-link-")); dirs.push(dir); return join(dir, "fe.db"); };

const slot = (n: number, epoch = "a".repeat(32)) => ({ origin: "desktop", originEpoch: epoch, target: "bot:b1", n });
const item = (n: number, epoch?: string) => ({ slot: slot(n, epoch), cmd: react(`m${n}`), createdAt: n, state: "waiting" as const });

const OPS: StorageOp[][] = [
  [{ op: "epoch", epoch: "a".repeat(32) }],
  [{ op: "put", item: item(1) }, { op: "counter", target: "bot:b1", next: 2 }],
  [{ op: "put", item: item(2) }, { op: "counter", target: "bot:b1", next: 3 }],
  [{ op: "put", item: { ...item(1), state: "delivered", outcome: { kind: "applied" }, from: { logId: "log-0000001", seq: 4 } } }],
  [{ op: "cursor", stream: "bot:b1", cursor: { logId: "log-0000001", seq: 4, hash: "c".repeat(64) } }, { op: "cursor", stream: "srv:s1", cursor: { logId: "inc-0000001", seq: 0, hash: null } }],
  [{ op: "retired", stream: "bot:b1", retired: [{ logId: "log-0000000", keptSeq: 2 }] }, { op: "retired", stream: "bot:b1", retired: [{ logId: "log-0000000", keptSeq: 2 }] }],
  [{ op: "delete", slot: slot(2) }, { op: "epoch", epoch: "b".repeat(32) }, { op: "put", item: { ...item(1, "b".repeat(32)), movedFrom: slot(2) } }, { op: "counter", target: "bot:b1", next: 2 }],
  [{ op: "cursor", stream: "srv:s1", cursor: null }],
];

describe("SqliteFeStorage", () => {
  it("keeps the same state as the in-memory storage, across a close and reopen", async () => {
    const file = tempFile();
    const memory = new MemoryFeStorage();
    let disk = new SqliteFeStorage(file);
    for (const [i, ops] of OPS.entries()) {
      await memory.write(ops);
      await disk.write(ops);
      if (i % 3 === 2) { await disk.close(); disk = new SqliteFeStorage(file); }
    }
    const fromDisk = await disk.load();
    const fromMemory = await memory.load();
    const norm = (s: typeof fromDisk) => ({ ...s, items: [...s.items].sort((a, b) => (a.slot.originEpoch + a.slot.n).localeCompare(b.slot.originEpoch + b.slot.n)) });
    expect(norm(fromDisk)).toEqual(norm(fromMemory));
    expect(fromDisk).toMatchObject({ epoch: "b".repeat(32), counters: { "bot:b1": 2 }, retired: { "bot:b1": [{ logId: "log-0000000", keptSeq: 2 }] } });
    expect(Object.keys(fromDisk.cursors)).toEqual(["bot:b1"]);
    expect(applyOps(emptyState(), OPS.flat())).toEqual(fromMemory);
    await disk.close();
  });

  it("a write that fails applies nothing", async () => {
    const disk = new SqliteFeStorage(tempFile());
    await disk.write([{ op: "epoch", epoch: "a".repeat(32) }]);
    const broken = { op: "put", item: { ...item(1), slot: { ...slot(1), n: undefined } } } as unknown as StorageOp;
    await expect(disk.write([{ op: "counter", target: "bot:b1", next: 9 }, broken])).rejects.toThrow();
    expect((await disk.load()).counters).toEqual({});
    await disk.close();
  });

  it("a link on the file keeps its outbox and epoch across a restart; a wiped file makes a new epoch", async () => {
    const file = tempFile();
    const server = new FakeServer();
    server.refuse = true;
    const clock = new FakeClock();
    const open = (path: string) => FeLink.open({ storage: new SqliteFeStorage(path), dial: server.dial, deviceId: "desktop", feVersion: "3.0.0", clock });
    const first = await open(file);
    first.start();
    await first.submit("bot:b1", react("m1"));
    const epoch = first.epoch;
    await first.close();

    const second = await open(file);
    expect(second.epoch).toBe(epoch);
    expect(second.pending().map((p) => [p.slot.n, p.state])).toEqual([[1, "waiting"]]);
    server.refuse = false;
    second.subscribe("bot:b1");
    second.start();
    await flush();
    expect(server.applied.map((a) => [a.slot.originEpoch, a.slot.n])).toEqual([[epoch, 1]]);
    await second.close();

    rmSync(file, { force: true });
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
    const wiped = await open(file);
    expect(wiped.epoch).not.toBe(epoch);
    await wiped.close();
  });
});

describe("Outbox rules without a socket", () => {
  async function outbox() {
    const storage = new MemoryFeStorage();
    const writer = new SerialWriter(storage);
    const box = await Outbox.open({ origin: "desktop", state: await storage.load(), writer, newEpoch: () => "e".repeat(32), now: () => 1 });
    return { storage, box };
  }

  it("floor is the smallest unresolved n of the item's queue", async () => {
    const { box } = await outbox();
    const a = await box.submit("bot:b1", react("m1"));
    const b = await box.submit("bot:b1", react("m2"));
    const c = await box.submit("bot:b1", react("m3"));
    expect(box.envelope(c, "inc-0000001").floor).toBe(1);
    await box.resolve(a.slot, { kind: "applied" }, { logId: "log-0000001", seq: 1 });
    expect(box.envelope(c, "inc-0000001").floor).toBe(2);
    await box.resolve(b.slot, { kind: "cancelled" }, { logId: "log-0000001", seq: 2 });
    expect(box.envelope(c, "inc-0000001")).toMatchObject({ floor: 3, slot: { n: 3 } });
  });

  it("an outcome resolves an item once; later copies change nothing", async () => {
    const { box, storage } = await outbox();
    const a = await box.submit("bot:b1", react("m1"));
    expect(await box.resolve(a.slot, { kind: "applied" }, { logId: "log-0000001", seq: 1 })).toMatchObject({ kind: "delivered" });
    const writes = storage.writes;
    expect(await box.resolve(a.slot, { kind: "refused", reason: "changed" }, { logId: "log-0000001", seq: 1 })).toBeUndefined();
    expect(storage.writes).toBe(writes);
  });

  it("cmd.skipped marks unresolved slots in its range not sent, and delivered ones lost", async () => {
    const { box } = await outbox();
    const a = await box.submit("bot:b1", react("m1"));
    await box.submit("bot:b1", react("m2"));
    await box.submit("bot:b1", react("m3"));
    await box.resolve(a.slot, { kind: "applied" }, { logId: "log-0000001", seq: 1 });
    await box.skipped({ originEpoch: box.epoch, target: "bot:b1" }, 1, 2, { logId: "log-0000002", seq: 1 });
    expect(box.list().map((i) => [i.slot.n, i.state, i.outcome?.kind, i.lost ?? false])).toEqual([
      [1, "delivered", "applied", true], [2, "not sent", "skipped", false], [3, "waiting", undefined, false],
    ]);
  });

  it("giveUp moves an unresolved slot out of unresolved() into persisted not sent / skipped, advancing floor", async () => {
    const { box, storage } = await outbox();
    const a = await box.submit("bot:b1", react("m1"));
    const b = await box.submit("bot:b1", react("m2"));
    const given = await box.giveUp(a.slot);
    expect(given).toMatchObject({ slot: a.slot, state: "not sent", outcome: { kind: "skipped" } });
    expect(box.unresolved().map((i) => i.slot.n)).toEqual([2]);
    expect(box.envelope(b, "inc-0000001").floor).toBe(2);
    // Persisted across reopen until dismissed.
    const reloaded = await Outbox.open({ origin: "desktop", state: await storage.load(), writer: new SerialWriter(storage), now: () => 2 });
    expect(reloaded.list().map((i) => [i.slot.n, i.state, i.outcome?.kind])).toEqual([
      [1, "not sent", "skipped"],
      [2, "waiting", undefined],
    ]);
    expect(reloaded.unresolved().map((i) => i.slot.n)).toEqual([2]);
    // Calling giveUp again on an already-resolved item is a no-op.
    const writes = storage.writes;
    expect(await reloaded.giveUp(a.slot)).toBeUndefined();
    expect(storage.writes).toBe(writes);
  });

  it("a reset marks delivered items above the kept seq lost and settle leaves them for the UI", async () => {
    const { box } = await outbox();
    const a = await box.submit("bot:b1", react("m1"));
    const b = await box.submit("bot:b1", react("m2"));
    await box.resolve(a.slot, { kind: "applied" }, { logId: "log-0000001", seq: 3 });
    await box.resolve(b.slot, { kind: "applied" }, { logId: "log-0000001", seq: 5 });
    await box.markLost("bot:b1", [{ logId: "log-0000001", keptSeq: 4 }]);
    await box.settle("bot:b1", { logId: "log-0000001", seq: 4 });
    expect(box.list().map((i) => [i.slot.n, i.lost ?? false])).toEqual([[2, true]]);
  });
});

describe("fe-link stays pure", () => {
  it("imports no Electron, core, main or Node built-in outside the sqlite storage", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = join(__dirname, "../../src/fe-link");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts") && n !== "sqlite-storage.ts")) {
      const imports = [...readFileSync(join(dir, name), "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of imports) expect(/^(node:|electron)|\/(core|main|main-v3)\/|sqlite/.test(spec), `${name} imports ${spec}`).toBe(false);
    }
    expect(readFileSync(join(dir, "index.ts"), "utf8")).not.toMatch(/from\s+"\.\/sqlite-storage"/);
  });
});
