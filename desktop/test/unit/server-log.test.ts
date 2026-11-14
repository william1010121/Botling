// Botling 3 bot log streams (src/server/log, protocol v1 §8.1, §8.3, §8.4, §7.6, D50): append with the hash chain
// inside writer transactions, cursors, snap, history, reset on a foreign or retired logId, rewind detection, eviction,
// and the reader window. The random sequences are in server-log-property.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BotSnapView, Entry, GENESIS_HASH, MESSAGES, type Message, type StreamId } from "../../src/protocol";
import {
  appendEntries, ENTRY_BYTES_LIMIT, ensureStream, evictEntries, hashEntry, listRetired, LogHub, LogError, nextHlc, readEntries,
  readHistory, readSnap, readStream, retireStream, verifyChain, verifyStream,
} from "../../src/server/log";
import { openServerStore } from "../../src/server/store";
import { FakeFe, message, quickStore, type QuickStore } from "./server-log-helpers";

const A = "bot:alpha" as StreamId;
const B = "bot:beta" as StreamId;
const stores: QuickStore[] = [];
const hubs: LogHub[] = [];
function setup(options: ConstructorParameters<typeof LogHub>[1] = {}) {
  const store = quickStore();
  stores.push(store);
  const hub = new LogHub(store, options);
  hubs.push(hub);
  return { store, hub };
}
afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  for (const store of stores.splice(0)) await store.close();
});

const added = (botId: string, id: string, text?: string) => ({ kind: "message.added", body: { botId, message: message(id, text) } });
async function open(store: QuickStore, ...streams: StreamId[]) {
  await store.submit((db) => { for (const stream of streams) ensureStream(db, stream); });
}
async function fill(hub: LogHub, stream: StreamId, count: number, prefix = "m") {
  const botId = stream.slice(4);
  for (let i = 0; i < count; i++) await hub.append(stream, [added(botId, `${prefix}${i}`)]);
}
const head = (store: QuickStore, stream: StreamId) => readStream(store.db, stream)!;

