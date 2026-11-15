// Botling 3 M2 step 4: remote device sessions on botlingd (src/server/session: session core, remote-session.ts,
// remote-reads.ts), over an in-memory transport, against the real parts (server.db in a temp folder, the roster with
// a cluster, the log hub, the intent runtime with the owner's slot check) and a fake turn engine. No window, no socket.
// - a paired device: hello → welcome; srv: snap; chat.send → cmd.result{applied} and the bot stream's entries; reads
//   on the allowlist answered;
// - a read-only device: chat.send → cmd.result{refused, scope}, the refusal in the log, nothing applied;
// - settings.set of a machine-security key is refused remotely even with `manage` (its handler never runs); a plain
//   key applies with `manage` and is refused (handler not run) without it;
// - req outside the allowlist → forbidden; local-only frames (content.open, admin), a foreign origin, a token in the
//   hello or another member's id → bye{role};
// - revocation: the roster listener ends the session at once (bye{revoked} reaches the device); without the listener
//   the device's next frame ends it; its unapplied commands (held ahead, or a copy arriving later) are refused
//   {origin}, never applied;
// - an unpaired key gets no session and no frame parsed; keepalive: ping after silence, bye{dead} after nothing heard;
//   back-pressure by the send queue's bytes (live frames skipped, a session that does not drain dropped).
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Command } from "../../src/contract";
import {
  decodeFrame, encodeFrame, memberIdFromKey, toBase64Url,
  type CmdBody, type Message, type MessageOf, type Slot, type StreamId,
} from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { ensureBot } from "../../src/server/effects/log-ops";
import { LogHub } from "../../src/server/log";
import { RosterStore } from "../../src/server/roster";
import {
  LIVE_SOFT_BYTES, RemoteSession, RemoteSessions, REMOTE_READS, slotAuthorize, statedScope,
  type RemoteHost, type RemoteSessionOptions, type SessionHost,
} from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { generateDhKeyPair, SessionLink, type SessionEnd, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";

const root = testRoot("remote-session");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const EPOCH = "0123456789abcdef0123456789abcdef";
const REMOTE = { local: false } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
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
  store: ServerStore;
  identity: Awaited<ReturnType<typeof loadOrCreateServerIdentity>>;
  roster: RosterStore;
  engine: FakeTurnEngine;
  runtime: IntentRuntime;
  host: RemoteHost;
  remote: RemoteSessions;
  serverId: string;
  logs: string[];
  inc(): string;
  entries(stream: string): Array<{ kind: string; body: Record<string, unknown>; slot: Slot | null }>;
}

async function server(options: RemoteSessionOptions = {}, extraHost: Partial<SessionHost> = {}): Promise<Server> {
  const dir = `${root}/d${++folders}`;
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const logs: string[] = [];
  const roster = await RosterStore.open(store, identity, { log: (line) => logs.push(line) });
  const setup = new ClusterSetup(roster);
  const started = await setup.begin();
  expect((await setup.confirm(started.code)).ok).toBe(true);
  const engine = new FakeTurnEngine({ bots: [BOT], chunks: ["hel", "lo"], chunkMs: 1 });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const runtime = new IntentRuntime({ store, engine, hub, live, log: (line) => logs.push(line), authorize: slotAuthorize(roster), serverEvents: "all", mirrorBotUpdates: true });
  await runtime.start();
  const shell = new ShellBridge();
  const base: SessionHost = {
    serverId, serverName: "Test server", startedAt: Date.now(), minFeVersion: "3.0.0", token: () => "t".repeat(32),
    hub, live, runtime, engine, content: null, shell,
    nextFor: (origin, originEpoch) => {
      const next: Record<string, number> = {};
      for (const row of hub.reader().prepare("SELECT target, next FROM slots WHERE origin = ? AND originEpoch = ?").all(origin, originEpoch)) next[String(row.target)] = Number(row.next);
      return next;
    },
    ensureBotStream: async (botId) => { if (!engine.hasBot(botId)) return false; await store.submit((tx) => { ensureBot(tx, botId); }); return true; },
    log: (line) => logs.push(line),
  };
  const host: RemoteHost = { ...base, ...extraHost, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey } };
  const remote = new RemoteSessions(host, options);
  cleanups.push(async () => {
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
    store, identity, roster, engine, runtime, host, remote, serverId, logs,
    inc: () => String(hub.reader().prepare("SELECT logId FROM streams WHERE stream = ?").get(`srv:${serverId}`)!.logId),
    entries: (stream) => hub.reader().prepare("SELECT kind, body, slot FROM entries WHERE stream = ? ORDER BY seq").all(stream)
      .map((row) => ({ kind: String(row.kind), body: JSON.parse(String(row.body)), slot: row.slot ? JSON.parse(String(row.slot)) : null })),
  };
}

/** A phone's keys, made with WebCrypto as the page will. */
async function deviceKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await generateDhKeyPair();
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const member = await memberIdFromKey(signPub);
  return { member, dh, keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) } };
}

class Device {
  readonly got: Message[] = [];
  readonly raw: Uint8Array[] = [];
  ended: SessionEnd | null = null;
  link!: SessionLink;
  session!: RemoteSession;
  n = new Map<string, number>();

  constructor(readonly s: Server, readonly member: string) {}

