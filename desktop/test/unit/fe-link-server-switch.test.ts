// M4-20a (D72, §13.1, D58): fe-link server selection, automatic switching after 30 s unreachable across all
// paths (direct + relay), 5-minute anti-flap holdoff, manual pickServer, preference persistence, and >= 50
// in-flight commands across switches (exactly-once, per-queue FIFO order, zero cursor <= seq replay).
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTI_FLAP_MS, MemoryFeStorage, mergeServerCandidates, orderServerCandidates, serverHealthScore, ServerSwitchController, UNREACHABLE_SWITCH_MS,
  type Clock, type Dial, type FeSocket, type SocketHandlers,
} from "../../src/fe-link";
import {
  decodeFrame, encodeFrame, encodeWireFrame, GENESIS_HASH, PROTOCOL_VERSION, slotKey, toBase64Url,
  type CmdBody, type Cursor, type Entry, type Message, type Outcome, type ServerState, type Slot, type StreamId, type Target,
} from "../../src/protocol";
import type { SummaryRow } from "../../src/protocol/table-rows";
import { SlotEngine, type ApplyContext, type SlotLog } from "../../src/server/slots";
import type { Db } from "../../src/server/store";
import { generateDhKeyPair, importDhKeyPair, SessionLink, type SessionTransport } from "../../src/session";
import {
  newDiagnostics, openConnection, openFallbackLink,
  type Connection, type DialPath, type FallbackLink, type ServerDialTarget,
} from "../../web-v3/shell/connection";
import { DEVICE_DB, loadPref, mergeServers, saveDevice, type DeviceRecord } from "../../web-v3/shell/device-store";
import { FakeClock, flush, react } from "./fe-link-harness";
import { FakeLog, memoryStore } from "./server-slots-harness";

const REMOTE = { local: false } as const;
const reactFor = (botId: string, messageId: string) => ({ ...react(messageId), botId } as const);

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
    const before = this.taskCount();
    super.clearTimeout(handle);
    if (this.taskCount() < before) this.pending = Math.max(0, this.pending - 1);
  }
  private taskCount(): number {
    return (this as unknown as { tasks: Map<unknown, unknown> }).tasks.size;
  }
}

class ClusterMemLog extends FakeLog {
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
    return stream === `srv:${this.ownerId}` ? this.inc : this.logId(null as unknown as Db, stream as StreamId);
  }
  constructor(private readonly ownerId: string) { super(); }
}

type PathMode = "open" | "refuse" | "hang";

interface ClusterConn {
  serverId: string;
  path: DialPath;
  open: boolean;
  closed: boolean;
  subscribed: boolean;
  handlers: SocketHandlers;
  subs: Map<string, number>;
}

const summary = (name: string): SummaryRow => ({
  name, face: null, role: "bot", parent: null, folderName: "proj", engine: "claude", model: null, status: "idle",
  waiting: [], unread: 0, lastAt: null, lines: ["hello"],
} as SummaryRow);

/**
 * Simulates a multi-server cluster where owner servers run real `SlotEngine`s and attached servers either execute
 * locally (when they own the target) or forward commands to the owner's `SlotEngine` (holding while disconnected).
 */
class MultiServerCluster {
  readonly servers = new Map<string, {
    id: string;
    name: string;
    state: ServerState;
    directMode: PathMode;
    relayMode: PathMode;
    revokedDevice: boolean;
    /** Simulated lag behind the owner's logId when serving as cache / overlapping replay. */
    replayAtOrBelowCursor?: number;
  }>();
  readonly engines = new Map<string, { log: ClusterMemLog; db: Db; engine: SlotEngine }>();
  readonly botOwners = new Map<string, string>();
  readonly applied: Array<{ owner: string; slot: Slot; cmd: unknown }> = [];
  readonly openConns = new Set<ClusterConn>();
  readonly dialLog: Array<{ serverId: string; path: DialPath; at: number }> = [];
  activeSubscribed = 0;
  maxActiveSubscribed = 0;
  /** Optional server-side hold on forwarding from `fromServer` -> `owner`. */
  readonly heldForward = new Map<string, Array<{ fromServer: string; body: CmdBody; reply: (m: Message) => void }>>();
  partitionedFromOwner = new Set<string>();
  /** When set, the server replays entries starting at `from = 1` on next `sub` so FE must drop <= cursor. */
  forceReplayFromSeq1OnSub = new Set<string>();

  constructor(private readonly clock: Clock) {}

  addServer(id: string, name: string, ownedBots: string[] = []): void {
    this.servers.set(id, { id, name, state: "live", directMode: "open", relayMode: "open", revokedDevice: false });
    const log = new ClusterMemLog(id);
    const { db, writer } = memoryStore();
    const engine = new SlotEngine({
      submit: (command) => writer.submit(command),
      log: log as SlotLog,
      apply: (context: ApplyContext) => {
        this.applied.push({ owner: id, slot: context.slot, cmd: context.cmd });
        return { result: { n: context.slot.n } };
      },
    });
    this.engines.set(id, { log, db, engine });
    for (const botId of ownedBots) this.botOwners.set(`bot:${botId}`, id);
  }

  killServer(id: string): void {
    const s = this.servers.get(id)!;
    s.directMode = "refuse";
    s.relayMode = "refuse";
    for (const conn of [...this.openConns]) {
      if (conn.serverId !== id) continue;
      this.closeConn(conn, "killed");
    }
  }

  markGone(id: string): void {
    const s = this.servers.get(id)!;
    s.state = "gone";
    s.directMode = "refuse";
    s.relayMode = "refuse";
    for (const conn of [...this.openConns]) {
      if (conn.serverId === id) this.closeConn(conn, "gone");
      else this.send(conn, { t: "peer", serverId: id, state: "gone", since: this.clock.now() });
    }
  }

  reviveServer(id: string, modes: { direct?: PathMode; relay?: PathMode } = {}): void {
    const s = this.servers.get(id)!;
    s.directMode = modes.direct ?? "open";
    s.relayMode = modes.relay ?? "open";
  }

  dialTargets(opts: { relayFor?: Set<string>; directFor?: Set<string> } = {}): ServerDialTarget[] {
    return [...this.servers.values()].map((s) => ({
      id: s.id,
      name: s.name,
      state: s.state,
      ...(opts.directFor === undefined || opts.directFor.has(s.id) ? { directDial: this.dialFor(s.id, "direct") } : {}),
      ...(opts.relayFor === undefined || opts.relayFor.has(s.id) ? { relayDial: this.dialFor(s.id, "relay") } : {}),
    }));
  }

  dialFor(serverId: string, path: DialPath): Dial {
    return (handlers: SocketHandlers): FeSocket => {
      this.dialLog.push({ serverId, path, at: this.clock.now() });
      const s = this.servers.get(serverId)!;
      const mode = path === "direct" ? s.directMode : s.relayMode;
      const conn: ClusterConn = {
        serverId, path, open: false, closed: false, subscribed: false, handlers, subs: new Map(),
      };
      if (mode === "refuse") {
        setImmediate(() => {
          if (conn.closed) return;
          conn.closed = true;
          handlers.close("refused");
        });
        return { send() { /* refused */ }, close() { conn.closed = true; } };
      }
      if (mode === "hang") {
        this.openConns.add(conn);
        return {
          send() { /* hanging */ },
          close: () => {
            if (conn.closed) return;
            conn.closed = true;
            this.removeConn(conn);
          },
        };
      }
      this.openConns.add(conn);
      setImmediate(() => {
        if (conn.closed) return;
        conn.open = true;
        handlers.open();
      });
      return {
        send: (frame: string) => {
          setImmediate(() => {
            if (conn.closed || !conn.open) return;
            void this.onFrame(conn, frame);
          });
        },
        close: () => {
          if (conn.closed) return;
          conn.closed = true;
          conn.open = false;
          if (conn.subscribed) this.activeSubscribed = Math.max(0, this.activeSubscribed - 1);
          this.openConns.delete(conn);
        },
      };
    };
  }

