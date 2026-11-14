// M3 step 8 (m3-brief §4 row 8, §5.9): pass-through of front ends' subscriptions to peers' bots, in one process over
// real server.db files. The stand-in for the skipped `Replication` pass-through model gate.
//
// Server B owns bot streams (a real LogHub on its store, PassThroughOwner answering forwarded subs); server A runs the
// real PassThrough with its PeerLogCache; they are joined by an in-memory FIFO peer link through the real wire encoder
// (peer role). A lost, duplicated or reordered frame ends a real session (D58), so every link fault here is a cut.
// Front ends on A subscribe through their legs and check every frame they get.
//
// Property (seeded): random appends on B, link cuts that stay down a while, restarts of A (its store reopened, the
// front ends re-attach with their cursors), restarts of B, restores of B (entries above a kept seq gone, new logId),
// front ends closing and re-opening the bot, late acks. Checked:
//   - every frame a front end gets equals what B sent for it, `via` taken off (byte-compare of the JSON), or comes from
//     A's cache while B is unreachable (then it equals B's earlier frames: entries compared by (logId, seq));
//   - the front end never applies an entry ≤ its cursor in one logId, never sees a gap, never returns to a retired logId,
//     never replaces its state with an older snapshot; every batch's prevHash chains on its last hash;
//   - A's cache always equals a prefix of what B has (snap + entries after it, hash chain intact);
//   - while B is down the front end gets A's cache and then `stale{since}` with A's own time of the last frame;
//   - after the last heal every front end is at B's head in B's current logId.
// Also: the 10-minute keep (clock injected) and followed bots; LRU above a lowered cap, followed bots last; history pages.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Cursor, Message, MessageOf, StreamId, WireMessage } from "../../src/protocol";
import { decodeWireFrame, encodeFrame, encodeWireFrame } from "../../src/protocol/frame";
import { verifyChain } from "../../src/server/log/chain";
import { LogHub } from "../../src/server/log";
import { appendEntries, ensureStream, retireStream } from "../../src/server/log/log-store";
import { PassThrough, PassThroughOwner, PeerLogCache, type PassThroughSession } from "../../src/server/replica";
import { openServerStore, type Db, type ServerStore } from "../../src/server/store";
import { message } from "./server-log-helpers";
import { rng } from "./server-slots-harness";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBB";
const dirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const run of cleanups.splice(0).reverse()) await run().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = (tag: string) => { const dir = mkdtempSync(join(tmpdir(), `passthrough-${tag}-`)); dirs.push(dir); return dir; };

// ---------------------------------------------------------------------------------------------
// Server B: bot streams on a real store and LogHub, the owner side of pass-through

class Owner {
  store!: ServerStore;
  hub!: LogHub;
  owner!: PassThroughOwner;
  /** Every entry B ever committed, by `logId:seq` (restored-away ones stay: frames of them were real). */
  readonly ever = new Map<string, string>();
  logs: string[] = [];
  constructor(readonly dir: string) {}

