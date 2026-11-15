// Botling 3 M4-16b: a server dials a peer server through the peer's relay room (server/peer/relay-connector.ts,
// peer-session.ts dialer transport: "relay"), with §6.3 pacing and revocation-sync-first KK sessions.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  decodeFrame, decodeWireFrame, encodeFrame, encodeWireFrame, fromBase64Url, slotKey,
  type Message, type MessageOf, type Slot, type StreamId, type WireMessage,
} from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { Directory, Forwarder } from "../../src/server/forward";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { CHANNEL_FRAMES, LoopbackListener, RELAY_PACE, RelayConnector } from "../../src/server/net";
import { PairingService } from "../../src/server/pairing";
import {
  DEFAULT_PEER_TIMERS, peerAddresses, PeerSession, PeerSessions, relayConnector, SessionRouter, webSocketConnector,
  type PeerSessionHost, type RelayAddress,
} from "../../src/server/peer";
import { PeerTables, TableFeeds } from "../../src/server/replica";
import { Gossip, parseStored, PrefsStore, RosterStore, type StoredStatement } from "../../src/server/roster";
import { RemoteSessions, slotAuthorize, type RemoteHost, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore } from "../../src/server/store";
import { newRelayRoomKey, relayDeviceToken, relayRoomOf, relayTokenHash, SessionLink } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { until } from "../helpers";
import { bucketRefusals, LocalRelay, maxInWindow, RelayMeter } from "../support/local-relay";
import { makeCluster, readServerKeys, sign, strangerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { freeLoopbackPort, startServers, type TestCluster, type TestServer } from "../support/two-servers";
import { deviceKeys } from "../support/ws-device";

const TIMERS = { ping: 300, dead: 3_000, redial: 150, redialMax: 800, revoked: 2_500 };
const TIMERS_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };
const REMOTE = { local: false } as const;
const encoder = new TextEncoder();

const scratchRoot = mkdtempSync(join(tmpdir(), "peer-relay-dial-"));
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

function withDb<T>(server: TestServer, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(server.dataDir, "server.db"), { readOnly: true });
  try { db.exec("PRAGMA busy_timeout = 10000"); return run(db); } finally { db.close(); }
}

function readRelayAddress(server: TestServer): RelayAddress | null {
  return withDb(server, (db) => {
    const rows = db.prepare("SELECT bytes FROM roster WHERE kind = 'profile' ORDER BY receivedAt DESC").all() as Array<{ bytes: Uint8Array }>;
    for (const row of rows) {
      const parsed = parseStored(row.bytes);
      const body = parsed?.body;
      if (body?.type === "profile" && body.field === "addresses") {
        const addr = peerAddresses(body.value).relay;
        if (addr) return addr;
      }
    }
    return null;
  });
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

async function openInProcessA(dataDir: string, options: { onRelayMessage?: PeerSessionHost["onMessage"]; withListener?: boolean } = {}) {
  const store = await openServerStore(dataDir);
  const identity = await loadOrCreateServerIdentity(dataDir, { create: false });
  const serverId = identity.memberId;
  const memberId = identity.memberId;
  const logs: string[] = [];
  const log = (line: string) => { logs.push(line); };
  const roster = await RosterStore.open(store, identity, { log });
  const prefs = await PrefsStore.open(store, { self: memberId, knownWriter: (w) => roster.view.servers.has(w), log });
  const gossip = new Gossip({ roster, prefs, log });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const engine = new FakeTurnEngine({ bots: [], chunks: ["ok"], chunkMs: 1 });
  const feeds = new TableFeeds({ reader: () => hub.reader(), ownStream: `srv:${serverId}`, log });
  const peerTables = new PeerTables({ store, reader: () => hub.reader(), feeds, log });
  const runtime = new IntentRuntime({ store, engine, hub, live, log, authorize: slotAuthorize(roster), serverEvents: "all", mirrorBotUpdates: true });
  await runtime.start();
  const shell = new ShellBridge();

  let activeSession: PeerSession | null = null;
  const directory = new Directory({
    self: serverId,
    reader: () => hub.reader(),
    peers: () => [...roster.view.members.values()].filter((m) => m.kind === "server" && m.member !== memberId).map((m) => m.member),
    hasBot: (botId) => engine.hasBot(botId),
  });
  const forwarder = new Forwarder({
    self: serverId,
    submit: (cmd) => store.submit(cmd),
    reader: () => hub.reader(),
    directory,
    session: (peer) => (activeSession && activeSession.peer === peer && activeSession.state === "open" ? activeSession : null),
    isRevoked: (peer) => !roster.view.valid.has(peer),
    log,
  });

  const pairing = new PairingService({
    roster, cluster: new ClusterSetup(roster), identity: { memberId, keys: identity.keys }, serverName: "Server A",
    addresses: () => ({ tailnet: "https://tailnet-name.invalid" }), pageUrl: () => "https://tailnet-name.invalid/v3/", log,
  });
  const base: SessionHost = {
    serverId, serverName: "Server A", startedAt: Date.now(), minFeVersion: "3.0.0", token: () => "t".repeat(32),
    hub, live, runtime, engine, content: null, shell,
    nextFor: (origin, originEpoch) => {
      const next: Record<string, number> = {};
      for (const row of hub.reader().prepare("SELECT target, next FROM slots WHERE origin = ? AND originEpoch = ?").all(origin, originEpoch)) next[String(row.target)] = Number(row.next);
      return next;
    },
    ensureBotStream: async (botId) => { if (!engine.hasBot(botId)) return false; await store.submit((tx) => { ensureBot(tx, botId); }); return true; },
    log,
    forward: {
      ownerOf: (target) => forwarder.ownerOf(target),
      commit: (envelope, owner) => forwarder.commit(envelope, owner),
      cancel: (slot, owner) => forwarder.cancel(slot, owner),
      attach: (origin, sink) => forwarder.attach(origin, sink),
    },
  };
  const remoteHost: RemoteHost = { ...base, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, pairing };
  const remote = new RemoteSessions(remoteHost);
  let listener: LoopbackListener | null = null;
  let port = 0;
  if (options.withListener) {
    port = await freeLoopbackPort();
    const router = new SessionRouter(remote, null);
    listener = await LoopbackListener.start({ port, remote: router, pageDir: scratchRoot, origins: () => [], log });
  }

  const peerHost: PeerSessionHost = {
    roster,
    self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey },
    timers: { pingMs: TIMERS.ping, deadMs: TIMERS.dead, redialMinMs: TIMERS.redial, redialMaxMs: TIMERS.redialMax, revokedRedialMs: TIMERS.revoked },
    log,
    onMessage: async (session, message) => {
      if (options.onRelayMessage && (await options.onRelayMessage(session, message)) !== false) return true;
      return (await gossip.onMessage(session, message)) || (await forwarder.onMessage(session, message)) || peerTables.onMessage(session, message);
    },
  };

  feeds.start();
  gossip.start();

  return {
    store, identity, memberId, roster, prefs, gossip, hub, live, engine, feeds, peerTables, runtime, shell,
    directory, forwarder, pairing, remote, listener, port, peerHost, logs,
    setActiveSession(session: PeerSession | null) { activeSession = session; },
    async close() {
      activeSession?.close("test closing");
      remote.close();
      await listener?.close();
      feeds.close();
      await runtime.scope.submit(() => undefined);
      engine.close();
      await runtime.close();
      shell.close();
      live.close();
      hub.close();
      await store.close();
    },
  };
}

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let clusterId: string;
let relay: LocalRelay;
let dialerMeter: RelayMeter;
let serverBMeter: RelayMeter;
let bRelayAddress: RelayAddress;