  /** Dials botlingd over an in-memory transport (IK, the server's keys from the roster / offer). */
  dial(keys: Awaited<ReturnType<typeof deviceKeys>>, accept: (transport: SessionTransport) => RemoteSession = (transport) => this.s.remote.accept(transport, "memory")): this {
    const toDevice: SessionTransport = { send: (frame) => this.link.receive(frame), close: () => { setTimeout(() => this.link.transportClosed(), 0); } };
    this.session = accept(toDevice);
    const toServer: SessionTransport = { send: (frame) => this.session.receive(frame), close: () => { setTimeout(() => this.session.transportClosed(), 0); } };
    this.link = SessionLink.initiate(toServer, {
      mode: "ik", transport: "memory", cluster: this.s.roster.clusterId!, self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
      responder: { memberId: this.s.host.self.memberId, dhPub: this.s.host.self.dhPub },
    }, {
      onFrame: (bytes) => {
        this.raw.push(bytes);
        const decoded = decodeFrame(bytes, "server", REMOTE);
        if (!decoded.ok) throw new Error(`the server sent a bad frame: ${decoded.detail}`);
        this.got.push(decoded.message);
      },
      onEnd: (end) => { this.ended = end; },
    });
    return this;
  }

  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", REMOTE);
    if (!encoded.ok) throw new Error(encoded.detail);
    this.link.send("control", encoder.encode(encoded.text));
  }

  /** A frame the device's own encoder would refuse (local-only, a token), sent as raw JSON. */
  sendRaw(value: unknown): void { this.link.send("control", encoder.encode(JSON.stringify(value))); }

  async hello(extra: Record<string, unknown> = {}): Promise<MessageOf<"welcome">> {
    await this.link.established;
    this.sendRaw({ t: "hello", deviceId: this.member, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [], ...extra });
    return this.wait((m): m is MessageOf<"welcome"> => m.t === "welcome", "welcome");
  }

  wait<T extends Message>(match: (message: Message) => message is T, what: string, ms?: number): Promise<T> {
    return waitFor(() => this.got.find(match) as T | undefined, what, ms);
  }

  slot(target: string, n?: number): Slot {
    const next = n ?? (this.n.get(target) ?? 0) + 1;
    this.n.set(target, Math.max(next, this.n.get(target) ?? 0));
    return { origin: this.member, originEpoch: EPOCH, target: target as Slot["target"], n: next };
  }

  cmd(slot: Slot, cmd: Command): void {
    this.send({ t: "cmd", slot, floor: 1, inc: this.s.inc(), cmd } as Message);
  }

  result(slot: Slot): Promise<MessageOf<"cmd.result">> {
    return this.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === slot.n && m.slot.target === slot.target, `cmd.result of ${slot.target} #${slot.n}`);
  }

  async req(cmd: Command): Promise<MessageOf<"res">> {
    const req = `r${this.got.length}-${Math.random().toString(36).slice(2, 8)}`;
    this.send({ t: "req", req, cmd } as Message);
    return this.wait((m): m is MessageOf<"res"> => m.t === "res" && m.req === req, `res ${req}`);
  }

  bye(): Promise<MessageOf<"bye">> { return this.wait((m): m is MessageOf<"bye"> => m.t === "bye", "bye"); }
}

async function paired(s: Server, scope?: Array<"read" | "reply" | "approve" | "manage">): Promise<{ device: Device; keys: Awaited<ReturnType<typeof deviceKeys>> }> {
  const keys = await deviceKeys();
  await s.roster.addDevice({ keys: keys.keys, name: "Phone", ...(scope ? { scope } : {}) });
  const device = new Device(s, keys.member).dial(keys);
  await device.hello();
  return { device, keys };
}

const bot = `bot:${BOT}` as StreamId;