  private removeConn(conn: ClusterConn): void {
    if (conn.subscribed) this.activeSubscribed = Math.max(0, this.activeSubscribed - 1);
    this.openConns.delete(conn);
  }

  private closeConn(conn: ClusterConn, detail: string): void {
    if (conn.closed) return;
    conn.closed = true;
    conn.open = false;
    this.removeConn(conn);
    setImmediate(() => conn.handlers.close(detail));
  }

  private send(conn: ClusterConn, message: Message): void {
    if (conn.closed || !conn.open) return;
    const encoded = encodeFrame(message, "server", REMOTE);
    if (!encoded.ok) throw new Error(`encode failed: ${encoded.detail}`);
    setImmediate(() => {
      if (!conn.closed && conn.open) conn.handlers.frame(encoded.text);
    });
  }

  private sendWire(conn: ClusterConn, message: Record<string, unknown>): void {
    if (conn.closed || !conn.open) return;
    const encoded = encodeWireFrame(message as never, "server", REMOTE);
    if (!encoded.ok) throw new Error(`encodeWireFrame failed: ${encoded.detail}`);
    setImmediate(() => {
      if (!conn.closed && conn.open) conn.handlers.frame(encoded.text);
    });
  }

  private async onFrame(conn: ClusterConn, frame: string): Promise<void> {
    const decoded = decodeFrame(frame, "fe", REMOTE);
    if (!decoded.ok) throw new Error(`bad frame: ${decoded.detail}`);
    const message = decoded.message;
    const srv = this.servers.get(conn.serverId)!;
    switch (message.t) {
      case "hello": {
        if (srv.revokedDevice) {
          this.send(conn, { t: "bye", reason: "revoked" });
          return;
        }
        const servers = [...this.servers.values()].map((entry) => ({
          id: entry.id,
          name: entry.name,
          state: entry.state,
          since: 1_000,
        }));
        this.send(conn, {
          t: "welcome", serverId: conn.serverId, protocol: { min: 1, max: 1 }, minFeVersion: "3.0.0",
          rosterDigest: null, servers, next: {}, views: {},
        });
        return;
      }
      case "sub": {
        if (message.stream.startsWith("srv:") && message.stream !== `srv:${conn.serverId}`) {
          const peerId = message.stream.slice(4);
          const peerEng = this.engines.get(peerId);
          if (!peerEng) return;
          const rows = [...this.botOwners.entries()]
            .filter(([, owner]) => owner === peerId)
            .map(([botStream], idx) => ({ key: botStream, rev: idx + 1, body: summary(botStream) }));
          this.sendWire(conn, {
            t: "rows", stream: message.stream, logId: peerEng.log.inc, after: 0, to: rows.length, rows, more: false,
          });
          return;
        }
        if (!conn.subscribed) {
          conn.subscribed = true;
          this.activeSubscribed += 1;
          this.maxActiveSubscribed = Math.max(this.maxActiveSubscribed, this.activeSubscribed);
        }
        const ownerId = this.ownerForStream(message.stream, conn.serverId);
        const eng = this.engines.get(ownerId)!;
        const head = eng.log.head(message.stream);
        const current = eng.log.current(message.stream);
        if (!message.cursor) {
          conn.subs.set(message.stream, head.seq);
          this.send(conn, { t: "snap", stream: message.stream, logId: current, seq: head.seq, hash: head.hash, view: {} });
        } else {
          // Optionally simulate a peer sending overlapping entries from seq 1 (<= cursor) to verify monotonic reads!
          const startAt = this.forceReplayFromSeq1OnSub.has(conn.serverId) ? 0 : Math.min(message.cursor.seq, head.seq);
          conn.subs.set(message.stream, startAt);
          this.pushStream(conn, message.stream);
        }
        return;
      }
      case "cmd": {
        const { t: _t, ...raw } = message;
        const body = raw as CmdBody;
        const ownerId = this.ownerForStream(body.slot.target, conn.serverId);
        if (ownerId !== conn.serverId && this.partitionedFromOwner.has(`${conn.serverId}->${ownerId}`)) {
          const list = this.heldForward.get(ownerId) ?? [];
          list.push({ fromServer: conn.serverId, body, reply: (reply) => this.send(conn, reply) });
          this.heldForward.set(ownerId, list);
          this.send(conn, { t: "held", slot: body.slot, at: conn.serverId });
          return;
        }
        const eng = this.engines.get(ownerId)!;
        await eng.engine.receive(body, {
          scope: "local",
          reply: (reply) => this.send(conn, reply),
        });
        for (const c of this.openConns) this.pushStream(c, body.slot.target);
        return;
      }
      case "bye":
        if (conn.subscribed) this.activeSubscribed = Math.max(0, this.activeSubscribed - 1);
        conn.closed = true;
        conn.open = false;
        this.openConns.delete(conn);
        return;
      default:
        return;
    }
  }

  async healForward(ownerId: string): Promise<void> {
    for (const key of [...this.partitionedFromOwner]) if (key.endsWith(`->${ownerId}`)) this.partitionedFromOwner.delete(key);
    const queued = this.heldForward.get(ownerId) ?? [];
    this.heldForward.delete(ownerId);
    const eng = this.engines.get(ownerId)!;
    for (const item of queued) {
      await eng.engine.receive(item.body, { scope: "local", reply: item.reply });
    }
    for (const c of this.openConns) {
      for (const stream of c.subs.keys()) this.pushStream(c, stream);
    }
  }

  private ownerForStream(stream: string, fallbackServerId: string): string {
    if (stream.startsWith("srv:")) return stream.slice(4);
    return this.botOwners.get(stream) ?? fallbackServerId;
  }

  private pushStream(conn: ClusterConn, stream: string): void {
    if (conn.closed || !conn.open) return;
    const sent = conn.subs.get(stream);
    if (sent === undefined) return;
    const ownerId = this.ownerForStream(stream, conn.serverId);
    const eng = this.engines.get(ownerId)!;
    const current = eng.log.current(stream);
    const fresh = (eng.log.entries.get(stream) ?? []).filter((e) => e.seq > sent && e.logId === current);
    if (!fresh.length) return;
    const prev = (eng.log.entries.get(stream) ?? []).find((e) => e.seq === fresh[0].seq - 1)?.hash ?? GENESIS_HASH;
    conn.subs.set(stream, fresh[fresh.length - 1].seq);
    this.send(conn, {
      t: "batch", stream: stream as StreamId, logId: current,
      from: fresh[0].seq, to: fresh[fresh.length - 1].seq, prevHash: prev, entries: fresh, more: false,
    });
  }
}

