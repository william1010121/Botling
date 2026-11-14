// Botling 3 M2 step 5: device pairing (src/server/pairing) against the real parts — server.db in a temp folder, the
// roster and cluster setup, the log hub and intent runtime, remote sessions with pair mode — and scripted devices that
// dial over an in-memory transport with WebCrypto keys. No window, no network listener. Also the CLI's code
// (`botlingd pair`, `revoke-device`, `devices`) over a real local socket in a temp folder.
// - the first pairing makes the cluster only after the recovery code is typed back;
// - a device pairs: same 6-digit code on both sides, Add committed, pair.added, ack → done; it then opens an IK session;
// - expired, reused and sixth pending secrets refused; a wrong confirmation code declines (and burns the offer);
// - a lost ack (transport gone, or no ack in time) gives the offer back and a retry with the same link works;
// - one handshake at a time per offer (busy); a replayed HS1 never consumes the offer; a bad pair.hello proof declines;
// - restart keeps the roster; revoke-device closes the device's sessions.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  decodeFrame, encodeFrame, fromBase64Url, memberIdFromKey, parsePairLink, PAIR_OFFER_TTL_MS, statementId, toBase64Url,
  type AdminEvent, type Message, type MessageOf, type PairOffer,
} from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity, type ServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { AdminClient, devicesCommand, pairCommand, PairingError, PairingService, qrModules, revokeDeviceCommand, type CliIo } from "../../src/server/pairing";
import { readAudits, RosterStore } from "../../src/server/roster";
import { devicePeerCheck, RemoteSessions, SessionServer, slotAuthorize, writeToken, type RemoteHost, type RemoteSession, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { generateDhKeyPair, SessionLink, signPairProof, type SessionEnd, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";

const root = testRoot("pairing");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const EPOCH = "0123456789abcdef0123456789abcdef";
const REMOTE = { local: false } as const;
const PAIRING = { local: false, pairing: true } as const;
const encoder = new TextEncoder();
let folders = 0;

async function waitFor<T>(probe: () => T | null | undefined | false, what: string, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

interface Server {
  dir: string;
  store: ServerStore;
  identity: ServerIdentity;
  roster: RosterStore;
  setup: ClusterSetup;
  pairing: PairingService;
  host: RemoteHost;
  remote: RemoteSessions;
  events: AdminEvent[];
  logs: string[];
  clock: { offset: number };
  /** Makes the cluster as the first pairing does (code shown, typed back). */
  cluster(): Promise<void>;
  offer(): Promise<PairOffer>;
  /** Stops everything but the folder (for a restart). */
  stop(): Promise<void>;
}

async function server(options: { dir?: string; ackTimeoutMs?: number; helloTimeoutMs?: number } = {}): Promise<Server> {
  const dir = options.dir ?? `${root}/d${++folders}`;
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: store.meta("memberId") === undefined });
  const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const logs: string[] = [];
  const clock = { offset: 0 };
  const now = () => Date.now() + clock.offset;
  const roster = await RosterStore.open(store, identity, { log: (line) => logs.push(line) });
  const setup = new ClusterSetup(roster, { now });
  const pairing = new PairingService({
    roster, cluster: setup, identity, serverName: "Test server", now, log: (line) => logs.push(line),
    addresses: () => ({ tailnet: "https://tailnet-name.invalid" }), pageUrl: () => "https://tailnet-name.invalid/v3/",
    ...(options.ackTimeoutMs ? { ackTimeoutMs: options.ackTimeoutMs } : {}),
    ...(options.helloTimeoutMs ? { helloTimeoutMs: options.helloTimeoutMs } : {}),
  });
  const events: AdminEvent[] = [];
  pairing.onEvent((event) => events.push(event));
  const engine = new FakeTurnEngine({ bots: [BOT], chunks: ["hel", "lo"], chunkMs: 1 });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const runtime = new IntentRuntime({ store, engine, hub, live, log: (line) => logs.push(line), authorize: slotAuthorize(roster), serverEvents: "all", mirrorBotUpdates: true });
  await runtime.start();
  const shell = new ShellBridge();
  const base: SessionHost = {
    serverId, serverName: "Test server", startedAt: Date.now(), minFeVersion: "3.0.0", token: () => "t".repeat(32),
    hub, live, runtime, engine, content: null, shell,
    nextFor: () => ({}),
    ensureBotStream: async (botId) => { if (!engine.hasBot(botId)) return false; await store.submit((tx) => { ensureBot(tx, botId); }); return true; },
    log: (line) => logs.push(line),
    admin: { handle: (op) => pairing.admin(op), onEvent: (listener) => pairing.onEvent(listener) },
  };
  const host: RemoteHost = { ...base, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, pairing };
  const remote = new RemoteSessions(host);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    pairing.close();
    remote.close();
    await runtime.scope.submit(() => undefined);
    engine.close();
    runtime.close();
    shell.close();
    live.close();
    hub.close();
    await store.close();
  };
  cleanups.push(stop);
  const s: Server = {
    dir, store, identity, roster, setup, pairing, host, remote, events, logs, clock, stop,
    cluster: async () => {
      const started = await pairing.admin({ op: "cluster.create" }) as { code: string };
      expect(await pairing.admin({ op: "cluster.confirm", code: started.code })).toMatchObject({ ok: true });
    },
    offer: async () => parsePairLink(((await pairing.admin({ op: "pair.offer" })) as { link: string }).link)!,
  };
  return s;
}

