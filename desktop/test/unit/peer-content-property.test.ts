// M3 step 10 (m3-brief §4 row 10; the M3 part of the skipped `Fetch` gate's stand-in, §5.9): content owned by server B
// read through server A. In one process, over real `server.db` files: B runs the real ContentService (files posted on a
// bot's line, pinned and hashed) and PeerContentOwner; A runs the real PeerContent, ChunkCache, PeerCacheBudget and
// RemoteContent behind a real LoopbackListener (127.0.0.1, port 0). The two are joined by a FIFO peer link through the
// real wire encoder (peer role; chunks as binary frames), whose frames are counted per direction.
//
// Checked:
//   - `/v3/c/<B>/…` through A answers exactly as M1's local path (`previewResponse`): sizes × Range headers × GET/HEAD;
//   - a second read of the same range is served from A's cache with no peer traffic;
//   - a chunk corrupted by B (the test hook) is refused: never cached, never served (502), on every try;
//   - a file above 1/4 of the budget streams through (correct bytes, nothing kept);
//   - a request naming an entry that does not reference the id, an unreadable stream, a device revoked on A or on B is
//     refused, at both servers; a revocation on either side mid-file stops the stream (chunks in flight dropped);
//   - a seek (the reader cancels) cancels the request at B;
//   - B unreachable: cached ranges still play, uncached ones answer 503 offline;
//   - the one budget (Q5): chunks and peers' logs share it, idle first, followed last.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewResponse } from "../../src/main/preview-response";
import { CHAT_MEDIA_CSP } from "../../src/main-v3/content-protocol";
import { CONTENT_CHUNK_BYTES, contentUrlPath, type DeviceScope, type EntryRef, type MessageOf, type StreamId, type WireMessage } from "../../src/protocol";
import { decodeWireFrame, encodeChunkFrame, encodeWireFrame } from "../../src/protocol/frame";
import { ContentService, type LineLike } from "../../src/server/content";
import { ChunkCache, PeerCacheBudget, type BudgetSource } from "../../src/server/content/chunk-cache";
import { PeerContent, PeerContentOwner } from "../../src/server/content/peer-content";
import { RemoteContent } from "../../src/server/content/remote";
import { ContentTickets } from "../../src/server/content/tickets";
import { ensureStream } from "../../src/server/log";
import { LoopbackListener } from "../../src/server/net";
import type { PeerSession } from "../../src/server/peer";
import { PeerLogCache } from "../../src/server/replica";
import { openServerStore, type ServerStore } from "../../src/server/store";

const MiB = CONTENT_CHUNK_BYTES;
const PEER = { local: false } as const;
const DEVICE = "abcdefghijklmnopqrstuvwxyz";
const BOT = "b1";
const STREAM = `bot:${BOT}` as StreamId;

function bytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = createHash("sha256").update(seed).digest();
  for (let at = 0; at < size; at += 32) { x.copy(out, at); x = createHash("sha256").update(x).digest(); }
  return out;
}
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const HEADERS = ["content-type", "content-range", "content-length", "accept-ranges", "content-security-policy", "cache-control", "x-content-type-options"];
async function answer(response: Response) {
  const headers: Record<string, string | null> = {};
  for (const name of HEADERS) headers[name] = response.headers.get(name);
  const body = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers, body: body.length ? createHash("sha256").update(body).digest("hex") + `:${body.length}` : null };
}
/** The same ranges as M1's and M2's property tests. */
function ranges(size: number, next: () => number, extra = 18): Array<string | null> {
  const n = (max: number) => Math.floor(next() * (max + 1));
  const out: Array<string | null> = [null, "bytes=0-", "bytes=0-0", `bytes=${size}-`, `bytes=${Math.max(0, size - 1)}-`, "bytes=-1", `bytes=-${size + 10}`, "bytes=-0", "bytes=-", "bytes=5-2",
    `bytes=0-${size + 1000}`, "bytes=0-1,4-5", "items=0-1", "bytes= 0-1", "bytes=99999999999999999999-", `bytes=${MiB - 1}-${MiB}`, `bytes=${MiB}-`];
  for (let i = 0; i < extra; i++) {
    const a = n(size + 2);
    const b = n(size + 2);
    const pick = n(4);
    out.push(pick === 0 ? `bytes=${Math.min(a, b)}-${Math.max(a, b)}` : pick === 1 ? `bytes=${a}-` : pick === 2 ? `bytes=-${b}` : pick === 3 ? `bytes=${Math.max(a, b)}-${Math.min(a, b)}` : `bytes=${a}-${a + n(3 * MiB)}`);
  }
  return out;
}