describe("append and the hash chain (§8.1)", () => {
  it("numbers entries gaplessly per (stream, logId), chains their hashes and keeps head/headHash", async () => {
    const { store, hub } = setup();
    await open(store, A, B);
    const first = await hub.append(A, [added("alpha", "a1"), added("alpha", "a2")]);
    const other = await hub.append(B, [added("beta", "b1")]);
    const third = await hub.append(A, [{ kind: "message.removed", body: { botId: "alpha", messageId: "a1" } }]);
    expect(first.map((e) => e.seq)).toEqual([1, 2]);
    expect(other.map((e) => e.seq)).toEqual([1]);
    expect(third[0].seq).toBe(3);
    const all = [...first, ...third];
    for (const entry of all) expect(Entry.safeParse(entry).success).toBe(true);
    expect(first[0].hash).toBe(hashEntry(GENESIS_HASH, first[0]));
    expect(verifyChain(GENESIS_HASH, all)).toEqual({ ok: true, lastHash: third[0].hash });
    expect(head(store, A)).toMatchObject({ head: 3, headHash: third[0].hash, tail: 0 });
    expect(verifyStream(store.db, A).ok).toBe(true);
    expect(verifyStream(store.db, B).ok).toBe(true);
    // Stored entries read back exactly as appended.
    expect(readEntries(store.db, A, 1, { maxEntries: 10, maxBytes: 1e9 }).entries).toEqual(all);
  });

  it("detects a changed, missing or reordered entry", async () => {
    const { store, hub } = setup();
    await open(store, A);
    await fill(hub, A, 5);
    store.db.prepare("UPDATE entries SET body = ? WHERE stream = ? AND seq = 3").run(JSON.stringify({ botId: "alpha", message: message("m2", "forged") }), A);
    expect(verifyStream(store.db, A)).toEqual({ ok: false, seq: 3, reason: "hash" });
    const entries = readEntries(store.db, A, 1, { maxEntries: 10, maxBytes: 1e9 }).entries;
    expect(verifyChain(GENESIS_HASH, [entries[0], entries[2]])).toMatchObject({ ok: false, reason: "gap" });
    store.db.prepare("DELETE FROM entries WHERE stream = ? AND seq = 4").run(A);
    expect(verifyStream(store.db, A)).toMatchObject({ ok: false });
  });

  it("appends only inside a writer command, and a failing command leaves no entry and no head change", async () => {
    const { store, hub } = setup();
    await open(store, A);
    await fill(hub, A, 2);
    expect(() => appendEntries(store.db, A, [added("alpha", "x")])).toThrow(LogError);
    await expect(store.submit((db) => { appendEntries(db, A, [added("alpha", "x")]); throw new Error("handler failed"); })).rejects.toThrow("handler failed");
    expect(head(store, A).head).toBe(2);
    expect(store.db.prepare("SELECT count(*) AS n FROM entries").get()!.n).toBe(2);
    expect(store.db.prepare("SELECT count(*) AS n FROM messages").get()!.n).toBe(2);
    // Several commands in one group commit still chain in order.
    const results = await Promise.all([1, 2, 3].map((i) => store.submit((db) => appendEntries(db, A, [added("alpha", `g${i}`)]))));
    expect(results.map((r) => r[0].seq)).toEqual([3, 4, 5]);
    expect(verifyStream(store.db, A).ok).toBe(true);
  });

  it("refuses unknown kinds, bodies of another bot, entries too big for a frame, and unknown or foreign streams", async () => {
    const { store } = setup();
    await open(store, A);
    const append = (items: Parameters<typeof appendEntries>[2], stream = A) => store.submit((db) => appendEntries(db, stream, items));
    await expect(append([{ kind: "nonsense", body: {} }])).rejects.toMatchObject({ code: "invalid entry" });
    await expect(append([{ kind: "turn.delta", body: { botId: "alpha", turnId: "t", messageId: "m", text: "x" } }])).rejects.toMatchObject({ code: "invalid entry" });
    await expect(append([added("beta", "x")])).rejects.toMatchObject({ code: "invalid entry" });
    await expect(append([added("alpha", "x", "y".repeat(ENTRY_BYTES_LIMIT))])).rejects.toMatchObject({ code: "too large" });
    await expect(append([added("ghost", "x")], "bot:ghost" as StreamId)).rejects.toMatchObject({ code: "unknown stream" });
    await store.submit((db) => db.prepare("INSERT INTO streams (stream, owner, logId, head, state) VALUES ('bot:peer', 'other', 'peerlog0001', 0, 'live')").run());
    await expect(append([added("peer", "x")], "bot:peer" as StreamId)).rejects.toMatchObject({ code: "not own" });
    expect(head(store, A).head).toBe(0);
  });

  it("gives entries a hybrid clock that never goes back", () => {
    expect(nextHlc(null, 1000)).toEqual({ ms: 1000, c: 0 });
    expect(nextHlc({ ms: 1000, c: 0 }, 900)).toEqual({ ms: 1000, c: 1 });
    expect(nextHlc({ ms: 1000, c: 0xffff }, 1000)).toEqual({ ms: 1001, c: 0 });
    expect(nextHlc({ ms: 1000, c: 3 }, 2000)).toEqual({ ms: 2000, c: 0 });
  });

  it("keeps the messages read model with the log: updates keep their place, removals go", async () => {
    const { store, hub } = setup();
    await open(store, A);
    await fill(hub, A, 3);
    await hub.append(A, [{ kind: "message.updated", body: { botId: "alpha", message: message("m0", "edited") } }, { kind: "message.removed", body: { botId: "alpha", messageId: "m1" } }]);
    const snap = readSnap(store.db, A)!;
    const view = BotSnapView.parse(snap.frame.view);
    expect(view.messages.map((m) => [m.id, m.text])).toEqual([["m0", "edited"], ["m2", "line m2"]]);
    expect(snap.frame.seq).toBe(5);
  });
});