describe("a paired device over an in-memory transport", () => {
  it("chat.send → cmd.result{applied} and the bot stream's entries; reads on the allowlist are answered", async () => {
    const s = await server();
    const { device } = await paired(s);
    expect(s.remote.open).toHaveLength(1);
    expect(s.remote.open[0]!.memberId).toBe(device.member);
    const welcome = device.got.find((m) => m.t === "welcome") as MessageOf<"welcome">;
    expect(welcome).toMatchObject({ serverId: s.serverId, protocol: { min: 1, max: 1 }, servers: [expect.objectContaining({ state: "live" })] });

    device.send({ t: "sub", stream: `srv:${s.serverId}` as StreamId, cursor: null } as Message);
    const snap = await device.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === `srv:${s.serverId}`, "srv snap");
    expect(snap.logId).toBe(s.inc());
    device.send({ t: "sub", stream: bot, cursor: null } as Message);
    await device.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === bot, "bot snap");

    const slot = device.slot(bot);
    device.cmd(slot, { type: "chat.send", botId: BOT, text: "hello from the phone" });
    const result = await device.result(slot);
    expect(result.outcome.kind).toBe("applied");
    const finished = await waitFor(() => device.got.some((m) => m.t === "batch" && m.stream === bot && m.entries.some((e) => e.kind === "turn.finished")), "turn.finished batch");
    expect(finished).toBe(true);
    const kinds = device.got.filter((m): m is MessageOf<"batch"> => m.t === "batch" && m.stream === bot).flatMap((m) => m.entries.map((e) => e.kind));
    expect(kinds).toEqual(expect.arrayContaining(["message.added", "turn.queued", "turn.started", "cmd.applied", "turn.finished"]));
    const userLine = s.entries(bot).find((e) => e.kind === "message.added" && (e.body as { message: { role: string } }).message.role === "user");
    expect(userLine?.slot).toEqual(slot);
    // The same command again is a duplicate: the stored outcome, applied once.
    device.cmd(slot, { type: "chat.send", botId: BOT, text: "hello from the phone" });
    await waitFor(() => device.got.filter((m) => m.t === "cmd.result" && m.slot.n === slot.n).length === 2 || null, "duplicate result");
    expect(s.entries(bot).filter((e) => e.kind === "cmd.applied")).toHaveLength(1);

    const snapshot = await device.req({ type: "chat.snapshot", botId: BOT });
    expect(snapshot.ok).toBe(true);
    // Live and catch-up frames are all for streams the device subscribed to.
    expect(device.got.filter((m) => "stream" in m).every((m) => [bot, `srv:${s.serverId}`].includes((m as { stream: string }).stream))).toBe(true);
  });

  it("a read-only device's chat.send → cmd.result{refused, scope}: the refusal is in the log, nothing applied", async () => {
    const s = await server();
    const { device } = await paired(s, ["read"]);
    const slot = device.slot(bot);
    device.cmd(slot, { type: "chat.send", botId: BOT, text: "may I?" });
    const result = await device.result(slot);
    expect(result.outcome).toMatchObject({ kind: "refused", reason: "scope" });
    expect((result.outcome as { detail?: string }).detail).toMatch(/reply/);
    const refused = s.entries(bot).find((e) => e.kind === "cmd.refused");
    expect(refused).toMatchObject({ body: { reason: "scope" }, slot });
    expect(s.entries(bot).some((e) => e.kind === "message.added")).toBe(false);
    // It still reads: the stream and the allowlisted reads.
    device.send({ t: "sub", stream: bot, cursor: null } as Message);
    await device.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === bot, "bot snap");
    expect((await device.req({ type: "chat.snapshot", botId: BOT })).ok).toBe(true);
    // The next slot still applies in order once allowed: the refused one counted (FIFO, no gap).
    expect(s.runtime.slots.next(s.store.openReader(), { origin: device.member, originEpoch: EPOCH, target: bot })).toBe(2);
  });

  it("settings.set of a machine-security key is refused remotely even with manage, and its handler never runs", async () => {
    const s = await server();
    const { device } = await paired(s, ["read", "reply", "approve", "manage"]);
    const srv = `srv:${s.serverId}`;
    const machine = device.slot(srv);
    device.cmd(machine, { type: "settings.set", change: { key: "claudeBypassPermissions", value: true } });
    expect((await device.result(machine)).outcome).toMatchObject({ kind: "refused", reason: "scope", detail: expect.stringMatching(/desktop window/) });
    const plain = device.slot(srv);
    device.cmd(plain, { type: "settings.set", change: { key: "language", value: "en" } });
    expect((await device.result(plain)).outcome).toEqual({ kind: "applied", result: { changed: "language" } });
    // A legacy `manage` command runs its handler with `manage`…
    const enable = device.slot(srv);
    device.cmd(enable, { type: "plugins.enable", name: "botling.routines", enabled: false });
    expect((await device.result(enable)).outcome.kind).toBe("applied");
    expect(s.engine.runs.filter((cmd) => cmd.type === "plugins.enable")).toHaveLength(1);

    // …and without `manage` (the default scope) a plain key and that legacy command are refused, the handler not run.
    const { device: phone } = await paired(s);
    const denied = phone.slot(srv);
    phone.cmd(denied, { type: "settings.set", change: { key: "language", value: "zh-Hant" } });
    expect((await phone.result(denied)).outcome).toMatchObject({ kind: "refused", reason: "scope" });
    const legacy = phone.slot(srv);
    phone.cmd(legacy, { type: "plugins.enable", name: "botling.routines", enabled: true });
    expect((await phone.result(legacy)).outcome).toMatchObject({ kind: "refused", reason: "scope", detail: expect.stringMatching(/manage/) });
    // A command that needs this machine (an app command: updates) is refused the same way.
    const app = phone.slot(srv);
    phone.cmd(app, { type: "updates.check", manual: true });
    expect((await phone.result(app)).outcome).toMatchObject({ kind: "refused", reason: "scope" });
    expect(s.engine.runs.filter((cmd) => cmd.type === "plugins.enable")).toHaveLength(1);
    expect(s.engine.runs.some((cmd) => cmd.type === "updates.check")).toBe(false);
  });

  it("req outside the allowlist is refused (forbidden); local-only frames, a foreign origin and a token end the session", async () => {
    const s = await server();
    const { device } = await paired(s, ["read", "reply", "approve", "manage"]);
    for (const cmd of [
      { type: "plugins.list" }, { type: "settings.get" }, { type: "doctor.run", includeLatest: false }, { type: "chat.send", botId: BOT, text: "no" }, { type: "mobile.view" },
    ] as Command[]) {
      expect(REMOTE_READS.has(cmd.type)).toBe(false);
      const res = await device.req(cmd);
      expect(res, cmd.type).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(s.engine.runs.some((cmd) => ["plugins.list", "settings.get", "doctor.run"].includes(cmd.type))).toBe(false);
    expect((await device.req({ type: "routines.list", botId: BOT } as Command)).ok).toBe(true);

    // content.open is a local-socket row: bye{role}, and the session ends.
    device.sendRaw({ t: "content.open", req: "c1", owner: s.serverId, id: "sha256:" + "a".repeat(64), variant: "original", entry: { stream: bot, seq: 1 } });
    expect(await device.bye()).toMatchObject({ reason: "role" });
    await waitFor(() => device.ended, "the device's link ends");
    expect(s.remote.open).toHaveLength(0);

    const cases: Array<[string, (d: Device) => void | Promise<void>]> = [
      ["admin", (d) => d.sendRaw({ t: "admin", req: "a1", op: { type: "devices" } })],
      ["a foreign origin", (d) => d.cmd({ origin: "desktop", originEpoch: EPOCH, target: bot, n: 1 }, { type: "chat.send", botId: BOT, text: "as someone else" })],
      ["a foreign cancel", (d) => d.send({ t: "cancel", slot: { origin: "desktop", originEpoch: EPOCH, target: bot, n: 1 } } as Message)],
    ];
    for (const [what, act] of cases) {
      const { device: d } = await paired(s);
      await act(d);
      expect(await d.bye(), what).toMatchObject({ reason: "role" });
    }
    expect(s.entries(bot).some((e) => e.kind === "message.added")).toBe(false);

    // The hello: a token (local socket only), or another member's id.
    for (const extra of [{ token: "t".repeat(32) }, { deviceId: "desktop" }]) {
      const keys = await deviceKeys();
      await s.roster.addDevice({ keys: keys.keys, name: "Tablet" });
      const d = new Device(s, keys.member).dial(keys);
      await d.link.established;
      d.sendRaw({ t: "hello", deviceId: keys.member, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [], ...extra });
      expect(await d.bye()).toMatchObject({ reason: "role" });
      expect(d.got.some((m) => m.t === "welcome")).toBe(false);
    }
  });
});

