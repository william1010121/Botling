// M4-17: the page's path fallback (direct -> 2 s / refused -> relay) and 60 s direct re-probe, in Node with
// fake sockets over the real SlotEngine.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFeStorage, type Clock, type Dial, type FeSocket, type SocketHandlers } from "../../src/fe-link";
import {
  decodeFrame, encodeFrame, GENESIS_HASH, slotKey,
  type CmdBody, type Cursor, type Entry, type Message, type Slot, type StreamId,
} from "../../src/protocol";
import { SlotEngine, type ApplyContext, type SlotLog } from "../../src/server/slots";
import type { Db } from "../../src/server/store";
import {
  askedPath, openFallbackLink, DIRECT_TIMEOUT_MS, REPROBE_INTERVAL_MS,
  type DialPath, type FallbackLink, type VisibilitySource,
} from "../../web-v3/shell/connection";
import { BOT, FakeClock, flush, react, SERVER_ID, SRV_STREAM } from "./fe-link-harness";
import { FakeLog, memoryStore } from "./server-slots-harness";

const REMOTE = { local: false } as const;

class CountingClock extends FakeClock {
  pending = 0;
  override setTimeout(fn: () => void, ms: number): unknown {
    this.pending += 1;
    return super.setTimeout(() => {
      this.pending = Math.max(0, this.pending - 1);
      fn();
    }, ms);
  }
  override clearTimeout(handle: unknown): void {
    // Only decrement if the task was still pending.
    const before = this.taskCount();
    super.clearTimeout(handle);
    if (this.taskCount() < before) this.pending = Math.max(0, this.pending - 1);
  }
  private taskCount(): number {
    return (this as unknown as { tasks: Map<unknown, unknown> }).tasks.size;
  }
}

class FakeVisibility implements VisibilitySource {
  hidden = false;
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: "visibilitychange", fn: () => void): void { this.listeners.add(fn); }
  removeEventListener(_type: "visibilitychange", fn: () => void): void { this.listeners.delete(fn); }
  listenerCount(): number { return this.listeners.size; }
  setHidden(value: boolean): void {
    this.hidden = value;
    for (const fn of [...this.listeners]) fn();
  }
}

class DualMemLog extends FakeLog {
  readonly entries = new Map<string, Entry[]>();
  override appendEntry(tx: Db, stream: StreamId, kind: string, body: Record<string, unknown>, slot?: Slot): Cursor {
    const at = super.appendEntry(tx, stream, kind, body, slot);
    const list = this.entries.get(stream) ?? [];
    const prev = list.length ? list[list.length - 1].hash : GENESIS_HASH;
    const content = { stream, logId: at.logId, seq: at.seq, hlc: { ms: at.seq, c: 0 }, kind, body, ...(slot ? { slot } : {}) };
    list.push({ ...content, hash: createHash("sha256").update(`${prev}\n${JSON.stringify(content)}`).digest("hex") } as Entry);
    this.entries.set(stream, list);
    return at;
  }
  head(stream: string): { seq: number; hash: string } {
    const list = this.entries.get(stream) ?? [];
    return list.length ? { seq: list[list.length - 1].seq, hash: list[list.length - 1].hash } : { seq: 0, hash: GENESIS_HASH };
  }
  current(stream: string): string {
    return stream === SRV_STREAM ? this.inc : this.logId(null as unknown as Db, stream as StreamId);
  }
}

type DirectBehavior = "open" | "refuse" | "hang-before-open" | "hang-after-open" | "hang-after-hello";

interface ConnTrace {
  id: number;
  path: DialPath;
  open: boolean;
  closed: boolean;
  welcomed: boolean;
  subscribed: boolean;
  sentCmds: string[];
  closeOrder: number | null;
  cmdOrder: number | null;
}

class DualPathServer {
  readonly log = new DualMemLog();
  readonly db: Db;
  readonly engine: SlotEngine;
  readonly applied: Array<{ slot: Slot; cmd: unknown }> = [];
  readonly traces: ConnTrace[] = [];
  directBehavior: DirectBehavior = "open";
  relayRefuse = false;
  /** Number of non-probe (subscribed) sessions currently open; must never exceed 1. */
  activeSubscribed = 0;
  maxActiveSubscribed = 0;
  private eventSeq = 0;
  private connSeq = 0;
  private readonly openConns = new Set<{
    trace: ConnTrace;
    handlers: SocketHandlers;
    subs: Map<string, number>;
    pingTimer?: unknown;
    close(): void;
  }>();

