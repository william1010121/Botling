// Live text across servers (M3, after step 8's deviation 5): a running turn's `live` frames on server B reach a front end
// attached to server A through pass-through, in one process with a fake clock.
//
// B runs a real store + LogHub, a real LiveChannel (fake clock) and the real PassThroughOwner; A runs the real PassThrough
// and PeerLogCache; they are joined by an in-memory FIFO link through the real wire encoder (peer role) whose queued
// bytes a test can raise (back-pressure). The front end on A is what session-core gives it: a real LiveGate (≤ 10
// frames/s on the connection) in front of a LiveReceiver (the receiving rules), whose `resync` goes back to the gate.
//
// Checked: frames on the peer hop carry the leg's `via`, frames to the front end none; the front end sees ≥ 5 frames
// before the commit, never two within 100 ms, and the gate never has to drop one (A paces from its own copy, so jitter
// on the peer hop costs nothing); every text it shows is a prefix of the reply B commits; under back-pressure B drops
// live frames, never entries, and resends the whole segment once the queue drained; after a cut mid-turn and a new
// session the front end gets what changed meanwhile; a front end's resync is answered by A from memory, a frame A
// cannot place makes A ask B; the turn's end drops A's copy; a keeper asks for no live frames.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Message, StreamId, WireMessage } from "../../src/protocol";
import { decodeWireFrame, encodeFrame, encodeWireFrame } from "../../src/protocol/frame";
import { LiveChannel, LiveReceiver, type Clock, type LiveFrame, type TimerHandle } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { appendEntries, ensureStream } from "../../src/server/log/log-store";
import { PassThrough, PassThroughOwner, PeerLogCache, type PassThroughLeg, type PassThroughSession } from "../../src/server/replica";
import { LiveGate } from "../../src/server/session/live-gate";
import { openServerStore, type Db, type ServerStore } from "../../src/server/store";
import { message } from "./server-log-helpers";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBB";
const BOT = "b1";
const STREAM = `bot:${BOT}` as StreamId;
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const run of cleanups.splice(0).reverse()) await run().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (tag: string) => { const dir = mkdtempSync(join(tmpdir(), `pt-live-${tag}-`)); dirs.push(dir); return dir; };

/** One fake clock for both servers (the live channel's, the gate's and the owner's retry timers). */
class FakeClock implements Clock {
  t = 1_000_000;
  private timers: Array<{ at: number; seq: number; run: () => void; done: boolean }> = [];
  private seq = 0;
  now(): number { return this.t; }
  setTimeout(run: () => void, ms: number): TimerHandle { const timer = { at: this.t + Math.max(0, ms), seq: this.seq++, run, done: false }; this.timers.push(timer); return timer; }
  clearTimeout(handle: TimerHandle): void { (handle as { done: boolean }).done = true; }
  schedule = (run: () => void, ms: number) => { const handle = this.setTimeout(run, ms); return () => this.clearTimeout(handle); };
  /** Runs the timers due up to now + ms, in time order, the clock set to each one's time. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers = this.timers.filter((timer) => !timer.done);
      const next = this.timers.filter((timer) => timer.at <= end).sort((x, y) => x.at - y.at || x.seq - y.seq)[0];
      if (!next) break;
      this.t = Math.max(this.t, next.at);
      next.done = true;
      next.run();
    }
    this.t = end;
  }
}

class Side implements PassThroughSession {
  state = "open";
  constructor(private readonly link: Link, readonly peer: string) {}
  get queuedBytes(): number { return this.link.queued; }
  sendWire(frame: WireMessage): boolean { return this.state === "open" && this.link.enqueue(this, frame); }
}

class Link {
  readonly atA: Side;
  readonly atB: Side;
  private queue: Array<{ toA: boolean; text: string }> = [];
  open = true;
  /** Back-pressure a test sets: bytes the owner sees queued toward A. */
  queued = 0;
  /** Frames B sent toward A, decoded. */
  readonly fromB: WireMessage[] = [];
  /** Frames A sent toward B, decoded. */
  readonly fromA: WireMessage[] = [];
  /** A test can lose B's next live frames toward A (a frame A then cannot place). */
  loseLive = 0;
  constructor(readonly world: World) { this.atA = new Side(this, B); this.atB = new Side(this, A); }

  enqueue(from: Side, frame: WireMessage): boolean {
    if (!this.open) return false;
    const encoded = encodeWireFrame(frame, "peer", { local: false });
    if (!encoded.ok) throw new Error(`cannot encode ${frame.t}: ${encoded.detail}`);
    const toA = from === this.atB;
    (toA ? this.fromB : this.fromA).push(JSON.parse(encoded.text) as WireMessage);
    this.queue.push({ toA, text: encoded.text });
    return true;
  }