describe("revocation (§4.6)", () => {
  it("the roster's change ends the session at once: bye{revoked} reaches the device; a later copy of its commands is refused", async () => {
    const s = await server();
    const { device, keys } = await paired(s);
    // Slot 2 before slot 1: held ahead in memory, not applied.
    const second = device.slot(bot, 2);
    device.cmd(second, { type: "chat.send", botId: BOT, text: "second" });
    await waitFor(() => s.runtime.slots.heldCount() === 1 || null, "slot 2 held");
    await s.roster.revokeDevice(device.member);
    expect(await device.bye()).toMatchObject({ reason: "revoked" });
    await waitFor(() => device.ended, "the device's link ends");
    expect(s.remote.of(device.member)).toHaveLength(0);
    // Slot 1 arrives later (a forwarding server's copy): refused{origin}; the held slot 2 is then decided: refused too.
    const first: CmdBody = { slot: device.slot(bot, 1), floor: 1, inc: s.inc() as CmdBody["inc"], cmd: { type: "chat.send", botId: BOT, text: "first" } };
    const status = await s.runtime.receive(first, { scope: statedScope(first.cmd as Command) });
    expect(status).toMatchObject({ status: "result", message: { outcome: { kind: "refused", reason: "origin" } } });
    await waitFor(() => s.entries(bot).filter((e) => e.kind === "cmd.refused").length === 2 || null, "both slots refused");
    expect(s.entries(bot).filter((e) => e.kind === "cmd.refused").map((e) => [e.slot?.n, e.body.reason])).toEqual([[1, "origin"], [2, "origin"]]);
    expect(s.entries(bot).some((e) => e.kind === "message.added" || e.kind === "cmd.applied")).toBe(false);
    // D73: a new handshake from the known revoked key proves the key and gets bye{revoked}; nothing is opened or registered.
    const again = new Device(s, device.member).dial(keys);
    await again.link.established;
    expect(await again.bye()).toMatchObject({ reason: "revoked" });
    await waitFor(() => again.ended, "the revoked device's link ends");
    expect(s.remote.open).toHaveLength(0);
    expect(again.session.isOpen).toBe(false);
    expect(again.session.link.delivered).toBe(0);
  });

  it("D73: a revoked device sending hello right after the handshake gets bye{revoked} and no welcome; a wrong key or unknown key gets nothing", async () => {
    const s = await server();
    const { device, keys } = await paired(s);
    await s.roster.revokeDevice(device.member);
    await device.bye();

    // Known revoked key sends hello right after established: gets bye{revoked}, never welcomed.
    const revokedHello = new Device(s, device.member).dial(keys);
    await revokedHello.link.established;
    revokedHello.sendRaw({ t: "hello", deviceId: device.member, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [] });
    expect(await revokedHello.bye()).toMatchObject({ reason: "revoked" });
    await waitFor(() => revokedHello.ended, "revoked hello session ends");
    expect(revokedHello.got.some((m) => m.t === "welcome")).toBe(false);
    expect(s.remote.open).toHaveLength(0);

    // Known revoked memberId presenting a different DH key is refused silently at HS1 (no bye).
    const otherKeys = await deviceKeys();
    const imposter = new Device(s, device.member).dial({ ...otherKeys, member: device.member });
    await expect(imposter.link.established).rejects.toBeTruthy();
    await waitFor(() => imposter.session.link.ending, "imposter rejected at handshake");
    expect(imposter.session.link.ending).toMatchObject({ reason: "roster" });
    expect(imposter.got).toEqual([]);
    expect(imposter.session.link.delivered).toBe(0);

    // Unknown key gets nothing at HS1 (no bye).
    const strangerKeys = await deviceKeys();
    const stranger = new Device(s, strangerKeys.member).dial(strangerKeys);
    await expect(stranger.link.established).rejects.toBeTruthy();
    await waitFor(() => stranger.session.link.ending, "stranger rejected at handshake");
    expect(stranger.session.link.ending).toMatchObject({ reason: "roster" });
    expect(stranger.got).toEqual([]);
    expect(stranger.session.link.delivered).toBe(0);
  });

  it("D73: a device revoked via cascading server revocation also proves its key and gets bye{revoked}", async () => {
    const s = await server();
    const dir2 = `${root}/d${++folders}`;
    const store2 = await openServerStore(dir2);
    const id2 = await loadOrCreateServerIdentity(dir2, { create: true });
    await store2.submit((tx) => bindServerIdentity(tx, id2));
    const roster2 = await RosterStore.open(store2, id2);
    cleanups.push(() => store2.close());

    const addS2 = await s.roster.addServer({ keys: id2.keys, name: "Peer" });
    const addS2Stmt = s.roster.statements().find((st) => st.id === addS2.addId)!.statement;
    await roster2.joinCluster({
      add: addS2Stmt,
      roster: s.roster.statements().map((st) => st.statement),
      sponsor: { member: s.identity.memberId, keys: s.identity.keys, name: "Root" },
    });
    const keys = await deviceKeys();
    await roster2.addDevice({ keys: keys.keys, name: "Phone" });
    await s.roster.merge(roster2.statements().map((st) => st.statement));
    await s.roster.revokeServer(id2.memberId, true);

    const cascaded = new Device(s, keys.member).dial(keys);
    await cascaded.link.established;
    expect(await cascaded.bye()).toMatchObject({ reason: "revoked" });
    await waitFor(() => cascaded.ended, "cascaded revoked device's link ends");
    expect(s.remote.open).toHaveLength(0);
    expect(cascaded.session.link.delivered).toBe(0);
  });

  it("without the listener, the device's next frame ends the session; its commands after that never reach the runtime", async () => {
    const s = await server();
    const keys = await deviceKeys();
    await s.roster.addDevice({ keys: keys.keys, name: "Phone" });
    // A session whose roster never announces changes: only the per-frame check can see the revocation.
    const quiet: RemoteHost = { ...s.host, roster: { device: (m) => s.roster.device(m), clusterId: s.roster.clusterId, onChange: () => () => undefined } };
    const device = new Device(s, keys.member).dial(keys, (transport) => new RemoteSession(transport, "memory", quiet));
    await device.hello();
    const second = device.slot(bot, 2);
    device.cmd(second, { type: "chat.send", botId: BOT, text: "second" });
    await waitFor(() => s.runtime.slots.heldCount() === 1 || null, "slot 2 held");
    await s.roster.revokeDevice(device.member);
    expect(device.got.some((m) => m.t === "bye")).toBe(false);
    // Its next frame (slot 1, which would let slot 2 apply) ends the session instead.
    device.cmd(device.slot(bot, 1), { type: "chat.send", botId: BOT, text: "first" });
    expect(await device.bye()).toMatchObject({ reason: "revoked" });
    await waitFor(() => device.ended, "the device's link ends");
    await s.runtime.scope.submit(() => undefined);
    expect(s.entries(bot).some((e) => e.kind === "message.added" || e.kind === "cmd.applied" || e.kind === "cmd.refused")).toBe(false);
    expect(s.runtime.slots.next(s.store.openReader(), { origin: device.member, originEpoch: EPOCH, target: bot })).toBe(1);
  });
});

