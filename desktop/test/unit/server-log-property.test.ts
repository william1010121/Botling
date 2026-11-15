// Property test of the bot log streams (src/server/log): random sequences of append / sub / ack / evict / unsub /
// reconnect / restore-style retire, with readers that send foreign and rewound cursors. After every step each reader
// holds a gapless prefix of the stream (its cursor's hash is the store's chain hash at that seq, every frame it
// applied continued its cursor); a foreign logId always yields reset + snap; the stored chain verifies; and once the
// readers ack to the end they all reach the head. Seeded, so a failure names the seed that reproduces it.
import { afterEach, describe, expect, it } from "vitest";
import type { StreamId } from "../../src/protocol";
import { ensureStream, hashAfter, LogHub, readStream, retireStream, verifyStream, type LogReader } from "../../src/server/log";
import { FakeFe, message, quickStore, type QuickStore } from "./server-log-helpers";
import { envCount } from "../helpers";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STREAMS = ["bot:alpha", "bot:beta"] as StreamId[];
const RUNS = envCount("V3_LOG_PROPERTY_RUNS", 30); // CI lowers it on pull requests
const STEPS = 160;

const stores: QuickStore[] = [];
const hubs: LogHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  for (const store of stores.splice(0)) await store.close();
});

interface Client { fe: FakeFe; reader: LogReader; subscribed: Set<StreamId> }

