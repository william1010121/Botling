// Detail on demand: pass-through of front ends' subscriptions to peers' bots (M3 step 8, protocol v1 §10.2–§10.5,
// §8.3, §8.4, D50, D58).
//
// The attached side (`PassThrough`, server S). A front end on S sends `sub{bot:X, cursor}` for a bot that peer B owns
// (the directory, server/forward/directory.ts, names B):
//
//   1. S opens a *leg* for that subscription with a tag `via` of its own and, while it has a session with B, forwards
//      `sub{bot:X, cursor, via}`. B serves it from its store like any reader (its LogReader: snap / batches / reset,
//      paging and the 1 MiB window of §10.4); every frame comes back tagged with `via`.
//   2. S takes `via` off and relays the frame unchanged to that front end, keeps it in its cache (peer-log-cache.ts:
//      the snap and the entries after it, hash chain checked) and moves the leg's cursor. The front end's `ack` goes
//      on to B with the leg's `via`, so B's window is the front end's window.
//      The leg is the front end's guard, too: a batch that does not follow the leg's cursor in its logId, a snap older
//      than the cursor, or any frame of a logId the leg knows as retired is not relayed (the leg asks B again from its
//      cursor). So the front end never gets an entry at or below its cursor in one logId, never an older snapshot,
//      never a retired logId (D50), whatever a late or repeated frame says.
//   3. B unreachable (no session, and the registry says stale): S serves its cache from the leg's cursor, then
//      `stale{stream, since}` with S's own time of the last frame from B (§10.5; no clock compared across machines).
//      When a session with B opens again, every leg re-subscribes from its cursor: no gap, no duplicate.
//   4. The front end closes the bot (unsub, or its session ends): S keeps a subscription of its own, a *keeper* leg
//      whose batches it acknowledges itself, for 10 minutes (quick re-open), then unsubscribes unless the bot is
//      followed (`followedBots`, a preference shared by all servers); followed bots are kept subscribed while a
//      session with their owner exists.
//   `history` pages go to B under a request id of S's and come back with the front end's own id.
//
// S never builds bot state; it stores and relays frames.
//
// Live text (§9, M3 live across servers): a front-end leg also carries the running turn's `live` frames. B's owner side
// subscribes each forwarded `sub` to its live channel (≤ 10 frames/s per turn and subscription, first frame the whole
// segment) and tags the frames with the leg's `via`. S keeps the latest segment of the leg's running turn in memory
// (§9.2 "each server on the path"): a LiveReceiver applies B's frames, and a LiveChannel of the leg's own (no
// checkpoints) re-sends that text to the front end's session, whose LiveGate keeps the connection at ≤ 10 frames/s.
// So S paces the front end by its own clock (jitter on the peer hop never makes the gate drop a frame), answers the
// front end's `live.resync` (and its gate's) at once from memory, and after a lost session sends only what changed
// while it was away. Only a frame S itself cannot apply makes S ask B (`live.resync`, tagged). S drops its copy of a
// turn when it relays that turn's `turn.finished` / `turn.interrupted` entry, so the entries replace the live text.
// Live frames are never stored or cached: when B's queue to S is over PEER_LIVE_SOFT_BYTES, B drops live frames (never
// entries) and, once the queue drained, sends the whole segment again. After a lost session, the re-sent `sub` starts a
// new live subscription whose first frame is the whole segment. Keeper legs ask B for no live frames (`sub.live: false`).
//
// The owner side (`PassThroughOwner`, server B): a peer's tagged `sub` / `ack` / `unsub` drive one LogReader per
// (session, via), whose frames go back with the tag; `history` is answered from the store. They end with the session.
import type { Cursor, LogId, Message, MessageOf, StreamId, WireMessage } from "../../protocol";
import { LiveChannel, LiveReceiver, type Clock, type LiveFrame, type LiveSubscription } from "../live";
import type { LogHub, LogReader } from "../log";
import { readHistory } from "../log/snap";
import { readStream } from "../log/log-store";
import type { PeerLogCache } from "./peer-log-cache";

/** v1 §10.3 step 4: S keeps its own subscription this long after the last front end closed the bot. */
export const KEEP_AFTER_CLOSE_MS = 10 * 60 * 1000;