describe("the handshake and the link", () => {
  it("an unpaired key gets no session: the roster check refuses it, no frame is parsed, nothing registered", async () => {
    const s = await server();
    const keys = await deviceKeys();
    const device = new Device(s, keys.member).dial(keys);
    await expect(device.link.established).rejects.toBeTruthy();
    await waitFor(() => device.session.link.ending, "the server side ends");
    expect(device.session.link.ending).toMatchObject({ reason: "roster" });
    expect(device.session.isOpen).toBe(false);
    expect(device.session.link.delivered).toBe(0);
    expect(s.remote.open).toHaveLength(0);
    // Logged without the unproven claim's id (it was never authenticated).
    expect(s.logs).toContain("remote session ?: ended (roster: not a valid device)");
  });

  it("checkPeer has no side effect: a refused claim leaves the roster and the store as they were", async () => {
    const s = await server();
    const before = s.roster.statements().length;
    const rows = Number(s.store.openReader().prepare("SELECT count(*) AS n FROM entries").get()!.n);
    for (let i = 0; i < 3; i += 1) {
      const keys = await deviceKeys();
      const device = new Device(s, keys.member).dial(keys);
      await expect(device.link.established).rejects.toBeTruthy();
    }
    expect(s.roster.statements()).toHaveLength(before);
    expect(Number(s.store.openReader().prepare("SELECT count(*) AS n FROM entries").get()!.n)).toBe(rows);
  });

  it("keepalive: ping after the server's silence, bye{dead} when nothing is heard", async () => {
    const s = await server({ pingAfterMs: 60, deadAfterMs: 400 });
    const { device } = await paired(s);
    await device.wait((m): m is MessageOf<"ping"> => m.t === "ping", "ping", 2_000);
    expect(await device.bye()).toMatchObject({ reason: "dead" });
    await waitFor(() => device.ended, "the device's link ends");
    expect(s.remote.open).toHaveLength(0);
  });

  it("a device that keeps talking is not dead", async () => {
    const s = await server({ pingAfterMs: 60, deadAfterMs: 300 });
    const { device } = await paired(s);
    const started = Date.now();
    while (Date.now() - started < 900) { device.send({ t: "ping", at: Date.now() } as Message); await new Promise((resolve) => setTimeout(resolve, 50)); }
    expect(device.got.some((m) => m.t === "bye")).toBe(false);
    expect(device.session.isOpen).toBe(true);
  });

  it("back-pressure by queued bytes: live frames are skipped above the soft mark; a session that does not drain is dropped", async () => {
    const s = await server({ maxBuffered: 4 * LIVE_SOFT_BYTES });
    const { device } = await paired(s);
    const session = device.session;
    // Frames are sealed one at a time (WebCrypto is asynchronous): queued synchronously, they wait in the link.
    const filler = { t: "ping", at: 1 } as Message;
    while (session.queuedBytes <= LIVE_SOFT_BYTES) expect(session.send(filler)).toBe(true);
    expect(session.send({ t: "live", stream: bot, turnId: "t1", seg: 0, rev: 1, at: 0, text: "skipped" } as Message)).toBe(false);
    while (session.isOpen && session.send(filler)) { /* fill past maxBuffered */ }
    expect(session.isOpen).toBe(false);
    expect(s.logs.some((line) => /dropped, it does not read/.test(line))).toBe(true);
    // Nothing the device received was a live frame (the skipped one never left).
    expect(device.got.some((m) => m.t === "live")).toBe(false);
  });

  it("frames go out as UTF-8 JSON plaintext the device decodes with the remote role table", async () => {
    const s = await server();
    const { device } = await paired(s);
    expect(device.raw.length).toBeGreaterThan(0);
    for (const bytes of device.raw) expect(() => JSON.parse(decoder.decode(bytes))).not.toThrow();
  });
});