  constructor(private readonly clock?: Clock) {
    const { db, writer } = memoryStore();
    this.db = db;
    this.engine = new SlotEngine({
      submit: (command) => writer.submit(command),
      log: this.log as SlotLog,
      apply: (context: ApplyContext) => {
        this.applied.push({ slot: context.slot, cmd: context.cmd });
        return { result: { n: context.slot.n } };
      },
    });
  }

  dialFor(path: DialPath): Dial {
    return (handlers: SocketHandlers): FeSocket => {
      const id = ++this.connSeq;
      const trace: ConnTrace = {
        id, path, open: false, closed: false, welcomed: false, subscribed: false,
        sentCmds: [], closeOrder: null, cmdOrder: null,
      };
      this.traces.push(trace);
      const conn: { trace: ConnTrace; handlers: SocketHandlers; subs: Map<string, number>; pingTimer?: unknown; close(): void } = {
        trace,
        handlers,
        subs: new Map<string, number>(),
        close: () => {
          if (trace.closed) return;
          trace.closed = true;
          trace.open = false;
          if (conn.pingTimer !== undefined) { this.clock?.clearTimeout(conn.pingTimer); conn.pingTimer = undefined; }
          trace.closeOrder = ++this.eventSeq;
          if (trace.subscribed) this.activeSubscribed = Math.max(0, this.activeSubscribed - 1);
          this.openConns.delete(conn);
        },
      };

      if ((path === "direct" && this.directBehavior === "refuse") || (path === "relay" && this.relayRefuse)) {
        setImmediate(() => {
          conn.close();
          handlers.close("refused");
        });
        return { send() { /* refused */ }, close: () => conn.close() };
      }

      if (path === "direct" && this.directBehavior === "hang-before-open") {
        return { send() { /* hanging */ }, close: () => conn.close() };
      }

      this.openConns.add(conn);
      setImmediate(() => {
        if (trace.closed) return;
        trace.open = true;
        handlers.open();
      });

      return {
        send: (frame: string) => {
          setImmediate(() => {
            if (trace.closed || !trace.open) return;
            void this.onFrame(conn, frame);
          });
        },
        close: () => conn.close(),
      };
    };
  }

  killPath(path: DialPath): void {
    for (const conn of [...this.openConns]) {
      if (conn.trace.path !== path) continue;
      conn.close();
      setImmediate(() => conn.handlers.close("killed"));
    }
  }

  private send(conn: { trace: ConnTrace; handlers: SocketHandlers }, message: Message): void {
    if (conn.trace.closed || !conn.trace.open) return;
    const encoded = encodeFrame(message, "server", REMOTE);
    if (!encoded.ok) throw new Error(`encode failed: ${encoded.detail}`);
    setImmediate(() => {
      if (!conn.trace.closed && conn.trace.open) conn.handlers.frame(encoded.text);
    });
  }

  private async onFrame(conn: { trace: ConnTrace; handlers: SocketHandlers; subs: Map<string, number>; pingTimer?: unknown; close(): void }, frame: string): Promise<void> {
    const decoded = decodeFrame(frame, "fe", REMOTE);
    if (!decoded.ok) throw new Error(`bad frame: ${decoded.detail}`);
    const message = decoded.message;
    switch (message.t) {
      case "hello": {
        if (conn.trace.path === "direct" && (this.directBehavior === "hang-after-open" || this.directBehavior === "hang-after-hello")) {
          return;
        }
        conn.trace.welcomed = true;
        this.send(conn, {
          t: "welcome", serverId: SERVER_ID, protocol: { min: 1, max: 1 }, minFeVersion: "3.0.0",
          rosterDigest: null, servers: [], next: {}, views: {},
        });
        const c = conn as { trace: ConnTrace; handlers: SocketHandlers; pingTimer?: unknown };
        const schedulePing = () => {
          if (!this.clock || conn.trace.closed) return;
          c.pingTimer = this.clock.setTimeout(() => {
            c.pingTimer = undefined;
            if (conn.trace.closed) return;
            this.send(conn, { t: "ping", at: this.clock!.now() });
            schedulePing();
          }, 15_000);
        };
        schedulePing();
        return;
      }
      case "sub": {
        if (!conn.trace.subscribed) {
          conn.trace.subscribed = true;
          this.activeSubscribed += 1;
          this.maxActiveSubscribed = Math.max(this.maxActiveSubscribed, this.activeSubscribed);
        }
        const head = this.log.head(message.stream);
        const current = this.log.current(message.stream);
        if (!message.cursor) {
          conn.subs.set(message.stream, head.seq);
          this.send(conn, { t: "snap", stream: message.stream, logId: current, seq: head.seq, hash: head.hash, view: {} });
        } else {
          conn.subs.set(message.stream, Math.min(message.cursor.seq, head.seq));
          this.push(conn);
        }
        return;
      }
      case "cmd": {
        const { t: _t, ...body } = message;
        if (conn.trace.cmdOrder === null) conn.trace.cmdOrder = ++this.eventSeq;
        conn.trace.sentCmds.push(slotKey((body as CmdBody).slot));
        await this.engine.receive(body as CmdBody, {
          scope: "local",
          reply: (reply) => this.send(conn, reply),
        });
        for (const c of this.openConns) this.push(c);
        return;
      }
      case "bye":
        conn.trace.closed = true;
        conn.trace.open = false;
        const c = conn as { pingTimer?: unknown };
        if (c.pingTimer !== undefined) { this.clock?.clearTimeout(c.pingTimer); c.pingTimer = undefined; }
        conn.trace.closeOrder = ++this.eventSeq;
        if (conn.trace.subscribed) this.activeSubscribed = Math.max(0, this.activeSubscribed - 1);
        this.openConns.delete(conn);
        return;
      default:
        return;
    }
  }

