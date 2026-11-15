// Botling 3 M4-26: cluster VAPID key replacement after a server revocation (Q-P3, protocol v1 §18.4).
// - Root mints a new VAPID key pair (`id = current + 1`) when it signs a server revocation (`revokeServer` or
//   `reroot` with `oldRootLost: true`), and distributes `vapid.key{id, pub, priv}` ONLY over full peer sessions to
//   valid servers (never to revoked servers, never on exchange-only sessions).
// - Offline valid servers receive the current rotated key when they open a full peer session with the root; fresh
//   joining servers receive `vapidId` alongside `vapid` in `join.welcome`.
// - Receivers accept `vapid.key` ONLY from `view.root?.root` on an open full peer session, verify the P-256 pair
//   matches, and keep the key with the highest `id` (rejecting stale/equal/mismatched keys).
// - Devices learn the current `vapidPublicKey` in `welcome`, and `PushSender` uses the rotated key on disk.
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// M4-26 review: a hook run right after ensureVapidKeys resolves on the sponsor, to land a rotation in the gap before
// the sponsor reads the key id for join.welcome. Pass-through while unset.
const vapidHooks = vi.hoisted(() => ({ afterEnsure: null as null | ((dataDir: string) => void) }));
vi.mock("../../src/server/identity/vapid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/identity/vapid")>();
  return {
    ...actual,
    ensureVapidKeys: async (dataDir: string) => {
      const made = await actual.ensureVapidKeys(dataDir);
      vapidHooks.afterEnsure?.(dataDir);
      return made;
    },
  };
});
import {
  decodeFrame, decodeWireFrame, encodeFrame, encodeWireFrame, fromBase64Url, toBase64Url,
  type MessageOf, type VapidKeys,
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
  addressesValue, PeerSessions, SessionRouter, type AcceptedSession,
  type PeerConnection, type PeerConnector, type PeerTimers,
} from "../../src/server/peer";
import { PushSender, VapidKeySync, type PushTransport } from "../../src/server/push";
import { IntentRuntime } from "../../src/server/intents";
import { effectCheckpointSink } from "../../src/server/effects";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { RemoteSessions, slotAuthorize, type RemoteHost } from "../../src/server/session";
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
  logs: string[];
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