describe("the owner's slot check (slotAuthorize)", () => {
  it("local and admin pass; a device scope needs a valid origin whose roster scope allows the command", () => {
    const devices = new Map<string, { keys: { sign: string; dh: string }; scope: Array<"read" | "reply" | "approve" | "manage"> }>([
      ["phone", { keys: { sign: "s", dh: "d" }, scope: ["read", "reply"] }],
    ]);
    const authorize = slotAuthorize({ device: (m) => devices.get(m) ?? null });
    const slot = (origin: string): Slot => ({ origin, originEpoch: EPOCH, target: bot as Slot["target"], n: 1 });
    const send: Command = { type: "chat.send", botId: BOT, text: "x" };
    const tx = null as never;
    expect(authorize(tx, { slot: slot("desktop"), cmd: send, scope: "local" })).toBeNull();
    expect(authorize(tx, { slot: slot("phone"), cmd: send, scope: "reply" })).toBeNull();
    expect(authorize(tx, { slot: slot("stranger"), cmd: send, scope: "reply" })).toMatchObject({ reason: "origin" });
    expect(authorize(tx, { slot: slot("phone"), cmd: send, scope: "manage" })).toMatchObject({ reason: "scope" });
    expect(authorize(tx, { slot: slot("phone"), cmd: { type: "bots.remove", botId: BOT } as Command, scope: "manage" })).toMatchObject({ reason: "scope" });
    const bypass: Command = { type: "settings.set", change: { key: "claudeBypassPermissions", value: true } };
    expect(statedScope(bypass)).toBe("read");
    devices.set("admin-ish", { keys: { sign: "s", dh: "d" }, scope: ["read", "reply", "approve", "manage"] });
    expect(authorize(tx, { slot: slot("admin-ish"), cmd: bypass, scope: statedScope(bypass) })).toMatchObject({ reason: "scope" });
    expect(authorize(tx, { slot: slot("admin-ish"), cmd: { type: "mobile.pair" } as unknown as Command, scope: "read" })).toMatchObject({ reason: "scope" });
  });
});

// D58: one session is a FIFO stream; a dropped or reordered frame voids the session, and the owner commits one
// session's commands of a queue in send order. D59: every `cancel` is answered.
describe("D58: one session's commands commit in send order; a broken stream ends the session", () => {
  const cmdKinds = (s: Server) => s.entries(bot).filter((e) => e.kind.startsWith("cmd.")).map((e) => `${e.kind}#${e.slot?.n}`);

  it("back-to-back commands of one queue (slow legacy, legacy, intent) all commit, in slot order, in the same session", async () => {
    const s = await server();
    const { device } = await paired(s);
    const run = s.engine.run.bind(s.engine);
    // The first legacy handler is slow: before D58 the copies behind it were checked first, slot 2 (legacy) was dropped
    // unanswered and slot 3 waited behind it for good.
    let slow = true;
    s.engine.run = async (cmd: Command) => { if (slow && cmd.type === "waiting.ignore") { slow = false; await new Promise((r) => setTimeout(r, 40)); } return run(cmd); };
    const slots = [device.slot(bot), device.slot(bot), device.slot(bot)];
    device.cmd(slots[0]!, { type: "waiting.ignore", botId: BOT, text: "first" });
    device.cmd(slots[1]!, { type: "waiting.ignore", botId: BOT, text: "second" });
    device.cmd(slots[2]!, { type: "chat.send", botId: BOT, text: "third" });
    for (const slot of slots) expect((await device.result(slot)).outcome.kind).toBe("applied");
    expect(cmdKinds(s)).toEqual(["cmd.applied#1", "cmd.applied#2", "cmd.applied#3"]);
    expect(device.got.some((m) => m.t === "bye")).toBe(false);
    expect(s.runtime.slots.heldCount()).toBe(0);
  });

  /** Lets the test reorder or drop the device's frames on their way to the server. */
  function tap(device: Device): { frames: (edit: (frame: Uint8Array) => Uint8Array[]) => void } {
    const real = device.session;
    const receive = real.receive.bind(real);
    let editor: ((frame: Uint8Array) => Uint8Array[]) | null = null;
    real.receive = (frame: Uint8Array) => { for (const f of editor ? editor(frame) : [frame]) receive(f); };
    return { frames: (edit) => { editor = edit; } };
  }

  for (const [name, edit] of [
    ["reordered", (): ((frame: Uint8Array) => Uint8Array[]) => { let held: Uint8Array | null = null; return (frame) => { if (!held) { held = frame; return []; } return [frame, held]; }; }],
    ["dropped", (): ((frame: Uint8Array) => Uint8Array[]) => { let first = true; return (frame) => { if (first) { first = false; return []; } return [frame]; }; }],
  ] as const) {
    it(`a ${name} frame ends the session before any later command is opened; re-sent in order on a new session, they commit in order`, async () => {
      const s = await server();
      const { device, keys } = await paired(s);
      tap(device).frames(edit());
      const first = device.slot(bot), second = device.slot(bot);
      device.cmd(first, { type: "chat.send", botId: BOT, text: "one" });
      device.cmd(second, { type: "chat.send", botId: BOT, text: "two" });
      await waitFor(() => device.session.link.ending, "the server ends the session");
      expect(device.session.link.ending).toMatchObject({ reason: "order" });
      await s.runtime.scope.submit(() => undefined);
      // Slot 2 was never opened: nothing committed, nothing held ahead of the missing slot 1.
      expect(cmdKinds(s)).toEqual([]);
      expect(s.runtime.slots.heldCount()).toBe(0);
      // The front end re-attaches and re-sends its outbox in slot order.
      const again = new Device(s, device.member).dial(keys);
      await again.hello();
      again.cmd(first, { type: "chat.send", botId: BOT, text: "one" });
      again.cmd(second, { type: "chat.send", botId: BOT, text: "two" });
      expect((await again.result(first)).outcome.kind).toBe("applied");
      expect((await again.result(second)).outcome.kind).toBe("applied");
      expect(cmdKinds(s)).toEqual(["cmd.applied#1", "cmd.applied#2"]);
    });
  }

  it("a copy the owner cannot keep (a legacy copy ahead of its predecessor) ends the session instead of going unanswered", async () => {
    const s = await server();
    const { device } = await paired(s);
    // Slot 2 with slot 1 never sent: the session broke FIFO (a front end bug or a lost frame the link did not see).
    device.cmd(device.slot(bot, 2), { type: "waiting.ignore", botId: BOT, text: "second" });
    expect(await device.bye()).toMatchObject({ reason: "unsettled", detail: expect.stringMatching(/D58/) });
    await s.runtime.scope.submit(() => undefined);
    expect(cmdKinds(s)).toEqual([]);
  });
});

