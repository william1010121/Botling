// Botling 3 M2 step 13 + M4-16a: botlingd's room on the relay (src/server/net/relay.ts), the device's relay socket
// (src/fe-link/relay-socket.ts), and SessionRouter + relayAllowList against the unchanged relay started locally
// (relay/src/main.ts on 127.0.0.1).
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { RelaySocket } from "../../src/fe-link";
import { decodeWireFrame, encodeWireFrame, fromBase64Url, memberIdFromKey, parseJoinLink, toBase64Url, type WireMessage } from "../../src/protocol";
import { relayAllowList } from "../../src/server/botlingd";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { cspWith, CSP, loadRelayRoomKey, relayConnectOrigin, RelayConnector, relayTestOptions, relayUrl } from "../../src/server/net";
import { PairingService, ServerJoin } from "../../src/server/pairing";
import { DEFAULT_PEER_TIMERS, PeerSessions, SessionRouter, type AcceptedSession } from "../../src/server/peer";
import { RosterStore, storedBytes, type StoredStatement } from "../../src/server/roster";
import { RemoteSessions, slotAuthorize, type RemoteHost, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore } from "../../src/server/store";
import {
  BULK_FRAME_LIMIT, generateDhKeyPair, Initiator, newRelayRoomKey, RELAY_BULK_FRAME_LIMIT, relayDeviceToken, relayPairToken, relayRoomOf, relayTokenHash,
  SessionLink, type Lane, type SessionTransport,
} from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { until } from "../helpers";
import { LocalRelay } from "../support/local-relay";
import { makeCluster, revokeServer, sign, strangerKeys, type MemberKeysInfo } from "../support/peer-cluster";

