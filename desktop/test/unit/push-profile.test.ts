// Botling 3 M4-22: Profile `push` field and `push.subscribe` (protocol v1 §4.1, §18.4).
// - `Profile{device, field: "push", value}` and `push.subscribe` round-trip, respect the 2,000-char limit and
//   validate endpoints (https to a public host on the default port, never an IP literal or local zone) and P-256 /
//   16-byte auth keys;
// - only the device's own authenticated remote session can set its `push` field (refused on local sockets, pairing
//   sessions, server/peer roles, or before hello; extra `device` field rejected);
// - a revoked device (direct revoke, cascading server revoke, or quiet per-frame check) cannot set a subscription and
//   its stored subscription is never returned or used ("a revoked device gets no push");
// - secret bytes (`keys.auth`, `keys.p256dh`) never appear in server logs.
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  canonicalJson, decodeFrame, encodeFrame, FrameSplitter, memberIdFromKey, packFrame,
  ProfileStatement, PushSubscription, SignedStatement, statementBytes, statementId, toBase64Url,
  type Message, type MessageOf, type Sender, type SessionKind,
} from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { ensureBot } from "../../src/server/effects/log-ops";
import { LogHub } from "../../src/server/log";
import { PrefsStore, RosterError, RosterStore, Gossip, signStatement, signWith, type GossipSession } from "../../src/server/roster";
import { RemoteSession, RemoteSessions, Session, slotAuthorize, type RemoteHost, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { generateDhKeyPair, SessionLink, type SessionEnd, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";

const root = testRoot("push-profile");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const EPOCH = "0123456789abcdef0123456789abcdef";
const TOKEN = "t".repeat(32);
const REMOTE: SessionKind = { local: false };
const LOCAL: SessionKind = { local: true };
const PAIRING: SessionKind = { local: false, pairing: true };
const encoder = new TextEncoder();
let folders = 0;

function makeP256Pub(fill: number): string {
  const bytes = new Uint8Array(65).fill(fill);
  bytes[0] = 4;
  return toBase64Url(bytes);
}

function makeAuth(fill: number): string {
  return toBase64Url(new Uint8Array(16).fill(fill));
}

function makeSub(n = 1): PushSubscription {
  return {
    endpoint: `https://push.example/sub/${n}`,
    keys: { p256dh: makeP256Pub(10 + n), auth: makeAuth(30 + n) },
  };
}

async function waitFor<T>(probe: () => T | null | undefined | false, what: string, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface TestServer {
  dir: string;
  store: ServerStore;
  identity: Awaited<ReturnType<typeof loadOrCreateServerIdentity>>;
  roster: RosterStore;
  host: RemoteHost;
  remote: RemoteSessions;
  sessionHost: SessionHost;
  serverId: string;
  logs: string[];
}

async function startServer(withCluster = true): Promise<TestServer> {
  const dir = join(root, `s${++folders}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const logs: string[] = [];
  const roster = await RosterStore.open(store, identity, { log: (line) => logs.push(line) });
  if (withCluster) {
    const setup = new ClusterSetup(roster);
    const started = await setup.begin();
    expect((await setup.confirm(started.code)).ok).toBe(true);
  }
  const engine = new FakeTurnEngine({ bots: [BOT] });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const runtime = new IntentRuntime({ store, engine, hub, live, log: (line) => logs.push(line), authorize: slotAuthorize(roster), serverEvents: "all", mirrorBotUpdates: true });
  await runtime.start();
  const shell = new ShellBridge();
  const sessionHost: SessionHost = {
    serverId, serverName: "Test server", startedAt: Date.now(), minFeVersion: "3.0.0", token: () => TOKEN,
    hub, live, runtime, engine, content: null, shell,
    nextFor: () => ({}),
    ensureBotStream: async (botId) => { if (!engine.hasBot(botId)) return false; await store.submit((tx) => { ensureBot(tx, botId); }); return true; },
    log: (line) => logs.push(line),
    roster,
    self: { dhPub: identity.dhPub },
  };
  const host: RemoteHost = { ...sessionHost, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey } };
  const remote = new RemoteSessions(host);
  cleanups.push(async () => {
    remote.close();
    await runtime.scope.submit(() => undefined);
    engine.close();
    runtime.close();
    shell.close();
    live.close();
    hub.close();
    await roster.idle();
    await store.close();
  });
  return { dir, store, identity, roster, host, remote, sessionHost, serverId, logs };
}

async function deviceKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await generateDhKeyPair();
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const member = await memberIdFromKey(signPub);
  return { member, dh, signer: signWith(sign.privateKey), keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) } };
}

class DeviceClient {
  readonly got: Message[] = [];
  ended: SessionEnd | null = null;
  link!: SessionLink;
  session!: RemoteSession;

  constructor(readonly s: TestServer, readonly member: string) {}

  dial(
    keys: Awaited<ReturnType<typeof deviceKeys>>,
    accept: (transport: SessionTransport) => RemoteSession = (transport) => this.s.remote.accept(transport, "memory"),
  ): this {
    const toDevice: SessionTransport = {
      send: (frame) => this.link.receive(frame),
      close: () => { void (this.link?.received() ?? Promise.resolve()).then(() => { setTimeout(() => this.link.transportClosed(), 0); }); },
    };
    this.session = accept(toDevice);
    const toServer: SessionTransport = {
      send: (frame) => this.session.receive(frame),
      close: () => { void this.session.link.received().then(() => { setTimeout(() => this.session.transportClosed(), 0); }); },
    };
    this.link = SessionLink.initiate(toServer, {
      mode: "ik", transport: "memory", cluster: this.s.roster.clusterId!,
      self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
      responder: { memberId: this.s.host.self.memberId, dhPub: this.s.host.self.dhPub },
    }, {
      onFrame: (bytes) => {
        const decoded = decodeFrame(bytes, "server", REMOTE);
        if (!decoded.ok) throw new Error(`bad server frame: ${decoded.detail}`);
        this.got.push(decoded.message);
      },
      onEnd: (end) => { this.ended = end; },
    });
    return this;
  }

  async hello(): Promise<MessageOf<"welcome">> {
    await this.link.established;
    this.sendRaw({ t: "hello", deviceId: this.member, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [] });
    return waitFor(() => this.got.find((m): m is MessageOf<"welcome"> => m.t === "welcome"), "welcome");
  }

  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", REMOTE);
    if (!encoded.ok) throw new Error(encoded.detail);
    this.link.send("control", encoder.encode(encoded.text));
  }

  sendRaw(value: unknown): void {
    this.link.send("control", encoder.encode(JSON.stringify(value)));
  }

  bye(): Promise<MessageOf<"bye">> {
    return waitFor(() => this.got.find((m): m is MessageOf<"bye"> => m.t === "bye"), "bye");
  }
}

class FakeLocalSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly writes: Uint8Array[] = [];
  write(bytes: Uint8Array): boolean { this.writes.push(bytes); return true; }
  end(): void {}
  destroy(): void { this.destroyed = true; }
  feedRaw(value: unknown): void {
    this.emit("data", Buffer.from(packFrame(JSON.stringify(value))));
  }
  frames(): Message[] {
    const splitter = new FrameSplitter();
    const out: Message[] = [];
    for (const chunk of this.writes) {
      const split = splitter.push(chunk);
      if (!split.ok) throw new Error(split.detail);
      for (const frame of split.frames) {
        const decoded = decodeFrame(frame, "server", LOCAL);
        if (!decoded.ok) throw new Error(decoded.detail);
        out.push(decoded.message);
      }
    }
    return out;
  }
}

describe("M4-22 protocol: Profile push field and push.subscribe", () => {
  it("round-trips Profile{field: 'push'} and push.subscribe through frames and statement serialization", async () => {
    const sub = makeSub(1);
    const value = canonicalJson(sub);
    const cluster = "0123456789abcdef0123456789abcdef";
    const device = "dddddddddddddddddddddddddd";
    const server = "aaaaaaaaaaaaaaaaaaaaaaaaaa";

    const parsedProfile = ProfileStatement.parse({
      type: "profile",
      cluster,
      member: device,
      field: "push",
      value,
      hlc: { ms: 1_763_100_000_000, c: 1 },
    });
    expect(parsedProfile.field).toBe("push");
    const signed = SignedStatement.parse({ body: parsedProfile, signer: server, sig: toBase64Url(new Uint8Array(64).fill(7)) });
    expect(await statementId(signed.body)).toMatch(/^[0-9a-f]{64}$/);
    expect(statementBytes(signed.body).length).toBeGreaterThan(0);

    const msg: MessageOf<"push.subscribe"> = { t: "push.subscribe", ...sub };
    const encoded = encodeFrame(msg, "fe", REMOTE);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error(encoded.detail);
    const decoded = decodeFrame(encoded.text, "fe", REMOTE);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.message).toEqual(msg);

  });

  it("refuses endpoints that aim the servers at their own machine or network (SSRF, M4-22 review)", () => {
    const keys = makeSub(1).keys;
    const ok = ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://web.push.apple.com:443/Q", "https://PUSH.Example./sub"];
    for (const endpoint of ok) expect(decodeFrame(JSON.stringify({ t: "push.subscribe", endpoint, keys }), "fe", REMOTE).ok, endpoint).toBe(true);
    const refused = [
      "http://127.0.0.1:41234/push", "http://localhost/push", "http://[::1]/push",
      "https://127.0.0.1/push", "https://2130706433/push", "https://0x7f.1/push", "https://10.0.0.5/push", "https://169.254.169.254/latest",
      "https://[::1]/push", "https://[fd00::1]/push",
      "https://localhost/push", "https://localhost./push", "https://a.localhost/push", "https://printer.local/push", "https://metadata.google.internal/x",
      "https://router.home.arpa/push", "https://intranet/push", "https://push.example:8443/sub", "https://push.example:22/sub",
    ];
    for (const endpoint of refused) {
      expect(decodeFrame(JSON.stringify({ t: "push.subscribe", endpoint, keys }), "fe", REMOTE), endpoint).toMatchObject({ ok: false, reason: "malformed" });
      expect(PushSubscription.safeParse({ endpoint, keys }).success, endpoint).toBe(false);
    }
  });

  it("enforces role boundaries: remote device fe only; refused on local socket, pairing, server, and peer", () => {
    const msg = { t: "push.subscribe", ...makeSub(1) };
    const cases: Array<[Sender, SessionKind]> = [
      ["fe", LOCAL],
      ["fe", PAIRING],
      ["server", REMOTE],
      ["server", LOCAL],
      ["peer", REMOTE],
      ["peer", LOCAL],
    ];
    for (const [sender, kind] of cases) {
      const decoded = decodeFrame(JSON.stringify(msg), sender, kind);
      expect(decoded.ok, `${sender} ${JSON.stringify(kind)}`).toBe(false);
      if (!decoded.ok) expect(decoded.reason, `${sender} ${JSON.stringify(kind)}`).toBe("role");
      expect(encodeFrame(msg as Message, sender, kind).ok).toBe(false);
    }
  });

  it("refuses malformed push.subscribe payloads and enforces the 2,000-character profile value limit", () => {
    const sub = makeSub(1);
    // Exact boundary: canonicalJson({ endpoint, keys }) at 2,000 chars passes; 2,001 fails.
    const prefix = "https://push.example/";
    const overhead = canonicalJson({ endpoint: prefix, keys: sub.keys }).length - prefix.length;
    const maxEndpoint = prefix + "a".repeat(2_000 - overhead - prefix.length);
    expect(canonicalJson({ endpoint: maxEndpoint, keys: sub.keys }).length).toBe(2_000);
    expect(decodeFrame(JSON.stringify({ t: "push.subscribe", endpoint: maxEndpoint, keys: sub.keys }), "fe", REMOTE).ok).toBe(true);
    const overEndpoint = maxEndpoint + "a";
    expect(canonicalJson({ endpoint: overEndpoint, keys: sub.keys }).length).toBe(2_001);
    expect(decodeFrame(JSON.stringify({ t: "push.subscribe", endpoint: overEndpoint, keys: sub.keys }), "fe", REMOTE)).toMatchObject({ ok: false, reason: "malformed" });

    const compressedPub = toBase64Url(new Uint8Array(65).fill(2));
    const shortAuth = toBase64Url(new Uint8Array(15).fill(1));
    const badPayloads: unknown[] = [
      { t: "push.subscribe", endpoint: "http://push.example/sub/1", keys: sub.keys },
      { t: "push.subscribe", endpoint: "http://192.168.1.5/sub/1", keys: sub.keys },
      { t: "push.subscribe", endpoint: "javascript:alert(1)", keys: sub.keys },
      { t: "push.subscribe", endpoint: "file:///etc/passwd", keys: sub.keys },
      { t: "push.subscribe", endpoint: "wss://push.example/sub/1", keys: sub.keys },
      { t: "push.subscribe", endpoint: "https://user:pass@push.example/sub/1", keys: sub.keys },
      { t: "push.subscribe", endpoint: "https://push.example/sub\n1", keys: sub.keys },
      { t: "push.subscribe", endpoint: sub.endpoint, keys: { ...sub.keys, p256dh: compressedPub } },
      { t: "push.subscribe", endpoint: sub.endpoint, keys: { ...sub.keys, p256dh: "short" } },
      { t: "push.subscribe", endpoint: sub.endpoint, keys: { ...sub.keys, auth: shortAuth } },
      { t: "push.subscribe", endpoint: sub.endpoint, keys: sub.keys, device: "dddddddddddddddddddddddddd" },
      { t: "push.subscribe", endpoint: sub.endpoint, keys: { ...sub.keys, extra: 1 } },
    ];
    for (const bad of badPayloads) {
      expect(decodeFrame(JSON.stringify(bad), "fe", REMOTE)).toMatchObject({ ok: false, reason: "malformed" });
    }
  });
});

describe("M4-22 server: RosterStore and attached session handling", () => {
  it("stores push subscription from the device's own session, persists across reopen, and replicates by gossip", async () => {
    const s1 = await startServer(true);
    const s2 = await startServer(false);

    // Pair s2 into s1's cluster so we can verify gossip of Profile{field: "push"}.
    const addS2 = await s1.roster.addServer({ keys: s2.identity.keys, name: "S2" });
    const addS2Stmt = s1.roster.statements().find((st) => st.id === addS2.addId)!.statement;
    const joined = await s2.roster.joinCluster({
      add: addS2Stmt,
      roster: s1.roster.statements().map((st) => st.statement),
      sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "S1" },
    });
    await s1.roster.merge([joined.add]);

    const keys = await deviceKeys();
    await s1.roster.addDevice({ keys: keys.keys, name: "Phone" });
    const client = new DeviceClient(s1, keys.member).dial(keys);
    await client.hello();

    const sub1 = makeSub(1);
    client.send({ t: "push.subscribe", ...sub1 });
    await waitFor(() => s1.roster.pushSubscription(keys.member), "push subscription stored");

    expect(s1.roster.pushSubscription(keys.member)).toEqual(sub1);
    expect(s1.roster.pushSubscriptions()).toEqual([{ device: keys.member, subscription: sub1 }]);
    expect(s1.roster.profile(keys.member, "push")).toBe(canonicalJson(sub1));

    const pushStatements = s1.roster.statements().filter((st) => st.statement.body.type === "profile" && st.statement.body.field === "push");
    expect(pushStatements).toHaveLength(1);
    expect(pushStatements[0]!.statement.signer).toBe(s1.identity.memberId);

    // Re-sending the exact same subscription is idempotent (no new Profile statement).
    client.send({ t: "push.subscribe", ...sub1 });
    await new Promise((r) => setTimeout(r, 30));
    await s1.roster.idle();
    expect(s1.roster.statements().filter((st) => st.statement.body.type === "profile" && st.statement.body.field === "push")).toHaveLength(1);

    // Updating with a new subscription writes a newer Profile (higher HLC).
    const sub2 = makeSub(2);
    client.send({ t: "push.subscribe", ...sub2 });
    await waitFor(() => (s1.roster.pushSubscription(keys.member)?.endpoint === sub2.endpoint ? true : null), "updated push subscription");
    expect(s1.roster.pushSubscription(keys.member)).toEqual(sub2);

    // Persists across RosterStore reopen.
    const reopened = await RosterStore.open(s1.store, s1.identity);
    expect(reopened.pushSubscription(keys.member)).toEqual(sub2);
    expect(reopened.pushSubscriptions()).toEqual([{ device: keys.member, subscription: sub2 }]);

    // Replicates to s2 over roster gossip.
    const prefs1 = await PrefsStore.open(s1.store, { self: s1.identity.memberId, knownWriter: (w) => s1.roster.view.servers.has(w) });
    const prefs2 = await PrefsStore.open(s2.store, { self: s2.identity.memberId, knownWriter: (w) => s2.roster.view.servers.has(w) });
    const g1 = new Gossip({ roster: s1.roster, prefs: prefs1, log: () => undefined });
    const g2 = new Gossip({ roster: s2.roster, prefs: prefs2, log: () => undefined });
    g1.start(); g2.start();
    const gs1: GossipSession = { peer: s2.identity.memberId, state: "open", sendWire: (m) => { queueMicrotask(() => { void g2.onMessage(gs2, m); }); return true; }, bye: () => undefined };
    const gs2: GossipSession = { peer: s1.identity.memberId, state: "open", sendWire: (m) => { queueMicrotask(() => { void g1.onMessage(gs1, m); }); return true; }, bye: () => undefined };
    g1.opened(gs1); g2.opened(gs2);
    await waitFor(() => s2.roster.pushSubscription(keys.member), "gossiped push subscription on s2");
    expect(s2.roster.pushSubscription(keys.member)).toEqual(sub2);
    g1.close(); g2.close();
    await s1.roster.idle();
    await s2.roster.idle();

    // Secret hygiene (L-015): auth and p256dh never appear in logs.
    const allLogs = s1.logs.join("\n");
    expect(allLogs).not.toContain(sub1.keys.auth);
    expect(allLogs).not.toContain(sub2.keys.auth);
    expect(allLogs).not.toContain(sub2.keys.p256dh);
  });

  it("only the device's own attached session can set it (another device, local socket, pre-hello, or server id fails)", async () => {
    const s = await startServer(true);
    const keysA = await deviceKeys();
    const keysB = await deviceKeys();
    await s.roster.addDevice({ keys: keysA.keys, name: "Phone A" });
    await s.roster.addDevice({ keys: keysB.keys, name: "Phone B" });

    const devA = new DeviceClient(s, keysA.member).dial(keysA);
    await devA.hello();
    const devB = new DeviceClient(s, keysB.member).dial(keysB);
    await devB.hello();

    // Device A sets its own subscription; Device B remains unset.
    const subA = makeSub(1);
    devA.send({ t: "push.subscribe", ...subA });
    await waitFor(() => s.roster.pushSubscription(keysA.member), "device A push");
    expect(s.roster.pushSubscription(keysB.member)).toBeNull();

    // Device A cannot specify a target device field (strict schema -> bye{malformed}).
    devA.sendRaw({ t: "push.subscribe", ...makeSub(2), device: keysB.member });
    expect(await devA.bye()).toMatchObject({ reason: "malformed" });
    expect(s.roster.pushSubscription(keysB.member)).toBeNull();

    // Before hello: refused with bye{role}.
    const early = new DeviceClient(s, keysB.member).dial(keysB);
    await early.link.established;
    early.sendRaw({ t: "push.subscribe", ...makeSub(3) });
    expect(await early.bye()).toMatchObject({ reason: "role" });
    expect(s.roster.pushSubscription(keysB.member)).toBeNull();

    // Local socket cannot send push.subscribe (bye{role}).
    const socket = new FakeLocalSocket();
    const localSession = new Session(socket as never, s.sessionHost, { helloTimeoutMs: 60_000, pingAfterMs: 60_000, deadAfterMs: 120_000 });
    socket.feedRaw({ t: "hello", deviceId: "desktop", feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [], token: TOKEN });
    socket.feedRaw({ t: "push.subscribe", ...makeSub(4) });
    await waitFor(() => socket.frames().find((m) => m.t === "bye"), "local socket bye");
    expect(socket.frames().find((m) => m.t === "bye")).toMatchObject({ reason: "role" });
    expect(s.roster.pushSubscription(keysB.member)).toBeNull();
    localSession.close();

    // Direct RosterStore guards: server id, unknown id, malformed value all throw.
    await expect(s.roster.writeProfile(s.identity.memberId, "push", canonicalJson(subA))).rejects.toMatchObject({ reason: "not-a-device" });
    await expect(s.roster.writeProfile("zzzzzzzzzzzzzzzzzzzzzzzzzz", "push", canonicalJson(subA))).rejects.toMatchObject({ reason: "not-a-device" });
    await expect(s.roster.writeProfile(keysB.member, "push", "not-json")).rejects.toMatchObject({ reason: "bad-profile" });
    await expect(s.roster.writeProfile(keysB.member, "push", JSON.stringify({ endpoint: "http://evil.example/p", keys: subA.keys }))).rejects.toMatchObject({ reason: "bad-profile" });
    expect(s.roster.pushSubscription(keysB.member)).toBeNull();
  });

  it("a revoked device's subscription is never used and cannot be updated", async () => {
    const s = await startServer(true);
    const keysA = await deviceKeys();
    const keysB = await deviceKeys();
    await s.roster.addDevice({ keys: keysA.keys, name: "Phone A" });
    await s.roster.addDevice({ keys: keysB.keys, name: "Phone B" });

    const devA = new DeviceClient(s, keysA.member).dial(keysA);
    await devA.hello();
    const devB = new DeviceClient(s, keysB.member).dial(keysB);
    await devB.hello();

    const subA = makeSub(1);
    const subB = makeSub(2);
    devA.send({ t: "push.subscribe", ...subA });
    devB.send({ t: "push.subscribe", ...subB });
    await waitFor(() => s.roster.pushSubscription(keysA.member) && s.roster.pushSubscription(keysB.member), "both subscriptions");

    // Revoke device A: its subscription immediately disappears from all readers while B remains.
    await s.roster.revokeDevice(keysA.member);
    expect(await devA.bye()).toMatchObject({ reason: "revoked" });
    expect(s.roster.profile(keysA.member, "push")).toBeNull();
    expect(s.roster.pushSubscription(keysA.member)).toBeNull();
    expect(s.roster.pushSubscriptions()).toEqual([{ device: keysB.member, subscription: subB }]);

    // Even after reopening RosterStore from disk, the revoked device's stored Profile{push} is never returned.
    const reopened = await RosterStore.open(s.store, s.identity);
    expect(reopened.profile(keysA.member, "push")).toBeNull();
    expect(reopened.pushSubscription(keysA.member)).toBeNull();
    expect(reopened.pushSubscriptions()).toEqual([{ device: keysB.member, subscription: subB }]);

    // Cannot write a push profile for a revoked device.
    await expect(s.roster.writeProfile(keysA.member, "push", canonicalJson(makeSub(3)))).rejects.toBeInstanceOf(RosterError);

    // Without the roster onChange listener, a revoked device's push.subscribe frame gets bye{revoked} and writes nothing.
    let writeProfileCalls = 0;
    const quietHost: RemoteHost = {
      ...s.host,
      roster: {
        device: (m) => s.roster.device(m),
        clusterId: s.roster.clusterId,
        onChange: () => () => undefined,
        writeProfile: (m, f, v) => { writeProfileCalls++; return s.roster.writeProfile(m, f, v); },
      },
    };
    const devBQuiet = new DeviceClient(s, keysB.member).dial(keysB, (t) => new RemoteSession(t, "memory", quietHost));
    await devBQuiet.hello();
    await s.roster.revokeDevice(keysB.member);
    const subBNew = makeSub(9);
    devBQuiet.send({ t: "push.subscribe", ...subBNew });
    expect(await devBQuiet.bye()).toMatchObject({ reason: "revoked" });
    expect(writeProfileCalls).toBe(0);
    expect(s.roster.pushSubscription(keysB.member)).toBeNull();
    expect(s.roster.pushSubscriptions()).toEqual([]);
  });

  it("cascading server revocation clears the device's push subscription; malformed gossiped push fails closed", async () => {
    const s1 = await startServer(true);
    const s2 = await startServer(false);
    const addS2 = await s1.roster.addServer({ keys: s2.identity.keys, name: "S2" });
    const addS2Stmt = s1.roster.statements().find((st) => st.id === addS2.addId)!.statement;
    const joined = await s2.roster.joinCluster({
      add: addS2Stmt,
      roster: s1.roster.statements().map((st) => st.statement),
      sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "S1" },
    });
    await s1.roster.merge([joined.add]);

    const phone = await deviceKeys();
    await s2.roster.addDevice({ keys: phone.keys, name: "Phone on S2" });
    const sub = makeSub(5);
    await s2.roster.writeProfile(phone.member, "push", canonicalJson(sub));
    await s1.roster.merge(s2.roster.statements().map((st) => st.statement));
    expect(s1.roster.pushSubscription(phone.member)).toEqual(sub);

    // Malformed push profile signed by the device with a higher HLC fails closed (returns null, never falls back to stale).
    const corrupt = await signStatement(
      { type: "profile", cluster: s1.roster.clusterId!, member: phone.member, field: "push", value: "corrupt-json", hlc: { ms: Date.now() + 60_000, c: 0 } },
      phone.member,
      phone.signer,
    );
    await s1.roster.merge([corrupt.statement]);
    expect(s1.roster.pushSubscription(phone.member)).toBeNull();
    expect(s1.roster.profile(phone.member, "push")).toBeNull();
    expect(s1.roster.pushSubscriptions()).toEqual([]);

    // Now write a valid newer push profile, then revoke S2 with cascade=true: phone is revoked -> no push.
    const sub2 = makeSub(6);
    await s1.roster.writeProfile(phone.member, "push", canonicalJson(sub2));
    expect(s1.roster.pushSubscription(phone.member)).toEqual(sub2);
    await s1.roster.revokeServer(s2.identity.memberId, true);
    expect(s1.roster.pushSubscription(phone.member)).toBeNull();
    expect(s1.roster.profile(phone.member, "push")).toBeNull();
    expect(s1.roster.pushSubscriptions()).toEqual([]);
  });
});
