// M4-01a (protocol v1 §9A.4 desktop row, §9A.3, §9A.7, D69 / Q-C1): the local server reads a peer's file
// through `PeerContent` (`LOCAL_WINDOW = null`, no `device` on the peer wire) and pumps verified bytes as `content.meta`
// + 64 KiB `content.chunk` frames with 4 MiB credit flow control.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_CHUNK_BYTES, decodeFrame, encodeFrame, FRAME_LIMIT, FrameSplitter, packFrame, type DeviceScope, type EntryRef, type Message, type MessageOf, type StreamId, type WireMessage } from "../../src/protocol";
import { decodeWireFrame, encodeChunkFrame, encodeWireFrame } from "../../src/protocol/frame";
import { ContentService, type LineLike } from "../../src/server/content";
import { ChunkCache, PeerCacheBudget } from "../../src/server/content/chunk-cache";
import { LocalPeerReads, type LocalPeerReadSink } from "../../src/server/content/local-peer-read";
import { LOCAL_WINDOW, PEER_CONTENT_FRAME, PEER_CONTENT_WINDOW, PeerContent, PeerContentOwner } from "../../src/server/content/peer-content";
import { ensureStream } from "../../src/server/log";
import type { PeerSession } from "../../src/server/peer";
import { Session, type SessionHost } from "../../src/server/session/session";
import { MAX_BUFFERED } from "../../src/server/session/session-core";
import { openServerStore, type ServerStore } from "../../src/server/store";

const MiB = CONTENT_CHUNK_BYTES;
const PEER = { local: false } as const;
const DEVICE = "abcdefghijklmnopqrstuvwxyz";
const BOT = "b1";
const STREAM = `bot:${BOT}` as StreamId;
const OTHER_STREAM = "bot:b2" as StreamId;

function makeBytes(seed: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  let x = createHash("sha256").update(seed).digest();
  for (let at = 0; at < size; at += 32) { x.copy(out, at); x = createHash("sha256").update(x).digest(); }
  return out;
}

function roster(scope: DeviceScope[] | null = ["read", "reply"]) {
  const state = { scope };
  return { state, device: (member: string) => (member === DEVICE && state.scope ? { keys: { sign: "s", dh: "d" }, scope: state.scope } : null) };
}

/** Two ends of a FIFO peer session through the real wire encoder; records raw JSON frames sent A -> B. */
class Link {
  open = true;
  readonly upRaw: Array<Record<string, unknown>> = [];
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
        if (dir === "up") link.upRaw.push(JSON.parse(encoded.text) as Record<string, unknown>);
        link.push(encoded.text, deliver);
        return true;
      },
      sendChunk: (message: MessageOf<"content.chunk">) => {
        if (!link.open) return false;
        const encoded = encodeChunkFrame(message, "peer", PEER);
        if (!encoded.ok) throw new Error(encoded.detail);
        link.push(encoded.bytes, deliver);
        return true;
      },
    }) as unknown as PeerSession;
    const link = this;
    this.a = end(bId, "up", () => (m) => onB(this.b, m));
    this.b = end(aId, "down", () => (m) => onA(this.a, m));
  }
  private push(frame: string | Uint8Array, deliver: () => (m: WireMessage) => void): void {
    this.queue.push(() => {
      if (!this.open) return;
      const decoded = decodeWireFrame(frame, "peer", PEER);
      if (!decoded.ok) throw new Error(`bad frame: ${decoded.detail}`);
      deliver()(decoded.message);
    });
    if (!this.flushing) { this.flushing = true; setImmediate(() => this.flush()); }
  }
  private flush(): void {
    for (let i = 0; i < 8 && this.queue.length; i++) this.queue.shift()!();
    if (this.queue.length) setImmediate(() => this.flush()); else this.flushing = false;
  }
  reset(): void { this.upRaw.length = 0; }
}

/** Recording sink for `LocalPeerReads`. */
class RecordingSink implements LocalPeerReadSink {
  readonly messages: Message[] = [];
  readonly chunks: Array<MessageOf<"content.chunk">> = [];
  private waiters: Array<() => void> = [];
  open = true;

  send(message: Message): boolean {
    if (!this.open) return false;
    this.messages.push(message);
    this.notify();
    return true;
  }

  chunk(message: MessageOf<"content.chunk">): boolean {
    if (!this.open) return false;
    this.chunks.push({ t: "content.chunk", req: message.req, offset: message.offset, bytes: Buffer.from(message.bytes) });
    this.notify();
    return true;
  }