describe("readers: sub, batches, ack and the window (§8.3, §10.4)", () => {
  it("a first open gets a snap, then new entries pushed as batches", async () => {
    const { store, hub } = setup();
    await store.submit((db) => {
      ensureStream(db, A);
      db.prepare("INSERT INTO bots (botId, settings, unread, model, liveTurnId, liveText, liveAt) VALUES ('alpha', '{\"x\":1}', 2, 'opus', 't1', 'so far', 5)").run();
      db.prepare("INSERT INTO cards (botId, cardId, rev, state, body) VALUES ('alpha', 'c1', 1, 'open', '{\"kind\":\"approval\"}'), ('alpha', 'c2', 1, 'done', '{}')").run();
    });
    await fill(hub, A, 2);
    const fe = new FakeFe("fe");
    const reader = hub.attach(fe.receive);
    expect(await reader.sub(A, null)).toEqual({ ok: true });
    expect(fe.frames.map((f) => f.t)).toEqual(["snap"]);
    const view = BotSnapView.parse((fe.frames[0] as Extract<Message, { t: "snap" }>).view);
    expect(view.bot).toEqual({ botId: "alpha", head: 2, unread: 2, model: "opus", settings: { x: 1 }, live: { turnId: "t1", text: "so far", at: 5 } });
    expect(view.cards).toEqual([{ cardId: "c1", rev: 1, state: "open", body: { kind: "approval" } }]);
    expect(view.messages.map((m) => m.id)).toEqual(["m0", "m1"]);
    expect(view.history).toEqual({ hasMore: false, older: 0 });
    await hub.append(A, [added("alpha", "n1"), added("alpha", "n2")]);
    expect(fe.frames.map((f) => f.t)).toEqual(["snap", "batch"]);
    expect(fe.cursor(A)).toEqual({ logId: head(store, A).logId, seq: 4 });
    expect(fe.hash(A)).toBe(head(store, A).headHash);
    expect(fe.violations).toEqual([]);
  });

  it("a cursor of the current logId resumes from seq + 1 with the right prevHash, never resending", async () => {
    const { store, hub } = setup();
    await open(store, A);
    await fill(hub, A, 6);
    const entries = readEntries(store.db, A, 1, { maxEntries: 10, maxBytes: 1e9 }).entries;
    const fe = new FakeFe("fe");
    fe.forceCursor(A, { logId: head(store, A).logId, seq: 4 }, entries[3].hash);
    const reader = hub.attach(fe.receive);
    await reader.sub(A, fe.cursor(A));
    expect(fe.frames).toHaveLength(1);
    expect(fe.frames[0]).toMatchObject({ t: "batch", from: 5, to: 6, prevHash: entries[3].hash, more: false });
    // At the head: nothing to send.
    await reader.sub(A, fe.cursor(A));
    expect(fe.frames).toHaveLength(1);
    expect(fe.violations).toEqual([]);
  });

  it("sends at most a page unacknowledged; ack asks for the next one; a reader at the head is pushed until the window fills", async () => {
    const { store, hub } = setup({ pageEntries: 10 });
    await open(store, A);
    await fill(hub, A, 25);
    const fe = new FakeFe("fe");
    fe.forceCursor(A, { logId: head(store, A).logId, seq: 0 }, GENESIS_HASH);
    const reader = hub.attach(fe.receive);
    await reader.sub(A, fe.cursor(A));
    expect(fe.cursor(A)!.seq).toBe(10);
    expect((fe.frames.at(-1) as Extract<Message, { t: "batch" }>).more).toBe(true);
    reader.ack(A, { logId: "otherlogid01", seq: 10 }); // another incarnation's ack: ignored
    reader.ack(A, { logId: head(store, A).logId, seq: 99 }); // beyond what was sent: ignored
    expect(fe.cursor(A)!.seq).toBe(10);
    reader.ack(A, fe.cursor(A)!);
    expect(fe.cursor(A)!.seq).toBe(20);
    reader.ack(A, { logId: head(store, A).logId, seq: 15 }); // a partial ack frees part of the window
    expect(fe.cursor(A)!.seq).toBe(25);
    reader.ack(A, fe.cursor(A)!);
    await fill(hub, A, 12, "p"); // pushed without asking, until 10 are unacknowledged
    expect(fe.cursor(A)!.seq).toBe(35);
    reader.ack(A, fe.cursor(A)!);
    expect(fe.cursor(A)!.seq).toBe(37);
    expect(fe.violations).toEqual([]);
  });

  it("cuts batches so every frame fits 256 KiB, and the byte window holds back big entries", async () => {
    const { store, hub } = setup({ pageBytes: 400 * 1024 });
    await open(store, A);
    for (let i = 0; i < 6; i++) await hub.append(A, [added("alpha", `big${i}`, "z".repeat(100_000))]);
    const fe = new FakeFe("fe");
    fe.forceCursor(A, { logId: head(store, A).logId, seq: 0 }, GENESIS_HASH);
    const reader = hub.attach(fe.receive);
    await reader.sub(A, fe.cursor(A));
    const batches = fe.frames as Array<Extract<Message, { t: "batch" }>>;
    expect(batches.length).toBeGreaterThan(1);
    expect(fe.cursor(A)!.seq).toBe(5); // pushed while under 400 KiB unacknowledged: 4 × ~100 KB leave room, the 5th fills it
    reader.ack(A, fe.cursor(A)!);
    expect(fe.cursor(A)!.seq).toBe(6);
    expect(fe.violations).toEqual([]);
  });

  it("unsub and close stop every push", async () => {
    const { store, hub } = setup();
    await open(store, A, B);
    const fe = new FakeFe("fe");
    const reader = hub.attach(fe.receive);
    await reader.sub(A, null);
    await reader.sub(B, null);
    reader.unsub(A);
    await fill(hub, A, 1);
    await fill(hub, B, 1);
    expect(fe.frames.map((f) => f.t)).toEqual(["snap", "snap", "batch"]);
    reader.close();
    await fill(hub, B, 1);
    expect(fe.frames).toHaveLength(3);
    expect(await reader.sub(B, null)).toEqual({ ok: false, reason: "closed" });
  });

  it("refuses unknown streams and table streams", async () => {
    const { hub } = setup();
    const reader = hub.attach(() => {});
    expect(await reader.sub("bot:none" as StreamId, null)).toEqual({ ok: false, reason: "unknown stream" });
    expect(await reader.sub("srv:x" as StreamId, null)).toEqual({ ok: false, reason: "not a bot stream" });
  });
});

