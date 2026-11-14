// Botling 3 live channel (src/server/live, protocol v1 §9, D10): scripted engine deltas through LiveChannel with a fake
// clock (nothing sleeps). Covers the frame-rate bound (≤ 10 frames/s per turn and subscriber, text never more than
// 100 ms late), segments per step, `live.resync` on a mismatch, a reader that reattaches mid-turn (log catch-up, then
// one whole-segment frame, then appends), the 5 s checkpoint and what a crash leaves of it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Event as ContractEvent } from "../../src/contract";
import { MESSAGES, type Message, type StreamId } from "../../src/protocol";
import { FRAME_LIMIT } from "../../src/protocol/frame";
import { ensureStream, LogHub, readSnap, readStream } from "../../src/server/log";
import {
  ContractLiveFeed, LiveChannel, LiveReceiver, listCheckpoints, readCheckpoint, splitUnits, storeCheckpointSink,
  type CheckpointSink, type Clock, type LiveCheckpoint, type LiveFrame, type TimerHandle,
} from "../../src/server/live";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { quickStore, type QuickStore } from "./server-log-helpers";

class FakeClock implements Clock {
  private t = 1_000_000;
  private seq = 0;
  private timers: Array<{ at: number; seq: number; run: () => void; handle: object }> = [];
  now(): number { return this.t; }
  setTimeout(run: () => void, ms: number): TimerHandle {
    const handle = {};
    this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, run, handle });
    return handle;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((timer) => timer.handle !== handle);
  }
  get pending(): number { return this.timers.length; }
  /** Runs every timer due within `ms`, in time order, moving the clock to each. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: (typeof this.timers)[number] | undefined;
      for (const timer of this.timers) if (timer.at <= end && (!next || timer.at < next.at || (timer.at === next.at && timer.seq < next.seq))) next = timer;
      if (!next) break;
      this.timers.splice(this.timers.indexOf(next), 1);
      this.t = next.at;
      next.run();
    }
    this.t = end;
  }
}

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A front end's live side: applies frames by receiver.ts, records them with their time, resyncs when told. */
class Client {
  readonly receiver = new LiveReceiver();
  readonly frames: Array<{ at: number; frame: LiveFrame }> = [];
  readonly results: string[] = [];
  resync: (() => void) | null = null;
  constructor(private readonly clock: FakeClock, private readonly drop: (frame: LiveFrame, index: number) => boolean = () => false) {}
  send = (frame: LiveFrame): void => {
    MESSAGES.live.parse(frame); // every frame is a valid protocol message
    expect(new TextEncoder().encode(JSON.stringify(frame)).length).toBeLessThanOrEqual(FRAME_LIMIT);
    const index = this.frames.length;
    this.frames.push({ at: this.clock.now(), frame });
    if (this.drop(frame, index)) return; // lost on the way
    const result = this.receiver.apply(frame);
    this.results.push(result);
    if (result === "resync") this.resync?.();
  };
  text(stream: StreamId): string { return this.receiver.view(stream)?.text ?? ""; }
  /** Frames sent to this client for one stream, by time. */
  times(stream: StreamId): number[] { return this.frames.filter((entry) => entry.frame.stream === stream).map((entry) => entry.at); }
}

const A = "bot:alpha" as StreamId;
const B = "bot:beta" as StreamId;

function expectRateBound(times: number[], interval = 100) {
  for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(interval);
  for (let i = 0; i < times.length; i++) {
    const inWindow = times.filter((time) => time >= times[i] && time < times[i] + 1000).length;
    expect(inWindow).toBeLessThanOrEqual(10);
  }
}

