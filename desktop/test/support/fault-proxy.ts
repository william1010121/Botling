// A frame-level fault proxy on loopback, for the Botling 3 two-server tests (M3 brief §3, step 2). It sits between a
// dialer and an acceptor (server A's peer dialer and server B's `/v3/ws`, or any framed test endpoint), cuts each
// direction into frames (framed.ts: length-prefixed or WebSocket messages) and forwards each frame's original bytes,
// unless a fault says otherwise. Peer frames are encrypted end to end, so the proxy never looks inside or rewrites a
// frame: it can only drop, delay, duplicate, cut, black-hole and replay whole frames. A duplicated or replayed frame
// must end the session (protocol v1 §5.2); the self-test checks that with the real SessionLink.
//
//   const proxy = await FaultProxy.start({ target: portOfB, framing: "websocket", seed: 7 });
//   // dial proxy.port instead of B's port
//   proxy.drop("up")                 next client → target frame is not delivered
//   proxy.duplicate("down", 2)       the next two target → client frames are delivered twice each
//   proxy.delay("up", 200, 3)        the next three frames go 200 ms late (and the ones behind them wait: order kept)
//   proxy.cut()                      every connection is closed at both ends (both see the close)
//   proxy.halfOpen("up")             frames up vanish, the sockets stay open (heal() ends it)
//   proxy.partition()                both directions black-holed; new dials are accepted and held, not connected;
//                                    heal() connects the held ones and lets frames pass again (what was sent during
//                                    the partition on old connections is lost)
//   await proxy.replay(conn)         a NEW connection to the target carrying every client frame the old one sent
//                                    (whole-session replay, upgrade head included)
//   proxy.schedule({ drop: 0.05, duplicate: 0.02, delay: { p: 0.1, ms: 50 } })
//                                    random faults per frame from a seeded PRNG (same seed, same decisions)
//
// "up" is client → target (dialer → acceptor), "down" the reverse. WebSocket control frames (ping, pong, close) and the
// HTTP upgrade head are never faulted, only black-holed by a partition or half-open. Every decision is logged in
// `events`, so a test can say exactly what the far side should have seen. Listens on 127.0.0.1 only, dials 127.0.0.1.
import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { LOOPBACK, splitter, type Framing, type WireUnit } from "./framed";

export type Direction = "up" | "down";
export type FaultAction = "pass" | "drop" | "duplicate" | "delay" | "blackhole" | "held" | "cut" | "replay" | "open" | "close";

export interface ProxyEvent {
  at: number;
  conn: number;
  dir: Direction | null;
  action: FaultAction;
  bytes: number;
  /** The frame's payload, for predicates in tests (decrypted content never appears: frames are ciphertext). */
  payload?: Buffer;
}

export type FramePredicate = (payload: Buffer, conn: number) => boolean;

export interface ScheduleOptions {
  /** Probability per data frame of each fault; checked in this order (drop, then duplicate, then delay). */
  drop?: number;
  duplicate?: number;
  delay?: { p: number; ms: number };
  /** Directions the schedule applies to (default both). */
  dirs?: Direction[];
}

export interface FaultProxyOptions {
  /** The target port on 127.0.0.1. */
  target: number;
  framing: Framing;
  /** Seed of the PRNG behind `schedule` (default 1). */
  seed?: number;
  /** Keep each event's payload (default true; turn off for long runs). */
  keepPayloads?: boolean;
}

interface Pending { action: "drop" | "duplicate" | "delay"; left: number; ms: number; match?: FramePredicate }

interface Pipe {
  id: number;
  client: Socket;
  upstream: Socket | null;
  /** Client bytes recorded for replay (each raw unit, in order). */
  sentUp: Buffer[];
  /** Units waiting for the upstream connection. */
  waiting: Buffer[];
  held: boolean;
  out: Record<Direction, Promise<void>>;
  closed: boolean;
}