/** A phone's keys, made with WebCrypto as the page will. */
async function deviceKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await generateDhKeyPair();
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const member = await memberIdFromKey(signPub);
  return { member, sign, dh, keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) } };
}
type Keys = Awaited<ReturnType<typeof deviceKeys>>;

interface PairDialOptions {
  /** Answer pair.added with pair.ack (default true). */
  ack?: boolean;
  /** Drop the transport right after pair.added arrives (a lost ack). */
  dropOnAdded?: boolean;
  /** Sign the proof over another transcript. */
  badProof?: boolean;
  /** Capture the HS1 bytes the device sends. */
  onHs1?: (frame: Uint8Array) => void;
}

/** A scripted device answering an offer in `pair` mode over an in-memory transport. */
class PairDevice {
  readonly got: Message[] = [];
  ended: SessionEnd | null = null;
  link!: SessionLink;
  session!: RemoteSession;
  transportUp = true;
  /** The id of the Add pair.added carried (computed from its body, as the device does). */
  addId: string | null = null;

  constructor(readonly s: Server, readonly keys: Keys, readonly offer: PairOffer, readonly options: PairDialOptions = {}) {}

  dial(): this {
    let first = true;
    const toDevice: SessionTransport = { send: (frame) => { if (this.transportUp) this.link.receive(frame); }, close: () => { setTimeout(() => this.link.transportClosed(), 0); } };
    this.session = this.s.remote.accept(toDevice, "memory");
    const toServer: SessionTransport = {
      send: (frame) => {
        if (first) { first = false; this.options.onHs1?.(frame.slice()); }
        if (this.transportUp) this.session.receive(frame);
      },
      close: () => { setTimeout(() => this.session.transportClosed(), 0); },
    };
    this.link = SessionLink.initiate(toServer, {
      mode: "pair", transport: "memory", cluster: this.offer.cluster,
      self: { memberId: this.keys.member, dhPub: this.keys.dh.publicKey, dhKey: this.keys.dh.privateKey },
      responder: { memberId: this.offer.server, dhPub: fromBase64Url(this.offer.keys.dh)! },
      pair: { offer: this.offer.offer, secret: fromBase64Url(this.offer.secret)! },
    }, {
      onFrame: async (bytes) => {
        const decoded = decodeFrame(bytes, "server", PAIRING);
        if (!decoded.ok) throw new Error(`the server sent a bad frame: ${decoded.detail}`);
        if (decoded.message.t === "pair.added") {
          this.addId = await statementId(decoded.message.add.body);
          this.got.push(decoded.message);
          if (this.options.dropOnAdded) { this.drop(); return; }
          if (this.options.ack !== false) this.send({ t: "pair.ack", addId: this.addId });
          return;
        }
        this.got.push(decoded.message);
      },
      onEnd: (end) => { this.ended = end; },
    });
    void this.link.established.then(async (info) => {
      const hash = this.options.badProof ? new Uint8Array(32).fill(7) : info.transcriptHash;
      const proof = await signPairProof(this.keys.sign.privateKey, hash);
      this.send({ t: "pair.hello", name: "Phone", sign: this.keys.keys.sign, proof: toBase64Url(proof), feVersion: "3.0.0", protocol: 1 } as Message);
    }, () => undefined);
    return this;
  }