describe("frame rate", () => {
  it("coalesces a fast stream to ≤ 10 frames/s per turn and subscriber, never more than 100 ms late", () => {
    const clock = new FakeClock();
    const live = new LiveChannel({ clock });
    const rnd = random(7);
    const clients = [new Client(clock), new Client(clock)];
    live.start("alpha", "t1");
    live.start("beta", "t2");
    const subs = clients.map((client) => [live.subscribe(A, client.send), live.subscribe(B, client.send)]);
    expect(subs.length).toBe(2);
    // Engine pieces every 1–15 ms for 6 s on two bots at once (≈ 130 pieces/s per turn, far above real engines).
    const full = { alpha: "", beta: "" };
    const sentAt: Array<{ stream: StreamId; at: number; length: number }> = [];
    const started = clock.now();
    while (clock.now() - started < 6_000) {
      clock.advance(1 + Math.floor(rnd() * 15));
      for (const [botId, stream] of [["alpha", A], ["beta", B]] as const) {
        if (rnd() < 0.7) continue;
        const piece = `w${Math.floor(rnd() * 1000)} `;
        full[botId] += piece;
        live.delta(botId, botId === "alpha" ? "t1" : "t2", piece);
        sentAt.push({ stream, at: clock.now(), length: full[botId].length });
      }
    }
    clock.advance(100);
    for (const client of clients) {
      expect(client.text(A)).toBe(full.alpha);
      expect(client.text(B)).toBe(full.beta);
      expect(client.results.every((result) => result === "applied")).toBe(true);
      for (const stream of [A, B]) {
        const times = client.times(stream);
        expectRateBound(times);
        expect(times.length).toBeGreaterThanOrEqual(55); // smooth: close to 10/s, not fewer
        expect(times.length).toBeLessThanOrEqual(61);
      }
      // Latency: every piece reaches the client within one frame interval.
      for (const piece of sentAt) {
        let length = 0;
        const reached = client.frames.find(({ frame }) => {
          if (frame.stream !== piece.stream) return false;
          length = frame.at + frame.text.length;
          return length >= piece.length;
        });
        expect(reached).toBeDefined();
        expect(reached!.at - piece.at).toBeLessThanOrEqual(100);
      }
    }
  });

  it("sends slow text at once (no added delay when the engine is slower than 10/s)", () => {
    const clock = new FakeClock();
    const live = new LiveChannel({ clock });
    const client = new Client(clock);
    live.start("alpha", "t1");
    live.subscribe(A, client.send);
    for (let i = 0; i < 10; i++) {
      clock.advance(250);
      const before = client.frames.length;
      live.delta("alpha", "t1", `p${i} `);
      expect(client.frames.length).toBe(before + 1);
      expect(client.frames.at(-1)!.at).toBe(clock.now());
    }
    expect(client.text(A)).toBe(Array.from({ length: 10 }, (_, i) => `p${i} `).join(""));
  });

  it("ignores deltas of a turn that is not running, and sends nothing after the turn ended", () => {
    const clock = new FakeClock();
    const live = new LiveChannel({ clock });
    const client = new Client(clock);
    live.subscribe(A, client.send);
    expect(live.delta("alpha", "t1", "x")).toBe(false);
    live.start("alpha", "t1");
    live.delta("alpha", "t1", "a");
    live.delta("alpha", "t1", "b"); // pending, inside the interval
    live.end("alpha", "t1");
    expect(live.delta("alpha", "t1", "c")).toBe(false);
    clock.advance(1_000);
    expect(client.frames.map(({ frame }) => frame.text)).toEqual(["a"]); // "b" was pending when the turn ended
    expect(clock.pending).toBe(0);
  });
});

describe("segments", () => {
  it("numbers segments per step; a new segment starts with a whole-segment frame and an empty one sends nothing", () => {
    const clock = new FakeClock();
    const live = new LiveChannel({ clock });
    const client = new Client(clock);
    live.start("alpha", "t1");
    live.subscribe(A, client.send); // first frame: the empty segment 0
    live.delta("alpha", "t1", "Let me look.");
    clock.advance(200);
    live.step("alpha", "t1"); // a tool call starts
    clock.advance(500);
    const quiet = client.frames.length;
    live.step("alpha", "t1"); // and another, still no text
    clock.advance(500);
    expect(client.frames.length).toBe(quiet);
    live.delta("alpha", "t1", "Found it");
    live.delta("alpha", "t1", ": here.");
    clock.advance(200);
    const frames = client.frames.map(({ frame }) => frame);
    expect(frames.map((frame) => [frame.seg, frame.at, frame.text])).toEqual([
      [0, 0, ""], [0, 0, "Let me look."], [2, 0, "Found it"], [2, 8, ": here."],
    ]);
    expect(frames.map((frame) => frame.rev)).toEqual([1, 2, 3, 4]);
    expect(client.receiver.view(A)).toMatchObject({ turnId: "t1", seg: 2, text: "Found it: here." });
    expect(live.running("alpha")).toMatchObject({ seg: 2, text: "Found it: here.", turnText: "Let me look.Found it: here." });
  });

  it("a rewrite of the segment sends only the changed tail (at = the common prefix)", () => {
    const clock = new FakeClock();
    const live = new LiveChannel({ clock });
    const client = new Client(clock);
    live.start("alpha", "t1");
    live.subscribe(A, client.send);
    live.delta("alpha", "t1", "Hello <tag");
    clock.advance(100);
    live.replace("alpha", "t1", "Hello world");
    clock.advance(100);
    expect(client.frames.at(-1)!.frame).toMatchObject({ at: 6, text: "world" });
    expect(client.text(A)).toBe("Hello world");
    live.replaceTurnText("alpha", "t1", "Hello world, again");
    clock.advance(100);
    expect(client.text(A)).toBe("Hello world, again");
  });

  it("splits a segment too big for one frame without cutting a surrogate pair", () => {
    expect(splitUnits("ab😀cd", 3)).toEqual(["ab", "😀c", "d"]);
    const clock = new FakeClock();
    const big = "表".repeat(70_000) + "😀".repeat(10_000) + "end"; // > one frame's worth of UTF-8
    const live = new LiveChannel({ clock });
    const client = new Client(clock);
    live.start("alpha", "t1");
    live.delta("alpha", "t1", big);
    live.subscribe(A, client.send); // frames are each checked against FRAME_LIMIT
    expect(client.frames.length).toBeGreaterThan(1);
    expect(client.frames[0].frame.at).toBe(0);
    expect(client.text(A)).toBe(big);
    expect(client.results.every((result) => result === "applied")).toBe(true);
  });
});

