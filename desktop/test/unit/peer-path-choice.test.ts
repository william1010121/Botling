// Botling 3 M4-15: peer path choice (loopback → tailnet → relay) with staggering, 60 s re-probing,
// one-session-per-pair, no re-probing of revoked peers, and real two-server loopback + relay upgrade under 50
// forwarded commands.
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { slotKey, type Message, type MessageOf, type Slot } from "../../src/protocol";
import { bindServerIdentity, loadOrCreateServerIdentity, type ServerIdentity } from "../../src/server/identity";
import { RelayConnector } from "../../src/server/net";
import {
  addressesValue, DEFAULT_PEER_TIMERS, peerAddresses, peerTimers, PeerSessions, relayConnector, SessionRouter,
  type AcceptedSession, type PeerConnection, type PeerConnector, type PeerPath, type PeerTimers,
} from "../../src/server/peer";
import { parseStored, RosterStore, type StoredStatement } from "../../src/server/roster";
import { newRelayRoomKey, relayDeviceToken, relayRoomOf, relayTokenHash, type LocalStatic, type SessionTransport } from "../../src/session";
import { testRoot } from "../botlingd-harness";
import { sleep, until } from "../helpers";
import { LocalRelay, RelayMeter } from "../support/local-relay";
import { makeCluster, readServerKeys, revokeServer, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestServer } from "../support/two-servers";
import { pairPhone, PhoneSession } from "../support/ws-device";

const root = testRoot("peer-path-choice");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TIMERS: PeerTimers = {
  pingMs: 150,
  deadMs: 900,
  redialMinMs: 40,
  redialMaxMs: 200,
  revokedRedialMs: 700,
  staggerMs: 80,
  reprobeMs: 240,
};

const deviceStub = {
  accept(transport: SessionTransport): AcceptedSession {
    return { link: { established: Promise.reject(new Error("a device dial")) }, receive: () => transport.close(), transportClosed: () => undefined };
  },
};

interface PathBehavior {
  mode: "ok" | "down" | "hang";
  delayMs?: number;
}

interface DialRecord {
  from: string;
  to: string;
  path: PeerPath;
  url: string;
  closed: boolean;
}

class PathNet {
  readonly routers = new Map<string, SessionRouter>();
  readonly dials: DialRecord[] = [];
  readonly paths = new Map<string, Record<PeerPath, PathBehavior>>();

  setBehavior(target: string, behavior: Partial<Record<PeerPath, PathBehavior>>): void {
    const cur = this.paths.get(target) ?? { loopback: { mode: "ok" }, tailnet: { mode: "ok" }, relay: { mode: "ok" } };
    this.paths.set(target, { ...cur, ...behavior });
  }

  connector(from: string, to: string, path: PeerPath): PeerConnector {
    return {
      connect: async (url) => {
        const rec: DialRecord = { from, to, path, url, closed: false };
        this.dials.push(rec);
        const behavior = (this.paths.get(to) ?? { loopback: { mode: "ok" }, tailnet: { mode: "ok" }, relay: { mode: "ok" } })[path];
        if (behavior.delayMs) await sleep(behavior.delayMs);
        if (behavior.mode === "down") throw new Error(`${path} refused`);
        if (behavior.mode === "hang") {
          return {
            send: () => undefined,
            close: () => { rec.closed = true; },
            bind: () => undefined,
          };
        }
        const router = this.routers.get(to);
        if (!router) throw new Error("no router");
        return this.pair(router, path === "relay" ? "relay" : "tailnet", rec);
      },
    };
  }

  pair(router: SessionRouter, kind: "tailnet" | "relay", rec: DialRecord): PeerConnection {
    let open = true;
    let events: { frame(frame: Uint8Array): void; closed(): void; resume?(): void } | null = null;
    const early: Array<() => void> = [];
    const toClient = (run: (e: { frame(frame: Uint8Array): void; closed(): void }) => void) => setImmediate(() => { if (events) run(events); else early.push(() => run(events!)); });
    const serverSide: SessionTransport = {
      send: (frame) => { if (open) { const copy = new Uint8Array(frame); toClient((e) => e.frame(copy)); } },
      close: () => { if (!open) return; open = false; rec.closed = true; setImmediate(() => accepted.transportClosed()); toClient((e) => e.closed()); },
    };
    const accepted = router.accept(serverSide, kind);
    return {
      send: (frame) => { if (open) { const copy = new Uint8Array(frame); setImmediate(() => { if (open) accepted.receive(copy); }); } },
      close: () => { if (!open) return; open = false; rec.closed = true; setImmediate(() => accepted.transportClosed()); toClient((e) => e.closed()); },
      bind: (bound) => { events = bound; for (const run of early.splice(0)) run(); },
    };
  }
}