const opened: FallbackLink[] = [];
const connections: Connection[] = [];
afterEach(async () => {
  for (const item of opened.splice(0)) await item.close();
  for (const conn of connections.splice(0)) await conn.close();
});

let epochSeq = 0;
const nextEpoch = () => (++epochSeq).toString(16).padStart(32, "0");

async function advanceWithFlush(clock: FakeClock, ms: number, step = 5_000): Promise<void> {
  let left = ms;
  while (left > 0) {
    const chunk = Math.min(left, step);
    clock.advance(chunk);
    await flush();
    left -= chunk;
  }
}

function memoryIdb(): IDBFactory {
  const databases = new Map<string, { version: number; stores: Map<string, Map<IDBValidKey, unknown>> }>();
  const fire = (fn: ((ev: Event) => void) | null | undefined) => { if (fn) setTimeout(() => fn(new Event("idb")), 0); };
  type Req<T> = {
    result: T;
    error: DOMException | null;
    onsuccess: ((ev: Event) => void) | null;
    onerror: ((ev: Event) => void) | null;
    onupgradeneeded: ((ev: IDBVersionChangeEvent) => void) | null;
    onblocked: ((ev: Event) => void) | null;
  };
  const makeRequest = <T>(run: (req: Req<T>) => void): Req<T> => {
    const req: Req<T> = { result: undefined as T, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    setTimeout(() => run(req), 0);
    return req;
  };
  return {
    open(name: string, version = 1) {
      return makeRequest<IDBDatabase>((req) => {
        let entry = databases.get(name);
        const upgraded = !entry || entry.version < version;
        if (!entry) { entry = { version, stores: new Map() }; databases.set(name, entry); }
        entry.version = Math.max(entry.version, version);
        const dbData = entry;
        const normKey = (k: IDBValidKey): string => (Array.isArray(k) ? `arr:${JSON.stringify(k)}` : `${typeof k}:${String(k)}`);
        const storeNames = () => ({ contains: (storeName: string) => dbData.stores.has(storeName) }) as DOMStringList;
        const db = {
          get objectStoreNames() { return storeNames(); },
          createObjectStore(storeName: string) { if (!dbData.stores.has(storeName)) dbData.stores.set(storeName, new Map()); return {} as IDBObjectStore; },
          transaction(storeNamesArg: string | string[], _mode?: IDBTransactionMode) {
            const list = Array.isArray(storeNamesArg) ? storeNamesArg : [storeNamesArg];
            const tx = { oncomplete: null as ((ev: Event) => void) | null, onerror: null as ((ev: Event) => void) | null, onabort: null as ((ev: Event) => void) | null, error: null as DOMException | null } as unknown as IDBTransaction;
            let pendingOps = 0;
            const maybeComplete = () => { if (pendingOps === 0) setTimeout(() => tx.oncomplete?.(new Event("complete")), 0); };
            setTimeout(maybeComplete, 0);
            (tx as unknown as { objectStore: (s: string) => IDBObjectStore }).objectStore = (storeName: string) => {
              if (!list.includes(storeName)) throw new Error(`unknown store ${storeName}`);
              const map = dbData.stores.get(storeName)! as unknown as Map<string, { rawKey: IDBValidKey; value: unknown }>;
              return {
                get(key: IDBValidKey) { pendingOps += 1; return makeRequest((r) => { r.result = map.get(normKey(key))?.value; pendingOps -= 1; r.onsuccess?.(new Event("success")); maybeComplete(); }) as unknown as IDBRequest; },
                put(value: unknown, key: IDBValidKey) { pendingOps += 1; return makeRequest((r) => { map.set(normKey(key), { rawKey: key, value }); r.result = key; pendingOps -= 1; r.onsuccess?.(new Event("success")); maybeComplete(); }) as unknown as IDBRequest; },
                getAllKeys() { pendingOps += 1; return makeRequest((r) => { r.result = [...map.values()].map((e) => e.rawKey); pendingOps -= 1; r.onsuccess?.(new Event("success")); maybeComplete(); }) as unknown as IDBRequest; },
                getAll() { pendingOps += 1; return makeRequest((r) => { r.result = [...map.values()].map((e) => e.value); pendingOps -= 1; r.onsuccess?.(new Event("success")); maybeComplete(); }) as unknown as IDBRequest; },
                delete(key: IDBValidKey) { pendingOps += 1; return makeRequest((r) => { map.delete(normKey(key)); r.result = undefined; pendingOps -= 1; r.onsuccess?.(new Event("success")); maybeComplete(); }) as unknown as IDBRequest; },
                clear() { pendingOps += 1; return makeRequest((r) => { map.clear(); r.result = undefined; pendingOps -= 1; r.onsuccess?.(new Event("success")); maybeComplete(); }) as unknown as IDBRequest; },
              } as unknown as IDBObjectStore;
            };
            return tx;
          },
          close() {},
          onversionchange: null,
        } as unknown as IDBDatabase;
        req.result = db;
        if (upgraded) req.onupgradeneeded?.({ oldVersion: 0, newVersion: version } as IDBVersionChangeEvent);
        fire(req.onsuccess);
      });
    },
    deleteDatabase(name: string) { return makeRequest((req) => { databases.delete(name); fire(req.onsuccess); }) as unknown as IDBOpenDBRequest; },
    cmp: (a: unknown, b: unknown) => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1),
    databases: async () => [...databases.entries()].map(([name, d]) => ({ name, version: d.version })),
  } as unknown as IDBFactory;
}

