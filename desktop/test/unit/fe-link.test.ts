// src/fe-link (protocol v1 §11, §13): the front end's outbox, cursors and connection states against a fake socket and
// a fake server that runs the real slot rules. Done-when checks of M1 step 10: the outbox survives a client restart; a
// duplicate re-send gets the stored outcome; wiping the storage makes a new epoch; state transitions match §13.3;
// reset/snap and retired-logId drops work; cmd.retry leads to exactly one apply.
import { afterEach, describe, expect, it } from "vitest";
import { slotKey, type ConnectionState } from "../../src/protocol";
import { connReduce, FeLink, initialConn, MemoryFeStorage, writesSent, type ConnEvent, type FeLinkEvent, type FeLinkOptions, type FeStorage } from "../../src/fe-link";
import { BOT, FakeClock, FakeServer, flush, react, SRV_STREAM } from "./fe-link-harness";

const links: FeLink[] = [];
afterEach(async () => {
  for (const link of links.splice(0)) await link.stop();
});

let epochCounter = 0;
const nextEpoch = () => (++epochCounter).toString(16).padStart(32, "0");

async function openLink(server: FakeServer, storage: FeStorage, clock: FakeClock, over: Partial<FeLinkOptions> = {}): Promise<{ link: FeLink; events: FeLinkEvent[]; states: ConnectionState[] }> {
  const link = await FeLink.open({ storage, dial: server.dial, deviceId: "desktop", feVersion: "3.0.0", clock, newEpoch: nextEpoch, ...over });
  links.push(link);
  const events: FeLinkEvent[] = [];
  const states: ConnectionState[] = [link.state];
  link.on((event) => { events.push(event); if (event.type === "state") states.push(event.status.state); });
  link.subscribe(BOT);
  link.start();
  return { link, events, states };
}

const appliedNs = (server: FakeServer) => server.applied.map((a) => a.slot.n);