interface TestPeer {
  name: string;
  port: number;
  dir: string;
  identity: ServerIdentity;
  keys: MemberKeysInfo;
  store?: Awaited<ReturnType<typeof import("../../src/server/store").openServerStore>>;
  roster?: RosterStore;
  peers?: PeerSessions;
  logs: string[];
}

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

let seq = 0;
async function makePeer(name: string, port: number): Promise<TestPeer> {
  const dir = join(root, `${name}-${++seq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { openServerStore } = await import("../../src/server/store");
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  await store.submit((tx) => bindServerIdentity(tx, identity));
  await store.close();
  return { name, port, dir, identity, keys: await readServerKeys(dir), logs: [] };
}

async function setupPair(
  net: PathNet,
  options: { startA?: boolean; startB?: boolean; timersA?: PeerTimers; timersB?: PeerTimers } = {},
) {
  const { openServerStore } = await import("../../src/server/store");
  const a = await makePeer("A", 43_000 + seq * 2);
  const b = await makePeer("B", 43_001 + seq * 2);
  const c = await makeCluster([a.keys, b.keys]);
  const { sign } = await import("../support/peer-cluster");
  const addrA = addressesValue(a.port, { tailnet: `https://peer-a-${seq}.tailnet.invalid`, relay: { url: "ws://127.0.0.1:9991/ws", room: "room-a" } });
  const addrB = addressesValue(b.port, { tailnet: `https://peer-b-${seq}.tailnet.invalid`, relay: { url: "ws://127.0.0.1:9992/ws", room: "room-b" } });
  const profA = await sign({ type: "profile", cluster: c.clusterId, member: a.keys.memberId, field: "addresses", value: addrA, hlc: { ms: Date.now(), c: 0 } }, a.keys);
  const profB = await sign({ type: "profile", cluster: c.clusterId, member: b.keys.memberId, field: "addresses", value: addrB, hlc: { ms: Date.now(), c: 0 } }, b.keys);
  writeStatements(a.dir, c.clusterId, [...c.statements, profA, profB]);
  writeStatements(b.dir, c.clusterId, [...c.statements, profA, profB]);

  const open = async (peer: TestPeer, other: TestPeer, timers: PeerTimers, start: boolean) => {
    peer.store = await openServerStore(peer.dir);
    peer.roster = await RosterStore.open(peer.store, peer.identity, { log: (l) => peer.logs.push(l) });
    const self: LocalStatic = { memberId: peer.identity.memberId, dhPub: peer.identity.dhPub, dhKey: peer.identity.dhKey };
    peer.peers = new PeerSessions(
      { roster: peer.roster, self, timers, log: (l) => peer.logs.push(l) },
      {
        connectors: {
          loopback: net.connector(peer.name, other.identity.memberId, "loopback"),
          tailnet: net.connector(peer.name, other.identity.memberId, "tailnet"),
          relay: net.connector(peer.name, other.identity.memberId, "relay"),
        },
        random: () => 0,
      },
    );
    net.routers.set(peer.identity.memberId, new SessionRouter(deviceStub, peer.peers));
    cleanups.push(async () => {
      peer.peers?.close();
      await sleep(20);
      await peer.store?.close().catch(() => undefined);
    });
    if (start) peer.peers.start();
  };

  await open(a, b, options.timersA ?? TIMERS, options.startA ?? true);
  await open(b, a, options.timersB ?? TIMERS, options.startB ?? false);
  return { a, b, ...c };
}

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}

