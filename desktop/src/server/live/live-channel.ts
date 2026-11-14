// The live channel of `botlingd` (protocol v1 §9, D10): a running turn's text goes to front ends as unpersisted `live`
// frames, never into the log, and is checkpointed into `bots.liveText` every 5 s.
//
// Fed through a small interface, independent of Electron and the core: `start / delta / replace / step / end` from the
// engine side (contract-feed.ts maps the core's events), `subscribe` from the session side, a CheckpointSink for the
// store, and an injectable Clock.
//
// - Segments (§9.2): `seg` counts the turn's text segments; `step()` closes one at a step boundary (a tool call starts,
//   a card opens). The finished segment is the caller's to commit inside `turn.steps`; call `step()` after that commit
//   was pushed to readers, so a front end never loses the text between dropping its live segment and the entry. An
//   empty new segment sends nothing: its first frame goes when text arrives.
// - Frames: `at` = offset in the segment where `text` goes (the receiver cuts there, then appends; an append has
//   `at` = the length it had), `rev` = this subscription's frame number, +1 per frame. A frame with `at = 0` carries
//   the whole segment. receiver.ts holds the receiving rules; a receiver that does not match sends `live.resync` and
//   gets one whole-segment frame.
// - Rate (≤ 10 frames/s per turn and subscriber): each subscription sends at most one frame per `minFrameIntervalMs`
//   (100 ms). The first change after a quiet spell goes out at once (no added latency when text is slow); changes
//   inside the interval are coalesced into one frame at its end, so text is never more than 100 ms late. Whole-segment
//   frames (resync) obey the same spacing; only the first frame of a new subscription goes out at once.
//   A segment too big for one frame (> `maxFrameUnits` code units) goes as consecutive frames in one send.
// - Catch-up (§9.4): the session subscribes a reader once its log cursor is at the head (after the catch-up batches);
//   the subscription's first frame is the whole current segment (`at = 0`), then appends follow.
// - Checkpoint (§9.3): at turn start (empty text, so recovery knows the turn) and then every `checkpointIntervalMs`
//   (5 s) when the text changed, the whole turn text (finished segments + current) goes to the sink, which must apply
//   writes in order; at most two writes per turn are in flight. `end()` clears it; `close()` (shutdown or crash) leaves it for recovery.
import type { StreamId } from "../../protocol";
import type { CheckpointSink, LiveCheckpoint } from "./checkpoint";
import { systemClock, type Clock, type TimerHandle } from "./clock";
import type { LiveFrame } from "./receiver";

export const MIN_FRAME_INTERVAL_MS = 100;
export const CHECKPOINT_INTERVAL_MS = 5_000;
/** UTF-16 code units per frame: ≤ 4 bytes per 2 units in UTF-8, so 60,000 units stay far below the 256 KiB frame (§5.2). */
export const MAX_FRAME_UNITS = 60_000;
const MAX_CHECKPOINTS_IN_FLIGHT = 2;

export interface LiveChannelOptions {
  clock?: Clock;
  /** Where checkpoints go; null for none (a peer's cache in M2). */
  sink?: CheckpointSink | null;
  minFrameIntervalMs?: number;
  checkpointIntervalMs?: number;
  maxFrameUnits?: number;
  /** A subscriber's send or a checkpoint write failed; the channel goes on. */
  onError?: (error: unknown) => void;
}

export type LiveSend = (frame: LiveFrame) => void;

export interface LiveSubscription {
  readonly stream: StreamId;
  readonly closed: boolean;
  /** The receiver did not match (`live.resync`): the next frame carries the whole segment. */
  resync(): void;
  close(): void;
}

export interface RunningTurn {
  botId: string;
  turnId: string;
  seg: number;
  /** The current segment. */
  text: string;
  /** Finished segments followed by the current one (what a checkpoint holds). */
  turnText: string;
}

interface Turn {
  botId: string;
  stream: StreamId;
  turnId: string;
  seg: number;
  /** Finished segments, joined. */
  prior: string;
  text: string;
  /** +1 per change; checkpoints compare it. */
  version: number;
  checkpointTimer: TimerHandle | null;
  checkpointed: number;
  /** Checkpoint writes not settled yet. */
  writing: number;
  /** A tick found too many writes in flight: write again once one settles. */
  tickWaiting: boolean;
  ended: boolean;
}

interface Sub extends LiveSubscription {
  send: LiveSend;
  rev: number;
  sentTurn: string | null;
  sentSeg: number;
  sentText: string;
  lastAt: number;
  timer: TimerHandle | null;
  /** The next frame must carry the whole segment. */
  needFull: boolean;
  /** Send the whole segment even when it is empty (first frame, resync). */
  force: boolean;
  isClosed: boolean;
}

export function streamOf(botId: string): StreamId {
  return `bot:${botId}` as StreamId;
}