  get code(): string | undefined { return this.link.info?.code; }

  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", PAIRING);
    if (!encoded.ok) throw new Error(encoded.detail);
    if (this.link.state === "open") this.link.send("control", encoder.encode(encoded.text));
  }

  /** The connection is lost: nothing more goes either way. */
  drop(): void {
    this.transportUp = false;
    setTimeout(() => { this.session.transportClosed(); this.link.transportClosed(); }, 0);
  }

  declined(): MessageOf<"pair.declined"> | undefined { return this.got.find((m): m is MessageOf<"pair.declined"> => m.t === "pair.declined"); }
  added(): MessageOf<"pair.added"> | undefined { return this.got.find((m): m is MessageOf<"pair.added"> => m.t === "pair.added"); }
  waitEnded(): Promise<SessionEnd> { return waitFor(() => this.ended, "the device's session to end"); }
  /** Why the server ended a handshake it refused (the device only sees the transport close: nothing is answered). */
  async refused(): Promise<string> {
    const end = await this.waitEnded();
    expect(end.reason).toBe("transport");
    expect(this.got).toEqual([]);
    return (await waitFor(() => this.session.link.ending, "the server side's end")).reason;
  }
}

function eventOf<K extends AdminEvent["kind"]>(s: Server, kind: K, offer?: string, from = 0): Promise<Extract<AdminEvent, { kind: K }>> {
  return waitFor(() => s.events.slice(from).find((e): e is Extract<AdminEvent, { kind: K }> => e.kind === kind && (!offer || !("offer" in e) || e.offer === offer)), `admin event ${kind}`);
}

/** Pairs a device through the whole flow (code compared and accepted, ack). */
async function pairDevice(s: Server, keys?: Keys): Promise<{ keys: Keys; device: PairDevice; addId: string }> {
  const k = keys ?? await deviceKeys();
  const offer = await s.offer();
  const from = s.events.length;
  const device = new PairDevice(s, k, offer).dial();
  const code = await eventOf(s, "pair.code", offer.offer, from);
  expect(code.code).toBe(device.code);
  expect(await s.pairing.confirm(offer.offer, true)).toMatchObject({ ok: true, deviceId: k.member });
  const done = await eventOf(s, "pair.done", offer.offer, from);
  return { keys: k, device, addId: done.addId };
}

/** A paired device's normal (IK) session: hello → welcome. */
async function dialIk(s: Server, keys: Keys) {
  const got: Message[] = [];
  let ended: SessionEnd | null = null;
  let link!: SessionLink;
  const toDevice: SessionTransport = { send: (frame) => link.receive(frame), close: () => { setTimeout(() => link.transportClosed(), 0); } };
  const session = s.remote.accept(toDevice, "memory");
  const toServer: SessionTransport = { send: (frame) => session.receive(frame), close: () => { setTimeout(() => session.transportClosed(), 0); } };
  link = SessionLink.initiate(toServer, {
    mode: "ik", transport: "memory", cluster: s.roster.clusterId!, self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
    responder: { memberId: s.host.self.memberId, dhPub: s.host.self.dhPub },
  }, {
    onFrame: (bytes) => { const decoded = decodeFrame(bytes, "server", REMOTE); if (decoded.ok) got.push(decoded.message); },
    onEnd: (end) => { ended = end; },
  });
  return { got, link, session, ended: () => ended };
}

async function openIk(s: Server, keys: Keys) {
  const dial = await dialIk(s, keys);
  await dial.link.established;
  dial.link.send("control", encoder.encode(JSON.stringify({ t: "hello", deviceId: keys.member, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [] })));
  await waitFor(() => dial.got.find((m) => m.t === "welcome"), "welcome");
  return dial;
}

describe("the first pairing makes the cluster", () => {
  it("only after the recovery code is typed back; offers are refused before", async () => {
    const s = await server();
    await expect(s.pairing.admin({ op: "pair.offer" })).rejects.toMatchObject({ code: "no-cluster" });
    expect(await s.pairing.admin({ op: "cluster.status" })).toEqual({ clusterId: null, pending: null, note: null });
    const started = await s.pairing.admin({ op: "cluster.create" }) as { code: string; clusterId: string };
    expect(started.code).toMatch(/^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/);
    const status = await s.pairing.admin({ op: "cluster.status" }) as { clusterId: string | null; note: string | null };
    expect(status.clusterId).toBeNull();
    expect(status.note).toMatch(/recovery code was shown but not typed back/);
    // A wrong code (well formed) changes nothing: still no cluster, still no offer.
    const wrong = started.code.startsWith("A") ? `B${started.code.slice(1)}` : `A${started.code.slice(1)}`;
    expect(await s.pairing.admin({ op: "cluster.confirm", code: wrong })).toMatchObject({ ok: false, reason: "wrong-code" });
    expect(s.roster.clusterId).toBeNull();
    await expect(s.pairing.admin({ op: "pair.offer" })).rejects.toMatchObject({ code: "no-cluster" });
    // The right code (any spelling) makes it.
    expect(await s.pairing.admin({ op: "cluster.confirm", code: started.code.toLowerCase().replace(/-/g, " ") })).toMatchObject({ ok: true, clusterId: started.clusterId });
    expect(s.roster.clusterId).toBe(started.clusterId);
    expect(await s.pairing.admin({ op: "cluster.status" })).toEqual({ clusterId: started.clusterId, pending: null, note: null });
    const offer = await s.offer();
    expect(offer.cluster).toBe(started.clusterId);
    // The code is in no log line.
    const normal = started.code.replace(/-/g, "");
    expect(s.logs.join("\n")).not.toContain(normal);
    expect(s.logs.join("\n")).not.toContain(started.code);
  });
});