  async open(): Promise<void> {
    this.store = await openServerStore(this.dir);
    await this.store.submit((tx) => { tx.prepare("INSERT INTO meta (key, value) VALUES ('serverId', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(B); });
    this.hub = new LogHub(this.store, { pageEntries: 40, pageBytes: 64 * 1024 });
    this.owner = new PassThroughOwner({ hub: this.hub, log: (line) => this.logs.push(line), ensureBotStream: async () => false });
  }

  async close(): Promise<void> {
    this.owner.close();
    this.hub.close();
    await this.store.close();
  }

  async create(stream: string): Promise<void> {
    await this.store.submit((tx) => { ensureStream(tx, stream as StreamId, B); });
  }

  async append(stream: string, count: number, tag: string): Promise<void> {
    const botId = stream.slice(4);
    const items = Array.from({ length: count }, (_, i) => ({ kind: "message.added", body: { botId, message: message(`${tag}-${i}`, `${tag} ${i} ${"x".repeat((i * 37) % 300)}`) } }));
    const entries = await this.store.submit((tx) => appendEntries(tx, stream as StreamId, items));
    for (const entry of entries) this.ever.set(`${entry.logId}:${entry.seq}`, JSON.stringify(entry));
    this.hub.committed([stream as StreamId]);
  }

  head(stream: string): { logId: string; seq: number } {
    const row = this.hub.reader().prepare("SELECT logId, head FROM streams WHERE stream = ?").get(stream)!;
    return { logId: String(row.logId), seq: Number(row.head) };
  }

  /** B restored to an older state (botlingd restore runs stopped): entries above `kept` gone, the stream gets a new logId. */
  async restore(stream: string, kept: number): Promise<string> {
    return this.store.submit((tx) => {
      const hash = kept === 0 ? "0".repeat(64) : String(tx.prepare("SELECT hash FROM entries WHERE stream = ? AND seq = ?").get(stream, kept)!.hash);
      tx.prepare("DELETE FROM entries WHERE stream = ? AND seq > ?").run(stream, kept);
      tx.prepare("UPDATE streams SET head = ?, headHash = ? WHERE stream = ?").run(kept, hash, stream);
      return retireStream(tx, stream, "restored").logId;
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Server A: the attached side

class Attached {
  store!: ServerStore;
  reader!: Db;
  cache!: PeerLogCache;
  pass!: PassThrough;
  state: { state: string; since: number | null } = { state: "stale", since: null };
  session: Side | null = null;
  logs: string[] = [];
  readonly followed = new Set<string>();
  readonly timers: Array<{ at: number; run: () => void; done: boolean }> = [];
  clock = 1_700_000_000_000;
  constructor(readonly dir: string, readonly capBytes = 64 * 1024 * 1024, readonly keepMs = 600_000) {}

  async open(): Promise<void> {
    this.store = await openServerStore(this.dir);
    this.reader = this.store.openReader();
    this.cache = new PeerLogCache({ store: this.store, reader: () => this.reader, capBytes: this.capBytes, now: () => this.clock, log: (line) => this.logs.push(line), priority: (stream) => this.pass.priority(stream) });
    this.pass = new PassThrough({
      cache: this.cache, now: () => this.clock, log: (line) => this.logs.push(line), keepMs: this.keepMs,
      ownerOf: (stream) => (stream.startsWith("bot:") ? B : null),
      session: () => (this.session && this.session.state === "open" ? this.session : null),
      peerState: () => this.state,
      followed: (stream) => this.followed.has(stream),
      schedule: (run, ms) => { const timer = { at: this.clock + ms, run, done: false }; this.timers.push(timer); return () => { timer.done = true; }; },
    });
  }

  advance(ms: number): void {
    this.clock += ms;
    for (const timer of this.timers) if (!timer.done && timer.at <= this.clock) { timer.done = true; timer.run(); }
  }

  async close(): Promise<void> {
    this.pass.close();
    await this.cache.idle();
    this.reader.close();
    await this.store.close();
  }

  /** The cache as a reader with no cursor would get it: snap + entries after it. */
  async cached(stream: string): Promise<Message[]> { return this.cache.frames(stream, null); }
}

// ---------------------------------------------------------------------------------------------
// The link (FIFO, real wire encoder; a fault ends it on both sides)

class Side implements PassThroughSession {
  state = "open";
  constructor(private readonly link: Link, readonly peer: string) {}
  sendWire(message: WireMessage): boolean {
    if (this.state !== "open") return false;
    return this.link.enqueue(this, message);
  }
}

class Link {
  /** Every tagged frame B ever sent on any link (for late replays). */
  static history: WireMessage[] = [];
  readonly atA: Side;
  readonly atB: Side;
  private queue: Array<{ toA: boolean; text: string }> = [];
  open = true;
  /** What B sent on this link for each `via`, decoded. */
  readonly sentByB = new Map<string, WireMessage[]>();
  constructor(readonly a: Attached, readonly b: Owner) {
    this.atA = new Side(this, B);
    this.atB = new Side(this, A);
  }

  start(): void {
    this.a.session = this.atA;
    this.a.state = { state: "live", since: this.a.clock };
    this.a.pass.sessionOpened(this.atA);
  }

  enqueue(from: Side, message: WireMessage): boolean {
    if (!this.open) return false;
    const encoded = encodeWireFrame(message, "peer", { local: false });
    if (!encoded.ok) throw new Error(`cannot encode ${message.t}: ${encoded.detail}`);
    const toA = from === this.atB;
    if (toA && (message as { via?: string }).via) {
      const via = (message as { via: string }).via;
      const list = this.sentByB.get(via) ?? [];
      const copy = JSON.parse(encoded.text) as WireMessage;
      list.push(copy);
      this.sentByB.set(via, list);
      Link.history.push(copy);
    }
    this.queue.push({ toA, text: encoded.text });
    return true;
  }

  /** Delivers frames one at a time (D58) until the queue is empty or `limit` frames went. */
  async pump(limit = Infinity): Promise<number> {
    let n = 0;
    while (this.open && this.queue.length && n < limit) {
      const { toA, text } = this.queue.shift()!;
      const decoded = decodeWireFrame(new TextEncoder().encode(text), "peer", { local: false });
      if (!decoded.ok) throw new Error(`cannot decode: ${decoded.detail}`);
      if (toA) {
        if (!this.a.pass.onMessage(this.atA, decoded.message)) throw new Error(`A did not take ${decoded.message.t}`);
      } else if (!(await this.b.owner.onMessage(this.atB, decoded.message))) throw new Error(`B did not take ${decoded.message.t}`);
      n++;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return n;
  }

  /** Lets pending work settle and delivers everything. */
  async settle(): Promise<void> {
    for (let round = 0; round < 200; round++) {
      await this.a.cache.idle();
      await new Promise((resolve) => setImmediate(resolve));
      if (!this.queue.length) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (!this.queue.length) return;
      }
      await this.pump();
    }
  }

  cut(lastHeard: number): void {
    if (!this.open) return;
    this.open = false;
    this.queue = [];
    this.atA.state = "closed";
    this.atB.state = "closed";
    this.b.owner.sessionClosed(this.atB);
    if (this.a.session === this.atA) this.a.session = null;
    this.a.pass.sessionClosed(this.atA);
    this.a.state = { state: "stale", since: lastHeard };
    this.a.pass.peerStateChanged(B, "stale", lastHeard);
  }
}

// ---------------------------------------------------------------------------------------------
// A front end on A: checks every frame it gets

class FrontEnd {
  logId: string | null = null;
  seq = -1;
  lastHash: string | null = null;
  readonly retired = new Set<string>();
  readonly violations: string[] = [];
  readonly frames: Message[] = [];
  stale: Array<{ since: number }> = [];
  leg: { ack(cursor: Cursor): void; close(): void } | null = null;
  pendingAck: Cursor | null = null;
  applied = 0;
  constructor(readonly name: string, readonly stream: string, readonly owner: Owner) {}

  cursor(): Cursor | null { return this.logId && this.seq >= 0 ? { logId: this.logId as Cursor["logId"], seq: this.seq } : null; }

  attach(a: Attached): void {
    this.leg?.close();
    this.leg = a.pass.open(this.stream, this.cursor(), (frame) => { this.take(frame); return true; });
  }

  detach(): void { this.leg?.close(); this.leg = null; }

  /** The front end lost its own copy (a wiped IndexedDB): it subscribes with no cursor and knows no retired logId. */
  wipe(): void { this.logId = null; this.seq = -1; this.lastHash = null; this.retired.clear(); this.pendingAck = null; }

  ack(): void {
    if (this.pendingAck && this.leg) this.leg.ack(this.pendingAck);
    this.pendingAck = null;
  }

  private take(frame: Message): void {
    this.frames.push(frame);
    // An FE decodes what a server sends it: the frame must be valid M1 wire (no via).
    const encoded = encodeFrame(frame, "server", { local: true });
    if (!encoded.ok) { this.violations.push(`not valid for an FE: ${encoded.detail}`); return; }
    if ((frame as { via?: unknown }).via !== undefined) this.violations.push("a via reached the FE");
    if (frame.t === "stale") { this.stale.push({ since: frame.since }); return; }
    if (frame.t === "reset") {
      if (this.retired.has(frame.logId)) this.violations.push("reset back to a retired logId");
      if (this.logId && !frame.retired.some((old) => old.logId === this.logId)) this.violations.push("reset that does not retire the FE's logId");
      for (const old of frame.retired) this.retired.add(old.logId);
      this.logId = frame.logId;
      this.seq = -1;
      this.lastHash = null;
      return;
    }
    if (frame.t === "snap") {
      if (this.retired.has(frame.logId)) this.violations.push("snap of a retired logId");
      if (this.logId && frame.logId !== this.logId) this.violations.push(`snap of another logId without a reset (${this.logId} → ${frame.logId})`);
      if (this.logId === frame.logId && frame.seq < this.seq) this.violations.push(`older snapshot ${frame.seq} < ${this.seq}`);
      this.logId = frame.logId;
      this.seq = frame.seq;
      this.lastHash = frame.hash;
      return;
    }
    if (frame.t === "batch") {
      if (this.retired.has(frame.logId)) { this.violations.push("batch of a retired logId"); return; }
      if (frame.logId !== this.logId) { this.violations.push("batch of another logId"); return; }
      if (frame.from <= this.seq) this.violations.push(`entry ${frame.from} ≤ cursor ${this.seq}`);
      if (frame.from > this.seq + 1) this.violations.push(`gap: ${frame.from} after ${this.seq}`);
      if (frame.prevHash !== this.lastHash) this.violations.push(`prevHash does not chain at ${frame.from}`);
      const check = verifyChain(frame.prevHash, frame.entries);
      if (!check.ok) this.violations.push(`chain broken at ${check.seq}`);
      for (const entry of frame.entries) {
        const truth = this.owner.ever.get(`${entry.logId}:${entry.seq}`);
        if (truth !== JSON.stringify(entry)) this.violations.push(`entry ${entry.logId}:${entry.seq} is not B's`);
      }
      this.seq = frame.to;
      this.lastHash = frame.entries[frame.entries.length - 1]!.hash;
      this.applied += frame.entries.length;
      this.pendingAck = { logId: frame.logId, seq: frame.to };
      return;
    }
    this.violations.push(`unexpected ${frame.t}`);
  }
}

/** A's cache is a prefix of what B committed: a snap of B's, entries after it that are B's, chain intact. */
async function checkCache(a: Attached, b: Owner, stream: string): Promise<string[]> {
  const problems: string[] = [];
  const frames = await a.cached(stream);
  if (!frames.length) return problems;
  const snap = frames[0] as MessageOf<"snap">;
  if (snap.t !== "snap") return [`cache starts with ${snap.t}`];
  // Never back to a retired logId (D50): once the cache took a reset retiring a logId, it never holds that logId again.
  // (Before it hears the reset, a cache of B's old incarnation is just behind, as any reader is.)
  const known = a.cache.get(stream)?.retired.list.map((old) => old.logId) ?? [];
  if (known.includes(snap.logId)) problems.push(`cache holds the retired logId ${snap.logId}`);
  const bRetired = b.hub.reader().prepare("SELECT logId FROM retired WHERE stream = ?").all(stream).map((row) => String(row.logId));
  for (const logId of known) if (!bRetired.includes(logId)) problems.push(`cache thinks ${logId} retired; B does not`);
  let hash = snap.hash;
  let seq = snap.seq;
  for (const frame of frames.slice(1)) {
    if (frame.t !== "batch") { problems.push(`cache has ${frame.t}`); continue; }
    if (frame.prevHash !== hash || frame.from !== seq + 1) problems.push(`cache chain at ${frame.from}`);
    const check = verifyChain(hash, frame.entries);
    if (!check.ok) problems.push(`cache chain broken at ${check.seq}`);
    for (const entry of frame.entries) if (b.ever.get(`${entry.logId}:${entry.seq}`) !== JSON.stringify(entry)) problems.push(`cache entry ${entry.seq} is not B's`);
    hash = frame.entries[frame.entries.length - 1]!.hash;
    seq = frame.to;
  }
  return problems;
}

async function pair(capBytes?: number, keepMs?: number): Promise<{ a: Attached; b: Owner }> {
  const b = new Owner(tempDir("b"));
  await b.open();
  const a = new Attached(tempDir("a"), capBytes, keepMs);
  await a.open();
  cleanups.push(async () => { await a.close(); await b.close(); });
  return { a, b };
}

describe("M3 step 8: pass-through (stand-in for the Replication pass-through gate)", () => {
  it("relays B's frames unchanged (via taken off), caches snap + entries, passes acks so B pages by the FE's window", async () => {
    const { a, b } = await pair();
    const stream = "bot:alpha";
    await b.create(stream);
    await b.append(stream, 30, "first");
    const link = new Link(a, b);
    link.start();
    const fe = new FrontEnd("fe", stream, b);
    fe.attach(a);
    await link.settle();
    // B pages by 40 entries; the FE acks, B sends the next page.
    await b.append(stream, 100, "more");
    for (let i = 0; i < 10; i++) { await link.settle(); fe.ack(); }
    await link.settle();
    expect(fe.violations).toEqual([]);
    expect({ logId: fe.logId, seq: fe.seq }).toEqual(b.head(stream));
    // Byte-compare: every frame the FE got is exactly what B sent on the link for its via, without the via.
    const [via] = [...link.sentByB.keys()];
    const sent = link.sentByB.get(via)!.map((frame) => { const { via: _v, ...rest } = frame as WireMessage & { via?: string }; return JSON.stringify(rest); });
    expect(fe.frames.map((frame) => JSON.stringify(frame))).toEqual(sent);
    expect(sent.length).toBeGreaterThan(3);
    // The cache: B's snap + every entry after it, hash chain intact.
    expect(await checkCache(a, b, stream)).toEqual([]);
    expect(a.cache.cursor(stream)).toEqual(fe.cursor());
    // History pages pass through with the FE's own request id.
    const pages: Message[] = [];
    a.pass.history({ t: "history", req: "fe-req-1", stream: stream as StreamId, before: "unknown-line" }, (page) => { pages.push(page); return true; });
    await link.settle();
    expect(pages).toEqual([expect.objectContaining({ t: "history.page", req: "fe-req-1", stream, logId: fe.logId, hasMore: false })]);
  });

  it("B unreachable: a new FE gets A's cache, then stale{since} with A's time of the last frame; resumes with no gap after the heal", async () => {
    const { a, b } = await pair();
    const stream = "bot:beta";
    await b.create(stream);
    await b.append(stream, 25, "x");
    let link = new Link(a, b);
    link.start();
    const first = new FrontEnd("first", stream, b);
    first.attach(a);
    for (let i = 0; i < 5; i++) { await link.settle(); first.ack(); }
    const heard = a.clock;
    a.clock += 5_000;
    link.cut(heard);
    // The attached FE: stale since the last frame heard.
    await link.settle();
    expect(first.stale.at(-1)).toEqual({ since: heard });
    // A new FE with no cursor: the cache (snap + entries), then stale.
    const late = new FrontEnd("late", stream, b);
    late.attach(a);
    await a.cache.idle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(late.frames.map((f) => f.t)).toEqual(["snap", ...late.frames.slice(1, -1).map(() => "batch"), "stale"]);
    expect(late.seq).toBe(first.seq);
    expect(late.stale).toEqual([{ since: heard }]);
    expect(late.violations).toEqual([]);
    // B goes on while unreachable; the heal brings both FEs to B's head without a gap or a duplicate.
    await b.append(stream, 60, "while-down");
    link = new Link(a, b);
    link.start();
    for (let i = 0; i < 10; i++) { await link.settle(); first.ack(); late.ack(); }
    for (const fe of [first, late]) {
      expect(fe.violations).toEqual([]);
      expect({ logId: fe.logId, seq: fe.seq }).toEqual(b.head(stream));
    }
    // A's restart: the cache survives in server.db and is served while B is down.
    link.cut(a.clock);
    await a.close();
    await a.open();
    const afterRestart = new FrontEnd("after", stream, b);
    afterRestart.attach(a);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(afterRestart.seq).toBe(b.head(stream).seq);
    expect(afterRestart.violations).toEqual([]);
    expect(afterRestart.stale.length).toBe(1);
  });

  it("the FE closes the bot: A keeps its own subscription for 10 minutes (clock injected), then unsubscribes unless followed", async () => {
    const { a, b } = await pair();
    const stream = "bot:gamma";
    const followedStream = "bot:delta";
    for (const s of [stream, followedStream]) { await b.create(s); await b.append(s, 10, s); }
    const link = new Link(a, b);
    link.start();
    a.followed.add(followedStream);
    const fe = new FrontEnd("fe", stream, b);
    const fe2 = new FrontEnd("fe2", followedStream, b);
    fe.attach(a); fe2.attach(a);
    await link.settle();
    fe.detach(); fe2.detach();
    await link.settle();
    expect(a.pass.legCount(stream)).toEqual({ fe: 0, keepers: 1 });
    expect(a.pass.legCount(followedStream)).toEqual({ fe: 0, keepers: 1 });
    expect(b.owner.readerCount()).toBe(2);
    // The keeper follows new entries and acknowledges them itself (B keeps pushing past its 40-entry window).
    await b.append(stream, 100, "kept");
    await link.settle();
    expect(a.cache.cursor(stream)?.seq).toBe(b.head(stream).seq);
    a.advance(9 * 60 * 1000);
    await link.settle();
    expect(a.pass.legCount(stream).keepers).toBe(1);
    a.advance(60 * 1000 + 1);
    await link.settle();
    expect(a.pass.legCount(stream).keepers).toBe(0);
    expect(a.pass.legCount(followedStream).keepers).toBe(1);
    expect(b.owner.readerCount()).toBe(1);
    // A quick re-open within the keep stops the keeper (one subscription at B per stream and front end).
    fe.attach(a);
    for (let i = 0; i < 5; i++) { await link.settle(); fe.ack(); }
    expect(fe.violations).toEqual([]);
    expect(fe.seq).toBe(b.head(stream).seq);
    // Unfollowing arms the 10-minute timer for the followed bot's keeper.
    a.followed.delete(followedStream);
    a.pass.ensureFollowed([]);
    a.advance(10 * 60 * 1000 + 1);
    await link.settle();
    expect(a.pass.legCount(followedStream).keepers).toBe(0);
  });

  it("LRU above the (lowered) cap: idle streams go first, followed bots last", async () => {
    const { a, b } = await pair(64 * 1024);
    const streams = ["bot:s1", "bot:s2", "bot:s3", "bot:s4"];
    const link = new Link(a, b);
    link.start();
    a.followed.add("bot:s1");
    for (const stream of streams) {
      await b.create(stream);
      await b.append(stream, 60, stream);
      const fe = new FrontEnd(stream, stream, b);
      fe.attach(a);
      for (let i = 0; i < 3; i++) { await link.settle(); fe.ack(); }
      await link.settle();
      fe.detach();
      a.advance(1_000);
      await link.settle();
    }
    // Keepers end (s1 stays followed); then more data forces evictions.
    a.advance(11 * 60 * 1000);
    await link.settle();
    const big = new FrontEnd("big", "bot:s4", b);
    big.attach(a);
    await b.append("bot:s4", 60, "grow");
    for (let i = 0; i < 4; i++) { await link.settle(); big.ack(); }
    await a.cache.idle();
    expect(a.cache.totalBytes).toBeLessThanOrEqual(a.cache.capBytes);
    expect(a.cache.counts.evicted).toBeGreaterThan(0);
    const held = a.cache.streams().map((log) => log.stream).sort();
    expect(held).toContain("bot:s1"); // followed: last
    expect(held).toContain("bot:s4"); // in use
    expect(held).not.toContain("bot:s2"); // the least recently used idle one went first
    expect(big.violations).toEqual([]);
  });

  it("property: random appends, cuts, A/B restarts, B restores, FE re-opens → monotonic, never a retired logId, cache = B's prefix", async () => {
    const totals = { replays: 0, wipes: 0, runs: 0, steps: 0, cuts: 0, aRestarts: 0, bRestarts: 0, restores: 0, reopens: 0, served: 0, stale: 0, applied: 0, resets: 0 };
    for (let seed = 1; seed <= 10; seed++) {
      Link.history = [];
      const random = rng(seed * 7919);
      const pick = (n: number) => Math.floor(random() * n);
      const { a, b } = await pair(256 * 1024);
      const streams = ["bot:p1", "bot:p2"];
      for (const stream of streams) { await b.create(stream); await b.append(stream, 5 + pick(30), `s${seed}`); }
      let link: Link | null = new Link(a, b);
      link.start();
      const fes = [new FrontEnd("x", streams[0]!, b), new FrontEnd("y", streams[0]!, b), new FrontEnd("z", streams[1]!, b)];
      for (const fe of fes) fe.attach(a);
      for (let step = 0; step < 80; step++) {
        totals.steps++;
        const roll = random();
        const stream = streams[pick(2)]!;
        if (roll < 0.35) {
          await b.append(stream, 1 + pick(60), `s${seed}-${step}`);
        } else if (roll < 0.5) {
          if (link?.open) {
            await link.pump(pick(6));
            const heard = a.clock;
            a.clock += 1 + pick(10_000);
            link.cut(heard);
            totals.cuts++;
          }
        } else if (roll < 0.62) {
          if (!link?.open) { link = new Link(a, b); link.start(); }
        } else if (roll < 0.67) {
          // A restarts (SIGKILL-like: no flush beyond what committed); its FEs re-attach with their cursors.
          link?.cut(a.clock);
          totals.served += a.pass.counts.servedFromCache;
          await a.close();
          await a.open();
          totals.aRestarts++;
          for (const fe of fes) { fe.leg = null; fe.attach(a); }
        } else if (roll < 0.71) {
          link?.cut(a.clock);
          await b.close();
          await b.open();
          totals.bRestarts++;
        } else if (roll < 0.76) {
          // B restored (stopped): a kept seq at or below its head, new logId.
          link?.cut(a.clock);
          const head = b.head(stream).seq;
          await b.close();
          await b.open();
          await b.restore(stream, pick(head + 1));
          totals.restores++;
        } else if (roll < 0.84) {
          const fe = fes[pick(fes.length)]!;
          fe.detach();
          if (random() < 0.5) a.advance(pick(15) * 60 * 1000);
          if (random() < 0.4) { fe.wipe(); totals.wipes++; }
          fe.attach(a);
          totals.reopens++;
        } else if (roll < 0.92) {
          for (const fe of fes) if (random() < 0.7) fe.ack();
        } else if (link?.open && Link.history.length) {
          // A late or repeated frame (an old relay, a frame of an earlier incarnation) handed to an open leg by hand:
          // a real session would end on it (D58); a late relay must still never move a front end back (D50).
          const vias = [...link.sentByB.keys()];
          const via = vias[pick(vias.length)];
          const target = via ? link.sentByB.get(via)![0] as { stream: string } : null;
          const old = Link.history.filter((frame) => (frame as { stream: string }).stream === target?.stream);
          if (via && old.length) {
            const frame = { ...old[pick(old.length)]!, via } as WireMessage;
            expect(a.pass.onMessage(link.atA, frame)).toBe(true);
            totals.replays++;
          }
        }
        if (link?.open) await link.pump(pick(40));
        await a.cache.idle();
        await new Promise((resolve) => setImmediate(resolve));
        for (const s of streams) {
          const problems = await checkCache(a, b, s);
          expect(problems, `seed ${seed} step ${step} cache of ${s}`).toEqual([]);
        }
        for (const fe of fes) expect(fe.violations, `seed ${seed} step ${step} ${fe.name}`).toEqual([]);
      }
      // Heal: everyone reaches B's head in B's current logId.
      if (!link?.open) { link = new Link(a, b); link.start(); }
      for (let round = 0; round < 40; round++) { await link.settle(); for (const fe of fes) fe.ack(); }
      for (const fe of fes) {
        expect(fe.violations, `seed ${seed} final ${fe.name}`).toEqual([]);
        expect({ logId: fe.logId, seq: fe.seq }, `seed ${seed} ${fe.name} at B's head`).toEqual(b.head(fe.stream));
        totals.stale += fe.stale.length;
        totals.applied += fe.applied;
        totals.resets += fe.frames.filter((f) => f.t === "reset").length;
      }
      totals.served += a.pass.counts.servedFromCache;
      totals.runs++;
    }
    console.log(`pass-through property: ${JSON.stringify(totals)}`);
    expect(totals.cuts).toBeGreaterThan(25);
    expect(totals.restores).toBeGreaterThan(10);
    expect(totals.aRestarts).toBeGreaterThan(10);
    expect(totals.bRestarts).toBeGreaterThan(10);
    expect(totals.resets).toBeGreaterThan(5);
    expect(totals.served).toBeGreaterThan(20);
    expect(totals.replays).toBeGreaterThan(10);
    expect(totals.stale).toBeGreaterThan(10);
  }, 120_000);
});
