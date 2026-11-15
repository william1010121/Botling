// Botling 3 M3 step 3 (m3-brief §4 row 3): peer sessions between two real botlingd on this machine, through the
// two-server harness and a fault proxy in front of each server's loopback listener (the statements are written
// directly into each server.db while it is stopped: server pairing is step 4).
//
// - KK completes only with both keys valid in both rosters; both servers dial; exactly one session survives, the one
//   dialled by the smaller server id; both listen on 127.0.0.1 only.
// - Proxy faults on the live session: a dropped frame, a duplicated frame, a cut → the session ends and both redial
//   to a new session; a partition → after the dead time both say `stale` since their last frame heard, and redial on
//   recovery.
// - An unknown key over `/v3/ws` gets no frame at all (nothing parsed before the roster check).
// - D47: the root revokes B (statement written at A); B's next dial is the exchange only: B learns it was removed,
//   A parses nothing else; B then dials on its short timer for the exchange only; a `Root` written at A (as the
//   recovery key) comes back to B through that exchange and both are live again.
// Requires `npm run build` (out/server/main.cjs).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionLink } from "../../src/session";
import { until } from "../helpers";
import type { FaultProxy } from "../support/fault-proxy";
import { makeCluster, nextRoot, profile, readServerKeys, revokeServer, strangerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";
import { startServers, type TestCluster, type TestServer } from "../support/two-servers";
import type { StoredStatement } from "../../src/server/roster";

const TIMERS = { ping: 300, dead: 1_500, redial: 150, redialMax: 1_000, revoked: 2_500 };
const TIMERS_ENV = { BOTLING_SERVER_PEER_TIMERS: Object.entries(TIMERS).map(([k, v]) => `${k}=${v}`).join(",") };

interface PeerFile { peers: Array<{ member: string; state: string; since: number | null; initiator?: string; sessionId?: string }> }
function peerState(server: TestServer): PeerFile["peers"][number] | null {
  try { return (JSON.parse(readFileSync(join(server.dataDir, "botlingd.peers.json"), "utf8")) as PeerFile).peers[0] ?? null; } catch { return null; }
}
const logLines = (server: TestServer, pattern: RegExp) => server.log.split("\n").filter((line) => pattern.test(line));

let cluster: TestCluster;
let a: TestServer, b: TestServer;
let ka: MemberKeysInfo, kb: MemberKeysInfo;
let pa: FaultProxy, pb: FaultProxy;
let made: Awaited<ReturnType<typeof makeCluster>>;

/** Both sides live on one session (the same id), different from `not`. */
async function bothLive(not: string | null = null, timeout = 20_000): Promise<string> {
  return until(() => {
    const sa = peerState(a), sb = peerState(b);
    if (sa?.state !== "live" || sb?.state !== "live" || !sa.sessionId || sa.sessionId !== sb.sessionId || sa.sessionId === not) return null;
    return sa.sessionId;
  }, { timeout, every: 50, what: "both live on one session" });
}

/** The proxy the live session runs through (the dialler connects to the other side's proxy). */
function liveProxy(): FaultProxy {
  return peerState(a)!.initiator === ka.memberId ? pb : pa;
}

beforeAll(async () => {
  cluster = await startServers({ name: "peer", env: { A: TIMERS_ENV, B: TIMERS_ENV } });
  ({ a, b } = cluster);
  await Promise.all([a.stop(), b.stop()]);
  [ka, kb] = await Promise.all([readServerKeys(a.dataDir), readServerKeys(b.dataDir)]);
  pa = await cluster.proxy(a, "websocket");
  pb = await cluster.proxy(b, "websocket");
  made = await makeCluster([ka, kb]); // A is the root
  // Each roster names the other's address as the proxy in front of it.
  writeStatements(a.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, kb, kb, pb.port)]);
  writeStatements(b.dataDir, made.clusterId, [...made.statements, await profile(made.clusterId, ka, ka, pa.port)]);
  await Promise.all([a.start(), b.start()]);
}, 120_000);

afterAll(async () => { await cluster?.cleanup(); }, 60_000);