describe("a scripted device pairs over the in-memory transport", () => {
  it("same code on both sides; the Add is committed, pair.added carries it and the cluster's root; the ack uses the offer up", async () => {
    const s = await server();
    await s.cluster();
    const keys = await deviceKeys();
    const offer = await s.offer();
    expect(offer.server).toBe(s.identity.memberId);
    expect(fromBase64Url(offer.secret)).toHaveLength(32);
    const device = new PairDevice(s, keys, offer).dial();
    const code = await eventOf(s, "pair.code", offer.offer);
    expect(code).toMatchObject({ deviceId: keys.member, deviceName: "Phone" });
    expect(code.code).toMatch(/^[0-9]{6}$/);
    expect(code.code).toBe(device.code);
    expect(s.pairing.pending()).toEqual([expect.objectContaining({ offer: offer.offer, state: "comparing" })]);
    // A pairing session is not a front-end session: nothing registered as one.
    expect(s.remote.open).toHaveLength(0);
    expect(s.remote.pairingSessions).toHaveLength(1);
    expect(s.roster.device(keys.member)).toBeNull();

    expect(await s.pairing.confirm(offer.offer, true)).toMatchObject({ ok: true, deviceId: keys.member });
    const done = await eventOf(s, "pair.done", offer.offer);
    const added = device.added()!;
    expect(device.addId).toBe(done.addId);
    expect(added.add.signer).toBe(s.identity.memberId);
    expect(added.add.body).toMatchObject({ member: keys.member, kind: "device", scope: ["read", "reply", "approve"], by: s.identity.memberId });
    expect(added.roster.some((st) => st.body.type === "root")).toBe(true);
    expect((await Promise.all(added.roster.map((st) => statementId(st.body))))).toContain(done.addId);
    // Used up: gone from the pending list; the device is valid with its keys.
    expect(s.pairing.pending()).toEqual([]);
    expect(s.roster.device(keys.member)).toMatchObject({ name: "Phone", keys: keys.keys });
    await device.waitEnded();
    // The device now opens a normal session.
    const ik = await openIk(s, keys);
    expect(s.remote.of(keys.member)).toHaveLength(1);
    ik.link.close();
    // Audit rows for the cluster and the Add.
    const db = s.store.openReader();
    try { expect(readAudits(db).map((a) => a.act)).toEqual(expect.arrayContaining(["cluster.create", "device.add"])); } finally { db.close(); }
    // The secret is in no log line.
    expect(s.logs.join("\n")).not.toContain(offer.secret);
  });

  it("an expired secret is refused (the handshake ends with `offer`); nothing is added", async () => {
    const s = await server();
    await s.cluster();
    const offer = await s.offer();
    s.clock.offset = PAIR_OFFER_TTL_MS + 1_000;
    const device = new PairDevice(s, await deviceKeys(), offer).dial();
    expect(await device.refused()).toBe("offer");
    expect(device.got).toEqual([]);
    expect(s.pairing.pending()).toEqual([]);
    expect([...s.roster.view.members.values()].filter((m) => m.kind === "device")).toEqual([]);
  });

  it("a used secret is refused", async () => {
    const s = await server();
    await s.cluster();
    const offer = await s.offer();
    const from = s.events.length;
    new PairDevice(s, await deviceKeys(), offer).dial();
    await eventOf(s, "pair.code", offer.offer, from);
    await s.pairing.confirm(offer.offer, true);
    await eventOf(s, "pair.done", offer.offer, from);
    const again = new PairDevice(s, await deviceKeys(), offer).dial();
    expect(await again.refused()).toBe("offer");
    expect(await s.pairing.confirm(offer.offer, true)).toEqual({ ok: false, reason: "used" });
    expect(s.pairing.devices()).toHaveLength(1);
  });

  it("a sixth pending secret is refused; a cancelled or expired one frees a place", async () => {
    const s = await server();
    await s.cluster();
    const offers = [];
    for (let i = 0; i < 5; i++) offers.push(await s.offer());
    expect(new Set(offers.map((o) => o.offer)).size).toBe(5);
    expect(new Set(offers.map((o) => o.secret)).size).toBe(5);
    await expect(s.pairing.admin({ op: "pair.offer" })).rejects.toBeInstanceOf(PairingError);
    await expect(s.pairing.admin({ op: "pair.offer" })).rejects.toMatchObject({ code: "limit" });
    expect(await s.pairing.admin({ op: "pair.cancel", offer: offers[0]!.offer })).toEqual({ ok: true });
    const sixth = await s.offer();
    await expect(s.pairing.admin({ op: "pair.offer" })).rejects.toMatchObject({ code: "limit" });
    // The cancelled one no longer pairs.
    const late = new PairDevice(s, await deviceKeys(), offers[0]!).dial();
    expect(await late.refused()).toBe("offer");
    // After 5 minutes every one has expired: five new ones fit.
    s.clock.offset = PAIR_OFFER_TTL_MS + 1;
    for (let i = 0; i < 5; i++) await s.offer();
    expect(s.pairing.pending().map((p) => p.offer)).not.toContain(sixth.offer);
  });

  it("a wrong confirmation code declines: the device is told, nothing is added, the offer is burnt", async () => {
    const s = await server();
    await s.cluster();
    const offer = await s.offer();
    const device = new PairDevice(s, await deviceKeys(), offer).dial();
    await eventOf(s, "pair.code", offer.offer);
    expect(await s.pairing.confirm(offer.offer, false)).toEqual({ ok: true });
    await device.waitEnded();
    expect(device.declined()).toEqual({ t: "pair.declined", reason: "code" });
    expect(await eventOf(s, "pair.declined", offer.offer)).toMatchObject({ reason: "code" });
    expect(s.pairing.devices()).toEqual([]);
    expect(s.pairing.pending()).toEqual([]);
    const again = new PairDevice(s, await deviceKeys(), offer).dial();
    expect(await again.refused()).toBe("offer");
  });

  it("the device declining (its code differs) burns the offer too", async () => {
    const s = await server();
    await s.cluster();
    const offer = await s.offer();
    const device = new PairDevice(s, await deviceKeys(), offer).dial();
    await eventOf(s, "pair.code", offer.offer);
    device.send({ t: "pair.declined", reason: "code" });
    expect(await eventOf(s, "pair.declined", offer.offer)).toMatchObject({ reason: "code" });
    expect(s.pairing.pending()).toEqual([]);
    expect(await s.pairing.confirm(offer.offer, true)).toMatchObject({ ok: false });
  });

  it("a lost ack (the connection drops after pair.added) gives the offer back; a retry with the same link works", async () => {
    const s = await server();
    await s.cluster();
    const keys = await deviceKeys();
    const offer = await s.offer();
    const first = new PairDevice(s, keys, offer, { dropOnAdded: true }).dial();
    await eventOf(s, "pair.code", offer.offer);
    const confirmed = await s.pairing.confirm(offer.offer, true) as { addId: string };
    expect(await eventOf(s, "pair.declined", offer.offer)).toMatchObject({ reason: "ack lost" });
    expect(first.addId).toBe(confirmed.addId);
    expect(s.pairing.pending()).toEqual([expect.objectContaining({ offer: offer.offer, state: "open" })]);
    // The Add is committed (the device just never heard): a retry gets the same one.
    expect(s.roster.device(keys.member)).not.toBeNull();
    const from = s.events.length;
    const retry = new PairDevice(s, keys, offer).dial();
    const code = await eventOf(s, "pair.code", offer.offer, from);
    expect(code.code).toBe(retry.code);
    expect(code.code).not.toBe(first.code);
    expect(await s.pairing.confirm(offer.offer, true)).toMatchObject({ ok: true, addId: confirmed.addId });
    expect((await eventOf(s, "pair.done", offer.offer, from)).addId).toBe(confirmed.addId);
    expect(s.pairing.pending()).toEqual([]);
    expect(s.pairing.devices()).toHaveLength(1);
    expect(s.roster.statements().filter((st) => st.statement.body.type === "add" && st.statement.body.kind === "device")).toHaveLength(1);
  });

  it("no ack within the time also gives the offer back (the silent session is ended)", async () => {
    const s = await server({ ackTimeoutMs: 150 });
    await s.cluster();
    const keys = await deviceKeys();
    const offer = await s.offer();
    const silent = new PairDevice(s, keys, offer, { ack: false }).dial();
    await eventOf(s, "pair.code", offer.offer);
    await s.pairing.confirm(offer.offer, true);
    expect(await eventOf(s, "pair.declined", offer.offer)).toMatchObject({ reason: "ack lost" });
    await silent.waitEnded();
    // A late ack on a new session is not how it works: the device pairs again with the link.
    const from = s.events.length;
    new PairDevice(s, keys, offer).dial();
    await eventOf(s, "pair.code", offer.offer, from);
    await s.pairing.confirm(offer.offer, true);
    await eventOf(s, "pair.done", offer.offer, from);
  });

  it("after the ack, the ack timer gives nothing back (no late 'ack lost' for a used offer) (step 8)", async () => {
    const s = await server({ ackTimeoutMs: 150 });
    await s.cluster();
    const { device } = await pairDevice(s);
    const offer = device.offer;
    const from = s.events.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(s.events.slice(from).filter((e) => e.kind === "pair.declined")).toEqual([]);
    expect(await s.pairing.confirm(offer.offer, true)).toMatchObject({ ok: false, reason: "used" });
  });

  it("one handshake at a time per offer: a second device is told busy; the offer stays with the first", async () => {
    const s = await server();
    await s.cluster();
    const offer = await s.offer();
    const a = new PairDevice(s, await deviceKeys(), offer).dial();
    await eventOf(s, "pair.code", offer.offer);
    const b = new PairDevice(s, await deviceKeys(), offer).dial();
    await b.waitEnded();
    expect(b.declined()).toEqual({ t: "pair.declined", reason: "busy" });
    expect(s.events.filter((e) => e.kind === "pair.code")).toHaveLength(1);
    expect(s.pairing.pending()).toEqual([expect.objectContaining({ state: "comparing" })]);
    await s.pairing.confirm(offer.offer, true);
    expect(await eventOf(s, "pair.done", offer.offer)).toMatchObject({ deviceId: a.keys.member });
    expect(s.pairing.devices().map((d) => d.id)).toEqual([a.keys.member]);
  });

  it("a replayed pair HS1 reaches the roster check but never consumes or claims the offer", async () => {
    const s = await server();
    await s.cluster();
    const offer = await s.offer();
    let hs1: Uint8Array | null = null;
    const original = new PairDevice(s, await deviceKeys(), offer, { onHs1: (frame) => { hs1 = frame; } }).dial();
    await eventOf(s, "pair.code", offer.offer);
    original.drop();
    await waitFor(() => s.pairing.pending()[0]?.state === "open", "the offer back to open");
    // An eavesdropper replays the HS1 (three times): the server answers HS2 each time and then waits for an HS3 it never gets.
    const answers: Uint8Array[] = [];
    const sessions = [0, 1, 2].map(() => {
      const session = s.remote.accept({ send: (frame) => answers.push(frame), close: () => undefined }, "memory");
      session.receive(hs1!);
      return session;
    });
    await waitFor(() => answers.length === 3 || null, "HS2 to every replay");
    expect(s.pairing.pending()).toEqual([expect.objectContaining({ offer: offer.offer, state: "open" })]);
    expect(s.remote.pairingSessions).toHaveLength(0);
    for (const session of sessions) session.close();
    // The real device still pairs with it.
    const from = s.events.length;
    new PairDevice(s, await deviceKeys(), offer).dial();
    await eventOf(s, "pair.code", offer.offer, from);
    await s.pairing.confirm(offer.offer, true);
    await eventOf(s, "pair.done", offer.offer, from);
  });

  it("a pair.hello whose proof is not over this transcript is declined and the offer goes back", async () => {
    const s = await server();
    await s.cluster();
    const offer = await s.offer();
    const bad = new PairDevice(s, await deviceKeys(), offer, { badProof: true }).dial();
    await bad.waitEnded();
    expect(bad.declined()).toEqual({ t: "pair.declined", reason: "unsupported" });
    expect(s.events.some((e) => e.kind === "pair.code")).toBe(false);
    expect(s.pairing.pending()).toEqual([expect.objectContaining({ state: "open" })]);
    const good = await pairDevice(s);
    expect(s.pairing.devices().map((d) => d.id)).toEqual([good.keys.member]);
  });

  it("a revoked device's key cannot pair again (refused at the roster check)", async () => {
    const s = await server();
    await s.cluster();
    const { keys } = await pairDevice(s);
    await s.pairing.revokeDevice(keys.member);
    const offer = await s.offer();
    const again = new PairDevice(s, keys, offer).dial();
    expect(await again.refused()).toBe("roster");
    expect(s.pairing.pending()).toEqual([expect.objectContaining({ state: "open" })]);
  });

  it("a pairing session that sends no pair.hello in time is ended and the offer goes back", async () => {
    const s = await server({ helloTimeoutMs: 100 });
    await s.cluster();
    const offer = await s.offer();
    const keys = await deviceKeys();
    let link!: SessionLink;
    const toDevice: SessionTransport = { send: (frame) => link.receive(frame), close: () => { setTimeout(() => link.transportClosed(), 0); } };
    const session = s.remote.accept(toDevice, "memory");
    let ended: SessionEnd | null = null;
    link = SessionLink.initiate({ send: (frame) => session.receive(frame), close: () => { setTimeout(() => session.transportClosed(), 0); } }, {
      mode: "pair", transport: "memory", cluster: offer.cluster, self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
      responder: { memberId: offer.server, dhPub: fromBase64Url(offer.keys.dh)! }, pair: { offer: offer.offer, secret: fromBase64Url(offer.secret)! },
    }, { onFrame: () => undefined, onEnd: (end) => { ended = end; } });
    await link.established;
    await waitFor(() => ended, "the silent pairing session to end");
    expect(s.pairing.pending()).toEqual([expect.objectContaining({ state: "open" })]);
  });
});