function readAddressProfiles(server: TestServer): StoredStatement[] {
  return withDb(server, (db) => {
    const rows = db.prepare("SELECT id, bytes FROM roster WHERE kind = 'profile' ORDER BY receivedAt DESC").all() as Array<{ id: string; bytes: Uint8Array }>;
    const out: StoredStatement[] = [];
    for (const row of rows) {
      const statement = parseStored(row.bytes);
      if (statement?.body.type === "profile" && statement.body.field === "addresses") {
        out.push({ id: row.id, statement });
      }
    }
    return out;
  });
}

function readPeerFile(server: TestServer): Array<{ member: string; state: string; initiator?: string; sessionId?: string; path?: string }> {
  try {
    const raw = JSON.parse(readFileSync(join(server.dataDir, "botlingd.peers.json"), "utf8")) as { peers?: Array<{ member: string; state: string; initiator?: string; sessionId?: string; path?: string }> };
    return raw.peers ?? [];
  } catch {
    return [];
  }
}

describe("M4-15: peer path choice, staggering, and 60 s re-probing", () => {
  it("config: DEFAULT_PEER_TIMERS and peerTimers include staggerMs (300) and reprobeMs (60 000)", () => {
    expect(DEFAULT_PEER_TIMERS.staggerMs).toBe(300);
    expect(DEFAULT_PEER_TIMERS.reprobeMs).toBe(60_000);
    expect(peerTimers({ BOTLING_SERVER_PEER_TIMERS: "stagger=120,reprobe=5000" })).toMatchObject({
      staggerMs: 120,
      reprobeMs: 5_000,
    });
    expect(() => peerTimers({ BOTLING_SERVER_PEER_TIMERS: "stagger=5" })).toThrow();
    expect(() => peerTimers({ BOTLING_SERVER_PEER_TIMERS: "reprobe=abc" })).toThrow();
  });

  it("1: loopback answering first wins, and the others are closed or never started", async () => {
    // 1a: loopback answers before staggerMs -> tailnet and relay are never dialled.
    const netFast = new PathNet();
    const { a: a1, b: b1 } = await setupPair(netFast, { startA: false, startB: false, timersA: { ...TIMERS, staggerMs: 400 } });
    netFast.setBehavior(b1.identity.memberId, {
      loopback: { mode: "ok", delayMs: 5 },
      tailnet: { mode: "ok", delayMs: 5 },
      relay: { mode: "ok", delayMs: 5 },
    });
    a1.peers!.start();
    await until(() => a1.peers!.states()[0]?.state === "live", { what: "1a A live with B" });
    expect(a1.peers!.states()[0]?.path).toBe("loopback");
    expect(netFast.dials.map((d) => d.path)).toEqual(["loopback"]);

    // 1b: loopback takes > staggerMs (120ms > 80ms) so tailnet starts at 80ms, but loopback finishes handshake first
    // (tailnet delayed 250ms); tailnet is closed and relay is never started.
    const netSlow = new PathNet();
    const { a: a2, b: b2 } = await setupPair(netSlow, { startA: false, startB: false });
    netSlow.setBehavior(b2.identity.memberId, {
      loopback: { mode: "ok", delayMs: 120 },
      tailnet: { mode: "ok", delayMs: 250 },
      relay: { mode: "ok", delayMs: 250 },
    });
    a2.peers!.start();
    await until(() => a2.peers!.states()[0]?.state === "live", { timeout: 10_000, what: "1b A live with B" });
    expect(a2.peers!.states()[0]?.path).toBe("loopback");
    expect(netSlow.dials.some((d) => d.path === "tailnet")).toBe(true);
    await until(() => netSlow.dials.filter((x) => x.path !== "loopback").every((d) => d.closed), { timeout: 5_000, what: "1b slower dial closed" });
    expect(netSlow.dials.some((d) => d.path === "relay")).toBe(false);
  });

  it("2: loopback down (or hanging): relay wins", async () => {
    const net = new PathNet();
    const { a, b } = await setupPair(net, { startA: false, startB: false, timersB: { ...TIMERS, reprobeMs: 60_000 } });
    net.setBehavior(b.identity.memberId, {
      loopback: { mode: "hang" },
      tailnet: { mode: "down" },
      relay: { mode: "ok", delayMs: 10 },
    });
    a.peers!.start();
    await until(() => a.peers!.states()[0]?.state === "live", { timeout: 10_000, what: "relay wins when loopback hangs and tailnet is down" });
    expect(a.peers!.states()[0]?.path).toBe("relay");
    expect(a.peers!.session(b.identity.memberId)?.link.info?.transport).toBe("relay");
    const lbDial = net.dials.find((d) => d.path === "loopback");
    expect(lbDial?.closed).toBe(true);
  });

  it("3a: loopback comes back (fake connectors): within one reprobe the session moves to loopback and closes the old relay session", async () => {
    const net = new PathNet();
    const { a, b } = await setupPair(net, { startA: false, startB: false });
    net.setBehavior(b.identity.memberId, {
      loopback: { mode: "down" },
      tailnet: { mode: "down" },
      relay: { mode: "ok", delayMs: 5 },
    });
    a.peers!.start();
    await until(() => a.peers!.states()[0]?.state === "live" && a.peers!.states()[0]?.path === "relay", {
      timeout: 10_000,
      what: "initially live on relay",
    });
    const oldSession = a.peers!.session(b.identity.memberId)!;
    const oldId = oldSession.link.info!.sessionId;

    // Bring loopback back; within one reprobeMs, the session upgrades to loopback and closes the relay session.
    net.setBehavior(b.identity.memberId, { loopback: { mode: "ok", delayMs: 5 } });
    try {
      await until(() => a.peers!.states()[0]?.path === "loopback", { timeout: 10_000, what: "moved to loopback on reprobe" });
    } catch (err) {
      throw new Error(`${String(err)}\nstate=${JSON.stringify(a.peers!.states())}\ndials=${JSON.stringify(net.dials)}\nlogsA=${a.logs.join(" | ")}\nlogsB=${b.logs.join(" | ")}`);
    }
    const newSession = a.peers!.session(b.identity.memberId)!;
    expect(newSession).not.toBe(oldSession);
    expect(newSession.link.info!.sessionId).not.toBe(oldId);
    expect(oldSession.state).toBe("closed");

    // Once on loopback, no more reprobe dials are scheduled.
    const dialsAtUpgrade = net.dials.length;
    await sleep(TIMERS.reprobeMs! * 2);
    expect(net.dials.length).toBe(dialsAtUpgrade);
  });

  it("3b: real two-server case on loopback + relay — moves to loopback on reprobe with 50 forwarded commands (0 lost, 0 doubled)", async () => {
    const localRelay = await new LocalRelay().ready();
    cleanups.push(() => localRelay.stop());

    const envTimers = {
      BOTLING_SERVER_PEER_TIMERS: "ping=300,dead=3000,redial=100,redialMax=600,revoked=2500,stagger=80,reprobe=400",
    };
    const two = await startServers({
      name: "path-choice-real",
      count: 2,
      env: {
        A: { ...envTimers, BOTLING_SERVER_RELAY_URL: localRelay.url },
        B: { ...envTimers, BOTLING_SERVER_RELAY_URL: localRelay.url },
      },
    });
    cleanups.push(() => two.cleanup());

    await Promise.all([two.a.stop(), two.b.stop()]);
    const [ka, kb] = await Promise.all([readServerKeys(two.a.dataDir), readServerKeys(two.b.dataDir)]);
    const pa = await two.proxy(two.a, "websocket");
    const pb = await two.proxy(two.b, "websocket");
    const made = await makeCluster([ka, kb]);
    writeStatements(two.a.dataDir, made.clusterId, made.statements);
    writeStatements(two.b.dataDir, made.clusterId, made.statements);

    // Partition loopback first so both write their Profile{addresses: {loopback: proxy, relay}} without connecting yet.
    pa.partition();
    pb.partition();
    await Promise.all([two.a.start(), two.b.start()]);
    await Promise.all([
      until(() => readAddressProfiles(two.a).some((s) => {
        const body = s.statement.body;
        return body.type === "profile" && body.member === ka.memberId && !!peerAddresses(body.value).relay && !!peerAddresses(body.value).loopback;
      }), { timeout: 20_000, what: "A wrote full profile" }),
      until(() => readAddressProfiles(two.b).some((s) => {
        const body = s.statement.body;
        return body.type === "profile" && body.member === kb.memberId && !!peerAddresses(body.value).relay && !!peerAddresses(body.value).loopback;
      }), { timeout: 20_000, what: "B wrote full profile" }),
    ]);
    await Promise.all([two.a.stop(), two.b.stop()]);
    const profA = readAddressProfiles(two.a);
    const profB = readAddressProfiles(two.b);
    writeStatements(two.a.dataDir, made.clusterId, profB);
    writeStatements(two.b.dataDir, made.clusterId, profA);

    // Start both with loopback still partitioned -> both stagger and connect through the relay.
    await Promise.all([two.a.start(), two.b.start()]);
    const smaller = ka.memberId < kb.memberId ? ka.memberId : kb.memberId;
    const dialerServer = smaller === ka.memberId ? two.a : two.b;
    const relaySessionId = await until(() => {
      const s1 = readPeerFile(two.a)[0];
      const s2 = readPeerFile(two.b)[0];
      if (s1?.state === "live" && s2?.state === "live" && s1.sessionId && s1.sessionId === s2.sessionId && s1.initiator === smaller) {
        return s1.sessionId;
      }
      return null;
    }, { timeout: 30_000, what: "both live over relay" });
    expect(readPeerFile(dialerServer)[0]?.path).toBe("relay");

    // Create a bot on B, wait for A to replicate srv:B.
    const cB = await two.b.client("script", "d".repeat(32));
    cleanups.push(() => cB.close());
    await cB.sub(cB.srv);
    const snapB = await cB.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === cB.srv, "B srv snap");
    cB.cmd({ origin: "script", originEpoch: cB.originEpoch, target: cB.srv, n: 1 } as Slot, { type: "bots.create", name: "Path Bot", job: "reprobe forwarding" }, snapB.logId);
    const created = await cB.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create on B");
    const botId = (created.outcome as { result: { botId: string } }).result.botId;

    await until(() => withDb(two.a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(cB.srv, `bot:${botId}`)), { timeout: 20_000, what: "A replicated bot row over relay" });
    const inc = withDb(two.a, (db) => String((db.prepare("SELECT logId FROM streams WHERE stream = ?").get(cB.srv) as { logId: string }).logId));

    const cAdmin = await two.a.client("admin", "f".repeat(32));
    cleanups.push(() => cAdmin.close());
    const phone = await pairPhone(cAdmin, two.a.port, "PathPhone");
    await until(() => withDb(two.b, (db) => !!db.prepare("SELECT 1 FROM roster WHERE kind = 'add' AND member = ?").get(phone.keys.member)), {
      timeout: 20_000,
      what: "B learned phone Add over relay",
    });

    const ph = await PhoneSession.open(phone.keys, two.a.port, ka, made.clusterId);
    cleanups.push(() => ph.close());
    await until(() => ph.welcomed, { timeout: 15_000, what: "phone welcomed on A" });
    const phoneEpoch = "e".repeat(32);

    // Send 20 commands over relay, heal loopback mid-flight, then send 30 more across the reprobe transition.
    for (let n = 1; n <= 20; n++) {
      expect(ph.send({
        t: "cmd",
        slot: { origin: phone.keys.member, originEpoch: phoneEpoch, target: `bot:${botId}`, n } as Slot,
        floor: 1,
        inc,
        cmd: { type: "chat.send", botId, text: `/say cmd-${n}` },
      } as Message)).toBe(true);
    }
    pa.heal();
    pb.heal();
    for (let n = 21; n <= 50; n++) {
      expect(ph.send({
        t: "cmd",
        slot: { origin: phone.keys.member, originEpoch: phoneEpoch, target: `bot:${botId}`, n } as Slot,
        floor: 1,
        inc,
        cmd: { type: "chat.send", botId, text: `/say cmd-${n}` },
      } as Message)).toBe(true);
    }

    // Wait for reprobe upgrade to loopback and all 50 results.
    await until(() => {
      const p = readPeerFile(dialerServer)[0];
      return p?.state === "live" && p.path === "loopback" && p.sessionId !== relaySessionId;
    }, { timeout: 20_000, what: "dialer upgraded to loopback on reprobe" });

    const results = new Map<number, MessageOf<"cmd.result">>();
    await until(() => {
      for (const m of ph.got) {
        if (m.t === "cmd.result" && m.slot.target === `bot:${botId}`) results.set(m.slot.n, m);
      }
      return results.size === 50;
    }, { timeout: 30_000, what: "all 50 forwarded commands answered across move" });
    for (let n = 1; n <= 50; n++) {
      expect(results.get(n)?.outcome.kind).toBe("applied");
    }

    // Confirm 0 lost, 0 doubled in B's server.db entries.
    const appliedSlots = withDb(two.b, (db) => (
      db.prepare("SELECT kind, slot FROM entries WHERE kind IN ('cmd.applied', 'cmd.refused') AND slot IS NOT NULL").all() as Array<{ kind: string; slot: string }>
    ).map((r) => ({ kind: String(r.kind), slot: JSON.parse(r.slot) as Slot }))
      .filter((e) => e.slot.origin === phone.keys.member && e.slot.originEpoch === phoneEpoch && e.slot.target === `bot:${botId}`));
    expect(appliedSlots).toHaveLength(50);
    expect(new Set(appliedSlots.map((e) => slotKey(e.slot))).size).toBe(50);
  }, 120_000);

  it("4: both servers dialling at once still end with one session (smaller serverId wins)", async () => {
    const net = new PathNet();
    const { a, b } = await setupPair(net, { startA: false, startB: false });
    net.setBehavior(a.identity.memberId, { loopback: { mode: "ok", delayMs: 20 }, tailnet: { mode: "ok", delayMs: 20 }, relay: { mode: "ok", delayMs: 20 } });
    net.setBehavior(b.identity.memberId, { loopback: { mode: "ok", delayMs: 5 }, tailnet: { mode: "ok", delayMs: 5 }, relay: { mode: "ok", delayMs: 5 } });

    a.peers!.start();
    b.peers!.start();

    const smaller = a.identity.memberId < b.identity.memberId ? a.identity.memberId : b.identity.memberId;
    let settledSince = 0;
    let settledId = "";
    await until(() => {
      const sa = a.peers!.states()[0];
      const sb = b.peers!.states()[0];
      if (sa?.state === "live" && sb?.state === "live" && sa.sessionId && sa.sessionId === sb.sessionId && sa.initiator === smaller) {
        if (settledId !== sa.sessionId) { settledId = sa.sessionId; settledSince = Date.now(); }
        return Date.now() - settledSince >= 150;
      }
      settledId = "";
      return false;
    }, { timeout: 10_000, what: "both agree on one session initiated by smaller id" });

    expect(a.peers!.all.filter((s) => s.state === "open")).toHaveLength(1);
    expect(b.peers!.all.filter((s) => s.state === "open")).toHaveLength(1);
    expect(a.peers!.states()[0]?.initiator).toBe(smaller);
    expect(b.peers!.states()[0]?.initiator).toBe(smaller);
  });

  it("5: a revoked peer is never re-probed", async () => {
    const net = new PathNet();
    const { a, b, clusterId } = await setupPair(net, { startA: false, startB: false });
    net.setBehavior(b.identity.memberId, {
      loopback: { mode: "down" },
      tailnet: { mode: "down" },
      relay: { mode: "ok", delayMs: 5 },
    });
    a.peers!.start();
    await until(() => a.peers!.states()[0]?.state === "live" && a.peers!.states()[0]?.path === "relay", {
      timeout: 10_000,
      what: "live on relay before revoke",
    });

    // Revoke B on A's roster while live on relay; bring loopback up to confirm A never re-probes B.
    const rev = await revokeServer(clusterId, a.keys, b.keys);
    await a.roster!.mergeRevocations([rev.statement]);
    await until(() => a.peers!.states()[0]?.state === "gone", { timeout: 10_000, what: "B state gone after revoke" });

    const dialsAfterRevoke = net.dials.length;
    net.setBehavior(b.identity.memberId, { loopback: { mode: "ok", delayMs: 5 } });
    await sleep(TIMERS.reprobeMs! * 2);
    expect(net.dials.slice(dialsAfterRevoke)).toEqual([]);
  });

  it("6 (F1): PeerSessions bind passes resume so SessionLink drains when RelayPacer writable() turns false", async () => {
    const localRelay = await new LocalRelay().ready();
    cleanups.push(() => localRelay.stop());

    const pB = await makePeer("PB", 44_000 + seq);
    const pA = await makePeer("PA", 44_001 + seq);
    const c = await makeCluster([pA.keys, pB.keys]);
    const roomKey = newRelayRoomKey();
    const roomId = await relayRoomOf(roomKey);
    const { sign } = await import("../support/peer-cluster");
    const profB = await sign({
      type: "profile",
      cluster: c.clusterId,
      member: pB.keys.memberId,
      field: "addresses",
      value: addressesValue(null, { relay: { url: localRelay.url, room: roomId } }),
      hlc: { ms: Date.now(), c: 0 },
    }, pB.keys);
    writeStatements(pA.dir, c.clusterId, [...c.statements, profB]);
    writeStatements(pB.dir, c.clusterId, [...c.statements, profB]);

    const { openServerStore } = await import("../../src/server/store");
    const storeB = await openServerStore(pB.dir);
    const rosterB = await RosterStore.open(storeB, pB.identity, { log: () => undefined });
    const receivedAtB: string[] = [];
    const peersB = new PeerSessions({
      roster: rosterB,
      self: { memberId: pB.identity.memberId, dhPub: pB.identity.dhPub, dhKey: pB.identity.dhKey },
      timers: TIMERS,
      log: () => undefined,
      onMessage: (_s, msg) => {
        receivedAtB.push(msg.t);
        return true;
      },
    });
    const routerB = new SessionRouter(deviceStub, peersB);
    const tokenA = await relayDeviceToken(pA.identity.memberId, pA.identity.dhKey, pB.identity.dhPub);
    const tokenAHash = await relayTokenHash(tokenA);
    const meter = await new RelayMeter(() => localRelay.url).start();
    cleanups.push(() => meter.stop());
    const relayConnB = new RelayConnector({
      url: meter.url,
      roomKey,
      sessions: routerB,
      allowList: async () => [{ h: tokenAHash }],
      log: () => undefined,
    });
    cleanups.push(async () => { relayConnB.close(); peersB.close(); await storeB.close(); });
    await relayConnB.start();
    await until(() => relayConnB.state === "ready" && (meter.connections[0]?.counts.allow ?? 0) >= 1, { timeout: 10_000, what: "F1 room ready" });

    const storeA = await openServerStore(pA.dir);
    const rosterA = await RosterStore.open(storeA, pA.identity, { log: () => undefined });
    const peersA = new PeerSessions(
      {
        roster: rosterA,
        self: { memberId: pA.identity.memberId, dhPub: pA.identity.dhPub, dhKey: pA.identity.dhKey },
        timers: TIMERS,
        log: () => undefined,
      },
      {
        connectors: {
          relay: relayConnector({
            room: roomId,
            self: { memberId: pA.identity.memberId, dhKey: pA.identity.dhKey },
            peerDhPub: pB.identity.dhPub,
            pace: { rate: 30, burst: 3, contentRate: 20, contentBurst: 1 },
          }),
        },
        random: () => 0,
      },
    );
    cleanups.push(async () => { peersA.close(); await sleep(20); await storeA.close(); });
    peersA.start();

    await until(() => peersA.states()[0]?.state === "live" && peersB.states()[0]?.state === "live", { timeout: 15_000, what: "F1 session live" });
    const sessionA = peersA.session(pB.identity.memberId)!;
    // Queue enough bulk chunks + pings in one burst to trip RelayPacer writable() === false; without resume(),
    // SessionLink stops pumping and the trailing pings never arrive at B.
    const bigBytes = new Uint8Array(70 * 1024).fill(0xab);
    for (let i = 0; i < 8; i++) {
      expect(sessionA.sendChunk({ t: "content.chunk", req: `req-${i}`, offset: 0, bytes: bigBytes })).toBe(true);
    }
    for (let i = 0; i < 4; i++) expect(sessionA.sendWire({ t: "content.credit", req: `ctrl-${i}`, bytes: 1 })).toBe(true);

    await until(() => receivedAtB.filter((t) => t === "content.chunk").length === 8 && receivedAtB.filter((t) => t === "content.credit").length === 4 && sessionA.queuedBytes === 0, {
      timeout: 15_000,
      what: "F1 queued chunks and trailing control frames resumed and drained to B",
    });
  }, 45_000);
});