/** A peer session as pass-through uses it (server/peer PeerSession). */
export interface PassThroughSession {
  readonly peer: string | null;
  readonly state: string;
  /** Bytes queued toward the peer (live frames back off above LIVE_SOFT_BYTES); absent: never backs off. */
  readonly queuedBytes?: number;
  sendWire(message: WireMessage): boolean;
}

/** Above this many bytes queued toward a peer, the owner drops live frames and resends the whole segment later. */
export const PEER_LIVE_SOFT_BYTES = 256 * 1024;
/** How often a dropped live subscription looks again whether the queue drained. */
export const PEER_LIVE_RETRY_MS = 100;

/** The owner's live channel as the owner side uses it (server/live LiveChannel). */
export interface PassThroughLive {
  subscribe(stream: StreamId, send: (frame: LiveFrame) => void): LiveSubscription;
}

/** A front end's subscription to a peer's bot, as session-core holds it. */
export interface PassThroughLeg {
  ack(cursor: Cursor): void;
  /** The front end's receiver lost track (`live.resync`, or its gate): the whole current segment, from this server's copy. */
  liveResync(): void;
  close(): void;
}

/** Where a leg's live frames go (the front end session's LiveGate send); frames come without `via`. */
export type LiveSink = (frame: LiveFrame) => void;

export interface PassThroughOptions {
  cache: PeerLogCache;
  /** The peer that owns `stream`, or null (this server, or nobody it knows). */
  ownerOf(stream: string): string | null;
  /** The open full session with `peer`, if any. */
  session(peer: string): PassThroughSession | null;
  /** The registry's view of `peer` (live / stale since T / gone). */
  peerState(peer: string): { state: string; since: number | null } | null;
  /** True when the bot of `stream` is followed. */
  followed(stream: string): boolean;
  keepMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Timers (injected in tests for the 10-minute keep). */
  schedule?: (run: () => void, ms: number) => () => void;
  /** The clock of the legs' live copies (injected in tests). */
  liveClock?: Clock;
}

type Sink = (message: Message) => boolean;

interface Leg {
  via: string;
  stream: string;
  owner: string;
  /** The front end's sink; null for a keeper (S's own subscription). */
  sink: Sink | null;
  /** The front end's live sink; null for a keeper, or a front end that takes no live frames. */
  live: LiveSink | null;
  /** This server's copy of the running turn's text and the front end's subscription to it (with `live`). */
  mirror: LiveMirror | null;
  /** Last position relayed to the front end (or taken by the keeper); null: nothing yet / a snap is due. */
  cursor: Cursor | null;
  /** LogIds this leg saw retired (from relayed resets and the cache). */
  retired: Set<string>;
  /** The session the leg's `sub` went on, while it is open. */
  session: PassThroughSession | null;
  /** The `since` of the last `stale` sent to the front end (null: none since the last frame). */
  staleSent: number | null;
  /** Work of this leg runs one after another (a cache serve, then the upstream sub). */
  chain: Promise<void>;
  closed: boolean;
  stopTimer: (() => void) | null;
}

/** A leg's copy of the owner's running turn (§9.2): B's frames in, paced frames to the front end out. */
interface LiveMirror {
  receiver: LiveReceiver;
  channel: LiveChannel;
  sub: LiveSubscription;
  /** The turn the channel runs now, and its segment. */
  turnId: string | null;
  seg: number;
}

const attached = (leg: Leg): boolean => leg.session !== null && leg.session.state === "open";

const defaultSchedule = (run: () => void, ms: number) => { const timer = setTimeout(run, ms); timer.unref?.(); return () => clearTimeout(timer); };

export class PassThrough {
  private readonly legs = new Map<string, Leg>();
  private readonly keepers = new Map<string, Leg>();
  private readonly histories = new Map<string, { sink: Sink; req: string; stream: string; session: PassThroughSession }>();
  private nextId = 1;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  /** Counters (tests, status). */
  readonly counts = { relayed: 0, dropped: 0, resubscribed: 0, servedFromCache: 0, stale: 0, keepersStopped: 0, liveRelayed: 0, liveDropped: 0, liveResyncs: 0 };