  async settle(): Promise<void> {
    for (let round = 0; round < 100; round++) {
      await this.world.cache.idle();
      await new Promise((resolve) => setImmediate(resolve));
      if (!this.queue.length) return;
      while (this.open && this.queue.length) {
        const { toA, text } = this.queue.shift()!;
        if (toA && this.loseLive > 0 && text.includes('"t":"live"')) { this.loseLive--; continue; }
        const decoded = decodeWireFrame(new TextEncoder().encode(text), "peer", { local: false });
        if (!decoded.ok) throw new Error(`cannot decode: ${decoded.detail}`);
        if (toA) { if (!this.world.pass.onMessage(this.atA, decoded.message)) throw new Error(`A did not take ${decoded.message.t}`); }
        else if (!(await this.world.owner.onMessage(this.atB, decoded.message))) throw new Error(`B did not take ${decoded.message.t}`);
      }
    }
  }
}

/** The front end on A as session-core serves it: leg frames straight, live frames through the connection's gate. */
class FrontEnd {
  readonly receiver = new LiveReceiver();
  readonly live: Array<{ at: number; frame: LiveFrame }> = [];
  readonly entries: Message[] = [];
  readonly violations: string[] = [];
  readonly shown: string[] = [];
  resyncs = 0;
  gate: LiveGate;
  leg: PassThroughLeg | null = null;
  /** A test can make the front end lose the next live frame (as if it never arrived). */
  loseNext = false;
  constructor(readonly world: World) {
    this.gate = new LiveGate((frame) => this.takeLive(frame), { clock: world.clock as never });
  }

  open(): void {
    let leg: PassThroughLeg | null = null;
    const send = this.gate.add(STREAM, () => leg?.liveResync());
    leg = this.world.pass.open(STREAM, this.cursor(), (frame) => { this.take(frame); return true; }, send);
    this.leg = leg;
  }

  cursor() {
    const last = [...this.entries].reverse().find((m) => m.t === "batch" || m.t === "snap") as { t: string; logId: string; to?: number; seq?: number } | undefined;
    if (!last) return null;
    return { logId: last.logId as never, seq: (last.t === "batch" ? last.to : last.seq)! };
  }

  private take(frame: Message): void {
    const encoded = encodeFrame(frame, "server", { local: true });
    if (!encoded.ok) this.violations.push(`${frame.t} not valid toward a front end: ${encoded.detail}`);
    this.entries.push(frame);
    if (frame.t === "batch") this.leg?.ack({ logId: frame.logId, seq: frame.to });
  }

  private takeLive(frame: LiveFrame): void {
    const encoded = encodeFrame(frame, "server", { local: true });
    if (!encoded.ok) this.violations.push(`live not valid toward a front end: ${encoded.detail}`);
    if ((frame as { via?: unknown }).via !== undefined) this.violations.push("live with a via");
    if (this.loseNext) { this.loseNext = false; return; }
    this.live.push({ at: this.world.clock.now(), frame });
    const result = this.receiver.apply(frame);
    if (result === "resync") { this.resyncs++; this.gate.resync(frame.stream); } // the front end's live.resync
    const view = this.receiver.view(STREAM);
    if (result === "applied" && view) this.shown.push(view.text);
  }

  committedText(): string | null {
    for (const frame of this.entries) {
      if (frame.t !== "batch") continue;
      for (const entry of frame.entries) if (entry.kind === "message.added") return (entry.body as { message: { text: string } }).message.text;
    }
    return null;
  }
}

class World {
  clock = new FakeClock();
  bStore!: ServerStore;
  hub!: LogHub;
  live!: LiveChannel;
  owner!: PassThroughOwner;
  aStore!: ServerStore;
  aReader!: Db;
  cache!: PeerLogCache;
  pass!: PassThrough;
  link: Link | null = null;
  peerState = { state: "stale", since: null as number | null };