/** A roster of one device whose scope (or absence) the test sets. */
function roster(scope: DeviceScope[] | null = ["read", "reply"]) {
  const state = { scope };
  return { state, device: (member: string) => (member === DEVICE && state.scope ? { keys: { sign: "s", dh: "d" }, scope: state.scope } : null) };
}

/** Two ends of a FIFO peer session through the real wire encoder; frames counted per direction. */
class Link {
  open = true;
  readonly frames = { up: 0, down: 0 };
  readonly bytes = { up: 0, down: 0 };
  readonly a: PeerSession;
  readonly b: PeerSession;
  private queue: Array<() => void> = [];
  private flushing = false;
  constructor(onA: (s: PeerSession, m: WireMessage) => void, onB: (s: PeerSession, m: WireMessage) => void, aId: string, bId: string) {
    const end = (peer: string, dir: "up" | "down", deliver: () => (m: WireMessage) => void) => ({
      peer,
      get state() { return link.open ? "open" : "closed"; },
      sendWire: (message: WireMessage) => {
        if (!link.open) return false;
        const encoded = encodeWireFrame(message, "peer", PEER);
        if (!encoded.ok) throw new Error(`${message.t}: ${encoded.detail}`);
        link.push(dir, encoded.text, deliver);
        return true;
      },
      sendChunk: (message: MessageOf<"content.chunk">) => {
        if (!link.open) return false;
        const encoded = encodeChunkFrame(message, "peer", PEER);
        if (!encoded.ok) throw new Error(encoded.detail);
        link.push(dir, encoded.bytes, deliver);
        return true;
      },
    }) as unknown as PeerSession;
    const link = this;
    // A's end sends up (to B) and B's end sends down (to A).
    this.a = end(bId, "up", () => (m) => onB(this.b, m));
    this.b = end(aId, "down", () => (m) => onA(this.a, m));
  }
  private push(dir: "up" | "down", frame: string | Uint8Array, deliver: () => (m: WireMessage) => void): void {
    this.frames[dir]++;
    this.bytes[dir] += typeof frame === "string" ? frame.length : frame.length;
    this.queue.push(() => {
      if (!this.open) return;
      const decoded = decodeWireFrame(frame, "peer", PEER);
      if (!decoded.ok) throw new Error(`bad frame: ${decoded.detail}`);
      deliver()(decoded.message);
    });
    if (!this.flushing) { this.flushing = true; setImmediate(() => this.flush()); }
  }
  private flush(): void {
    // A few frames per turn, so HTTP and timers interleave as on a socket.
    for (let i = 0; i < 8 && this.queue.length; i++) this.queue.shift()!();
    if (this.queue.length) setImmediate(() => this.flush()); else this.flushing = false;
  }
  reset(): void { this.frames.up = this.frames.down = 0; this.bytes.up = this.bytes.down = 0; }
}

let scratch: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "botling-peer-content-")); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

interface World {
  storeA: ServerStore; storeB: ServerStore; serviceB: ContentService; owner: PeerContentOwner; peer: PeerContent; cache: ChunkCache;
  link: Link; rosterA: ReturnType<typeof roster>; rosterB: ReturnType<typeof roster>; tickets: ContentTickets; remote: RemoteContent;
  origin: string; aId: string; bId: string; budget: PeerCacheBudget;
  post(line: string, file: string): Promise<void>;
  locate(line: string, file: string): Promise<MessageOf<"content.located">>;
  url(ref: NonNullable<MessageOf<"content.located">["ref"]>, ticket: string, variant?: string): string;
  setOffline(offline: boolean): void;
}

