// Botling 3 M4-26: cluster VAPID key replacement after a server revocation (Q-P3, protocol v1 §18.4).
// - Root mints a new VAPID key pair ordered by `(gen, id)` whenever a revoked server is missing from `covers`
//   or when a new root generation (`view.root.gen > 1`) takes over (`record.gen < view.root.gen`), retrying on disk
//   write errors and reconciling on `start()` and every roster change (F1, F2).
// - Distributes `vapid.key{gen, id, pub, priv}` ONLY over full peer sessions to valid servers (never to revoked
//   servers, never on exchange-only sessions).
// - Offline valid servers receive the current rotated key (`id >= 1`) when they open a full peer session with the root;
//   fresh joining servers receive `{ gen, id }` (`vapidId`) and `vapidCovers` alongside `vapid` in `join.welcome` (F4).
// - Receivers accept `vapid.key` ONLY from `view.root?.root` on an open full peer session, verify the P-256 pair
//   matches, and keep the key with the highest `(gen, id)` via `compareVapidKeyId`.
// - Remote `welcome` carries `{ vapidPublicKey, vapidId }` so devices move only forward (F3); local sessions omit both (F5).
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// M4-26 review: hooks run around ensureVapidKeys / rotateVapidKeys for F1/F4 tests. Pass-through while unset.
const vapidHooks = vi.hoisted(() => ({
  afterEnsure: null as null | ((dataDir: string) => void),
  beforeRotate: null as null | ((dataDir: string) => void),
}));
vi.mock("../../src/server/identity/vapid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/identity/vapid")>();
  return {
    ...actual,
    ensureVapidKeys: async (dataDir: string, options?: { gen?: number; covers?: readonly string[] }) => {
      const made = await actual.ensureVapidKeys(dataDir, options);
      vapidHooks.afterEnsure?.(dataDir);
      return made;
    },
    rotateVapidKeys: (dataDir: string, options?: { gen?: number; covers?: readonly string[] }) => {
      vapidHooks.beforeRotate?.(dataDir);
      return actual.rotateVapidKeys(dataDir, options);
    },
  };
});
import {
  compareVapidKeyId, decodeFrame, decodeWireFrame, encodeFrame, encodeWireFrame, FrameSplitter, fromBase64Url,
  packFrame, toBase64Url, type MessageOf, type VapidKeys,
} from "../../src/protocol";
import {
  acceptVapidKey, bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity,
  readVapidKeyRecord, readVapidKeys, rotateVapidKeys, vapidFilePath, writeVapidKeys,
  type ServerIdentity,
} from "../../src/server/identity";
import { RosterStore } from "../../src/server/roster";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { ServerJoin } from "../../src/server/pairing";
import {
  PeerSessions, SessionRouter, type AcceptedSession,
  type PeerConnection, type PeerConnector, type PeerTimers,
} from "../../src/server/peer";
import { PushSender, VapidKeySync, type PushTransport } from "../../src/server/push";
import { IntentRuntime } from "../../src/server/intents";
import { effectCheckpointSink } from "../../src/server/effects";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { RemoteSessions, SessionServer, slotAuthorize, type RemoteHost, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { generateDhKeyPair, SessionLink, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";
import { until } from "../helpers";
import {
  makeCluster, profile, readServerKeys, sign, writeStatements,
  type MemberKeysInfo, type Recovery,
} from "../support/peer-cluster";

const root = testRoot("push-rotate");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TIMERS: PeerTimers = { pingMs: 200, deadMs: 1_500, redialMinMs: 30, redialMaxMs: 200, revokedRedialMs: 1_000 };
const EPOCH = "0123456789abcdef0123456789abcdef";
const BOT = "6A0B0000-0000-4000-8000-000000000002";

function generateTestVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  const x = fromBase64Url(pubJwk.x)!;
  const y = fromBase64Url(pubJwk.y)!;
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);
  return { publicKey: toBase64Url(uncompressed), privateKey: privJwk.d };
}

class InMemoryPeerNet {
  readonly routers = new Map<number, SessionRouter>();
  readonly blocked = new Set<string>();

