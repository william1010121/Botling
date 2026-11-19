// Botling 3 M3 step 5 (m3-brief §4 row 5, §5.9): roster and preference gossip between servers, in one process with
// real rosters and preference stores on real server.db files, real peer sessions (KK, D47 sync, D58 order) and an
// in-memory loopback network that can block links (partitions) and drop frames (a dropped frame ends the session,
// D58; both sides redial). Stand-in for the skipped `Roster` server-pairing model gate (no TLA, user's rule).
//
// Property (seeded): random statement sets split across 3 servers (devices added and revoked by any server, a fourth
// and fifth server joined through them, the root's revocation of one with a random cascade, profiles, statements a
// stranger signed, a bad signature), random acts while running (device pairing and revoking, preference writes on
// skewed clocks), random partitions and frame drops → once healed, every server holds the same digest, root, valid
// and revoked set, and the same preferences: each key's `(hlc, writer)` maximum. Throughout: a device a server once
// found revoked is never valid there again; nothing a stranger signed or a bad signature is ever stored; each server
// writes at most one Endorse per member, and exactly one for every valid member it did not add itself.
// Plus focused cases: a device paired on B is valid on A after one session; a device revoked on A is refused by B
// as soon as the statement arrives (immediately on a connected peer, at the next session after a partition); a third
// server learned only through gossip is dialled; an Endorse may travel before its Add in one set; a refused statement
// is asked for again after a later change; an oversize set ends the session.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mergePrefs, rosterDigest, statementId, toBase64Url, type PrefRow, type SignedStatement, type WireMessage } from "../../src/protocol";
import type { LocalStatic, SessionTransport } from "../../src/session";
import { bindServerIdentity, loadOrCreateServerIdentity, type ServerIdentity } from "../../src/server/identity";
import { computeRoster, Gossip, MAX_GOSSIP_SET, PrefsStore, RosterStore, STATEMENTS_PER_FRAME, verifyStatements, type StoredStatement } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { PeerSessions, SessionRouter, type AcceptedSession, type PeerConnection, type PeerConnector, type PeerTimers } from "../../src/server/peer";
import { testRoot } from "../botlingd-harness";
import { envCount, sleep, until } from "../helpers";
import { makeCluster, profile, readServerKeys, sign, strangerKeys, writeStatements, type MemberKeysInfo } from "../support/peer-cluster";

const root = testRoot("gossip-property");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TIMERS: PeerTimers = { pingMs: 150, deadMs: 900, redialMinMs: 30, redialMaxMs: 200, revokedRedialMs: 700 };
const SEEDS = [11, 23, 37, 41, 59, 73].slice(0, envCount("V3_GOSSIP_PROPERTY_SEEDS", 6)); // CI lowers it on pull requests
const STEPS = 45;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x1_0000_0000; };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)]!, chance: (p: number) => next() < p };
}

// ---------------------------------------------------------------------------------------------
// An in-memory loopback network with partitions and frame drops.

const deviceStub = {
  accept(transport: SessionTransport): AcceptedSession {
    return { link: { established: Promise.reject(new Error("a device dial")) }, receive: () => transport.close(), transportClosed: () => undefined };
  },
};

interface Pipe { from: string; to: string; open: boolean; cut(): void; dropNext: number }

class Net {
  readonly routers = new Map<number, { name: string; router: SessionRouter }>();
  readonly pipes = new Set<Pipe>();
  readonly blocked = new Set<string>();
  drops = 0;

  private key(a: string, b: string) { return a < b ? `${a}|${b}` : `${b}|${a}`; }
  isBlocked(a: string, b: string) { return this.blocked.has(this.key(a, b)); }
  block(a: string, b: string) {
    this.blocked.add(this.key(a, b));
    for (const pipe of this.pipes) if (pipe.open && this.key(pipe.from, pipe.to) === this.key(a, b)) pipe.cut();
  }
  heal(a?: string, b?: string) { if (a && b) this.blocked.delete(this.key(a, b)); else this.blocked.clear(); }
  /** Drops the next frame on one open pipe between these two (the session then ends: D58). */
  dropOn(a: string, b: string): boolean {
    for (const pipe of this.pipes) if (pipe.open && this.key(pipe.from, pipe.to) === this.key(a, b)) { pipe.dropNext++; return true; }
    return false;
  }