let seqDir = 0;
async function setupClusterNodes(
  net: InMemoryPeerNet,
  names: string[],
  options: { offline?: string[]; initialVapid?: VapidKeys } = {},
): Promise<{ recovery: Recovery; clusterId: string; recoveryCode: string; nodes: Node[] }> {
  const dirs = names.map((name) => join(root, `n${++seqDir}-${name}`));
  for (const d of dirs) mkdirSync(d, { recursive: true });
  const stores = await Promise.all(dirs.map((d) => openServerStore(d)));
  const identities = await Promise.all(dirs.map((d) => loadOrCreateServerIdentity(d, { create: true })));
  await Promise.all(stores.map((s, i) => s.submit((tx) => bindServerIdentity(tx, identities[i]!))));
  const keyInfos = await Promise.all(dirs.map((d) => readServerKeys(d)));

  // Use a deterministic ClusterSetup on node 0 for recovery code support (needed for reroot test), or makeCluster.
  // Actually let's sign cluster statements using a real recovery key generated via ClusterSetup so reroot works too!
  const roster0 = await RosterStore.open(stores[0]!, identities[0]!);
  const setup0 = new ClusterSetup(roster0);
  const begun = await setup0.begin();
  const confirmed = await setup0.confirm(begun.code);
  expect(confirmed.ok).toBe(true);

  // Read Root{1} from node 0 and add all servers mutually.
  const clusterId = confirmed.ok ? confirmed.clusterId : "";
  const baseStatements = roster0.statements();
  // Add mutual server Adds and address Profiles for every node.
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
    if (options.initialVapid) writeVapidKeys(dirs[i]!, options.initialVapid);
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
    net.routers.set(port, router);

    if (!offline.has(names[i]!)) {
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

  // Dummy recovery object for signature compatibility when needed.
  const dummy = await makeCluster(keyInfos);
  return { recovery: dummy.recovery, clusterId, recoveryCode: begun.code, nodes };
}

describe("M4-26: protocol & vapid.key / welcome schemas", () => {
  it("round-trips vapid.key only for peer sender and rejects fe/server/malformed", () => {
    const keys = generateTestVapidKeys();
    const frame = { t: "vapid.key" as const, id: 1, pub: keys.publicKey, priv: keys.privateKey };

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

    const badId = decodeWireFrame(JSON.stringify({ ...frame, id: -1 }), "peer", { local: false });
    expect(badId.ok).toBe(false);
    const badPub = decodeWireFrame(JSON.stringify({ ...frame, pub: "not-a-p256-key" }), "peer", { local: false });
    expect(badPub.ok).toBe(false);
    const extraField = decodeWireFrame(JSON.stringify({ ...frame, extra: 1 }), "peer", { local: false });
    expect(extraField.ok).toBe(false);
  });

  it("allows optional vapidPublicKey in welcome", () => {
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
    const withKey = encodeFrame({ ...base, vapidPublicKey: keys.publicKey }, "server", { local: false });
    expect(withKey.ok).toBe(true);
    if (withKey.ok) {
      const dec = decodeFrame(withKey.text, "server", { local: false });
      expect(dec.ok).toBe(true);
      if (dec.ok && dec.message.t === "welcome") {
        expect(dec.message.vapidPublicKey).toBe(keys.publicKey);
      }
    }
  });
});

describe("M4-26: VAPID key storage & highest-id invariant", () => {
  it("reads legacy vapid-keys.json as id=0, rotates monotonically, and keeps highest id", () => {
    const dir = join(root, `store-${++seqDir}`);
    mkdirSync(dir, { recursive: true });
    const initial = generateTestVapidKeys();
    // Simulate pre-M4-26 vapid-keys.json without an `id` field.
    writeFileSync(vapidFilePath(dir), `${JSON.stringify({ v: 1, ...initial })}\n`, { mode: 0o600 });

    const rec0 = readVapidKeyRecord(dir);
    expect(rec0).toEqual({ id: 0, keys: initial });
    expect(readVapidKeys(dir)).toEqual(initial);

    const rot1 = rotateVapidKeys(dir);
    expect(rot1.id).toBe(1);
    expect(rot1.keys.publicKey).not.toBe(initial.publicKey);
    expect(rot1.keys.privateKey).not.toBe(initial.privateKey);
    expect(readVapidKeyRecord(dir)).toEqual(rot1);
    expect(readVapidKeys(dir)).toEqual(rot1.keys);
    expect(statSync(vapidFilePath(dir)).mode & 0o777).toBe(0o600);

    const rot2 = rotateVapidKeys(dir);
    expect(rot2.id).toBe(2);
    expect(rot2.keys.publicKey).not.toBe(rot1.keys.publicKey);

    // Equal or lower id is rejected; higher id wins.
    expect(acceptVapidKey(dir, { id: 2, pub: initial.publicKey, priv: initial.privateKey })).toMatchObject({ accepted: false, reason: "stale" });
    expect(acceptVapidKey(dir, { id: 1, pub: initial.publicKey, priv: initial.privateKey })).toMatchObject({ accepted: false, reason: "stale" });
    expect(readVapidKeys(dir)).toEqual(rot2.keys);

    // Mismatched public/private key pair is rejected even with higher id.
    const kA = generateTestVapidKeys();
    const kB = generateTestVapidKeys();
    expect(acceptVapidKey(dir, { id: 5, pub: kA.publicKey, priv: kB.privateKey })).toMatchObject({ accepted: false, reason: "mismatch" });
    expect(readVapidKeyRecord(dir)?.id).toBe(2);

    // Malformed id or key material is rejected.
    expect(acceptVapidKey(dir, { id: -1, pub: kA.publicKey, priv: kA.privateKey })).toMatchObject({ accepted: false, reason: "malformed" });
    expect(acceptVapidKey(dir, { id: 9.5, pub: kA.publicKey, priv: kA.privateKey })).toMatchObject({ accepted: false, reason: "malformed" });
    expect(acceptVapidKey(dir, { id: 9, pub: "bad", priv: kA.privateKey })).toMatchObject({ accepted: false, reason: "malformed" });

    // Matching pair with higher id is accepted.
    expect(acceptVapidKey(dir, { id: 5, pub: kA.publicKey, priv: kA.privateKey })).toMatchObject({ accepted: true, record: { id: 5, keys: kA } });
    expect(readVapidKeyRecord(dir)).toEqual({ id: 5, keys: kA });
  });

  it("refuses symlinked vapid-keys.json on read and replaces symlink safely on write", () => {
    const dir = join(root, `sym-${++seqDir}`);
    mkdirSync(dir, { recursive: true });
    const decoy = join(dir, "decoy.json");
    const keys = generateTestVapidKeys();
    writeFileSync(decoy, `${JSON.stringify({ v: 1, id: 9, ...keys })}\n`, { mode: 0o600 });
    symlinkSync(decoy, vapidFilePath(dir));

    expect(readVapidKeyRecord(dir)).toBeNull();
    const rotated = rotateVapidKeys(dir);
    expect(rotated.id).toBe(1);
    // Decoy file was not overwritten through the symlink; vapid-keys.json is now a regular file.
    expect(JSON.parse(readFileSync(decoy, "utf8")).id).toBe(9);
  });
});


  it("propagates current vapidId across ServerJoin after prior key rotations", async () => {
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
    rotateVapidKeys(sDir);
    const rot2 = rotateVapidKeys(sDir);
    expect(rot2.id).toBe(2);

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

    // A third rotation lands between S's ensureVapidKeys and its join.welcome: N must get that pair with its id,
    // never the old pair under the new id.
    let rot3: ReturnType<typeof rotateVapidKeys> | null = null;
    vapidHooks.afterEnsure = (dataDir) => { if (dataDir === sDir && !rot3) rot3 = rotateVapidKeys(sDir); };
    cleanups.push(() => { vapidHooks.afterEnsure = null; });
    const offer = nJoin.createOffer();
    const added = await sJoin.addMachine(offer.link);
    const res = await sJoin.code(added.attempt, offer.code);
    expect(res.ok).toBe(true);
    expect(rot3).not.toBeNull();
    expect(rot3!.id).toBe(3);
    expect(readVapidKeyRecord(nDir)).toEqual(rot3);
    expect(readVapidKeyRecord(nDir)).toEqual(readVapidKeyRecord(sDir));
    // Because N received id=3, a stale id=1 key is rejected.
    const oldKeys = generateTestVapidKeys();
    expect(acceptVapidKey(nDir, { id: 1, pub: oldKeys.publicKey, priv: oldKeys.privateKey })).toMatchObject({ accepted: false, reason: "stale" });
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

    // Wait for root <-> good and root <-> bad full sessions to open.
    await until(() =>
      rootNode.peers.session(goodNode.keys.memberId)?.state === "open" &&
      rootNode.peers.session(badNode.keys.memberId)?.state === "open" &&
      goodNode.peers.session(rootNode.keys.memberId)?.state === "open"
    , { what: "initial peer sessions open" });

    // Root revokes `bad`.
    const rev = await rootNode.roster.revokeServer(badNode.keys.memberId, false, "stolen disk");
    expect(rev.already).toBe(false);

    // Root rotated synchronously on commit.
    const rootRec1 = readVapidKeyRecord(rootNode.dir);
    expect(rootRec1?.id).toBe(1);
    expect(rootRec1?.keys.publicKey).not.toBe(initial.publicKey);

    // Valid peer `good` receives id=1 over its full encrypted session; `bad` NEVER receives it.
    await until(() => readVapidKeyRecord(goodNode.dir)?.id === 1, { what: "good receives vapid.key id=1" });
    expect(readVapidKeys(goodNode.dir)).toEqual(rootRec1!.keys);
    expect(readVapidKeyRecord(badNode.dir)).toEqual({ id: 0, keys: initial });

    // Idempotent second call to revokeServer does NOT mint a second key.
    const revAgain = await rootNode.roster.revokeServer(badNode.keys.memberId, false, "stolen disk");
    expect(revAgain.already).toBe(true);
    expect(readVapidKeyRecord(rootNode.dir)?.id).toBe(1);

    // Bring `late` online now: it was offline during the revocation, so on opening a full session with `root`,
    // it receives `vapid.key{id: 1}` automatically after `roster.revocations` sync.
    lateNode.peers.start();
    lateNode.vapidSync.start();

    await until(() => readVapidKeyRecord(lateNode.dir)?.id === 1, { what: "late catches up vapid.key id=1 on reconnect" });
    expect(readVapidKeys(lateNode.dir)).toEqual(rootRec1!.keys);

    // Spoof check: wait for `good` <-> `late` session, then `late` (non-root) tries to send vapid.key{id: 99} to `good`.
    await until(() => lateNode.peers.session(goodNode.keys.memberId)?.state === "open", { what: "good <-> late open" });
    const spoof = generateTestVapidKeys();
    const sentSpoof = lateNode.peers.session(goodNode.keys.memberId)!.sendWire({
      t: "vapid.key",
      id: 99,
      pub: spoof.publicKey,
      priv: spoof.privateKey,
    });
    expect(sentSpoof).toBe(true);
    await until(() => goodNode.logs.some((l) => l.includes("non-root")), { what: "good logs non-root refusal" });
    expect(readVapidKeyRecord(goodNode.dir)?.id).toBe(1);
    expect(readVapidKeys(goodNode.dir)).toEqual(rootRec1!.keys);

    // Secrets check: no logs ever contain private keys.
    const allLogs = nodes.flatMap((n) => n.logs).join("\n");
    expect(allLogs).not.toContain(initial.privateKey);
    expect(allLogs).not.toContain(rootRec1!.keys.privateKey);
    expect(allLogs).not.toContain(spoof.privateKey);
  });

  it("rotates and distributes when reroot signs Revoke{oldRoot} (oldRootLost: true)", async () => {
    const net = new InMemoryPeerNet();
    const initial = generateTestVapidKeys();
    const { recoveryCode, nodes } = await setupClusterNodes(net, ["root", "good", "late"], { initialVapid: initial });
    const [rootNode, goodNode, lateNode] = nodes as [Node, Node, Node];

    await until(() =>
      goodNode.peers.session(rootNode.keys.memberId)?.state === "open" &&
      goodNode.peers.session(lateNode.keys.memberId)?.state === "open"
    , { what: "sessions open before reroot" });

    // `good` reroots with oldRootLost=true -> becomes gen 2 root and signs Revoke{oldRoot}.
    const res = await goodNode.roster.reroot({ code: recoveryCode, oldRootLost: true, keep: [] });
    expect(res.gen).toBe(2);
    expect(res.revokeId).toBeTruthy();

    const goodRec = readVapidKeyRecord(goodNode.dir);
    expect(goodRec?.id).toBe(1);
    expect(goodRec?.keys.publicKey).not.toBe(initial.publicKey);

    await until(() => readVapidKeyRecord(lateNode.dir)?.id === 1, { what: "late accepts vapid.key from new root" });
    expect(readVapidKeys(lateNode.dir)).toEqual(goodRec!.keys);
    expect(readVapidKeyRecord(rootNode.dir)).toEqual({ id: 0, keys: initial });
  });

  it("never sends vapid.key to a revoked or exchange-only session even if still open, and refuses non-root rotation", () => {
    const dir = join(root, `sync-guard-${++seqDir}`);
    mkdirSync(dir, { recursive: true });
    writeVapidKeys(dir, generateTestVapidKeys(), 0);

    const view: import("../../src/server/roster").RosterView = {
      self: "root-1",
      cluster: "cluster-1",
      root: { id: "r1", gen: 1, root: "root-1", recoveryPub: "rec", keep: new Set() },
      servers: new Set(["root-1", "good-1", "revoked-1"]),
      revoked: new Set(["revoked-1"]),
      valid: new Set(["root-1", "good-1"]),
      members: new Map(),
      countingRevokes: [],
      dropped: [],
    };
    const listeners = new Set<(c: import("../../src/server/roster").RosterChange) => void>();
    const sentGood: unknown[] = [];
    const sentRevoked: unknown[] = [];
    const sentExchange: unknown[] = [];
    const logs: string[] = [];

    const goodSession = { peer: "good-1", state: "open", sendWire: (m: unknown) => { sentGood.push(m); return true; } };
    const revokedSession = { peer: "revoked-1", state: "open", sendWire: (m: unknown) => { sentRevoked.push(m); return true; } };
    const exchangeSession = { peer: "good-1", state: "exchange", sendWire: (m: unknown) => { sentExchange.push(m); return true; } };

    const sync = new VapidKeySync({
      dataDir: dir,
      roster: {
        memberId: "root-1",
        get view() { return view; },
        onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      },
      sessions: () => [goodSession, revokedSession, exchangeSession],
      log: (l) => logs.push(l),
    });
    sync.start();

    // Non-server-revocation roster change does not rotate.
    for (const fn of listeners) fn({ view, invalidated: [] });
    expect(readVapidKeyRecord(dir)?.id).toBe(0);
    expect(sentGood).toHaveLength(0);

    // Server revocation rotates once and sends ONLY to open valid peer session.
    for (const fn of listeners) fn({ view, invalidated: ["revoked-1"], serverRevokeSigned: true });
    expect(readVapidKeyRecord(dir)?.id).toBe(1);
    expect(sentGood).toHaveLength(1);
    expect(sentRevoked).toHaveLength(0);
    expect(sentExchange).toHaveLength(0);

    // sessionOpened also refuses revoked and non-open sessions.
    sync.sessionOpened(revokedSession);
    sync.sessionOpened(exchangeSession);
    expect(sentRevoked).toHaveLength(0);
    expect(sentExchange).toHaveLength(0);

    sync.close();
  });
});

