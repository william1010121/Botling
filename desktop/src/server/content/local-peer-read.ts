// Local socket peer-content reads (M4-01a, protocol v1 §9A.4 desktop row, §9A.3, §9A.7, D69 / Q-C1):
// bridges a local `Session` (`content.get` / `content.credit` / `content.cancel`) to `PeerContent.respond` with
// `LOCAL_WINDOW = null` (so the peer wire omits `device`), pumping verified bytes as `content.meta` and <= 64 KiB
// `content.chunk` frames bounded by the 4 MiB credit window.
import { CONTENT_CHUNK_BYTES, type Message, type MessageOf } from "../../protocol";
import { GoneReason, LOCAL_WINDOW, PEER_CONTENT_FRAME, PEER_CONTENT_WINDOW, PeerContent, PeerReadError } from "./peer-content";

const MAX_READS_PER_SESSION = 32;

export interface LocalPeerReadSink {
  send(message: Message): boolean;
  chunk(message: MessageOf<"content.chunk">): boolean;
}

export interface LocalPeerReadsOptions {
  peer: Pick<PeerContent, "respond" | "meta">;
  self: string;
  maxReadsPerSession?: number;
  log?: (line: string) => void;
}

interface OpenRead {
  session: object;
  req: string;
  credit: number;
  cancelled: boolean;
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
  wake: (() => void) | null;
}

export class LocalPeerReads {
  private readonly sessions = new Map<object, Map<string, OpenRead>>();
  private readonly maxReadsPerSession: number;
  private readonly log: (line: string) => void;

  constructor(private readonly options: LocalPeerReadsOptions) {
    this.maxReadsPerSession = options.maxReadsPerSession ?? MAX_READS_PER_SESSION;
    this.log = options.log ?? (() => undefined);
  }