  connector(from: string): PeerConnector {
    return { connect: async (url) => {
      const port = Number(/:(\d+)\//.exec(url)?.[1]);
      const target = this.routers.get(port);
      if (!target || this.isBlocked(from, target.name)) throw new Error("connection refused");
      return this.pair(from, target.name, target.router);
    } };
  }

  pair(from: string, to: string, router: SessionRouter): PeerConnection {
    let events: { frame(frame: Uint8Array): void; closed(): void } | null = null;
    const early: Array<() => void> = [];
    const toClient = (run: (e: { frame(frame: Uint8Array): void; closed(): void }) => void) => setImmediate(() => { if (events) run(events); else early.push(() => run(events!)); });
    let accepted: AcceptedSession;
    const pipe: Pipe = {
      from, to, open: true, dropNext: 0,
      cut: () => { if (!pipe.open) return; pipe.open = false; this.pipes.delete(pipe); setImmediate(() => accepted.transportClosed()); toClient((e) => e.closed()); },
    };
    this.pipes.add(pipe);
    const dropped = () => { if (pipe.dropNext > 0) { pipe.dropNext--; this.drops++; return true; } return false; };
    const serverSide: SessionTransport = {
      send: (frame) => { if (pipe.open && !dropped()) { const copy = new Uint8Array(frame); toClient((e) => { if (pipe.open) e.frame(copy); }); } },
      close: () => pipe.cut(),
    };
    accepted = router.accept(serverSide, "tailnet");
    return {
      send: (frame) => { if (pipe.open && !dropped()) { const copy = new Uint8Array(frame); setImmediate(() => { if (pipe.open) accepted.receive(copy); }); } },
      close: () => pipe.cut(),
      bind: (bound) => { events = bound; for (const run of early.splice(0)) run(); },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Servers

interface Server {
  name: string;
  port: number;
  dir: string;
  identity: ServerIdentity;
  keys: MemberKeysInfo;
  clock: { skew: number };
  store?: ServerStore;
  roster?: RosterStore;
  prefs?: PrefsStore;
  gossip?: Gossip;
  peers?: PeerSessions;
  logs: string[];
}

const running: Server[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) {
    s.peers?.close();
    s.gossip?.close();
  }
  await sleep(30);
  for (const s of [...stores.splice(0)]) await s.close().catch(() => undefined);
});
const stores: ServerStore[] = [];

let made = 0;
let nextPort = 43_000;
async function makeServer(name: string): Promise<Server> {
  const dir = join(root, `${name}${++made}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  await store.submit((tx) => bindServerIdentity(tx, identity));
  await store.close();
  return { name, port: nextPort++, dir, identity, keys: await readServerKeys(dir), clock: { skew: 0 }, logs: [] };
}

async function start(net: Net, s: Server): Promise<Server> {
  s.store = await openServerStore(s.dir);
  stores.push(s.store);
  const log = (line: string) => s.logs.push(line);
  s.roster = await RosterStore.open(s.store, s.identity, { log });
  const roster = s.roster;
  s.prefs = await PrefsStore.open(s.store, { self: s.identity.memberId, now: () => Date.now() + s.clock.skew, knownWriter: (w) => roster.view.servers.has(w), log });
  s.gossip = new Gossip({ roster, prefs: s.prefs, log });
  const gossip = s.gossip;
  const self: LocalStatic = { memberId: s.identity.memberId, dhPub: s.identity.dhPub, dhKey: s.identity.dhKey };
  s.peers = new PeerSessions({
    roster, self, timers: TIMERS, log,
    onMessage: (session, message) => gossip.onMessage(session, message),
    sessionOpened: (session) => gossip.opened(session),
    sessionClosed: (session) => gossip.closed(session),
  }, { connector: net.connector(s.name) });
  net.routers.set(s.port, { name: s.name, router: new SessionRouter(deviceStub, s.peers) });
  running.push(s);
  gossip.start();
  s.peers.start();
  return s;
}

async function deviceKeysInfo(): Promise<MemberKeysInfo> {
  const k = await strangerKeys();
  return { memberId: k.memberId, sign: k.sign, dh: k.dh, signKey: k.signKey };
}

const ids = (s: Server) => s.roster!.gossipStatements().map((item) => item.id);
/** Every stored id (also what gossip does not carry). */
const stored = (s: Server) => s.roster!.statements().map((item) => item.id);
const digestOf = (s: Server) => rosterDigest(ids(s));
const sorted = (set: Iterable<string>) => [...set].sort();
const liveWith = (s: Server, other: Server) => s.peers!.states().find((p) => p.member === other.identity.memberId)?.state === "live";

/** Every server holds the same statements and preferences (and its acts have settled). */
async function converged(servers: Server[], timeout = 30_000): Promise<void> {
  await until(async () => {
    for (const s of servers) { await s.roster!.idle(); await s.prefs!.idle(); }
    const digests = await Promise.all(servers.map(digestOf));
    const prefs = await Promise.all(servers.map((s) => s.prefs!.digest()));
    return new Set(digests).size === 1 && new Set(prefs).size === 1 ? true : null;
  }, { timeout, every: 50, what: `convergence of ${servers.map((s) => s.name).join(", ")}` });
}

/** Endorse statements per (signer, member). */
function endorsements(s: Server): Map<string, number> {
  const out = new Map<string, number>();
  for (const { statement } of s.roster!.statements()) {
    if (statement.body.type !== "endorse") continue;
    const key = `${statement.body.by} ${statement.body.member}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** Each server endorsed every valid member it did not add, exactly once (and nothing twice). */
function checkEndorse(servers: Server[]): void {
  for (const s of servers) {
    const counts = endorsements(s);
    for (const [key, count] of counts) expect(count, `${s.name}: ${key} endorsed once`).toBe(1);
    for (const signer of servers) {
      const view = signer.roster!.view;
      const self = signer.identity.memberId;
      const added = new Set(signer.roster!.statements().flatMap(({ statement }) => (statement.body.type === "add" && statement.body.by === self ? [statement.body.member] : [])));
      for (const member of view.valid) {
        if (member === self || added.has(member)) continue;
        expect(counts.get(`${self} ${member}`) ?? 0, `${signer.name} endorsed ${member} (seen at ${s.name})`).toBe(1);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------

describe("M3 step 5: roster and preference gossip (stand-in for the Roster server-pairing gate)", () => {
  it("property: random statement sets split over 3 servers, random sessions, partitions and drops → one digest, root, valid set and preferences; a revoked device never valid again", async () => {
    const report: string[] = [];
    for (const seed of SEEDS) {
      const r = rng(seed);
      const net = new Net();
      const servers = await Promise.all(["A", "B", "C"].map(makeServer));
      const [A, B, C] = servers;
      for (const s of servers) s.clock.skew = r.int(400) - 200;
      const cl = await makeCluster(servers.map((s) => s.keys));
      const cluster = cl.clusterId;
      const base: StoredStatement[] = [...cl.statements];
      for (const s of servers) base.push(await profile(cluster, s.keys, s.keys, s.port));

      // Extra servers D (joined through a random running server) and E (joined through D), devices added by any of
      // them, device revocations by any known server, maybe the root's revocation of D with a random cascade.
      const D = await deviceKeysInfo();
      const E = await deviceKeysInfo();
      const through = r.pick(servers).keys;
      const serverAdd = (member: MemberKeysInfo, by: MemberKeysInfo, joined: boolean) => sign({ type: "add", cluster, member: member.memberId, kind: "server", keys: { sign: member.sign, dh: member.dh }, name: `srv ${member.memberId.slice(0, 4)}`, by: by.memberId, at: 1_700_000_000_000, joined }, by);
      const deviceAdd = (member: MemberKeysInfo, by: MemberKeysInfo) => sign({ type: "add", cluster, member: member.memberId, kind: "device", keys: { sign: member.sign, dh: member.dh }, name: `dev ${member.memberId.slice(0, 4)}`, scope: ["read"], by: by.memberId, at: 1_700_000_000_000 }, by);
      const extras: StoredStatement[] = [
        await serverAdd(D, through, true), await serverAdd(through, D, false),
        await serverAdd(E, D, true), await serverAdd(D, E, false),
        await profile(cluster, D, D, 1),
      ];
      const signers = [...servers.map((s) => s.keys), D, E];
      const devices: MemberKeysInfo[] = [];
      for (let i = 0; i < 6; i++) {
        const d = await deviceKeysInfo();
        devices.push(d);
        extras.push(await deviceAdd(d, r.pick(signers)));
        if (r.chance(0.4)) { const by = r.pick(signers); extras.push(await sign({ type: "revoke", cluster, member: d.memberId, reason: "test", by: by.memberId, gen: 1, cascade: false }, by)); }
      }
      if (r.chance(0.6)) extras.push(await sign({ type: "revoke", cluster, member: D.memberId, reason: "test", by: A.keys.memberId, gen: 1, cascade: r.chance(0.5) }, A.keys));
      // Never stored anywhere: what a stranger signed (it names a fake server), and a bad signature of a real body.
      const stranger = await deviceKeysInfo();
      const junk: StoredStatement[] = [
        await serverAdd(await deviceKeysInfo(), stranger, true),
        await deviceAdd(await deviceKeysInfo(), stranger),
        await profile(cluster, A.keys, stranger, 9),
      ];
      const real = await deviceAdd(await deviceKeysInfo(), B.keys);
      const forged: StoredStatement = { id: real.id, statement: { ...real.statement, sig: toBase64Url(new Uint8Array(64).fill(3)) } as SignedStatement };
      const junkIds = new Set([...junk.map((j) => j.id), forged.id]);

      // Split: every base statement everywhere; each extra (and junk) in a random non-empty subset.
      const split = new Map<Server, StoredStatement[]>(servers.map((s) => [s, [...base]]));
      for (const item of [...extras, ...junk, forged]) {
        const holders = servers.filter(() => r.chance(0.5));
        for (const s of holders.length ? holders : [r.pick(servers)]) split.get(s)!.push(item);
      }
      for (const s of servers) writeStatements(s.dir, cluster, split.get(s)!);

      // Start in a random order with random links blocked.
      for (const [x, y] of [[A, B], [B, C], [A, C]] as const) if (r.chance(0.5)) net.block(x.name, y.name);
      for (const s of [...servers].sort(() => r.next() - 0.5)) await start(net, s);

      const prefsWritten: PrefRow[] = [];
      const everRevoked = new Map<Server, Set<string>>(servers.map((s) => [s, new Set()]));
      const check = () => {
        for (const s of servers) {
          const view = s.roster!.view;
          const seen = everRevoked.get(s)!;
          for (const d of view.revoked) if (!view.servers.has(d)) seen.add(d);
          for (const d of seen) expect(view.valid.has(d), `seed ${seed}: ${s.name} found ${d} revoked earlier`).toBe(false);
          // Junk written straight into a server's db is stored there (as in step 3), but gossip never relays it.
          if (!split.get(s)!.some((item) => junkIds.has(item.id))) for (const id of stored(s)) expect(junkIds.has(id), `seed ${seed}: junk at ${s.name}`).toBe(false);
          for (const [key, count] of endorsements(s)) expect(count, `seed ${seed}: ${key}`).toBe(1);
        }
      };
      const acted = { pair: 0, revoke: 0, prefs: 0, drops: 0, blocks: 0 };
      for (let step = 0; step < STEPS; step++) {
        const action = r.int(10);
        const [x, y] = [r.pick(servers), r.pick(servers)];
        try {
          if (action <= 1 && x !== y) { net.block(x.name, y.name); acted.blocks++; }
          else if (action === 2) net.heal();
          else if (action === 3 && x !== y) { if (net.dropOn(x.name, y.name)) acted.drops++; }
          else if (action === 4) {
            const d = await deviceKeysInfo();
            devices.push(d);
            await x.roster!.addDevice({ keys: { sign: d.sign, dh: d.dh }, name: "phone" });
            acted.pair++;
          } else if (action === 5) {
            const known = devices.filter((d) => x.roster!.view.members.get(d.memberId)?.kind === "device" && x.roster!.view.valid.has(d.memberId));
            if (known.length) { await x.roster!.revokeDevice(r.pick(known).memberId); acted.revoke++; }
          } else if (action <= 7) {
            prefsWritten.push(await x.prefs!.set(r.pick(["language", "theme", "followedBots", "designatedServer"]), r.chance(0.1) ? null : { v: r.int(1000), by: x.name }));
            acted.prefs++;
          }
        } catch { /* an act refused here (a device this server cannot revoke yet) */ }
        await sleep(5 + r.int(40));
        check();
      }
      net.heal();
      await converged(servers);
      check();
      // Same digest, root, valid and revoked sets on every server.
      const views = servers.map((s) => s.roster!.view);
      for (const view of views.slice(1)) {
        expect(view.root?.id).toBe(views[0]!.root?.id);
        expect(sorted(view.valid)).toEqual(sorted(views[0]!.valid));
        expect(sorted(view.revoked)).toEqual(sorted(views[0]!.revoked));
        expect([...view.countingRevokes]).toEqual([...views[0]!.countingRevokes]);
      }
      // The same validity as a fresh evaluation of the union (independent of the order things arrived in).
      const union = new Map<string, StoredStatement>();
      for (const s of servers) for (const item of s.roster!.statements()) union.set(item.id, item);
      const fresh = computeRoster(A.identity.memberId, cluster, await verifyStatements(union.values(), { memberId: A.identity.memberId, signPub: A.keys.sign }));
      expect(sorted(fresh.valid)).toEqual(sorted(views[0]!.valid));
      // Every legitimate statement arrived everywhere; no junk anywhere.
      const held = new Set(ids(A));
      for (const item of [...base, ...extras]) expect(held.has(item.id), `seed ${seed}: ${item.statement.body.type} reached A`).toBe(true);
      for (const s of servers) {
        const direct = new Set(split.get(s)!.map((item) => item.id));
        for (const j of [...junk, forged]) if (!direct.has(j.id)) expect(stored(s).includes(j.id), `seed ${seed}: junk relayed to ${s.name}`).toBe(false);
      }
      // A forged copy may be stored only by the server it was written to directly (step 3 rule for writeStatements), never relayed.
      // Revoked devices are revoked everywhere; Endorse once per member per server.
      for (const s of servers) for (const d of everRevoked.get(s)!) expect(views[0]!.revoked.has(d)).toBe(true);
      checkEndorse(servers);
      // Preferences: each key's (hlc, writer) maximum of everything written.
      const expected = [...mergePrefs([], prefsWritten).values()].sort((a, b) => (a.key < b.key ? -1 : 1));
      for (const s of servers) expect(s.prefs!.rows()).toEqual(expected);
      report.push(`seed ${seed}: ${union.size} statements, valid ${views[0]!.valid.size}, revoked ${views[0]!.revoked.size}, ${JSON.stringify(acted)}, drops observed ${net.drops}`);
      for (const s of running.splice(0)) { s.peers?.close(); s.gossip?.close(); }
      await sleep(30);
      for (const st of stores.splice(0)) await st.close().catch(() => undefined);
    }
    console.log(report.join("\n"));
  }, 240_000);

  it("a device paired on B is valid on A after one session; revoked on A it is refused by a connected B at once, and by a partitioned B at the next session", async () => {
    const net = new Net();
    const servers = await Promise.all(["A", "B"].map(makeServer));
    const [A, B] = servers;
    const cl = await makeCluster(servers.map((s) => s.keys));
    const profiles = [await profile(cl.clusterId, A.keys, A.keys, A.port), await profile(cl.clusterId, B.keys, B.keys, B.port)];
    for (const s of servers) writeStatements(s.dir, cl.clusterId, [...cl.statements, ...profiles]);
    net.block("A", "B");
    for (const s of servers) await start(net, s);
    const d = await deviceKeysInfo();
    await B.roster!.addDevice({ keys: { sign: d.sign, dh: d.dh }, name: "phone" });
    expect(B.roster!.isValid(d.memberId)).toBe(true);
    await sleep(200);
    expect(A.roster!.isValid(d.memberId)).toBe(false);
    net.heal();
    await until(() => liveWith(A, B), { what: "A–B live" });
    await until(() => A.roster!.isValid(d.memberId), { what: "the device valid on A" });
    // Connected: A revokes, B refuses at once (the statement is pushed; B's listener ends the device's sessions).
    const invalidatedOnB: string[] = [];
    B.roster!.onChange((change) => invalidatedOnB.push(...change.invalidated));
    const before = Date.now();
    await A.roster!.revokeDevice(d.memberId);
    await until(() => !B.roster!.isValid(d.memberId), { timeout: 3_000, what: "the device refused on B" });
    expect(Date.now() - before).toBeLessThan(1_000);
    expect(invalidatedOnB).toContain(d.memberId);
    // Partitioned: a second device stays valid on B until the statement arrives at the next session.
    const d2 = await deviceKeysInfo();
    await B.roster!.addDevice({ keys: { sign: d2.sign, dh: d2.dh }, name: "phone 2" });
    await until(() => A.roster!.isValid(d2.memberId), { what: "d2 valid on A" });
    net.block("A", "B");
    await A.roster!.revokeDevice(d2.memberId);
    await sleep(TIMERS.deadMs);
    expect(B.roster!.isValid(d2.memberId)).toBe(true); // the honest limit (§4.6)
    net.heal();
    await until(() => !B.roster!.isValid(d2.memberId), { timeout: 10_000, what: "d2 refused on B after the partition" });
    await converged(servers);
    checkEndorse(servers);
  }, 60_000);

  it("a third server learned only through gossip is dialled, and its peers converge", async () => {
    const net = new Net();
    const servers = await Promise.all(["A", "B", "C"].map(makeServer));
    const [A, B, C] = servers;
    const cl = await makeCluster([A.keys, B.keys]);
    const cluster = cl.clusterId;
    const pa = await profile(cluster, A.keys, A.keys, A.port);
    const pb = await profile(cluster, B.keys, B.keys, B.port);
    const pc = await profile(cluster, C.keys, C.keys, C.port);
    // C joined through A only (A's joining Add, C's write-back): B knows nothing of C, C nothing of B.
    const addC = await sign({ type: "add", cluster, member: C.keys.memberId, kind: "server", keys: { sign: C.keys.sign, dh: C.keys.dh }, name: "C", by: A.keys.memberId, at: 1, joined: true }, A.keys);
    const backA = await sign({ type: "add", cluster, member: A.keys.memberId, kind: "server", keys: { sign: A.keys.sign, dh: A.keys.dh }, name: "A", by: C.keys.memberId, at: 1, joined: false }, C.keys);
    writeStatements(A.dir, cluster, [...cl.statements, pa, pb, addC, backA, pc]);
    writeStatements(B.dir, cluster, [...cl.statements, pa, pb]);
    writeStatements(C.dir, cluster, [cl.root, addC, backA, pa, pc]);
    for (const s of servers) await start(net, s);
    await until(() => liveWith(B, C) && liveWith(C, B), { timeout: 15_000, what: "B and C live with each other" });
    await converged(servers);
    expect(B.logs.some((line) => line.includes(`peer ${C.identity.memberId}: live`))).toBe(true);
    for (const s of servers) expect(sorted(s.roster!.view.valid)).toEqual(sorted([A, B, C].map((x) => x.identity.memberId)));
    checkEndorse(servers);
  }, 60_000);

  it("only what verifies and a known server signed is stored; an Endorse may come before its Add in one set; a refused statement is asked for again after a change; an oversize set ends the session", async () => {
    const servers = await Promise.all(["A", "B"].map(makeServer));
    const [A, B] = servers;
    const cl = await makeCluster(servers.map((s) => s.keys));
    const addresses = [await profile(cl.clusterId, A.keys, A.keys, A.port), await profile(cl.clusterId, B.keys, B.keys, B.port)];
    for (const s of servers) writeStatements(s.dir, cl.clusterId, [...cl.statements, ...addresses]);
    const net = new Net();
    net.block("A", "B");
    for (const s of servers) await start(net, s);
    const cluster = cl.clusterId;
    const d = await deviceKeysInfo();
    const add = await sign({ type: "add", cluster, member: d.memberId, kind: "device", keys: { sign: d.sign, dh: d.dh }, name: "d", scope: ["read"], by: B.keys.memberId, at: 1 }, B.keys);
    const endorse = await sign({ type: "endorse", cluster, member: d.memberId, addId: add.id, by: A.keys.memberId }, A.keys);
    // A third server's Endorse arrives first, alone: its signer is unknown → refused, not stored.
    const X = await deviceKeysInfo();
    const xAdd = await sign({ type: "add", cluster, member: X.memberId, kind: "server", keys: { sign: X.sign, dh: X.dh }, name: "X", by: B.keys.memberId, at: 1, joined: true }, B.keys);
    const xEndorse = await sign({ type: "endorse", cluster, member: d.memberId, addId: add.id, by: X.memberId }, X);
    const first = await A.roster!.mergeGossip([xEndorse.statement]);
    expect(first).toEqual({ fresh: [], refused: [xEndorse.id] });
    // In one set, Endorse before its Add: both stored.
    const second = await A.roster!.mergeGossip([endorse.statement, add.statement]);
    expect(sorted(second.fresh)).toEqual(sorted([endorse.id, add.id]));
    expect(A.roster!.isValid(d.memberId)).toBe(true);
    // Bad signatures and strangers' statements are never stored.
    const bad = { ...xAdd.statement, sig: toBase64Url(new Uint8Array(64).fill(1)) };
    const strangerProfile = await profile(cluster, A.keys, X, 1); // X is not known to A yet
    expect((await A.roster!.mergeGossip([bad, strangerProfile.statement])).fresh).toEqual([]);
    // Over the wire: B holds xEndorse and xAdd; A refuses xEndorse until it has xAdd (which B's change pushes).
    await B.roster!.mergeGossip([add.statement, xEndorse.statement]); // refused at B too (X unknown)
    expect(B.roster!.statementsById([xEndorse.id])).toEqual([]);
    net.heal();
    await until(() => liveWith(A, B), { what: "live" });
    await converged(servers);
    await B.roster!.mergeGossip([xAdd.statement, xEndorse.statement]);
    await converged(servers);
    expect(A.roster!.statementsById([xAdd.id, xEndorse.id])).toHaveLength(2);
    expect(A.roster!.view.servers.has(X.memberId)).toBe(true);

    // An oversize set ends the session with bye{too-large}: a peer that keeps sending full chunks. The two sessions are looked up
    // again for each try: on a loaded runner the pair's session can end first for another reason (a duplicate dial resolved by
    // "one session per pair", or `bye dead` after a stall), and then the next live session gets the oversize set (ubuntu CI, 2026-11-19).
    const full = Array.from({ length: STATEMENTS_PER_FRAME }, () => add.statement);
    const tooLarge = () => B.logs.some((line) => /too-large/.test(line)) || A.logs.some((line) => /too-large/.test(line));
    for (let attempt = 0; attempt < 3 && !tooLarge(); attempt++) {
      await until(() => liveWith(A, B) && liveWith(B, A), { timeout: 10_000, what: "A and B live before the oversize set" });
      const session = A.peers!.session(B.identity.memberId);
      const target = B.peers!.session(A.identity.memberId);
      if (!session || !target) continue;
      for (let sent = 0; sent <= MAX_GOSSIP_SET; sent += STATEMENTS_PER_FRAME) if (!session.sendWire({ t: "roster.statements", statements: full } as WireMessage)) break;
      await until(() => target.state === "closed", { timeout: 10_000, what: "B ends the session" });
    }
    if (!tooLarge()) throw new Error(`no bye{too-large} in either log; B's last lines:\n${B.logs.slice(-10).join("\n")}\nA's last lines:\n${A.logs.slice(-10).join("\n")}`);
  }, 90_000);

  it("what this side could not take is not asked for again in a loop, and is asked for again after its next roster change", async () => {
    const servers = await Promise.all(["A", "B"].map(makeServer));
    const [A, B] = servers;
    const cl = await makeCluster(servers.map((s) => s.keys));
    const addresses = [await profile(cl.clusterId, A.keys, A.keys, A.port), await profile(cl.clusterId, B.keys, B.keys, B.port)];
    for (const s of servers) writeStatements(s.dir, cl.clusterId, [...cl.statements, ...addresses]);
    const net = new Net();
    net.block("A", "B");
    for (const s of servers) await start(net, s);
    const d = await deviceKeysInfo();
    const add = await sign({ type: "add", cluster: cl.clusterId, member: d.memberId, kind: "device", keys: { sign: d.sign, dh: d.dh }, name: "d", scope: ["read"], by: B.keys.memberId, at: 1 }, B.keys);
    await B.roster!.mergeGossip([add.statement]);
    // A cannot take the device's Add the first time it arrives (as if it failed a rule there).
    const real = A.roster!.mergeGossip.bind(A.roster!);
    let refusedOnce = false;
    A.roster!.mergeGossip = async (statements, limit) => {
      const ids = await Promise.all(statements.map((statement) => statementId((statement as { body: never }).body)));
      if (!refusedOnce && ids.includes(add.id)) { refusedOnce = true; return { fresh: [], refused: ids }; }
      return real(statements, limit);
    };
    net.heal();
    await until(() => liveWith(A, B) && refusedOnce, { what: "the Add refused once at A" });
    await sleep(600);
    expect(A.gossip!.stats.refused).toBe(1); // not asked for again while nothing changed (no loop)
    expect(A.roster!.isValid(d.memberId)).toBe(false);
    // A's next change (a newer address Profile of its own): it asks B again and takes the Add.
    const newer = await profile(cl.clusterId, A.keys, A.keys, A.port, Date.now() + 1_000);
    expect((await real([newer.statement])).fresh).toEqual([newer.id]);
    await converged(servers);
    expect(A.roster!.isValid(d.memberId)).toBe(true);
  }, 60_000);
});
