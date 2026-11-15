// Owner side of peer content (`PeerContentOwner`, server B), split out of peer-content.ts (M7-S23): answers a peer's
// `content.locate` / `content.get` / `content.credit` / `content.cancel`. See the header of peer-content.ts for the protocol.
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import type { MessageOf, WireMessage } from "../../protocol";
import type { DeviceScope } from "../../protocol/scopes";
import type { ContentService } from "./service";
import { sameSig, statSig } from "./pin";
import { HASHES_TEXT_LIMIT, MiB, PEER_CONTENT_FRAME, PEER_CONTENT_WINDOW, type GoneReason } from "./peer-content-types";

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
