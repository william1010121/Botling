// Botling 3 M3 step 3: peer sessions between servers (src/server/peer), in one process with real rosters on real
// server.db files and an in-memory loopback network between them (frames in order, as a WebSocket carries them).
// The two-botlingd run with the fault proxy is two-servers-peer.test.ts.
//
// - KK opens only when both keys are valid in both rosters; both servers dial at once → exactly one session survives,
//   the one dialled by the smaller server id (both sides keep the same one).
// - An unknown key: refused at HS1, nothing answered, nothing parsed; a server key that dials IK is a device dial and
//   fails there too; a device-kind key that dials KK fails the server check.
// - A revoked server (D47): the exchange carries Revoke/Root through a refused handshake; the refusing side parses
//   nothing but `roster.revocations` (+ bye): a raw client with the revoked server's keys sending other frames gets
//   `bye{revoked}` after the exchange, and a non-revocation first frame gets `bye{role}` with nothing merged.
// - The removed server redials on its short timer for the exchange only; once the root's side holds a `Root` that
//   leaves the revocation out, the next exchange brings it back and a full session opens.
// - Pushes: a revocation committed while a session is live reaches the peer at once; a peer revoked while live gets
//   the statement and `bye{revoked}`.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { decodeWireFrame, encodeWireFrame, type WireMessage } from "../../src/protocol";
import { generateDhKeyPair, hs1Mode, Initiator, Responder, SessionLink, type LocalStatic, type PeerStatic, type SessionTransport } from "../../src/session";
import { bindServerIdentity, loadOrCreateServerIdentity, type ServerIdentity } from "../../src/server/identity";
import { RosterStore } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import {
  addressesValue, DEFAULT_PEER_TIMERS, loopbackAddress, peerTimers, PeerSessions, SessionRouter, type AcceptedSession, type PeerConnection, type PeerConnector, type PeerTimers,
} from "../../src/server/peer";
import { testRoot } from "../botlingd-harness";
import { sleep, until } from "../helpers";
import {
  makeCluster, nextRoot, profile, readServerKeys, revokeServer, sign, strangerKeys, writeStatements,
  type MemberKeysInfo, type Recovery,
} from "../support/peer-cluster";
import type { StoredStatement } from "../../src/server/roster";

const root = testRoot("peer-sessions");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TIMERS: PeerTimers = { pingMs: 150, deadMs: 900, redialMinMs: 40, redialMaxMs: 300, revokedRedialMs: 700 };

// ---------------------------------------------------------------------------------------------
// An in-memory loopback network: `ws://127.0.0.1:<port>/v3/ws` → that server's SessionRouter.

const deviceStub = {
  accepted: 0,
  accept(transport: SessionTransport): AcceptedSession {
    this.accepted++;
    return { link: { established: Promise.reject(new Error("a device dial")) }, receive: () => transport.close(), transportClosed: () => undefined };
  },
};

class Net {
  readonly routers = new Map<number, SessionRouter>();
  readonly dials: Array<{ from: string; port: number }> = [];
  readonly blocked = new Set<string>();