describe("M4-16b: peer dialer through the peer's relay room", () => {
  beforeAll(async () => {
    relay = await new LocalRelay().ready();
    dialerMeter = await new RelayMeter(() => relay.url).start();
    serverBMeter = await new RelayMeter(() => relay.url).start();

    cluster = await startServers({
      name: "relay-peers-dial",
      count: 2,
      env: {
        A: { ...TIMERS_ENV, BOTLING_SERVER_PORT: "off" },
        B: { ...TIMERS_ENV, BOTLING_SERVER_PORT: "off", BOTLING_SERVER_RELAY_URL: serverBMeter.url },
      },
    });
    ({ a, b } = cluster);
    await Promise.all([a.stop(), b.stop()]);
    [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
    const made = await makeCluster([ka, kb]);
    clusterId = made.clusterId;
    // Seed only the cluster root & server Adds — NO loopback addresses, so the relay is the only path.
    writeStatements(a.dataDir, clusterId, made.statements);
    writeStatements(b.dataDir, clusterId, made.statements);
    await b.start();

    // Wait for B to open its relay room and publish its relay address in its own Profile.
    bRelayAddress = await until(() => readRelayAddress(b), { timeout: 20_000, what: "B's relay address profile" });
    await until(() => b.log.includes("relay: room open"), { timeout: 15_000, what: "B's relay room open" });
    await until(() => (serverBMeter.connections.at(-1)?.counts.allow ?? 0) >= 1, { timeout: 15_000, what: "B sent allow list to relay" });
  }, 120_000);

  afterAll(async () => {
    await cluster?.cleanup();
    await dialerMeter?.stop();
    await serverBMeter?.stop();
    await relay?.stop();
  }, 60_000);

  it("1: KK session through the relay completes with transport 'relay' and exchanges roster.revocations first", async () => {
    const gotFromB: WireMessage[] = [];
    const stackA = await openInProcessA(a.dataDir, {
      onRelayMessage: (_session, msg) => {
        gotFromB.push(msg);
        return false;
      },
    });
    cleanups.push(() => stackA.close());

    const kbDhPub = fromBase64Url(kb.dh)!;
    const connector = relayConnector({
      room: bRelayAddress.room,
      self: { memberId: ka.memberId, dhKey: stackA.identity.dhKey },
      peerDhPub: kbDhPub,
    });
    const conn = await connector.connect(dialerMeter.url);
    cleanups.push(() => conn.close());

    let opened = false;
    const session = new PeerSession(conn, { dial: { memberId: kb.memberId, dhPub: kbDhPub }, transport: "relay" }, stackA.peerHost, {
      opened: () => { opened = true; },
    });
    conn.bind({ frame: (f) => session.receive(f), closed: () => session.transportClosed(), resume: () => session.link.resume() });

    await until(() => opened && session.state === "open", { timeout: 20_000, what: "relay KK PeerSession open" });
    expect(session.link.info?.transport).toBe("relay");
    expect(session.link.info?.mode).toBe("kk");
    expect(session.link.info?.peer.memberId).toBe(kb.memberId);

    // Send a ping followed by a sub for B's srv: table after handshake + revocation sync; receiving B's `rows`
    // deterministically proves B accepted our roster.revocations first, processed ping, and kept the session open.
    const srvB = `srv:${kb.memberId}` as StreamId;
    expect(session.sendWire({ t: "ping", at: Date.now() })).toBe(true);
    expect(session.sendWire({ t: "sub", stream: srvB, cursor: null })).toBe(true);
    await until(() => gotFromB.some((m) => m.t === "rows" && m.stream === srvB), { timeout: 20_000, what: "B answered sub after ping over relay" });
    expect(session.state).toBe("open");
    session.bye("closing", "test 1 done");
    await until(() => session.state === "closed", { timeout: 10_000, what: "session 1 closed" });

    // Verify B strictly enforces roster.revocations first over relay (same as tailnet): sending `ping` before
    // `roster.revocations` causes B to close with bye{role}.
    const rawConn = await connector.connect(dialerMeter.url);
    cleanups.push(() => rawConn.close());
    const rawGot: WireMessage[] = [];
    let rawEnded = false;
    const rawLink = SessionLink.initiate(rawConn, {
      mode: "kk", transport: "relay", cluster: clusterId,
      self: { memberId: ka.memberId, dhPub: stackA.identity.dhPub, dhKey: stackA.identity.dhKey },
      responder: { memberId: kb.memberId, dhPub: kbDhPub },
    }, {
      onFrame: (pt) => { const d = decodeWireFrame(pt, "peer", REMOTE); if (d.ok) rawGot.push(d.message); },
      onEnd: () => { rawEnded = true; },
    });
    rawConn.bind({ frame: (f) => rawLink.receive(f), closed: () => rawLink.transportClosed(), resume: () => rawLink.resume() });
    const rawInfo = await rawLink.established;
    expect(rawInfo.transport).toBe("relay");

    // B's first frame MUST be roster.revocations.
    await until(() => rawGot.length >= 1, { timeout: 15_000, what: "B's first frame over relay" });
    expect(rawGot[0]!.t).toBe("roster.revocations");

    // Send ping BEFORE sending our roster.revocations: B must refuse with bye{role}.
    const badFirst = encodeWireFrame({ t: "ping", at: Date.now() }, "peer", REMOTE);
    expect(badFirst.ok).toBe(true);
    if (badFirst.ok) rawLink.send("control", encoder.encode(badFirst.text));

    await until(() => rawGot.some((m) => m.t === "bye") && rawEnded, { timeout: 15_000, what: "B rejects out-of-order ping" });
    const byeMsg = rawGot.find((m): m is MessageOf<"bye"> => m.t === "bye");
    expect(byeMsg?.reason).toBe("role");
  }, 60_000);

  it("2: a command forwarded A -> B over the relay session applies once (reused from peer-forward-faults)", async () => {
    // Create a bot + message on B (exact pattern from peer-forward-faults.test.ts).
    const bClient = await b.client("script", "d".repeat(32));
    cleanups.push(() => bClient.close());
    await bClient.sub(bClient.srv);
    const snap = await bClient.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === bClient.srv, "B srv snap");
    bClient.cmd({ origin: "script", originEpoch: bClient.originEpoch, target: bClient.srv, n: 1 } as Slot, { type: "bots.create", name: "Relay helper", job: "relay forwarding test" }, snap.logId);
    const created = await bClient.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create on B");
    const botB = (created.outcome as { result: { botId: string } }).result.botId;
    bClient.cmd({ origin: "script", originEpoch: bClient.originEpoch, target: `bot:${botB}`, n: 1 } as Slot, { type: "chat.send", botId: botB, text: "/say hello over relay" }, snap.logId);
    await bClient.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.target === `bot:${botB}`, "chat.send on B");
    const messageB = await until(() => withDb(b, (db) => (db.prepare("SELECT msgId FROM messages WHERE botId = ? ORDER BY seq LIMIT 1").get(botB) as { msgId: string } | undefined)?.msgId ?? null), { timeout: 20_000, what: "a line on B's bot" });

    // Start A's in-process stack with loopback listener so a Phone can attach and forward commands A -> B over relay.
    const stackA = await openInProcessA(a.dataDir, { withListener: true });
    cleanups.push(() => stackA.close());

    const dev = await deviceKeys();
    await stackA.roster.addDevice({ keys: dev.keys, name: "Relay Phone" });

    // Open KK session A -> B through the relay and wire gossip + peerTables + forwarder.
    const kbDhPub = fromBase64Url(kb.dh)!;
    const connector = relayConnector({
      room: bRelayAddress.room,
      self: { memberId: ka.memberId, dhKey: stackA.identity.dhKey },
      peerDhPub: kbDhPub,
    });
    const conn = await connector.connect(dialerMeter.url);
    cleanups.push(() => conn.close());

    let sessionOpened = false;
    const session = new PeerSession(conn, { dial: { memberId: kb.memberId, dhPub: kbDhPub }, transport: "relay" }, stackA.peerHost, {
      opened: (s) => {
        sessionOpened = true;
        stackA.setActiveSession(s);
        stackA.gossip.opened(s);
        void stackA.peerTables.opened(s);
        stackA.forwarder.opened(s);
      },
      closed: (s) => {
        stackA.gossip.closed(s);
        stackA.peerTables.sessionClosed(s);
        stackA.forwarder.closed(s);
      },
    });
    conn.bind({ frame: (f) => session.receive(f), closed: () => session.transportClosed(), resume: () => session.link.resume() });

    await until(() => sessionOpened, { timeout: 15_000, what: "relay session opened for forwarding" });
    // Wait until B receives the phone's Add by gossip and A's copy of B's srv: table names botB.
    const srvB = `srv:${kb.memberId}`;
    await until(() => withDb(b, (db) => !!db.prepare("SELECT 1 FROM roster WHERE kind = 'add' AND member = ?").get(dev.member)), { timeout: 20_000, what: "B received phone Add by gossip over relay" });
    await until(() => !!stackA.hub.reader().prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(srvB, `bot:${botB}`), { timeout: 20_000, what: "A's copy names botB" });

    // Attach the Phone to A over loopback and send commands for botB & srvB (from peer-forward-faults.test.ts).
    const inc = () => String((stackA.hub.reader().prepare("SELECT logId FROM streams WHERE stream = ?").get(srvB) as { logId: string }).logId);
    const epoch = "a".repeat(32);
    const phConn = await webSocketConnector.connect(`ws://127.0.0.1:${stackA.port}/v3/ws`);
    cleanups.push(() => phConn.close());

    const results = new Map<string, MessageOf<"cmd.result">>();
    const heldSlots: string[] = [];
    let phOpen = false;
    const phLink = SessionLink.initiate(phConn, {
      mode: "ik", transport: "tailnet", cluster: clusterId,
      self: { memberId: dev.member, dhPub: dev.dh.publicKey, dhKey: dev.dh.privateKey },
      responder: { memberId: ka.memberId, dhPub: stackA.identity.dhPub },
    }, {
      onFrame: (pt) => {
        const dec = decodeFrame(pt, "server", REMOTE);
        if (!dec.ok) return;
        const msg = dec.message;
        if (msg.t === "welcome") phOpen = true;
        if (msg.t === "held") heldSlots.push(`${msg.slot.target}#${msg.slot.n}`);
        if (msg.t === "cmd.result") results.set(`${msg.slot.target}#${msg.slot.n}`, msg);
      },
      onEnd: () => undefined,
    });
    phConn.bind({ frame: (f) => phLink.receive(f), closed: () => phLink.transportClosed() });
    await phLink.established;
    const hello = encodeFrame({ t: "hello", deviceId: dev.member, feVersion: "3.0.0", protocol: 1, originEpoch: epoch, cursors: {}, outbox: [], want: [] } as Message, "fe", REMOTE);
    if (hello.ok) phLink.send("control", encoder.encode(hello.text));
    await until(() => phOpen, { timeout: 10_000, what: "phone welcome on A" });

    const sendPhoneCmd = (target: string, n: number, cmd: Record<string, unknown>) => {
      const slot = { origin: dev.member, originEpoch: epoch, target, n } as Slot;
      const f = encodeFrame({ t: "cmd", slot, floor: 1, inc: inc(), cmd } as Message, "fe", REMOTE);
      expect(f.ok).toBe(true);
      if (f.ok) phLink.send("control", encoder.encode(f.text));
    };
    const react = (present: boolean) => ({ type: "chat.react", botId: botB, messageId: messageB, emoji: "👍", present });
    sendPhoneCmd(`bot:${botB}`, 1, react(true));
    sendPhoneCmd(`bot:${botB}`, 2, react(false));
    sendPhoneCmd(srvB, 1, { type: "bots.create", name: "Made through relay", job: "forwarded over relay" });

    await until(() => results.size === 3, { timeout: 20_000, what: "all 3 forwarded commands answered" });
    expect(heldSlots.length).toBeGreaterThanOrEqual(3);
    expect(results.get(`bot:${botB}#1`)!.outcome.kind).toBe("applied");
    expect(results.get(`bot:${botB}#2`)!.outcome.kind).toBe("applied");
    expect(results.get(`${srvB}#1`)!.outcome.kind).toBe("refused");

    // Re-send duplicate slot bot:botB#1 to confirm exactly-once at B.
    sendPhoneCmd(`bot:${botB}`, 1, react(true));
    await until(() => {
      const s = stackA.forwarder.stats();
      return s.rows === 0 && s.cancels === 0;
    }, { timeout: 10_000, what: "A forwardq empty" });

    const bEntries = withDb(b, (db) => (
      db.prepare("SELECT seq, kind, slot FROM entries WHERE kind IN ('cmd.applied', 'cmd.refused', 'cmd.cancelled') AND slot IS NOT NULL ORDER BY stream, seq").all() as Array<{ seq: number; kind: string; slot: string }>
    ).map((r) => ({ seq: Number(r.seq), kind: String(r.kind), slot: JSON.parse(r.slot) as Slot })).filter((e) => e.slot.origin === dev.member && e.slot.originEpoch === epoch));

    const bySlot = new Map<string, typeof bEntries>();
    for (const entry of bEntries) {
      const k = slotKey(entry.slot);
      bySlot.set(k, [...(bySlot.get(k) ?? []), entry]);
    }
    expect(bySlot.get(slotKey({ origin: dev.member, originEpoch: epoch, target: `bot:${botB}`, n: 1 } as Slot))?.map((e) => e.kind)).toEqual(["cmd.applied"]);
    expect(bySlot.get(slotKey({ origin: dev.member, originEpoch: epoch, target: `bot:${botB}`, n: 2 } as Slot))?.map((e) => e.kind)).toEqual(["cmd.applied"]);
    expect(bySlot.get(slotKey({ origin: dev.member, originEpoch: epoch, target: srvB, n: 1 } as Slot))?.map((e) => e.kind)).toEqual(["cmd.refused"]);
  }, 60_000);

  it("3: killing the relay ends the open session, and the dialler reports a dial failure", async () => {
    const localRelay = await new LocalRelay().ready();
    cleanups.push(() => localRelay.stop());
    const roomMeter = await new RelayMeter(() => localRelay.url).start();
    cleanups.push(() => roomMeter.stop());

    const dirB = join(scratchRoot, "t3-b");
    mkdirSync(dirB, { recursive: true, mode: 0o700 });
    const storeB = await openServerStore(dirB);
    const idB = await loadOrCreateServerIdentity(dirB, { create: true });
    await storeB.submit((tx) => bindServerIdentity(tx, idB));
    const dirA = join(scratchRoot, "t3-a");
    mkdirSync(dirA, { recursive: true, mode: 0o700 });
    const storeA = await openServerStore(dirA);
    const idA = await loadOrCreateServerIdentity(dirA, { create: true });
    await storeA.submit((tx) => bindServerIdentity(tx, idA));

    const infoA: MemberKeysInfo = { memberId: idA.memberId, sign: idA.keys.sign, dh: idA.keys.dh, signKey: idA.signKey };
    const infoB: MemberKeysInfo = { memberId: idB.memberId, sign: idB.keys.sign, dh: idB.keys.dh, signKey: idB.signKey };
    const made = await makeCluster([infoA, infoB]);
    await storeA.close();
    await storeB.close();
    writeStatements(dirA, made.clusterId, made.statements);
    writeStatements(dirB, made.clusterId, made.statements);

    const openB = await openServerStore(dirB);
    const rosterB = await RosterStore.open(openB, idB, { log: () => undefined });
    const peersB = new PeerSessions({ roster: rosterB, self: { memberId: idB.memberId, dhPub: idB.dhPub, dhKey: idB.dhKey }, timers: DEFAULT_PEER_TIMERS, log: () => undefined });
    const routerB = new SessionRouter({ accept: () => ({ link: { established: new Promise(() => undefined) }, receive: () => undefined, transportClosed: () => undefined }) }, peersB);
    const roomKey = newRelayRoomKey();
    const roomId = await relayRoomOf(roomKey);
    const tokenA = await relayDeviceToken(idA.memberId, idA.dhKey, idB.dhPub);
    const tokenAHash = await relayTokenHash(tokenA);
    const relayConnB = new RelayConnector({ url: roomMeter.url, roomKey, sessions: routerB, allowList: async () => [{ h: tokenAHash }], log: () => undefined });
    cleanups.push(async () => { relayConnB.close(); peersB.close(); await openB.close(); });
    await relayConnB.start();
    await until(() => relayConnB.state === "ready" && (roomMeter.connections[0]?.counts.allow ?? 0) >= 1, { timeout: 10_000, what: "test 3 room ready and allow sent" });

    const stackA = await openInProcessA(dirA);
    cleanups.push(() => stackA.close());
    const connector = relayConnector({ room: roomId, self: { memberId: idA.memberId, dhKey: idA.dhKey }, peerDhPub: idB.dhPub });
    const conn = await connector.connect(localRelay.url);
    cleanups.push(() => conn.close());

    let endReason: string | null = null;
    const session = new PeerSession(conn, { dial: { memberId: idB.memberId, dhPub: idB.dhPub }, transport: "relay" }, stackA.peerHost, {
      closed: (_s, end) => { endReason = end.reason; },
    });
    conn.bind({ frame: (f) => session.receive(f), closed: () => session.transportClosed(), resume: () => session.link.resume() });
    await until(() => session.state === "open", { timeout: 10_000, what: "test 3 session open" });

    // Kill the relay: the open session ends with transport failure, and a subsequent dial rejects.
    await localRelay.stop();
    await until(() => session.state === "closed", { timeout: 10_000, what: "session closed when relay killed" });
    expect(endReason).toBe("transport");
    await expect(connector.connect(localRelay.url)).rejects.toThrow();
  }, 30_000);

  it("4: a wrong token is refused by the relay (4403), with zero d frames on RelayMeter", async () => {
    const stackA = await openInProcessA(a.dataDir);
    cleanups.push(() => stackA.close());

    const countDFrames = (m: RelayMeter) => m.connections.reduce((sum, c) => sum + (c.receivedCounts.d ?? 0), 0);
    const serverDBefore = countDFrames(serverBMeter);
    const dialerConnsBefore = dialerMeter.connections.length;

    const kbDhPub = fromBase64Url(kb.dh)!;
    const wrongExplicit = relayConnector({ room: bRelayAddress.room, token: "wrong-token-0123456789abcdef" });
    await expect(wrongExplicit.connect(dialerMeter.url)).rejects.toThrow(/4403|denied/);

    // Also a wrong DH key deriving a valid-looking per-peer token for an unallowed key:
    const stranger = await strangerKeys();
    const wrongDerived = relayConnector({
      room: bRelayAddress.room,
      self: { memberId: ka.memberId, dhKey: stranger.dhKey },
      peerDhPub: kbDhPub,
    });
    await expect(wrongDerived.connect(dialerMeter.url)).rejects.toThrow(/4403|denied/);

    const refusedConns = dialerMeter.connections.slice(dialerConnsBefore);
    expect(refusedConns).toHaveLength(2);
    for (const c of refusedConns) {
      expect(c.relayClosed?.code).toBe(4403);
      expect(c.counts.to ?? 0).toBe(0);
      expect(c.receivedCounts.d ?? 0).toBe(0);
    }
    expect(countDFrames(serverBMeter)).toBe(serverDBefore);
  }, 30_000);

  it("5: pacing obeys §6.3 limits (<= 45/s, burst <= 150, content <= 30/s) and SessionLink writable/resume back-pressure", async () => {
    const localRelay = await new LocalRelay().ready();
    cleanups.push(() => localRelay.stop());
    const roomMeter = await new RelayMeter(() => localRelay.url).start();
    cleanups.push(() => roomMeter.stop());
    const meter = await new RelayMeter(() => localRelay.url).start();
    cleanups.push(() => meter.stop());

    const roomKey = newRelayRoomKey();
    const roomId = await relayRoomOf(roomKey);
    const peerA = await strangerKeys();
    const peerB = await strangerKeys();
    const token = await relayDeviceToken(peerA.memberId, peerA.dhKey, peerB.dhPub);
    const tokenHash = await relayTokenHash(token);

    const receivedAtB: Uint8Array[] = [];
    const relayConnB = new RelayConnector({
      url: roomMeter.url,
      roomKey,
      allowList: async () => [{ h: tokenHash }],
      log: () => undefined,
      sessions: {
        accept(transport, kind) {
          expect(kind).toBe("relay");
          const link = SessionLink.respond(transport, {
            transport: "relay",
            cluster: "0".repeat(32),
            self: { memberId: peerB.memberId, dhPub: peerB.dhPub, dhKey: peerB.dhKey },
            modes: ["kk"],
            expectInitiator: peerA.memberId,
            checkPeer: () => ({ ok: true }),
          }, {
            onFrame: (pt) => { receivedAtB.push(pt); },
          });
          return { link, receive: (f) => link.receive(f), transportClosed: () => link.transportClosed() };
        },
      },
    });
    cleanups.push(() => relayConnB.close());
    await relayConnB.start();
    await until(() => relayConnB.state === "ready" && (roomMeter.connections[0]?.counts.allow ?? 0) >= 1, { timeout: 10_000, what: "test 5 room ready and allow sent" });

    // (a) Default RELAY_PACE (<= 45/s, burst <= 150): burst 185 control frames through default pacer and confirm
    // the relay never closes with 4429 and arrivals satisfy both the 45/150 and 50/200 buckets.
    const defaultConn = await relayConnector({
      room: roomId,
      self: { memberId: peerA.memberId, dhKey: peerA.dhKey },
      peerDhPub: peerB.dhPub,
    }).connect(meter.url);
    cleanups.push(() => defaultConn.close());
    const defaultLink = SessionLink.initiate(defaultConn, {
      mode: "kk", transport: "relay", cluster: "0".repeat(32),
      self: { memberId: peerA.memberId, dhPub: peerA.dhPub, dhKey: peerA.dhKey },
      responder: { memberId: peerB.memberId, dhPub: peerB.dhPub },
    }, { onFrame: () => undefined });
    defaultConn.bind({ frame: (f) => defaultLink.receive(f), closed: () => defaultLink.transportClosed(), resume: () => defaultLink.resume() });
    await defaultLink.established;
    for (let i = 0; i < 185; i++) defaultLink.send("control", encoder.encode(`d-${i}`));
    await until(() => receivedAtB.length === 185, { timeout: 15_000, what: "all 185 default-paced frames delivered" });
    const defaultMetered = meter.connections[0]!;
    expect(defaultMetered.relayClosed).toBeNull();
    expect(defaultConn.pace.maxPerSecond).toBeLessThanOrEqual(RELAY_PACE.burst + RELAY_PACE.rate);
    expect(bucketRefusals(defaultMetered.times, 50, 200).refused).toBe(0);
    expect(defaultConn.pace.minTokens).toBeGreaterThanOrEqual(0);
    defaultConn.close();
    receivedAtB.length = 0;

    // (b) Content cap <= 30/s + writable()/resume() back-pressure (later control overtakes waiting bulk).
    const connector = relayConnector({
      room: roomId,
      self: { memberId: peerA.memberId, dhKey: peerA.dhKey },
      peerDhPub: peerB.dhPub,
      pace: { rate: RELAY_PACE.rate, burst: 10, contentRate: RELAY_PACE.contentRate, contentBurst: 1 },
    });
    const conn = await connector.connect(meter.url);
    cleanups.push(() => conn.close());

    const linkA = SessionLink.initiate(conn, {
      mode: "kk", transport: "relay", cluster: "0".repeat(32),
      self: { memberId: peerA.memberId, dhPub: peerA.dhPub, dhKey: peerA.dhKey },
      responder: { memberId: peerB.memberId, dhPub: peerB.dhPub },
    }, { onFrame: () => undefined });
    conn.bind({ frame: (f) => linkA.receive(f), closed: () => linkA.transportClosed(), resume: () => linkA.resume() });
    const info = await linkA.established;
    expect(info.transport).toBe("relay");

    // Queue 90 bulk chunks (> 64 KiB each, valid under relay's 128 KiB limit) + 30 control frames at once.
    const bigBulk = new Uint8Array(70 * 1024).fill(0xab);
    for (let i = 0; i < 90; i++) linkA.send("bulk", bigBulk);
    for (let i = 0; i < 30; i++) linkA.send("control", encoder.encode(`ctrl-${i}`));

    await until(() => receivedAtB.length === 120, { timeout: 15_000, what: "all 120 paced frames delivered" });
    const firstCtrlIdx = receivedAtB.findIndex((pt) => pt[0] !== 0xab);
    expect(firstCtrlIdx).toBeLessThanOrEqual(CHANNEL_FRAMES + 1);

    const metered = meter.connections[1]!;
    expect(metered.relayClosed).toBeNull();
    expect(bucketRefusals(metered.times, 50, 200).refused).toBe(0);
    expect(maxInWindow(metered.times, 1_000)).toBeLessThanOrEqual(RELAY_PACE.rate + 10);
    expect(conn.pace.minTokens).toBeGreaterThanOrEqual(0);
    expect(conn.pace.bulk).toBe(90);
    expect(conn.pace.control).toBe(32); // HS1 + HS3 + 30 control frames
    expect(conn.pace.maxBulkPerSecond).toBeLessThanOrEqual(RELAY_PACE.contentRate + 5);
  }, 30_000);

  it("6: negative test — initiator claiming transport 'tailnet' over the relay fails handshake", async () => {
    const stackA = await openInProcessA(a.dataDir);
    cleanups.push(() => stackA.close());

    const bLogFrom = b.log.length;
    const dialerConnsBefore = dialerMeter.connections.length;
    const kbDhPub = fromBase64Url(kb.dh)!;
    const connector = relayConnector({
      room: bRelayAddress.room,
      self: { memberId: ka.memberId, dhKey: stackA.identity.dhKey },
      peerDhPub: kbDhPub,
    });
    const conn = await connector.connect(dialerMeter.url);
    cleanups.push(() => conn.close());

    let end: { opened: boolean; reason: string } | null = null;
    const session = new PeerSession(conn, { dial: { memberId: kb.memberId, dhPub: kbDhPub }, transport: "tailnet" }, stackA.peerHost, {
      closed: (_s, info) => { end = info; },
    });
    conn.bind({ frame: (f) => session.receive(f), closed: () => session.transportClosed(), resume: () => session.link.resume() });

    await expect(session.link.established).rejects.toThrow();
    await until(() => session.state === "closed" && end !== null && dialerMeter.connections[dialerConnsBefore]?.relayClosed !== null, { timeout: 10_000, what: "mismatched transport session closed by relay kick" });
    expect(end!.opened).toBe(false);
    expect(dialerMeter.connections[dialerConnsBefore]?.relayClosed?.code).toBe(4403);
    expect(b.log.slice(bLogFrom)).not.toMatch(/peer ${ka.memberId}: (live|exchange only)/);
  }, 30_000);

  it("7: two real botlingd processes with listeners off connect through the relay and forward commands", async () => {
    const localRelay = await new LocalRelay().ready();
    cleanups.push(() => localRelay.stop());
    const meter1 = await new RelayMeter(() => localRelay.url).start();
    cleanups.push(() => meter1.stop());
    const meter2 = await new RelayMeter(() => localRelay.url).start();
    cleanups.push(() => meter2.stop());

    const two = await startServers({
      name: "two-botlingd-relay",
      count: 2,
      env: {
        A: { ...TIMERS_ENV, BOTLING_SERVER_PORT: "off", BOTLING_SERVER_RELAY_URL: meter1.url },
        B: { ...TIMERS_ENV, BOTLING_SERVER_PORT: "off", BOTLING_SERVER_RELAY_URL: meter2.url },
      },
    });
    cleanups.push(() => two.cleanup());

    await Promise.all([two.a.stop(), two.b.stop()]);
    const [k1, k2] = await Promise.all([readServerKeys(two.a.dataDir), readServerKeys(two.b.dataDir)]);
    const made = await makeCluster([k1, k2]);
    const dev = await deviceKeys();
    const addDev = await sign({
      type: "add",
      cluster: made.clusterId,
      member: dev.member,
      kind: "device",
      keys: dev.keys,
      name: "Relay Phone",
      scope: ["read", "reply", "approve", "manage"],
      by: k1.memberId,
      at: 1_700_000_000_000,
    }, k1);
    writeStatements(two.a.dataDir, made.clusterId, [...made.statements, addDev]);
    writeStatements(two.b.dataDir, made.clusterId, made.statements);

    // Start both briefly so each writes its signed relay address Profile, then seed each other's Profile.
    await Promise.all([two.a.start(), two.b.start()]);
    const [relay1, relay2] = await Promise.all([
      until(() => readRelayAddress(two.a), { timeout: 20_000, what: "server 1 relay profile" }),
      until(() => readRelayAddress(two.b), { timeout: 20_000, what: "server 2 relay profile" }),
    ]);
    expect(relay2.room).toBeTruthy();
    await Promise.all([two.a.stop(), two.b.stop()]);
    const profiles1 = readAddressProfiles(two.a);
    const profiles2 = readAddressProfiles(two.b);
    writeStatements(two.a.dataDir, made.clusterId, profiles2);
    writeStatements(two.b.dataDir, made.clusterId, profiles1);

    await Promise.all([two.a.start(), two.b.start()]);
    const smaller = k1.memberId < k2.memberId ? k1.memberId : k2.memberId;
    await until(() => {
      const p1 = readPeerFile(two.a)[0];
      const p2 = readPeerFile(two.b)[0];
      return p1?.state === "live" && p2?.state === "live" && p1.sessionId && p1.sessionId === p2.sessionId && p1.initiator === smaller;
    }, { timeout: 30_000, what: "two real botlingd live on one relay session" });

    expect(readPeerFile(two.a)[0]?.path).toBe("relay");
    expect(readPeerFile(two.b)[0]?.path).toBe("relay");
    two.a.assertLoopbackOnly({ expectListener: false });
    two.b.assertLoopbackOnly({ expectListener: false });

    // Wait for B to learn the phone device Add by gossip over the relay session.
    await until(() => withDb(two.b, (db) => !!db.prepare("SELECT 1 FROM roster WHERE kind = 'add' AND member = ?").get(dev.member)), {
      timeout: 20_000,
      what: "B learned device Add by gossip over relay",
    });

    // Create a bot on B, then connect the phone to A through A's relay room (listeners off!) and forward a command.
    const c2 = await two.b.client("script", "d".repeat(32));
    cleanups.push(() => c2.close());
    await c2.sub(c2.srv);
    const snap2 = await c2.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === c2.srv, "B srv snap");
    c2.cmd({ origin: "script", originEpoch: c2.originEpoch, target: c2.srv, n: 1 } as Slot, { type: "bots.create", name: "Two-Relay Bot", job: "real botlingd over relay" }, snap2.logId);
    const created = await c2.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "bots.create on B");
    const botId = (created.outcome as { result: { botId: string } }).result.botId;

    await until(() => withDb(two.a, (db) => !!db.prepare("SELECT 1 FROM rows WHERE stream = ? AND key = ? AND deleted = 0").get(c2.srv, `bot:${botId}`)), {
      timeout: 20_000,
      what: "A replicated B's bot row over relay",
    });
    const inc = withDb(two.a, (db) => String((db.prepare("SELECT logId FROM streams WHERE stream = ?").get(c2.srv) as { logId: string }).logId));

    const phConn = await relayConnector({
      room: relay1.room,
      self: { memberId: dev.member, dhKey: dev.dh.privateKey },
      peerDhPub: fromBase64Url(k1.dh)!,
    }).connect(localRelay.url);
    cleanups.push(() => phConn.close());

    let phOpen = false;
    const phResults: Array<MessageOf<"cmd.result">> = [];
    const phLink = SessionLink.initiate(phConn, {
      mode: "ik",
      transport: "relay",
      cluster: made.clusterId,
      self: { memberId: dev.member, dhPub: dev.dh.publicKey, dhKey: dev.dh.privateKey },
      responder: { memberId: k1.memberId, dhPub: fromBase64Url(k1.dh)! },
    }, {
      onFrame: (pt) => {
        const dec = decodeFrame(pt, "server", REMOTE);
        if (!dec.ok) return;
        if (dec.message.t === "welcome") phOpen = true;
        if (dec.message.t === "cmd.result") phResults.push(dec.message);
      },
      onEnd: () => undefined,
    });
    phConn.bind({ frame: (f) => phLink.receive(f), closed: () => phLink.transportClosed(), resume: () => phLink.resume() });
    await phLink.established;
    const epoch = "e".repeat(32);
    const hello = encodeFrame({ t: "hello", deviceId: dev.member, feVersion: "3.0.0", protocol: 1, originEpoch: epoch, cursors: {}, outbox: [], want: [] } as Message, "fe", REMOTE);
    if (hello.ok) phLink.send("control", encoder.encode(hello.text));
    await until(() => phOpen, { timeout: 10_000, what: "phone welcome on A over relay" });

    const cmdFrame = encodeFrame({
      t: "cmd",
      slot: { origin: dev.member, originEpoch: epoch, target: `bot:${botId}`, n: 1 } as Slot,
      floor: 1,
      inc,
      cmd: { type: "chat.send", botId, text: "/say hello across relay" },
    } as Message, "fe", REMOTE);
    expect(cmdFrame.ok).toBe(true);
    if (cmdFrame.ok) phLink.send("control", encoder.encode(cmdFrame.text));

    await until(() => phResults.some((m) => m.slot.target === `bot:${botId}` && m.slot.n === 1), {
      timeout: 20_000,
      what: "forwarded chat.send result over relay",
    });
    expect(phResults[0]?.outcome.kind).toBe("applied");
  }, 90_000);
});