describe("M4-20a: server selection (§13.1), D72 switching, and 50+ in-flight D58 checks", () => {
  it("§13.1 orderServerCandidates: last good -> designated -> roster order, skipping gone, non-dialable, excluded, and held-off", () => {
    const servers = [
      { id: "srvA", name: "A", state: "live" as const, dialable: true },
      { id: "srvB", name: "B", state: "live" as const, dialable: true },
      { id: "srvC", name: "C", state: "live" as const, dialable: true },
      { id: "srvD", name: "D", state: "gone" as const, dialable: false },
      { id: "srvE", name: "E", state: "live" as const, dialable: false },
    ];
    expect(orderServerCandidates({ servers, lastGoodId: "srvC", designatedId: "srvA" }).map((s) => s.id))
      .toEqual(["srvC", "srvA", "srvB"]);

    const holdoff = new Map([["srvA", 500_000]]);
    expect(orderServerCandidates({
      servers, lastGoodId: "srvC", designatedId: "srvA", excludeId: "srvC", holdoffUntil: holdoff, now: 499_999,
    }).map((s) => s.id)).toEqual(["srvB"]);

    // Holdoff expires at 500_000 -> designated srvA becomes eligible again before roster srvB.
    expect(orderServerCandidates({
      servers, lastGoodId: "srvC", designatedId: "srvA", excludeId: "srvC", holdoffUntil: holdoff, now: 500_000,
    }).map((s) => s.id)).toEqual(["srvA", "srvB"]);

    expect(serverHealthScore({ handshakeMs: 40, staleStreams: 0, updatedAt: 100 }))
      .toBeLessThan(serverHealthScore({ handshakeMs: 40, staleStreams: 2, updatedAt: 100 }));
  });

  it("D72 30 s threshold: waits full 30 s on unreachable direct+relay, stays on A when relay works, stays when A recovers before 30 s", async () => {
    const clock = new CountingClock();
    const cluster = new MultiServerCluster(clock);
    cluster.addServer("srvA", "Machine A", ["b1"]);
    cluster.addServer("srvB", "Machine B", ["b2"]);

    const switched: Array<{ from: string; to: string; reason: string }> = [];
    const fb = await openFallbackLink({
      storage: new MemoryFeStorage(),
      servers: cluster.dialTargets(),
      designatedServerId: "srvA",
      deviceId: "phone",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
      onSwitch: (ev) => switched.push(ev),
    });
    opened.push(fb);
    fb.start();
    await flush();
    expect(fb.link.attachedServerId()).toBe("srvA");
    expect(fb.serverId).toBe("srvA");

    // Direct dies, relay stays open -> A stays attached on relay past 30 s and 5 min!
    cluster.servers.get("srvA")!.directMode = "refuse";
    cluster.killServer("srvA");
    cluster.reviveServer("srvA", { direct: "refuse", relay: "open" });
    await advanceWithFlush(clock, 35_000);
    expect(fb.link.attachedServerId()).toBe("srvA");
    expect(fb.path).toBe("relay");
    expect(switched).toEqual([]);

    // Now kill BOTH direct and relay on A -> must NOT switch at 29.9 s, MUST switch at 30.0 s!
    cluster.killServer("srvA");
    await flush();
    await advanceWithFlush(clock, UNREACHABLE_SWITCH_MS - 1, 5_000);
    expect(fb.serverId).toBe("srvA");
    expect(switched).toEqual([]);

    await advanceWithFlush(clock, 1);
    await flush();
    expect(fb.serverId).toBe("srvB");
    expect(fb.link.attachedServerId()).toBe("srvB");
    expect(switched).toEqual([{ from: "srvA", to: "srvB", reason: "auto" }]);

    // If B drops and recovers at 25 s (< 30 s), we stay on B.
    cluster.killServer("srvB");
    await advanceWithFlush(clock, 25_000, 5_000);
    cluster.reviveServer("srvB");
    await advanceWithFlush(clock, 10_000, 2_000);
    expect(fb.link.attachedServerId()).toBe("srvB");
    expect(switched).toHaveLength(1);
  });

  it("D72 5-minute anti-flap: no auto-switch back within 5 minutes even if A recovers or B also fails; 3rd server C preferred while A is in holdoff", async () => {
    const clock = new CountingClock();
    const cluster = new MultiServerCluster(clock);
    cluster.addServer("srvA", "Machine A");
    cluster.addServer("srvB", "Machine B");
    cluster.addServer("srvC", "Machine C");

    const switched: Array<{ from: string; to: string; reason: string }> = [];
    const fb = await openFallbackLink({
      storage: new MemoryFeStorage(),
      servers: cluster.dialTargets(),
      designatedServerId: "srvA",
      deviceId: "phone",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
      onSwitch: (ev) => switched.push(ev),
    });
    opened.push(fb);
    fb.start();
    await flush();

    // Kill A -> switches to B at 30 s.
    cluster.killServer("srvA");
    await flush();
    await advanceWithFlush(clock, UNREACHABLE_SWITCH_MS, 5_000);
    expect(fb.link.attachedServerId()).toBe("srvB");

    // Bring A back immediately -> must NOT auto-switch back while B is healthy (even past 5 minutes!).
    cluster.reviveServer("srvA");
    await advanceWithFlush(clock, 120_000, 10_000);
    expect(fb.link.attachedServerId()).toBe("srvB");

    // Kill B while A is still in 5-min holdoff -> must skip A and pick C!
    cluster.killServer("srvB");
    await flush();
    await advanceWithFlush(clock, UNREACHABLE_SWITCH_MS, 5_000);
    expect(fb.link.attachedServerId()).toBe("srvC");
    expect(switched).toEqual([
      { from: "srvA", to: "srvB", reason: "auto" },
      { from: "srvB", to: "srvC", reason: "auto" },
    ]);

    // Revive B too, then kill C while BOTH A and B are still inside their 5-min holdoffs (< 300 s since switch away).
    cluster.reviveServer("srvB");
    cluster.killServer("srvC");
    await flush();
    await advanceWithFlush(clock, UNREACHABLE_SWITCH_MS, 5_000);
    // Neither A nor B may be auto-selected before A's 5-min holdoff expires!
    expect(fb.serverId).toBe("srvC");

    // Advance until A's 5-min holdoff (300_000 ms from first switch at 30_000 => 330_000) expires.
    await advanceWithFlush(clock, ANTI_FLAP_MS - 150_000, 10_000);
    expect(fb.link.attachedServerId()).toBe("srvA");
  });

  it("§13.1 order across 3 servers (lastGood -> designated -> roster) and manual pickServer ignores 5-min holdoff", async () => {
    const clock = new CountingClock();
    const cluster = new MultiServerCluster(clock);
    cluster.addServer("srvA", "Machine A");
    cluster.addServer("srvB", "Machine B");
    cluster.addServer("srvC", "Machine C");

    const fb = await openFallbackLink({
      storage: new MemoryFeStorage(),
      servers: cluster.dialTargets(),
      designatedServerId: "srvA",
      lastGoodServerId: "srvC",
      deviceId: "phone",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
    });
    opened.push(fb);
    fb.start();
    await flush();
    expect(fb.link.attachedServerId()).toBe("srvC");

    // C dies -> switches to designated srvA (NOT srvB).
    cluster.killServer("srvC");
    await flush();
    await advanceWithFlush(clock, UNREACHABLE_SWITCH_MS, 5_000);
    expect(fb.link.attachedServerId()).toBe("srvA");

    // Revive C while within 5 min; user manually picks C -> switches at once!
    cluster.reviveServer("srvC");
    expect(fb.pickServer("srvC")).toBe(true);
    await flush();
    expect(fb.link.attachedServerId()).toBe("srvC");

    // Picking a gone or unknown server returns false and keeps C attached.
    cluster.markGone("srvB");
    await flush();
    expect(fb.pickServer("srvB")).toBe(false);
    expect(fb.pickServer("unknown-id")).toBe(false);
    expect(fb.link.attachedServerId()).toBe("srvC");
  });

  it("D58 highest-risk gate: >= 50 in-flight commands across auto-switch (A -> B) arrive once each, per-queue FIFO order preserved, zero <= cursor entries re-applied", async () => {
    const clock = new CountingClock();
    const cluster = new MultiServerCluster(clock);
    cluster.addServer("srvA", "Machine A", ["a1"]);
    cluster.addServer("srvB", "Machine B", ["b1", "b2"]);

    const fb = await openFallbackLink({
      storage: new MemoryFeStorage(),
      servers: cluster.dialTargets(),
      designatedServerId: "srvA",
      deviceId: "phone",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
    });
    opened.push(fb);

    const BOT1 = "bot:b1" as StreamId;
    const BOT2 = "bot:b2" as StreamId;
    const emittedSeqs = new Map<string, number[]>([[BOT1, []], [BOT2, []]]);
    const snapSeqs = new Map<string, number[]>([[BOT1, []], [BOT2, []]]);
    fb.link.on((ev) => {
      if (ev.type === "entries" && emittedSeqs.has(ev.stream)) {
        emittedSeqs.get(ev.stream)!.push(...ev.entries.map((e) => e.seq));
      }
      if (ev.type === "snap" && snapSeqs.has(ev.snap.stream)) {
        snapSeqs.get(ev.snap.stream)!.push(ev.snap.seq);
      }
    });
    fb.link.subscribe(BOT1);
    fb.link.subscribe(BOT2);
    fb.start();
    await flush();
    expect(fb.link.attachedServerId()).toBe("srvA");

    // Phase 1: send 10 commands on BOT1 and 10 on BOT2 while attached to A so cursors advance.
    const expectedB1: number[] = [];
    const expectedB2: number[] = [];
    for (let i = 1; i <= 10; i++) {
      const it1 = await fb.link.submit(BOT1 as Target, react(`q1-${i}`));
      expectedB1.push(it1.slot.n);
      const it2 = await fb.link.submit(BOT2 as Target, reactFor("b2", `q2-${i}`));
      expectedB2.push(it2.slot.n);
    }
    await flush();
    const cursor1BeforeSwitch = fb.link.cursor(BOT1)!.seq;
    const cursor2BeforeSwitch = fb.link.cursor(BOT2)!.seq;
    expect(cursor1BeforeSwitch).toBeGreaterThanOrEqual(10);
    expect(cursor2BeforeSwitch).toBeGreaterThanOrEqual(10);

    // Phase 2: partition A->B forwarding, send 15 commands/queue held at A (30 in-flight!), then kill A!
    cluster.partitionedFromOwner.add("srvA->srvB");
    for (let i = 11; i <= 25; i++) {
      const it1 = await fb.link.submit(BOT1 as Target, react(`q1-${i}`));
      expectedB1.push(it1.slot.n);
      const it2 = await fb.link.submit(BOT2 as Target, reactFor("b2", `q2-${i}`));
      expectedB2.push(it2.slot.n);
    }
    await flush();

    // Kill A (both direct & relay), and force B to replay entries from seq 1 on sub to test monotonic cursor guard!
    cluster.killServer("srvA");
    cluster.forceReplayFromSeq1OnSub.add("srvB");
    const engB = cluster.engines.get("srvB")!;
    engB.log.appendEntry(engB.db, BOT1, "turn.cancelled", { botId: "b1", turnId: "t-away" });
    await flush();

    // Phase 3: send 15 more commands on EACH queue while disconnected (60 in-flight across outage/switch!).
    for (let i = 26; i <= 40; i++) {
      const it1 = await fb.link.submit(BOT1 as Target, react(`q1-${i}`));
      expectedB1.push(it1.slot.n);
      const it2 = await fb.link.submit(BOT2 as Target, reactFor("b2", `q2-${i}`));
      expectedB2.push(it2.slot.n);
    }

    // Advance 30 s so D72 auto-switches to B.
    await advanceWithFlush(clock, UNREACHABLE_SWITCH_MS, 5_000);
    expect(fb.link.attachedServerId()).toBe("srvB");

    // Submit another batch immediately during/after catch-up on B (total 100 commands, 80 across/after switch!).
    for (let i = 41; i <= 50; i++) {
      const it1 = await fb.link.submit(BOT1 as Target, react(`q1-${i}`));
      expectedB1.push(it1.slot.n);
      const it2 = await fb.link.submit(BOT2 as Target, reactFor("b2", `q2-${i}`));
      expectedB2.push(it2.slot.n);
    }
    await flush(60);

    // Verify zero drops, zero duplicates, exact per-queue FIFO order on B's SlotEngine!
    const b1Applied = cluster.applied.filter((a) => a.slot.target === BOT1).map((a) => a.slot.n);
    const b2Applied = cluster.applied.filter((a) => a.slot.target === BOT2).map((a) => a.slot.n);
    expect(b1Applied).toEqual(expectedB1);
    expect(b2Applied).toEqual(expectedB2);
    expect(b1Applied).toHaveLength(50);
    expect(b2Applied).toHaveLength(50);
    expect(new Set(b1Applied).size).toBe(50);
    expect(new Set(b2Applied).size).toBe(50);
    expect(fb.link.pending()).toEqual([]);
    expect(cluster.maxActiveSubscribed).toBe(1);

    // Verify zero entries at or below the synced cursor were re-applied on either stream (strictly increasing seqs, no duplicates)!
    for (const [stream, seqs] of emittedSeqs) {
      expect(new Set(seqs).size).toBe(seqs.length);
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
      expect(seqs[0]).toBe(1);
      expect(seqs.length).toBeGreaterThanOrEqual(50);
      // Specifically verify nothing <= cursorBeforeSwitch appeared after the switch!
      const beforeCursor = stream === BOT1 ? cursor1BeforeSwitch : cursor2BeforeSwitch;
      const idxAfterCursor = seqs.findIndex((s) => s > beforeCursor);
      expect(idxAfterCursor).toBeGreaterThan(0);
      expect(seqs.slice(idxAfterCursor).every((s) => s > beforeCursor)).toBe(true);
    }
  });

  it("D58 manual pickServer during 60 in-flight commands (A -> B -> A): zero drops/dups, per-queue FIFO, monotonic cursors", async () => {
    const clock = new CountingClock();
    const cluster = new MultiServerCluster(clock);
    cluster.addServer("srvA", "Machine A", ["a1"]);
    cluster.addServer("srvB", "Machine B", ["b1", "b2"]);

    const fb = await openFallbackLink({
      storage: new MemoryFeStorage(),
      servers: cluster.dialTargets(),
      designatedServerId: "srvA",
      deviceId: "phone",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
    });
    opened.push(fb);

    const BOT1 = "bot:b1" as StreamId;
    const BOT2 = "bot:b2" as StreamId;
    const emittedSeqs = new Map<string, number[]>([[BOT1, []], [BOT2, []]]);
    fb.link.on((ev) => {
      if (ev.type === "entries" && emittedSeqs.has(ev.stream)) emittedSeqs.get(ev.stream)!.push(...ev.entries.map((e) => e.seq));
    });
    fb.link.subscribe(BOT1);
    fb.link.subscribe(BOT2);
    fb.start();
    await flush();

    // Send 10 commands per queue, then hold A->B forwarding so the next batch is in-flight across manual switches.
    const expectedB1: number[] = [];
    const expectedB2: number[] = [];
    for (let i = 1; i <= 10; i++) {
      expectedB1.push((await fb.link.submit(BOT1 as Target, react(`m1-${i}`))).slot.n);
      expectedB2.push((await fb.link.submit(BOT2 as Target, reactFor("b2", `m2-${i}`))).slot.n);
    }
    await flush();

    cluster.partitionedFromOwner.add("srvA->srvB");
    cluster.forceReplayFromSeq1OnSub.add("srvB");
    cluster.forceReplayFromSeq1OnSub.add("srvA");
    const inflight: Array<Promise<unknown>> = [];
    for (let i = 11; i <= 35; i++) {
      inflight.push(fb.link.submit(BOT1 as Target, react(`m1-${i}`)).then((it) => expectedB1.push(it.slot.n)));
      inflight.push(fb.link.submit(BOT2 as Target, reactFor("b2", `m2-${i}`)).then((it) => expectedB2.push(it.slot.n)));
    }
    // Switch A -> B right in the middle of the in-flight submissions!
    expect(fb.pickServer("srvB")).toBe(true);
    for (let i = 36; i <= 45; i++) {
      inflight.push(fb.link.submit(BOT1 as Target, react(`m1-${i}`)).then((it) => expectedB1.push(it.slot.n)));
      inflight.push(fb.link.submit(BOT2 as Target, reactFor("b2", `m2-${i}`)).then((it) => expectedB2.push(it.slot.n)));
    }
    await Promise.all(inflight);
    await flush();
    expect(fb.link.attachedServerId()).toBe("srvB");

    // Now heal A->B and manually switch B -> A while another 10 commands are queued.
    await cluster.healForward("srvB");
    for (let i = 46; i <= 50; i++) {
      expectedB1.push((await fb.link.submit(BOT1 as Target, react(`m1-${i}`))).slot.n);
      expectedB2.push((await fb.link.submit(BOT2 as Target, reactFor("b2", `m2-${i}`))).slot.n);
    }
    expect(fb.pickServer("srvA")).toBe(true);
    await flush(60);
    expect(fb.link.attachedServerId()).toBe("srvA");
    expect(cluster.maxActiveSubscribed).toBe(1);

    const b1Applied = cluster.applied.filter((a) => a.slot.target === BOT1).map((a) => a.slot.n);
    const b2Applied = cluster.applied.filter((a) => a.slot.target === BOT2).map((a) => a.slot.n);
    expect(b1Applied).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(b2Applied).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    for (const [, seqs] of emittedSeqs) {
      expect(new Set(seqs).size).toBe(seqs.length);
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it("openConnection + conn.link.start() switches on manual pickServer (F1) and persists server pref only after attach (F6)", async () => {
    const idb = memoryIdb();
    const prevIdb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = idb;
    const prevNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const prevWinDesc = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true, writable: true });
    Object.defineProperty(globalThis, "window", { value: new EventTarget(), configurable: true, writable: true });

    const clusterId = "c".repeat(32);
    const DEV1 = "d".repeat(26);
    const SRVA = "a".repeat(26);
    const SRVB = "b".repeat(26);
    const SRVGONE = "g".repeat(26);
    const rawDevDh = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
    const devPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", rawDevDh.privateKey));
    const devDh = await importDhKeyPair(devPkcs8);
    const srvAKeys = await generateDhKeyPair();
    const srvBKeys = await generateDhKeyPair();

    const record: DeviceRecord = {
      v: 1,
      memberId: DEV1,
      name: "Phone",
      signKey: (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair).privateKey,
      signPub: "devSignPub",
      dhKey: devDh.privateKey,
      dhPub: devDh.publicKey,
      cluster: clusterId,
      server: { memberId: SRVA, name: "Machine A", dhPub: srvAKeys.publicKey },
      addId: "e".repeat(32),
      scope: ["chat"],
      pairedAt: 1_000,
      relay: { url: "wss://relay.invalid/ws", room: "roomA" },
      servers: [
        { id: SRVA, name: "Machine A", dh: toBase64Url(srvAKeys.publicKey), state: "live", addresses: { tailnet: "wss://a.invalid/v3/ws", relay: { url: "wss://relay.invalid/ws", room: "roomA" } } },
        { id: SRVB, name: "Machine B", dh: toBase64Url(srvBKeys.publicKey), state: "live", addresses: { tailnet: "wss://b.invalid/v3/ws", relay: { url: "wss://relay.invalid/ws", room: "roomB" } } },
        { id: SRVGONE, name: "Gone Box", dh: toBase64Url(srvBKeys.publicKey), state: "gone" },
      ],
    };

    const waitUntil = async (cond: () => boolean, label: string) => {
      for (let i = 0; i < 60; i++) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for ${label}`);
    };

    try {
      await saveDevice(record, devPkcs8, idb);
      const seenUrls: string[] = [];
      const holdWelcome = new Set<string>();
      const pendingWelcomes = new Map<string, () => void>();
      const enc = new TextEncoder();
      const dec = new TextDecoder();

      class FakeWs {
        static OPEN = 1;
        readyState = 0;
        binaryType = "arraybuffer";
        onopen: (() => void) | null = null;
        onmessage: ((e: { data: unknown }) => void) | null = null;
        onclose: ((e: { code: number; reason: string }) => void) | null = null;
        onerror: (() => void) | null = null;
        private session: SessionLink;
        constructor(public readonly url: string) {
          seenUrls.push(url);
          const serverId = url.includes("://b.invalid") ? SRVB : SRVA;
          const serverKeys = serverId === SRVB ? srvBKeys : srvAKeys;
          const transport: SessionTransport = {
            send: (frame) => {
              setTimeout(() => {
                if (this.readyState !== 1) return;
                const buf = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
                this.onmessage?.({ data: buf });
              }, 0);
            },
            close: () => { this.close(); },
          };
          const sendMsg = (msg: Message) => {
            const out = encodeFrame(msg, "server", REMOTE);
            if (!out.ok) throw new Error(out.detail);
            this.session.send("control", enc.encode(out.text));
          };
          this.session = SessionLink.respond(transport, {
            modes: ["ik"],
            transport: "tailnet",
            cluster: clusterId,
            self: { memberId: serverId, dhPub: serverKeys.publicKey, dhKey: serverKeys.privateKey },
            checkPeer: (peer) => ({ ok: peer.memberId === DEV1 }),
          }, {
            onFrame: (bytes) => {
              const parsed = decodeFrame(dec.decode(bytes), "fe", REMOTE);
              if (!parsed.ok) return;
              if (parsed.message.t === "hello") {
                const sendWelcome = () => sendMsg({
                  t: "welcome",
                  serverId,
                  protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
                  minFeVersion: "3.0.0-m2",
                  rosterDigest: null,
                  servers: [
                    { id: SRVA, name: "Machine A", state: "live", since: 1_000, dh: toBase64Url(srvAKeys.publicKey), addresses: { tailnet: "wss://a.invalid/v3/ws" } },
                    { id: SRVB, name: "Machine B", state: "live", since: 1_000, dh: toBase64Url(srvBKeys.publicKey), addresses: { tailnet: "wss://b.invalid/v3/ws" } },
                  ],
                  next: {},
                  views: {},
                });
                if (holdWelcome.has(serverId)) pendingWelcomes.set(serverId, sendWelcome);
                else sendWelcome();
              } else if (parsed.message.t === "sub" && parsed.message.stream === `srv:${serverId}`) {
                sendMsg({ t: "snap", stream: parsed.message.stream, logId: `log-${serverId}-1`, seq: 0, hash: GENESIS_HASH, view: {} });
              }
            },
          });
          setTimeout(() => {
            if (this.readyState !== 0) return;
            this.readyState = 1;
            this.onopen?.();
          }, 0);
        }
        send(data: unknown) {
          if (data instanceof Uint8Array) this.session.receive(data);
          else if (data instanceof ArrayBuffer) this.session.receive(new Uint8Array(data));
        }
        close() {
          if (this.readyState === 3) return;
          this.readyState = 3;
          this.session.transportClosed();
          this.onclose?.({ code: 1000, reason: "closed" });
        }
      }
      const prevWs = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
      (globalThis as { WebSocket?: typeof WebSocket }).WebSocket = FakeWs as unknown as typeof WebSocket;

      try {
        const picked: string[] = [];
        const conn = await openConnection(record, newDiagnostics(), "https://a.invalid/v3/", {
          onServer: (id) => picked.push(id),
        });
        connections.push(conn);
        // Shell.tsx starts via conn.link.start() (NOT fb.start())!
        conn.link.start();
        await waitUntil(() => conn.link.attachedServerId() === SRVA, "attach srvA");
        await new Promise((r) => setTimeout(r, 25));
        expect(await loadPref("server", idb)).toBe(SRVA);

        // Manual pick while srvB holds welcome: dial switches immediately (F1), pref stays SRVA until B attaches (F6).
        holdWelcome.add(SRVB);
        expect(conn.pickServer?.(SRVGONE)).toBe(false);
        expect(conn.pickServer?.(SRVB)).toBe(true);
        expect(conn.serverId).toBe(SRVB);
        expect(picked).toContain(SRVB);
        await waitUntil(() => seenUrls.includes("wss://b.invalid/v3/ws"), "dial srvB after conn.link.start()");
        await waitUntil(() => pendingWelcomes.has(SRVB), "srvB hello received");
        await new Promise((r) => setTimeout(r, 25));
        expect(await loadPref("server", idb)).toBe(SRVA);

        // Now let srvB welcome -> attaches to srvB and persists SRVB!
        holdWelcome.delete(SRVB);
        pendingWelcomes.get(SRVB)!();
        await waitUntil(() => conn.link.attachedServerId() === SRVB, "attach srvB");
        await new Promise((r) => setTimeout(r, 30));
        expect(await loadPref("server", idb)).toBe(SRVB);

        // Re-opening openConnection reads persisted SRVB as lastGood first (§13.1)!
        await conn.close();
        seenUrls.length = 0;
        const conn2 = await openConnection(record, newDiagnostics(), "https://a.invalid/v3/");
        connections.push(conn2);
        expect(conn2.serverId).toBe(SRVB);
        conn2.link.start();
        await waitUntil(() => seenUrls.includes("wss://b.invalid/v3/ws"), "conn2 dials srvB");
      } finally {
        (globalThis as { WebSocket?: typeof WebSocket }).WebSocket = prevWs;
        await new Promise<void>((resolve) => {
          const req = idb.deleteDatabase(DEVICE_DB);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
      }
    } finally {
      (globalThis as { indexedDB?: IDBFactory }).indexedDB = prevIdb;
      if (prevNavDesc) Object.defineProperty(globalThis, "navigator", prevNavDesc); else delete (globalThis as { navigator?: unknown }).navigator;
      if (prevWinDesc) Object.defineProperty(globalThis, "window", prevWinDesc); else delete (globalThis as { window?: unknown }).window;
    }
  });

  it("F5 dedup: command held on A, re-sent and applied on B, then healForward on A causes zero duplicate apply", async () => {
    const clock = new CountingClock();
    const cluster = new MultiServerCluster(clock);
    cluster.addServer("srvA", "Machine A", ["a1"]);
    cluster.addServer("srvB", "Machine B", ["b1"]);

    const fb = await openFallbackLink({
      storage: new MemoryFeStorage(),
      servers: cluster.dialTargets(),
      designatedServerId: "srvA",
      deviceId: "phone",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
    });
    opened.push(fb);
    const BOT1 = "bot:b1" as StreamId;
    fb.link.subscribe(BOT1);
    fb.start();
    await flush();
    expect(fb.link.attachedServerId()).toBe("srvA");

    // Partition A->B so A holds the commands unsettled without forwarding to B.
    cluster.partitionedFromOwner.add("srvA->srvB");
    for (let i = 1; i <= 10; i++) {
      await fb.link.submit(BOT1 as Target, react(`dup-${i}`));
    }
    await flush();
    expect(cluster.heldForward.get("srvB")?.length).toBe(10);
    expect(cluster.applied.filter((a) => a.slot.target === BOT1)).toHaveLength(0);

    // Switch to B while A still holds its copies -> FE re-sends to B and B applies [1..10].
    expect(fb.pickServer("srvB")).toBe(true);
    await flush();
    expect(fb.link.attachedServerId()).toBe("srvB");
    expect(cluster.applied.filter((a) => a.slot.target === BOT1).map((a) => a.slot.n))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(fb.link.pending()).toEqual([]);

    // Now heal A->B so A delivers its held copies to B; server-side slot dedup prevents any duplicate apply!
    await cluster.healForward("srvB");
    await flush();
    expect(cluster.heldForward.get("srvB")).toBeUndefined();
    expect(cluster.applied.filter((a) => a.slot.target === BOT1).map((a) => a.slot.n))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("F5 + F2: requires all paths attempted before auto-switch and never re-enters dial synchronously", async () => {
    const clock = new CountingClock();
    const cluster = new MultiServerCluster(clock);
    cluster.addServer("srvA", "Machine A");
    cluster.addServer("srvB", "Machine B");

    let dialDepth = 0;
    let maxDialDepth = 0;
    let switchedDuringDial = false;
    const rawTargets = cluster.dialTargets();
    const wrappedTargets = rawTargets.map((t) => ({
      ...t,
      directDial: (h: SocketHandlers): FeSocket => {
        dialDepth += 1;
        maxDialDepth = Math.max(maxDialDepth, dialDepth);
        try { return t.directDial!(h); } finally { dialDepth -= 1; }
      },
      relayDial: (h: SocketHandlers): FeSocket => {
        dialDepth += 1;
        maxDialDepth = Math.max(maxDialDepth, dialDepth);
        try { return t.relayDial!(h); } finally { dialDepth -= 1; }
      },
    }));

    const switched: Array<{ from: string; to: string; reason: string }> = [];
    let directTimeoutMs = 25_000;
    const fb = await openFallbackLink({
      storage: new MemoryFeStorage(),
      servers: wrappedTargets,
      designatedServerId: "srvA",
      directTimeoutMs,
      switchAfterMs: UNREACHABLE_SWITCH_MS,
      deviceId: "phone",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
      onSwitch: (ev) => {
        switched.push(ev);
        if (dialDepth > 0) switchedDuringDial = true;
      },
    });
    opened.push(fb);
    fb.link.start();
    await flush();
    expect(fb.link.attachedServerId()).toBe("srvA");

    // Phase 1: direct hangs and relay opens at 25 s (< 30 s) -> relay succeeds and cancels switch window on srvA.
    cluster.killServer("srvA");
    cluster.reviveServer("srvA", { direct: "hang", relay: "open" });
    await flush();
    await advanceWithFlush(clock, 26_000, 5_000);
    expect(fb.link.attachedServerId()).toBe("srvA");
    expect(fb.path).toBe("relay");
    expect(switched).toEqual([]);

    // Phase 2: direct hangs + relay refuses with directTimeoutMs > 30 s (use a fresh link with 35 s directTimeoutMs):
    await fb.close();
    cluster.reviveServer("srvA", { direct: "open", relay: "open" });
    const fb2 = await openFallbackLink({
      storage: new MemoryFeStorage(),
      servers: wrappedTargets,
      designatedServerId: "srvA",
      directTimeoutMs: 35_000,
      switchAfterMs: UNREACHABLE_SWITCH_MS,
      deviceId: "phone",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
      onSwitch: (ev) => {
        switched.push(ev);
        if (dialDepth > 0) switchedDuringDial = true;
      },
    });
    opened.push(fb2);
    fb2.link.start();
    await flush();
    expect(fb2.link.attachedServerId()).toBe("srvA");

    cluster.killServer("srvA");
    cluster.reviveServer("srvA", { direct: "hang", relay: "refuse" });
    await flush();

    // At 30 s, only direct was tried (relay NOT yet attempted because directTimeoutMs = 35 s) -> MUST NOT switch!
    await advanceWithFlush(clock, UNREACHABLE_SWITCH_MS, 5_000);
    expect(fb2.serverId).toBe("srvA");
    expect(switched).toEqual([]);

    // At 35 s (+ 250 ms reconnect backoff), directTimeoutMs fires, tries relay -> deferred timeout(0) switches cleanly!
    await advanceWithFlush(clock, 6_000, 1_000);
    expect(fb2.serverId).toBe("srvB");
    expect(fb2.link.attachedServerId()).toBe("srvB");
    expect(switchedDuringDial).toBe(false);
    expect(maxDialDepth).toBe(1);
    expect(switched).toEqual([{ from: "srvA", to: "srvB", reason: "auto" }]);
  });

  it("F2 + F3 controller invariants: defers auto-switch to timeout(0) and clears timer when no candidates remain", () => {
    const clock = new CountingClock();
    const switched: string[] = [];
    const ctrl = new ServerSwitchController({
      servers: [
        { id: "srvA", name: "A", state: "live", dialable: true },
        { id: "srvB", name: "B", state: "live", dialable: true },
      ],
      designatedId: "srvA",
      clock,
      onSwitch: ({ to }) => switched.push(to),
    });
    ctrl.noteDialStart("srvA", ["direct", "relay"]);
    ctrl.notePathAttempt("srvA", "direct");
    clock.advance(UNREACHABLE_SWITCH_MS);
    // Still has not switched because relay was not tried yet.
    expect(switched).toEqual([]);
    // Trying relay past 30 s does NOT invoke onSwitch synchronously (F2), defers to timeout(0).
    ctrl.notePathAttempt("srvA", "relay");
    expect(switched).toEqual([]);
    clock.advance(0);
    expect(switched).toEqual(["srvB"]);

    // F3: mark srvA gone so when srvB also stays unreachable, no candidates remain and timer is cleared (pending === 0).
    ctrl.updateServers([{ id: "srvA", name: "A", state: "gone", dialable: false }]);
    ctrl.noteDialStart("srvB", ["direct"]);
    ctrl.notePathAttempt("srvB", "direct");
    clock.advance(UNREACHABLE_SWITCH_MS);
    expect(ctrl.current()).toBe("srvB");
    expect(clock.pending).toBe(0);
    ctrl.stop();
  });

  it("F4: gone is irreversible across mergeServerCandidates, mergeServers, and openFallbackLink syncServers", async () => {
    // 1. FeLink server-switch layer: gone strips addresses and cannot revert to live.
    const mergedCandidates = mergeServerCandidates(
      [{ id: "srvB", name: "B", state: "gone", dh: "kB" }],
      [{ id: "srvB", name: "B", state: "live", dialable: true, addresses: { tailnet: "wss://evil.invalid/v3/ws" } }],
    );
    expect(mergedCandidates).toEqual([{ id: "srvB", name: "B", state: "gone", dh: "kB", dialable: false }]);

    // 2. device-store layer: gone strips addresses and cannot revert to live.
    const stored = mergeServers(
      [{ id: "srvB", name: "B", state: "live", dh: "kB", addresses: { tailnet: "wss://b.invalid/v3/ws" } }],
      [{ id: "srvB", name: "B", state: "gone", since: 100 }],
    );
    expect(stored).toEqual([{ id: "srvB", name: "B", state: "gone", dh: "kB", since: 100 }]);
    const afterFakeRevive = mergeServers(stored, [
      { id: "srvB", name: "B", state: "live", since: 200, addresses: { tailnet: "wss://evil.invalid/v3/ws" } },
    ]);
    expect(afterFakeRevive).toEqual([{ id: "srvB", name: "B", state: "gone", dh: "kB", since: 100 }]);

    // 3. connection.ts syncServers: strips previous addresses/dials on gone and resists peer{state: "live"}.
    const clock = new CountingClock();
    const cluster = new MultiServerCluster(clock);
    cluster.addServer("srvA", "Machine A");
    cluster.addServer("srvB", "Machine B");
    const fb = await openFallbackLink({
      storage: new MemoryFeStorage(),
      servers: cluster.dialTargets(),
      designatedServerId: "srvA",
      deviceId: "phone",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
    });
    opened.push(fb);
    fb.link.start();
    await flush();

    cluster.markGone("srvB");
    await flush();
    expect(fb.pickServer("srvB")).toBe(false);

    // Even if a rogue/stale frame claims srvB is live again with addresses, it stays gone and undialable!
    for (const conn of cluster.openConns) {
      if (conn.serverId === "srvA") {
        const enc = encodeFrame({
          t: "peer", serverId: "srvB", state: "live", since: 999,
          addresses: { tailnet: "wss://evil.invalid/v3/ws" },
        }, "server", REMOTE);
        if (enc.ok) conn.handlers.frame(enc.text);
      }
    }
    await flush();
    expect(fb.pickServer("srvB")).toBe(false);

    cluster.dialLog.length = 0;
    cluster.killServer("srvA");
    await flush();
    await advanceWithFlush(clock, UNREACHABLE_SWITCH_MS, 5_000);
    expect(fb.serverId).toBe("srvA");
    expect(cluster.dialLog.some((d) => d.serverId === "srvB")).toBe(false);
  });

  it("re-calling pickServer on the current unreachable server does not restart the 30 s switch window", async () => {
    const clock = new CountingClock();
    const cluster = new MultiServerCluster(clock);
    cluster.addServer("srvA", "Machine A");
    cluster.addServer("srvB", "Machine B");

    const fb = await openFallbackLink({
      storage: new MemoryFeStorage(),
      servers: cluster.dialTargets(),
      designatedServerId: "srvA",
      deviceId: "phone",
      feVersion: "3.0.0",
      local: false,
      clock,
      newEpoch: nextEpoch,
    });
    opened.push(fb);
    fb.link.start();
    await flush();
    expect(fb.link.attachedServerId()).toBe("srvA");

    // Kill srvA so the 30 s unreachable window starts.
    cluster.killServer("srvA");
    await flush();
    expect(fb.serverId).toBe("srvA");

    // Advance 20 s into the 30 s window, then re-call pickServer("srvA") on the current target.
    await advanceWithFlush(clock, 20_000, 1_000);
    expect(fb.serverId).toBe("srvA");
    const dialsBeforeRepick = cluster.dialLog.length;
    expect(fb.pickServer("srvA")).toBe(true);
    await flush();
    expect(fb.serverId).toBe("srvA");
    expect(cluster.dialLog.length).toBe(dialsBeforeRepick);

    // Advance only 10 s more (30 s total since srvA went down — NOT 30 s since re-pick!).
    // Must switch to srvB right at the original 30 s deadline.
    await advanceWithFlush(clock, 10_000, 1_000);
    expect(fb.serverId).toBe("srvB");
    expect(fb.link.attachedServerId()).toBe("srvB");
  });
});