describe("outbox durability and resend", () => {
  it("the outbox survives a client restart and is sent on the next attach; each item applies once", async () => {
    const server = new FakeServer();
    server.refuse = true;
    const storage = new MemoryFeStorage();
    const clock = new FakeClock();
    const first = await openLink(server, storage, clock);
    const a = await first.link.submit(BOT, react("m1"));
    const b = await first.link.submit(BOT, react("m2"));
    expect([a.slot.n, b.slot.n]).toEqual([1, 2]);
    // Durable before resolved: both items are in the storage the moment submit resolved.
    expect(storage.snapshot().items.map((item) => item.slot.n)).toEqual([1, 2]);
    expect(first.link.pending(BOT).map((p) => p.state)).toEqual(["waiting", "waiting"]);
    const epoch = first.link.epoch;
    await first.link.stop();

    server.refuse = false;
    const second = await openLink(server, storage, clock);
    expect(second.link.epoch).toBe(epoch);
    expect(second.link.pending(BOT).map((p) => [p.slot.n, p.state])).toEqual([[1, "waiting"], [2, "waiting"]]);
    await flush();
    expect(appliedNs(server)).toEqual([1, 2]);
    expect(server.applied.every((a) => a.slot.originEpoch === epoch)).toBe(true);
    // Delivered items leave the outbox once the stream shows their outcome entries (§13.4).
    expect(second.link.pending(BOT)).toEqual([]);
    expect(storage.snapshot().items).toEqual([]);
    expect((await second.link.submit(BOT, react("m3"))).slot.n).toBe(3);
  });

  it("a duplicate re-send gets the stored outcome, never a second apply", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const { link, events } = await openLink(server, storage, clock);
    await flush();
    expect(link.state).toBe("live");
    server.dropReplies = 1; // the cmd.result is lost on the wire
    link.unsubscribe(BOT);  // and no entry shows the outcome either
    const item = await link.submit(BOT, react("m1"));
    await flush();
    expect(appliedNs(server)).toEqual([1]);
    expect(link.pending(BOT).map((p) => p.state)).toEqual(["waiting"]);

    server.kill();
    await flush();
    expect(link.state).toBe("connecting");
    clock.advance(250);
    await flush();
    expect(link.state).toBe("live");
    // The same slot went out twice; the owner answered the second copy with the stored outcome.
    expect(server.copies.map((c) => c.slot.n)).toEqual([1, 1]);
    expect(appliedNs(server)).toEqual([1]);
    expect(outcomesOf(events, item.slot)).toEqual([{ kind: "applied", result: { n: 1 } }]);
    expect(link.pending()).toEqual([]);
  });

  it("wiping the storage makes a new origin epoch; the same storage keeps it", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const one = await openLink(server, storage, clock);
    const epoch = one.link.epoch;
    expect(epoch).toMatch(/^[0-9a-f]{32}$/);
    await flush();
    await one.link.submit(BOT, react("m1"));
    await flush();
    await one.link.stop();
    const again = await openLink(server, storage, clock);
    expect(again.link.epoch).toBe(epoch);
    await again.link.stop();

    const wiped = await openLink(server, new MemoryFeStorage(), clock);
    expect(wiped.link.epoch).not.toBe(epoch);
    await flush();
    const item = await wiped.link.submit(BOT, react("m2"));
    expect(item.slot).toMatchObject({ originEpoch: wiped.link.epoch, n: 1 });
    await flush();
    // A new epoch starts its own queue at n = 1: applied, not a slot conflict.
    expect(server.applied.map((a) => [a.slot.originEpoch, a.slot.n])).toEqual([[epoch, 1], [wiped.link.epoch, 1]]);
  });

  it("an item counts as in the outbox only once its write is durable", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const { link } = await openLink(server, storage, clock);
    await flush();
    let release!: () => void;
    storage.gate = () => new Promise<void>((resolve) => { release = resolve; });
    const submitted = link.submit(BOT, react("m1"));
    await flush();
    expect(link.pending()).toEqual([]);
    expect(server.copies).toEqual([]);
    storage.gate = null;
    release();
    await submitted;
    await flush();
    expect(server.copies.map((c) => c.slot.n)).toEqual([1]);
  });

  it("a failed write takes no slot number: the next item gets the same n", async () => {
    const server = new FakeServer();
    server.refuse = true;
    const storage = new MemoryFeStorage();
    const { link } = await openLink(server, storage, new FakeClock());
    storage.gate = () => Promise.reject(new Error("disk full"));
    await expect(link.submit(BOT, react("m1"))).rejects.toThrow("disk full");
    storage.gate = null;
    expect((await link.submit(BOT, react("m2"))).slot.n).toBe(1);
  });

  it("the pending marker shows only after ~150 ms without held or an outcome (§13.4)", async () => {
    const server = new FakeServer();
    server.refuse = true;
    const clock = new FakeClock();
    const { link } = await openLink(server, new MemoryFeStorage(), clock);
    await link.submit(BOT, react("m1"));
    expect(link.pending()[0].sending).toBe(false);
    clock.advance(149);
    expect(link.pending()[0].sending).toBe(false);
    clock.advance(1);
    expect(link.pending()[0].sending).toBe(true);
  });

  it("a slot conflict (a cloned storage) moves only the refused item to a new epoch; every command applies once", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const one = await openLink(server, storage, clock);
    await flush();
    const clone = new MemoryFeStorage();
    (clone as unknown as { state: unknown }).state = storage.snapshot();
    await one.link.submit(BOT, react("m1"));
    await flush();
    await one.link.stop();
    const two = await openLink(server, clone, clock);
    await flush();
    const item = await two.link.submit(BOT, react("m2", "🎉"));
    expect(item.slot).toMatchObject({ originEpoch: one.link.epoch, n: 1 });
    await flush();
    expect(two.link.epoch).not.toBe(one.link.epoch);
    expect(server.applied.map((a) => [a.slot.originEpoch, a.slot.n, (a.cmd as { emoji: string }).emoji])).toEqual([
      [one.link.epoch, 1, "👍"], [two.link.epoch, 1, "🎉"],
    ]);
    expect(two.link.pending()).toEqual([]);
  });
});