describe("reset and rewind (§7.6, §8.3, D50)", () => {
  it("a foreign logId yields reset (listing it) + snap of the current incarnation", async () => {
    const { store, hub } = setup();
    await open(store, A);
    await fill(hub, A, 3);
    const fe = new FakeFe("fe");
    fe.forceCursor(A, { logId: "foreignlog01", seq: 2 });
    const reader = hub.attach(fe.receive);
    await reader.sub(A, fe.cursor(A));
    expect(fe.frames.map((f) => f.t)).toEqual(["reset", "snap"]);
    expect(fe.frames[0]).toMatchObject({ logId: head(store, A).logId, retired: [{ logId: "foreignlog01", keptSeq: 0 }], reason: "restored" });
    expect(fe.frames[1]).toMatchObject({ logId: head(store, A).logId, seq: 3, hash: head(store, A).headHash });
    expect(fe.violations).toEqual([]);
  });

  it("a retired logId yields reset listing every retired logId with its kept seq; readers never go back", async () => {
    const { store, hub } = setup();
    await open(store, A);
    await fill(hub, A, 3);
    const first = head(store, A).logId;
    const watcher = new FakeFe("watcher");
    const watching = hub.attach(watcher.receive);
    await watching.sub(A, null);
    const retiredOnce = await store.submit((db) => retireStream(db, A, "restored"));
    hub.retiredUnder([[A, first]]); // a restore in this process: subscribed readers are reset at once
    expect(watcher.frames.map((f) => f.t)).toEqual(["snap", "reset", "snap"]);
    await fill(hub, A, 2, "n"); // seq goes on: 4, 5 in the new incarnation, chained to entry 3
    const second = head(store, A).logId;
    await store.submit((db) => retireStream(db, A, "restored"));
    expect(listRetired(store.db, A)).toEqual([
      { logId: first, keptSeq: 3, reason: "restored" }, { logId: second, keptSeq: 5, reason: "restored" },
    ]);
    expect(retiredOnce.logId).toBe(second);
    expect(verifyStream(store.db, A).ok).toBe(true);
    const fe = new FakeFe("fe");
    fe.forceCursor(A, { logId: first, seq: 3 });
    const reader = hub.attach(fe.receive);
    await reader.sub(A, fe.cursor(A));
    expect(fe.frames.map((f) => f.t)).toEqual(["reset", "snap"]);
    expect(fe.frames[0]).toMatchObject({ logId: head(store, A).logId, retired: [{ logId: first, keptSeq: 3 }, { logId: second, keptSeq: 5 }] });
    // The reader now holds the new logId; a late frame of an old one would be dropped by it (FakeFe checks).
    await fill(hub, A, 1, "z");
    expect(fe.cursor(A)).toEqual({ logId: head(store, A).logId, seq: 6 });
    expect(fe.violations).toEqual([]);
    // Entries of all incarnations still verify as one chain; each carries its own logId.
    const logIds = readEntries(store.db, A, 1, { maxEntries: 10, maxBytes: 1e9 }).entries.map((e) => e.logId);
    expect(logIds).toEqual([first, first, first, second, second, head(store, A).logId]);
  });

  it("a cursor beyond the head is a rewind: every own stream gets a new logId, readers get reset + snap", async () => {
    let onRewind = 0;
    const { store, hub } = setup({ onRewind: (db) => { onRewind++; expect(db.inTransaction).toBe(true); } });
    await open(store, A, B);
    await fill(hub, A, 3);
    await fill(hub, B, 2);
    const oldA = head(store, A).logId;
    const oldB = head(store, B).logId;
    const other = new FakeFe("other");
    const otherReader = hub.attach(other.receive);
    await otherReader.sub(B, null);
    const fe = new FakeFe("fe");
    fe.forceCursor(A, { logId: oldA, seq: 7 }); // it saw 7 of this incarnation, the store holds 3
    const reader = hub.attach(fe.receive);
    const second = new FakeFe("second");
    second.forceCursor(A, { logId: oldA, seq: 9 });
    const secondReader = hub.attach(second.receive);
    await Promise.all([reader.sub(A, fe.cursor(A)), secondReader.sub(A, second.cursor(A))]);
    expect(onRewind).toBe(1); // two readers noticed at once: one rewind
    expect(head(store, A).logId).not.toBe(oldA);
    expect(head(store, B).logId).not.toBe(oldB);
    expect(listRetired(store.db, A)).toEqual([{ logId: oldA, keptSeq: 3, reason: "rewind" }]);
    for (const seen of [fe, second]) {
      expect(seen.frames.map((f) => f.t)).toEqual(["reset", "snap"]);
      expect(seen.frames[0]).toMatchObject({ reason: "rewind", retired: [{ logId: oldA, keptSeq: 3 }] });
      expect(seen.cursor(A)).toEqual({ logId: head(store, A).logId, seq: 3 });
    }
    expect(other.frames.map((f) => f.t)).toEqual(["snap", "reset", "snap"]);
    expect(other.cursor(B)).toEqual({ logId: head(store, B).logId, seq: 2 });
    for (const seen of [fe, second, other]) expect(seen.violations).toEqual([]);
  });
});