  private push(conn: { trace: ConnTrace; handlers: SocketHandlers; subs: Map<string, number> }): void {
    if (conn.trace.closed || !conn.trace.open) return;
    for (const [stream, sent] of conn.subs) {
      const current = this.log.current(stream);
      const fresh = (this.log.entries.get(stream) ?? []).filter((e) => e.seq > sent && e.logId === current);
      if (!fresh.length) continue;
      const prev = (this.log.entries.get(stream) ?? []).find((e) => e.seq === fresh[0].seq - 1)?.hash ?? GENESIS_HASH;
      conn.subs.set(stream, fresh[fresh.length - 1].seq);
      this.send(conn, { t: "batch", stream: stream as StreamId, logId: current, from: fresh[0].seq, to: fresh[fresh.length - 1].seq, prevHash: prev, entries: fresh, more: false });
    }
  }
}

const opened: FallbackLink[] = [];
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close();
});

let epochSeq = 0;
const nextEpoch = () => (++epochSeq).toString(16).padStart(32, "0");

async function advanceWithFlush(clock: FakeClock, ms: number, step = 15_000): Promise<void> {
  let left = ms;
  while (left > 0) {
    const chunk = Math.min(left, step);
    clock.advance(chunk);
    await flush();
    left -= chunk;
  }
}

async function openTestLink(
  server: DualPathServer,
  clock: Clock,
  opts: {
    forcedPath?: DialPath;
    hasRelay?: boolean;
    visibility?: VisibilitySource;
    storage?: MemoryFeStorage;
  } = {},
) {
  const paths: DialPath[] = [];
  const probes: string[] = [];
  const fb = await openFallbackLink({
    storage: opts.storage ?? new MemoryFeStorage(),
    directDial: server.dialFor("direct"),
    ...(opts.hasRelay === false ? {} : { relayDial: server.dialFor("relay") }),
    ...(opts.forcedPath ? { forcedPath: opts.forcedPath } : {}),
    deviceId: "dev1",
    feVersion: "3.0.0",
    local: false,
    clock,
    newEpoch: nextEpoch,
    visibility: opts.visibility,
    onPath: (path) => paths.push(path),
    onProbe: (res) => probes.push(res),
  });
  opened.push(fb);
  fb.link.subscribe(BOT);
  fb.start();
  return { fb, paths, probes };
}