  async get(session: object, m: MessageOf<"content.get">, sink: LocalPeerReadSink): Promise<void> {
    if (m.owner === this.options.self) {
      sink.send({ t: "content.gone", req: m.req, id: m.id, reason: "denied" });
      return;
    }
    let map = this.sessions.get(session);
    if (!map) {
      map = new Map();
      this.sessions.set(session, map);
    }
    const prior = map.get(m.req);
    if (prior) {
      this.stopRead(prior);
    } else if (map.size >= this.maxReadsPerSession) {
      sink.send({ t: "content.gone", req: m.req, id: m.id, reason: "offline" });
      return;
    }

    const read: OpenRead = {
      session,
      req: m.req,
      credit: PEER_CONTENT_WINDOW,
      cancelled: false,
      reader: null,
      wake: null,
    };
    map.set(m.req, read);

    try {
      const rangeEnd = m.offset + m.length - 1;
      const range = Number.isSafeInteger(rangeEnd) ? `bytes=${m.offset}-${rangeEnd}` : `bytes=${m.offset}-`;
      const response = await this.options.peer.respond(
        { owner: m.owner, id: m.id, variant: m.variant, entry: m.entry },
        new Request("http://local/", { headers: { Range: range } }),
        LOCAL_WINDOW,
      );

      if (read.cancelled) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }

      const meta = this.options.peer.meta({ owner: m.owner, id: m.id, variant: m.variant });
      const contentType = meta?.type ?? (response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream");

      if (response.status === 416) {
        await response.body?.cancel().catch(() => undefined);
        const size = meta?.size ?? parseContentRangeSize(response.headers.get("content-range")) ?? 0;
        sink.send({ t: "content.meta", req: m.req, id: m.id, size, type: contentType, chunkSize: CONTENT_CHUNK_BYTES, variants: [] });
        return;
      }

      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel().catch(() => undefined);
        const reason = parseGoneHeader(response.headers.get("x-botling-content"));
        sink.send({ t: "content.gone", req: m.req, id: m.id, reason });
        return;
      }

      const size = meta?.size
        ?? parseContentRangeSize(response.headers.get("content-range"))
        ?? parseNonNegativeInt(response.headers.get("content-length"))
        ?? 0;

      if (!sink.send({ t: "content.meta", req: m.req, id: m.id, size, type: contentType, chunkSize: CONTENT_CHUNK_BYTES, variants: [] })) {
        this.stopRead(read);
        await response.body?.cancel().catch(() => undefined);
        return;
      }

      if (size === 0 || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }

      const reader = response.body.getReader();
      read.reader = reader;
      let offset = m.offset;
      let sent = 0;
      let streamDone = false;

      try {
        while (!read.cancelled && sent < m.length) {
          while (!read.cancelled && read.credit <= 0) await waitForWake(read);
          if (read.cancelled) break;

          const { done, value } = await reader.read();
          if (done) {
            streamDone = true;
            break;
          }
          if (!value || value.length === 0) continue;

          let pos = 0;
          while (!read.cancelled && pos < value.length && sent < m.length) {
            while (!read.cancelled && read.credit <= 0) await waitForWake(read);
            if (read.cancelled) break;
            const piece = Math.min(PEER_CONTENT_FRAME, value.length - pos, m.length - sent, read.credit);
            const bytes = value.subarray(pos, pos + piece);
            if (!sink.chunk({ t: "content.chunk", req: m.req, offset, bytes })) {
              read.cancelled = true;
              break;
            }
            read.credit -= piece;
            offset += piece;
            sent += piece;
            pos += piece;
          }
        }
      } catch (error) {
        if (!read.cancelled) {
          const reason = error instanceof PeerReadError && error.reason !== "corrupt" && error.reason !== "cancelled"
            ? error.reason
            : "offline";
          this.log(`local peer read ${m.id}: ${error instanceof Error ? error.message : String(error)}`);
          sink.send({ t: "content.gone", req: m.req, id: m.id, reason });
        }
      } finally {
        read.reader = null;
        if (!streamDone) await reader.cancel().catch(() => undefined);
      }
    } catch (error) {
      if (!read.cancelled) {
        this.log(`local peer read ${m.id} failed: ${error instanceof Error ? error.message : String(error)}`);
        sink.send({ t: "content.gone", req: m.req, id: m.id, reason: "offline" });
      }
    } finally {
      const current = this.sessions.get(session);
      if (current?.get(m.req) === read) {
        current.delete(m.req);
        if (current.size === 0) this.sessions.delete(session);
      }
    }
  }

  credit(session: object, m: MessageOf<"content.credit">): void {
    const read = this.sessions.get(session)?.get(m.req);
    if (!read || read.cancelled) return;
    read.credit += m.bytes;
    const wake = read.wake;
    read.wake = null;
    wake?.();
  }

  cancel(session: object, m: MessageOf<"content.cancel">): void {
    const map = this.sessions.get(session);
    const read = map?.get(m.req);
    if (!read) return;
    map!.delete(m.req);
    if (map!.size === 0) this.sessions.delete(session);
    this.stopRead(read);
  }

  closeSession(session: object): void {
    const map = this.sessions.get(session);
    if (!map) return;
    this.sessions.delete(session);
    for (const read of map.values()) this.stopRead(read);
  }

  close(): void {
    for (const session of [...this.sessions.keys()]) this.closeSession(session);
  }

  private stopRead(read: OpenRead): void {
    read.cancelled = true;
    const wake = read.wake;
    read.wake = null;
    wake?.();
    const reader = read.reader;
    read.reader = null;
    if (reader) void reader.cancel().catch(() => undefined);
  }
}

function waitForWake(read: OpenRead): Promise<void> {
  return new Promise<void>((resolve) => {
    read.wake = resolve;
  });
}

function parseContentRangeSize(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf("/");
  if (slash === -1) return null;
  return parseNonNegativeInt(header.slice(slash + 1));
}

function parseNonNegativeInt(text: string | null): number | null {
  if (!text) return null;
  const n = Number(text.trim());
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function parseGoneHeader(header: string | null): GoneReason {
  const match = /^gone;\s*reason=(changed|deleted|denied|offline|too-large)$/.exec(header?.trim() ?? "");
  return match ? (match[1] as GoneReason) : "offline";
}