describe("cmd.retry (D49)", () => {
  it("a copy sent to an earlier incarnation waits for the owner's reset, then applies exactly once", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link, events } = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    expect(link.cursor(SRV_STREAM)?.logId).toBe("inc-00000001");
    server.holdResets = true;
    server.restore(); // the front end has not heard of it yet
    const item = await link.submit(BOT, react("m1"));
    await flush();
    expect(server.copies.map((c) => c.inc)).toEqual(["inc-00000001"]);
    expect(server.applied).toEqual([]);
    expect(link.pending()[0].state).toBe("waiting");
    // No re-send until the reset: the retry names an inc the front end does not follow yet.
    await flush();
    expect(server.copies).toHaveLength(1);

    server.releaseResets();
    await flush();
    expect(link.cursor(SRV_STREAM)?.logId).toBe("inc-00000002");
    expect(server.copies.map((c) => c.inc)).toEqual(["inc-00000001", "inc-00000002"]);
    expect(appliedNs(server)).toEqual([1]);
    expect(outcomesOf(events, item.slot)).toEqual([{ kind: "applied", result: { n: 1 } }]);

    // A reconnect re-sends nothing that is resolved.
    server.kill();
    await flush();
    clock.advance(250);
    await flush();
    expect(appliedNs(server)).toEqual([1]);
  });

  it("when the reset comes first, the retry re-sends at once under the new inc", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link } = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    server.dropReplies = 0;
    // Send while the restore happens: the cmd leaves with the old inc, the reset overtakes the retry.
    const pending = link.submit(BOT, react("m1"));
    server.restore();
    await pending;
    await flush();
    expect(appliedNs(server)).toEqual([1]);
    // Whatever copies left with the old inc were answered with cmd.retry; the one that applied carried the new inc.
    expect(server.copies[server.copies.length - 1].inc).toBe("inc-00000002");
    expect(server.copies.every((c) => c.inc === "inc-00000001" || c.inc === "inc-00000002")).toBe(true);
    expect(link.pending()).toEqual([]);
  });

  it("a retry for an item no longer held is ignored", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link } = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    const item = await link.submit(BOT, react("m1"));
    await flush();
    server.send({ t: "cmd.retry", slot: item.slot, inc: "inc-00000009" });
    await flush();
    expect(server.copies).toHaveLength(1);
    expect(appliedNs(server)).toEqual([1]);
  });
});

