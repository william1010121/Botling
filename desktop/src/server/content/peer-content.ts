// Content owned by another server, read through this one (M3 step 10, protocol v1 §9A.4 last row, §9A.6, §9A.7;
// m3-brief §4 row 10, Q5, Q8).
//
// Attached side (`PeerContent`, server A; the page is attached here, the bytes are on peer B):
//   - `content.locate` of a line of B's bot: A asks B (`content.locate{device}` over the peer session). B decides (the
//     device is valid and may read, the stream is readable) and answers the line's reference; A keeps the answer
//     (`peer_content_lines`), so a page can still find it while B is unreachable, and gives the page its own URL ticket.
//   - `/v3/c/<B>/<id>/<variant>?e=…&t=…`: after the ticket checks of remote.ts, A checks that its copy of B's table
//     names the entry's bot as B's, and that B confirmed the entry references the id (`peer_content_refs`, learnt from
//     B's answers). Then it answers the range exactly as M1/M2 do (`rangedResponse`, the same headers), from 1 MiB chunks:
//     each comes from A's chunk cache (checked again against its hash) or from B by `content.get{device}` (B checks the
//     reference and the device again on every get), and each chunk from B is checked against B's chunk hash **before**
//     it is cached or served. A mismatch is refused and reported: never cached, never served (the request fails).
//   - Flow control: B may send 4 MiB per request before any credit; A grants 1 MiB more each time the reader takes a
//     chunk, so the player's own pulls are the back-pressure. When the player seeks or closes, the reader's request to B
//     is cancelled (`content.cancel`).
//   - A file above 1/4 of the peer cache budget streams through: only the chunks in flight are held, nothing is kept.
//   - B unreachable: cached ranges still play; a range whose first chunk is not cached answers 503 (offline), and a
//     range that runs into a missing chunk ends cut (never other bytes).
//   - A device that leaves A's roster or loses `read` stops at its next chunk (`dropDevice` cancels its reads at once).
// Owner side (`PeerContentOwner`, server B): answers a peer's `content.locate` / `content.get` / `content.credit` /
// `content.cancel`; every get is checked like a device's open (`ContentService.open` with `remote`: an entry that
// references the id in a readable stream) plus the named device's validity and `read`, and the device is checked again
// at every chunk sent. Chunk hashes of variants (posters, previews) are made on demand by the hasher and kept in memory.
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import { fileHeaders, rangedResponse } from "../../main/preview-response";
import { CHAT_MEDIA_CSP, goneResponse } from "../../main-v3/content-protocol";
import { CONTENT_CHUNK_BYTES, type ContentUrl, type ContentVariant, type EntryRef, type MessageOf, type WireMessage } from "../../protocol";
import type { DeviceScope } from "../../protocol/scopes";
import type { PeerSession } from "../peer";
import type { Db, ServerStore } from "../store";
import { chunkKeyText, type ChunkCache, type ChunkKey } from "./chunk-cache";
import type { ContentService } from "./service";
import { sameSig, statSig } from "./pin";

const MiB = CONTENT_CHUNK_BYTES;
/** What a sender may send per request before any credit (v1 §9A.4: a 4 MiB window on direct sessions). */
export const PEER_CONTENT_WINDOW = 4 * MiB;
/** Bytes per `content.chunk` frame on a direct session (§9A.4). */
export const PEER_CONTENT_FRAME = 64 * 1024;
/** The owner's answer (located, meta, next chunk) must come within this time, or the read fails as offline. */
export const PEER_CONTENT_TIMEOUT_MS = 15_000;
const HASHES_TEXT_LIMIT = 240_000;
/** How many owner descriptions (size, variants) of peer files are kept in memory (M3 step 12). */
const DESCRIBED_KEPT = 2_000;

export type GoneReason = MessageOf<"content.gone">["reason"];
/** Why a read through a peer failed. */
export type PeerReadFailure = GoneReason | "corrupt" | "cancelled";

export class PeerReadError extends Error {
  constructor(readonly reason: PeerReadFailure, detail: string = reason) { super(detail); this.name = "PeerReadError"; }
}

/** A located reference (as `ContentService.locate` answers). */
export type LocatedRef = NonNullable<MessageOf<"content.found">["ref"]>;