  private notify(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  bytesReceived(): Buffer {
    return Buffer.concat(this.chunks.map((c) => c.bytes));
  }

  totalChunkBytes(): number {
    return this.chunks.reduce((sum, c) => sum + c.bytes.length, 0);
  }

  async waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    if (predicate()) return;
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("timed out waiting for sink condition");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(left, 50));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }
}

let scratch: string;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "botling-local-peer-read-")); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

interface World {
  storeA: ServerStore;
  storeB: ServerStore;
  serviceB: ContentService;
  owner: PeerContentOwner;
  peer: PeerContent;
  cache: ChunkCache;
  reads: LocalPeerReads;
  link: Link;
  aId: string;
  bId: string;
  corrupt: { id: string | null };
  post(line: string, file: string, stream?: StreamId, bot?: string): Promise<void>;
  locate(line: string, file: string, bot?: string): Promise<NonNullable<MessageOf<"content.found">["ref"]> | null>;
  setOffline(offline: boolean): void;
}

async function world(options: { capBytes?: number } = {}): Promise<World> {
  const storeB = await openServerStore(join(scratch, "B"));
  const storeA = await openServerStore(join(scratch, "A"));
  const bId = storeB.meta("serverId")!;
  const aId = storeA.meta("serverId")!;
  await storeB.submit((db) => { ensureStream(db, STREAM); ensureStream(db, OTHER_STREAM); });
  const serviceB = new ContentService({ store: storeB, dataDir: join(scratch, "B"), serverId: bId });
  const rosterA = roster();
  const rosterB = roster();
  const corrupt = { id: null as string | null };
  const owner = new PeerContentOwner({ service: serviceB, roster: rosterB });
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
  const reads = new LocalPeerReads({ peer, self: aId });
  cleanups.push(async () => {
    reads.close();
    peer.close();
    await peer.flushed();
    readerA.close();
    await serviceB.close();
    await storeA.close();
    await storeB.close();
  });
  return {
    storeA, storeB, serviceB, owner, peer, cache, reads, link, aId, bId, corrupt,
    async post(line, file, stream = STREAM, bot = BOT) {
      const l: LineLike = { id: line, text: `![f](${pathToFileURL(file).href})` };
      const message = { id: line, role: "bot", text: l.text, time: "2026-11-15T00:00:00.000Z", state: "done" };
      const { ready } = await serviceB.appendLine(stream, bot, l, [{ kind: "message.added", body: { botId: bot, message } }]);
      await ready;
    },
    locate: (line, file, bot = BOT) => peer.locate(LOCAL_WINDOW, { t: "content.locate", req: "l1", botId: bot, line, url: pathToFileURL(file).href }),
    setOffline(value) {
      offline = value;
      link.open = !value;
      if (value) { peer.sessionClosed(link.a); owner.sessionClosed(link.b); }
    },
  };
}

async function posted(w: World, line: string, size: number, ext = "mp4") {
  const file = join(scratch, `${line}.${ext}`);
  const data = makeBytes(line, size);
  writeFileSync(file, data);
  await w.post(line, file);
  const ref = await w.locate(line, file);
  if (!ref) throw new Error(`no reference for ${line}`);
  return { file, data, ref };
}

const sessionKey = {};