describe("eviction", () => {
  it("serves readers from the tail with its hash, gives readers behind it a snap, and keeps the chain verifiable", async () => {
    const { store, hub } = setup();
    await open(store, A);
    await fill(hub, A, 8);
    const entries = readEntries(store.db, A, 1, { maxEntries: 10, maxBytes: 1e9 }).entries;
    expect(await hub.evict(A, 5)).toBe(5);
    expect(head(store, A)).toMatchObject({ tail: 5, tailHash: entries[4].hash, head: 8 });
    expect(await hub.evict(A, 3)).toBe(0);
    expect(verifyStream(store.db, A).ok).toBe(true);
    const atTail = new FakeFe("tail");
    atTail.forceCursor(A, { logId: head(store, A).logId, seq: 5 }, entries[4].hash);
    await hub.attach(atTail.receive).sub(A, atTail.cursor(A));
    expect(atTail.frames.map((f) => f.t)).toEqual(["batch"]);
    expect(atTail.cursor(A)!.seq).toBe(8);
    const behind = new FakeFe("behind");
    behind.forceCursor(A, { logId: head(store, A).logId, seq: 2 }, entries[1].hash);
    await hub.attach(behind.receive).sub(A, behind.cursor(A));
    expect(behind.frames.map((f) => f.t)).toEqual(["snap"]);
    expect(behind.cursor(A)!.seq).toBe(8);
    // Evicting everything, then appending, still chains from the tail.
    await hub.evict(A, 100);
    expect(head(store, A)).toMatchObject({ tail: 8, head: 8 });
    await fill(hub, A, 2, "n");
    expect(verifyStream(store.db, A).ok).toBe(true);
    expect(atTail.cursor(A)!.seq).toBe(10);
    for (const seen of [atTail, behind]) expect(seen.violations).toEqual([]);
  });

  it("a reader whose unsent entries were evicted under it gets a snap", async () => {
    const { store, hub } = setup({ pageEntries: 3 });
    await open(store, A);
    await fill(hub, A, 10);
    const fe = new FakeFe("fe");
    fe.forceCursor(A, { logId: head(store, A).logId, seq: 0 }, GENESIS_HASH);
    const reader = hub.attach(fe.receive);
    await reader.sub(A, fe.cursor(A));
    expect(fe.cursor(A)!.seq).toBe(3);
    await store.submit((db) => evictEntries(db, A, 7));
    reader.ack(A, fe.cursor(A)!);
    expect(fe.frames.at(-1)!.t).toBe("snap");
    expect(fe.cursor(A)!.seq).toBe(10);
    expect(fe.violations).toEqual([]);
  });
});

