// Botling 3 M4-18 (D70): the device learns every server it may attach to (dh + addresses on welcome.servers / peer,
// filled by session-core from roster + K12 Profiles, tracked in FeLink ServerView, persisted in device-store servers[]).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  decodeFrame, encodeFrame, fromBase64Url, memberIdFromKey, toBase64Url,
  type Message, type MessageOf, type ServerState,
} from "../../src/protocol";
import { FeLink, MemoryFeStorage, type ServerView } from "../../src/fe-link";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { effectCheckpointSink, ensureBot } from "../../src/server/effects";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { addressesValue } from "../../src/server/peer";
import { RosterStore } from "../../src/server/roster";
import { RemoteSessions, slotAuthorize, type RemoteHost, type SessionHost } from "../../src/server/session";
import type { SessionTables } from "../../src/server/session/session-core";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { importDhKeyPair, SessionLink, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { DEVICE_DB, loadDevice, saveDevice, saveDeviceServers, type DeviceRecord } from "../../web-v3/shell/device-store";
import { testRoot } from "../botlingd-harness";
import { until } from "../helpers";
import { FakeClock, FakeServer, flush, SERVER_ID } from "./fe-link-harness";

const REMOTE = { local: false } as const;
const EPOCH = "0123456789abcdef0123456789abcdef";
const BOT = "b1";

const root = testRoot("device-servers");
const stores: ServerStore[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const store of stores.splice(0)) await store.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dirSeq = 0;
function nextDir(): string {
  const dir = join(root, `s${++dirSeq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function makeServerIdentity(now = () => 1_000_000) {
  const dir = nextDir();
  const store = await openServerStore(dir);
  stores.push(store);
  const identity = await loadOrCreateServerIdentity(dir);
  await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity, { now });
  return { dir, store, identity, roster, setup: new ClusterSetup(roster) };
}

async function makeDeviceKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const rawDh = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const dhPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", rawDh.privateKey));
  const dh = await importDhKeyPair(dhPkcs8);
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const member = await memberIdFromKey(signPub);
  return { member, sign, signPub, dh, dhPkcs8, keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) } };
}

/** Minimal in-memory IDBFactory sufficient for device-store.ts (open, upgrade, strict-durability get/put, delete). */
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
        const storeNames = () => ({
          contains: (storeName: string) => dbData.stores.has(storeName),
        }) as DOMStringList;
        const db = {
          get objectStoreNames() { return storeNames(); },
          onversionchange: null as ((ev: IDBVersionChangeEvent) => void) | null,
          close() { /* noop */ },
          createObjectStore(storeName: string) {
            if (!dbData.stores.has(storeName)) dbData.stores.set(storeName, new Map());
            return {} as IDBObjectStore;
          },
          transaction(storeName: string | string[]) {
            const target = Array.isArray(storeName) ? storeName[0]! : storeName;
            let pending = 0;
            const doneOne = () => {
              pending -= 1;
              if (pending === 0) fire(tx.oncomplete);
            };
            const tx: {
              oncomplete: ((ev: Event) => void) | null;
              onerror: ((ev: Event) => void) | null;
              onabort: ((ev: Event) => void) | null;
              objectStore: (n: string) => IDBObjectStore;
            } = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore(n: string) {
                const map = dbData.stores.get(n ?? target);
                if (!map) throw new Error(`missing store ${n}`);
                return {
                  get(key: IDBValidKey) {
                    pending += 1;
                    return makeRequest<unknown>((getReq) => {
                      getReq.result = map.get(key);
                      getReq.onsuccess?.(new Event("idb"));
                      doneOne();
                    }) as unknown as IDBRequest;
                  },
                  put(value: unknown, key: IDBValidKey) {
                    pending += 1;
                    return makeRequest<IDBValidKey>((putReq) => {
                      map.set(key, value);
                      putReq.result = key;
                      putReq.onsuccess?.(new Event("idb"));
                      doneOne();
                    }) as unknown as IDBRequest;
                  },
                } as unknown as IDBObjectStore;
              },
            };
            return tx as unknown as IDBTransaction;
          },
        } as unknown as IDBDatabase;
        req.result = db;
        if (upgraded && req.onupgradeneeded) req.onupgradeneeded({ target: req } as unknown as IDBVersionChangeEvent);
        fire(req.onsuccess);
      }) as unknown as IDBOpenDBRequest;
    },
    deleteDatabase(name: string) {
      return makeRequest<undefined>((req) => {
        databases.delete(name);
        req.result = undefined;
        fire(req.onsuccess);
      }) as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

describe("M4-18 / D70: device learns every server's key and addresses", () => {
  it("protocol accepts optional dh and addresses on welcome.servers and peer (additive)", () => {
    const dh = toBase64Url(new Uint8Array(32).fill(7));
    const welcome = {
      t: "welcome",
      serverId: "a".repeat(26),
      protocol: { min: 1, max: 1 },
      minFeVersion: "3.0.0",
      rosterDigest: null,
      servers: [
        {
          id: "a".repeat(26),
          name: "Mac",
          state: "live",
          since: 100,
          dh,
          addresses: { tailnet: "wss://mac.example.invalid/v3/ws", relay: { url: "wss://relay.example.invalid/ws", room: "room1" } },
        },
        { id: "b".repeat(26), name: "Old", state: "stale", since: null },
      ],
      next: {},
      views: {},
    };
    const encWelcome = encodeFrame(welcome as Message, "server", REMOTE);
    expect(encWelcome.ok).toBe(true);
    if (!encWelcome.ok) return;
    const decWelcome = decodeFrame(encWelcome.text, "server", REMOTE);
    expect(decWelcome.ok).toBe(true);
    if (decWelcome.ok && decWelcome.message.t === "welcome") {
      expect(decWelcome.message.servers[0]).toMatchObject({
        dh,
        addresses: { tailnet: "wss://mac.example.invalid/v3/ws", relay: { url: "wss://relay.example.invalid/ws", room: "room1" } },
      });
    }

    const peerMsg = {
      t: "peer",
      serverId: "b".repeat(26),
      state: "live",
      since: 200,
      dh,
      addresses: { tailnet: "wss://linux.example.invalid:8443/v3/ws" },
    };
    const encPeer = encodeFrame(peerMsg as Message, "server", REMOTE);
    expect(encPeer.ok).toBe(true);
    if (!encPeer.ok) return;
    const decPeer = decodeFrame(encPeer.text, "server", REMOTE);
    expect(decPeer.ok).toBe(true);

    // Bad tailnet scheme (https instead of wss://.../v3/ws) is rejected by the protocol schema.
    const bad = {
      ...peerMsg,
      addresses: { tailnet: "https://linux.example.invalid" },
    };
    expect(decodeFrame(JSON.stringify(bad), "server", REMOTE).ok).toBe(false);
  });

  it("1 & 2. welcome and peer list valid servers with dh and K12 addresses, and revoked servers as gone with no addresses", async () => {
    let clock = 1_000;
    const tick = () => ++clock;
    const s1 = await makeServerIdentity(tick);
    const started = await s1.setup.begin();
    expect((await s1.setup.confirm(started.code)).ok).toBe(true);

    const s2 = await makeServerIdentity(tick);
    const addS2 = await s1.roster.addServer({ keys: s2.identity.keys, name: "Linux box" });
    const addS2Stmt = s1.roster.statements().find((item) => item.id === addS2.addId)!.statement;
    await s2.roster.joinCluster({
      add: addS2Stmt,
      roster: s1.roster.statements().map((item) => item.statement),
      sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "Mac Studio" },
    });

    const s3 = await makeServerIdentity(tick);
    const addS3 = await s1.roster.addServer({ keys: s3.identity.keys, name: "Temp box" });
    const addS3Stmt = s1.roster.statements().find((item) => item.id === addS3.addId)!.statement;
    await s3.roster.joinCluster({
      add: addS3Stmt,
      roster: s1.roster.statements().map((item) => item.statement),
      sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "Mac Studio" },
    });

    await s1.roster.writeProfile(
      s1.identity.memberId,
      "addresses",
      addressesValue(9001, { tailnet: "https://mac.example.invalid", relay: { url: "wss://relay.example.invalid/ws", room: "room-s1" } }),
    );
    await s2.roster.writeProfile(
      s2.identity.memberId,
      "addresses",
      addressesValue(9002, { tailnet: "https://linux.example.invalid", relay: { url: "wss://relay.example.invalid/ws", room: "room-s2" } }),
    );

    const phone = await makeDeviceKeys();
    await s1.roster.addDevice({ keys: phone.keys, name: "Phone", scope: ["read", "reply"] });

    const all = [...s1.roster.statements(), ...s2.roster.statements(), ...s3.roster.statements()].map((item) => item.statement);
    await s1.roster.merge(all);
    await s2.roster.merge(all);
    await s3.roster.merge(all);

    // K12: revoke s3, then let s3 sign a newer Profile for s2 (loopback/evil tailnet); s1 must ignore s3's Profile.
    await s1.roster.revokeServer(s3.identity.memberId, false, "retired");
    clock += 10_000;
    const forged = await s3.roster.writeProfile(
      s2.identity.memberId,
      "addresses",
      JSON.stringify({ tailnet: "wss://evil.example.invalid/v3/ws" }),
    );
    if (forged) await s1.roster.merge([forged]);

    const peerStates: Array<{ id: string; name: string; state: ServerState; since: number | null }> = [
      { id: s2.identity.memberId, name: "Linux box", state: "live", since: 2_000 },
      { id: s3.identity.memberId, name: "Temp box", state: "gone", since: 3_000 },
    ];
    const peerListeners = new Set<(peer: { id: string; state: ServerState; since: number | null }) => void>();
    const tables: SessionTables = {
      peers: () => peerStates,
      onPeer: (listener) => { peerListeners.add(listener); return () => { peerListeners.delete(listener); }; },
      isPeerTable: () => false,
      subscribe: () => ({ close() {} }),
    };

    const engine = new FakeTurnEngine({ bots: [BOT] });
    const hub = new LogHub(s1.store, { serverStreams: true });
    const live = new LiveChannel({ sink: effectCheckpointSink(s1.store), checkpointIntervalMs: 5 });
    const runtime = new IntentRuntime({
      store: s1.store, engine, hub, live, log: () => undefined,
      authorize: slotAuthorize(s1.roster), serverEvents: "all", mirrorBotUpdates: true,
    });
    await runtime.start();
    const shell = new ShellBridge();
    const base: SessionHost = {
      serverId: s1.identity.memberId,
      serverName: "Mac Studio",
      startedAt: 1_000,
      minFeVersion: "3.0.0",
      token: () => "t".repeat(32),
      hub, live, runtime, engine, content: null, shell,
      nextFor: () => ({}),
      ensureBotStream: async (botId) => { if (!engine.hasBot(botId)) return false; await s1.store.submit((tx) => { ensureBot(tx, botId); }); return true; },
      log: () => undefined,
      tables,
    };
    const host: RemoteHost = { ...base, roster: s1.roster, self: { memberId: s1.identity.memberId, dhPub: s1.identity.dhPub, dhKey: s1.identity.dhKey } };
    const remote = new RemoteSessions(host);
    cleanups.push(async () => {
      remote.close();
      await runtime.scope.submit(() => undefined);
      engine.close();
      runtime.close();
      shell.close();
      live.close();
      hub.close();
    });

    const dialPhone = async () => {
      const got: Message[] = [];
      let session!: ReturnType<RemoteSessions["accept"]>;
      const toDevice: SessionTransport = { send: (frame) => link.receive(frame), close: () => setTimeout(() => link.transportClosed(), 0) };
      session = remote.accept(toDevice, "memory");
      const toServer: SessionTransport = { send: (frame) => session.receive(frame), close: () => setTimeout(() => session.transportClosed(), 0) };
      const link = SessionLink.initiate(toServer, {
        mode: "ik", transport: "memory", cluster: s1.roster.clusterId!,
        self: { memberId: phone.member, dhPub: phone.dh.publicKey, dhKey: phone.dh.privateKey },
        responder: { memberId: s1.identity.memberId, dhPub: s1.identity.dhPub },
      }, {
        onFrame: (bytes) => {
          const decoded = decodeFrame(bytes, "server", REMOTE);
          if (decoded.ok) got.push(decoded.message);
        },
        onEnd: () => undefined,
      });
      await link.established;
      const encHello = encodeFrame({
        t: "hello", deviceId: phone.member, feVersion: "3.0.0", protocol: 1,
        originEpoch: EPOCH, cursors: {}, outbox: [], want: [],
      }, "fe", REMOTE);
      if (!encHello.ok) throw new Error(encHello.detail);
      link.send("control", new TextEncoder().encode(encHello.text));
      // The welcome arrives asynchronously (store reads, writer commits): wait for it, never assume one flush() is enough.
      await until(() => got.some((m) => m.t === "welcome"), { timeout: 10_000, what: "the welcome frame" });
      return { got, link, close: () => { link.close(); session.close(); } };
    };

    // Session 1: s1 + s2 are valid (with dh + tailnet/relay, no loopback, no forged s3 address); s3 is gone (no addresses).
    const first = await dialPhone();
    cleanups.push(() => first.close());
    const welcome1 = first.got.find((m): m is MessageOf<"welcome"> => m.t === "welcome");
    expect(welcome1).toBeDefined();
    expect(welcome1!.servers).toHaveLength(3);

    const selfEntry = welcome1!.servers.find((s) => s.id === s1.identity.memberId);
    expect(selfEntry).toEqual({
      id: s1.identity.memberId,
      name: "Mac Studio",
      state: "live",
      since: 1_000,
      dh: s1.identity.keys.dh,
      addresses: { tailnet: "wss://mac.example.invalid/v3/ws", relay: { url: "wss://relay.example.invalid/ws", room: "room-s1" } },
    });

    const s2Entry = welcome1!.servers.find((s) => s.id === s2.identity.memberId);
    expect(s2Entry).toEqual({
      id: s2.identity.memberId,
      name: "Linux box",
      state: "live",
      since: 2_000,
      dh: s2.identity.keys.dh,
      addresses: { tailnet: "wss://linux.example.invalid/v3/ws", relay: { url: "wss://relay.example.invalid/ws", room: "room-s2" } },
    });

    const s3Entry = welcome1!.servers.find((s) => s.id === s3.identity.memberId);
    expect(s3Entry).toEqual({
      id: s3.identity.memberId,
      name: "Temp box",
      state: "gone",
      since: 3_000,
      dh: s3.identity.keys.dh,
    });
    expect("addresses" in s3Entry!).toBe(false);

    // Live peer event when s2 becomes stale: still carries dh and addresses; when s2 is revoked -> gone with no addresses.
    const findPeer = (state: ServerState) => first.got.find((m): m is MessageOf<"peer"> => m.t === "peer" && m.serverId === s2.identity.memberId && m.state === state);
    for (const fn of peerListeners) fn({ id: s2.identity.memberId, state: "stale", since: 4_000 });
    const stalePeer = await until(() => findPeer("stale"), { timeout: 10_000, what: "the stale peer frame" });
    expect(stalePeer).toEqual({
      t: "peer",
      serverId: s2.identity.memberId,
      state: "stale",
      since: 4_000,
      dh: s2.identity.keys.dh,
      addresses: { tailnet: "wss://linux.example.invalid/v3/ws", relay: { url: "wss://relay.example.invalid/ws", room: "room-s2" } },
    });

    await s1.roster.revokeServer(s2.identity.memberId, false, "stolen");
    peerStates[0] = { id: s2.identity.memberId, name: "Linux box", state: "gone", since: 5_000 };
    for (const fn of peerListeners) fn({ id: s2.identity.memberId, state: "gone", since: 5_000 });
    const gonePeer = await until(() => findPeer("gone"), { timeout: 10_000, what: "the gone peer frame" });
    expect(gonePeer).toEqual({
      t: "peer",
      serverId: s2.identity.memberId,
      state: "gone",
      since: 5_000,
      dh: s2.identity.keys.dh,
    });
    expect("addresses" in gonePeer!).toBe(false);

    // Session 2 after revocation: welcome also lists s2 as gone with no addresses.
    const second = await dialPhone();
    cleanups.push(() => second.close());
    const welcome2 = second.got.find((m): m is MessageOf<"welcome"> => m.t === "welcome");
    const s2After = welcome2!.servers.find((s) => s.id === s2.identity.memberId);
    expect(s2After).toEqual({
      id: s2.identity.memberId,
      name: "Linux box",
      state: "gone",
      since: 5_000,
      dh: s2.identity.keys.dh,
    });
    expect("addresses" in s2After!).toBe(false);
  });

  it("FeLink stores dh and addresses in ServerView and clears addresses on gone", async () => {
    const server = new FakeServer();
    const dhA = toBase64Url(new Uint8Array(32).fill(1));
    const dhB = toBase64Url(new Uint8Array(32).fill(2));
    server.servers = [
      { id: SERVER_ID, name: "Studio", state: "live", since: 1, dh: dhA, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" } },
      { id: "srvB", name: "Linux", state: "live", since: 2, dh: dhB, addresses: { tailnet: "wss://linux.example.invalid/v3/ws", relay: { url: "wss://relay.example.invalid/ws", room: "r-b" } } },
    ];
    const link = await FeLink.open({ storage: new MemoryFeStorage(), dial: server.dial, deviceId: "phone", feVersion: "3.0.0", clock: new FakeClock(), local: true });
    cleanups.push(() => link.stop());
    link.start();
    await flush();

    expect(link.servers()).toEqual<ServerView[]>([
      { id: SERVER_ID, name: "Studio", state: "live", since: 1, self: true, dh: dhA, addresses: { tailnet: "wss://studio.example.invalid/v3/ws" } },
      { id: "srvB", name: "Linux", state: "live", since: 2, self: false, dh: dhB, addresses: { tailnet: "wss://linux.example.invalid/v3/ws", relay: { url: "wss://relay.example.invalid/ws", room: "r-b" } } },
    ]);

    // Peer update for srvB moving to gone clears addresses while preserving dh and name.
    server.send({ t: "peer", serverId: "srvB", state: "gone", since: 900 } as Message);
    await flush();
    const srvB = link.servers().find((s) => s.id === "srvB");
    expect(srvB).toEqual({ id: "srvB", name: "Linux", state: "gone", since: 900, self: false, dh: dhB });
    expect("addresses" in srvB!).toBe(false);
  });

  it("3. device-store saves servers[] merged by id and survives a reload", async () => {
    const idb = memoryIdb();
    const keys = await makeDeviceKeys();
    const serverA = "a".repeat(26);
    const serverB = "b".repeat(26);
    const dhA = toBase64Url(new Uint8Array(32).fill(11));
    const dhB = toBase64Url(new Uint8Array(32).fill(22));
    const dhPkcs8 = keys.dhPkcs8;

    const record: DeviceRecord = {
      v: 1,
      memberId: keys.member,
      name: "Phone",
      signKey: keys.sign.privateKey,
      signPub: keys.keys.sign,
      dhKey: keys.dh.privateKey,
      dhPub: keys.dh.publicKey,
      cluster: "c".repeat(32),
      server: { memberId: serverA, name: "Mac Studio", dhPub: new Uint8Array(32).fill(11) },
      addId: "d".repeat(64),
      scope: ["read", "reply"],
      pairedAt: 1000,
      relay: { url: "wss://relay.example.invalid/ws", room: "room-a" },
    };
    await saveDevice(record, dhPkcs8, idb);

    await saveDeviceServers([
      { id: serverA, name: "Mac Studio", state: "live", since: 10, dh: dhA, addresses: { tailnet: "wss://mac.example.invalid/v3/ws", relay: { url: "wss://relay.example.invalid/ws", room: "room-a" } } },
      { id: serverB, name: "Linux", state: "live", since: 20, dh: dhB, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" } },
    ], idb);

    // Reload: both servers and their dh/addresses are restored from IndexedDB.
    const reloaded = await loadDevice(idb);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.servers).toEqual([
      { id: serverA, name: "Mac Studio", state: "live", since: 10, dh: dhA, addresses: { tailnet: "wss://mac.example.invalid/v3/ws", relay: { url: "wss://relay.example.invalid/ws", room: "room-a" } } },
      { id: serverB, name: "Linux", state: "live", since: 20, dh: dhB, addresses: { tailnet: "wss://linux.example.invalid/v3/ws" } },
    ]);

    // Merge a peer update marking serverB gone: serverA stays intact, serverB loses addresses and keeps dh.
    await saveDeviceServers([{ id: serverB, name: "Linux", state: "gone", since: 50 }], idb);
    const afterRevoke = await loadDevice(idb);
    expect(afterRevoke!.servers).toEqual([
      { id: serverA, name: "Mac Studio", state: "live", since: 10, dh: dhA, addresses: { tailnet: "wss://mac.example.invalid/v3/ws", relay: { url: "wss://relay.example.invalid/ws", room: "room-a" } } },
      { id: serverB, name: "Linux", state: "gone", since: 50, dh: dhB },
    ]);
    expect("addresses" in afterRevoke!.servers![1]!).toBe(false);
  });

  it("4. an old-format DeviceRecord without servers[] still loads", async () => {
    const idb = memoryIdb();
    const keys = await makeDeviceKeys();
    const serverA = "a".repeat(26);
    const dhA = new Uint8Array(32).fill(33);
    const dhPkcs8 = keys.dhPkcs8;

    // Write a legacy M2/M3 record (no `servers` property in stored object).
    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, dhPkcs8));
    const legacyStored = {
      v: 1 as const,
      memberId: keys.member,
      name: "Old Phone",
      signKey: keys.sign.privateKey,
      signPub: keys.keys.sign,
      dhPub: keys.dh.publicKey,
      cluster: "c".repeat(32),
      server: { memberId: serverA, name: "Mac Studio", dhPub: dhA },
      addId: "e".repeat(64),
      scope: ["read"],
      pairedAt: 500,
      relay: { url: "wss://relay.example.invalid/ws", room: "room-legacy" },
      dhSeal: { key: aesKey, iv, data },
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DEVICE_DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("device")) req.result.createObjectStore("device"); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("device", "readwrite");
      tx.objectStore("device").put(legacyStored, "self");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const loaded = await loadDevice(idb);
    expect(loaded).not.toBeNull();
    expect(loaded!.memberId).toBe(keys.member);
    expect(loaded!.server).toEqual({ memberId: serverA, name: "Mac Studio", dhPub: dhA });
    expect(loaded!.relay).toEqual({ url: "wss://relay.example.invalid/ws", room: "room-legacy" });
    expect(loaded!.servers).toEqual([
      { id: serverA, name: "Mac Studio", dh: toBase64Url(dhA), addresses: { relay: { url: "wss://relay.example.invalid/ws", room: "room-legacy" } } },
    ]);
  });
});