describe("M4-01a: LocalPeerReads (local socket reads a peer's file)", () => {
  it("1. a get of [0, 100) of B's file sends content.meta{size, type} then chunks matching the first 100 bytes with exact offsets", async () => {
    const w = await world();
    const item = await posted(w, "small", 1_024, "mp4");
    const sink = new RecordingSink();
    await w.reads.get(sessionKey, {
      t: "content.get", req: "r1", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: 0, length: 100, entry: item.ref.entry,
    }, sink);

    expect(sink.messages).toEqual([
      { t: "content.meta", req: "r1", id: item.ref.id, size: 1_024, type: "video/mp4", chunkSize: CONTENT_CHUNK_BYTES, variants: [] },
    ]);
    expect(sink.chunks.length).toBeGreaterThan(0);
    expect(sink.chunks.map((c) => c.offset)).toEqual([0]);
    expect(Buffer.from(sink.bytesReceived()).equals(item.data.subarray(0, 100))).toBe(true);
  });

  it("2a. a get of a whole 3 MiB file completes in order with each frame <= 64 KiB", async () => {
    const w = await world();
    const size = 3 * MiB;
    const item = await posted(w, "three", size);
    const sink = new RecordingSink();
    await w.reads.get(sessionKey, {
      t: "content.get", req: "r2a", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: 0, length: size, entry: item.ref.entry,
    }, sink);

    expect(sink.messages).toHaveLength(1);
    expect(sink.messages[0]).toMatchObject({ t: "content.meta", req: "r2a", size, type: "video/mp4" });
    let expectedOffset = 0;
    for (const chunk of sink.chunks) {
      expect(chunk.bytes.length).toBeLessThanOrEqual(PEER_CONTENT_FRAME);
      expect(chunk.offset).toBe(expectedOffset);
      expectedOffset += chunk.bytes.length;
    }
    expect(expectedOffset).toBe(size);
    expect(Buffer.from(sink.bytesReceived()).equals(item.data)).toBe(true);
  });

  it("2b. credit bounds output to 4 MiB without credit, and delivers all remaining bytes once credit is given", async () => {
    const w = await world();
    const size = 5 * MiB + 123;
    const item = await posted(w, "five", size);
    const sink = new RecordingSink();
    const done = w.reads.get(sessionKey, {
      t: "content.get", req: "r2b", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: 0, length: size, entry: item.ref.entry,
    }, sink);

    await sink.waitUntil(() => sink.totalChunkBytes() === PEER_CONTENT_WINDOW);
    // Wait a couple ticks to confirm nothing past the 4 MiB window is sent without credit.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sink.totalChunkBytes()).toBe(PEER_CONTENT_WINDOW);

    w.reads.credit(sessionKey, { t: "content.credit", req: "r2b", bytes: 2 * MiB });
    await done;

    expect(sink.messages).toHaveLength(1);
    let expectedOffset = 0;
    for (const chunk of sink.chunks) {
      expect(chunk.bytes.length).toBeLessThanOrEqual(PEER_CONTENT_FRAME);
      expect(chunk.offset).toBe(expectedOffset);
      expectedOffset += chunk.bytes.length;
    }
    expect(expectedOffset).toBe(size);
    expect(Buffer.from(sink.bytesReceived()).equals(item.data)).toBe(true);
  });

  it("3. D69: LOCAL_WINDOW sends content.locate and content.get without `device`; a remote member read still carries `device`", async () => {
    const w = await world();
    const item = await posted(w, "wirecheck", 512);
    const sink = new RecordingSink();
    await w.reads.get(sessionKey, {
      t: "content.get", req: "r3", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: 0, length: 512, entry: item.ref.entry,
    }, sink);

    const localFrames = w.link.upRaw.filter((m) => m.t === "content.locate" || m.t === "content.get");
    expect(localFrames.length).toBeGreaterThanOrEqual(2);
    for (const frame of localFrames) {
      expect(Object.hasOwn(frame, "device")).toBe(false);
    }

    w.link.reset();
    const file2 = join(scratch, "remote.mp4");
    writeFileSync(file2, makeBytes("remote", 512));
    await w.post("remote1", file2);
    const remoteRef = await w.peer.locate(DEVICE, { t: "content.locate", req: "lr", botId: BOT, line: "remote1", url: pathToFileURL(file2).href });
    expect(remoteRef).not.toBeNull();
    const res = await w.peer.respond({ owner: remoteRef!.owner, id: remoteRef!.id, variant: "original", entry: remoteRef!.entry }, new Request("http://local/"), DEVICE);
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    const remoteFrames = w.link.upRaw.filter((m) => m.t === "content.locate" || m.t === "content.get");
    expect(remoteFrames.length).toBeGreaterThanOrEqual(2);
    for (const frame of remoteFrames) {
      expect(frame.device).toBe(DEVICE);
    }
  });

  it("4. an entry that does not reference the id -> content.gone{denied} and zero chunks", async () => {
    const w = await world();
    const item = await posted(w, "real", 512);
    const otherFile = join(scratch, "other.mp4");
    writeFileSync(otherFile, makeBytes("other", 512));
    await w.post("other", otherFile, OTHER_STREAM, "b2");
    const otherRef = await w.peer.locate(LOCAL_WINDOW, { t: "content.locate", req: "lo", botId: "b2", line: "other", url: pathToFileURL(otherFile).href });
    expect(otherRef).not.toBeNull();

    const sink = new RecordingSink();
    await w.reads.get(sessionKey, {
      t: "content.get", req: "r4", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: 0, length: 512, entry: otherRef!.entry,
    }, sink);

    expect(sink.messages).toEqual([{ t: "content.gone", req: "r4", id: item.ref.id, reason: "denied" }]);
    expect(sink.chunks).toEqual([]);
  });

  it("5. B corrupts a chunk -> content.gone{offline} and zero bytes of the corrupted MiB are sent", async () => {
    const w = await world();
    const item = await posted(w, "corrupt0", MiB + 100);
    w.corrupt.id = item.ref.id;
    const sink = new RecordingSink();
    await w.reads.get(sessionKey, {
      t: "content.get", req: "r5a", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: 0, length: MiB + 100, entry: item.ref.entry,
    }, sink);

    expect(sink.messages).toEqual([{ t: "content.gone", req: "r5a", id: item.ref.id, reason: "offline" }]);
    expect(sink.chunks).toEqual([]);

    // Also verify mid-stream corruption on chunk 1 after chunk 0 was verified cleanly.
    w.corrupt.id = null;
    const item2 = await posted(w, "corrupt1", 2 * MiB);
    const first = new RecordingSink();
    await w.reads.get(sessionKey, {
      t: "content.get", req: "r5b0", owner: item2.ref.owner, id: item2.ref.id, variant: "original",
      offset: 0, length: 64, entry: item2.ref.entry,
    }, first);
    expect(first.totalChunkBytes()).toBe(64);
    await w.peer.flushed();

    w.corrupt.id = item2.ref.id;
    const sink2 = new RecordingSink();
    await w.reads.get(sessionKey, {
      t: "content.get", req: "r5b1", owner: item2.ref.owner, id: item2.ref.id, variant: "original",
      offset: 0, length: 2 * MiB, entry: item2.ref.entry,
    }, sink2);

    expect(sink2.totalChunkBytes()).toBe(MiB);
    expect(Buffer.from(sink2.bytesReceived()).equals(item2.data.subarray(0, MiB))).toBe(true);
    expect(sink2.messages.at(-1)).toEqual({ t: "content.gone", req: "r5b1", id: item2.ref.id, reason: "offline" });
  });

  it("6. peer session drops mid-file -> content.gone{offline} after bytes already sent, none after", async () => {
    const w = await world();
    const size = 6 * MiB;
    const item = await posted(w, "drop", size);
    const sink = new RecordingSink();
    const done = w.reads.get(sessionKey, {
      t: "content.get", req: "r6", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: 0, length: size, entry: item.ref.entry,
    }, sink);

    // Wait until chunk 0 is verified and sent, then drop the peer session before chunk 1+ finishes.
    await sink.waitUntil(() => sink.totalChunkBytes() >= MiB);
    w.setOffline(true);
    await done;

    const sent = sink.totalChunkBytes();
    expect(sent).toBeGreaterThanOrEqual(MiB);
    expect(sent).toBeLessThan(size);
    expect(Buffer.from(sink.bytesReceived()).equals(item.data.subarray(0, sent))).toBe(true);
    expect(sink.messages.at(-1)).toEqual({ t: "content.gone", req: "r6", id: item.ref.id, reason: "offline" });
  });

  it("7. cancel mid-file -> B sees content.cancel (counts.cancelled rises) and no more chunks are sent", async () => {
    const w = await world();
    const size = 8 * MiB;
    const item = await posted(w, "cancel", size);
    const sink = new RecordingSink();
    const beforeCancelled = w.owner.counts.cancelled;
    const done = w.reads.get(sessionKey, {
      t: "content.get", req: "r7", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: 0, length: size, entry: item.ref.entry,
    }, sink);

    await sink.waitUntil(() => sink.totalChunkBytes() >= MiB);
    w.reads.cancel(sessionKey, { t: "content.cancel", req: "r7" });
    await done;
    const countAfterCancel = sink.chunks.length;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(w.owner.counts.cancelled).toBeGreaterThan(beforeCancelled);
    expect(sink.chunks.length).toBe(countAfterCancel);
    expect(sink.totalChunkBytes()).toBeLessThan(size);
    expect(sink.messages.some((m) => m.t === "content.gone")).toBe(false);
  });

  it("8. m.owner === self -> content.gone{denied} without touching peer", async () => {
    const w = await world();
    const respondSpy = vi.spyOn(w.peer, "respond");
    w.link.reset();
    const sink = new RecordingSink();
    await w.reads.get(sessionKey, {
      t: "content.get", req: "r8", owner: w.aId, id: `sha256:${"a".repeat(64)}`, variant: "original",
      offset: 0, length: 100, entry: { stream: STREAM, seq: 1 },
    }, sink);

    expect(sink.messages).toEqual([{ t: "content.gone", req: "r8", id: `sha256:${"a".repeat(64)}`, reason: "denied" }]);
    expect(sink.chunks).toEqual([]);
    expect(respondSpy).not.toHaveBeenCalled();
    expect(w.link.upRaw).toEqual([]);
  });

  it("9. offset >= size -> content.meta and zero chunks", async () => {
    const w = await world();
    const size = 256;
    const item = await posted(w, "pastend", size);
    const sink = new RecordingSink();
    await w.reads.get(sessionKey, {
      t: "content.get", req: "r9", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: size, length: 100, entry: item.ref.entry,
    }, sink);

    expect(sink.messages).toEqual([
      { t: "content.meta", req: "r9", id: item.ref.id, size, type: "video/mp4", chunkSize: CONTENT_CHUNK_BYTES, variants: [] },
    ]);
    expect(sink.chunks).toEqual([]);
  });

  it("10. closeSession cancels every open read of that session, enforces at most 32 open reads per session, and caps total unreturned credit below MAX_BUFFERED", async () => {
    const w = await world();
    const size = 8 * MiB;
    const item = await posted(w, "limit", size);
    const sessionA = { id: "A" };
    const beforeCancelled = w.owner.counts.cancelled;

    // Open 32 reads concurrently without returning credit; all 32 open (meta sent), bounded by the shared session budget.
    const sinks: RecordingSink[] = [];
    const pending: Array<Promise<void>> = [];
    for (let i = 0; i < 32; i++) {
      const s = new RecordingSink();
      sinks.push(s);
      pending.push(w.reads.get(sessionA, {
        t: "content.get", req: `lim-${i}`, owner: item.ref.owner, id: item.ref.id, variant: "original",
        offset: 0, length: size, entry: item.ref.entry,
      }, s));
    }
    await Promise.all(sinks.map((s) => s.waitUntil(() => s.messages.some((m) => m.t === "content.meta"))));
    const totalUnreturned = () => sinks.reduce((sum, s) => sum + s.totalChunkBytes(), 0);
    await sinks[0].waitUntil(() => totalUnreturned() >= 16 * MiB);
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(totalUnreturned()).toBeLessThan(MAX_BUFFERED);
    expect(totalUnreturned()).toBe(16 * MiB);
    for (const s of sinks) expect(s.totalChunkBytes()).toBeLessThanOrEqual(PEER_CONTENT_WINDOW);

    // 33rd read on the same session is refused with content.gone{offline}.
    const extraSink = new RecordingSink();
    await w.reads.get(sessionA, {
      t: "content.get", req: "lim-32", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: 0, length: size, entry: item.ref.entry,
    }, extraSink);
    expect(extraSink.messages).toEqual([{ t: "content.gone", req: "lim-32", id: item.ref.id, reason: "offline" }]);

    w.reads.closeSession(sessionA);
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(w.owner.counts.cancelled).toBeGreaterThan(beforeCancelled);
    expect(totalUnreturned()).toBe(16 * MiB);
  });

  it("11. L1: 10 concurrent reads on a Session share one credit budget < MAX_BUFFERED so a stalled socket does not drop the session", async () => {
    const w = await world();
    const size = 6 * MiB;
    const item = await posted(w, "gallery", size);
    const LOCAL = { local: true } as const;
    const TOKEN = "t".repeat(32);
    const EPOCH = "0123456789abcdef0123456789abcdef";

    class BufferedFakeSocket extends EventEmitter {
      destroyed = false;
      writableLength = 0;
      readonly writes: Uint8Array[] = [];
      write(bytes: Uint8Array): boolean {
        this.writes.push(bytes);
        this.writableLength += bytes.length;
        return true;
      }
      end(): void {}
      destroy(): void { this.destroyed = true; }
      frames(): Message[] {
        const splitter = new FrameSplitter();
        const out: Message[] = [];
        for (const chunk of this.writes) {
          const split = splitter.push(chunk);
          if (!split.ok) throw new Error(split.detail);
          for (const frame of split.frames) {
            expect(frame.length).toBeLessThanOrEqual(FRAME_LIMIT);
            const decoded = decodeFrame(frame, "server", LOCAL);
            if (!decoded.ok) throw new Error(decoded.detail);
            out.push(decoded.message);
          }
        }
        return out;
      }
      feed(message: Message): void {
        const encoded = encodeFrame(message, "fe", LOCAL);
        if (!encoded.ok) throw new Error(encoded.detail);
        this.emit("data", Buffer.from(packFrame(encoded.text)));
      }
    }

    const host = {
      serverId: w.aId, serverName: "Mac", startedAt: 0, minFeVersion: "3.0.0", token: () => TOKEN,
      hub: { attach: () => ({ close() {}, sub: async () => ({ ok: false, reason: "unknown stream" }), ack() {}, history: () => null }), reader: () => null },
      live: { subscribe: () => ({ close() {}, resync() {} }) },
      runtime: {}, engine: { run: async () => null }, content: null,
      shell: { attach() {}, detach() {}, answer() {} },
      nextFor: () => ({}), ensureBotStream: async () => false, log: () => {},
      peerReads: () => w.reads,
    } as unknown as SessionHost;

    const socket = new BufferedFakeSocket();
    const session = new Session(socket as never, host, { helloTimeoutMs: 60_000, pingAfterMs: 60_000, deadAfterMs: 120_000 });
    cleanups.push(() => session.close());
    socket.feed({ t: "hello", deviceId: "desktop", feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [], token: TOKEN } as never);

    const nReads = 10;
    for (let i = 0; i < nReads; i++) {
      socket.feed({
        t: "content.get", req: `gal-${i}`, owner: item.ref.owner, id: item.ref.id, variant: "original",
        offset: 0, length: size, entry: item.ref.entry,
      });
    }

    const chunkBytesByReq = () => {
      const map = new Map<string, Buffer[]>();
      for (const frame of socket.frames()) {
        if (frame.t === "content.chunk") {
          const list = map.get(frame.req) ?? [];
          list.push(Buffer.from(frame.bytes));
          map.set(frame.req, list);
        }
      }
      return map;
    };
    const totalChunkBytes = () => {
      let total = 0;
      for (const list of chunkBytesByReq().values()) for (const b of list) total += b.length;
      return total;
    };

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (!session.isOpen) break;
      const frames = socket.frames();
      const metas = frames.filter((f) => f.t === "content.meta").length;
      if (metas === nReads && totalChunkBytes() >= 16 * MiB) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(session.isOpen).toBe(true);
    expect(socket.destroyed).toBe(false);
    expect(socket.writableLength).toBeLessThan(MAX_BUFFERED);
    expect(totalChunkBytes()).toBeLessThan(MAX_BUFFERED);
    expect(totalChunkBytes()).toBe(16 * MiB);

    // Drain socket and return credit as bytes arrive until all 10 reads finish.
    const credited = new Array<number>(nReads).fill(0);
    const finishDeadline = Date.now() + 10_000;
    while (Date.now() < finishDeadline) {
      socket.writableLength = 0;
      const byReq = chunkBytesByReq();
      let allDone = true;
      for (let i = 0; i < nReads; i++) {
        const got = (byReq.get(`gal-${i}`) ?? []).reduce((s, b) => s + b.length, 0);
        if (got < size) allDone = false;
        const delta = got - credited[i];
        if (delta > 0) {
          credited[i] += delta;
          socket.feed({ t: "content.credit", req: `gal-${i}`, bytes: delta });
        }
      }
      if (allDone) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(session.isOpen).toBe(true);
    const finalByReq = chunkBytesByReq();
    for (let i = 0; i < nReads; i++) {
      const joined = Buffer.concat(finalByReq.get(`gal-${i}`) ?? []);
      expect(joined.equals(item.data)).toBe(true);
    }
  });

  it("12. N1: sink.chunk returning false sends content.gone{offline} and stops the read", async () => {
    const w = await world();
    const item = await posted(w, "chunkfail", 256 * 1024);
    const messages: Message[] = [];
    let chunkCalls = 0;
    const sink: LocalPeerReadSink = {
      send(message) {
        messages.push(message);
        return true;
      },
      chunk() {
        chunkCalls += 1;
        return false;
      },
    };

    await w.reads.get(sessionKey, {
      t: "content.get", req: "r12", owner: item.ref.owner, id: item.ref.id, variant: "original",
      offset: 0, length: 256 * 1024, entry: item.ref.entry,
    }, sink);

    expect(chunkCalls).toBe(1);
    expect(messages).toEqual([
      { t: "content.meta", req: "r12", id: item.ref.id, size: 256 * 1024, type: "video/mp4", chunkSize: CONTENT_CHUNK_BYTES, variants: [] },
      { t: "content.gone", req: "r12", id: item.ref.id, reason: "offline" },
    ]);
  });
});