describe("live.resync", () => {
  it("a lost frame is noticed by rev, and the resync brings one whole-segment frame", () => {
    const clock = new FakeClock();
    const live = new LiveChannel({ clock });
    const client = new Client(clock, (_frame, index) => index === 3);
    live.start("alpha", "t1");
    const sub = live.subscribe(A, client.send);
    client.resync = () => sub.resync();
    let full = "";
    for (let i = 0; i < 12; i++) {
      full += `piece${i} `;
      live.delta("alpha", "t1", `piece${i} `);
      clock.advance(100);
    }
    clock.advance(100);
    expect(client.results).toContain("resync");
    const resyncIndex = client.results.indexOf("resync");
    const whole = client.frames.slice(resyncIndex + 2).find(({ frame }) => frame.at === 0);
    expect(whole).toBeDefined();
    expect(client.frames.filter(({ frame }) => frame.at === 0 && frame.text.length > 0)).toHaveLength(2); // the first text, then the resync
    expect(client.text(A)).toBe(full);
    expectRateBound(client.times(A)); // the resync answer keeps the spacing too
  });

  it("a frame of another segment or turn, or past the receiver's length, is a mismatch", () => {
    const receiver = new LiveReceiver();
    const frame = (fields: Partial<LiveFrame>): LiveFrame => ({ t: "live", stream: A, turnId: "t1", seg: 0, rev: 1, at: 0, text: "", ...fields });
    expect(receiver.apply(frame({ text: "abc" }))).toBe("applied");
    expect(receiver.apply(frame({ rev: 2, at: 3, text: "d" }))).toBe("applied");
    expect(receiver.apply(frame({ rev: 3, seg: 1, at: 4, text: "e" }))).toBe("resync");
    expect(receiver.apply(frame({ rev: 3, at: 4, text: "e" }))).toBe("waiting"); // dropped until a whole segment
    expect(receiver.apply(frame({ rev: 9, seg: 1, at: 0, text: "new" }))).toBe("applied");
    expect(receiver.apply(frame({ rev: 10, seg: 1, at: 5, text: "x" }))).toBe("resync"); // past its length
    expect(receiver.apply(frame({ rev: 11, seg: 1, turnId: "t2", at: 0, text: "other" }))).toBe("applied");
    expect(receiver.apply(frame({ rev: 12, seg: 1, turnId: "t1", at: 5, text: "!" }))).toBe("resync"); // another turn
    expect(receiver.view(A)).toMatchObject({ turnId: "t2", text: "other" });
  });

  it("a resync while the receiver is behind on a duplicate or reordered frame recovers the same way", () => {
    const clock = new FakeClock();
    const live = new LiveChannel({ clock });
    let held: LiveFrame | null = null;
    const client = new Client(clock);
    // Delivers frame 3 after frame 4 (out of order).
    const sub = live.subscribe(A, (frame) => {
      if (frame.rev === 3) { held = frame; return; }
      client.send(frame);
      if (held && frame.rev === 4) { client.send(held); held = null; }
    });
    client.resync = () => sub.resync();
    live.start("alpha", "t1");
    for (let i = 0; i < 8; i++) { live.delta("alpha", "t1", `${i},`); clock.advance(100); }
    clock.advance(200);
    expect(client.results).toContain("resync");
    expect(client.text(A)).toBe("0,1,2,3,4,5,6,7,");
  });
});