describe("D59: every cancel is answered", () => {
  it("a cancel ahead of its slot → cancel.noted (committed), then the slot is cmd.cancelled; a cancel too late → the stored cmd.result", async () => {
    const s = await server();
    const { device } = await paired(s);
    const first = device.slot(bot);
    device.send({ t: "cancel", slot: first } as Message);
    const noted = await device.wait((m): m is MessageOf<"cancel.noted"> => m.t === "cancel.noted", "cancel.noted");
    expect(noted.slot).toEqual(first);
    device.cmd(first, { type: "chat.send", botId: BOT, text: "never mind" });
    expect((await device.result(first)).outcome.kind).toBe("cancelled");
    expect(s.entries(bot).some((e) => e.kind === "message.added")).toBe(false);

    const second = device.slot(bot);
    device.cmd(second, { type: "chat.send", botId: BOT, text: "kept" });
    expect((await device.result(second)).outcome.kind).toBe("applied");
    device.send({ t: "cancel", slot: second } as Message);
    await waitFor(() => device.got.filter((m) => m.t === "cmd.result" && m.slot.n === second.n).length === 2 || null, "the stored result again");
    const answers = device.got.filter((m) => (m.t === "cmd.result" || m.t === "cancel.noted") && m.slot.n === second.n);
    expect(answers.map((m) => m.t)).toEqual(["cmd.result", "cmd.result"]);
    expect(answers[1]).toMatchObject({ outcome: { kind: "applied" } });
    expect(device.got.filter((m) => m.t === "cancel.noted")).toHaveLength(1);
  });
});