async function world(options: { capBytes?: number; corrupt?: () => string | null } = {}): Promise<World> {
  const storeB = await openServerStore(join(scratch, "B"));
  const storeA = await openServerStore(join(scratch, "A"));
  const bId = storeB.meta("serverId")!;
  const aId = storeA.meta("serverId")!;
  await storeB.submit((db) => { ensureStream(db, STREAM); ensureStream(db, "bot:b2" as StreamId); });
  const serviceB = new ContentService({ store: storeB, dataDir: join(scratch, "B"), serverId: bId });
  const rosterA = roster();
  const rosterB = roster();
  const corrupt = { id: null as string | null };
  const owner = new PeerContentOwner({ service: serviceB, roster: rosterB, ...(options.corrupt ? {} : {}) });
  Object.defineProperty((owner as unknown as { options: object }).options, "corruptId", { get: () => corrupt.id });
  const budget = new PeerCacheBudget(options.capBytes ?? 16 * MiB);
  let peer!: PeerContent;
  const cache = new ChunkCache({ store: storeA, reader: () => storeA.openReader(), dataDir: join(scratch, "A"), budget, priority: (key, stream) => peer.priority(key, stream) });
  const link = new Link((s, m) => { peer.onMessage(s, m); }, (s, m) => { owner.onMessage(s, m); }, aId, bId);
  let offline = false;
  const readerA = storeA.openReader();
  peer = new PeerContent({
    self: aId, store: storeA, reader: () => readerA, cache,
    session: (who) => (who === bId && !offline ? link.a : null),
    ownerOf: (stream) => (stream.startsWith("bot:b") ? bId : null),
    readable: (member) => { const d = rosterA.device(member); return !!d && d.scope.includes("read"); },
    timeoutMs: 5_000,
  });
  const tickets = new ContentTickets();
  const serviceA = { serverId: aId, locate: () => null, open: async (m: MessageOf<"content.open">) => ({ t: "content.gone" as const, req: m.req, id: m.id, reason: "offline" as const }), markChanged: async () => undefined };
  const remote = new RemoteContent({ service: serviceA, tickets, roster: rosterA, peer });
  const listener = await LoopbackListener.start({ port: 0, remote: { accept: () => { throw new Error("no sessions here"); } }, pageDir: null, origins: () => [], log: () => undefined, content: remote });
  cleanups.push(async () => {
    peer.close();
    await listener.close();
    await peer.flushed();
    readerA.close();
    await serviceB.close();
    await storeA.close();
    await storeB.close();
  });
  const w: World = {
    storeA, storeB, serviceB, owner, peer, cache, link, rosterA, rosterB, tickets, remote, origin: `http://127.0.0.1:${listener.port}`, aId, bId, budget,
    async post(line, file) {
      const l: LineLike = { id: line, text: `![f](${pathToFileURL(file).href})` };
      const message = { id: line, role: "bot", text: l.text, time: "2026-11-15T00:00:00.000Z", state: "done" };
      const { ready } = await serviceB.appendLine(STREAM, BOT, l, [{ kind: "message.added", body: { botId: BOT, message } }]);
      await ready;
    },
    locate: (line, file) => remote.locate(DEVICE, { t: "content.locate", req: "k1", botId: BOT, line, url: pathToFileURL(file).href }),
    url: (ref, ticket, variant = "original") => w.origin + contentUrlPath({ owner: ref.owner, id: ref.id, variant, entry: ref.entry, ticket }),
    setOffline(value) {
      offline = value;
      link.open = !value;
      if (value) { peer.sessionClosed(link.a); owner.sessionClosed(link.b); }
    },
  };
  (w as unknown as { corrupt: typeof corrupt }).corrupt = corrupt;
  return w;
}

async function located(w: World, line: string, size: number, seed = line) {
  const file = join(scratch, `${line}.mp4`);
  const data = bytes(seed, size);
  writeFileSync(file, data);
  await w.post(line, file);
  const found = await w.locate(line, file);
  if (!found.ref || !found.ticket) throw new Error(`no reference for ${line}: ${JSON.stringify(found)}`);
  return { file, data, ref: found.ref, ticket: found.ticket, url: w.url(found.ref, found.ticket) };
}

const get = (url: string, range?: string, method = "GET") => fetch(url, { method, headers: range ? { range } : {} });

