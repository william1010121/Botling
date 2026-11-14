// The per-connection cap on `live` frames (M1 step 9): at most one frame per `intervalMs` (100 ms, so ≤ 10 frames/s) on
// one connection, whatever number of bots run turns at once. The live channel already keeps each turn and subscriber at
// ≤ 10 frames/s (live-channel.ts); this gate keeps the sum there too.
//
// How, without breaking the receiver's rules (receiver.ts: an append frame needs rev = last + 1 and `at` within the
// text; a frame with `at = 0` carries the whole segment and is always taken):
// - a frame that finds the connection's slot free goes out, and takes the slot for `intervalMs`;
// - a frame that finds it taken is dropped, and its stream waits: every later frame of that stream is dropped too, until
//   the stream's turn comes (round robin among waiting streams, one per interval), when the gate asks the channel for a
//   whole-segment frame (`resync`, `at = 0`) and lets that through. The receiver then has the whole text again, rev and
//   all; nothing it holds is ever contradicted by a frame it missed.
// - a segment too big for one frame goes as consecutive frames in one send (live-channel.ts `splitUnits`): the frames
//   that continue the one just sent, in the same tick, go with it.
import type { LiveFrame } from "../live";

export interface LiveGateClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemGateClock: LiveGateClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

interface StreamState {
  /** Frames of this stream are dropped until a whole-segment frame (`at = 0`) is let through. */
  waiting: boolean;
  /** Asks the channel for a whole-segment frame (the subscription's `resync`). */
  resync(): void;
  /** The last frame sent, to let a too-big segment's consecutive frames through in the same tick. */
  last: { turnId: string; seg: number; rev: number; end: number; tick: number } | null;
}

export class LiveGate {
  private readonly clock: LiveGateClock;
  private readonly intervalMs: number;
  private readonly streams = new Map<string, StreamState>();
  /** Streams waiting for their turn, oldest first. */
  private readonly queue: string[] = [];
  private lastSent = -Infinity;
  /** The stream whose whole-segment frame the slot is kept for. */
  private granted: string | null = null;
  private timer: unknown = null;
  private tick = 0;
  private tickArmed = false;
  private closed = false;
  /** Frames dropped so far (diagnostics, tests). */
  dropped = 0;

  constructor(private readonly send: (frame: LiveFrame) => void, options: { intervalMs?: number; clock?: LiveGateClock } = {}) {
    this.clock = options.clock ?? systemGateClock;
    this.intervalMs = options.intervalMs ?? 100;
  }

  /** A stream's live subscription: `resync` asks it for a whole-segment frame. Returns its `send`. */
  add(stream: string, resync: () => void): (frame: LiveFrame) => void {
    this.streams.set(stream, { waiting: false, resync, last: null });
    return (frame) => this.offer(stream, frame);
  }

  remove(stream: string): void {
    this.streams.delete(stream);
    const at = this.queue.indexOf(stream);
    if (at >= 0) this.queue.splice(at, 1);
    if (this.granted === stream) this.granted = null;
  }

  /** The front end asked for the whole segment (`live.resync`): the stream's next frame carries it; queue as any other. */
  resync(stream: string): void {
    const state = this.streams.get(stream);
    if (!state) return;
    if (this.slotFree()) { state.waiting = false; state.resync(); return; }
    this.wait(stream, state);
  }

  close(): void {
    this.closed = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.streams.clear();
    this.queue.length = 0;
  }

  private offer(stream: string, frame: LiveFrame): void {
    const state = this.streams.get(stream);
    if (!state || this.closed) return;
    const now = this.clock.now();
    // The rest of a too-big segment, sent by the channel in the same send as the frame just let through.
    const last = state.last;
    if (last && last.tick === this.tick && frame.turnId === last.turnId && frame.seg === last.seg && frame.rev === last.rev + 1 && frame.at === last.end) {
      this.forward(stream, state, frame, now);
      return;
    }
    if (this.granted === stream && frame.at === 0) {
      this.granted = null;
      state.waiting = false;
      this.forward(stream, state, frame, now);
      return;
    }
    if (state.waiting) { this.dropped += 1; return; }
    if (this.slotFree(now)) {
      this.forward(stream, state, frame, now);
      return;
    }
    this.dropped += 1;
    this.wait(stream, state);
  }

  private slotFree(now = this.clock.now()): boolean {
    return this.granted === null && now - this.lastSent >= this.intervalMs;
  }

  private forward(stream: string, state: StreamState, frame: LiveFrame, now: number): void {
    this.lastSent = now;
    this.armTick();
    state.last = { turnId: frame.turnId, seg: frame.seg, rev: frame.rev, end: frame.at + frame.text.length, tick: this.tick };
    this.send(frame);
    if (this.queue.length) this.schedule();
  }

  private wait(stream: string, state: StreamState): void {
    state.waiting = true;
    if (!this.queue.includes(stream)) this.queue.push(stream);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.closed) return;
    const wait = Math.max(0, this.lastSent + this.intervalMs - this.clock.now());
    this.timer = this.clock.setTimeout(() => { this.timer = null; this.next(); }, wait);
  }

  /** The slot is free again: the oldest waiting stream gets it, for its whole-segment frame. */
  private next(): void {
    if (this.closed) return;
    // A grant whose frame never came (the turn ended meanwhile) lapses after one interval.
    this.granted = null;
    const now = this.clock.now();
    if (now - this.lastSent < this.intervalMs) { this.schedule(); return; }
    const stream = this.queue.shift();
    if (!stream) return;
    const state = this.streams.get(stream);
    if (!state) { this.next(); return; }
    this.granted = stream;
    this.lastSent = now; // the slot is kept for this stream's frame
    state.resync();
    if (this.queue.length) this.schedule();
    else {
      // Let the grant lapse after one interval if its frame did not come.
      this.timer = this.clock.setTimeout(() => { this.timer = null; this.next(); }, this.intervalMs);
    }
  }

  /** Frames sent in one synchronous run share a tick number. */
  private armTick(): void {
    if (this.tickArmed) return;
    this.tickArmed = true;
    queueMicrotask(() => { this.tickArmed = false; this.tick += 1; });
  }
}