describe("M4-26: welcome.vapidPublicKey & PushSender use rotated keys", () => {
  it("sends updated vapidPublicKey in welcome on re-attach and PushSender signs with the new key", async () => {
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
    writeVapidKeys(dir, initial);

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

    const host: RemoteHost = {
      serverId,
      serverName: "TestMac",
      startedAt: Date.now(),
      minFeVersion: "3.0.0",
      token: () => "",
      hub,
      live,
      runtime,
      engine,
      content: null,
      shell: new ShellBridge(),
      nextFor: () => ({}),
      ensureBotStream: async () => false,
      log: (l) => logs.push(l),
      roster,
      self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey },
      vapidPublicKey: () => readVapidKeys(dir)?.publicKey ?? null,
    };
    const remote = new RemoteSessions(host);
    cleanups.push(async () => {
      remote.close();
      await runtime.close();
      live.close();
      hub.close();
      await store.close();
    });

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

    // Rotate VAPID keys on disk (as happens on server revocation).
    const rotated = rotateVapidKeys(dir);
    const w2 = await attachOnce();
    expect(w2.vapidPublicKey).toBe(rotated.keys.publicKey);
    expect(w2.vapidPublicKey).not.toBe(initial.publicKey);

    // Subscribe the device and verify PushSender uses the new key immediately.
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