interface Meta { size: number; type: string; hashesText: string; hashes: Buffer; chunks: number }

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** One `content.get` to the owner, for chunks `start…end` of one file. */
interface Upstream {
  req: string;
  owner: string;
  key: ChunkKey;
  entry: EntryRef;
  session: PeerSession;
  start: number;
  end: number;
  next: number;
  parts: Buffer[];
  partBytes: number;
  /** Bytes received so far (chunk frames must come in order, contiguous). */
  received: number;
  chunks: Map<number, Deferred<Buffer>>;
  meta: Deferred<Meta>;
  cacheable: boolean;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Readers still interested (a reader's own request; others only coalesce on its chunks). */
  reader: Reader | null;
  /** Bytes the owner may send in all (the window, then the credits). */
  granted: number;
  /** Bytes this request asks for. */
  length: number;
}

/** One HTTP range being answered. */
interface Reader {
  key: ChunkKey;
  entry: EntryRef;
  deviceId: string;
  start: number;
  end: number;
  pos: number;
  up: Upstream | null;
  closed: boolean;
  /** The first chunk, read before the answer was given (a clean status when it cannot be had). */
  primed: Buffer | null;
  /**
   * Verified chunks of the reader's own request that came before the player pulled them (a file that streams through
   * is not cached, so they wait here). Bounded by the window: the owner sends at most 4 MiB past what was taken.
   */
  ready: Map<number, Buffer>;
  /** Why it was closed by this side (revoked, stopping). */
  failure?: unknown;
}

export interface PeerContentOptions {
  self: string;
  store: Pick<ServerStore, "submit">;
  reader: () => Db;
  cache: ChunkCache;
  /** The live session with `owner`, or null. */
  session(owner: string): PeerSession | null;
  /** The peer that owns a stream (`bot:<id>`) by this server's copy of the peers' tables; null when none. */
  ownerOf(stream: string): string | null;
  /** The device is valid in this server's roster now and has `read`. */
  readable(deviceId: string): boolean;
  /** The bot's stream is followed (its content goes last in the budget). */
  followed?: (stream: string) => boolean;
  log?: (line: string) => void;
  timeoutMs?: number;
}

const refKey = (owner: string, id: string, entry: EntryRef) => `${owner}\n${id}\n${entry.stream}\n${entry.seq}`;

export class PeerContent {
  private readonly metas = new Map<string, Meta>();
  private readonly refs = new Set<string>();
  private readonly described = new Map<string, { size: number; variants: ContentVariant[] }>();
  private readonly locates = new Map<string, { owner: string; done: Deferred<MessageOf<"content.located"> | null>; timer: ReturnType<typeof setTimeout> }>();
  private readonly upstreams = new Map<string, Upstream>();
  /** Chunks on their way from an owner, by file and index (a second reader waits for the same bytes). */
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private readonly readers = new Set<Reader>();
  private writes: Promise<unknown> = Promise.resolve();
  private reqs = 0;
  private closed = false;
  private readonly prefix = Math.random().toString(36).slice(2, 8);
  private readonly log: (line: string) => void;
  /** Counters (tests, status): chunks fetched and verified, refused by hash, served from cache; gets sent; cancels. */
  readonly counts = { gets: 0, chunksVerified: 0, corrupt: 0, cancels: 0, servedFromCache: 0, locates: 0, refusedByOwner: 0, offline: 0 };

  constructor(private readonly options: PeerContentOptions) {
    this.log = options.log ?? (() => undefined);
    this.load();
  }

  private get timeoutMs(): number { return this.options.timeoutMs ?? PEER_CONTENT_TIMEOUT_MS; }
  private newReq(kind: string): string { return `pc${kind}.${this.prefix}.${++this.reqs}`; }

  private load(): void {
    try {
      const db = this.options.reader();
      for (const row of db.prepare("SELECT owner, id, variant, size, type, chunkHashes FROM peer_content").all()) {
        const meta = makeMeta(Number(row.size), String(row.type), String(row.chunkHashes));
        if (meta) this.metas.set(chunkKeyText({ owner: String(row.owner), id: String(row.id), variant: String(row.variant) }), meta);
      }
      for (const row of db.prepare("SELECT owner, id, stream, seq FROM peer_content_refs").all()) {
        this.refs.add(refKey(String(row.owner), String(row.id), { stream: String(row.stream) as EntryRef["stream"], seq: Number(row.seq) }));
      }
    } catch (error) {
      this.log(`peer content: the cache tables were not read: ${String((error as Error)?.message ?? error)}`);
    }
  }

  private write(command: (tx: Db) => void): void {
    this.writes = this.writes.then(() => this.options.store.submit(command)).catch((error) => {
      this.log(`peer content: a write failed: ${String((error as Error)?.message ?? error)}`);
    });
  }

  /** Resolves when every store write queued so far is done (tests). */
  async flushed(): Promise<void> { await this.writes; await this.options.cache.flushed(); }

  /** Priority of a file's chunks in the budget (in use 1, followed 2). */
  priority(key: ChunkKey, stream: string | null): number {
    if (stream && this.options.followed?.(stream)) return 2;
    const text = chunkKeyText(key);
    for (const reader of this.readers) if (chunkKeyText(reader.key) === text) return 1;
    return 0;
  }

  /** The peer that owns bot `botId`, by this server's copy of the peers' tables; null when it is this server's. */
  ownerOfBot(botId: string): string | null { return this.options.ownerOf(`bot:${botId}`); }

  isConfirmed(owner: string, id: string, entry: EntryRef): boolean { return this.refs.has(refKey(owner, id, entry)); }

  private confirm(owner: string, id: string, entry: EntryRef): void {
    const key = refKey(owner, id, entry);
    if (this.refs.has(key)) return;
    this.refs.add(key);
    this.write((tx) => { tx.prepare("INSERT OR IGNORE INTO peer_content_refs (owner, id, stream, seq) VALUES (?, ?, ?, ?)").run(owner, id, entry.stream, entry.seq); });
  }

  /** The owner refused an id for an entry (or it changed / is gone): forget what was confirmed, and its chunks. */
  private forget(owner: string, id: string, entry: EntryRef | null, reason: GoneReason): void {
    if (entry) this.refs.delete(refKey(owner, id, entry));
    else for (const key of [...this.refs]) if (key.startsWith(`${owner}\n${id}\n`)) this.refs.delete(key);
    if (reason === "changed" || reason === "deleted") {
      for (const key of [...this.metas.keys()]) if (key.startsWith(`${owner}\n${id}\n`)) this.metas.delete(key);
      this.options.cache.dropContent(owner, id);
    }
    this.write((tx) => {
      if (entry) tx.prepare("DELETE FROM peer_content_refs WHERE owner = ? AND id = ? AND stream = ? AND seq = ?").run(owner, id, entry.stream, entry.seq);
      else tx.prepare("DELETE FROM peer_content_refs WHERE owner = ? AND id = ?").run(owner, id);
      if (reason === "changed" || reason === "deleted") {
        tx.prepare("DELETE FROM peer_content WHERE owner = ? AND id = ?").run(owner, id);
        tx.prepare("UPDATE peer_content_lines SET state = ? WHERE owner = ? AND id = ?").run(reason === "changed" ? "changed" : "gone", owner, id);
      }
    });
  }