const root = mkdtempSync(join(tmpdir(), "relay-unit-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

const encoder = new TextEncoder();
let folderSeq = 0;
function nextDir(prefix = "srv"): string {
  const dir = join(root, `${prefix}-${++folderSeq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** An echo "session" per relay peer: every frame comes back on the same lane. */
function echoSessions() {
  const accepted: Array<{ transport: SessionTransport; frames: number; closed: boolean }> = [];
  return {
    accepted,
    accept(transport: SessionTransport, kind: "relay") {
      expect(kind).toBe("relay");
      const entry = { transport, frames: 0, closed: false };
      accepted.push(entry);
      return {
        link: { established: Promise.resolve(), resume: () => undefined },
        receive(frame: Uint8Array) { entry.frames++; transport.send(frame, (frame[0] === 0xbb ? "bulk" : "control") as Lane); },
        transportClosed() { entry.closed = true; },
      };
    },
  };
}

function device(url: string, room: string, token: string) {
  const socket = new RelaySocket({ url, room, token });
  const got: Uint8Array[] = [];
  let open = false, closed: number | null = null;
  socket.onopen = () => { open = true; };
  socket.onmessage = (event) => { got.push(new Uint8Array(event.data as ArrayBuffer)); };
  socket.onclose = (event) => { closed = event.code ?? 0; };
  cleanups.push(() => socket.close());
  return { socket, got, get open() { return open; }, get closed() { return closed; } };
}

async function makeMemberKeys() {
  const signPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await generateDhKeyPair();
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", signPair.publicKey));
  const memberId = await memberIdFromKey(signPub);
  const info: MemberKeysInfo = { memberId, sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey), signKey: signPair.privateKey };
  return { ...info, dhPub: dh.publicKey, dhKey: dh.privateKey, keys: { sign: info.sign, dh: info.dh } };
}

async function makeServerStack(opts: { clustered?: boolean; cluster?: { clusterId: string; statements: StoredStatement[] }; dir?: string } = {}) {
  const dir = opts.dir ?? nextDir();
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: store.meta("memberId") === undefined });
  const { serverId, memberId } = await store.submit((tx) => {
    const bound = bindServerIdentity(tx, identity);
    if (opts.cluster) {
      tx.prepare("INSERT INTO meta (key, value) VALUES ('clusterId', ?)").run(opts.cluster.clusterId);
      const insert = tx.prepare("INSERT INTO roster (id, kind, member, bytes, receivedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING");
      for (const { id, statement } of opts.cluster.statements) {
        const body = statement.body;
        insert.run(id, body.type, body.type === "root" ? body.root : body.member, storedBytes(statement), Date.now());
      }
    }
    return bound;
  });
  const logs: string[] = [];
  const roster = await RosterStore.open(store, identity, { log: (line) => logs.push(line) });
  const setup = new ClusterSetup(roster);
  if (opts.clustered) {
    const started = await setup.begin();
    expect((await setup.confirm(started.code)).ok).toBe(true);
  }
  const engine = new FakeTurnEngine({ bots: ["6A0B0000-0000-4000-8000-000000000002"], chunks: ["ok"], chunkMs: 1 });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const runtime = new IntentRuntime({ store, engine, hub, live, log: (line) => logs.push(line), authorize: slotAuthorize(roster), serverEvents: "all", mirrorBotUpdates: true });
  await runtime.start();
  const shell = new ShellBridge();
  const pairing = new PairingService({
    roster, cluster: setup, identity: { memberId, keys: identity.keys }, serverName: "Server",
    addresses: () => ({ tailnet: "https://tailnet-name.invalid" }), pageUrl: () => "https://tailnet-name.invalid/v3/", log: (line) => logs.push(line),
  });
  const base: SessionHost = {
    serverId, serverName: "Test server", startedAt: Date.now(), minFeVersion: "3.0.0", token: () => "t".repeat(32),
    hub, live, runtime, engine, content: null, shell,
    nextFor: () => ({}),
    ensureBotStream: async (botId) => { if (!engine.hasBot(botId)) return false; await store.submit((tx) => { ensureBot(tx, botId); }); return true; },
    log: (line) => logs.push(line),
  };
  const host: RemoteHost = { ...base, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, pairing };
  const remote = new RemoteSessions(host);
  const peers = new PeerSessions({ roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, timers: DEFAULT_PEER_TIMERS, log: (line) => logs.push(line) });
  const serverJoin = new ServerJoin({
    roster, identity: { memberId, keys: identity.keys, dhPub: identity.dhPub, dhKey: identity.dhKey, signKey: identity.signKey },
    serverName: "Server", version: "3.0.0", dataDir: dir, ownAddresses: () => null, joinAddresses: () => ["ws://127.0.0.1:9/v3/ws"], log: (line) => logs.push(line),
  });
  const router = new SessionRouter(remote, peers, undefined, serverJoin);
  cleanups.push(async () => {
    serverJoin.close();
    peers.close();
    remote.close();
    await runtime.scope.submit(() => undefined);
    engine.close();
    runtime.close();
    shell.close();
    live.close();
    hub.close();
    await store.close();
  });
  return {
    dir, store, identity, memberId,
    keysInfo: { memberId, sign: identity.keys.sign, dh: identity.keys.dh, signKey: identity.signKey } as MemberKeysInfo,
    roster, setup, pairing, remote, peers, serverJoin, router, logs,
  };
}

async function openRelayTransport(url: string, room: string, token: string) {
  const socket = new RelaySocket({ url, room, token });
  cleanups.push(() => socket.close());
  let open = false;
  let closed: { code: number; reason: string } | null = null;
  let receiver: { receive(frame: Uint8Array): void; transportClosed(): void } | null = null;
  const early: Uint8Array[] = [];
  const transport: SessionTransport = {
    send: (frame) => socket.send(frame),
    close: () => socket.close(),
  };
  socket.onopen = () => { open = true; };
  socket.onmessage = (event) => {
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    if (receiver) receiver.receive(bytes); else early.push(bytes);
  };
  socket.onclose = (event) => {
    closed = { code: event.code ?? 0, reason: event.reason ?? "" };
    receiver?.transportClosed();
  };
  await until(() => open || closed !== null, { what: "relay socket open", timeout: 10_000 });
  return {
    socket,
    transport,
    get open() { return open; },
    get closed() { return closed; },
    bind(target: { receive(frame: Uint8Array): void; transportClosed(): void }) {
      receiver = target;
      for (const f of early.splice(0)) target.receive(f);
    },
  };
}

describe("relay join tokens", () => {
  it("device and server derive the same token; hashes and room ids are the relay's", async () => {
    const dev = await generateDhKeyPair();
    const srv = await generateDhKeyPair();
    const a = await relayDeviceToken("dev1", dev.privateKey, srv.publicKey);
    const b = await relayDeviceToken("dev1", srv.privateKey, dev.publicKey);
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await relayDeviceToken("dev2", dev.privateKey, srv.publicKey)).not.toBe(a);
    const secret = new Uint8Array(32).fill(7);
    const pairToken = await relayPairToken("offer-1", secret);
    expect(pairToken).not.toBe(await relayPairToken("offer-2", secret));
    expect(await relayTokenHash(pairToken)).toBe(createHash("sha256").update(pairToken, "utf8").digest("hex"));
    const key = newRelayRoomKey();
    expect(await relayRoomOf(key)).toBe(createHash("sha256").update(Buffer.from(key, "base64url")).digest("base64url"));
  });

  it("settings: the URL, the room key file (0600, kept), the page's connect-src", () => {
    expect(relayUrl({})).toBeNull();
    expect(relayUrl({ BOTLING_SERVER_RELAY_URL: "ws://127.0.0.1:9/ws" })).toBe("ws://127.0.0.1:9/ws");
    expect(() => relayUrl({ BOTLING_SERVER_RELAY_URL: "https://example.invalid/ws" })).toThrow();
    expect(relayTestOptions({ BOTLING_SERVER_RELAY_BACKOFF_MS: "50,200" })).toEqual({ backoff: { minMs: 50, maxMs: 200 } });
    const file = join(root, "relay-room.key");
    const key = loadRelayRoomKey(file);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadRelayRoomKey(file)).toBe(key);
    chmodSync(file, 0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(key);
    expect(relayConnectOrigin("wss://relay.example.invalid/ws")).toBe("wss://relay.example.invalid");
    expect(cspWith([])).toBe(CSP);
    expect(cspWith(["ws://127.0.0.1:9"])).toContain("connect-src 'self' ws://127.0.0.1:9;");
    expect(cspWith(["javascript:alert(1)"])).toBe(CSP);
  });
});

describe("botlingd's room on a local relay", () => {
  it("opens its room, admits listed tokens only, echoes frames, revokes by the allow list, and comes back after a relay restart", async () => {
    let relay = await new LocalRelay().ready();
    cleanups.push(() => relay.stop());
    const port = relay.port;
    const key = newRelayRoomKey();
    const good = "g".repeat(43), bad = "b".repeat(43);
    let tokens = [{ h: await relayTokenHash(good) }];
    const sessions = echoSessions();
    const lines: string[] = [];
    const connector = new RelayConnector({ url: relay.url, roomKey: key, sessions, allowList: async () => tokens, log: (line) => lines.push(line), backoff: { minMs: 50, maxMs: 200 } });
    cleanups.push(() => connector.close());
    await connector.start();
    await until(() => connector.state === "ready", { what: "the room", timeout: 10_000 });
    expect(connector.room).toBe(await relayRoomOf(key));
    // Let the allow list arrive before devices join.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const refused = device(relay.url, connector.room!, bad);
    await until(() => refused.closed !== null, { what: "the refused join" });
    expect(refused.open).toBe(false);
    expect(refused.socket.refusal).toBe("denied");

    const phone = device(relay.url, connector.room!, good);
    await until(() => phone.open, { what: "the join" });
    phone.socket.send(Uint8Array.of(1, 2, 3));
    const big = new Uint8Array(128 * 1024 + 40).fill(0xbb);
    for (let i = 0; i < 20; i++) phone.socket.send(big);
    await until(() => phone.got.length === 21, { what: "the echoes", timeout: 10_000 });
    expect([...phone.got[0]!]).toEqual([1, 2, 3]);
    expect(phone.got[20]!.length).toBe(big.length);
    expect(connector.pace!.bulk).toBe(20);
    expect(connector.pace!.minTokens).toBeGreaterThanOrEqual(0);

    // Off the allow list: the relay closes the device at once; the session hears its transport closed.
    tokens = [];
    await connector.refreshAllow();
    await until(() => phone.closed !== null, { what: "the revoke" });
    expect(phone.closed).toBe(4403);
    await until(() => sessions.accepted[0]!.closed, { what: "the session's end" });

    // The relay restarts on the same port: botlingd opens the same room again; a device joins and talks.
    tokens = [{ h: await relayTokenHash(good) }];
    await relay.stop();
    await until(() => connector.state !== "ready", { what: "the loss" });
    relay = await new LocalRelay({}, port).ready();
    await until(() => connector.state === "ready", { what: "the room again", timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const again = device(relay.url, connector.room!, good);
    await until(() => again.open, { what: "the join after the restart" });
    again.socket.send(Uint8Array.of(9));
    await until(() => again.got.length === 1, { what: "the echo after the restart" });
    expect(connector.counts.readies).toBe(2);
    expect(connector.counts.closes.some((close) => close.code === 4429)).toBe(false);
    expect(lines.join("\n")).not.toContain(key);
    expect(lines.join("\n")).not.toContain(good);
  }, 30_000);
});

describe("M4-16a: peer servers in the relay room and SessionRouter", () => {
  it("1 & 2 & M4-06#7: relayAllowList includes valid peer servers (not self), excludes a revoked server on the same roster change, and the relay closes its connection", async () => {
    const relay = await new LocalRelay().ready();
    cleanups.push(() => relay.stop());

    // Pre-create s2's identity so we can build a cluster with root R, non-root member S2, and peer server B.
    const s2Dir = nextDir("s2");
    const s2PreStore = await openServerStore(s2Dir);
    const s2Id = await loadOrCreateServerIdentity(s2Dir, { create: true });
    await s2PreStore.close();
    const s2Info: MemberKeysInfo = {
      memberId: s2Id.memberId,
      sign: s2Id.keys.sign,
      dh: s2Id.keys.dh,
      signKey: s2Id.signKey,
    };
    const rootKeys = await makeMemberKeys();
    const peerB = await makeMemberKeys();
    const devD = await makeMemberKeys();
    const made = await makeCluster([rootKeys, s2Info, peerB]);
    const s2 = await makeServerStack({ dir: s2Dir, cluster: { clusterId: made.clusterId, statements: made.statements } });
    await s2.roster.addDevice({ keys: devD.keys, name: "Phone D" });
    const offer = await s2.pairing.createOffer();

    const allowList = relayAllowList({ roster: s2.roster, identity: s2.identity, pairing: s2.pairing });
    const peerBToken = await relayDeviceToken(peerB.memberId, peerB.dhKey, s2.identity.dhPub);
    const peerBHash = await relayTokenHash(peerBToken);
    const rootHash = await relayTokenHash(await relayDeviceToken(rootKeys.memberId, rootKeys.dhKey, s2.identity.dhPub));
    const devDToken = await relayDeviceToken(devD.memberId, devD.dhKey, s2.identity.dhPub);
    const devDHash = await relayTokenHash(devDToken);
    const selfHash = await relayTokenHash(await relayDeviceToken(s2.memberId, s2.identity.dhKey, s2.identity.dhPub));

    const initial = await allowList();
    expect(initial.map((t) => t.h)).toContain(peerBHash);
    expect(initial.map((t) => t.h)).toContain(rootHash);
    expect(initial.map((t) => t.h)).toContain(devDHash);
    expect(initial.map((t) => t.h)).not.toContain(selfHash);
    expect(initial.some((t) => t.exp === offer.expiresAt)).toBe(true);

    const key = newRelayRoomKey();
    const connector = new RelayConnector({ url: relay.url, roomKey: key, sessions: s2.router, allowList, log: (l) => s2.logs.push(l) });
    cleanups.push(() => connector.close());
    let tokensOnChange: string[] = [];
    s2.roster.onChange(() => {
      void allowList().then((list) => { tokensOnChange = list.map((t) => t.h); });
      void connector.refreshAllow();
    });
    await connector.start();
    await until(() => connector.state === "ready", { what: "room ready" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Peer B and Device D both join S2's relay room.
    const peerSocket = device(relay.url, connector.room!, peerBToken);
    const devSocket = device(relay.url, connector.room!, devDToken);
    await until(() => peerSocket.open && devSocket.open, { what: "peer B and device D joined" });

    // Root revokes B; S2 learns it via mergeRevocations. B's token must leave the allow list in the same roster change.
    const revokeB = await revokeServer(made.clusterId, rootKeys, peerB);
    await s2.roster.mergeRevocations([revokeB.statement]);
    await until(() => tokensOnChange.length > 0, { what: "allowList snapshot onChange" });
    expect(tokensOnChange).not.toContain(peerBHash);
    expect(tokensOnChange).toContain(devDHash);

    // The relay closes B's connection (4403), leaves D open, and refuses B's reconnect.
    await until(() => peerSocket.closed !== null, { what: "revoked peer closed by relay" });
    expect(peerSocket.closed).toBe(4403);
    expect(devSocket.closed).toBeNull();

    const retry = device(relay.url, connector.room!, peerBToken);
    await until(() => retry.closed !== null, { what: "revoked peer reconnect refused" });
    expect(retry.open).toBe(false);
    expect(retry.socket.refusal).toBe("denied");
  }, 30_000);

  it("3: KK HS1 over the relay reaches PeerSessions with transport 'relay', exchanges revocations, enforces transport kind, and parses nothing before roster check", async () => {
    const relay = await new LocalRelay().ready();
    cleanups.push(() => relay.stop());

    const a = await makeServerStack({ clustered: true });
    const peerB = await makeMemberKeys();
    const devD = await makeMemberKeys();
    await a.roster.addServer({ keys: peerB.keys, name: "Peer B" });
    await a.roster.addDevice({ keys: devD.keys, name: "Phone D" });

    const key = newRelayRoomKey();
    const allowList = relayAllowList({ roster: a.roster, identity: a.identity, pairing: a.pairing });
    const connector = new RelayConnector({ url: relay.url, roomKey: key, sessions: a.router, allowList, log: (l) => a.logs.push(l) });
    cleanups.push(() => connector.close());
    await connector.start();
    await until(() => connector.state === "ready", { what: "room ready" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // (a) Nothing parsed before roster check: a device in the room (valid device token) sending a KK HS1 + trailing
    // garbage is refused by serverPeerCheck at HS1, gets no HS2, and parses 0 frames.
    const devToken = await relayDeviceToken(devD.memberId, devD.dhKey, a.identity.dhPub);
    const badPeer = await openRelayTransport(relay.url, connector.room!, devToken);
    const badFrames: Uint8Array[] = [];
    badPeer.bind({ receive: (f) => badFrames.push(f), transportClosed: () => undefined });
    const stranger = await strangerKeys();
    const badHs1 = await new Initiator({
      mode: "kk", transport: "relay", cluster: a.roster.clusterId!,
      self: { memberId: stranger.memberId, dhPub: stranger.dhPub, dhKey: stranger.dhKey },
      responder: { memberId: a.memberId, dhPub: a.identity.dhPub },
    }).start();
    badPeer.transport.send(badHs1);
    badPeer.transport.send(Uint8Array.of(0x20, 0, 0, 0, 1, 2, 3));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(badFrames).toEqual([]);
    expect(a.peers.all.every((s) => s.parsed === 0)).toBe(true);

    // (b) Transport kind is enforced: KK HS1 naming "tailnet" over the relay is refused ("HS1 names another transport").
    const peerToken = await relayDeviceToken(peerB.memberId, peerB.dhKey, a.identity.dhPub);
    const wrongTransport = await openRelayTransport(relay.url, connector.room!, peerToken);
    const wrongFrames: Uint8Array[] = [];
    wrongTransport.bind({ receive: (f) => wrongFrames.push(f), transportClosed: () => undefined });
    const tailnetHs1 = await new Initiator({
      mode: "kk", transport: "tailnet", cluster: a.roster.clusterId!,
      self: { memberId: peerB.memberId, dhPub: peerB.dhPub, dhKey: peerB.dhKey },
      responder: { memberId: a.memberId, dhPub: a.identity.dhPub },
    }).start();
    wrongTransport.transport.send(tailnetHs1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(wrongFrames).toEqual([]);

    // (c) Valid KK HS1 with transport "relay" reaches PeerSessions, opens with transport "relay", and exchanges revocations.
    const goodConn = await openRelayTransport(relay.url, connector.room!, peerToken);
    const gotFromA: WireMessage[] = [];
    let bLink!: SessionLink;
    bLink = SessionLink.initiate(goodConn.transport, {
      mode: "kk", transport: "relay", cluster: a.roster.clusterId!,
      self: { memberId: peerB.memberId, dhPub: peerB.dhPub, dhKey: peerB.dhKey },
      responder: { memberId: a.memberId, dhPub: a.identity.dhPub },
    }, {
      onFrame: (plaintext) => {
        const decoded = decodeWireFrame(plaintext, "peer", { local: false });
        if (decoded.ok) gotFromA.push(decoded.message);
      },
      onEnd: () => undefined,
    });
    goodConn.bind({ receive: (f) => bLink.receive(f), transportClosed: () => bLink.transportClosed() });
    const info = await bLink.established;
    expect(info.transport).toBe("relay");

    // Send B's empty revocation sync chunk so A finishes sync and keeps the peer session live.
    const revMsg = encodeWireFrame({ t: "roster.revocations", statements: [] }, "peer", { local: false });
    expect(revMsg.ok).toBe(true);
    if (revMsg.ok) bLink.send("control", encoder.encode(revMsg.text));

    await until(() => a.peers.session(peerB.memberId)?.state === "open", { what: "peer session open on A" });
    expect(a.peers.session(peerB.memberId)!.link.info?.transport).toBe("relay");
    await until(() => gotFromA.some((m) => m.t === "roster.revocations"), { what: "A sent roster.revocations" });
  }, 30_000);

  it("4: device IK HS1 over the relay reaches RemoteSessions with transport 'relay' (128 KiB chunks) and forwards link.resume?.()", async () => {
    // Unit check: SessionRouter forwards AcceptedSession.link.resume?.() once a target is picked (and is a no-op before).
    const resumeSpy = vi.fn();
    const stubRouter = new SessionRouter(
      { accept: () => ({ link: { established: new Promise(() => undefined), resume: resumeSpy }, receive: () => undefined, transportClosed: () => undefined }) },
      null,
      50,
    );
    const accepted = stubRouter.accept({ send: () => undefined, close: () => undefined }, "relay");
    expect(() => accepted.link.resume?.()).not.toThrow();
    expect(resumeSpy).not.toHaveBeenCalled();
    accepted.receive(Uint8Array.of(0x10, 1, 2, 2)); // picks device acceptor
    accepted.link.resume?.();
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    const relay = await new LocalRelay().ready();
    cleanups.push(() => relay.stop());

    const a = await makeServerStack({ clustered: true });
    const devD = await makeMemberKeys();
    await a.roster.addDevice({ keys: devD.keys, name: "Phone D" });

    const key = newRelayRoomKey();
    const allowList = relayAllowList({ roster: a.roster, identity: a.identity, pairing: a.pairing });
    // Tight pacer burst so back-pressure exercises RelayConnector -> SessionRouter.link.resume?.() -> RemoteSession.link.resume().
    const connector = new RelayConnector({ url: relay.url, roomKey: key, sessions: a.router, allowList, pace: { rate: 25, burst: 2 }, log: (l) => a.logs.push(l) });
    cleanups.push(() => connector.close());
    await connector.start();
    await until(() => connector.state === "ready", { what: "room ready" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const devToken = await relayDeviceToken(devD.memberId, devD.dhKey, a.identity.dhPub);
    const conn = await openRelayTransport(relay.url, connector.room!, devToken);
    const receivedFrames: Uint8Array[] = [];
    let dLink!: SessionLink;
    dLink = SessionLink.initiate(conn.transport, {
      mode: "ik", transport: "relay", cluster: a.roster.clusterId!,
      self: { memberId: devD.memberId, dhPub: devD.dhPub, dhKey: devD.dhKey },
      responder: { memberId: a.memberId, dhPub: a.identity.dhPub },
    }, {
      onFrame: (bytes) => { receivedFrames.push(bytes); },
      onEnd: () => undefined,
    });
    conn.bind({ receive: (f) => dLink.receive(f), transportClosed: () => dLink.transportClosed() });
    const info = await dLink.established;
    expect(info.transport).toBe("relay");

    await until(() => a.remote.open.length === 1, { what: "remote device session open" });
    const session = a.remote.open[0]!;
    expect(session.link.info?.transport).toBe("relay");

    // 128 KiB bulk chunk support (> 64 KiB tailnet limit, <= RELAY_BULK_FRAME_LIMIT):
    const largeChunk = new Uint8Array(128 * 1024).fill(0x5a);
    expect(largeChunk.length).toBeGreaterThan(BULK_FRAME_LIMIT);
    expect(largeChunk.length).toBeLessThanOrEqual(RELAY_BULK_FRAME_LIMIT);
    session.link.send("bulk", largeChunk);
    // Queue several control frames too so the tight pacer (burst 2) withholds writable() and resumes via link.resume?.().
    for (let i = 0; i < 4; i++) session.link.send("control", encoder.encode(`msg-${i}`));

    await until(() => receivedFrames.length === 5, { what: "128 KiB chunk and resumed frames delivered", timeout: 10_000 });
    expect(receivedFrames.some((f) => f.length === largeChunk.length && f[0] === 0x5a)).toBe(true);
  }, 30_000);

  it("5: pair HS1 through the relay reaches ServerJoin only for an open offer", async () => {
    const relay = await new LocalRelay().ready();
    cleanups.push(() => relay.stop());

    const n = await makeServerStack({ clustered: false });
    const offer = n.serverJoin.createOffer("New Server");
    const parsed = parseJoinLink(offer.link)!;
    const offerSecret = fromBase64Url(parsed.secret)!;
    const dialer = await makeMemberKeys();
    const dialerToken = await relayDeviceToken(dialer.memberId, dialer.dhKey, n.identity.dhPub);
    const dialerHash = await relayTokenHash(dialerToken);

    const key = newRelayRoomKey();
    const connector = new RelayConnector({
      url: relay.url, roomKey: key, sessions: n.router,
      allowList: async () => [{ h: dialerHash }],
      log: (l) => n.logs.push(l),
    });
    cleanups.push(() => connector.close());
    await connector.start();
    await until(() => connector.state === "ready", { what: "room ready" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // (a) A pair HS1 naming an unknown/closed offer id does NOT reach ServerJoin; routed to devices and refused (no HS2).
    const wrongOfferConn = await openRelayTransport(relay.url, connector.room!, dialerToken);
    const wrongFrames: Uint8Array[] = [];
    wrongOfferConn.bind({ receive: (f) => wrongFrames.push(f), transportClosed: () => undefined });
    const unknownHs1 = await new Initiator({
      mode: "pair", transport: "relay", cluster: "0".repeat(32),
      self: { memberId: dialer.memberId, dhPub: dialer.dhPub, dhKey: dialer.dhKey },
      responder: { memberId: n.memberId, dhPub: n.identity.dhPub },
      pair: { offer: "unknown-offer-id-1234", secret: offerSecret },
    }).start();
    wrongOfferConn.transport.send(unknownHs1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(wrongFrames).toEqual([]);

    // (b) A pair HS1 naming the open offer reaches ServerJoin with transport 'relay', completes handshake, and gets join.hello.
    const goodConn = await openRelayTransport(relay.url, connector.room!, dialerToken);
    const gotJoin: WireMessage[] = [];
    let sLink!: SessionLink;
    sLink = SessionLink.initiate(goodConn.transport, {
      mode: "pair", transport: "relay", cluster: "0".repeat(32),
      self: { memberId: dialer.memberId, dhPub: dialer.dhPub, dhKey: dialer.dhKey },
      responder: { memberId: n.memberId, dhPub: n.identity.dhPub },
      pair: { offer: offer.offer, secret: offerSecret },
    }, {
      onFrame: (plaintext) => {
        const decoded = decodeWireFrame(plaintext, "peer", { local: false, pairing: true });
        if (decoded.ok) gotJoin.push(decoded.message);
      },
      onEnd: () => undefined,
    });
    goodConn.bind({ receive: (f) => sLink.receive(f), transportClosed: () => sLink.transportClosed() });
    const info = await sLink.established;
    expect(info.transport).toBe("relay");
    await until(() => gotJoin.some((m) => m.t === "join.hello"), { what: "join.hello from ServerJoin" });
  }, 30_000);
});