  constructor(private readonly options: PassThroughOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /** True when `stream` is a bot a peer owns (its detail comes through pass-through). */
  isPeerStream(stream: string): boolean {
    return stream.startsWith("bot:") && this.options.ownerOf(stream) !== null;
  }

  /** Eviction priority for the cache: 0 idle, 1 in use (a front end or a keeper), 2 followed. */
  priority(stream: string): number {
    if (this.options.followed(stream)) return 2;
    return this.keepers.has(stream) || [...this.legs.values()].some((leg) => leg.stream === stream) ? 1 : 0;
  }

  /** Front-end legs and keepers now (tests, status). */
  legCount(stream?: string): { fe: number; keepers: number } {
    const fe = [...this.legs.values()].filter((leg) => leg.sink && (!stream || leg.stream === stream)).length;
    const keepers = stream ? (this.keepers.has(stream) ? 1 : 0) : this.keepers.size;
    return { fe, keepers };
  }

  /**
   * A front end subscribes to a peer's bot from `cursor`; `sink` gets frames as the owner sent them (no via), `live`
   * the running turn's live frames (no via).
   */
  open(stream: string, cursor: Cursor | null, sink: Sink, live: LiveSink | null = null): PassThroughLeg {
    const owner = this.options.ownerOf(stream);
    if (!owner) throw new Error(`pass-through: no peer owns ${stream}`);
    this.stopKeeper(stream);
    const leg = this.makeLeg(stream, owner, cursor, sink, live);
    this.options.cache.touch(stream);
    const session = this.liveSession(owner);
    if (session) this.attach(leg, session);
    else if (this.isStale(owner)) this.serveCache(leg);
    // (Live in the registry with no session: between a session and its redial; `sessionOpened` or the stale state comes.)
    return {
      ack: (at) => this.ack(leg, at),
      liveResync: () => this.liveResync(leg),
      close: () => this.closeLeg(leg),
    };
  }

  /** A front end asks for older lines of a peer's bot (§8.4). */
  history(request: MessageOf<"history">, sink: Sink): void {
    const owner = this.options.ownerOf(request.stream);
    const session = owner ? this.liveSession(owner) : null;
    if (session) {
      const id = `pt.h${this.nextId++}`;
      this.histories.set(id, { sink, req: request.req, stream: request.stream, session });
      if (session.sendWire({ ...request, req: id } as WireMessage)) return;
      this.histories.delete(id);
    }
    this.unanswerable(request.req, request.stream, sink);
  }

  /** A full session with a peer opened: legs re-subscribe from their cursors; followed bots get keepers. */
  sessionOpened(session: PassThroughSession): void {
    const peer = session.peer;
    if (!peer) return;
    for (const leg of [...this.legs.values()]) if (leg.owner === peer && !leg.closed) this.attach(leg, session);
    this.ensureFollowed();
  }

  /** A session ended: its legs wait for the next one; open history requests are answered as unanswerable. */
  sessionClosed(session: PassThroughSession): void {
    for (const leg of this.legs.values()) if (leg.session === session) leg.session = null;
    for (const [id, pending] of [...this.histories]) {
      if (pending.session !== session) continue;
      this.histories.delete(id);
      this.unanswerable(pending.req, pending.stream, pending.sink);
    }
  }

  /** The registry's state of `peer` changed: when it is not live, front-end legs get the cache, then `stale{since}`. */
  peerStateChanged(peer: string, state: string, since: number | null): void {
    if (state === "live") return;
    for (const leg of [...this.legs.values()]) {
      if (leg.owner !== peer || !leg.sink || leg.closed || attached(leg)) continue;
      leg.session = null;
      this.serveCache(leg, since);
    }
  }

  /** Followed bots changed: keepers start for followed bots of reachable owners; others get their 10-minute timer. */
  ensureFollowed(streams: readonly string[] = []): void {
    for (const stream of streams) {
      if (!stream.startsWith("bot:") || this.keepers.has(stream) || [...this.legs.values()].some((leg) => leg.stream === stream && leg.sink)) continue;
      if (this.options.ownerOf(stream)) this.startKeeper(stream);
    }
    for (const keeper of this.keepers.values()) {
      if (this.options.followed(keeper.stream)) { keeper.stopTimer?.(); keeper.stopTimer = null; } else if (!keeper.stopTimer) this.armKeeper(keeper);
    }
  }

  /** A frame from a peer; false when it is not pass-through's (the caller hands it on). */
  onMessage(session: PassThroughSession, message: WireMessage): boolean {
    if (message.t === "history.page") {
      const pending = this.histories.get(message.req);
      if (!pending) return false;
      this.histories.delete(message.req);
      if (pending.session !== session) return true;
      pending.sink({ ...message, req: pending.req } as Message);
      return true;
    }
    if (message.t === "live" && message.via !== undefined) { this.takeLive(session, message as LiveFrame & { via: string }); return true; }
    if ((message.t !== "snap" && message.t !== "batch" && message.t !== "reset") || message.via === undefined) return false;
    const leg = this.legs.get(message.via);
    if (!leg || leg.closed || leg.session !== session || leg.stream !== message.stream) {
      // A frame for a leg that closed (its unsub crossed it), or of an older subscription with the same tag: dropped.
      this.counts.dropped++;
      if (!leg && session.state === "open") session.sendWire({ t: "unsub", stream: message.stream, via: message.via } as WireMessage);
      return true;
    }
    const { via: _via, ...frame } = message as Message & { via?: string };
    this.take(leg, frame as Message);
    return true;
  }

  close(): void {
    for (const leg of [...this.legs.values()]) { leg.closed = true; leg.stopTimer?.(); leg.mirror?.channel.close(); }
    this.legs.clear();
    this.keepers.clear();
    this.histories.clear();
  }

  // ---------------------------------------------------------------------------------------------

  /** A live frame of a leg: relayed without `via` while the leg is on that session, else dropped (never stored). */
  private takeLive(session: PassThroughSession, message: LiveFrame & { via: string }): void {
    const leg = this.legs.get(message.via);
    if (!leg || leg.closed || leg.session !== session || leg.stream !== message.stream || !leg.mirror) { this.counts.liveDropped++; return; }
    const { via: _via, ...frame } = message;
    const mirror = leg.mirror!;
    const result = mirror.receiver.apply(frame as LiveFrame);
    if (result === "resync") {
      // A frame this copy cannot place: ask the owner for the whole segment (the front end keeps what it has meanwhile).
      this.counts.liveResyncs++;
      session.sendWire({ t: "live.resync", stream: leg.stream as StreamId, via: leg.via } as WireMessage);
      return;
    }
    if (result !== "applied") return;
    this.counts.liveRelayed++;
    const view = mirror.receiver.view(leg.stream)!;
    const botId = leg.stream.slice(4);
    try {
      if (mirror.turnId !== view.turnId || view.seg < mirror.seg) {
        mirror.channel.start(botId, view.turnId);
        mirror.turnId = view.turnId;
        mirror.seg = 0;
      }
      while (mirror.seg < view.seg) { mirror.channel.step(botId, view.turnId); mirror.seg++; }
      mirror.channel.replace(botId, view.turnId, view.text);
    } catch (error) { this.log(`pass-through: live of ${leg.stream}: ${String((error as Error)?.message ?? error)}`); }
  }

  /** The leg relayed an entry that ends a turn: the entries replace its live text, so the copy is dropped. */
  private endLive(leg: Leg, frame: Message): void {
    const mirror = leg.mirror;
    if (!mirror?.turnId || frame.t !== "batch") return;
    for (const entry of frame.entries) {
      if (entry.kind !== "turn.finished" && entry.kind !== "turn.interrupted") continue;
      const turnId = (entry.body as { turnId?: unknown } | null)?.turnId;
      if (!mirror.turnId || turnId !== mirror.turnId) continue;
      mirror.channel.end(leg.stream.slice(4), mirror.turnId);
      mirror.receiver.drop(leg.stream);
      mirror.turnId = null;
      mirror.seg = 0;
    }
  }

  private liveResync(leg: Leg): void {
    if (leg.closed || !leg.mirror) return;
    leg.mirror.sub.resync();
  }

  private makeMirror(stream: string, live: LiveSink): LiveMirror {
    const channel = new LiveChannel({ sink: null, ...(this.options.liveClock ? { clock: this.options.liveClock } : {}), onError: (error) => this.log(`pass-through: live of ${stream}: ${String((error as Error)?.message ?? error)}`) });
    const sub = channel.subscribe(stream as StreamId, live);
    return { receiver: new LiveReceiver(), channel, sub, turnId: null, seg: 0 };
  }

  private makeLeg(stream: string, owner: string, cursor: Cursor | null, sink: Sink | null, live: LiveSink | null = null): Leg {
    const via = `pt.${this.nextId++}`;
    const retired = new Set<string>();
    for (const old of this.options.cache.get(stream)?.retired.list ?? []) retired.add(old.logId);
    const leg: Leg = { via, stream, owner, sink, live, mirror: live ? this.makeMirror(stream, live) : null, cursor, retired, session: null, staleSent: null, chain: Promise.resolve(), closed: false, stopTimer: null };
    this.legs.set(via, leg);
    return leg;
  }

  private liveSession(peer: string): PassThroughSession | null {
    const session = this.options.session(peer);
    return session && session.state === "open" ? session : null;
  }

  private isStale(peer: string): boolean {
    const state = this.options.peerState(peer);
    return !state || state.state !== "live";
  }

  private run(leg: Leg, work: () => void | Promise<void>): void {
    leg.chain = leg.chain.then(async () => { if (!leg.closed) await work(); }).catch((error) => this.log(`pass-through: ${leg.stream}: ${String((error as Error)?.message ?? error)}`));
  }

  /** Sends the leg's `sub` on `session` (after any cache serve still running for it). */
  private attach(leg: Leg, session: PassThroughSession): void {
    leg.session = session;
    this.run(leg, () => {
      if (leg.session !== session || session.state !== "open") return;
      session.sendWire(this.subFrame(leg));
    });
  }

  /** The leg's forwarded `sub`; a leg with no live sink (a keeper) asks for no live frames. */
  private subFrame(leg: Leg): WireMessage {
    return { t: "sub", stream: leg.stream as StreamId, cursor: leg.cursor, via: leg.via, ...(leg.live ? {} : { live: false }) } as WireMessage;
  }

  /** Owner unreachable: what the cache has above the leg's cursor, then `stale{since}` (once per `since`). */
  private serveCache(leg: Leg, since?: number | null): void {
    if (!leg.sink) return;
    this.run(leg, async () => {
      if (attached(leg)) return;
      const frames = await this.options.cache.frames(leg.stream, leg.cursor);
      if (attached(leg) || leg.closed) return;
      for (const frame of frames) {
        if (!this.guard(leg, frame)) break;
        this.counts.servedFromCache++;
        this.advance(leg, frame);
        leg.sink!(frame);
        this.endLive(leg, frame);
      }
      const at = since ?? this.options.peerState(leg.owner)?.since ?? this.options.cache.get(leg.stream)?.heardAt ?? this.now();
      if (leg.staleSent === at) return;
      leg.staleSent = at;
      this.counts.stale++;
      leg.sink!({ t: "stale", stream: leg.stream as StreamId, since: at } as MessageOf<"stale">);
    });
  }

  /** True when `frame` may reach the front end at the leg's cursor (monotonic, never a retired logId, §8.3, D50). */
  private guard(leg: Leg, frame: Message): boolean {
    const cursor = leg.cursor;
    if (frame.t === "reset") {
      if (leg.retired.has(frame.logId)) return false;
      if (cursor && cursor.logId !== frame.logId && !frame.retired.some((old) => old.logId === cursor.logId)) return false;
      return !(cursor && cursor.logId === frame.logId);
    }
    if (frame.t === "snap") {
      if (leg.retired.has(frame.logId)) return false;
      if (!cursor) return true;
      if (cursor.logId !== frame.logId) return false; // another logId only after a reset (which sets the cursor to null… see advance)
      return frame.seq >= cursor.seq;
    }
    if (frame.t === "batch") {
      if (leg.retired.has(frame.logId) || !cursor || cursor.logId !== frame.logId) return false;
      return frame.from === cursor.seq + 1;
    }
    return false;
  }

  private advance(leg: Leg, frame: Message): void {
    leg.staleSent = null;
    if (frame.t === "reset") {
      for (const old of frame.retired) leg.retired.add(old.logId);
      leg.cursor = null; // the snap of the new logId follows
    } else if (frame.t === "snap") {
      leg.cursor = { logId: frame.logId, seq: frame.seq };
    } else if (frame.t === "batch") {
      leg.cursor = { logId: frame.logId, seq: frame.to };
    }
  }

  private take(leg: Leg, frame: Message): void {
    // The cache takes what the owner sent, whoever's leg it came on (its own rules keep it a prefix).
    const cache = this.options.cache;
    if (frame.t === "snap") cache.takeSnap(leg.owner, frame);
    else if (frame.t === "batch") cache.takeBatch(leg.owner, frame);
    else if (frame.t === "reset") cache.takeReset(leg.owner, frame);
    if (!this.guard(leg, frame)) {
      this.counts.dropped++;
      // A frame that does not follow the cursor: ask again from it (B answers from the cursor, with a reset if needed).
      if (frame.t === "batch" && leg.cursor && frame.logId === leg.cursor.logId && frame.to <= leg.cursor.seq) return; // a plain duplicate
      if (frame.t === "snap" && leg.cursor && frame.logId === leg.cursor.logId && frame.seq < leg.cursor.seq) return;
      if (leg.retired.has((frame as { logId: string }).logId)) return;
      this.counts.resubscribed++;
      const session = leg.session;
      if (session && session.state === "open") session.sendWire(this.subFrame(leg));
      return;
    }
    this.advance(leg, frame);
    this.counts.relayed++;
    if (leg.sink) { leg.sink(frame); this.endLive(leg, frame); return; }
    // A keeper acknowledges what it took itself, so the owner keeps pushing (§10.4).
    if (frame.t === "batch" && leg.session?.state === "open") leg.session.sendWire({ t: "ack", stream: leg.stream as StreamId, cursor: { logId: frame.logId, seq: frame.to }, via: leg.via } as WireMessage);
  }

  private ack(leg: Leg, cursor: Cursor): void {
    if (leg.closed || !leg.session || leg.session.state !== "open") return;
    leg.session.sendWire({ t: "ack", stream: leg.stream as StreamId, cursor, via: leg.via } as WireMessage);
  }

  private closeLeg(leg: Leg): void {
    if (leg.closed) return;
    leg.closed = true;
    leg.stopTimer?.();
    leg.mirror?.channel.close();
    this.legs.delete(leg.via);
    if (this.keepers.get(leg.stream) === leg) this.keepers.delete(leg.stream);
    if (leg.session && leg.session.state === "open") leg.session.sendWire({ t: "unsub", stream: leg.stream as StreamId, via: leg.via } as WireMessage);
    leg.session = null;
    if (leg.sink && ![...this.legs.values()].some((other) => other.stream === leg.stream && other.sink)) this.startKeeper(leg.stream);
  }

  private startKeeper(stream: string): void {
    if (this.keepers.has(stream)) return;
    const owner = this.options.ownerOf(stream);
    if (!owner) return;
    const keeper = this.makeLeg(stream, owner, this.options.cache.cursor(stream), null);
    this.keepers.set(stream, keeper);
    if (!this.options.followed(stream)) this.armKeeper(keeper);
    const session = this.liveSession(owner);
    if (session) this.attach(keeper, session);
  }

  private armKeeper(keeper: Leg): void {
    keeper.stopTimer?.();
    keeper.stopTimer = this.schedule(() => {
      keeper.stopTimer = null;
      if (keeper.closed || this.options.followed(keeper.stream)) return;
      this.counts.keepersStopped++;
      this.log(`pass-through: ${keeper.stream} not opened for ${Math.round((this.options.keepMs ?? KEEP_AFTER_CLOSE_MS) / 1000)} s and not followed: unsubscribed`);
      this.closeLeg(keeper);
    }, this.options.keepMs ?? KEEP_AFTER_CLOSE_MS);
  }

  private stopKeeper(stream: string): void {
    const keeper = this.keepers.get(stream);
    if (keeper) this.closeLeg(keeper);
  }

  /** No owner to ask: an empty page of the cache's logId that says more exists (asked again later), or nothing. */
  private unanswerable(req: string, stream: string, sink: Sink): void {
    const logId = this.options.cache.get(stream)?.logId;
    if (!logId) { this.log(`pass-through: history of ${stream} not answered (its owner is unreachable and nothing is cached)`); return; }
    sink({ t: "history.page", req, stream: stream as StreamId, logId: logId as LogId, messages: [], hasMore: true, older: 0 } as MessageOf<"history.page">);
  }
}

// ---------------------------------------------------------------------------------------------
// The owner side

export interface PassThroughOwnerOptions {
  hub: LogHub;
  /** A bot the engine has whose stream is not made yet: make it (true: the stream exists now). */
  ensureBotStream(botId: string): Promise<boolean>;
  /** The live channel: forwarded subscriptions get the running turn's live frames, tagged (null: none). */
  live?: PassThroughLive | null;
  /** Queued bytes toward the peer above which live frames are dropped (default PEER_LIVE_SOFT_BYTES). */
  liveSoftBytes?: number;
  liveRetryMs?: number;
  /** Timers (injected in tests). */
  schedule?: (run: () => void, ms: number) => () => void;
  log?: (line: string) => void;
}

/** One forwarded subscription at the owner: its log reader and, unless the peer asked for none, its live subscription. */
interface OwnerSub {
  reader: LogReader;
  live: LiveSubscription | null;
  /** Live frames were dropped (back-pressure): every frame is dropped until a whole-segment one (`at = 0`) goes. */
  liveBroken: boolean;
  /** The look-again timer while broken. */
  retry: (() => void) | null;
  closed: boolean;
}

export class PassThroughOwner {
  private readonly readers = new Map<PassThroughSession, Map<string, OwnerSub>>();
  private readonly log: (line: string) => void;
  private readonly schedule: (run: () => void, ms: number) => () => void;
  /** Counters (tests, status). */
  readonly counts = { liveSent: 0, liveDropped: 0, liveResent: 0 };