  meta(key: ChunkKey): Meta | null { return this.metas.get(chunkKeyText(key)) ?? null; }

  // -------------------------------------------------------------------------------------------
  // Lookups and tickets (remote.ts)

  /**
   * `content.locate` of a line of a peer's bot: the owner decides (over the peer session); while it is unreachable,
   * the last answer it gave. Null: no such reference, or the owner refused.
   */
  /**
   * M3 step 12: what the owner said of a ready file it holds (size and variants), from its last `content.located`
   * (this process's memory: a page asks again after a restart, and the owner answers again).
   */
  describe(id: string): { size: number; variants: ContentVariant[] } | null { return this.described.get(id) ?? null; }

  private remember(id: string, value: { size: number; variants: ContentVariant[] }): void {
    this.described.delete(id);
    this.described.set(id, value);
    if (this.described.size > DESCRIBED_KEPT) this.described.delete(this.described.keys().next().value!);
  }

  async locate(deviceId: string, message: MessageOf<"content.locate">): Promise<LocatedRef | null> {
    const owner = this.ownerOfBot(message.botId);
    if (!owner) return null;
    const session = this.options.session(owner);
    if (session) {
      const req = this.newReq("l");
      const done = deferred<MessageOf<"content.located"> | null>();
      const timer = setTimeout(() => { this.locates.delete(req); done.resolve(null); }, this.timeoutMs);
      timer.unref?.();
      this.locates.set(req, { owner, done, timer });
      this.counts.locates++;
      if (session.sendWire({ t: "content.locate", req, botId: message.botId, line: message.line, url: message.url, device: deviceId } as WireMessage)) {
        const answer = await done.promise;
        if (answer) {
          const ref = answer.ref && answer.ref.owner === owner && answer.ref.entry.stream === `bot:${message.botId}` ? answer.ref : null;
          this.write((tx) => {
            if (!ref) { tx.prepare("DELETE FROM peer_content_lines WHERE botId = ? AND line = ? AND url = ?").run(message.botId, message.line, message.url); return; }
            tx.prepare("INSERT OR REPLACE INTO peer_content_lines (botId, line, url, owner, id, type, state, stream, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
              .run(message.botId, message.line, message.url, ref.owner, ref.id, ref.type, ref.state, ref.entry.stream, ref.entry.seq);
          });
          if (ref && ref.state === "ready" && ref.id.startsWith("sha256:")) {
            this.confirm(owner, ref.id, ref.entry);
            if (ref.size !== undefined) this.remember(ref.id, { size: ref.size, variants: answer.variants ?? [] });
          }
          return ref;
        }
      } else {
        clearTimeout(timer);
        this.locates.delete(req);
      }
    }
    // Unreachable (or no answer): what the owner said last, still only for a bot this server places on that owner.
    const row = this.options.reader().prepare("SELECT owner, id, type, state, stream, seq FROM peer_content_lines WHERE botId = ? AND line = ? AND url = ?").get(message.botId, message.line, message.url);
    if (!row || String(row.owner) !== owner) return null;
    return { owner, id: String(row.id), type: String(row.type), state: String(row.state) as LocatedRef["state"], entry: { stream: String(row.stream) as EntryRef["stream"], seq: Number(row.seq) } };
  }

  /**
   * Whether a ticket may be given for (owner, id, entry): the entry's bot is the owner's (this server's copy), and the
   * owner confirmed the reference, now (a get when it is reachable and has not confirmed it yet) or before.
   */
  async check(deviceId: string, owner: string, id: string, entry: EntryRef, variant = "original"): Promise<"ok" | PeerReadFailure> {
    if (!this.options.readable(deviceId)) return "denied";
    if (this.options.ownerOf(entry.stream) !== owner) return "denied";
    const key = { owner, id, variant };
    if (this.isConfirmed(owner, id, entry) && this.meta(key)) return "ok";
    if (!this.options.session(owner)) return this.isConfirmed(owner, id, entry) ? "ok" : "offline";
    try {
      await this.fetchMeta(key, entry, deviceId);
      return "ok";
    } catch (error) {
      return error instanceof PeerReadError ? error.reason : "offline";
    }
  }

  // -------------------------------------------------------------------------------------------
  // HTTP ranges (remote.ts `respond`, after the ticket and device checks)

  async respond(url: ContentUrl, request: Request, deviceId: string): Promise<Response> {
    const { owner, id, variant, entry } = url;
    if (this.options.ownerOf(entry.stream) !== owner) return goneResponse("denied");
    const key = { owner, id, variant };
    let meta = this.meta(key);
    if (!this.isConfirmed(owner, id, entry) || !meta) {
      if (!this.options.session(owner)) { this.counts.offline++; return goneResponse("offline"); }
      try { meta = await this.fetchMeta(key, entry, deviceId); } catch (error) { return failureResponse(error); }
    }
    const reader: Reader = { key, entry, deviceId, start: 0, end: -1, pos: 0, up: null, closed: false, primed: null, ready: new Map() };
    const known = meta;
    const handle = { read: async (buffer: Buffer, offset: number, length: number, position: number) => {
      // fileHeaders reads the first 64 KiB of a text type (charset sniffing), exactly as for a local file.
      const first = known.size ? await this.chunk(reader, 0) : Buffer.alloc(0);
      const bytes = first.subarray(position, position + length);
      bytes.copy(buffer, offset);
      return { bytesRead: bytes.length, buffer };
    } } as unknown as FileHandle;
    let headers: Headers;
    try { headers = await fileHeaders(handle, known.size, known.type, CHAT_MEDIA_CSP); } catch (error) { this.closeReader(reader); return failureResponse(error); }
    let streamed = false;
    const response = rangedResponse(request, known.size, headers, (start, end) => {
      streamed = true;
      reader.start = start; reader.end = end; reader.pos = start;
      return this.stream(reader);
    });
    if (!streamed) { this.closeReader(reader); return response; }
    // Read the first chunk before answering: a range that cannot be had (owner unreachable, refused, bad hash) gets a
    // clean status instead of a cut body.
    this.readers.add(reader);
    try {
      reader.primed = await this.chunk(reader, Math.floor(reader.start / MiB));
    } catch (error) {
      this.closeReader(reader);
      await response.body?.cancel().catch(() => undefined);
      return failureResponse(error);
    }
    // Read ahead: the chunks after the first are asked for now (under the 4 MiB window), not when the player pulls them,
    // so playback does not wait a round trip per MiB. A seek cancels this request.
    const nextIdx = Math.floor(reader.start / MiB) + 1;
    if (!reader.up && !reader.closed && nextIdx * MiB <= reader.end && !this.options.cache.has(key, nextIdx) && !this.inflight.has(`${chunkKeyText(key)}\n${nextIdx}`)) {
      try { reader.up = this.startUpstream(reader, nextIdx, known); } catch { /* offline: the pull reports it */ }
    }
    return response;
  }

  /** Forgets every read of a device (it left the roster or lost `read`): its streams fail at once. */
  dropDevice(deviceId: string): number {
    let dropped = 0;
    for (const reader of [...this.readers]) if (reader.deviceId === deviceId) { this.closeReader(reader, new PeerReadError("denied", "the device may no longer read")); dropped++; }
    return dropped;
  }

  private stream(reader: Reader): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          if (reader.closed) throw reader.failure ?? new PeerReadError("cancelled");
          if (reader.pos > reader.end) { this.closeReader(reader); controller.close(); return; }
          // §9A.7: checked on every chunk; a device revoked mid-file gets nothing more.
          if (!this.options.readable(reader.deviceId)) throw new PeerReadError("denied", "the device may no longer read");
          const idx = Math.floor(reader.pos / MiB);
          let bytes: Buffer;
          if (reader.primed && idx === Math.floor(reader.start / MiB)) { bytes = reader.primed; reader.primed = null; } else bytes = await this.chunk(reader, idx);
          if (reader.closed) throw reader.failure ?? new PeerReadError("cancelled");
          const chunkStart = idx * MiB;
          const last = Math.min(reader.end, chunkStart + bytes.length - 1);
          controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset + (reader.pos - chunkStart), last - reader.pos + 1));
          reader.pos = last + 1;
        } catch (error) {
          this.closeReader(reader);
          controller.error(error);
        }
      },
      cancel: () => { this.closeReader(reader); },
    }, { highWaterMark: 0 });
  }

  private closeReader(reader: Reader, failure?: unknown): void {
    if (reader.closed) return;
    reader.closed = true;
    if (failure) reader.failure = failure;
    this.readers.delete(reader);
    reader.primed = null;
    reader.ready.clear();
    const up = reader.up;
    reader.up = null;
    if (up && !up.done) this.cancelUpstream(up, failure ? (failure as Error) : new PeerReadError("cancelled", "the player seeked away or closed"));
  }

  /** Chunk `idx` of the reader's file: from the cache, the reader's own request, another reader's, or a new request. */
  private async chunk(reader: Reader, idx: number): Promise<Buffer> {
    const meta = this.meta(reader.key);
    if (!meta) throw new PeerReadError("offline", "nothing is known of this file");
    if (idx >= meta.chunks) throw new PeerReadError("deleted", "past the end of the file");
    const expected = meta.hashes.subarray(idx * 32, idx * 32 + 32);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (reader.closed) throw reader.failure ?? new PeerReadError("cancelled");
      const early = reader.ready.get(idx);
      if (early) {
        for (const i of [...reader.ready.keys()]) if (i <= idx) reader.ready.delete(i);
        this.creditOwn(reader, idx);
        return early;
      }
      const cached = this.options.cache.get(reader.key, idx, expected);
      if (cached) { this.counts.servedFromCache++; this.creditOwn(reader, idx); return cached; }
      const up = reader.up;
      if (up && !up.done && idx >= up.next && idx <= up.end) {
        const bytes = await up.chunks.get(idx)!.promise;
        this.creditOwn(reader, idx);
        return bytes;
      }
      const pending = this.inflight.get(`${chunkKeyText(reader.key)}\n${idx}`);
      if (pending) {
        try { return await pending; } catch (error) {
          if (error instanceof PeerReadError && (error.reason === "corrupt" || error.reason === "denied" || error.reason === "changed" || error.reason === "deleted")) throw error;
          continue; // another reader's request was cancelled: ask for it ourselves
        }
      }
      if (up && !up.done) this.cancelUpstream(up, new PeerReadError("cancelled", "the player seeked"));
      reader.ready.clear();
      reader.up = this.startUpstream(reader, idx, meta);
    }
    throw new PeerReadError("offline", "the chunk could not be read");
  }

  /** The reader took a chunk of its own request: B may send one chunk more (the reader's pulls are the back-pressure). */
  private creditOwn(reader: Reader, idx: number): void {
    const up = reader.up;
    if (!up || up.done || idx < up.start || idx > up.end) return;
    const more = Math.min(MiB, up.length - up.granted);
    if (more <= 0) return;
    up.granted += more;
    up.session.sendWire({ t: "content.credit", req: up.req, bytes: more } as WireMessage);
  }

  /** A request to the owner for chunks idx… up to the reader's end (or the next cached chunk). */
  private startUpstream(reader: Reader, idx: number, meta: Meta | null): Upstream {
    const owner = reader.key.owner;
    const session = this.options.session(owner);
    if (!session) { this.counts.offline++; throw new PeerReadError("offline", "the owner is unreachable"); }
    let end = idx;
    if (meta) {
      const last = Math.min(meta.chunks - 1, Math.floor(Math.max(reader.end, reader.start) / MiB));
      while (end < last && !this.options.cache.has(reader.key, end + 1)) end++;
    }
    const up = this.openUpstream(session, reader.key, reader.entry, reader.deviceId, idx, end, meta);
    up.reader = reader;
    return up;
  }

  private openUpstream(session: PeerSession, key: ChunkKey, entry: EntryRef, deviceId: string, start: number, end: number, meta: Meta | null): Upstream {
    const req = this.newReq("g");
    const up: Upstream = {
      req, owner: key.owner, key, entry, session, start, end, next: start, parts: [], partBytes: 0, received: 0,
      chunks: new Map(), meta: deferred<Meta>(), cacheable: true, done: false, timer: null, reader: null, granted: PEER_CONTENT_WINDOW, length: 0,
    };
    for (let i = start; i <= end; i++) {
      const d = deferred<Buffer>();
      up.chunks.set(i, d);
      this.inflight.set(`${chunkKeyText(key)}\n${i}`, d.promise);
    }
    if (meta) { up.meta.resolve(meta); up.cacheable = this.cacheable(meta); }
    this.upstreams.set(req, up);
    this.armTimer(up);
    const offset = start * MiB;
    const length = meta ? Math.min(meta.size, (end + 1) * MiB) - offset : (end + 1) * MiB - offset;
    up.length = length;
    this.counts.gets++;
    if (length <= 0 || !session.sendWire({ t: "content.get", req, owner: key.owner, id: key.id, variant: key.variant, offset, length, entry, device: deviceId } as WireMessage)) {
      this.failUpstream(up, new PeerReadError("offline", "the get could not be sent"));
    }
    return up;
  }

  private cacheable(meta: Meta): boolean { return meta.size <= this.options.cache.budget.capBytes / 4; }

  private armTimer(up: Upstream): void {
    if (up.timer) clearTimeout(up.timer);
    up.timer = setTimeout(() => {
      if (up.done) return;
      up.session.sendWire({ t: "content.cancel", req: up.req } as WireMessage);
      this.failUpstream(up, new PeerReadError("offline", `no answer from the owner in ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    up.timer.unref?.();
  }

  /** The owner's meta for a file, with its confirmation of the entry (a get of chunk 0, which also warms the cache). */
  private async fetchMeta(key: ChunkKey, entry: EntryRef, deviceId: string): Promise<Meta> {
    const session = this.options.session(key.owner);
    if (!session) throw new PeerReadError("offline", "the owner is unreachable");
    const up = this.openUpstream(session, key, entry, deviceId, 0, 0, null);
    // Chunk 0 keeps coming after the meta (and is cached when verified); a reader of chunk 0 waits for it (inflight).
    return up.meta.promise;
  }

  private cancelUpstream(up: Upstream, error: Error): void {
    if (up.done) return;
    this.counts.cancels++;
    up.session.sendWire({ t: "content.cancel", req: up.req } as WireMessage);
    this.failUpstream(up, error);
  }

  private failUpstream(up: Upstream, error: unknown): void {
    if (up.done) return;
    up.done = true;
    if (up.timer) { clearTimeout(up.timer); up.timer = null; }
    this.upstreams.delete(up.req);
    up.meta.reject(error);
    for (const [idx, d] of up.chunks) {
      if (idx < up.next) continue;
      d.reject(error);
      const key = `${chunkKeyText(up.key)}\n${idx}`;
      if (this.inflight.get(key) === d.promise) this.inflight.delete(key);
    }
    up.parts = [];
    if (up.reader?.up === up) up.reader.up = null;
  }

  private finishUpstream(up: Upstream): void {
    up.done = true;
    if (up.timer) { clearTimeout(up.timer); up.timer = null; }
    this.upstreams.delete(up.req);
    if (up.reader?.up === up) up.reader.up = null;
  }

  // -------------------------------------------------------------------------------------------
  // Frames from owners

  /** A peer frame for this side (`content.located` / `meta` / `chunk` / `gone` answering a request of ours). */
  onMessage(session: PeerSession, message: WireMessage): boolean {
    const t = message.t;
    if (t === "content.located") {
      const m = message as MessageOf<"content.located">;
      const waiting = this.locates.get(m.req);
      if (!waiting || waiting.owner !== session.peer) return true;
      this.locates.delete(m.req);
      clearTimeout(waiting.timer);
      waiting.done.resolve(m);
      return true;
    }
    if (t !== "content.meta" && t !== "content.chunk" && t !== "content.gone") return false;
    const req = (message as { req: string }).req;
    const up = this.upstreams.get(req);
    if (!up || up.session !== session) return t === "content.chunk" || t === "content.meta" || t === "content.gone" ? req.startsWith("pc") : false;
    this.armTimer(up);
    if (t === "content.meta") this.takeMeta(up, message as MessageOf<"content.meta">);
    else if (t === "content.chunk") this.takeChunk(up, message as MessageOf<"content.chunk">);
    else this.takeGone(up, message as MessageOf<"content.gone">);
    return true;
  }

  private takeMeta(up: Upstream, message: MessageOf<"content.meta">): void {
    const known = this.meta(up.key);
    if (message.id !== up.key.id) { this.refuse(up, `meta for another id`); return; }
    if (!message.chunkHashes) {
      this.forget(up.owner, up.key.id, up.entry, "too-large");
      this.failUpstream(up, new PeerReadError("too-large", "the owner sent no chunk hashes (file too large to verify)"));
      up.session.sendWire({ t: "content.cancel", req: up.req } as WireMessage);
      return;
    }
    const meta = makeMeta(message.size, message.type, message.chunkHashes);
    if (!meta) { this.refuse(up, "a chunk-hash list that does not fit the size"); return; }
    if (known && (known.size !== meta.size || known.hashesText !== meta.hashesText)) { this.refuse(up, "meta that differs from what the owner said before for the same id"); return; }
    if (!known) {
      this.metas.set(chunkKeyText(up.key), meta);
      this.write((tx) => {
        tx.prepare("INSERT OR IGNORE INTO peer_content (owner, id, variant, size, type, chunkHashes, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(up.key.owner, up.key.id, up.key.variant, meta.size, meta.type, meta.hashesText, Date.now());
      });
    }
    // The owner checked the entry's reference and the device for this get: the reference is confirmed.
    this.confirm(up.owner, up.key.id, up.entry);
    const kept = known ?? meta;
    up.cacheable = this.cacheable(kept);
    // Chunks past the end of the file are never coming.
    const last = kept.chunks - 1;
    if (up.end > last) {
      for (let i = Math.max(up.start, last + 1); i <= up.end; i++) {
        const d = up.chunks.get(i);
        d?.reject(new PeerReadError("deleted", "past the end of the file"));
        const key = `${chunkKeyText(up.key)}\n${i}`;
        if (d && this.inflight.get(key) === d.promise) this.inflight.delete(key);
        up.chunks.delete(i);
      }
      up.end = last;
    }
    up.length = Math.max(0, Math.min(kept.size, (up.end + 1) * MiB) - up.start * MiB);
    up.meta.resolve(kept);
    if (up.start > up.end) this.finishUpstream(up);
  }

  private takeChunk(up: Upstream, message: MessageOf<"content.chunk">): void {
    let meta: Meta | null = this.meta(up.key);
    if (!meta) { this.refuse(up, "a chunk before the meta"); return; }
    if (message.offset !== up.start * MiB + up.received) { this.refuse(up, `a chunk at ${message.offset}, expected ${up.start * MiB + up.received}`); return; }
    const bytes = Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength);
    up.received += bytes.length;
    up.parts.push(bytes);
    up.partBytes += bytes.length;
    while (!up.done && up.next <= up.end) {
      const idx = up.next;
      const length = Math.min(MiB, meta.size - idx * MiB);
      if (up.partBytes < length) break;
      const whole = Buffer.concat(up.parts, up.partBytes);
      const chunk = Buffer.from(whole.subarray(0, length));
      const rest = whole.subarray(length);
      up.parts = rest.length ? [Buffer.from(rest)] : [];
      up.partBytes = rest.length;
      const expected = meta.hashes.subarray(idx * 32, idx * 32 + 32);
      if (!createHash("sha256").update(chunk).digest().equals(expected)) {
        // §9A.6, risk 4: a chunk that does not match the owner's hash is refused and reported, never cached or served.
        this.counts.corrupt++;
        this.log(`peer content: chunk ${idx} of ${up.key.id} (${up.key.variant}) from ${up.owner} does not match its hash; refused (never cached, never served)`);
        up.session.sendWire({ t: "content.cancel", req: up.req } as WireMessage);
        this.failUpstream(up, new PeerReadError("corrupt", `chunk ${idx} from the owner does not match its hash`));
        return;
      }
      this.counts.chunksVerified++;
      if (up.cacheable) this.options.cache.put(up.key, idx, chunk, up.entry.stream);
      const d = up.chunks.get(idx)!;
      if (up.reader && !up.reader.closed && up.reader.up === up) up.reader.ready.set(idx, chunk);
      d.resolve(chunk);
      const key = `${chunkKeyText(up.key)}\n${idx}`;
      if (this.inflight.get(key) === d.promise) this.inflight.delete(key);
      up.chunks.delete(idx);
      up.next++;
      meta = this.meta(up.key) ?? meta;
    }
    if (!up.done && up.next > up.end) {
      if (up.partBytes > 0) { this.refuse(up, "more bytes than asked for"); return; }
      this.finishUpstream(up);
    }
  }

  private takeGone(up: Upstream, message: MessageOf<"content.gone">): void {
    this.counts.refusedByOwner++;
    if (message.reason !== "offline") this.forget(up.owner, up.key.id, message.reason === "denied" ? up.entry : null, message.reason);
    this.failUpstream(up, new PeerReadError(message.reason, `the owner answered ${message.reason}`));
  }

  private refuse(up: Upstream, why: string): void {
    this.counts.corrupt++;
    this.log(`peer content: ${up.owner} sent ${why} for ${up.key.id}; refused`);
    up.session.sendWire({ t: "content.cancel", req: up.req } as WireMessage);
    this.failUpstream(up, new PeerReadError("corrupt", why));
  }

  /** A peer session ended: its requests fail as offline (cached ranges still play). */
  sessionClosed(session: PeerSession): void {
    for (const up of [...this.upstreams.values()]) if (up.session === session) this.failUpstream(up, new PeerReadError("offline", "the session with the owner ended"));
    for (const [req, waiting] of [...this.locates]) {
      if (waiting.owner !== session.peer) continue;
      this.locates.delete(req);
      clearTimeout(waiting.timer);
      waiting.done.resolve(null);
    }
  }

  close(): void {
    this.closed = true;
    for (const reader of [...this.readers]) this.closeReader(reader, new PeerReadError("offline", "botlingd is stopping"));
    for (const up of [...this.upstreams.values()]) this.failUpstream(up, new PeerReadError("offline", "botlingd is stopping"));
    for (const waiting of this.locates.values()) { clearTimeout(waiting.timer); waiting.done.resolve(null); }
    this.locates.clear();
  }
}

function makeMeta(size: number, type: string, hashesText: string): Meta | null {
  const hashes = Buffer.from(hashesText, "base64");
  const chunks = Math.ceil(size / MiB);
  if (hashes.length !== chunks * 32) return null;
  return { size, type, hashesText, hashes, chunks };
}

/** The answer for a read through a peer that failed before any byte was sent. */
export function failureResponse(error: unknown): Response {
  const reason: PeerReadFailure = error instanceof PeerReadError ? error.reason : "offline";
  if (reason === "corrupt") {
    return new Response("The other machine sent bytes that do not match this file.\n", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "X-Botling-Content": "refused; reason=chunk-hash" },
    });
  }
  return goneResponse(reason === "cancelled" ? "offline" : reason);
}

// ---------------------------------------------------------------------------------------------
// Owner side

export interface PeerContentOwnerOptions {
  service: Pick<ContentService, "open" | "locate" | "chunkHashesOf" | "markChanged" | "hasher"> & Partial<Pick<ContentService, "describe">>;
  roster: { device(member: string): { scope?: readonly DeviceScope[] } | null };
  log?: (line: string) => void;
  /**
   * Test hook (`BOTLING_SERVER_TEST_CORRUPT_CONTENT`): every chunk of this content id sent to a peer has one byte
   * flipped, so the attached server's check can be shown to refuse it. Never set outside tests.
   */
  corruptId?: string | null;
}

/**
 * Who the owner side serves: a peer server's session, or (M2 step 13) a device's own session through a `DeviceContentSink`
 * (remote-session.ts), which names its device on every get and its transport's frame size and window (relay: 128 KiB
 * chunks, a 1 MiB window; v1 §9A.4).
 */
export interface ContentSink {
  readonly peer: string | null;
  readonly state: string;
  sendWire(message: WireMessage): boolean;
  sendChunk(message: MessageOf<"content.chunk">): boolean;
  /** Bytes per `content.chunk` (default PEER_CONTENT_FRAME). */
  readonly contentFrame?: number;
  /** Bytes a get may send before any credit (default PEER_CONTENT_WINDOW). */
  readonly contentWindow?: number;
}

interface Serving {
  req: string;
  credit: number;
  /** Bytes sent so far (the cancel log line). */
  sent: number;
  cancelled: boolean;
  wake: (() => void) | null;
}

export class PeerContentOwner {
  private readonly serving = new Map<ContentSink, Map<string, Serving>>();
  private readonly variantHashes = new Map<string, Promise<string | null>>();
  private readonly log: (line: string) => void;
  /** Counters (tests, status). */
  readonly counts = { gets: 0, chunksSent: 0, bytesSent: 0, refused: 0, cancelled: 0, locates: 0 };

  constructor(private readonly options: PeerContentOwnerOptions) {
    this.log = options.log ?? (() => undefined);
  }

  private readable(device: string | undefined): boolean {
    if (device === undefined) return true;
    const found = this.options.roster.device(device);
    return !!found && (found.scope ?? []).includes("read");
  }

  onMessage(session: ContentSink, message: WireMessage): boolean {
    switch (message.t) {
      case "content.locate": {
        const m = message as MessageOf<"content.locate">;
        this.counts.locates++;
        const ref = this.readable(m.device) ? this.options.service.locate(m) : null;
        // M3 step 12: the owner describes its own ready file (size, variants: poster, preview, text), so the attached
        // server can hand the page what it hands for its own files (the poster first, the 1.5× rule, the PDF's text).
        const described = ref && ref.state === "ready" && ref.id.startsWith("sha256:") ? this.options.service.describe?.(ref.id) ?? null : null;
        session.sendWire({ t: "content.located", req: m.req, ref: ref ? { ...ref, ...(described ? { size: described.size } : {}) } : null, ...(described?.variants.length ? { variants: described.variants } : {}) } as WireMessage);
        return true;
      }
      case "content.get": {
        const m = message as MessageOf<"content.get">;
        let map = this.serving.get(session);
        if (!map) { map = new Map(); this.serving.set(session, map); }
        const prior = map.get(m.req);
        if (prior) { prior.cancelled = true; prior.wake?.(); }
        const serving: Serving = { req: m.req, credit: session.contentWindow ?? PEER_CONTENT_WINDOW, sent: 0, cancelled: false, wake: null };
        map.set(m.req, serving);
        this.counts.gets++;
        void this.serve(session, m, serving).catch((error) => {
          this.log(`peer content: serving ${m.id} to ${session.peer} failed: ${String((error as Error)?.message ?? error)}`);
          session.sendWire({ t: "content.gone", req: m.req, id: m.id, reason: "deleted" } as WireMessage);
        }).finally(() => { if (map!.get(m.req) === serving) map!.delete(m.req); });
        return true;
      }
      case "content.credit": {
        const m = message as MessageOf<"content.credit">;
        const serving = this.serving.get(session)?.get(m.req);
        if (serving) { serving.credit += m.bytes; serving.wake?.(); }
        return true;
      }
      case "content.cancel": {
        const m = message as MessageOf<"content.cancel">;
        const serving = this.serving.get(session)?.get(m.req);
        if (serving) {
          serving.cancelled = true; this.counts.cancelled++; serving.wake?.();
          // Seen in the log (M2 step 14: a player that seeks away through the page's service worker cancels its read).
          this.log(`content: cancel ${m.req} from ${session.peer ?? "?"} after ${serving.sent} bytes`);
        }
        return true;
      }
      default:
        return false;
    }
  }

  sessionClosed(session: ContentSink): void {
    const map = this.serving.get(session);
    if (!map) return;
    for (const serving of map.values()) { serving.cancelled = true; serving.wake?.(); }
    this.serving.delete(session);
  }

  private async hashesOf(id: string, variant: string, file: { path: string; sig: { size: number; mtimeNs: string; ino: string } }): Promise<string | null> {
    if (variant === "original") return this.options.service.chunkHashesOf(id);
    const key = `${file.path}\n${JSON.stringify(file.sig)}`;
    let pending = this.variantHashes.get(key);
    if (!pending) {
      pending = this.options.service.hasher.hash(file.path).then((result) => (result.size === file.sig.size ? result.chunkHashes : null), () => null);
      this.variantHashes.set(key, pending);
      if (this.variantHashes.size > 2_000) this.variantHashes.delete(this.variantHashes.keys().next().value!);
    }
    const hashes = await pending;
    if (hashes === null) this.variantHashes.delete(key);
    return hashes;
  }

  private async serve(session: ContentSink, m: MessageOf<"content.get">, serving: Serving): Promise<void> {
    const gone = (reason: GoneReason) => { this.counts.refused++; session.sendWire({ t: "content.gone", req: m.req, id: m.id, reason } as WireMessage); };
    if (!this.readable(m.device)) { gone("denied"); return; }
    const opened = await this.options.service.open({ t: "content.open", req: m.req, owner: m.owner, id: m.id, variant: m.variant, entry: m.entry }, { remote: true });
    if (opened.t === "content.gone") { gone(opened.reason); return; }
    const hashesText = await this.hashesOf(m.id, m.variant, opened);
    if (!hashesText || hashesText.length > HASHES_TEXT_LIMIT) { gone("too-large"); return; }
    const size = opened.sig.size;
    const hashes = Buffer.from(hashesText, "base64");
    if (serving.cancelled) return;
    let handle: FileHandle;
    try { handle = await open(opened.path, "r"); } catch { gone(opened.pin === "path" ? "changed" : "deleted"); return; }
    try {
      let now;
      try { now = statSig(opened.path); } catch { now = null; }
      if (!sameSig(now, opened.sig)) {
        if (opened.pin === "path" && m.variant === "original") { await this.options.service.markChanged(m.id); gone("changed"); } else gone("deleted");
        return;
      }
      session.sendWire({ t: "content.meta", req: m.req, id: m.id, size, type: opened.type, chunkSize: MiB, chunkHashes: hashesText, variants: [] } as WireMessage);
      const end = Math.min(size, m.offset + m.length);
      let pos = m.offset;
      while (pos < end) {
        const idx = Math.floor(pos / MiB);
        const chunkStart = idx * MiB;
        const length = Math.min(MiB, size - chunkStart);
        const chunk = Buffer.allocUnsafe(length);
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(chunk, read, length - read, chunkStart + read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        const expected = hashes.subarray(idx * 32, idx * 32 + 32);
        if (read !== length || !createHash("sha256").update(chunk).digest().equals(expected)) {
          // A reference serves the bytes of its hash or nothing (§9A.3).
          if (opened.pin === "path" && m.variant === "original") { await this.options.service.markChanged(m.id); gone("changed"); } else gone("deleted");
          return;
        }
        const stop = Math.min(end, chunkStart + length);
        while (pos < stop) {
          const piece = Math.min(session.contentFrame ?? PEER_CONTENT_FRAME, stop - pos);
          while (!serving.cancelled && serving.credit < piece && session.state === "open") await new Promise<void>((resolve) => { serving.wake = resolve; });
          serving.wake = null;
          if (serving.cancelled || session.state !== "open") return;
          // §9A.7: the device is checked again at every chunk; a device revoked here mid-file gets nothing more.
          if (!this.readable(m.device)) { gone("denied"); return; }
          const bytes = new Uint8Array(chunk.subarray(pos - chunkStart, pos - chunkStart + piece));
          if (this.options.corruptId && this.options.corruptId === m.id && pos % MiB === 0) bytes[Math.min(100, bytes.length - 1)]! ^= 0xff;
          if (!session.sendChunk({ t: "content.chunk", req: m.req, offset: pos, bytes })) return;
          serving.credit -= piece;
          serving.sent += piece;
          this.counts.chunksSent++;
          this.counts.bytesSent += piece;
          pos += piece;
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