export class LiveChannel {
  private readonly clock: Clock;
  private readonly sink: CheckpointSink | null;
  private readonly interval: number;
  private readonly checkpointInterval: number;
  private readonly maxUnits: number;
  private readonly turns = new Map<StreamId, Turn>();
  private readonly subs = new Map<StreamId, Set<Sub>>();
  private closed = false;

  constructor(private readonly options: LiveChannelOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.sink = options.sink ?? null;
    this.interval = Math.max(1, options.minFrameIntervalMs ?? MIN_FRAME_INTERVAL_MS);
    this.checkpointInterval = Math.max(1, options.checkpointIntervalMs ?? CHECKPOINT_INTERVAL_MS);
    this.maxUnits = Math.max(2, options.maxFrameUnits ?? MAX_FRAME_UNITS);
  }

  // ---------------------------------------------------------------------------------------------
  // Engine side

  /** A turn of `botId` started; a turn still running on the bot ends first. */
  start(botId: string, turnId: string): void {
    if (this.closed) return;
    const stream = streamOf(botId);
    const previous = this.turns.get(stream);
    if (previous) this.end(botId, previous.turnId);
    const turn: Turn = {
      botId, stream, turnId, seg: 0, prior: "", text: "", version: 0, checkpointTimer: null, checkpointed: -1, writing: 0, tickWaiting: false, ended: false,
    };
    this.turns.set(stream, turn);
    this.writeCheckpoint(turn);
    this.armCheckpoint(turn);
  }

  /** Text appended to the current segment. False when no such turn runs (a late event). */
  delta(botId: string, turnId: string, text: string): boolean {
    const turn = this.turn(botId, turnId);
    if (!turn || !text) return Boolean(turn);
    turn.text += text;
    this.changed(turn);
    return true;
  }

  /** The current segment rewritten as a whole (the engine took back text, e.g. a tag it held). */
  replace(botId: string, turnId: string, segment: string): boolean {
    const turn = this.turn(botId, turnId);
    if (!turn) return false;
    if (segment === turn.text) return true;
    turn.text = segment;
    this.changed(turn);
    return true;
  }

  /**
   * The turn's whole text so far (as the 2.x core's `message.updated` carries it). The finished segments stay as
   * they are when it starts with them; otherwise the whole text becomes the current segment.
   */
  replaceTurnText(botId: string, turnId: string, text: string): boolean {
    const turn = this.turn(botId, turnId);
    if (!turn) return false;
    if (turn.prior && !text.startsWith(turn.prior)) {
      turn.prior = "";
      return this.replace(botId, turnId, text);
    }
    return this.replace(botId, turnId, text.slice(turn.prior.length));
  }

  /** A step boundary: the current segment is finished (committed by the caller in `turn.steps`), a new one starts. */
  step(botId: string, turnId: string): boolean {
    const turn = this.turn(botId, turnId);
    if (!turn) return false;
    turn.prior += turn.text;
    turn.text = "";
    turn.seg += 1;
    turn.version += 1;
    // Nothing to send for an empty segment; subscribers' pending timers find nothing new and stay quiet.
    return true;
  }

  /**
   * The turn ended: its entries (`turn.finished`, `message.added`) replace the live text, so pending frames are dropped
   * and, unless `clear` is false, the checkpoint is cleared.
   */
  end(botId: string, turnId: string, options: { clear?: boolean } = {}): boolean {
    const turn = this.turn(botId, turnId);
    if (!turn) return false;
    turn.ended = true;
    if (turn.checkpointTimer) this.clock.clearTimeout(turn.checkpointTimer);
    turn.checkpointTimer = null;
    this.turns.delete(turn.stream);
    for (const sub of this.subs.get(turn.stream) ?? []) this.cancel(sub);
    if (options.clear !== false && this.sink) {
      // Writer commands commit in order, so a checkpoint write already submitted lands before this clear.
      this.sink.clear(turn.botId, turn.turnId).catch((error) => this.fail(error));
    }
    return true;
  }