/** mulberry32: small, seeded, good enough for test schedules. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class FaultProxy {
  static async start(options: FaultProxyOptions): Promise<FaultProxy> {
    const proxy = new FaultProxy(options);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once("error", reject);
      proxy.server.listen(0, LOOPBACK, () => { proxy.server.off("error", reject); resolve(); });
    });
    return proxy;
  }

  readonly events: ProxyEvent[] = [];
  private readonly server: Server;
  private readonly pipes = new Map<number, Pipe>();
  private readonly pending: Record<Direction, Pending[]> = { up: [], down: [] };
  private readonly random: () => number;
  private plan: ScheduleOptions | null = null;
  private partitioned = false;
  private readonly halfOpenDirs = new Set<Direction>();
  private nextId = 1;
  private closing = false;

  private constructor(private readonly options: FaultProxyOptions) {
    this.random = seededRandom(options.seed ?? 1);
    this.server = createServer((client) => this.accept(client));
  }

  get port(): number { return (this.server.address() as AddressInfo).port; }
  get address(): string { return (this.server.address() as AddressInfo).address; }
  get url(): string { return `ws://${LOOPBACK}:${this.port}`; }
  /** Ids of the connections still open at both ends (or held by a partition). */
  get open(): number[] { return [...this.pipes.values()].filter((pipe) => !pipe.closed).map((pipe) => pipe.id); }
  get isPartitioned(): boolean { return this.partitioned; }

  /** Events of one action (and direction), for assertions. */
  count(action: FaultAction, dir?: Direction): number {
    return this.events.filter((event) => event.action === action && (dir === undefined || event.dir === dir)).length;
  }

  drop(dir: Direction, count = 1, match?: FramePredicate): this { this.pending[dir].push({ action: "drop", left: count, ms: 0, match }); return this; }
  duplicate(dir: Direction, count = 1, match?: FramePredicate): this { this.pending[dir].push({ action: "duplicate", left: count, ms: 0, match }); return this; }
  delay(dir: Direction, ms: number, count = 1, match?: FramePredicate): this { this.pending[dir].push({ action: "delay", left: count, ms, match }); return this; }

  /** Random faults on every data frame from now on (seeded); `null` stops them. */
  schedule(plan: ScheduleOptions | null): this { this.plan = plan; return this; }

  /** Closes every connection at both ends. */
  cut(): void {
    for (const pipe of this.pipes.values()) if (!pipe.closed) { this.log(pipe.id, null, "cut", 0); this.closePipe(pipe); }
  }

  halfOpen(dir: Direction): void { this.halfOpenDirs.add(dir); }

  partition(): void { this.partitioned = true; }

  /** Ends a partition and any half-open direction; held connections are connected now. */
  heal(): void {
    this.partitioned = false;
    this.halfOpenDirs.clear();
    for (const pipe of this.pipes.values()) if (pipe.held && !pipe.closed) { pipe.held = false; this.connectUpstream(pipe); }
  }

  /** Opens a new connection to the target and sends it every client frame `conn` sent (default: the last one). */
  async replay(conn?: number): Promise<number> {
    const source = conn !== undefined ? this.pipes.get(conn) : [...this.pipes.values()].at(-1);
    if (!source) throw new Error("no connection to replay");
    const id = this.nextId++;
    const upstream = createConnection({ host: LOOPBACK, port: this.options.target });
    upstream.setNoDelay(true);
    await new Promise<void>((resolve, reject) => { upstream.once("connect", () => resolve()); upstream.once("error", reject); });
    upstream.on("error", () => upstream.destroy());
    upstream.on("data", () => undefined); // answers to a replay go nowhere
    const fake: Pipe = { id, client: upstream, upstream, sentUp: [], waiting: [], held: false, out: { up: Promise.resolve(), down: Promise.resolve() }, closed: false };
    this.pipes.set(id, fake);
    upstream.on("close", () => { if (!fake.closed) { fake.closed = true; this.log(id, null, "close", 0); } });
    this.log(id, "up", "replay", source.sentUp.reduce((sum, raw) => sum + raw.length, 0));
    for (const raw of source.sentUp) upstream.write(raw);
    return id;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const pipe of this.pipes.values()) this.closePipe(pipe);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(client: Socket): void {
    if (this.closing) { client.destroy(); return; }
    client.setNoDelay(true);
    const pipe: Pipe = {
      id: this.nextId++, client, upstream: null, sentUp: [], waiting: [], held: this.partitioned,
      out: { up: Promise.resolve(), down: Promise.resolve() }, closed: false,
    };
    this.pipes.set(pipe.id, pipe);
    this.log(pipe.id, null, this.partitioned ? "held" : "open", 0);
    const up = splitter(this.options.framing);
    client.on("data", (chunk: Buffer) => {
      let units: WireUnit[];
      try { units = up.push(chunk); } catch { this.closePipe(pipe); return; }
      for (const unit of units) this.route(pipe, "up", unit);
    });
    client.on("error", () => this.closePipe(pipe));
    client.on("close", () => this.closePipe(pipe));
    if (!pipe.held) this.connectUpstream(pipe);
  }

  private connectUpstream(pipe: Pipe): void {
    const upstream = createConnection({ host: LOOPBACK, port: this.options.target });
    upstream.setNoDelay(true);
    pipe.upstream = upstream;
    const down = splitter(this.options.framing);
    upstream.on("connect", () => {
      for (const raw of pipe.waiting.splice(0)) upstream.write(raw);
    });
    upstream.on("data", (chunk: Buffer) => {
      let units: WireUnit[];
      try { units = down.push(chunk); } catch { this.closePipe(pipe); return; }
      for (const unit of units) this.route(pipe, "down", unit);
    });
    upstream.on("error", () => this.closePipe(pipe));
    upstream.on("close", () => this.closePipe(pipe));
  }

  /** Decides one unit's fate and queues its delivery in order behind the units before it. */
  private route(pipe: Pipe, dir: Direction, unit: WireUnit): void {
    if (pipe.closed) return;
    if (dir === "up") pipe.sentUp.push(unit.raw);
    if (pipe.held) {
      // A dial during a partition: the bytes wait in the client's kernel in real life, so they wait here.
      this.log(pipe.id, dir, "held", unit.raw.length, unit.payload);
      pipe.waiting.push(unit.raw);
      return;
    }
    if (this.partitioned || this.halfOpenDirs.has(dir)) { this.log(pipe.id, dir, "blackhole", unit.raw.length, unit.payload); return; }
    let action: "pass" | "drop" | "duplicate" | "delay" = "pass";
    let ms = 0;
    if (!unit.control) {
      const queue = this.pending[dir];
      const index = queue.findIndex((item) => !item.match || item.match(unit.payload, pipe.id));
      if (index >= 0) {
        const item = queue[index];
        action = item.action;
        ms = item.ms;
        if (--item.left <= 0) queue.splice(index, 1);
      } else if (this.plan && (this.plan.dirs ?? ["up", "down"]).includes(dir)) {
        const plan = this.plan;
        if (plan.drop && this.random() < plan.drop) action = "drop";
        else if (plan.duplicate && this.random() < plan.duplicate) action = "duplicate";
        else if (plan.delay && this.random() < plan.delay.p) { action = "delay"; ms = plan.delay.ms; }
      }
    }
    this.log(pipe.id, dir, action, unit.raw.length, unit.payload);
    if (action === "drop") return;
    const write = () => {
      if (pipe.closed) return;
      const target = dir === "up" ? pipe.upstream : pipe.client;
      if (!target) return;
      const copies = action === "duplicate" ? 2 : 1;
      for (let i = 0; i < copies; i++) {
        if (dir === "up" && target.connecting) pipe.waiting.push(unit.raw);
        else target.write(unit.raw);
      }
    };
    pipe.out[dir] = pipe.out[dir].then(async () => { if (ms) await sleep(ms); write(); });
  }

  private closePipe(pipe: Pipe): void {
    if (pipe.closed) return;
    pipe.closed = true;
    this.log(pipe.id, null, "close", 0);
    pipe.client.destroy();
    pipe.upstream?.destroy();
  }

  private log(conn: number, dir: Direction | null, action: FaultAction, bytes: number, payload?: Buffer): void {
    this.events.push({ at: Date.now(), conn, dir, action, bytes, ...(payload && this.options.keepPayloads !== false ? { payload } : {}) });
  }
}
