// Pacing of botlingd's one relay connection (M2 step 13, protocol v1 §6.3, §9A.4, D36). The relay counts every message
// a connection sends and closes it above 50 messages/s (burst 200), and this one connection carries every device session
// of this server, so botlingd sends at most RELAY_PACE.rate messages/s (burst RELAY_PACE.burst): control and live frames
// first, content (bulk) frames with what is left and at most RELAY_PACE.contentRate per second.
//
// - Every message to the relay goes through here: the room hello, allow lists, `to` frames and `kick`s.
// - Each channel (one relay peer = one device session; `null` = the connection itself) is FIFO: its frames were sealed in
//   order and must arrive in order. Only a channel's head may go; among the heads, control first (round-robin over the
//   channels), then bulk while the content bucket has a token.
// - A channel holds at most `channelFrames` frames here: `writable(channel)` turns false at that depth, so the session
//   link keeps the rest in its own lane queues unsealed (a control frame queued later then still overtakes its waiting
//   bulk frames, waiting at most for the frames already here), and `onWritable` wakes it when a frame left.
// - The socket's own buffer is not let grow: while the connection's `bufferedAmount` is above `maxBuffered`, nothing is
//   sent (so paced frames do not pile up in a buffer and reach the relay in one bunch).
// No timer runs while nothing waits.

/** The limits (v1 §20: relay pacing per server). */
export const RELAY_PACE = { rate: 45, burst: 150, contentRate: 30, contentBurst: 30 } as const;
/** Frames one channel may have waiting here before its link holds the rest. */
export const CHANNEL_FRAMES = 2;
/** Socket bytes not yet written past which the pacer waits. */
export const MAX_SOCKET_BUFFER = 1024 * 1024;

export type PaceLane = "control" | "bulk";

/** A token bucket: `rate` per second, at most `burst` saved. */
export class PaceBucket {
  private tokens: number;
  private at: number;
  constructor(readonly rate: number, readonly burst: number, private readonly now: () => number) {
    this.tokens = burst;
    this.at = now();
  }
  private refill(): void {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate);
    this.at = now;
  }
  get available(): number { this.refill(); return this.tokens; }
  take(): boolean { this.refill(); if (this.tokens < 1) return false; this.tokens -= 1; return true; }
  /** Milliseconds until one token is there (0 now). */
  wait(): number { this.refill(); return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1000); }
}

interface Item { text: string; lane: PaceLane; after?: () => void }
interface Channel { id: string | null; items: Item[]; wake: (() => void) | null }

export interface RelayPacerOptions {
  /** Puts one message on the socket. */
  write(text: string): void;
  /** The socket's bytes not yet written (`ws.bufferedAmount`). */
  buffered?: () => number;
  now?: () => number;
  rate?: number;
  burst?: number;
  contentRate?: number;
  contentBurst?: number;
  channelFrames?: number;
  maxBuffered?: number;
}

/** What the pacer measured (status, tests, evidence). */
export interface PaceStats {
  sent: number;
  control: number;
  bulk: number;
  /** The most messages sent inside any 1 s window. */
  maxPerSecond: number;
  /** The most content messages sent inside any 1 s window. */
  maxBulkPerSecond: number;
  /** The fewest tokens the main bucket ever had left after a send (≥ 0 means the 45/150 budget was never overdrawn). */
  minTokens: number;
  waiting: number;
}

export class RelayPacer {
  private readonly now: () => number;
  private readonly all: PaceBucket;
  private readonly content: PaceBucket;
  private readonly channels = new Map<string | null, Channel>();
  private order: Array<string | null> = [];
  private turn = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private readonly recent: number[] = [];
  private readonly recentBulk: number[] = [];
  readonly stats: PaceStats = { sent: 0, control: 0, bulk: 0, maxPerSecond: 0, maxBulkPerSecond: 0, minTokens: Number.POSITIVE_INFINITY, waiting: 0 };