describe("restart and revocation", () => {
  it("a restart keeps the roster: the cluster and the device, which then opens a session", async () => {
    const first = await server();
    await first.cluster();
    const { keys, addId } = await pairDevice(first);
    const cluster = first.roster.clusterId;
    await first.stop();
    const again = await server({ dir: first.dir });
    expect(again.identity.memberId).toBe(first.identity.memberId);
    expect(again.roster.clusterId).toBe(cluster);
    expect(again.roster.device(keys.member)).toMatchObject({ addId, keys: keys.keys, name: "Phone" });
    expect(devicePeerCheck(again.roster, { mode: "ik", memberId: keys.member, dhPub: keys.dh.publicKey })).toEqual({ ok: true });
    // Offers are not kept (memory only): a new one is needed, and the cluster is not made twice.
    expect(again.pairing.pending()).toEqual([]);
    await expect(again.pairing.admin({ op: "cluster.create" })).rejects.toThrow(/already belongs to a cluster/);
    const ik = await openIk(again, keys);
    expect(again.remote.of(keys.member)).toHaveLength(1);
    ik.link.close();
  });

  it("revoking a device closes its sessions at once and tells the admin listeners", async () => {
    const s = await server();
    await s.cluster();
    const { keys } = await pairDevice(s);
    const one = await openIk(s, keys);
    const two = await openIk(s, keys);
    expect(s.remote.of(keys.member)).toHaveLength(2);
    expect(await s.pairing.admin({ op: "device.revoke", deviceId: keys.member, reason: "lost" })).toMatchObject({ already: false });
    await waitFor(() => one.got.some((m) => m.t === "bye" && m.reason === "revoked") && two.got.some((m) => m.t === "bye" && m.reason === "revoked"), "bye{revoked} on both sessions");
    await waitFor(() => s.remote.of(keys.member).length === 0 || null, "the sessions gone");
    expect(await eventOf(s, "device.revoked")).toEqual({ kind: "device.revoked", deviceId: keys.member });
    expect(s.pairing.devices()).toEqual([expect.objectContaining({ id: keys.member, revoked: true, valid: false })]);
    // Not a device: refused.
    await expect(s.pairing.admin({ op: "device.revoke", deviceId: s.identity.memberId })).rejects.toMatchObject({ code: "not-a-device" });
  });
});