async function run(seed: number): Promise<{ steps: Record<string, number> }> {
  const random = mulberry32(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const int = (max: number) => Math.floor(random() * (max + 1));
  const store = quickStore();
  stores.push(store);
  const hub = new LogHub(store, { pageEntries: 1 + int(8), pageBytes: 1024 + int(6000) });
  hubs.push(hub);
  await store.submit((db) => { for (const stream of STREAMS) ensureStream(db, stream); });
  const clients: Client[] = Array.from({ length: 3 }, (_, i) => {
    const fe = new FakeFe(`seed ${seed} fe${i}`);
    return { fe, reader: hub.attach(fe.receive), subscribed: new Set<StreamId>() };
  });
  const lines = new Map<StreamId, string[]>(STREAMS.map((s) => [s, []]));
  let made = 0;
  const steps: Record<string, number> = {};
  const count = (name: string) => { steps[name] = (steps[name] ?? 0) + 1; };

  const check = (where: string) => {
    for (const { fe } of clients) {
      expect(fe.violations, `${where}`).toEqual([]);
      for (const stream of STREAMS) {
        const cursor = fe.cursor(stream);
        if (!cursor) continue;
        const row = readStream(store.db, stream)!;
        if (cursor.logId !== row.logId) continue; // retired under it: it moves only by reset + snap
        // Gapless prefix: the reader's position is in the stream and its hash is the chain's hash there.
        expect(cursor.seq, `${where}: ${fe.name} ${stream} cursor beyond head`).toBeLessThanOrEqual(row.head);
        const expected = hashAfter(store.db, row, cursor.seq);
        if (expected !== null) expect(fe.hash(stream), `${where}: ${fe.name} ${stream} hash at ${cursor.seq}`).toBe(expected);
        const view = fe.streams.get(stream)!;
        view.applied.forEach((entry, index) => {
          if (index > 0) expect(entry.seq).toBe(view.applied[index - 1].seq + 1);
        });
      }
    }
  };

  for (let step = 0; step < STEPS; step++) {
    const stream = pick(STREAMS);
    const botId = stream.slice(4);
    const client = pick(clients);
    const roll = random();
    const where = `seed ${seed} step ${step}`;
    if (roll < 0.34) {
      count("append");
      const items = Array.from({ length: 1 + int(3) }, () => {
        const known = lines.get(stream)!;
        const r = random();
        if (known.length && r < 0.2) return { kind: "message.updated", body: { botId, message: message(pick(known), `edit ${made++}`) } };
        if (known.length && r < 0.3) {
          const id = pick(known);
          known.splice(known.indexOf(id), 1);
          return { kind: "message.removed", body: { botId, messageId: id } };
        }
        const id = `m${made++}`;
        known.push(id);
        return { kind: "message.added", body: { botId, message: message(id, "x".repeat(int(400))) } };
      });
      await hub.append(stream, items);
    } else if (roll < 0.52) {
      count("sub");
      client.subscribed.add(stream);
      await client.reader.sub(stream, client.fe.cursor(stream));
    } else if (roll < 0.72) {
      count("ack");
      const cursor = client.fe.cursor(stream);
      if (cursor) client.reader.ack(stream, cursor);
    } else if (roll < 0.78) {
      count("evict");
      const row = readStream(store.db, stream)!;
      await hub.evict(stream, row.tail + int(Math.max(0, row.head - row.tail)));
    } else if (roll < 0.82) {
      count("unsub");
      client.subscribed.delete(stream);
      client.reader.unsub(stream);
    } else if (roll < 0.86) {
      count("reconnect"); // the FE keeps its cursors (durable storage) and attaches again
      client.reader.close();
      client.reader = hub.attach(client.fe.receive);
      client.subscribed.clear();
    } else if (roll < 0.9) {
      count("foreign");
      const fe = new FakeFe(`${where} foreign`);
      const foreign = `foreign${seed}x${step}`;
      fe.forceCursor(stream, { logId: foreign, seq: int(20) });
      const reader = hub.attach(fe.receive);
      await reader.sub(stream, fe.cursor(stream));
      expect(fe.frames.map((f) => f.t), where).toEqual(["reset", "snap"]);
      const reset = fe.frames[0] as Extract<typeof fe.frames[number], { t: "reset" }>;
      expect(reset.retired.map((r) => r.logId), where).toContain(foreign);
      expect(reset.logId, where).toBe(readStream(store.db, stream)!.logId);
      expect(fe.violations, where).toEqual([]);
      reader.close();
    } else if (roll < 0.93) {
      count("rewind"); // a reader that saw more of this incarnation than the store holds
      const row = readStream(store.db, stream)!;
      const fe = new FakeFe(`${where} rewound`);
      fe.forceCursor(stream, { logId: row.logId, seq: row.head + 1 + int(5) });
      const reader = hub.attach(fe.receive);
      await reader.sub(stream, fe.cursor(stream));
      expect(fe.frames.map((f) => f.t), where).toEqual(["reset", "snap"]);
      expect(readStream(store.db, stream)!.logId, where).not.toBe(row.logId);
      expect(fe.violations, where).toEqual([]);
      reader.close();
    } else if (roll < 0.96) {
      count("restore"); // a restore done in this process (step 12 does the rest of §7.6)
      const old = readStream(store.db, stream)!.logId;
      await store.submit((db) => retireStream(db, stream, "restored"));
      hub.retiredUnder([[stream, old]]);
    } else {
      count("rehash");
      for (const s of STREAMS) expect(verifyStream(store.db, s), where).toMatchObject({ ok: true });
    }
    check(where);
  }

  // Drain: every reader subscribes to every stream and acks until nothing more comes; all reach the head.
  for (const client of clients) {
    for (const stream of STREAMS) {
      await client.reader.sub(stream, client.fe.cursor(stream));
      for (let guard = 0; guard < 10_000; guard++) {
        const cursor = client.fe.cursor(stream)!;
        const before = cursor.seq;
        client.reader.ack(stream, cursor);
        if (client.fe.cursor(stream)!.seq === before) break;
      }
      const row = readStream(store.db, stream)!;
      expect(client.fe.cursor(stream), `seed ${seed} drain ${client.fe.name}`).toEqual({ logId: row.logId, seq: row.head });
      expect(client.fe.hash(stream)).toBe(row.headHash);
    }
    expect(client.fe.violations).toEqual([]);
    expect(client.fe.dropped).toBe(0);
  }
  for (const stream of STREAMS) expect(verifyStream(store.db, stream)).toMatchObject({ ok: true });
  return { steps };
}

describe("bot log streams under random operations", () => {
  it(`keeps every reader a gapless prefix over ${RUNS} seeded runs of ${STEPS} steps`, async () => {
    const totals: Record<string, number> = {};
    for (let seed = 1; seed <= RUNS; seed++) {
      const { steps } = await run(seed);
      for (const [name, n] of Object.entries(steps)) totals[name] = (totals[name] ?? 0) + n;
      for (const hub of hubs.splice(0)) hub.close();
      for (const store of stores.splice(0)) await store.close();
    }
    // Every kind of step ran many times.
    for (const name of ["append", "sub", "ack", "evict", "unsub", "reconnect", "foreign", "rewind", "restore"]) expect(totals[name] ?? 0).toBeGreaterThan(20);
  }, 120_000);
});