describe("F2 (D58): a command or cancel the server cannot settle ends the session (bye unsettled)", () => {
  const cmdKinds = (s: Server) => s.entries(bot).filter((e) => e.kind.startsWith("cmd.")).map((e) => `${e.kind}#${e.slot?.n}`);

  it("a store that fails on slot 1 ends the session; slot 2 of the same session is not processed there; the next session applies both once, in order", async () => {
    const s = await server();
    const { device, keys } = await paired(s);
    const receive = s.runtime.receive.bind(s.runtime);
    let fail = true;
    s.runtime.receive = async (body, options) => {
      if (fail && body.slot.n === 1) { fail = false; throw new Error("the store refused the transaction (test)"); }
      return receive(body, options);
    };
    const first = device.slot(bot), second = device.slot(bot);
    device.cmd(first, { type: "chat.send", botId: BOT, text: "one" });
    device.cmd(second, { type: "chat.send", botId: BOT, text: "two" });
    expect(await device.bye()).toMatchObject({ reason: "unsettled" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await s.runtime.scope.submit(() => undefined);
    expect(cmdKinds(s)).toEqual([]);
    expect(s.runtime.slots.heldCount()).toBe(0);
    expect(device.got.some((m) => m.t === "cmd.result")).toBe(false);

    const again = new Device(s, device.member).dial(keys);
    await again.hello();
    again.cmd(first, { type: "chat.send", botId: BOT, text: "one" });
    again.cmd(second, { type: "chat.send", botId: BOT, text: "two" });
    expect((await again.result(first)).outcome.kind).toBe("applied");
    expect((await again.result(second)).outcome.kind).toBe("applied");
    expect(cmdKinds(s)).toEqual(["cmd.applied#1", "cmd.applied#2"]);
  });

  it("a cmd handler that throws (before the runtime) ends the session with bye unsettled", async () => {
    const s = await server();
    const { device } = await paired(s);
    (device.session as unknown as { cmdScope: () => never }).cmdScope = () => { throw new Error("scope lookup failed (test)"); };
    device.cmd(device.slot(bot), { type: "chat.send", botId: BOT, text: "one" });
    expect(await device.bye()).toMatchObject({ reason: "unsettled" });
    await s.runtime.scope.submit(() => undefined);
    expect(cmdKinds(s)).toEqual([]);
  });

  it("a cancel the store cannot commit ends the session with bye unsettled (no answer is made up)", async () => {
    const s = await server();
    const { device } = await paired(s);
    s.runtime.slots.cancel = async () => { throw new Error("the store refused the transaction (test)"); };
    device.send({ t: "cancel", slot: device.slot(bot) } as Message);
    expect(await device.bye()).toMatchObject({ reason: "unsettled" });
    expect(device.got.some((m) => m.t === "cancel.noted" || m.t === "cmd.result")).toBe(false);
  });
});

describe("D59: a cancel after the slot's handler began is too late", () => {
  const cmdKinds = (s: Server) => s.entries(bot).filter((e) => e.kind.startsWith("cmd.")).map((e) => `${e.kind}#${e.slot?.n}`);
  const cancelRows = (s: Server) => s.store.submit((tx) => Number(tx.prepare("SELECT count(*) AS n FROM cancels").get()!.n));

  it("a cancel that arrives while a legacy handler runs waits for it and gets the stored cmd.result{applied}; the slot is never cancelled", async () => {
    const s = await server();
    const { device } = await paired(s);
    const run = s.engine.run.bind(s.engine);
    let started = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    s.engine.run = async (cmd: Command) => { if (cmd.type === "waiting.ignore") { started = true; await gate; } return run(cmd); };
    const first = device.slot(bot);
    device.cmd(first, { type: "waiting.ignore", botId: BOT, text: "slow" });
    await waitFor(() => started, "the handler started");
    device.send({ t: "cancel", slot: first } as Message);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Not answered yet (the outcome is not decided), and nothing was committed into `cancels`.
    expect(device.got.some((m) => m.t === "cancel.noted" || m.t === "cmd.result")).toBe(false);
    expect(await cancelRows(s)).toBe(0);
    release();
    await waitFor(() => device.got.filter((m) => m.t === "cmd.result" && m.slot.n === first.n).length === 2 || null, "the result and the cancel's answer");
    const answers = device.got.filter((m) => (m.t === "cmd.result" || m.t === "cancel.noted") && m.slot.n === first.n);
    expect(answers.map((m) => [m.t, (m as MessageOf<"cmd.result">).outcome?.kind])).toEqual([["cmd.result", "applied"], ["cmd.result", "applied"]]);
    expect(cmdKinds(s)).toEqual(["cmd.applied#1"]);
    expect(await cancelRows(s)).toBe(0);
  });

  it("a cancel that lands while a legacy copy's handler ran but its outcome was not stored waits for the re-send, then gets the real outcome", async () => {
    const s = await server();
    const { device, keys } = await paired(s);
    const runtime = s.runtime as unknown as { slots: { receive: (...a: unknown[]) => Promise<unknown> } };
    const receive = runtime.slots.receive.bind(runtime.slots);
    let fail = true;
    // The handler runs, then the store refuses the command that keeps its outcome (once).
    runtime.slots.receive = async (...args: unknown[]) => {
      if (fail) { fail = false; throw new Error("the store refused the transaction (test)"); }
      return receive(...args);
    };
    let runs = 0;
    const run = s.engine.run.bind(s.engine);
    s.engine.run = async (cmd: Command) => { if (cmd.type === "waiting.ignore") runs += 1; return run(cmd); };
    const first = device.slot(bot);
    device.cmd(first, { type: "waiting.ignore", botId: BOT, text: "ran once" });
    expect(await device.bye()).toMatchObject({ reason: "unsettled" });
    expect(runs).toBe(1);
    // The next session: the cancel comes first (it is not queued behind its cmd), the cmd's re-send after it.
    const again = new Device(s, device.member).dial(keys);
    await again.hello();
    again.send({ t: "cancel", slot: first } as Message);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(again.got.some((m) => m.t === "cancel.noted")).toBe(false);
    expect(await cancelRows(s)).toBe(0);
    again.cmd(first, { type: "waiting.ignore", botId: BOT, text: "ran once" });
    await waitFor(() => again.got.filter((m) => m.t === "cmd.result" && m.slot.n === first.n).length === 2 || null, "the result and the cancel's answer");
    expect(again.got.filter((m) => m.t === "cmd.result").map((m) => (m as MessageOf<"cmd.result">).outcome.kind)).toEqual(["applied", "applied"]);
    expect(cmdKinds(s)).toEqual(["cmd.applied#1"]);
  });

  it("intent commands have no such window: the decision and the apply are one transaction, so a cancel is either noted before it or too late after it", async () => {
    const s = await server();
    const { device } = await paired(s);
    const first = device.slot(bot);
    device.cmd(first, { type: "chat.send", botId: BOT, text: "one" });
    device.send({ t: "cancel", slot: first } as Message);
    await waitFor(() => device.got.filter((m) => (m.t === "cmd.result" || m.t === "cancel.noted") && m.slot.n === first.n).length === 2 || null, "two answers");
    const kinds = cmdKinds(s);
    const result = device.got.find((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === first.n)!;
    // Cancel first: noted, and the slot is cancelled when its cmd comes. Cmd first: applied, and the cancel gets that result.
    if (device.got.some((m) => m.t === "cancel.noted")) { expect(kinds).toEqual(["cmd.cancelled#1"]); expect(result.outcome.kind).toBe("cancelled"); }
    else { expect(kinds).toEqual(["cmd.applied#1"]); expect(device.got.filter((m) => m.t === "cmd.result").every((m) => (m as MessageOf<"cmd.result">).outcome.kind === "applied")).toBe(true); }
  });
});

describe("M4-01a M1: remote sessions never reach peerReads or peerLocate", () => {
  it("a remote session with spy peerReads / peerLocate never invokes them on content.get, content.credit, content.cancel, content.find, or close", async () => {
    const peerReadsCalls: string[] = [];
    const peerLocateCalls: unknown[] = [];
    const fakePeerReads = {
      get: async () => { peerReadsCalls.push("get"); },
      credit: () => { peerReadsCalls.push("credit"); },
      cancel: () => { peerReadsCalls.push("cancel"); },
      closeSession: () => { peerReadsCalls.push("closeSession"); },
    };
    const s = await server({}, {
      peerReads: () => { peerReadsCalls.push("peerReads"); return fakePeerReads as never; },
      peerLocate: async (m) => { peerLocateCalls.push(m); return null; },
    });
    const { device } = await paired(s);
    const id = `sha256:${"a".repeat(64)}`;
    const entry = { stream: bot, seq: 1 };

    // Over the encrypted link while open: RemoteSession handles content.get/credit/cancel itself and never touches peerReads.
    device.send({ t: "content.get", req: "rg1", owner: "peer-server-1", id, variant: "original", offset: 0, length: 64, entry });
    device.send({ t: "content.credit", req: "rg1", bytes: 1024 });
    device.send({ t: "content.cancel", req: "rg1" });
    await device.wait((m): m is MessageOf<"content.gone"> => m.t === "content.gone" && m.req === "rg1", "content.gone");

    // Defense in depth: even if content.find reaches SessionCore on a non-local session, kind.local blocks peerLocate.
    (device.session as unknown as { onMessage(m: Message): void }).onMessage({
      t: "content.find", req: "rf1", botId: BOT, line: "line-1", url: "file:///tmp/x.txt",
    });
    await waitFor(() => s.logs.some((l) => l.includes("cannot send content.found")), "content.found blocked on remote kind");

    // Closing a non-local session never calls peerReads().closeSession.
    device.session.close();
    await waitFor(() => device.ended, "ended");

    // Defense in depth: after close(), RemoteSession.onMessage falls through to SessionCore.onMessage; kind.local still blocks peerReads.
    const onMsg = (device.session as unknown as { onMessage(m: Message): void }).onMessage.bind(device.session);
    onMsg({ t: "content.get", req: "rg2", owner: "peer-server-1", id, variant: "original", offset: 0, length: 64, entry });
    onMsg({ t: "content.credit", req: "rg2", bytes: 1024 });
    onMsg({ t: "content.cancel", req: "rg2" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(peerReadsCalls).toEqual([]);
    expect(peerLocateCalls).toEqual([]);
  });
});