  connector(from: string): PeerConnector {
    return {
      connect: async (url) => {
        const port = Number(/:(\d+)\//.exec(url)?.[1]);
        const router = this.routers.get(port);
        if (!router || this.blocked.has(`${from}->${port}`)) throw new Error("connection refused");
        return this.pair(router);
      },
    };
  }

  pair(router: SessionRouter): PeerConnection {
    let open = true;
    let events: { frame(frame: Uint8Array): void; closed(): void } | null = null;
    const early: Array<() => void> = [];
    const toClient = (run: (e: { frame(frame: Uint8Array): void; closed(): void }) => void) =>
      setImmediate(() => { if (events) run(events); else early.push(() => run(events!)); });
    let accepted: AcceptedSession;
    const serverSide: SessionTransport = {
      send: (frame) => { if (open) { const copy = new Uint8Array(frame); toClient((e) => e.frame(copy)); } },
      close: () => { if (!open) return; open = false; setImmediate(() => accepted.transportClosed()); toClient((e) => e.closed()); },
    };
    accepted = router.accept(serverSide, "tailnet");
    return {
      send: (frame) => { if (open) { const copy = new Uint8Array(frame); setImmediate(() => { if (open) accepted.receive(copy); }); } },
      close: () => { if (!open) return; open = false; setImmediate(() => accepted.transportClosed()); toClient((e) => e.closed()); },
      bind: (bound) => { events = bound; for (const run of early.splice(0)) run(); },
    };
  }
}

interface Node {
  name: string;
  port: number;
  dir: string;
  identity: ServerIdentity;
  keys: MemberKeysInfo;
  store: ServerStore;
  roster: RosterStore;
  peers: PeerSessions;
  vapidSync: VapidKeySync;
  router: SessionRouter;
  logs: string[];
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vapidHooks.afterEnsure = null;
  vapidHooks.beforeRotate = null;
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

let seqDir = 0;
async function setupClusterNodes(
  net: InMemoryPeerNet,
  names: string[],
  options: { offline?: string[]; initialVapid?: VapidKeys; initialRecord?: { gen: number; id: number; covers?: string[] }; retryMs?: number } = {},
): Promise<{ recovery: Recovery; clusterId: string; recoveryCode: string; nodes: Node[] }> {
  const dirs = names.map((name) => join(root, `n${++seqDir}-${name}`));
  for (const d of dirs) mkdirSync(d, { recursive: true });
  const stores = await Promise.all(dirs.map((d) => openServerStore(d)));
  const identities = await Promise.all(dirs.map((d) => loadOrCreateServerIdentity(d, { create: true })));
  await Promise.all(stores.map((s, i) => s.submit((tx) => bindServerIdentity(tx, identities[i]!))));
  const keyInfos = await Promise.all(dirs.map((d) => readServerKeys(d)));

  const roster0 = await RosterStore.open(stores[0]!, identities[0]!);
  const setup0 = new ClusterSetup(roster0);
  const begun = await setup0.begin();
  const confirmed = await setup0.confirm(begun.code);
  expect(confirmed.ok).toBe(true);

  const clusterId = confirmed.ok ? confirmed.clusterId : "";
  const baseStatements = roster0.statements();
  const extra: Awaited<ReturnType<typeof sign>>[] = [];
  const basePort = 41_000 + seqDir * 10;
  for (let i = 0; i < names.length; i++) {
    for (let j = 0; j < names.length; j++) {
      if (i === j) continue;
      extra.push(await sign({
        type: "add",
        cluster: clusterId,
        member: keyInfos[j]!.memberId,
        kind: "server",
        keys: { sign: keyInfos[j]!.sign, dh: keyInfos[j]!.dh },
        name: names[j]!,
        by: keyInfos[i]!.memberId,
        at: 1_700_000_000_000,
        joined: true,
      }, keyInfos[i]!));
    }
    extra.push(await profile(clusterId, keyInfos[i]!, keyInfos[i]!, basePort + i));
  }
  const allStatements = [...baseStatements, ...extra];
  for (let i = 0; i < names.length; i++) {
    writeStatements(dirs[i]!, clusterId, allStatements);
    if (options.initialVapid) writeVapidKeys(dirs[i]!, options.initialVapid, options.initialRecord ?? { gen: 1, id: 0 });
  }

  const offline = new Set(options.offline ?? []);
  const nodes: Node[] = [];
  for (let i = 0; i < names.length; i++) {
    const logs: string[] = [];
    const port = basePort + i;
    const roster = await RosterStore.open(stores[i]!, identities[i]!, { log: (l) => logs.push(l) });
    let peers!: PeerSessions;
    const vapidSync = new VapidKeySync({
      dataDir: dirs[i]!,
      roster,
      sessions: () => peers.all,
      log: (l) => logs.push(l),
      retryMs: options.retryMs ?? 30,
    });
    peers = new PeerSessions({
      roster,
      self: { memberId: identities[i]!.memberId, dhPub: identities[i]!.dhPub, dhKey: identities[i]!.dhKey },
      timers: TIMERS,
      log: (l) => logs.push(l),
      onMessage: async (session, message) => vapidSync.onMessage(session, message),
      sessionOpened: (session) => { vapidSync.sessionOpened(session); },
    }, { connector: net.connector(names[i]!) });

    const router = new SessionRouter(
      { accept: (t) => ({ link: { established: Promise.reject(new Error("no device")) }, receive: () => t.close(), transportClosed: () => undefined }) },
      peers,
    );
    if (!offline.has(names[i]!)) {
      net.routers.set(port, router);
      peers.start();
      vapidSync.start();
    }

    const node: Node = {
      name: names[i]!,
      port,
      dir: dirs[i]!,
      identity: identities[i]!,
      keys: keyInfos[i]!,
      store: stores[i]!,
      roster,
      peers,
      vapidSync,
      router,
      logs,
    };
    nodes.push(node);
    cleanups.push(async () => {
      net.routers.delete(port);
      vapidSync.close();
      peers.close();
      await stores[i]!.close();
    });
  }

  const dummy = await makeCluster(keyInfos);
  return { recovery: dummy.recovery, clusterId, recoveryCode: begun.code, nodes };
}

describe("M4-26: protocol & vapid.key / welcome schemas", () => {
  it("round-trips vapid.key only for peer sender and rejects fe/server/malformed", () => {
    const keys = generateTestVapidKeys();
    const frame = { t: "vapid.key" as const, gen: 1, id: 1, pub: keys.publicKey, priv: keys.privateKey };

    const encoded = encodeWireFrame(frame, "peer", { local: false });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const decoded = decodeWireFrame(encoded.text, "peer", { local: false });
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.message).toEqual(frame);

    for (const sender of ["fe", "server"] as const) {
      const badRole = decodeWireFrame(JSON.stringify(frame), sender, { local: false });
      expect(badRole.ok).toBe(false);
      if (!badRole.ok) expect(badRole.reason).toBe("role");
    }

    expect(decodeWireFrame(JSON.stringify({ ...frame, gen: 0 }), "peer", { local: false }).ok).toBe(false);
    expect(decodeWireFrame(JSON.stringify({ ...frame, gen: -1 }), "peer", { local: false }).ok).toBe(false);
    expect(decodeWireFrame(JSON.stringify({ ...frame, id: 0 }), "peer", { local: false }).ok).toBe(false);
    expect(decodeWireFrame(JSON.stringify({ ...frame, id: -1 }), "peer", { local: false }).ok).toBe(false);
    expect(decodeWireFrame(JSON.stringify({ ...frame, pub: "not-a-p256-key" }), "peer", { local: false }).ok).toBe(false);
    expect(decodeWireFrame(JSON.stringify({ ...frame, extra: 1 }), "peer", { local: false }).ok).toBe(false);
  });

  it("allows optional vapidPublicKey and vapidId in welcome, and orders VapidKeyId lexicographically", () => {
    expect(compareVapidKeyId({ gen: 1, id: 99 }, { gen: 2, id: 1 })).toBeLessThan(0);
    expect(compareVapidKeyId({ gen: 2, id: 1 }, { gen: 1, id: 99 })).toBeGreaterThan(0);
    expect(compareVapidKeyId({ gen: 2, id: 1 }, { gen: 2, id: 2 })).toBeLessThan(0);
    expect(compareVapidKeyId({ gen: 2, id: 2 }, { gen: 2, id: 2 })).toBe(0);

    const keys = generateTestVapidKeys();
    const base = {
      t: "welcome" as const,
      serverId: "server-1",
      protocol: { min: 1, max: 1 },
      minFeVersion: "3.0.0",
      rosterDigest: null,
      servers: [{ id: "server-1", name: "Mac", state: "live" as const, since: null }],
      next: {},
      views: {},
    };
    const withoutKey = encodeFrame(base, "server", { local: false });
    expect(withoutKey.ok).toBe(true);
    const withKey = encodeFrame({ ...base, vapidPublicKey: keys.publicKey, vapidId: { gen: 2, id: 1 } }, "server", { local: false });
    expect(withKey.ok).toBe(true);
    if (withKey.ok) {
      const dec = decodeFrame(withKey.text, "server", { local: false });
      expect(dec.ok).toBe(true);
      if (dec.ok && dec.message.t === "welcome") {
        expect(dec.message.vapidPublicKey).toBe(keys.publicKey);
        expect(dec.message.vapidId).toEqual({ gen: 2, id: 1 });
      }
    }
  });
});

describe("M4-26: VAPID key storage & (gen, id) monotonic invariant", () => {
  it("reads legacy vapid-keys.json as (gen=0, id=0, covers=[]), rotates by (gen, id) + covers, and keeps highest (gen, id)", () => {
    const dir = join(root, `store-${++seqDir}`);
    mkdirSync(dir, { recursive: true });
    const initial = generateTestVapidKeys();
    writeFileSync(vapidFilePath(dir), `${JSON.stringify({ v: 1, ...initial })}\n`, { mode: 0o600 });

    const rec0 = readVapidKeyRecord(dir);
    expect(rec0).toEqual({ gen: 0, id: 0, covers: [], keys: initial });
    expect(readVapidKeys(dir)).toEqual(initial);

    const srvA = "a".repeat(26);
    const srvB = "b".repeat(26);
    const rot1 = rotateVapidKeys(dir, { gen: 1, covers: [srvA] });
    expect(rot1).toMatchObject({ gen: 1, id: 1, covers: [srvA] });
    expect(rot1.keys.publicKey).not.toBe(initial.publicKey);
    expect(readVapidKeyRecord(dir)).toEqual(rot1);
    expect(statSync(vapidFilePath(dir)).mode & 0o777).toBe(0o600);

    const rot2 = rotateVapidKeys(dir, { gen: 1, covers: [srvB, srvA] });
    expect(rot2).toMatchObject({ gen: 1, id: 2, covers: [srvA, srvB] });
    expect(rot2.keys.publicKey).not.toBe(rot1.keys.publicKey);

    // Same or lower (gen, id) is rejected; higher gen resets counter to 1 and still wins over higher id in lower gen.
    expect(acceptVapidKey(dir, { gen: 1, id: 2, pub: initial.publicKey, priv: initial.privateKey })).toMatchObject({ accepted: false, reason: "stale" });
    expect(acceptVapidKey(dir, { gen: 1, id: 1, pub: initial.publicKey, priv: initial.privateKey })).toMatchObject({ accepted: false, reason: "stale" });
    expect(acceptVapidKey(dir, { gen: 0, id: 99, pub: initial.publicKey, priv: initial.privateKey })).toMatchObject({ accepted: false, reason: "malformed" });

    const kGen2 = generateTestVapidKeys();
    expect(acceptVapidKey(dir, { gen: 2, id: 1, pub: kGen2.publicKey, priv: kGen2.privateKey })).toMatchObject({
      accepted: true,
      record: { gen: 2, id: 1, covers: [], keys: kGen2 },
    });
    // A lower-gen key with higher counter (1, 99) is stale against (2, 1).
    const kOldGen = generateTestVapidKeys();
    expect(acceptVapidKey(dir, { gen: 1, id: 99, pub: kOldGen.publicKey, priv: kOldGen.privateKey })).toMatchObject({ accepted: false, reason: "stale" });

    // Mismatched public/private key pair is rejected even with higher (gen, id).
    const kA = generateTestVapidKeys();
    const kB = generateTestVapidKeys();
    expect(acceptVapidKey(dir, { gen: 3, id: 1, pub: kA.publicKey, priv: kB.privateKey })).toMatchObject({ accepted: false, reason: "mismatch" });
    expect(readVapidKeyRecord(dir)).toMatchObject({ gen: 2, id: 1 });

    // Malformed id/gen/key is rejected.
    expect(acceptVapidKey(dir, { gen: 2, id: -1, pub: kA.publicKey, priv: kA.privateKey })).toMatchObject({ accepted: false, reason: "malformed" });
    expect(acceptVapidKey(dir, { gen: 2, id: 9.5, pub: kA.publicKey, priv: kA.privateKey })).toMatchObject({ accepted: false, reason: "malformed" });
    expect(acceptVapidKey(dir, { gen: 3, id: 1, pub: "bad", priv: kA.privateKey })).toMatchObject({ accepted: false, reason: "malformed" });
  });

  it("refuses symlinked vapid-keys.json on read and replaces symlink safely on write", () => {
    const dir = join(root, `sym-${++seqDir}`);
    mkdirSync(dir, { recursive: true });
    const decoy = join(dir, "decoy.json");
    const keys = generateTestVapidKeys();
    writeFileSync(decoy, `${JSON.stringify({ v: 1, gen: 1, id: 9, ...keys })}\n`, { mode: 0o600 });
    symlinkSync(decoy, vapidFilePath(dir));

    expect(readVapidKeyRecord(dir)).toBeNull();
    const rotated = rotateVapidKeys(dir, { gen: 1, covers: [] });
    expect(rotated.gen).toBe(1);
    expect(rotated.id).toBe(1);
    expect(JSON.parse(readFileSync(decoy, "utf8")).id).toBe(9);
  });

  it("propagates current vapidId across ServerJoin after prior key rotations (F4)", async () => {
    const sDir = join(root, `join-s-${++seqDir}`);
    const nDir = join(root, `join-n-${++seqDir}`);
    mkdirSync(sDir, { recursive: true, mode: 0o700 });
    mkdirSync(nDir, { recursive: true, mode: 0o700 });
    const sStore = await openServerStore(sDir);
    const nStore = await openServerStore(nDir);
    const sId = await loadOrCreateServerIdentity(sDir, { create: true });
    const nId = await loadOrCreateServerIdentity(nDir, { create: true });
    await sStore.submit((tx) => bindServerIdentity(tx, sId));
    await nStore.submit((tx) => bindServerIdentity(tx, nId));
    const sRoster = await RosterStore.open(sStore, sId);
    const nRoster = await RosterStore.open(nStore, nId);
    const setup = new ClusterSetup(sRoster);
    const begun = await setup.begin();
    expect((await setup.confirm(begun.code)).ok).toBe(true);

    // S rotated twice before N ever joined.
    rotateVapidKeys(sDir, { gen: 1, covers: [] });
    const rot2 = rotateVapidKeys(sDir, { gen: 1, covers: [] });
    expect(rot2).toMatchObject({ gen: 1, id: 2 });

    let nJoin!: ServerJoin;
    const connector: PeerConnector = {
      async connect(): Promise<PeerConnection> {
        let toS: { frame(frame: Uint8Array): void; closed(): void } | null = null;
        const early: Uint8Array[] = [];
        let closed = false;
        let acceptor: ReturnType<ServerJoin["accept"]> | null = null;
        const shut = () => {
          if (closed) return;
          closed = true;
          setImmediate(() => { acceptor?.transportClosed(); toS?.closed(); });
        };
        const nSide: SessionTransport = {
          send: (frame) => { if (!closed) setImmediate(() => { if (toS) toS.frame(frame); else early.push(frame); }); },
          close: shut,
        };
        return {
          send: (frame) => {
            if (closed) return;
            const copy = new Uint8Array(frame);
            setImmediate(() => {
              if (!acceptor) acceptor = nJoin.accept(nSide);
              acceptor.receive(copy);
            });
          },
          close: shut,
          bind: (bound) => { toS = bound; for (const f of early.splice(0)) bound.frame(f); },
        };
      },
    };

    nJoin = new ServerJoin({
      roster: nRoster, identity: nId, serverName: "N", version: "3.0.0", dataDir: nDir,
      log: () => undefined, ownAddresses: () => null, joinAddresses: () => ["ws://127.0.0.1:42001/v3/ws"],
    });
    const sJoin = new ServerJoin({
      roster: sRoster, identity: sId, serverName: "S", version: "3.0.0", dataDir: sDir,
      log: () => undefined, ownAddresses: () => null, joinAddresses: () => ["ws://127.0.0.1:42002/v3/ws"],
      connector,
    });
    cleanups.push(async () => {
      sJoin.close();
      nJoin.close();
      await nStore.close();
      await sStore.close();
    });

    // A third rotation lands between S's ensureVapidKeys and its join.welcome: N must get that pair with its (gen, id).
    let rot3: ReturnType<typeof rotateVapidKeys> | null = null;
    vapidHooks.afterEnsure = (dataDir) => { if (dataDir === sDir && !rot3) rot3 = rotateVapidKeys(sDir, { gen: 1, covers: [] }); };
    const offer = nJoin.createOffer();
    const added = await sJoin.addMachine(offer.link);
    const res = await sJoin.code(added.attempt, offer.code);
    expect(res.ok).toBe(true);
    expect(rot3).not.toBeNull();
    expect(rot3!.gen).toBe(1);
    expect(rot3!.id).toBe(3);
    expect(readVapidKeyRecord(nDir)).toEqual(rot3);
    expect(readVapidKeyRecord(nDir)).toEqual(readVapidKeyRecord(sDir));

    const oldKeys = generateTestVapidKeys();
    expect(acceptVapidKey(nDir, { gen: 1, id: 1, pub: oldKeys.publicKey, priv: oldKeys.privateKey })).toMatchObject({ accepted: false, reason: "stale" });
  });
});

describe("M4-26: root minting & encrypted peer distribution on server revocation", () => {
  it("rotates on revokeServer, sends vapid.key only to valid peers, catches up offline peers, and rejects non-root spoofs", async () => {
    const net = new InMemoryPeerNet();
    const initial = generateTestVapidKeys();
    const { nodes } = await setupClusterNodes(net, ["root", "good", "bad", "late"], {
      offline: ["late"],
      initialVapid: initial,
    });
    const [rootNode, goodNode, badNode, lateNode] = nodes as [Node, Node, Node, Node];

    await until(() =>
      rootNode.peers.session(goodNode.keys.memberId)?.state === "open" &&
      rootNode.peers.session(badNode.keys.memberId)?.state === "open" &&
      goodNode.peers.session(rootNode.keys.memberId)?.state === "open"
    , { what: "initial peer sessions open" });

    const rev = await rootNode.roster.revokeServer(badNode.keys.memberId, false, "stolen disk");
    expect(rev.already).toBe(false);

    const rootRec1 = readVapidKeyRecord(rootNode.dir);
    expect(rootRec1).toMatchObject({ gen: 1, id: 1, covers: [badNode.keys.memberId] });
    expect(rootRec1?.keys.publicKey).not.toBe(initial.publicKey);

    await until(() => readVapidKeyRecord(goodNode.dir)?.id === 1, { what: "good receives vapid.key (1, 1)" });
    expect(readVapidKeys(goodNode.dir)).toEqual(rootRec1!.keys);
    expect(readVapidKeyRecord(badNode.dir)).toEqual({ gen: 1, id: 0, covers: [], keys: initial });

    // Idempotent second call to revokeServer does NOT mint a second key.
    const revAgain = await rootNode.roster.revokeServer(badNode.keys.memberId, false, "stolen disk");
    expect(revAgain.already).toBe(true);
    expect(readVapidKeyRecord(rootNode.dir)?.id).toBe(1);

    net.routers.set(lateNode.port, lateNode.router);
    lateNode.peers.start();
    lateNode.vapidSync.start();

    await until(() => readVapidKeyRecord(lateNode.dir)?.id === 1, { what: "late catches up vapid.key (1, 1) on reconnect" });
    expect(readVapidKeys(lateNode.dir)).toEqual(rootRec1!.keys);

    // Spoof check: `late` (non-root) tries to send vapid.key{gen: 9, id: 99} to `good`.
    await until(() => lateNode.peers.session(goodNode.keys.memberId)?.state === "open", { what: "good <-> late open" });
    const spoof = generateTestVapidKeys();
    const sentSpoof = lateNode.peers.session(goodNode.keys.memberId)!.sendWire({
      t: "vapid.key",
      gen: 9,
      id: 99,
      pub: spoof.publicKey,
      priv: spoof.privateKey,
    });
    expect(sentSpoof).toBe(true);
    await until(() => goodNode.logs.some((l) => l.includes("non-root")), { what: "good logs non-root refusal" });
    expect(readVapidKeyRecord(goodNode.dir)).toMatchObject({ gen: 1, id: 1 });
    expect(readVapidKeys(goodNode.dir)).toEqual(rootRec1!.keys);

    const allLogs = nodes.flatMap((n) => n.logs).join("\n");
    expect(allLogs).not.toContain(initial.privateKey);
    expect(allLogs).not.toContain(rootRec1!.keys.privateKey);
    expect(allLogs).not.toContain(spoof.privateKey);
  });

  it("F1: retries a failed rotation via timer after ENOSPC without failing revokeServer or leaking secrets", async () => {
    const net = new InMemoryPeerNet();
    const initial = generateTestVapidKeys();
    const { nodes } = await setupClusterNodes(net, ["root", "good", "bad"], { initialVapid: initial, retryMs: 25 });
    const [rootNode, goodNode, badNode] = nodes as [Node, Node, Node];

    await until(() =>
      rootNode.peers.session(goodNode.keys.memberId)?.state === "open" &&
      goodNode.peers.session(rootNode.keys.memberId)?.state === "open"
    , { what: "sessions open before failed rotation" });

    let failOnce = true;
    vapidHooks.beforeRotate = (dir) => {
      if (dir === rootNode.dir && failOnce) {
        failOnce = false;
        throw Object.assign(new Error(`ENOSPC: no space left on ${initial.privateKey}`), { code: "ENOSPC" });
      }
    };

    const rev = await rootNode.roster.revokeServer(badNode.keys.memberId, false, "disk full test");
    expect(rev.already).toBe(false);
    // Right after the failed write, key was still old; retry timer recovers automatically.
    expect(rootNode.logs.some((l) => l.includes("vapid-keys.json") && l.includes("will retry"))).toBe(true);
    expect(rootNode.logs.join("\n")).not.toContain(initial.privateKey);

    await until(() => {
      const rec = readVapidKeyRecord(rootNode.dir);
      return rec?.gen === 1 && rec.id === 1 && rec.covers.includes(badNode.keys.memberId);
    }, { what: "retry timer rotates root vapid key after write error" });

    await until(() => {
      const rec = readVapidKeyRecord(goodNode.dir);
      return rec?.gen === 1 && rec.id === 1;
    }, { what: "good receives retried key from root" });
    expect(readVapidKeys(goodNode.dir)).toEqual(readVapidKeys(rootNode.dir));
  });

  it("F1: reconciles pre-existing or crash-interrupted uncovered revocations on VapidKeySync.start()", async () => {
    const net = new InMemoryPeerNet();
    const initial = generateTestVapidKeys();
    const { nodes } = await setupClusterNodes(net, ["root", "good", "bad"], { initialVapid: initial, retryMs: 60_000 });
    const [rootNode, goodNode, badNode] = nodes as [Node, Node, Node];

    await until(() =>
      rootNode.peers.session(goodNode.keys.memberId)?.state === "open" &&
      goodNode.peers.session(rootNode.keys.memberId)?.state === "open"
    , { what: "sessions open" });

    // Simulate process killed after revokeServer commit before rotation succeeds.
    vapidHooks.beforeRotate = (dir) => {
      if (dir === rootNode.dir) throw Object.assign(new Error("crash"), { code: "EACCES" });
    };
    await rootNode.roster.revokeServer(badNode.keys.memberId, false, "interrupted");
    expect(readVapidKeyRecord(rootNode.dir)).toEqual({ gen: 1, id: 0, covers: [], keys: initial });
    rootNode.vapidSync.close();

    // Restart VapidKeySync with healthy disk: start() alone detects the uncovered revocation and rotates.
    vapidHooks.beforeRotate = null;
    const restartedSync = new VapidKeySync({
      dataDir: rootNode.dir,
      roster: rootNode.roster,
      sessions: () => rootNode.peers.all,
      log: (l) => rootNode.logs.push(l),
    });
    cleanups.push(() => restartedSync.close());
    restartedSync.start();

    const rec = readVapidKeyRecord(rootNode.dir);
    expect(rec).toMatchObject({ gen: 1, id: 1, covers: [badNode.keys.memberId] });
    expect(rec?.keys.publicKey).not.toBe(initial.publicKey);
    await until(() => readVapidKeyRecord(goodNode.dir)?.id === 1, { what: "good receives key reconciled on start()" });
    expect(readVapidKeys(goodNode.dir)).toEqual(rec!.keys);
  });

  it("F2 case 1: new root that missed a prior (1, 1) rotation while offline mints (2, 1) on reroot and heals mid holding (1, 1)", async () => {
    const net = new InMemoryPeerNet();
    const initial = generateTestVapidKeys();
    const { recoveryCode, nodes } = await setupClusterNodes(net, ["root", "good", "mid", "late"], {
      offline: ["good"],
      initialVapid: initial,
    });
    const [rootNode, goodNode, midNode, lateNode] = nodes as [Node, Node, Node, Node];

    await until(() =>
      midNode.peers.session(rootNode.keys.memberId)?.state === "open"
    , { what: "root <-> mid open while good is offline" });

    // Root revokes `late`: root and mid advance to (1, 1). `good` stays offline on (1, 0).
    await rootNode.roster.revokeServer(lateNode.keys.memberId, false, "lost");
    await until(() => readVapidKeyRecord(midNode.dir)?.id === 1, { what: "mid holds (1, 1)" });
    const staleMidKey = readVapidKeys(midNode.dir)!;
    expect(readVapidKeyRecord(goodNode.dir)).toMatchObject({ gen: 1, id: 0 });

    // `root` vanishes; `good` comes back and reroots with oldRootLost=true -> gen 2, mints (2, 1) without seeing (1, 1).
    net.routers.delete(rootNode.port);
    rootNode.vapidSync.close();
    rootNode.peers.close();
    goodNode.vapidSync.start();
    const res = await goodNode.roster.reroot({ code: recoveryCode, oldRootLost: true, keep: [] });
    expect(res.gen).toBe(2);

    const goodRec = readVapidKeyRecord(goodNode.dir);
    expect(goodRec).toMatchObject({ gen: 2, id: 1 });
    expect(goodRec?.covers).toContain(rootNode.keys.memberId);
    expect(goodRec?.keys.publicKey).not.toBe(staleMidKey.publicKey);

    // Connect `good` and `mid`: `mid` accepts (2, 1) over its (1, 1) key.
    net.routers.set(goodNode.port, goodNode.router);
    goodNode.peers.start();
    await until(() => {
      const rec = readVapidKeyRecord(midNode.dir);
      return rec?.gen === 2 && rec.id === 1;
    }, { what: "mid replaces (1, 1) with new root's (2, 1)" });
    expect(readVapidKeys(midNode.dir)).toEqual(goodRec!.keys);
  });

  it("F2 case 2: reroot with oldRootLost=false always mints (2, 1) and heals split caused by stale old root", async () => {
    const net = new InMemoryPeerNet();
    const initial = generateTestVapidKeys();
    const { recoveryCode, nodes } = await setupClusterNodes(net, ["root", "good", "mid", "victim"], {
      offline: ["good"],
      initialVapid: initial,
    });
    const [rootNode, goodNode, midNode, victimNode] = nodes as [Node, Node, Node, Node];

    await until(() =>
      midNode.peers.session(rootNode.keys.memberId)?.state === "open"
    , { what: "root <-> mid open before partition" });

    // Partitioned `good` reroots with oldRootLost=false (0 revocations) -> MUST still mint a fresh key (2, 1).
    goodNode.vapidSync.start();
    const res = await goodNode.roster.reroot({ code: recoveryCode, oldRootLost: false, keep: [] });
    expect(res.gen).toBe(2);
    expect(res.revokeId).toBeNull();
    const rec21 = readVapidKeyRecord(goodNode.dir);
    expect(rec21).toMatchObject({ gen: 2, id: 1, covers: [] });
    expect(rec21?.keys.publicKey).not.toBe(initial.publicKey);

    // Before hearing Root{2}, stale `root` revokes `victim`, minting (1, 1) and pushing it to `mid`.
    await rootNode.roster.revokeServer(victimNode.keys.memberId, false, "stale root revoke");
    await until(() => readVapidKeyRecord(midNode.dir)?.id === 1, { what: "mid takes stale root (1, 1)" });
    const rootRec11 = readVapidKeyRecord(rootNode.dir)!;
    expect(rootRec11).toMatchObject({ gen: 1, id: 1 });

    // Partition heals: `good` connects to `mid` and `root`.
    // Both `mid` and `root` accept `good`'s (2, 1) over stale old root's (1, 1) and reject any stale gen 1 key.
    net.routers.set(goodNode.port, goodNode.router);
    goodNode.peers.start();
    await until(() => {
      const m = readVapidKeyRecord(midNode.dir);
      const r = readVapidKeyRecord(rootNode.dir);
      return m?.gen === 2 && m.id === 1 && r?.gen === 2 && r.id === 1;
    }, { what: "cluster heals split onto new root (2, 1) key" });

    expect(readVapidKeys(midNode.dir)).toEqual(rec21!.keys);
    expect(readVapidKeys(rootNode.dir)).toEqual(rec21!.keys);
    expect(acceptVapidKey(midNode.dir, { gen: 1, id: 99, pub: rootRec11.keys.publicKey, priv: rootRec11.keys.privateKey })).toMatchObject({ accepted: false, reason: "stale" });
  });

  it("F5: refuses non-root rotation and never sends vapid.key to revoked, exchange-only, or invalid-self sessions", () => {
    const dir = join(root, `sync-guard-${++seqDir}`);
    mkdirSync(dir, { recursive: true });
    const initial = generateTestVapidKeys();
    writeVapidKeys(dir, initial, { gen: 1, id: 0, covers: [] });

    const rootId = "a".repeat(26);
    const nonRootId = "b".repeat(26);
    const goodId = "c".repeat(26);
    const revokedId = "d".repeat(26);
    const validSet = new Set([rootId, nonRootId, goodId]);
    const view: import("../../src/server/roster").RosterView = {
      self: nonRootId,
      cluster: "0".repeat(32),
      root: { id: "r2", gen: 3, root: rootId, recoveryPub: "rec", keep: new Set() },
      servers: new Set([rootId, nonRootId, goodId, revokedId]),
      revoked: new Set([revokedId]),
      valid: (validSet),
      members: new Map(),
      countingRevokes: [],
      dropped: [],
    };
    const listeners = new Set<(c: import("../../src/server/roster").RosterChange) => void>();
    const sentGood: unknown[] = [];
    const sentRevoked: unknown[] = [];
    const sentExchange: unknown[] = [];
    const logs: string[] = [];

    const goodSession = { peer: goodId, state: "open", sendWire: (m: unknown) => { sentGood.push(m); return true; } };
    const revokedSession = { peer: revokedId, state: "open", sendWire: (m: unknown) => { sentRevoked.push(m); return true; } };
    const exchangeSession = { peer: goodId, state: "exchange", sendWire: (m: unknown) => { sentExchange.push(m); return true; } };

    let currentMember = nonRootId;
    const sync = new VapidKeySync({
      dataDir: dir,
      roster: {
        get memberId() { return currentMember; },
        get view() { return view; },
        onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      },
      sessions: () => [goodSession, revokedSession, exchangeSession],
      log: (l) => logs.push(l),
    });
    sync.start();

    // Non-root server MUST NOT rotate on start() or on roster change even with uncovered revocation & higher root gen.
    expect(readVapidKeyRecord(dir)).toEqual({ gen: 1, id: 0, covers: [], keys: initial });
    for (const fn of listeners) fn({ view, invalidated: ["revoked-1"] });
    expect(readVapidKeyRecord(dir)).toEqual({ gen: 1, id: 0, covers: [], keys: initial });
    expect(sentGood).toHaveLength(0);

    // Invalid/revoked root MUST NOT rotate either.
    currentMember = rootId;
    validSet.delete(rootId);
    for (const fn of listeners) fn({ view, invalidated: [] });
    expect(readVapidKeyRecord(dir)).toEqual({ gen: 1, id: 0, covers: [], keys: initial });

    // Valid root rotates once for uncovered revocation + gen 3, and sends ONLY to open valid peer session.
    validSet.add(rootId);
    for (const fn of listeners) fn({ view, invalidated: [revokedId] });
    expect(readVapidKeyRecord(dir)).toMatchObject({ gen: 3, id: 1, covers: [revokedId] });
    expect(sentGood).toHaveLength(1);
    expect(sentRevoked).toHaveLength(0);
    expect(sentExchange).toHaveLength(0);

    // Second unrelated roster change does NOT rotate again because revoked-1 is already in covers and gen matches.
    for (const fn of listeners) fn({ view, invalidated: [] });
    expect(readVapidKeyRecord(dir)).toMatchObject({ gen: 3, id: 1 });
    expect(sentGood).toHaveLength(1);

    // sessionOpened also refuses revoked and non-open sessions.
    sync.sessionOpened(revokedSession);
    sync.sessionOpened(exchangeSession);
    expect(sentRevoked).toHaveLength(0);
    expect(sentExchange).toHaveLength(0);

    sync.close();
  });
});

describe("M4-26: welcome vapidPublicKey/vapidId (remote only) & PushSender use rotated keys", () => {
  it("F3/F5: sends vapidPublicKey + vapidId on remote welcome, omits both on local session welcome, and PushSender signs with new key", async () => {
    const dir = join(root, `remote-${++seqDir}`);
    mkdirSync(dir, { recursive: true });
    const store = await openServerStore(dir);
    const identity = await loadOrCreateServerIdentity(dir, { create: true });
    const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
    const logs: string[] = [];
    const roster = await RosterStore.open(store, identity, { log: (l) => logs.push(l) });
    const setup = new ClusterSetup(roster);
    const begun = await setup.begin();
    expect((await setup.confirm(begun.code)).ok).toBe(true);

    const initial = generateTestVapidKeys();
    writeVapidKeys(dir, initial, { gen: 1, id: 0, covers: [] });

    const engine = new FakeTurnEngine({ bots: [BOT], chunks: ["ok"], chunkMs: 1 });
    const hub = new LogHub(store, { serverStreams: true });
    const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
    const runtime = new IntentRuntime({
      store, engine, hub, live, log: (l) => logs.push(l), authorize: slotAuthorize(roster),
      serverEvents: "all", mirrorBotUpdates: true,
    });
    await runtime.start();

    const deviceSign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const deviceSignPub = new Uint8Array(await crypto.subtle.exportKey("raw", deviceSign.publicKey));
    const deviceDh = await generateDhKeyPair();
    const { member: deviceId } = await roster.addDevice({
      name: "Phone",
      keys: { sign: toBase64Url(deviceSignPub), dh: toBase64Url(deviceDh.publicKey) },
      scope: ["read"],
    });

    const localToken = "local-token-0123456789";
    const sessionHost: SessionHost = {
      serverId,
      serverName: "TestMac",
      startedAt: Date.now(),
      minFeVersion: "3.0.0",
      token: () => localToken,
      hub,
      live,
      runtime,
      engine,
      content: null,
      shell: new ShellBridge(),
      nextFor: () => ({}),
      ensureBotStream: async () => false,
      log: (l) => logs.push(l),
      vapidKey: () => {
        const rec = readVapidKeyRecord(dir);
        return rec ? { publicKey: rec.keys.publicKey, id: { gen: rec.gen, id: rec.id } } : null;
      },
      vapidPublicKey: () => readVapidKeys(dir)?.publicKey ?? null,
    };

    const localSockPath = join(dir, "s.sock");
    const localServer = new SessionServer(localSockPath, sessionHost);
    await localServer.listen();

    const host: RemoteHost = {
      ...sessionHost,
      roster,
      self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey },
    };
    const remote = new RemoteSessions(host);
    cleanups.push(async () => {
      remote.close();
      await localServer.close();
      await runtime.close();
      live.close();
      hub.close();
      await store.close();
    });

    // F5: Local Unix socket session must omit both vapidPublicKey and vapidId from welcome.
    const localWelcome = await new Promise<{ message: MessageOf<"welcome">; raw: string }>((resolve, reject) => {
      const sock = connect(localSockPath);
      const splitter = new FrameSplitter();
      sock.on("error", reject);
      sock.on("data", (chunk) => {
        const split = splitter.push(new Uint8Array(chunk));
        if (!split.ok) { reject(new Error(split.detail)); return; }
        for (const frame of split.frames) {
          const text = new TextDecoder().decode(frame);
          const dec = decodeFrame(text, "server", { local: true });
          if (dec.ok && dec.message.t === "welcome") {
            sock.destroy();
            resolve({ message: dec.message, raw: text });
            return;
          }
        }
      });
      const hello = encodeFrame({
        t: "hello",
        deviceId: "desktop",
        feVersion: "3.0.0",
        protocol: 1,
        originEpoch: EPOCH,
        cursors: {},
        outbox: [],
        want: [],
        token: localToken,
      }, "fe", { local: true });
      if (!hello.ok) { reject(new Error(hello.detail)); return; }
      sock.on("connect", () => sock.write(packFrame(hello.text)));
    });
    expect(localWelcome.message.vapidPublicKey).toBeUndefined();
    expect(localWelcome.message.vapidId).toBeUndefined();
    expect(localWelcome.raw).not.toContain("vapidPublicKey");
    expect(localWelcome.raw).not.toContain("vapidId");

    async function attachOnce(): Promise<MessageOf<"welcome">> {
      let open = true;
      let clientLink!: SessionLink;
      let serverSession!: ReturnType<RemoteSessions["accept"]>;
      const serverTransport: SessionTransport = {
        send: (frame) => { if (open) { const copy = new Uint8Array(frame); setImmediate(() => clientLink.receive(copy)); } },
        close: () => { if (!open) return; open = false; setImmediate(() => clientLink.transportClosed()); },
      };
      const clientTransport: SessionTransport = {
        send: (frame) => { if (open) { const copy = new Uint8Array(frame); setImmediate(() => serverSession.receive(copy)); } },
        close: () => { if (!open) return; open = false; setImmediate(() => serverSession.transportClosed()); },
      };

      let welcomed: MessageOf<"welcome"> | null = null;
      clientLink = SessionLink.initiate(
        clientTransport,
        {
          mode: "ik",
          transport: "tailnet",
          cluster: roster.clusterId!,
          self: { memberId: deviceId, dhPub: deviceDh.publicKey, dhKey: deviceDh.privateKey },
          responder: { memberId, dhPub: identity.dhPub },
        },
        {
          onFrame: (bytes) => {
            const dec = decodeFrame(bytes, "server", { local: false });
            if (dec.ok && dec.message.t === "welcome") welcomed = dec.message;
          },
          onEnd: () => undefined,
        },
      );
      serverSession = remote.accept(serverTransport, "tailnet");
      await clientLink.established;
      const hello = encodeFrame({
        t: "hello",
        deviceId,
        feVersion: "3.0.0",
        protocol: 1,
        originEpoch: EPOCH,
        cursors: {},
        outbox: [],
        want: [],
      }, "fe", { local: false });
      if (!hello.ok) throw new Error(hello.detail);
      clientLink.send("control", new TextEncoder().encode(hello.text));
      await until(() => welcomed !== null, { what: "welcome frame" });
      clientLink.close();
      return welcomed!;
    }

    const w1 = await attachOnce();
    expect(w1.vapidPublicKey).toBe(initial.publicKey);
    expect(w1.vapidId).toEqual({ gen: 1, id: 0 });

    const rotated = rotateVapidKeys(dir, { gen: 1, covers: [] });
    const w2 = await attachOnce();
    expect(w2.vapidPublicKey).toBe(rotated.keys.publicKey);
    expect(w2.vapidId).toEqual({ gen: 1, id: 1 });
    expect(w2.vapidPublicKey).not.toBe(initial.publicKey);

    const subKeys = generateTestVapidKeys();
    await roster.writeProfile(deviceId, "push", JSON.stringify({
      endpoint: "https://push.example/sub/device1",
      keys: {
        p256dh: subKeys.publicKey,
        auth: toBase64Url(new Uint8Array(16).fill(7)),
      },
    }));

    const headersSeen: Record<string, string>[] = [];
    const transport: PushTransport = async (req) => {
      headersSeen.push(req.headers);
      return { status: 201, headers: {} };
    };
    const sender = new PushSender({ dataDir: dir, ownsBot: () => true, roster, transport, log: (l) => logs.push(l) });
    const report = await sender.notify({ botId: BOT, botName: "Helper" });
    expect(report.sent).toBe(1);
    expect(headersSeen[0]?.["Authorization"]).toContain(`k=${rotated.keys.publicKey}`);
  });
});