describe("cursors, reset/snap and retired logIds (§8.3, D50)", () => {
  it("a restore moves the reader through reset + snap; batches, snaps, resets and results of a retired logId are dropped", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const { link, events } = await openLink(server, storage, clock);
    await flush();
    await link.submit(BOT, react("m1"));
    await flush();
    const oldLog = link.cursor(BOT)!.logId;
    const oldEntries = server.entries(BOT);
    expect(link.cursor(BOT)!.seq).toBe(oldEntries.length);

    server.restore();
    await flush();
    expect(link.state).toBe("history restored");
    const newLog = link.cursor(BOT)!.logId;
    expect(newLog).not.toBe(oldLog);
    expect(link.retired(BOT).map((r) => r.logId)).toContain(oldLog);
    expect(storage.snapshot().retired[BOT].map((r) => r.logId)).toContain(oldLog);
    expect(storage.snapshot().cursors[BOT].logId).toBe(newLog);

    const before = events.length;
    // A late batch and snap of the old incarnation: dropped.
    server.send(server.batchOf(BOT, oldEntries, "0".repeat(64)));
    server.send({ t: "snap", stream: BOT, logId: oldLog, seq: 99, hash: "a".repeat(64), view: {} });
    // A reset back to the retired logId: dropped.
    server.send({ t: "reset", stream: BOT, logId: oldLog, retired: [{ logId: newLog, keptSeq: 1 }], reason: "restored" });
    await flush();
    expect(events.slice(before).filter((e) => e.type === "entries" || e.type === "snap" || e.type === "reset")).toEqual([]);
    expect(link.cursor(BOT)!.logId).toBe(newLog);

    // A late cmd.result of the retired logId is not an outcome: the item stays unresolved.
    link.unsubscribe(BOT);
    server.dropReplies = 1;
    const item = await link.submit(BOT, react("m2"));
    await flush();
    server.send({ t: "cmd.result", slot: item.slot, outcome: { kind: "applied" }, logId: oldLog, seq: 5 });
    await flush();
    expect(link.pending().map((p) => p.state)).toEqual(["waiting"]);
    // The real result of the current incarnation resolves it.
    server.send({ t: "cmd.result", slot: item.slot, outcome: { kind: "applied" }, logId: newLog, seq: 6 });
    await flush();
    expect(link.pending()).toEqual([]);
  });

  it("an outcome above the retired logId's kept seq shows 'delivered, then lost' (D50)", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link } = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    // Hold the batch back so the item stays "delivered" (its entry not yet shown).
    const realPush = server.push.bind(server);
    server.push = () => {};
    const item = await link.submit(BOT, react("m1"));
    await flush();
    expect(link.pending(BOT).map((p) => [p.state, p.lost])).toEqual([["delivered", false]]);
    server.push = realPush;
    server.restore(0); // the restore kept nothing of the old incarnation
    await flush();
    expect(link.pending(BOT).map((p) => [p.state, p.lost])).toEqual([["delivered", true]]);
    await link.dismiss(item.slot);
    expect(link.pending(BOT)).toEqual([]);
  });

  it("a gap asks for a re-sub from the cursor; a prevHash mismatch drops the cache and asks for a snap", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link, events } = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    server.push = () => {};
    await link.submit(BOT, react("m1"));
    await link.submit(BOT, react("m2"));
    await flush();
    const entries = server.entries(BOT);
    expect(entries).toHaveLength(2);
    const subsBefore = server.received.filter((m) => m.t === "sub").length;
    server.send(server.batchOf(BOT, [entries[1]], entries[0].hash)); // seq 2 while the cursor is at 0
    await flush();
    const subs = server.received.filter((m) => m.t === "sub");
    expect(subs.length).toBe(subsBefore + 1);
    expect(subs[subs.length - 1]).toMatchObject({ stream: BOT, cursor: { seq: 0 } });

    server.send(server.batchOf(BOT, [entries[0]], "f".repeat(64))); // wrong prevHash
    await flush();
    expect(events.some((e) => e.type === "dropped" && e.stream === BOT)).toBe(true);
    const last = server.received.filter((m) => m.t === "sub").pop();
    expect(last).toMatchObject({ stream: BOT, cursor: null });
  });

  it("duplicates at or below the cursor are dropped; an overlapping batch applies only the new entries", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link, events } = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    await link.submit(BOT, react("m1"));
    await flush();
    const first = server.entries(BOT);
    server.push = () => {};
    await link.submit(BOT, react("m2"));
    await flush();
    const all = server.entries(BOT);
    const before = events.filter((e) => e.type === "entries").length;
    server.send(server.batchOf(BOT, first, "0".repeat(64))); // already applied
    server.send(server.batchOf(BOT, all, "0".repeat(64)));   // overlaps: only the new one applies
    await flush();
    const got = events.filter((e) => e.type === "entries").slice(before) as Array<Extract<FeLinkEvent, { type: "entries" }>>;
    expect(got.map((e) => e.entries.map((x) => x.seq))).toEqual([[all.length]]);
    expect(link.cursor(BOT)!.seq).toBe(all.length);
  });
});

describe("connection states (§13.3)", () => {
  it("the reducer follows the table", () => {
    const steps: Array<[ConnEvent, ConnectionState]> = [
      [{ type: "offline" }, "offline"],
      [{ type: "welcome", catching: true }, "catching up"],
      [{ type: "catching", catching: false }, "live"],
      [{ type: "reset" }, "history restored"],
      [{ type: "catching", catching: true }, "history restored"],
      [{ type: "catching", catching: false }, "history restored"],
      [{ type: "restore seen" }, "live"],
      [{ type: "lost" }, "connecting"],
      [{ type: "reset" }, "connecting"],
      [{ type: "offline" }, "offline"],
      [{ type: "welcome", catching: false }, "live"],
      [{ type: "update required", minFeVersion: "3.1.0" }, "update required"],
      [{ type: "welcome", catching: false }, "update required"],
      [{ type: "lost" }, "update required"],
    ];
    let model = initialConn(0);
    expect(model.state).toBe("connecting");
    steps.forEach(([event, state], i) => {
      model = connReduce(model, event, i + 1);
      expect([i, model.state]).toEqual([i, state]);
    });
    expect(model.asOf).toBe(8); // the last attached moment, for "offline · as of <time>"
    expect(writesSent("live") && writesSent("catching up") && writesSent("history restored")).toBe(true);
    expect(writesSent("connecting") || writesSent("offline") || writesSent("update required")).toBe(false);
  });

  it("the link goes connecting → catching up → live → history restored → live → connecting → offline → live", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link, states } = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    expect(states).toEqual(["connecting", "catching up", "live"]);
    server.restore();
    await flush();
    expect(link.state).toBe("history restored");
    expect(link.status.restoredAt).toBe(clock.now());
    link.dismissRestored();
    expect(link.state).toBe("live");
    server.refuse = true;
    server.kill();
    await flush();
    expect(link.state).toBe("connecting");
    // Writes made now wait in the outbox.
    await link.submit(BOT, react("m1"));
    expect(link.pending()[0].state).toBe("waiting");
    clock.advance(10_000);
    await flush();
    expect(link.state).toBe("offline");
    server.refuse = false;
    clock.advance(5_000);
    await flush();
    expect(link.state).toBe("live");
    expect(appliedNs(server)).toEqual([1]);
    expect(states.slice(3)).toEqual(["history restored", "live", "connecting", "offline", "live"]);
  });

  it("update required: a server asking a newer front end stops the link and keeps the outbox", async () => {
    const server = new FakeServer();
    server.minFeVersion = "3.2.0";
    const clock = new FakeClock();
    const storage = new MemoryFeStorage();
    const { link } = await openLink(server, storage, clock);
    await link.submit(BOT, react("m1"));
    await flush();
    expect(link.state).toBe("update required");
    expect(link.status.minFeVersion).toBe("3.2.0");
    expect(server.copies).toEqual([]);
    clock.advance(60_000);
    await flush();
    expect(link.state).toBe("update required");
    expect(storage.snapshot().items).toHaveLength(1);
  });

  it("no frame for 45 s ends the session; a ping goes out after 15 s of sending nothing", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link } = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    clock.advance(15_000);
    await flush();
    expect(server.received.some((m) => m.t === "ping")).toBe(true);
    clock.advance(30_000);
    await flush();
    expect(link.state).toBe("connecting");
  });
});