  running(botId: string): RunningTurn | null {
    const turn = this.turns.get(streamOf(botId));
    return turn ? { botId: turn.botId, turnId: turn.turnId, seg: turn.seg, text: turn.text, turnText: turn.prior + turn.text } : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Session side

  /**
   * A reader of `stream` whose log cursor is at the head. If a turn runs, its first frame (the whole current segment,
   * `at = 0`) goes out now.
   */
  subscribe(stream: StreamId, send: LiveSend): LiveSubscription {
    const channel = this;
    const sub: Sub = {
      stream, send, rev: 0, sentTurn: null, sentSeg: -1, sentText: "", lastAt: -Infinity, timer: null, needFull: true, force: true, isClosed: false,
      get closed() { return sub.isClosed; },
      resync() {
        if (sub.isClosed) return;
        sub.needFull = true;
        sub.force = true;
        channel.schedule(sub);
      },
      close() {
        if (sub.isClosed) return;
        sub.isClosed = true;
        channel.cancel(sub);
        const set = channel.subs.get(stream);
        set?.delete(sub);
        if (set && !set.size) channel.subs.delete(stream);
      },
    };
    if (this.closed) { sub.isClosed = true; return sub; }
    let set = this.subs.get(stream);
    if (!set) this.subs.set(stream, (set = new Set()));
    set.add(sub);
    this.flush(sub);
    return sub;
  }

  /** Shutdown or crash: stop every timer and send nothing more; checkpoints stay for recovery. */
  close(): void {
    this.closed = true;
    for (const turn of this.turns.values()) {
      turn.ended = true;
      if (turn.checkpointTimer) this.clock.clearTimeout(turn.checkpointTimer);
      turn.checkpointTimer = null;
    }
    this.turns.clear();
    for (const set of this.subs.values()) for (const sub of set) { this.cancel(sub); sub.isClosed = true; }
    this.subs.clear();
  }

  // ---------------------------------------------------------------------------------------------

  private turn(botId: string, turnId: string): Turn | null {
    const turn = this.turns.get(streamOf(botId));
    return turn && turn.turnId === turnId ? turn : null;
  }

  private changed(turn: Turn): void {
    turn.version += 1;
    for (const sub of this.subs.get(turn.stream) ?? []) this.schedule(sub);
  }

  private schedule(sub: Sub): void {
    if (sub.timer || sub.isClosed || this.closed) return;
    const wait = sub.lastAt + this.interval - this.clock.now();
    if (wait <= 0) { this.flush(sub); return; }
    sub.timer = this.clock.setTimeout(() => { sub.timer = null; this.flush(sub); }, wait);
  }

  private cancel(sub: Sub): void {
    if (sub.timer) this.clock.clearTimeout(sub.timer);
    sub.timer = null;
  }

  /** Sends what the subscriber has not seen of the current segment, as one frame (or consecutive ones if too big). */
  private flush(sub: Sub): void {
    if (sub.isClosed || this.closed) return;
    const turn = this.turns.get(sub.stream);
    if (!turn) return;
    let at: number;
    if (sub.needFull || sub.sentTurn !== turn.turnId || sub.sentSeg !== turn.seg) {
      if (!turn.text && !sub.force) return; // an empty new segment: wait for its text
      at = 0;
    } else {
      if (turn.text === sub.sentText) return;
      at = turn.text.startsWith(sub.sentText) ? sub.sentText.length : commonPrefix(sub.sentText, turn.text);
    }
    const frames: LiveFrame[] = [];
    for (const piece of splitUnits(turn.text.slice(at), this.maxUnits)) {
      frames.push({ t: "live", stream: sub.stream, turnId: turn.turnId, seg: turn.seg, rev: ++sub.rev, at, text: piece });
      at += piece.length;
    }
    // State first: a send may call back in (a receiver's resync), and must find this frame already counted.
    sub.sentTurn = turn.turnId;
    sub.sentSeg = turn.seg;
    sub.sentText = turn.text;
    sub.needFull = false;
    sub.force = false;
    sub.lastAt = this.clock.now();
    for (const frame of frames) {
      if (sub.isClosed || this.closed) return;
      try {
        sub.send(frame);
      } catch (error) {
        this.fail(error);
      }
    }
  }

  private armCheckpoint(turn: Turn): void {
    if (!this.sink || turn.ended) return;
    turn.checkpointTimer = this.clock.setTimeout(() => {
      turn.checkpointTimer = null;
      if (turn.ended) return;
      if (turn.version !== turn.checkpointed) this.writeCheckpoint(turn);
      this.armCheckpoint(turn);
    }, this.checkpointInterval);
  }

  private writeCheckpoint(turn: Turn): void {
    if (!this.sink || turn.ended) return;
    // Writes commit in order (the store's writer is FIFO), so a newer one may follow an unfinished one; only a writer
    // stalled for whole intervals makes ticks wait, and the next one after it settles takes the newest text.
    if (turn.writing >= MAX_CHECKPOINTS_IN_FLIGHT) { turn.tickWaiting = true; return; }
    const checkpoint: LiveCheckpoint = { botId: turn.botId, turnId: turn.turnId, text: turn.prior + turn.text, at: this.clock.now() };
    turn.checkpointed = turn.version;
    turn.writing += 1;
    this.sink.write(checkpoint).catch((error) => {
      turn.checkpointed = -1; // try again at the next tick
      this.fail(error);
    }).finally(() => {
      turn.writing -= 1;
      if (turn.tickWaiting && !turn.ended) {
        turn.tickWaiting = false;
        if (turn.version !== turn.checkpointed) this.writeCheckpoint(turn);
      }
    });
  }

  private fail(error: unknown): void {
    try { this.options.onError?.(error); } catch { /* an observer must not break the channel */ }
  }
}

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a.charCodeAt(index) === b.charCodeAt(index)) index++;
  return index;
}

/** Splits into pieces of at most `max` code units without cutting a surrogate pair. Always at least one piece. */
export function splitUnits(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1; // a high surrogate: keep the pair together
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}
