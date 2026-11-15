// Constants, error, wire-shaped helper types and the options of `PeerContent` (attached side), split out of
// peer-content.ts (M7-S23). Nothing here imports `peer-content.ts` or `peer-content-owner.ts`; both import from here.
import { CONTENT_CHUNK_BYTES, type EntryRef, type MessageOf } from "../../protocol";
import type { PeerSession } from "../peer";
import type { Db, ServerStore } from "../store";
import type { ChunkCache, ChunkKey } from "./chunk-cache";


export const MiB = CONTENT_CHUNK_BYTES;
/** What a sender may send per request before any credit (v1 §9A.4: a 4 MiB window on direct sessions). */
export const PEER_CONTENT_WINDOW = 4 * MiB;
/** Bytes per `content.chunk` frame on a direct session (§9A.4). */
export const PEER_CONTENT_FRAME = 64 * 1024;
/** The owner's answer (located, meta, next chunk) must come within this time, or the read fails as offline. */
export const PEER_CONTENT_TIMEOUT_MS = 15_000;
/** D69 (Q-C1): a server's own local desktop window reads as that server, so the peer wire omits `device`. */
export const LOCAL_WINDOW = null;
export const HASHES_TEXT_LIMIT = 240_000;
/** How many owner descriptions (size, variants) of peer files are kept in memory (M3 step 12). */
export const DESCRIBED_KEPT = 2_000;

export type GoneReason = MessageOf<"content.gone">["reason"];
/** Why a read through a peer failed. */
export type PeerReadFailure = GoneReason | "corrupt" | "cancelled";

export class PeerReadError extends Error {
  constructor(readonly reason: PeerReadFailure, detail: string = reason) { super(detail); this.name = "PeerReadError"; }
}

/** A located reference (as `ContentService.locate` answers). */
export type LocatedRef = NonNullable<MessageOf<"content.found">["ref"]>;

export interface Meta { size: number; type: string; hashesText: string; hashes: Buffer; chunks: number }

export interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** One `content.get` to the owner, for chunks `start…end` of one file. */
export interface Upstream {
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
export interface Reader {
  key: ChunkKey;
  entry: EntryRef;
  deviceId: string | null;
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