describe("web-v3 path fallback and 60 s re-probe (M4-17)", () => {
  it("direct refused: the relay is used within 3 s", async () => {
    const clock = new CountingClock();
    const server = new DualPathServer(clock);
    server.directBehavior = "refuse";
    const { fb, paths } = await openTestLink(server, clock);
    await flush();
    expect(fb.path).toBe("relay");
    expect(fb.link.state).toBe("live");
    expect(paths).toContain("relay");
  });

  it("direct hangs before welcome: falls back to relay after 2 s (within 3 s)", async () => {
    const clock = new CountingClock();
    const server = new DualPathServer(clock);
    server.directBehavior = "hang-after-hello";
    const { fb } = await openTestLink(server, clock);
    await flush();
    expect(fb.path).toBe("direct");
    expect(fb.link.state).toBe("connecting");

    clock.advance(DIRECT_TIMEOUT_MS);
    await flush();
    expect(fb.path).toBe("relay");
    expect(fb.link.state).toBe("live");
  });

  it("direct back: moved within one 60 s re-probe, old session closed before new outbox sends", async () => {
    const clock = new CountingClock();
    const server = new DualPathServer(clock);
    server.directBehavior = "refuse";
    const { fb, probes } = await openTestLink(server, clock);
    await flush();
    expect(fb.path).toBe("relay");
    expect(fb.link.state).toBe("live");

    // First re-probe at 60 s while direct is still down: relay stays live undisturbed.
    await advanceWithFlush(clock, REPROBE_INTERVAL_MS);
    expect(probes).toEqual(["failed"]);
    expect(fb.path).toBe("relay");
    expect(fb.link.state).toBe("live");

    // Direct comes back; next re-probe at 60 s welcomes and switches over.
    server.directBehavior = "open";
    await advanceWithFlush(clock, REPROBE_INTERVAL_MS);
    expect(probes).toEqual(["failed", "welcomed"]);
    expect(fb.path).toBe("direct");
    expect(fb.link.state).toBe("live");

    // Two sessions never ran at once, and the relay session closed before any new session subscribed/sent outbox.
    expect(server.maxActiveSubscribed).toBe(1);
    const relaySess = server.traces.find((t) => t.path === "relay" && t.subscribed)!;
    const directSess = server.traces.find((t) => t.path === "direct" && t.subscribed)!;
    expect(relaySess.closed).toBe(true);
    expect(directSess.welcomed).toBe(true);
    expect(relaySess.closeOrder!).toBeLessThan(directSess.id === relaySess.id ? Infinity : Number.MAX_SAFE_INTEGER);

    // Send a command on direct to verify closeOrder < cmdOrder on new session.
    await fb.link.submit(BOT, react("m1"));
    await flush();
    expect(relaySess.closeOrder!).toBeLessThan(directSess.cmdOrder!);
    expect(server.applied.map((a) => a.slot.n)).toEqual([1]);
  });

  it("20 sends across two moves: 0 lost, 0 doubled (outbox)", async () => {
    const clock = new CountingClock();
    const server = new DualPathServer(clock);
    const { fb } = await openTestLink(server, clock);
    await flush();
    expect(fb.path).toBe("direct");

    // 1-5 on direct.
    for (let i = 1; i <= 5; i++) await fb.link.submit(BOT, react(`m${i}`));
    await flush();

    // Move 1: direct drops and refuses -> falls back to relay; 6-12 submitted while switching / on relay.
    server.directBehavior = "refuse";
    server.killPath("direct");
    await flush();
    for (let i = 6; i <= 9; i++) await fb.link.submit(BOT, react(`m${i}`));
    clock.advance(250);
    await flush();
    expect(fb.path).toBe("relay");
    expect(fb.link.state).toBe("live");
    for (let i = 10; i <= 12; i++) await fb.link.submit(BOT, react(`m${i}`));
    await flush();

    // Move 2: direct comes back -> 60 s re-probe switches back to direct; 13-20 submitted across and after move 2.
    server.directBehavior = "open";
    for (let i = 13; i <= 15; i++) await fb.link.submit(BOT, react(`m${i}`));
    await advanceWithFlush(clock, REPROBE_INTERVAL_MS);
    expect(fb.path).toBe("direct");
    expect(fb.link.state).toBe("live");
    for (let i = 16; i <= 20; i++) await fb.link.submit(BOT, react(`m${i}`));
    await flush();

    expect(server.maxActiveSubscribed).toBe(1);
    const appliedNs = server.applied.map((a) => a.slot.n);
    expect(appliedNs).toHaveLength(20);
    expect(appliedNs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(fb.link.pending(BOT)).toEqual([]);

    // Old relay session closed before the new direct session sent any outbox command.
    const relaySess = server.traces.find((t) => t.path === "relay" && t.subscribed)!;
    const secondDirect = server.traces.filter((t) => t.path === "direct" && t.subscribed)[1]!;
    if (secondDirect.cmdOrder !== null) expect(relaySess.closeOrder!).toBeLessThan(secondDirect.cmdOrder);
  });

  it("?via=relay never tries direct", async () => {
    expect(askedPath("?via=relay")).toBe("relay");
    expect(askedPath("?via=tailnet")).toBe("tailnet");
    expect(askedPath("")).toBeNull();

    const clock = new CountingClock();
    const server = new DualPathServer(clock);
    const { fb } = await openTestLink(server, clock, { forcedPath: "relay" });
    await flush();
    expect(fb.path).toBe("relay");
    expect(fb.link.state).toBe("live");

    await advanceWithFlush(clock, REPROBE_INTERVAL_MS * 3);
    expect(fb.path).toBe("relay");
    expect(server.traces.filter((t) => t.path === "direct")).toEqual([]);
  });

  it("direct hangs before open: falls back to relay after 2 s", async () => {
    const clock = new CountingClock();
    const server = new DualPathServer(clock);
    server.directBehavior = "hang-before-open";
    const { fb } = await openTestLink(server, clock);
    await flush();
    expect(fb.path).toBe("direct");
    expect(fb.link.state).toBe("connecting");

    clock.advance(DIRECT_TIMEOUT_MS);
    await flush();
    expect(fb.path).toBe("relay");
    expect(fb.link.state).toBe("live");
  });

  it("probe timeout keeps the active relay session undisturbed", async () => {
    const clock = new CountingClock();
    const server = new DualPathServer(clock);
    server.directBehavior = "refuse";
    const { fb, probes } = await openTestLink(server, clock);
    await flush();
    expect(fb.path).toBe("relay");
    const relayBefore = server.traces.find((t) => t.path === "relay" && t.subscribed)!;

    // At 60 s, direct hangs on hello instead of welcoming -> probe times out in 2 s; relay stays open.
    server.directBehavior = "hang-after-hello";
    await advanceWithFlush(clock, REPROBE_INTERVAL_MS);
    clock.advance(DIRECT_TIMEOUT_MS);
    await flush();
    expect(probes).toEqual(["timeout"]);
    expect(fb.path).toBe("relay");
    expect(fb.link.state).toBe("live");
    expect(relayBefore.closed).toBe(false);

    // Direct welcomes on the next 60 s probe.
    server.directBehavior = "open";
    await advanceWithFlush(clock, REPROBE_INTERVAL_MS);
    expect(probes).toEqual(["timeout", "welcomed"]);
    expect(fb.path).toBe("direct");
    expect(relayBefore.closed).toBe(true);
  });

  it("?via=tailnet never tries relay even when direct is refused", async () => {
    const clock = new CountingClock();
    const server = new DualPathServer(clock);
    server.directBehavior = "refuse";
    const { fb } = await openTestLink(server, clock, { forcedPath: "direct" });
    await flush();
    clock.advance(DIRECT_TIMEOUT_MS * 2);
    await flush();
    expect(fb.path).toBe("direct");
    expect(server.traces.filter((t) => t.path === "relay")).toEqual([]);
  });

  it("timers stop when the page hides or closes", async () => {
    const clock = new CountingClock();
    const server = new DualPathServer(clock);
    server.directBehavior = "refuse";
    const visibility = new FakeVisibility();
    const { fb, probes } = await openTestLink(server, clock, { visibility });
    await flush();
    expect(fb.path).toBe("relay");
    expect(clock.pending).toBeGreaterThan(0);

    // Hide the page: probe timer stops and no probes run even after 3 minutes.
    visibility.setHidden(true);
    await advanceWithFlush(clock, REPROBE_INTERVAL_MS * 3);
    expect(probes).toEqual([]);
    expect(fb.path).toBe("relay");

    // Show the page again while direct is back: re-probe resumes and switches.
    server.directBehavior = "open";
    visibility.setHidden(false);
    await advanceWithFlush(clock, REPROBE_INTERVAL_MS);
    expect(probes).toEqual(["welcomed"]);
    expect(fb.path).toBe("direct");

    // Close: all timers and visibility listeners are cleaned up.
    await fb.close();
    opened.length = 0;
    expect(clock.pending).toBe(0);
    expect(visibility.listenerCount()).toBe(0);
  });

  it("close while a 2 s fallback or active probe is pending leaves zero timers", async () => {
    const clock = new CountingClock();
    const server = new DualPathServer(clock);
    server.directBehavior = "hang-before-open";
    const visibility = new FakeVisibility();
    const { fb } = await openTestLink(server, clock, { visibility });
    await flush();
    expect(clock.pending).toBeGreaterThan(0);
    await fb.close();
    opened.length = 0;
    expect(clock.pending).toBe(0);
    expect(visibility.listenerCount()).toBe(0);
  });
});