describe("M3 step 3: peer sessions between two botlingd", () => {
  it("KK opens with both keys valid in both rosters; one session, dialled by the smaller server id; loopback only", async () => {
    // Both servers dial at start (each after a random 0–150 ms). When the larger id's dial opens first, both report its
    // session live for a moment, until the smaller id's session opens and replaces it (§6.2). Reading the first live
    // session was the flake (seen under load): wait until both sides agree on one session and keep it.
    const smaller = ka.memberId < kb.memberId ? ka.memberId : kb.memberId;
    const small = smaller === ka.memberId ? a : b;
    let held = { id: "", since: 0 };
    const session = await until(() => {
      const sa = peerState(a), sb = peerState(b);
      const id = sa?.state === "live" && sb?.state === "live" && sa.sessionId && sa.sessionId === sb.sessionId ? sa.sessionId : "";
      if (id !== held.id) held = { id, since: Date.now() };
      // The smaller side dialled: its session is the one that must stay (no other dial is in flight once it is kept).
      const settled = id && sa!.initiator === smaller ? 0 : 1_500;
      return id && Date.now() - held.since >= settled ? id : null;
    }, { timeout: 20_000, every: 50, what: "one session both sides keep" });
    // The smaller id dialled (it always does unless the larger's session was live before its first try): its session
    // won. Every "two sessions" decision on either side kept the smaller id's session.
    if (logLines(small, /: dialling/).length > 0) expect(peerState(a)!.initiator).toBe(smaller);
    expect(peerState(b)!.initiator).toBe(peerState(a)!.initiator);
    for (const line of [...logLines(a, /two sessions; keeping/), ...logLines(b, /two sessions; keeping/)]) expect(line).toContain(`dialled by ${smaller}`);
    expect(peerState(a)!.member).toBe(kb.memberId);
    expect(peerState(b)!.member).toBe(ka.memberId);
    expect(session).toMatch(/^[A-Za-z0-9_-]{22}$/);
    for (const server of [a, b]) server.assertLoopbackOnly({ expectListener: true });
    expect(logLines(a, /exchange only/).length + logLines(b, /exchange only/).length).toBe(0);
    // Both dialled at start (one of the two may have found the other's session live first).
    expect(logLines(a, /dialling/).length + logLines(b, /dialling/).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("a dropped frame ends the session (order) and both redial", async () => {
    const before = await bothLive();
    liveProxy().drop("up", 1);
    const after = await bothLive(before);
    expect(after).not.toBe(before);
    expect(logLines(a, /session ended \(order/).length + logLines(b, /session ended \(order/).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("a duplicated frame ends the session (order) and both redial", async () => {
    const before = await bothLive();
    const orders = logLines(a, /session ended \(order/).length + logLines(b, /session ended \(order/).length;
    liveProxy().duplicate("down", 1);
    const after = await bothLive(before);
    expect(after).not.toBe(before);
    expect(logLines(a, /session ended \(order/).length + logLines(b, /session ended \(order/).length).toBeGreaterThan(orders);
  }, 60_000);

  it("a cut ends the session; both say stale since their last frame, then redial", async () => {
    const before = await bothLive();
    const cutAt = Date.now();
    pa.cut(); pb.cut();
    await until(() => logLines(a, /: stale since/).length > 0 && logLines(b, /: stale since/).length > 0, { timeout: 10_000, what: "stale logged" });
    const after = await bothLive(before);
    expect(after).not.toBe(before);
    // The stale line names a time at or before the cut (the last frame heard), never a later one.
    for (const server of [a, b]) {
      const line = logLines(server, /: stale since/).at(-1)!;
      const since = Date.parse(/stale since (\S+)/.exec(line)![1]);
      expect(since).toBeLessThanOrEqual(cutAt + 50);
      expect(since).toBeGreaterThan(cutAt - TIMERS.dead);
    }
  }, 60_000);

  it("a partition: after the dead time both are stale since their last frame heard; healed → redial", async () => {
    const before = await bothLive();
    const partitionAt = Date.now();
    pa.partition(); pb.partition();
    const stale = await until(() => {
      const sa = peerState(a), sb = peerState(b);
      return sa?.state === "stale" && sb?.state === "stale" ? { at: Date.now(), a: sa.since!, b: sb.since! } : null;
    }, { timeout: 20_000, every: 50, what: "both stale" });
    // Not before the dead time; `since` is the last frame heard, before the partition plus one ping interval.
    expect(stale.at - partitionAt).toBeGreaterThanOrEqual(TIMERS.dead - 100);
    for (const since of [stale.a, stale.b]) {
      expect(since).toBeLessThanOrEqual(partitionAt + TIMERS.ping + 100);
      expect(since).toBeGreaterThan(partitionAt - TIMERS.dead);
    }
    expect(logLines(a, /bye dead|nothing heard/).length + logLines(b, /bye dead|nothing heard/).length).toBeGreaterThanOrEqual(1);
    pa.heal(); pb.heal();
    const after = await bothLive(before, 30_000);
    expect(after).not.toBe(before);
  }, 90_000);

  it("an unknown key over /v3/ws gets no frame back: nothing is parsed before the roster check", async () => {
    const stranger = await strangerKeys();
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}/v3/ws`);
    ws.binaryType = "arraybuffer";
    const received: unknown[] = [];
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("no socket")); });
    const link = SessionLink.initiate({ send: (frame) => ws.send(frame), close: () => ws.close() }, {
      mode: "kk", transport: "tailnet", cluster: made.clusterId,
      self: { memberId: stranger.memberId, dhPub: stranger.dhPub, dhKey: stranger.dhKey },
      responder: { memberId: ka.memberId, dhPub: Uint8Array.from(Buffer.from(ka.dh, "base64url")) },
    }, { onFrame: () => undefined });
    ws.onmessage = (event) => { received.push(event.data); link.receive(new Uint8Array(event.data as ArrayBuffer)); };
    ws.onclose = () => link.transportClosed();
    await expect(link.established).rejects.toThrow();
    expect(received).toHaveLength(0);
    await until(() => logLines(a, /peer \?: handshake ended \(roster: not a server of this roster\)/).length > 0, { what: "refusal logged" });
    expect(a.log).not.toContain(stranger.memberId);
    // The live peer session was not disturbed.
    expect(peerState(a)!.state).toBe("live");
  }, 30_000);

  it("D47: B, revoked at A, gets the exchange only, learns it, redials on the short timer; a Root written at A brings it back", async () => {
    await bothLive();
    // The root (A) removes B: written while A is stopped. B does not know.
    const revokeB: StoredStatement = await revokeServer(made.clusterId, ka, kb);
    await a.stop();
    writeStatements(a.dataDir, made.clusterId, [revokeB]);
    const mark = a.log.length;
    await a.start();
    // A never dials B; B dials A and gets the exchange: it takes the Revoke and finds itself removed.
    await until(() => logLines(b, /took 1 revocation statement/).length >= 1, { timeout: 20_000, what: "B took the Revoke" });
    await until(() => logLines(a, /exchange only \(the peer is not valid here\)/).length >= 1 && peerState(a)?.state === "gone", { timeout: 10_000, what: "A ran the exchange" });
    expect(logLines(a, /exchange done/).length).toBeGreaterThanOrEqual(1);
    expect(a.log.slice(mark)).not.toMatch(/dialling/); // A has not dialled since its restart
    // B, removed, dials again for the exchange only, every `revoked` ms (not the backoff).
    await until(() => logLines(b, /dialling \(exchange only/).length >= 3, { timeout: 20_000, what: "B's exchange redials" });
    const times = logLines(b, /dialling \(exchange only/).map((line) => Date.parse(line.slice(0, 24)));
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(TIMERS.revoked * 0.9);
    expect(peerState(b)?.state).not.toBe("live");
    // The user types the recovery code at A: Root{2} keeps nothing, so the Revoke of B stops counting.
    const root2 = await nextRoot(made.recovery, made.root, ka);
    await a.stop();
    writeStatements(a.dataDir, made.clusterId, [root2]);
    const tookBefore = logLines(b, /took 1 revocation statement/).length;
    await a.start();
    await until(() => logLines(b, /took 1 revocation statement/).length > tookBefore, { timeout: 20_000, what: "B took the Root" });
    await bothLive(null, 30_000);
  }, 120_000);
});
