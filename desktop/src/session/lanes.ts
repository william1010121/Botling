// Lanes (protocol v1 §5.3): two sender queues per session. Control+live (roster, `cmd`, `held`, `cmd.result`, `live`,
// batches at the head) always goes first; bulk (catch-up pages, `snap`, content and fetch chunks) is cut small, so a
// control frame waits at most one bulk frame. Frames are sealed when they leave the queue, so counters follow the
// order on the wire.
import { SessionError } from "./bytes";

export type Lane = "control" | "bulk";

/** The most a frame's plaintext may be (§5.2; the same as protocol/frame.ts FRAME_LIMIT). */
export const SESSION_FRAME_LIMIT = 256 * 1024;
/**
 * A binary chunk frame's header room (protocol/frame.ts: mark, length, header ≤ BINARY_HEADER_LIMIT = 32 KiB). A
 * `fetch.chunk` header carries a file path of up to 4096 bytes (M5-07b), so a 64 KiB fetch chunk must still fit.
 */
const CHUNK_HEADER_ROOM = 3 + 32 * 1024;
/** Bulk frames on a direct session: ≤ 64 KiB of payload (a 64 KiB content chunk with its header fits). */
export const BULK_FRAME_LIMIT = 64 * 1024 + CHUNK_HEADER_ROOM;
/** Bulk frames on a relay session: content chunks are 128 KiB there (§5.3, D36). */
export const RELAY_BULK_FRAME_LIMIT = 128 * 1024 + CHUNK_HEADER_ROOM;

export class LaneQueue {
  private readonly control: Uint8Array[] = [];
  private readonly bulk: Uint8Array[] = [];
  private bytes = 0;
  private controlBytes_ = 0;

  constructor(readonly bulkFrameLimit = BULK_FRAME_LIMIT) {}

  push(lane: Lane, plaintext: Uint8Array): void {
    if (plaintext.length === 0) throw new SessionError("malformed", "a frame is not empty");
    if (plaintext.length > SESSION_FRAME_LIMIT) throw new SessionError("malformed", `a frame is at most ${SESSION_FRAME_LIMIT} bytes`);
    if (lane === "bulk" && plaintext.length > this.bulkFrameLimit) throw new SessionError("malformed", `a bulk frame is at most ${this.bulkFrameLimit} bytes`);
    (lane === "control" ? this.control : this.bulk).push(plaintext);
    this.bytes += plaintext.length;
    if (lane === "control") this.controlBytes_ += plaintext.length;
  }

  /** The next frame to seal: control first. */
  shift(): { lane: Lane; plaintext: Uint8Array } | undefined {
    const control = this.control.shift();
    if (control) { this.bytes -= control.length; this.controlBytes_ -= control.length; return { lane: "control", plaintext: control }; }
    const bulk = this.bulk.shift();
    if (bulk) { this.bytes -= bulk.length; return { lane: "bulk", plaintext: bulk }; }
    return undefined;
  }

  get length(): number { return this.control.length + this.bulk.length; }
  /** Plaintext bytes waiting (for back-pressure). */
  get queuedBytes(): number { return this.bytes; }
  /** Plaintext bytes waiting on the control lane (they leave before any bulk frame). */
  get queuedControlBytes(): number { return this.controlBytes_; }

  clear(): void {
    this.control.length = 0;
    this.bulk.length = 0;
    this.bytes = 0;
    this.controlBytes_ = 0;
  }
}