  constructor(private readonly options: PassThroughOwnerOptions) {
    this.log = options.log ?? (() => undefined);
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /** Readers open for peers now (tests). */
  readerCount(): number { let n = 0; for (const map of this.readers.values()) n += map.size; return n; }

  /** A peer's tagged `sub` / `ack` / `unsub` / `live.resync`, or its `history`; false when the frame is not this side's. */
  async onMessage(session: PassThroughSession, message: WireMessage): Promise<boolean> {
    if (message.t === "history") {
      if (!message.stream.startsWith("bot:")) return false;
      const db = this.options.hub.reader();
      const page = readHistory(db, message);
      if (page) { session.sendWire(page as WireMessage); return true; }
      const row = readStream(db, message.stream);
      if (row) session.sendWire({ t: "history.page", req: message.req, stream: message.stream, logId: row.logId, messages: [], hasMore: false, older: 0 } as WireMessage);
      return true;
    }
    if (message.t === "live.resync" && message.via !== undefined) {
      const sub = this.readers.get(session)?.get(message.via);
      sub?.live?.resync();
      return true;
    }
    if ((message.t !== "sub" && message.t !== "ack" && message.t !== "unsub") || message.via === undefined) return false;
    const via = message.via;
    let map = this.readers.get(session);
    if (message.t === "ack") { map?.get(via)?.reader.ack(message.stream, message.cursor); return true; }
    const old = map?.get(via);
    if (old) this.closeSub(old);
    map?.delete(via);
    if (message.t === "unsub") return true;
    if (!message.stream.startsWith("bot:")) { this.log(`pass-through: a forwarded sub of ${message.stream} from ${session.peer ?? "?"} is not served (bot streams only)`); return true; }
    if (!map) { map = new Map(); this.readers.set(session, map); }
    const sub: OwnerSub = { reader: null as unknown as LogReader, live: null, liveBroken: false, retry: null, closed: false };
    sub.reader = this.options.hub.attach((frame) => {
      if (session.state !== "open") return;
      session.sendWire({ ...frame, via } as WireMessage);
      // A reset makes the receiver start over: the whole segment again (as a front end's own session does).
      if (frame.t === "reset") sub.live?.resync();
    });
    map.set(via, sub);
    const stream = message.stream;
    const wantsLive = (message as { live?: false }).live !== false;
    let result = await sub.reader.sub(stream, message.cursor);
    if (!result.ok && result.reason === "unknown stream" && (await this.options.ensureBotStream(stream.slice(4)))) result = await sub.reader.sub(stream, message.cursor);
    if (!result.ok) {
      this.log(`pass-through: a forwarded sub of ${stream} from ${session.peer ?? "?"} refused (${result.reason})`);
      this.closeSub(sub);
      if (map.get(via) === sub) map.delete(via);
      return true;
    }
    // As a front end's session does (§9.4): the live subscription starts with the log one; its first frame is the whole
    // current segment, which a receiver always takes.
    if (wantsLive && !sub.closed && this.options.live && map.get(via) === sub) {
      sub.live = this.options.live.subscribe(stream, (frame) => this.sendLive(session, via, sub, frame));
    }
    return true;
  }

  sessionClosed(session: PassThroughSession): void {
    const map = this.readers.get(session);
    if (!map) return;
    for (const sub of map.values()) this.closeSub(sub);
    this.readers.delete(session);
  }

  close(): void {
    for (const map of this.readers.values()) for (const sub of map.values()) this.closeSub(sub);
    this.readers.clear();
  }

  /**
   * A live frame toward the peer. Under back-pressure (queue over the soft limit, or the send refused) it is dropped and
   * the subscription is broken: later frames are dropped too until the queue drained, when the whole segment is asked
   * again (`resync`) and goes as one frame with `at = 0`. Entries are never dropped here: they are the log reader's.
   */
  private sendLive(session: PassThroughSession, via: string, sub: OwnerSub, frame: LiveFrame): void {
    if (sub.closed || session.state !== "open") return;
    if (sub.liveBroken && frame.at !== 0) { this.counts.liveDropped++; return; }
    const queued = session.queuedBytes ?? 0;
    if (queued <= (this.options.liveSoftBytes ?? PEER_LIVE_SOFT_BYTES) && session.sendWire({ ...frame, via } as WireMessage)) {
      if (sub.liveBroken) { sub.liveBroken = false; this.counts.liveResent++; }
      this.counts.liveSent++;
      return;
    }
    this.counts.liveDropped++;
    sub.liveBroken = true;
    this.armRetry(session, sub);
  }

  private armRetry(session: PassThroughSession, sub: OwnerSub): void {
    if (sub.retry || sub.closed) return;
    sub.retry = this.schedule(() => {
      sub.retry = null;
      if (sub.closed || !sub.liveBroken || session.state !== "open") return;
      if ((session.queuedBytes ?? 0) > (this.options.liveSoftBytes ?? PEER_LIVE_SOFT_BYTES)) { this.armRetry(session, sub); return; }
      // The queue drained: the next frame is the whole segment (nothing goes if the turn ended meanwhile; the entries
      // then carry the text).
      sub.live?.resync();
    }, this.options.liveRetryMs ?? PEER_LIVE_RETRY_MS);
  }

  private closeSub(sub: OwnerSub): void {
    if (sub.closed) return;
    sub.closed = true;
    sub.retry?.();
    sub.retry = null;
    sub.live?.close();
    sub.live = null;
    sub.reader.close();
  }
}

/** Tests lower the peer cache and the keep time: `BOTLING_SERVER_PEER_CACHE=bytes=<n>,keep=<ms>`. */
export const PEER_CACHE_ENV = "BOTLING_SERVER_PEER_CACHE";

export function passThroughSettings(env: Record<string, string | undefined>): { capBytes?: number; keepMs?: number } {
  const text = (env[PEER_CACHE_ENV] ?? "").trim();
  const out: { capBytes?: number; keepMs?: number } = {};
  if (!text) return out;
  for (const part of text.split(",")) {
    const match = /^\s*(bytes|keep)\s*=\s*(\d{1,13})\s*$/.exec(part);
    if (!match) throw new Error(`${PEER_CACHE_ENV}: "${part}" is not bytes=<n> or keep=<ms>`);
    if (match[1] === "bytes") out.capBytes = Number(match[2]); else out.keepMs = Math.max(10, Number(match[2]));
  }
  return out;
}

/** The streams of the followed bots (`followedBots`: bot ids or `bot:<id>` names). */
export function followedStreams(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 200).map((item) => (item.startsWith("bot:") ? item : `bot:${item}`));
}