  connector(from: string): PeerConnector {
    return { connect: async (url) => {
      const port = Number(/:(\d+)\//.exec(url)?.[1]);
      this.dials.push({ from, port });
      const router = this.routers.get(port);
      if (!router || this.blocked.has(`${from}->${port}`)) throw new Error("connection refused");
      return this.pair(router);
    } };
  }

  /** A connection to `router`; the client side as a PeerConnection. */
  pair(router: SessionRouter): PeerConnection & { received: Uint8Array[] } {
    let open = true;
    let events: { frame(frame: Uint8Array): void; closed(): void } | null = null;
    const early: Array<() => void> = [];
    const toClient = (run: (e: { frame(frame: Uint8Array): void; closed(): void }) => void) => setImmediate(() => { if (events) run(events); else early.push(() => run(events!)); });
    let accepted: AcceptedSession;
    const serverSide: SessionTransport = {
      send: (frame) => { if (open) { const copy = new Uint8Array(frame); toClient((e) => e.frame(copy)); } },
      close: () => { if (!open) return; open = false; setImmediate(() => accepted.transportClosed()); toClient((e) => e.closed()); },
    };
    accepted = router.accept(serverSide, "tailnet");
    const client: PeerConnection & { received: Uint8Array[] } = {
      received: [],
      send: (frame) => { if (open) { const copy = new Uint8Array(frame); setImmediate(() => { if (open) accepted.receive(copy); }); } },
      close: () => { if (!open) return; open = false; setImmediate(() => accepted.transportClosed()); toClient((e) => e.closed()); },
      bind: (bound) => { events = bound; for (const run of early.splice(0)) run(); },
    };
    return client;
  }
}

interface TestPeer {
  name: string;
  port: number;
  dir: string;
  identity: ServerIdentity;
  keys: MemberKeysInfo;
  store?: ServerStore;
  roster?: RosterStore;
  peers?: PeerSessions;
  logs: string[];
}

const live: TestPeer[] = [];
afterEach(async () => {
  for (const peer of live.splice(0)) {
    peer.peers?.close();
    await sleep(20);
    await peer.store?.close().catch(() => undefined);
  }
});

let n = 0;
async function makePeer(name: string, port: number): Promise<TestPeer> {
  const dir = join(root, `${name}${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  await store.submit((tx) => bindServerIdentity(tx, identity));
  await store.close();
  return { name, port, dir, identity, keys: await readServerKeys(dir), logs: [] };
}

async function run(net: Net, peer: TestPeer, start = true, random?: () => number): Promise<TestPeer> {
  peer.store = await openServerStore(peer.dir);
  peer.roster = await RosterStore.open(peer.store, peer.identity, { log: (line) => peer.logs.push(line) });
  const self: LocalStatic = { memberId: peer.identity.memberId, dhPub: peer.identity.dhPub, dhKey: peer.identity.dhKey };
  peer.peers = new PeerSessions({ roster: peer.roster, self, timers: TIMERS, log: (line) => peer.logs.push(line) }, { connector: net.connector(peer.name), random });
  net.routers.set(peer.port, new SessionRouter(deviceStub, peer.peers));
  live.push(peer);
  if (start) peer.peers.start();
  return peer;
}

/** A and B (and more) in one cluster, each with the others' Adds and loopback profiles. */
async function cluster(names: string[], extra: (keys: MemberKeysInfo[], c: { clusterId: string; recovery: Recovery; root: StoredStatement }) => Promise<Record<string, StoredStatement[]>> = async () => ({})) {
  const net = new Net();
  const peers = await Promise.all(names.map((name, i) => makePeer(name, 41_000 + i + n * 10)));
  const c = await makeCluster(peers.map((p) => p.keys));
  const profiles: StoredStatement[] = [];
  for (const p of peers) profiles.push(await profile(c.clusterId, p.keys, p.keys, p.port));
  const more = await extra(peers.map((p) => p.keys), c);
  for (const p of peers) writeStatements(p.dir, c.clusterId, [...c.statements, ...profiles, ...(more[p.name] ?? [])]);
  return { net, peers, ...c };
}

const liveWith = (p: TestPeer, other: TestPeer) => p.peers!.states().find((s) => s.member === other.identity.memberId)?.state === "live";

/** A raw KK client (the test holds a server's keys) to `port`; returns the decoded frames it receives. */
async function rawDial(net: Net, port: number, self: LocalStatic, responder: PeerStatic, clusterId: string) {
  const connection = net.pair(net.routers.get(port)!);
  const received: WireMessage[] = [];
  let ended = false;
  const link = SessionLink.initiate(connection, { mode: "kk", transport: "tailnet", cluster: clusterId, self, responder }, {
    onFrame: (plaintext) => { const decoded = decodeWireFrame(plaintext, "peer", { local: false }); if (decoded.ok) received.push(decoded.message); },
    onEnd: () => { ended = true; },
  });
  connection.bind({ frame: (frame) => { connection.received.push(frame); link.receive(frame); }, closed: () => link.transportClosed() });
  const send = (message: WireMessage) => link.send("control", new TextEncoder().encode((encodeWireFrame(message, "peer", { local: false }) as { text: string }).text));
  return { link, received, connection, send, get ended() { return ended; } };
}

describe("M3 step 3: peer sessions", () => {
  it("KK between two valid servers: both dial at once, exactly one session survives (the smaller server id's)", async () => {
    const { net, peers: [a, b] } = await cluster(["A", "B"]);
    // No jitter: both first dials leave in the same tick.
    await Promise.all([run(net, a, false, () => 0), run(net, b, false, () => 0)]);
    a.peers!.start(); b.peers!.start();
    await until(() => liveWith(a, b) && liveWith(b, a), { timeout: 10_000, what: "both live" });
    await sleep(TIMERS.redialMaxMs * 2);
    // Both dialled.
    expect(net.dials.filter((d) => d.from === "A").length).toBeGreaterThanOrEqual(1);
    expect(net.dials.filter((d) => d.from === "B").length).toBeGreaterThanOrEqual(1);
    const smaller = a.identity.memberId < b.identity.memberId ? a.identity.memberId : b.identity.memberId;
    const sa = a.peers!.states()[0]!, sb = b.peers!.states()[0]!;
    expect(sa.state).toBe("live");
    expect(sb.state).toBe("live");
    // The same session on both sides, dialled by the smaller id.
    expect(sa.sessionId).toBe(sb.sessionId);
    expect(sa.initiator).toBe(smaller);
    expect(sb.initiator).toBe(smaller);
    // Exactly one open session on each side.
    expect(a.peers!.all.filter((s) => s.state === "open")).toHaveLength(1);
    expect(b.peers!.all.filter((s) => s.state === "open")).toHaveLength(1);
    // A lone peer list holds only the other server.
    expect(a.peers!.states().map((s) => s.member)).toEqual([b.identity.memberId]);
  }, 30_000);

  it("forced race: two sessions opened at once on both sides → both keep the one dialled by the smaller id", async () => {
    for (let round = 0; round < 5; round++) {
      const { net, peers: [a, b] } = await cluster(["A", "B"]);
      await Promise.all([run(net, a, false, () => 0), run(net, b, false, () => 0)]);
      // Both dial in the same tick.
      a.peers!.start(); b.peers!.start();
      await until(() => liveWith(a, b) && liveWith(b, a), { timeout: 10_000, what: "both live" });
      await sleep(100);
      const smaller = a.identity.memberId < b.identity.memberId ? a.identity.memberId : b.identity.memberId;
      expect(net.dials.map((d) => d.from).sort()).toEqual(["A", "B"]);
      expect(a.peers!.states()[0]!.initiator).toBe(smaller);
      expect(a.logs.concat(b.logs).some((line) => /two sessions; keeping the one dialled by/.test(line))).toBe(true);
      expect(b.peers!.states()[0]!.sessionId).toBe(a.peers!.states()[0]!.sessionId);
      for (const p of [a, b]) { p.peers!.close(); await sleep(10); await p.store!.close(); live.splice(live.indexOf(p), 1); }
    }
  }, 60_000);

  it("a session needs both keys valid in both rosters; an unknown key gets nothing; wrong modes fail their acceptor", async () => {
    const { net, peers: [a, b], clusterId } = await cluster(["A", "B"]);
    await run(net, a);
    // An unknown server key dialling KK: refused at HS1, not one frame back.
    const stranger = await strangerKeys();
    const raw = await rawDial(net, a.port, { memberId: stranger.memberId, dhPub: stranger.dhPub, dhKey: stranger.dhKey }, { memberId: a.identity.memberId, dhPub: a.identity.dhPub }, clusterId);
    await expect(raw.link.established).rejects.toThrow();
    expect(raw.connection.received).toHaveLength(0);
    expect(raw.received).toHaveLength(0);
    await until(() => a.logs.some((line) => /handshake ended \(roster: not a server of this roster\)/.test(line)), { what: "refusal logged" });
    // A server with no cluster yet refuses every KK, even from a real server key.
    const lonely = await makePeer("L", 49_999);
    await run(net, lonely);
    const toLonely = await rawDial(net, lonely.port, { memberId: a.identity.memberId, dhPub: a.identity.dhPub, dhKey: a.identity.dhKey }, { memberId: lonely.identity.memberId, dhPub: lonely.identity.dhPub }, clusterId);
    await expect(toLonely.link.established).rejects.toThrow();
    expect(toLonely.connection.received).toHaveLength(0);
    // A server key that dials IK goes to the device acceptor (and fails there).
    const before = deviceStub.accepted;
    const ik = net.pair(net.routers.get(a.port)!);
    const ikLink = SessionLink.initiate(ik, { mode: "ik", transport: "tailnet", cluster: clusterId, self: { memberId: b.identity.memberId, dhPub: b.identity.dhPub, dhKey: b.identity.dhKey }, responder: { memberId: a.identity.memberId, dhPub: a.identity.dhPub } }, { onFrame: () => undefined });
    ik.bind({ frame: (frame) => ikLink.receive(frame), closed: () => ikLink.transportClosed() });
    await expect(ikLink.established).rejects.toThrow();
    expect(deviceStub.accepted).toBe(before + 1);
    expect(a.peers!.all.filter((s) => s.state === "open")).toHaveLength(0);
  }, 30_000);

  it("D47: a revoked server's handshake carries only the revocation exchange and bye; it learns it was removed", async () => {
    let revokeB!: StoredStatement;
    const { net, peers: [a, b] } = await cluster(["A", "B"], async ([ka, kb], c) => {
      revokeB = await revokeServer(c.clusterId, ka!, kb!);
      return { A: [revokeB] };
    });
    await Promise.all([run(net, a), run(net, b)]);
    // A (the root) knows B is removed and never dials it; B does not know yet and dials A.
    await until(() => b.logs.some((line) => line.includes("took 1 revocation statement")), { timeout: 10_000, what: "B took the Revoke" });
    expect(b.roster!.view.valid.has(b.identity.memberId)).toBe(false);
    await until(() => a.logs.some((line) => /exchange done/.test(line)), { what: "A's exchange" });
    expect(a.logs.some((line) => /exchange only \(the peer is not valid here\)/.test(line))).toBe(true);
    expect(net.dials.filter((d) => d.from === "A")).toHaveLength(0);
    expect(a.peers!.states()[0]!.state).toBe("gone");
    // B, removed, dials again for the exchange only, on the short timer (not the backoff).
    const firstDials = net.dials.filter((d) => d.from === "B").length;
    await until(() => net.dials.filter((d) => d.from === "B").length >= firstDials + 2, { timeout: 10_000, what: "two more exchange dials" });
    expect(b.logs.filter((line) => /dialling \(exchange only/.test(line)).length).toBeGreaterThanOrEqual(2);
    expect(a.peers!.all.filter((s) => s.state === "open")).toHaveLength(0);
    expect(b.peers!.all.filter((s) => s.state === "open")).toHaveLength(0);
    void revokeB;
  }, 30_000);

  it("D47 at the refusing side: nothing but roster.revocations is parsed; any other first frame gets bye{role}, nothing merged", async () => {
    let revokeB!: StoredStatement;
    const { net, peers: [a, b], clusterId, recovery, root: root1 } = await cluster(["A", "B"], async ([ka, kb], c) => {
      revokeB = await revokeServer(c.clusterId, ka!, kb!);
      return { A: [revokeB] };
    });
    await run(net, a);
    const bSelf = { memberId: b.identity.memberId, dhPub: b.identity.dhPub, dhKey: b.identity.dhKey };
    const aStatic = { memberId: a.identity.memberId, dhPub: a.identity.dhPub };
    // 1. Revocations, then frames A must not read: A answers with its revocations, then bye{revoked}.
    const one = await rawDial(net, a.port, bSelf, aStatic, clusterId);
    await one.link.established;
    const root2 = await nextRoot(recovery, root1, a.keys); // a Root the test (as the recovery key) made: B's copy only
    one.send({ t: "roster.revocations", statements: [root2.statement] } as WireMessage);
    one.send({ t: "roster.have", digest: "0".repeat(64) } as WireMessage);
    one.send({ t: "ping" } as WireMessage);
    await until(() => one.ended, { what: "A ends the session" });
    const kinds = one.received.map((m) => m.t);
    expect(kinds).toEqual(["roster.revocations", "bye"]);
    expect((one.received[1] as { reason: string }).reason).toBe("revoked");
    // A sent only Revoke/Root statements.
    const sent = (one.received[0] as { statements: Array<{ body: { type: string } }> }).statements;
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((s) => s.body.type === "revoke" || s.body.type === "root")).toBe(true);
    // A took the Root (the D47 merge) …
    await until(() => a.roster!.statements().some((s) => s.id === root2.id), { what: "A merged the Root" });
    // … and parsed exactly one frame of B's: the later ones were not decoded.
    await until(() => a.logs.some((line) => /exchange done \(1 new statements taken\)/.test(line)), { what: "exchange done" });
    // The Root brought B back at A (Root{2} keeps nothing): A now finds B valid.
    expect(a.roster!.view.valid.has(b.identity.memberId)).toBe(true);
  }, 30_000);

  it("D47 at the refusing side: a first frame other than roster.revocations ends the session with bye{role} and nothing merged", async () => {
    const { net, peers: [a, b], clusterId, recovery, root: root1 } = await cluster(["A", "B"], async ([ka, kb], c) => ({ A: [await revokeServer(c.clusterId, ka!, kb!)] }));
    await run(net, a);
    const raw = await rawDial(net, a.port, { memberId: b.identity.memberId, dhPub: b.identity.dhPub, dhKey: b.identity.dhKey }, { memberId: a.identity.memberId, dhPub: a.identity.dhPub }, clusterId);
    await raw.link.established;
    const root2 = await nextRoot(recovery, root1, a.keys);
    raw.send({ t: "roster.have", digest: "0".repeat(64) } as WireMessage);
    raw.send({ t: "roster.revocations", statements: [root2.statement] } as WireMessage);
    await until(() => raw.ended, { what: "A ends the session" });
    expect(raw.received.map((m) => m.t)).toEqual(["roster.revocations", "bye"]);
    expect((raw.received[1] as { reason: string }).reason).toBe("role");
    await sleep(100);
    expect(a.roster!.statements().some((s) => s.id === root2.id)).toBe(false);
    expect(a.roster!.view.valid.has(b.identity.memberId)).toBe(false);
  }, 30_000);

  it("D47 redial: the removed server's short-timer redial carries a Root that brings it back, then a full session opens", async () => {
    let revokeB!: StoredStatement;
    const { net, peers: [a, b], recovery, root: root1 } = await cluster(["A", "B"], async ([ka, kb], c) => {
      revokeB = await revokeServer(c.clusterId, ka!, kb!);
      return { A: [revokeB], B: [revokeB] };
    });
    // A cannot reach B (only B's dials get through), so whatever B learns comes by its own exchange redials.
    net.blocked.add(`A->${b.port}`);
    await Promise.all([run(net, a), run(net, b)]);
    await until(() => b.logs.filter((line) => /dialling \(exchange only/.test(line)).length >= 2, { timeout: 10_000, what: "B's exchange redials" });
    expect(b.roster!.view.valid.has(b.identity.memberId)).toBe(false);
    // The user types the recovery code at A: Root{2} keeps nothing, so the root's Revoke of B stops counting.
    const root2 = await nextRoot(recovery, root1, a.keys);
    await a.roster!.mergeRevocations([root2.statement]);
    expect(a.roster!.view.valid.has(b.identity.memberId)).toBe(true);
    const at = Date.now();
    await until(() => b.roster!.statements().some((s) => s.id === root2.id), { timeout: 10_000, what: "B got the Root" });
    expect(Date.now() - at).toBeLessThanOrEqual(TIMERS.revokedRedialMs * 1.5 + 1_000);
    expect(b.roster!.view.valid.has(b.identity.memberId)).toBe(true);
    await until(() => liveWith(a, b) && liveWith(b, a), { timeout: 10_000, what: "both live" });
    expect(b.peers!.states()[0]!.initiator).toBe(b.identity.memberId); // B dialled (A cannot reach it)
  }, 30_000);

  it("pushes while live: a new revocation reaches the peer at once; a peer revoked while live gets it and bye{revoked}", async () => {
    let revokeC!: StoredStatement, revokeB!: StoredStatement;
    const { net, peers: [a, b, c] } = await cluster(["A", "B", "C"], async ([ka, kb, kc], cl) => {
      revokeC = await revokeServer(cl.clusterId, ka!, kc!);
      revokeB = await revokeServer(cl.clusterId, ka!, kb!);
      return {};
    });
    await Promise.all([run(net, a), run(net, b)]); // C stays off
    await until(() => liveWith(a, b) && liveWith(b, a), { timeout: 10_000, what: "A–B live" });
    // The root removes C: B holds the Revoke right after.
    await a.roster!.mergeRevocations([revokeC.statement]);
    await until(() => b.roster!.statements().some((s) => s.id === revokeC.id), { timeout: 5_000, what: "push reached B" });
    expect(b.roster!.view.valid.has(c.identity.memberId)).toBe(false);
    expect(liveWith(a, b)).toBe(true);
    // The root removes B while the session is live: B gets the Revoke, then bye{revoked}.
    await a.roster!.mergeRevocations([revokeB.statement]);
    await until(() => b.roster!.statements().some((s) => s.id === revokeB.id), { timeout: 5_000, what: "B got its Revoke" });
    await until(() => !liveWith(a, b) && !liveWith(b, a), { timeout: 5_000, what: "session ended" });
    expect(a.peers!.states().find((s) => s.member === b.identity.memberId)!.state).toBe("gone");
    expect(b.roster!.view.valid.has(b.identity.memberId)).toBe(false);
  }, 30_000);
});

describe("M3 step 3: peer settings, the /v3/ws router and the KK rule", () => {
  it("timers: defaults (15 s ping, 45 s dead, 10 min exchange redial) and the test knob; malformed values refused", () => {
    expect(peerTimers({})).toEqual(DEFAULT_PEER_TIMERS);
    expect(DEFAULT_PEER_TIMERS).toMatchObject({ pingMs: 15_000, deadMs: 45_000, revokedRedialMs: 600_000 });
    expect(peerTimers({ BOTLING_SERVER_PEER_TIMERS: "ping=200, dead=600,revoked=1500" })).toMatchObject({ pingMs: 200, deadMs: 600, revokedRedialMs: 1_500 });
    for (const bad of ["ping", "ping=x", "sleep=100", "ping=5", "ping=700,dead=600", "redial=500,redialMax=100"]) {
      expect(() => peerTimers({ BOTLING_SERVER_PEER_TIMERS: bad })).toThrow();
    }
  });

  it("addresses: only ws://127.0.0.1:<port>/v3/ws is dialled", () => {
    expect(loopbackAddress(addressesValue(8744))).toBe("ws://127.0.0.1:8744/v3/ws");
    for (const value of [null, "", "{", "[]", JSON.stringify({ loopback: "ws://0.0.0.0:1/v3/ws" }), JSON.stringify({ loopback: "ws://localhost:1/v3/ws" }),
      JSON.stringify({ loopback: "wss://127.0.0.1:1/v3/ws" }), JSON.stringify({ loopback: "ws://127.0.0.1:0/v3/ws" }), JSON.stringify({ loopback: "ws://127.0.0.1:70000/v3/ws" }),
      JSON.stringify({ loopback: "ws://127.0.0.1:1/other" }), JSON.stringify({ tailnet: "https://host.invalid" })]) {
      expect(loopbackAddress(value)).toBeNull();
    }
  });

  it("router: a KK HS1 goes to the peer acceptor, other first frames to devices; a silent socket is closed", async () => {
    const seen: string[] = [];
    const acceptor = (name: string) => ({ accept: () => { seen.push(name); return { link: { established: new Promise(() => undefined) }, receive: () => undefined, transportClosed: () => undefined }; } });
    const router = new SessionRouter(acceptor("device"), acceptor("peer"), 50);
    const self = await generateDhKeyPair();
    const responder = await generateDhKeyPair();
    const base = { transport: "tailnet" as const, cluster: "0".repeat(32), self: { memberId: "a".repeat(26), dhPub: self.publicKey, dhKey: self.privateKey }, responder: { memberId: "b".repeat(26), dhPub: responder.publicKey } };
    const kk = await new Initiator({ ...base, mode: "kk" }).start();
    const ik = await new Initiator({ ...base, mode: "ik" }).start();
    expect(hs1Mode(kk)).toBe("kk");
    expect(hs1Mode(ik)).toBe("ik");
    expect(hs1Mode(Uint8Array.of(0x20, 1, 1, 1))).toBeNull();
    const t = () => ({ send: () => undefined, close: () => { closed++; } });
    let closed = 0;
    router.accept(t(), "tailnet").receive(kk);
    router.accept(t(), "tailnet").receive(ik);
    router.accept(t(), "tailnet").receive(Uint8Array.of(1, 2, 3));
    expect(seen).toEqual(["peer", "device", "device"]);
    const silent = router.accept(t(), "tailnet");
    await expect(silent.link.established).rejects.toThrow(/no handshake/);
    expect(closed).toBe(1);
    // Without a peer acceptor (no M3), KK goes to the device side as before.
    const old = new SessionRouter(acceptor("device"), null, 50);
    old.accept(t(), "tailnet").receive(kk);
    expect(seen.at(-1)).toBe("device");
  });

  it("KK without an expected initiator is refused unless the responder checks the roster itself (kkFromRoster)", async () => {
    const i = await generateDhKeyPair(), r = await generateDhKeyPair();
    const cluster = "0".repeat(32);
    const init = () => new Initiator({ mode: "kk", transport: "memory", cluster, self: { memberId: "a".repeat(26), dhPub: i.publicKey, dhKey: i.privateKey }, responder: { memberId: "b".repeat(26), dhPub: r.publicKey } });
    const resp = (extra: object) => new Responder({ transport: "memory", cluster, self: { memberId: "b".repeat(26), dhPub: r.publicKey, dhKey: r.privateKey }, modes: ["kk"], checkPeer: () => ({ ok: true }), ...extra });
    await expect(resp({}).receive(await init().start())).rejects.toThrow(/KK needs the expected initiator/);
    await expect(resp({ kkFromRoster: true }).receive(await init().start())).resolves.toBeInstanceOf(Uint8Array);
    await expect(resp({ kkFromRoster: true, checkPeer: () => ({ ok: false, detail: "not a server" }) }).receive(await init().start())).rejects.toThrow(/not a server/);
  });
});

void sign;
