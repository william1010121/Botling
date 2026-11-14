// The receiving side of `live` frames (protocol v1 §9.2), pure: what a front end (or a server on the path) keeps of a
// stream's running segment and when it must ask `live.resync`. The server's tests use it as the client; fe-link's live
// buffer (step 10) can use the same rules.
//
// Rules, per stream:
// - A frame with `at = 0` carries the whole segment: it is always taken, whatever turn, segment or rev it names.
// - Any other frame must name the receiver's turnId and seg, carry rev = last rev + 1, and have `at` ≤ the receiver's
//   length; the receiver then cuts its text at `at` and appends `text` (normally `at` = its length: an append).
// - Anything else is a mismatch: the frame is dropped and the receiver asks `live.resync`; frames that follow are
//   dropped too until a whole-segment frame arrives.
// Offsets count UTF-16 code units (JavaScript string indexes), on both sides.
import type { MessageOf } from "../../protocol";

export type LiveFrame = MessageOf<"live">;

export interface LiveSegmentView {
  turnId: string;
  seg: number;
  rev: number;
  text: string;
}

export type ApplyResult = "applied" | "resync" | "waiting";

export class LiveReceiver {
  private readonly views = new Map<string, LiveSegmentView>();
  /** Streams whose state is unknown until a whole-segment frame comes (a resync was asked). */
  private readonly broken = new Set<string>();

  view(stream: string): LiveSegmentView | null {
    return this.views.get(stream) ?? null;
  }

  /** Applies one frame. "resync": send `live.resync{stream}` now; "waiting": already asked, frame dropped. */
  apply(frame: LiveFrame): ApplyResult {
    const current = this.views.get(frame.stream);
    if (frame.at === 0) {
      this.views.set(frame.stream, { turnId: frame.turnId, seg: frame.seg, rev: frame.rev, text: frame.text });
      this.broken.delete(frame.stream);
      return "applied";
    }
    if (this.broken.has(frame.stream)) return "waiting";
    if (!current || current.turnId !== frame.turnId || current.seg !== frame.seg || frame.rev !== current.rev + 1 || frame.at > current.text.length) {
      this.broken.add(frame.stream);
      return "resync";
    }
    current.text = current.text.slice(0, frame.at) + frame.text;
    current.rev = frame.rev;
    return "applied";
  }

  /** The turn ended (its entries replaced the live text) or the stream was dropped. */
  drop(stream: string): void {
    this.views.delete(stream);
    this.broken.delete(stream);
  }
}