describe("snap and history paging (§8.4)", () => {
  it("history walks back page by page from the snap's first line, and answers null for an unknown line", async () => {
    const { store, hub } = setup();
    await open(store, A);
    await fill(hub, A, 40);
    const snap = readSnap(store.db, A)!;
    const view = BotSnapView.parse(snap.frame.view);
    expect(view.messages).toHaveLength(40);
    const seen: string[] = [];
    let before = "m20";
    for (;;) {
      const page = readHistory(store.db, { t: "history", req: "r1", stream: A, before, bytes: 1024 })!;
      expect(MESSAGES["history.page"].safeParse(page).success).toBe(true);
      expect(page.logId).toBe(snap.frame.logId);
      seen.unshift(...page.messages.map((m) => m.id));
      expect(page.older).toBe(Number(page.messages[0].id.slice(1)));
      if (!page.hasMore) break;
      before = page.messages[0].id;
    }
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
    expect(readHistory(store.db, { t: "history", req: "r2", stream: A, before: "nope" })).toBeNull();
    expect(readHistory(store.db, { t: "history", req: "r3", stream: "bot:none" as StreamId, before: "m1" })).toBeNull();
  });

  it("a snap of a long chat fits one frame and says how many older lines wait", async () => {
    const { store, hub } = setup();
    await open(store, A);
    for (let i = 0; i < 12; i++) await hub.append(A, [added("alpha", `m${i}`, "w".repeat(60_000))]);
    const fe = new FakeFe("fe");
    await hub.attach(fe.receive).sub(A, null);
    const snap = fe.frames[0] as Extract<Message, { t: "snap" }>;
    expect(Buffer.byteLength(JSON.stringify(snap))).toBeLessThanOrEqual(256 * 1024);
    const view = BotSnapView.parse(snap.view);
    expect(view.messages.length).toBeGreaterThan(0);
    expect(view.messages.at(-1)!.id).toBe("m11");
    expect(view.history).toEqual({ hasMore: true, older: 12 - view.messages.length });
    const page = await Promise.resolve(hub.attach(() => {}).history({ t: "history", req: "r", stream: A, before: view.messages[0].id }))!;
    expect(page!.messages.at(-1)!.id).toBe(`m${11 - view.messages.length}`);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(256 * 1024);
    expect(fe.violations).toEqual([]);
  });
});

describe("on the real store (durable settings)", () => {
  it("appends, pushes and verifies with openServerStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "botling-log-real-"));
    const store = await openServerStore(dir);
    const hub = new LogHub(store);
    try {
      await store.submit((db) => ensureStream(db, A));
      const check = store.openReader();
      try { expect(readStream(check, A)!.owner).toBe(store.meta("serverId")); } finally { check.close(); }
      const fe = new FakeFe("fe");
      await hub.attach(fe.receive).sub(A, null);
      await hub.append(A, [added("alpha", "x1"), added("alpha", "x2")]);
      expect(fe.cursor(A)!.seq).toBe(2);
      const reader = store.openReader();
      try { expect(verifyStream(reader, A).ok).toBe(true); } finally { reader.close(); }
      expect(fe.violations).toEqual([]);
    } finally {
      hub.close();
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