describe("reattach mid-turn", () => {
  const stores: QuickStore[] = [];
  afterEach(async () => { for (const store of stores.splice(0)) await store.close(); });

  const step = (id: string) => ({ id, kind: "tool", tool: "Read", title: `step ${id}`, detail: null, output: null, failed: false, done: false });

  it("a reader that reconnects gets the log catch-up, then one whole-segment frame, then appends", async () => {
    const store = quickStore();
    stores.push(store);
    const hub = new LogHub(store);
    const clock = new FakeClock();
    const live = new LiveChannel({ clock });
    await store.submit((db) => { ensureStream(db, A); });
    await hub.append(A, [{ kind: "message.added", body: { botId: "alpha", message: { id: "m1", role: "user", text: "hi", time: "2026-11-14T00:00:00.000Z" } } }]);

    // The window's first connection follows the turn from its start.
    const first: Message[] = [];
    const firstReader = hub.attach((message) => first.push(message));
    await firstReader.sub(A, null);
    await hub.append(A, [{ kind: "turn.started", body: { botId: "alpha", turnId: "t1", messageId: "m2" } }]);
    live.start("alpha", "t1");
    const firstLive = live.subscribe(A, (frame) => first.push(frame));
    live.delta("alpha", "t1", "Reading the file. ");
    clock.advance(100);
    await hub.append(A, [{ kind: "turn.steps", body: { botId: "alpha", turnId: "t1", messageId: "m2", steps: [step("s1")] } }]);
    live.step("alpha", "t1");
    live.delta("alpha", "t1", "The file says");
    clock.advance(100);
    const cursor = firstReader.subscription(A)!;
    expect(cursor.sent).toBe(3);

    // The window closes; the turn goes on.
    firstLive.close();
    firstReader.close();
    const cursorAtClose = { logId: cursor.logId, seq: 1 }; // its durable cursor lagged: acked only the first line
    live.delta("alpha", "t1", " that");
    clock.advance(30);
    live.delta("alpha", "t1", " the build");
    clock.advance(500);

    // It reconnects: log catch-up from its cursor, then live once at the head.
    const second: Message[] = [];
    const client = new Client(clock);
    const reader = hub.attach((message) => second.push(message));
    await reader.sub(A, cursorAtClose);
    expect(reader.subscription(A)!.sent).toBe(readStream(store.db, A)!.head); // at the head: may get live now
    const sub = live.subscribe(A, (frame) => { second.push(frame); client.send(frame); });
    client.resync = () => sub.resync();
    live.delta("alpha", "t1", " passes.");
    clock.advance(100);

    expect(second.map((message) => message.t)).toEqual(["batch", "live", "live"]);
    const batch = second[0] as Message & { t: "batch" };
    expect(batch.entries.map((entry) => entry.kind)).toEqual(["turn.started", "turn.steps"]);
    expect(second[1]).toMatchObject({ t: "live", turnId: "t1", seg: 1, at: 0, text: "The file says that the build" });
    expect(second[2]).toMatchObject({ t: "live", seg: 1, at: 28, text: " passes." });
    expect(second.filter((message) => message.t === "live" && message.at === 0)).toHaveLength(1);
    expect(client.text(A)).toBe("The file says that the build passes.");
    hub.close();
  });

  it("a reader that comes back after the turn ended gets no live frame", () => {
    const clock = new FakeClock();
    const live = new LiveChannel({ clock });
    live.start("alpha", "t1");
    live.delta("alpha", "t1", "done");
    live.end("alpha", "t1");
    const client = new Client(clock);
    live.subscribe(A, client.send);
    clock.advance(1_000);
    expect(client.frames).toHaveLength(0);
  });
});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("checkpoint", () => {
  function fakeSink() {
    const writes: LiveCheckpoint[] = [];
    const clears: Array<[string, string]> = [];
    const gates: Array<() => void> = [];
    let hold = false;
    const sink: CheckpointSink = {
      write: (checkpoint) => {
        writes.push({ ...checkpoint });
        return hold ? new Promise((resolve) => gates.push(resolve)) : Promise.resolve();
      },
      clear: async (botId, turnId) => { clears.push([botId, turnId]); },
    };
    return { sink, writes, clears, gates, setHold: (value: boolean) => { hold = value; } };
  }

  it("writes the whole turn text at start, its first text 1 s after it came, then every 5 s when it changed; a stalled writer makes ticks wait", async () => {
    const clock = new FakeClock();
    const { sink, writes, clears, gates, setHold } = fakeSink();
    const live = new LiveChannel({ clock, sink });
    live.start("alpha", "t1");
    expect(writes).toEqual([{ botId: "alpha", turnId: "t1", text: "", at: clock.now() }]);
    live.delta("alpha", "t1", "one ");
    clock.advance(999);
    expect(writes).toHaveLength(1);
    clock.advance(1); // M1 demo bug 5b: the first text does not wait for the 5 s tick
    expect(writes.at(-1)).toMatchObject({ text: "one ", at: clock.now() });
    clock.advance(4_000); // the 5 s tick: unchanged since, no write
    expect(writes).toHaveLength(2);
    clock.advance(5_000); // unchanged: no write
    expect(writes).toHaveLength(2);
    await flush();
    live.step("alpha", "t1");
    live.delta("alpha", "t1", "two");
    setHold(true);
    clock.advance(5_000);
    live.delta("alpha", "t1", " three");
    clock.advance(5_000);
    expect(writes.map((write) => write.text).slice(2)).toEqual(["one two", "one two three"]);
    live.delta("alpha", "t1", " four");
    clock.advance(5_000); // two writes in flight: this tick waits
    expect(writes).toHaveLength(4);
    setHold(false);
    gates.shift()!();
    await flush();
    expect(writes.at(-1)!.text).toBe("one two three four");
    live.end("alpha", "t1");
    await flush();
    expect(clears).toEqual([["alpha", "t1"]]);
    gates.shift()!();
    await flush();
    clock.advance(20_000);
    expect(writes).toHaveLength(5);
    expect(clock.pending).toBe(0);
  });

  it("the first text is checkpointed at the first step boundary when that comes sooner, and only once early", async () => {
    const clock = new FakeClock();
    const { sink, writes } = fakeSink();
    const live = new LiveChannel({ clock, sink });
    live.start("alpha", "t1");
    live.delta("alpha", "t1", "Let me look.");
    clock.advance(300);
    live.step("alpha", "t1"); // a tool call: the words so far are a finished segment
    expect(writes.map((write) => [write.text, write.at - writes[0].at])).toEqual([["", 0], ["Let me look.", 300]]);
    await flush(); // both writes settle (at most two are in flight)
    clock.advance(700); // the 1 s timer is gone: nothing more early
    live.delta("alpha", "t1", " Found it.");
    clock.advance(1_000);
    expect(writes).toHaveLength(2);
    clock.advance(3_000); // the 5 s tick from the start takes the rest
    expect(writes.at(-1)).toMatchObject({ text: "Let me look. Found it." });
    expect(writes).toHaveLength(3);
    // An empty step boundary (no words yet) writes nothing early; a turn that ends before 1 s writes no first text.
    live.start("alpha", "t2");
    live.step("alpha", "t2");
    live.delta("alpha", "t2", "x");
    clock.advance(500);
    live.end("alpha", "t2");
    clock.advance(10_000);
    expect(writes.filter((write) => write.turnId === "t2").map((write) => write.text)).toEqual([""]);
    expect(clock.pending).toBe(0);
  });

  it("after a simulated crash the interrupted turn shows the checkpoint text, at most ~5 s missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "botling-live-"));
    try {
      let store: ServerStore = await openServerStore(dir);
      await store.submit((db) => { ensureStream(db, A); });
      const clock = new FakeClock();
      const live = new LiveChannel({ clock, sink: storeCheckpointSink(store) });
      live.start("alpha", "t1");
      const rnd = random(11);
      let full = "";
      const history: Array<{ at: number; length: number }> = [];
      const started = clock.now();
      // 23.4 s of engine text, a step boundary now and then; writes go through the real writer.
      while (clock.now() - started < 23_400) {
        clock.advance(20 + Math.floor(rnd() * 60));
        const piece = `tok${Math.floor(rnd() * 100)} `;
        full += piece;
        live.delta("alpha", "t1", piece);
        history.push({ at: clock.now(), length: full.length });
        if (rnd() < 0.01) live.step("alpha", "t1");
        await store.writer.idle();
      }
      const crashAt = clock.now();
      // Crash: nothing ends the turn or clears its checkpoint; only what committed survives.
      live.close();
      await store.close();

      store = await openServerStore(dir);
      const reader = store.openReader();
      try {
        const [checkpoint] = listCheckpoints(reader);
        expect(checkpoint).toMatchObject({ botId: "alpha", turnId: "t1" });
        expect(full.startsWith(checkpoint.text)).toBe(true);
        expect(checkpoint.text.length).toBeGreaterThan(0);
        expect(crashAt - checkpoint.at).toBeLessThanOrEqual(5_000);
        // Missing text is at most what the engine wrote in the last 5 s.
        const fiveSecondsBefore = history.filter((point) => point.at <= crashAt - 5_000).at(-1)!.length;
        expect(checkpoint.text.length).toBeGreaterThanOrEqual(fiveSecondsBefore);
        // What a front end sees in the bot's snap: the interrupted turn with the checkpoint text.
        const snap = readSnap(reader, A)!;
        expect(snap.frame.view).toMatchObject({ bot: { live: { turnId: "t1", text: checkpoint.text } } });
        expect(readCheckpoint(reader, "alpha")).toEqual(checkpoint);
      } finally {
        reader.close();
        await store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the end of a turn clears its checkpoint, never a newer turn's", async () => {
    const store = quickStore();
    try {
      const clock = new FakeClock();
      const live = new LiveChannel({ clock, sink: storeCheckpointSink(store) });
      live.start("alpha", "t1");
      live.delta("alpha", "t1", "first");
      clock.advance(5_000);
      live.start("alpha", "t2"); // t1 ends (its clear is queued), t2's start checkpoint follows in order
      live.delta("alpha", "t2", "second");
      live.start("beta", "t3");
      await store.writer.idle();
      expect(readCheckpoint(store.db, "alpha")).toMatchObject({ turnId: "t2", text: "" });
      clock.advance(5_000);
      await store.writer.idle();
      expect(readCheckpoint(store.db, "alpha")).toMatchObject({ turnId: "t2", text: "second" });
      live.end("alpha", "t1"); // not running: nothing happens
      live.end("alpha", "t2");
      await store.writer.idle();
      expect(readCheckpoint(store.db, "alpha")).toBeNull();
      expect(listCheckpoints(store.db).map((checkpoint) => checkpoint.turnId)).toEqual(["t3"]);
      live.close();
    } finally {
      await store.close();
    }
  });
});

describe("contract feed", () => {
  it("maps the core's turn events to the live channel; turn.delta is only live", () => {
    const clock = new FakeClock();
    const live = new LiveChannel({ clock });
    const feed = new ContractLiveFeed(live);
    const client = new Client(clock);
    live.subscribe(A, client.send);
    const steps = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `s${i}`, kind: "tool" as const, tool: "Bash", title: "run", detail: null, output: null, failed: false, done: false }));
    const events: ContractEvent[] = [
      { type: "turn.started", botId: "alpha", turnId: "t1", messageId: "m1" },
      { type: "turn.delta", botId: "alpha", turnId: "t1", messageId: "m1", text: "Checking" },
      { type: "turn.steps", botId: "alpha", turnId: "t1", messageId: "m1", steps: steps(1) },
      { type: "turn.steps", botId: "alpha", turnId: "t1", messageId: "m1", steps: steps(1) }, // an update, not a new step
      { type: "turn.delta", botId: "alpha", turnId: "t1", messageId: "m1", text: " Done <b" },
      { type: "message.updated", botId: "alpha", message: { id: "m1", role: "bot", text: "Checking Done.", time: "2026-11-14T00:00:00.000Z" } },
    ] as ContractEvent[];
    const liveOnly = events.map((event) => { const only = feed.feed(event); clock.advance(100); return only; });
    expect(liveOnly).toEqual([false, true, false, false, true, false]);
    expect(live.running("alpha")).toMatchObject({ seg: 1, text: " Done.", turnText: "Checking Done." });
    expect(client.text(A)).toBe(" Done.");
    feed.feed({ type: "turn.finished", botId: "alpha", turnId: "t1", messageId: "m1", status: "done" } as unknown as ContractEvent);
    expect(live.running("alpha")).toBeNull();
  });
});