describe("M3 step 10: content owned by B, read through A", () => {
  it("answers /v3/c/<B>/… exactly as M1's local path (sizes × Range headers × GET/HEAD); B located the line and A's ticket serves it", async () => {
    const w = await world();
    const next = random(7);
    const sizes = [1, 2, 31, MiB - 1, MiB, MiB + 1, 3 * MiB + 12_345, 1 + Math.floor(next() * 2 * MiB)];
    let compared = 0;
    const statuses = new Set<number>();
    for (const [i, size] of sizes.entries()) {
      const item = await located(w, `m${i}`, size);
      expect(item.ref.owner).toBe(w.bId);
      expect(item.ref.id).toMatch(/^sha256:[0-9a-f]{64}$/);
      for (const range of ranges(size, next)) {
        for (const method of ["GET", "HEAD"]) {
          const expected = await answer(await previewResponse(item.file, new Request("botling-chat://chat/attachment/x", { method, headers: range ? { range } : {} }), { type: "video/mp4", follow: false, csp: CHAT_MEDIA_CSP }));
          statuses.add(expected.status);
          const response = await get(item.url, range ?? undefined, method);
          expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
          expect(await answer(response), `size ${size}, ${method} ${range ?? "(no range)"}`).toEqual(expected);
          compared++;
        }
      }
    }
    expect([...statuses].sort()).toEqual([200, 206, 416]);
    expect(compared).toBeGreaterThan(sizes.length * 60);
    expect(w.peer.counts.corrupt).toBe(0);
    expect(w.peer.counts.chunksVerified).toBeGreaterThan(0);
    expect(w.owner.counts.refused).toBe(0);
  }, 120_000);

  it("M3 step 12: A's answer for B's file carries B's size and variants (poster, preview), as B described them", async () => {
    const w = await world();
    const poster = { name: "poster", id: `sha256:${"a".repeat(64)}`, type: "image/jpeg", size: 2_000 };
    const preview = { name: "preview", id: `sha256:${"b".repeat(64)}`, type: "video/mp4", size: 40_000, bitrate: 600_000 };
    const real = w.serviceB.describe.bind(w.serviceB);
    w.serviceB.describe = (id: string) => { const found = real(id); return found ? { size: found.size, variants: [poster, preview] as never } : null; };
    const file = join(scratch, "v1.mp4");
    writeFileSync(file, bytes("v1", 123_456));
    await w.post("v1", file);
    const found = await w.locate("v1", file);
    expect(found.ref).toMatchObject({ owner: w.bId, state: "ready", size: 123_456 });
    expect(found.variants).toEqual([poster, preview]);
    // B unreachable: the reference and what B said last.
    await w.peer.flushed();
    w.setOffline(true);
    const again = await w.locate("v1", file);
    expect(again.ref).toMatchObject({ owner: w.bId, size: 123_456 });
    expect(again.variants).toEqual([poster, preview]);
  });

  it("a second read of the same range is served from A's cache with no peer traffic", async () => {
    const w = await world();
    const item = await located(w, "c1", 3 * MiB + 7);
    const first = await get(item.url, "bytes=0-");
    expect(Buffer.from(await first.arrayBuffer()).equals(item.data)).toBe(true);
    await w.peer.flushed();
    expect(w.cache.kept({ owner: w.bId, id: item.ref.id, variant: "original" })).toEqual([0, 1, 2, 3]);
    w.link.reset();
    for (const range of ["bytes=0-", `bytes=${MiB + 5}-${2 * MiB + 9}`, "bytes=-100", undefined]) {
      const again = await get(item.url, range);
      expect([200, 206]).toContain(again.status);
      await again.arrayBuffer();
    }
    expect(w.link.frames).toEqual({ up: 0, down: 0 });
    expect(w.peer.counts.servedFromCache).toBeGreaterThan(0);
  });

  it("a chunk B corrupts is refused: never cached, never served (502 on every try), and reported", async () => {
    const w = await world();
    const file = join(scratch, "bad.mp4");
    const data = bytes("bad", 2 * MiB + 3);
    writeFileSync(file, data);
    await w.post("bad", file);
    const found = await w.locate("bad", file);
    (w as unknown as { corrupt: { id: string | null } }).corrupt.id = found.ref!.id;
    const url = w.url(found.ref!, found.ticket!);
    for (const range of [undefined, "bytes=0-", `bytes=${MiB}-`, "bytes=-10"]) {
      const response = await get(url, range);
      expect(response.status, range).toBe(502);
      expect(response.headers.get("x-botling-content")).toBe("refused; reason=chunk-hash");
      expect(Buffer.from(await response.arrayBuffer()).includes(data.subarray(0, 64))).toBe(false);
    }
    await w.peer.flushed();
    expect(w.cache.kept({ owner: w.bId, id: found.ref!.id, variant: "original" })).toEqual([]);
    expect(w.peer.counts.corrupt).toBeGreaterThanOrEqual(4);
    // B stops corrupting: the same URL serves the right bytes.
    (w as unknown as { corrupt: { id: string | null } }).corrupt.id = null;
    const fixed = await get(url, "bytes=0-");
    expect(Buffer.from(await fixed.arrayBuffer()).equals(data)).toBe(true);
  });

  it("a file above 1/4 of the budget streams through: right bytes, nothing kept; a smaller one is kept", async () => {
    const w = await world({ capBytes: 16 * MiB });
    const big = await located(w, "big", 6 * MiB + 11);
    const small = await located(w, "small", 2 * MiB);
    const gets = w.peer.counts.gets;
    const response = await get(big.url, "bytes=0-");
    expect(Buffer.from(await response.arrayBuffer()).equals(big.data)).toBe(true);
    // One get for chunk 0 (with the meta) and one read-ahead for the rest: chunks that came before the player pulled
    // them waited for it, nothing was cancelled and asked again.
    expect(w.peer.counts.gets - gets).toBe(2);
    expect(w.peer.counts.cancels).toBe(0);
    const part = await get(big.url, `bytes=${3 * MiB - 2}-${5 * MiB}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(big.data.subarray(3 * MiB - 2, 5 * MiB + 1))).toBe(true);
    await (await get(small.url, "bytes=0-")).arrayBuffer();
    await w.peer.flushed();
    expect(w.cache.kept({ owner: w.bId, id: big.ref.id, variant: "original" })).toEqual([]);
    expect(w.cache.kept({ owner: w.bId, id: small.ref.id, variant: "original" })).toEqual([0, 1]);
  });

  it("refused at both servers: an entry that does not reference the id, an unreadable stream, a device revoked on A or on B", async () => {
    const w = await world();
    const a = await located(w, "ra", MiB + 1);
    const b = await located(w, "rb", 2 * MiB);
    const status = async (id: string, entry: EntryRef) => {
      const { ticket } = w.tickets.issue({ deviceId: DEVICE, owner: w.bId, id, entry });
      const r = await get(w.origin + contentUrlPath({ owner: w.bId, id, variant: "original", entry, ticket }));
      await r.arrayBuffer();
      return `${r.status} ${r.headers.get("x-botling-content") ?? "ok"}`;
    };
    // a's id with b's entry: A has no confirmation, asks B, B refuses (its content_refs).
    const refusedAtB = w.owner.counts.refused;
    expect(await status(a.ref.id, b.ref.entry)).toBe("404 gone; reason=denied");
    expect(w.owner.counts.refused).toBe(refusedAtB + 1);
    expect(await w.remote.ticket(DEVICE, { t: "content.ticket", req: "k", owner: w.bId, id: a.ref.id, entry: b.ref.entry })).toMatchObject({ t: "content.gone", reason: "denied" });
    // An entry of a stream A does not place on B: refused at A without asking B.
    w.link.reset();
    expect(await status(a.ref.id, { stream: "bot:zz" as StreamId, seq: a.ref.entry.seq })).toBe("404 gone; reason=denied");
    expect(w.link.frames.up).toBe(0);
    // Device revoked on A: refused at A (the ticket check), nothing asked of B.
    w.rosterA.state.scope = null;
    expect((await get(a.url)).status).toBe(403);
    expect(await w.remote.locate(DEVICE, { t: "content.locate", req: "k", botId: BOT, line: "ra", url: pathToFileURL(a.file).href })).toEqual({ t: "content.located", req: "k", ref: null });
    expect(w.link.frames.up).toBe(0);
    w.rosterA.state.scope = ["read"];
    // Device revoked on B only (A does not know yet): B answers no reference, and refuses the get of a file A has not cached.
    const c = await located(w, "rc", MiB + 2);
    w.rosterB.state.scope = null;
    expect((await w.locate("rc", c.file)).ref).toBeNull();
    const before = w.owner.counts.refused;
    const refusedAtB2 = await get(w.url(c.ref, (await w.remote.ticket(DEVICE, { t: "content.ticket", req: "k", owner: w.bId, id: c.ref.id, entry: c.ref.entry }) as { ticket?: string }).ticket ?? w.tickets.issue({ deviceId: DEVICE, owner: w.bId, id: c.ref.id, entry: c.ref.entry }).ticket), `bytes=${MiB}-`);
    await refusedAtB2.arrayBuffer();
    expect(refusedAtB2.status).toBe(404);
    expect(w.owner.counts.refused).toBeGreaterThan(before);
    w.rosterB.state.scope = ["read"];
    // The stream becomes unreadable on B (gone): B refuses the get of an uncached range.
    const d = await located(w, "rd", 2 * MiB + 1);
    await w.storeB.submit((db) => { db.prepare("UPDATE streams SET state = 'gone' WHERE stream = ?").run(STREAM); });
    const gone = await get(d.url, `bytes=${MiB}-`);
    await gone.arrayBuffer();
    expect(gone.status).toBe(404);
    expect(await w.locate("rd", d.file)).toMatchObject({ ref: null });
  });

  it("a revocation mid-file stops the stream, on A and on B (chunks in flight dropped)", async () => {
    for (const side of ["A", "B"] as const) {
      const w = await world({ capBytes: 16 * MiB });
      const item = await located(w, `mid${side}`, 10 * MiB);
      const response = await get(item.url, "bytes=0-");
      expect(response.status).toBe(206);
      const reader = response.body!.getReader();
      let got = 0;
      const first = await reader.read();
      got += first.value?.length ?? 0;
      if (side === "A") { w.rosterA.state.scope = null; w.peer.dropDevice(DEVICE); } else w.rosterB.state.scope = null;
      let failed = false;
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; }
      } catch { failed = true; }
      expect(failed, `revoked on ${side}`).toBe(true);
      expect(got).toBeLessThan(10 * MiB);
      if (side === "B") expect(w.owner.counts.refused).toBeGreaterThan(0);
    }
  });

  it("a seek (the player drops the response) cancels the request at B", async () => {
    const w = await world({ capBytes: 16 * MiB });
    const item = await located(w, "seek", 12 * MiB);
    const response = await get(item.url, "bytes=0-");
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(w.owner.counts.cancelled).toBeGreaterThanOrEqual(1);
    expect(w.owner.counts.bytesSent).toBeLessThan(12 * MiB);
    // The seek target is read from there, not from the start.
    w.link.reset();
    const at = 9 * MiB + 5;
    const seeked = await get(item.url, `bytes=${at}-`);
    expect(Buffer.from(await seeked.arrayBuffer()).equals(item.data.subarray(at))).toBe(true);
    expect(w.link.bytes.down).toBeLessThan(4 * MiB);
  });

  it("B unreachable: cached ranges still play; uncached ones answer 503 offline", async () => {
    const w = await world();
    const cached = await located(w, "o1", 3 * MiB + 1);
    const partial = await located(w, "o2", 3 * MiB);
    const never = await located(w, "o3", MiB);
    await (await get(cached.url, "bytes=0-")).arrayBuffer();
    await (await get(partial.url, "bytes=0-100")).arrayBuffer();
    await w.peer.flushed();
    w.setOffline(true);
    const whole = await get(cached.url);
    expect(whole.status).toBe(200);
    expect(Buffer.from(await whole.arrayBuffer()).equals(cached.data)).toBe(true);
    const head = await get(partial.url, "bytes=0-100");
    expect(head.status).toBe(206);
    expect(Buffer.from(await head.arrayBuffer()).equals(partial.data.subarray(0, 101))).toBe(true);
    const missing = await get(partial.url, `bytes=${2 * MiB}-`);
    await missing.arrayBuffer();
    expect(`${missing.status} ${missing.headers.get("x-botling-content")}`).toBe("503 gone; reason=offline");
    const unknown = await get(never.url);
    await unknown.arrayBuffer();
    expect(unknown.status).toBe(503);
    // The line is still found (the owner's last answer), with a ticket.
    const again = await w.locate("o1", cached.file);
    expect(again.ref).toEqual(cached.ref);
    expect(again.ticket).toBe(cached.ticket);
    w.setOffline(false);
    const back = await get(partial.url, `bytes=${2 * MiB}-`);
    expect(Buffer.from(await back.arrayBuffer()).equals(partial.data.subarray(2 * MiB))).toBe(true);
  });
});

describe("M3 step 10: one peer cache budget (Q5)", () => {
  it("chunks and peers' logs share one cap: idle chunks go first, then idle logs, followed last", async () => {
    const store = await openServerStore(join(scratch, "A"));
    const reader = store.openReader();
    const budget = new PeerCacheBudget(6 * MiB);
    const followed = new Set<string>(["bot:f"]);
    const cache = new ChunkCache({ store, reader: () => reader, dataDir: join(scratch, "A"), budget, priority: (_key, stream) => (stream && followed.has(stream) ? 2 : 0) });
    const logs = new PeerLogCache({ store, reader: () => reader, budget, priority: () => 0 });
    cleanups.push(async () => { await cache.flushed(); await logs.idle(); reader.close(); await store.close(); });
    expect(logs.capBytes).toBe(6 * MiB);
    // A stand-in log source next to the real ones, with a followed and an idle stream.
    const fake = { items: [{ priority: 2, usedAt: 1, bytes: 2 * MiB, gone: false }, { priority: 0, usedAt: 5, bytes: 2 * MiB, gone: false }] };
    const source: BudgetSource = {
      name: "fake-logs",
      bytes: () => fake.items.filter((item) => !item.gone).reduce((sum, item) => sum + item.bytes, 0),
      items: () => fake.items.filter((item) => !item.gone).map((item) => ({ ...item, evict: () => { item.gone = true; } })),
    };
    budget.register(source);
    const key = (id: string) => ({ owner: "peerb", id: `sha256:${id.repeat(64)}`, variant: "original" });
    const chunk = (seed: string) => bytes(seed, MiB);
    cache.put(key("f"), 0, chunk("f0"), "bot:f");
    expect(budget.totalBytes).toBe(5 * MiB);
    cache.put(key("a"), 0, chunk("a0"), "bot:x");
    expect(budget.totalBytes).toBe(6 * MiB);
    // Over the cap: the idle chunk (oldest of priority 0) goes before the idle log... both priority 0: LRU decides.
    await new Promise((resolve) => setTimeout(resolve, 5));
    cache.put(key("b"), 0, chunk("b0"), "bot:x");
    expect(budget.totalBytes).toBeLessThanOrEqual(6 * MiB);
    expect(fake.items[1]!.gone).toBe(true); // usedAt 5: older than any chunk
    expect(fake.items[0]!.gone).toBe(false); // followed: last
    cache.put(key("c"), 0, chunk("c0"), "bot:x");
    cache.put(key("d"), 0, chunk("d0"), "bot:x");
    expect(budget.totalBytes).toBeLessThanOrEqual(6 * MiB);
    expect(cache.has(key("f"), 0)).toBe(true); // a followed bot's chunk stays
    expect(cache.has(key("a"), 0)).toBe(false); // the oldest idle chunk went
    expect(fake.items[0]!.gone).toBe(false);
    expect(budget.evicted.chunks).toBeGreaterThanOrEqual(1);
    // A chunk whose file changed on disk is a miss, never other bytes.
    const kept = key("d");
    expect(cache.get(kept, 0, createHash("sha256").update(chunk("d0")).digest())).not.toBeNull();
    expect(cache.get(kept, 0, createHash("sha256").update(chunk("other")).digest())).toBeNull();
    expect(cache.has(kept, 0)).toBe(false);
  });
});