  async open(): Promise<void> {
    this.bStore = await openServerStore(tempDir("b"));
    await this.bStore.submit((tx) => { tx.prepare("INSERT INTO meta (key, value) VALUES ('serverId', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(B); });
    await this.bStore.submit((tx) => { ensureStream(tx, STREAM, B); });
    this.hub = new LogHub(this.bStore, { pageEntries: 40, pageBytes: 64 * 1024 });
    this.live = new LiveChannel({ clock: this.clock });
    this.owner = new PassThroughOwner({ hub: this.hub, live: this.live, ensureBotStream: async () => false, schedule: this.clock.schedule });
    this.aStore = await openServerStore(tempDir("a"));
    this.aReader = this.aStore.openReader();
    this.cache = new PeerLogCache({ store: this.aStore, reader: () => this.aReader, capBytes: 8 * 1024 * 1024, priority: () => 1 });
    this.pass = new PassThrough({
      cache: this.cache, ownerOf: (stream) => (stream.startsWith("bot:") ? B : null),
      session: () => (this.link?.open ? this.link.atA : null), peerState: () => this.peerState, followed: () => false, schedule: this.clock.schedule, liveClock: this.clock,
    });
    cleanups.push(async () => {
      this.pass.close(); this.owner.close(); this.live.close(); this.hub.close();
      await this.cache.idle(); this.aReader.close();
      await this.aStore.close(); await this.bStore.close();
    });
  }

  async connect(): Promise<Link> {
    const link = new Link(this);
    this.link = link;
    this.peerState = { state: "live", since: this.clock.now() };
    this.pass.sessionOpened(link.atA);
    await link.settle();
    return link;
  }

  cut(): void {
    const link = this.link!;
    link.open = false;
    link.atA.state = "closed"; link.atB.state = "closed";
    this.owner.sessionClosed(link.atB);
    this.pass.sessionClosed(link.atA);
    this.link = null;
    this.peerState = { state: "stale", since: this.clock.now() };
    this.pass.peerStateChanged(B, "stale", this.peerState.since);
  }

  /** Lets the clock run `ms` in steps of `step`, delivering everything after each step. */
  async run(ms: number, step = 5, each?: () => void): Promise<void> {
    for (let done = 0; done < ms; done += step) {
      each?.();
      this.clock.advance(step);
      await this.link?.settle();
    }
  }

  /** The reply committed: `message.added` with the whole text and `turn.finished`, then the turn ends on B. */
  async commit(turnId: string, text: string): Promise<void> {
    await this.bStore.submit((tx) => appendEntries(tx, STREAM, [
      { kind: "message.added", body: { botId: BOT, message: message(`reply-${turnId}`, text) } },
      { kind: "turn.finished", body: { botId: BOT, turnId, messageId: `reply-${turnId}`, status: "done", text } },
    ]));
    this.hub.committed([STREAM]);
    this.live.end(BOT, turnId);
    await this.link?.settle();
  }
}

/** A reply as the fake engine streams it: one word every 15 ms. */
function words(n: number): string[] { return Array.from({ length: n }, (_, i) => `w${String(i).padStart(3, "0")} `); }

function maxPerSecond(times: number[]): number {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) { while (times[i]! - times[j]! >= 1000) j++; best = Math.max(best, i - j + 1); }
  return best;
}

async function setup(): Promise<{ world: World; fe: FrontEnd }> {
  const world = new World();
  await world.open();
  await world.connect();
  const fe = new FrontEnd(world);
  fe.open();
  await world.link!.settle();
  return { world, fe };
}

/** Streams `list` (one word per 15 ms) on B, running the clock; `at(i)` runs before word i. */
async function stream(world: World, turnId: string, list: string[], at?: (i: number) => void | Promise<void>): Promise<string> {
  let text = "";
  for (let i = 0; i < list.length; i++) {
    await at?.(i);
    world.live.delta(BOT, turnId, list[i]!);
    text += list[i]!;
    await world.run(15);
  }
  return text;
}

describe("live text across servers (pass-through of live frames)", () => {
  it("a turn on B streams to a front end on A: ≥ 5 frames before the commit, ≤ 10/s, tagged on the peer hop only", async () => {
    const { world, fe } = await setup();
    const link = world.link!;
    world.live.start(BOT, "t1");
    const started = world.clock.now();
    const text = await stream(world, "t1", words(200)); // 3 s of text
    await world.run(300);
    const beforeCommit = fe.live.length;
    await world.commit("t1", text);

    expect(fe.violations).toEqual([]);
    expect(beforeCommit).toBeGreaterThanOrEqual(5);
    const times = fe.live.map((item) => item.at);
    expect(maxPerSecond(times)).toBeLessThanOrEqual(10);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(100);
    // The first frame went out at the first word (no added latency on the path).
    expect(times[0]! - started).toBeLessThanOrEqual(20);
    // Every text shown is a prefix of the reply, the last one the whole reply; the committed entry equals it.
    for (const shown of fe.shown) expect(text.startsWith(shown)).toBe(true);
    expect(fe.shown.at(-1)).toBe(text);
    expect(fe.committedText()).toBe(text);
    // Peer hop: every live frame tagged with the leg's via (the front end's carry none: checked in takeLive).
    const tagged = link.fromB.filter((m) => m.t === "live") as Array<LiveFrame & { via?: string }>;
    expect(tagged.length).toBeGreaterThanOrEqual(5);
    expect(new Set(tagged.map((m) => m.via)).size).toBe(1);
    expect(tagged[0]!.via).toMatch(/^pt\./);
    expect(fe.resyncs).toBe(0);
    expect(fe.gate.dropped).toBe(0);
    // The turn ended: A dropped its copy, so a late resync shows nothing of it.
    const count = fe.live.length;
    fe.gate.resync(STREAM);
    await world.run(300);
    expect(fe.live.length).toBe(count);
    console.log(JSON.stringify({ test: "stream", frames: fe.live.length, maxPerSecond: maxPerSecond(times), firstFrameMs: times[0]! - started }));
  });

  it("peer back-pressure drops live frames, never entries; the whole segment comes once the queue drained", async () => {
    const { world, fe } = await setup();
    const link = world.link!;
    world.live.start(BOT, "t2");
    const list = words(200);
    let entryAt = -1;
    const text = await stream(world, "t2", list, async (i) => {
      if (i === 40) link.queued = 10 * 1024 * 1024; // B's queue toward A is full
      if (i === 60) {
        // An entry committed meanwhile (a step's text, say) still goes.
        await world.bStore.submit((tx) => appendEntries(tx, STREAM, [{ kind: "message.added", body: { botId: BOT, message: message("mid", "a line committed under back-pressure") } }]));
        world.hub.committed([STREAM]);
        entryAt = fe.entries.length;
      }
      if (i === 100) link.queued = 0;
    });
    await world.run(300);
    expect(fe.violations).toEqual([]);
    expect(world.owner.counts.liveDropped).toBeGreaterThan(0);
    // The entry arrived while live frames were dropped.
    expect(fe.entries.slice(entryAt).some((m) => m.t === "batch" && m.entries.some((e) => (e.body as { message?: { id: string } }).message?.id === "mid"))).toBe(true);
    // B sent no live frame while its queue was full; after it drained, B's next one carried the whole segment.
    const bLive = link.fromB.filter((m) => m.t === "live") as LiveFrame[];
    expect(bLive.slice(1).some((frame) => frame.at === 0)).toBe(true);
    expect(world.owner.counts.liveResent).toBeGreaterThanOrEqual(1);
    // The front end saw a pause, then only the text it had missed (A sends the difference from its copy).
    const gaps = fe.live.slice(1).map((item, index) => item.at - fe.live[index]!.at);
    expect(Math.max(...gaps)).toBeGreaterThan(500);
    expect(fe.resyncs).toBe(0); // the receiver never saw a gap: the owner held everything until the whole segment
    for (const shown of fe.shown) expect(text.startsWith(shown)).toBe(true);
    expect(fe.shown.at(-1)).toBe(text);
    await world.commit("t2", text);
    expect(fe.committedText()).toBe("a line committed under back-pressure");
    expect(fe.entries.flatMap((m) => (m.t === "batch" ? m.entries : [])).filter((e) => e.kind === "message.added").length).toBe(2);
  });

  it("a cut mid-turn and a new session: the front end gets what it missed and ends on the committed text", async () => {
    const { world, fe } = await setup();
    world.live.start(BOT, "t3");
    const list = words(200);
    let framesAtCut = 0;
    const text = await stream(world, "t3", list, async (i) => {
      if (i === 50) { framesAtCut = fe.live.length; world.cut(); }
      if (i === 120) await world.connect();
    });
    await world.run(300);
    expect(fe.violations).toEqual([]);
    const after = fe.live.slice(framesAtCut);
    expect(after.length).toBeGreaterThan(0);
    // B's new subscription began with the whole segment; A sent the front end only what it had missed.
    const lastBefore = fe.live[framesAtCut - 1]!.frame;
    expect(after[0]!.frame.at).toBe(lastBefore.at + lastBefore.text.length);
    expect(after[0]!.frame.text.length).toBeGreaterThan(100);
    expect(fe.resyncs).toBe(0);
    for (const shown of fe.shown) expect(text.startsWith(shown)).toBe(true);
    expect(fe.shown.at(-1)).toBe(text);
    await world.commit("t3", text);
    expect(fe.committedText()).toBe(text);
    // No entry twice, none lost: the reply is there once.
    const replies = fe.entries.flatMap((m) => (m.t === "batch" ? m.entries : [])).filter((e) => e.kind === "message.added");
    expect(replies.length).toBe(1);
  });

  it("a front end that lost a frame asks live.resync: A answers it from its copy, without asking B", async () => {
    const { world, fe } = await setup();
    const link = world.link!;
    world.live.start(BOT, "t4");
    const text = await stream(world, "t4", words(120), (i) => { if (i === 30) fe.loseNext = true; });
    await world.run(300);
    expect(fe.resyncs).toBe(1);
    expect(link.fromA.filter((m) => m.t === "live.resync")).toEqual([]);
    expect(fe.live.slice(1).some((item) => item.frame.at === 0)).toBe(true);
    expect(fe.shown.at(-1)).toBe(text);
    expect(fe.violations).toEqual([]);
  });

  it("a frame A cannot place makes A ask B (live.resync, tagged); the front end never notices", async () => {
    const { world, fe } = await setup();
    const link = world.link!;
    world.live.start(BOT, "t7");
    const text = await stream(world, "t7", words(120), (i) => { if (i === 30) link.loseLive = 1; });
    await world.run(300);
    const resync = link.fromA.filter((m) => m.t === "live.resync") as Array<{ stream: string; via?: string }>;
    expect(resync.length).toBe(1);
    expect(resync[0]).toMatchObject({ stream: STREAM });
    expect(resync[0]!.via).toMatch(/^pt\./);
    expect(fe.resyncs).toBe(0);
    expect(fe.shown.at(-1)).toBe(text);
    expect(fe.violations).toEqual([]);
  });

  it("two bots streaming at once to one front end stay ≤ 10 frames/s on the connection", async () => {
    const { world, fe } = await setup();
    const second = "b2";
    const stream2 = `bot:${second}` as StreamId;
    await world.bStore.submit((tx) => { ensureStream(tx, stream2, B); });
    const seen2: LiveFrame[] = [];
    let leg2: PassThroughLeg | null = null;
    const send2 = fe.gate.add(stream2, () => leg2?.liveResync());
    leg2 = world.pass.open(stream2, null, () => true, (frame) => { seen2.push(frame); send2(frame); });
    await world.link!.settle();
    world.live.start(BOT, "t5");
    world.live.start(second, "u5");
    for (let i = 0; i < 200; i++) { world.live.delta(BOT, "t5", `a${i} `); world.live.delta(second, "u5", `b${i} `); await world.run(15); }
    await world.run(300);
    const all = fe.live.map((item) => item.at);
    expect(maxPerSecond(all)).toBeLessThanOrEqual(10);
    expect(seen2.length).toBeGreaterThan(5);
    expect(fe.violations).toEqual([]);
  });

  it("a keeper leg asks for no live frames (sub.live = false) and B sends none for it", async () => {
    const { world, fe } = await setup();
    const link = world.link!;
    fe.leg!.close(); // the last front end closed the bot: A keeps a subscription of its own
    await link.settle();
    expect(world.pass.legCount(STREAM).keepers).toBe(1);
    const subs = link.fromA.filter((m) => m.t === "sub") as Array<{ via: string; live?: boolean }>;
    expect(subs.at(-1)!.live).toBe(false);
    expect(subs[0]!.live).toBeUndefined();
    const before = link.fromB.filter((m) => m.t === "live").length;
    world.live.start(BOT, "t6");
    await stream(world, "t6", words(40));
    expect(link.fromB.filter((m) => m.t === "live").length).toBe(before);
  });

  it("the wire: only a peer tags live / live.resync or turns live off on a sub; a front end never gets a via", () => {
    const live = { t: "live", stream: STREAM, turnId: "t", seg: 0, rev: 1, at: 0, text: "x", via: "pt.1" };
    expect(encodeWireFrame(live as WireMessage, "peer", { local: false }).ok).toBe(true);
    expect(encodeFrame(live as Message, "server", { local: true }).ok).toBe(false);
    expect(encodeWireFrame({ t: "live.resync", stream: STREAM, via: "pt.1" } as WireMessage, "peer", { local: false }).ok).toBe(true);
    expect(encodeFrame({ t: "live.resync", stream: STREAM, via: "pt.1" } as Message, "fe", { local: true }).ok).toBe(false);
    expect(encodeWireFrame({ t: "sub", stream: STREAM, cursor: null, via: "pt.1", live: false } as WireMessage, "peer", { local: false }).ok).toBe(true);
    expect(encodeFrame({ t: "sub", stream: STREAM, cursor: null, live: false } as Message, "fe", { local: true }).ok).toBe(false);
    expect(encodeFrame({ t: "live.resync", stream: STREAM } as Message, "fe", { local: true }).ok).toBe(true);
  });
});