describe("live buffer (§9.4)", () => {
  it("applies live frames through LiveReceiver, asks live.resync on a mismatch, and marks the text stale offline", async () => {
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link } = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    server.send({ t: "live", stream: BOT, turnId: "t1", seg: 0, rev: 1, at: 0, text: "Hel" });
    server.send({ t: "live", stream: BOT, turnId: "t1", seg: 0, rev: 2, at: 3, text: "lo" });
    await flush();
    expect(link.live(BOT)).toEqual({ view: { turnId: "t1", seg: 0, rev: 2, text: "Hello" }, stale: false });
    server.send({ t: "live", stream: BOT, turnId: "t1", seg: 0, rev: 5, at: 5, text: "!" });
    await flush();
    expect(server.received.filter((m) => m.t === "live.resync")).toEqual([{ t: "live.resync", stream: BOT }]);
    server.kill();
    await flush();
    expect(link.live(BOT)?.stale).toBe(true);
  });
});

/** The outcome events the link emitted for a slot (exactly one is expected). */
function outcomesOf(events: FeLinkEvent[], slot: Parameters<typeof slotKey>[0]) {
  return events.filter((e): e is Extract<FeLinkEvent, { type: "outcome" }> => e.type === "outcome" && slotKey(e.item.slot) === slotKey(slot)).map((e) => e.item.outcome);
}

describe("a req answer too large for one frame (M1 demo bug 1: plugins.web)", () => {
  it("is joined from its res.parts into the request's result; parts out of order fail the request instead of hanging it", async () => {
    const { encodeResFrames } = await import("../../src/protocol");
    const server = new FakeServer();
    const clock = new FakeClock();
    const { link } = await openLink(server, new MemoryFeStorage(), clock);
    await flush();
    const result = { specs: [{ name: "botling.note", source: "x".repeat(700_000) }, { name: "ccb-latex", source: "é\"".repeat(150_000) }] };
    let reorder = false;
    server.onMessage = (message) => {
      if (message.t !== "req") return;
      const frames = encodeResFrames({ t: "res", req: message.req, ok: true, result }, "server", { local: true });
      if (!frames.ok) throw new Error(frames.detail);
      const parts = frames.texts.map((text) => JSON.parse(text));
      if (reorder) parts.reverse();
      for (const part of parts) server.send(part);
    };
    const answer = link.request({ type: "plugins.web" });
    await flush();
    await expect(answer).resolves.toEqual(result);
    reorder = true;
    const broken = link.request({ type: "plugins.web" }).then(() => null, (error: Error) => error);
    await flush();
    expect((await broken)?.message).toMatch(/out of order/);
  });
});