describe("the CLI over a real local socket", () => {
  /** A local socket for the admin requests, served by the same host as the device sessions. */
  async function socketFor(s: Server): Promise<{ path: string; token: string }> {
    const path = join(s.dir, "botlingd.sock");
    const token = writeToken(join(s.dir, "botlingd.token"));
    const local = new SessionServer(path, { ...s.host, token: () => token });
    await local.listen();
    cleanups.push(() => local.close());
    return { path, token };
  }

  /** Scripted terminal: answers questions from `answer`, keeps every printed line. */
  function terminal(answer: (prompt: string, lines: string[]) => string | null | Promise<string | null>): CliIo & { lines: string[] } {
    const lines: string[] = [];
    return { lines, out: (line) => { lines.push(line); }, ask: async (prompt) => { lines.push(prompt); return answer(prompt, lines); } };
  }

  it("botlingd pair: first pairing (recovery code typed back after one wrong try), link + QR, code compared, device paired; devices; revoke-device closes its session", async () => {
    const s = await server();
    const { path, token } = await socketFor(s);
    const client = await AdminClient.connect(path, token);
    cleanups.push(() => client.close());
    const keys = await deviceKeys();
    let device: PairDevice | null = null;
    let tries = 0;
    const io = terminal(async (prompt, lines) => {
      if (prompt.startsWith("Recovery code")) {
        // The cluster is not there before the code is typed back.
        expect(s.roster.clusterId).toBeNull();
        const shown = lines.map((line) => line.trim()).find((line) => /^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/.test(line))!;
        tries++;
        return tries === 1 ? "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA" : shown;
      }
      if (prompt.startsWith("Does the device show")) {
        const shown = lines.filter((line) => line.startsWith("Code: ")).at(-1)!.slice(6).replace(" ", "");
        expect(shown).toBe(device!.code);
        return "y";
      }
      return null;
    });
    // The device opens the link as soon as it is printed.
    const watcher = waitFor(() => io.lines.find((line) => line.startsWith("https://tailnet-name.invalid/v3/#pair=")), "the link").then((link) => {
      device = new PairDevice(s, keys, parsePairLink(link)!).dial();
    });
    const code = await pairCommand(client, io, {});
    await watcher;
    expect(code).toBe(0);
    expect(tries).toBe(2);
    expect(io.lines).toContain("That is not the code shown above.");
    expect(io.lines.some((line) => line.startsWith("Cluster ") && line.endsWith(" created."))).toBe(true);
    expect(io.lines.some((line) => line.includes("█") || line.includes("▀"))).toBe(true); // the QR
    expect(io.lines.at(-1)).toMatch(new RegExp(`^Paired: ${keys.member} `));
    expect(s.roster.device(keys.member)).not.toBeNull();

    const listed = terminal(() => null);
    expect(await devicesCommand(client, listed, { json: true })).toBe(0);
    expect(JSON.parse(listed.lines[0]!)).toEqual([expect.objectContaining({ id: keys.member, name: "Phone", valid: true, revoked: false, scope: ["read", "reply", "approve"] })]);

    const session = await openIk(s, keys);
    const revoking = terminal(() => null);
    expect(await revokeDeviceCommand(client, revoking, keys.member, "lost phone")).toBe(0);
    expect(revoking.lines[0]).toMatch(/^Revoked .* its sessions were closed/);
    await waitFor(() => session.got.some((m) => m.t === "bye" && m.reason === "revoked"), "bye{revoked}");
    await waitFor(() => session.ended(), "the session ended");
    expect(s.remote.of(keys.member)).toEqual([]);
    expect(await revokeDeviceCommand(client, terminal(() => null), "zzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(1);
  });

  it("botlingd pair: answering no to the code declines; three wrong recovery codes make no cluster", async () => {
    const s = await server();
    const { path, token } = await socketFor(s);
    const client = await AdminClient.connect(path, token);
    cleanups.push(() => client.close());
    const noCluster = terminal(() => "AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA");
    expect(await pairCommand(client, noCluster, { qr: false })).toBe(1);
    expect(noCluster.lines.at(-1)).toMatch(/no cluster was made/);
    expect(s.roster.clusterId).toBeNull();

    await s.cluster();
    let device: PairDevice | null = null;
    const io = terminal(() => "n");
    const watcher = waitFor(() => io.lines.find((line) => line.includes("#pair=")), "the link").then(async (link) => {
      device = new PairDevice(s, await deviceKeys(), parsePairLink(link)!).dial();
    });
    expect(await pairCommand(client, io, { qr: false })).toBe(1);
    await watcher;
    await device!.waitEnded();
    expect(device!.declined()).toEqual({ t: "pair.declined", reason: "code" });
    expect(s.pairing.devices()).toEqual([]);
  });

  it("the QR encoder holds a whole pairing link and jsQR reads it back", async () => {
    const s = await server();
    await s.cluster();
    const { link } = await s.pairing.admin({ op: "pair.offer" }) as { link: string };
    expect(link.length).toBeGreaterThan(213); // more than the 2.x encoder takes
    const modules = qrModules(link);
    const scale = 4, quiet = 4, size = (modules.length + quiet * 2) * scale;
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
    modules.forEach((row, y) => row.forEach((on, x) => {
      if (!on) return;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const at = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
      }
    }));
    const jsQR = (await import("jsqr")).default;
    expect(jsQR(pixels, size, size)?.data).toBe(link);
    for (const text of ["x", "a".repeat(100), "b".repeat(400), "c".repeat(1200)]) {
      const m = qrModules(text);
      const sz = (m.length + 8) * 2;
      const px = new Uint8ClampedArray(sz * sz * 4).fill(255);
      m.forEach((row, y) => row.forEach((on, x) => { if (on) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const at = (((y + 4) * 2 + dy) * sz + (x + 4) * 2 + dx) * 4; px[at] = px[at + 1] = px[at + 2] = 0; } }));
      expect(jsQR(px, sz, sz)?.data).toBe(text);
    }
  });
});