  constructor(private readonly options: RelayPacerOptions) {
    this.now = options.now ?? Date.now;
    this.all = new PaceBucket(options.rate ?? RELAY_PACE.rate, options.burst ?? RELAY_PACE.burst, this.now);
    this.content = new PaceBucket(options.contentRate ?? RELAY_PACE.contentRate, options.contentBurst ?? RELAY_PACE.contentBurst, this.now);
  }

  private channel(id: string | null): Channel {
    let channel = this.channels.get(id);
    if (!channel) { channel = { id, items: [], wake: null }; this.channels.set(id, channel); this.order.push(id); }
    return channel;
  }

  /** Queues one message on a channel (`null`: the connection's own messages, always control). */
  push(id: string | null, lane: PaceLane, text: string, after?: () => void): void {
    if (this.stopped) return;
    this.channel(id).items.push({ text, lane: id === null ? "control" : lane, ...(after ? { after } : {}) });
    this.stats.waiting++;
    this.pump();
  }

  /** Whether a channel's link may hand over another frame now. */
  writable(id: string): boolean {
    return !this.stopped && (this.channels.get(id)?.items.length ?? 0) < (this.options.channelFrames ?? CHANNEL_FRAMES);
  }

  /** Called (once) when the channel can take frames again. */
  onWritable(id: string, wake: () => void): void { this.channel(id).wake = wake; }

  /** Frames of a channel still here. */
  waiting(id: string | null): number { return this.channels.get(id)?.items.length ?? 0; }

  /** Forgets a channel and what it still had queued (its peer is gone). */
  drop(id: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    this.stats.waiting -= channel.items.length;
    this.channels.delete(id);
    this.order = this.order.filter((other) => other !== id);
  }

  /** Stops: nothing more is sent (the socket closed). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.channels.clear();
    this.order = [];
    this.stats.waiting = 0;
  }

  /** Socket room again (the caller saw its buffer drain). */
  kick(): void { this.pump(); }

  private next(bulkAllowed: boolean): Channel | null {
    const count = this.order.length;
    for (const wantBulk of bulkAllowed ? [false, true] : [false]) {
      for (let step = 0; step < count; step++) {
        const id = this.order[(this.turn + step) % count]!;
        const channel = this.channels.get(id)!;
        const head = channel.items[0];
        if (!head || (head.lane === "bulk") !== wantBulk) continue;
        this.turn = (this.turn + step + 1) % Math.max(1, count);
        return channel;
      }
    }
    return null;
  }

  private pump(): void {
    if (this.stopped || this.timer) return;
    while (!this.stopped) {
      if (this.stats.waiting === 0) return;
      if ((this.options.buffered?.() ?? 0) > (this.options.maxBuffered ?? MAX_SOCKET_BUFFER)) { this.later(20); return; }
      const allWait = this.all.wait();
      if (allWait > 0) { this.later(allWait); return; }
      const bulkOk = this.content.wait() === 0;
      const channel = this.next(bulkOk);
      if (!channel) {
        // Only bulk heads wait, and the content bucket is empty.
        this.later(Math.max(1, this.content.wait()));
        return;
      }
      const item = channel.items.shift()!;
      this.stats.waiting--;
      this.all.take();
      if (item.lane === "bulk") this.content.take();
      this.record(item.lane);
      this.options.write(item.text);
      item.after?.();
      if (channel.wake && channel.id !== null && this.writable(channel.id)) { const wake = channel.wake; channel.wake = null; wake(); }
    }
  }

  private later(ms: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, ms);
    this.timer.unref?.();
  }

  private record(lane: PaceLane): void {
    const now = this.now();
    const stats = this.stats;
    stats.sent++;
    if (lane === "bulk") stats.bulk++; else stats.control++;
    stats.minTokens = Math.min(stats.minTokens, this.all.available);
    const window = (list: number[]) => { list.push(now); while (list.length && now - list[0]! >= 1000) list.shift(); return list.length; };
    stats.maxPerSecond = Math.max(stats.maxPerSecond, window(this.recent));
    if (lane === "bulk") stats.maxBulkPerSecond = Math.max(stats.maxBulkPerSecond, window(this.recentBulk));
  }
}
