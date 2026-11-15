// Botling 3 M4-24: Web Push triggers (protocol v1 §18.4, Q-P1..Q-P4).
// - Push ONLY when a bot owned by this server needs the user (an open approval or question card waits); never on
//   turn.finished, bot.updated, or waiting.updated alone.
// - Calls PushSender once per opening event per valid unrevoked device (never re-pushes on updates to an already-open
//   card, never pushes for closed/answered/ignored/queued/removed cards, and respects transaction rollbacks).
// - A device with an attached open RemoteSession (after hello/welcome) gets no push; local desktop socket sessions do
//   not suppress pushes to paired devices, and multi-tab devices stay suppressed until their last tab disconnects.
// - Wired into Botlingd end-to-end with fake-claude `/choices` and `/tool` cards.
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { BotView, MessageView } from "../../src/contract";
import {
  encodeFrame,
  encodePushSubscription,
  decodeFrame,
  FrameSplitter,
  fromBase64Url,
  packFrame,
  toBase64Url,
  type DeviceScope,
  type Message,
  type MessageOf,
  type PushSubscription,
  type SessionKind,
  type VapidKeys,
} from "../../src/protocol";
import { Botlingd } from "../../src/server/botlingd";
import { effectCheckpointSink } from "../../src/server/effects";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity, writeVapidKeys } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { attachedDeviceIds, DEFAULT_PUSH_COALESCE_MS, parseRetryAfterMs, PushSender, PushTriggers, type PushAlert, type PushSendReport, type PushTransport } from "../../src/server/push";
import { RosterStore } from "../../src/server/roster";
import { RemoteSession, RemoteSessions, Session, SessionHost, slotAuthorize, type RemoteHost, type SessionOptions } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore } from "../../src/server/store";
import { generateDhKeyPair, SessionLink, type SessionEnd, type SessionTransport } from "../../src/session";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { desktop, until } from "../helpers";

const root = testRoot("push-triggers");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const REMOTE: SessionKind = { local: false };
const LOCAL: SessionKind = { local: true };
const EPOCH = "0123456789abcdef0123456789abcdef";
const TOKEN = "local-test-token-for-push-triggers";
const OWNED_BOT = "6A0B0000-0000-4000-8000-000000000001";
const PEER_BOT = "6A0B0000-0000-4000-8000-000000000002";
const encoder = new TextEncoder();

let seq = 0;
function makeTempDir(): string {
  const dir = join(root, `d${++seq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function generateTestVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  const rawPub = Buffer.concat([Buffer.from([4]), Buffer.from(pubJwk.x, "base64url"), Buffer.from(pubJwk.y, "base64url")]);
  return { publicKey: toBase64Url(rawPub), privateKey: privJwk.d };
}

function makeDevicePushKeys(seedAuth = 1): { p256dh: string; auth: string; privateKey: Buffer } {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, seedAuth);
  return {
    p256dh: toBase64Url(ecdh.getPublicKey()),
    auth: toBase64Url(auth),
    privateKey: ecdh.getPrivateKey(),
  };
}

function decryptAes128Gcm(body: Uint8Array, uaPrivateKey: Uint8Array, uaPublicKey: Uint8Array, authSecret: Uint8Array): Uint8Array {
  const salt = body.subarray(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(16, false);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);

  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(uaPrivateKey);
  const shared = ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\x00", "ascii"), uaPublicKey, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\x00", "ascii"), 16));
  const baseNonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\x00", "ascii"), 12));

  const records: Buffer[] = [];
  let offset = 21 + idlen;
  let block = 0;
  while (offset < body.length) {
    const end = Math.min(offset + rs, body.length);
    const chunk = body.subarray(offset, end);
    const ciphertext = chunk.subarray(0, chunk.length - 16);
    const tag = chunk.subarray(chunk.length - 16);
    const nonce = Buffer.from(baseNonce);
    let carry = block;
    for (let i = 11; i >= 0 && carry > 0; i--) {
      nonce[i] ^= carry & 0xff;
      carry >>>= 8;
    }
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(tag);
    const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    let delimIdx = padded.length - 1;
    while (delimIdx >= 0 && padded[delimIdx] === 0) delimIdx--;
    records.push(padded.subarray(0, delimIdx));
    offset = end;
    block++;
  }
  return Buffer.concat(records);
}

type FakePushResponse = { status: number; headers?: Record<string, string> };
type FakePushResponder = (req: {
  url: string;
  origin: string;
  method: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}) => FakePushResponse | Promise<FakePushResponse>;

async function startFakePushServer(responder?: FakePushResponder) {
  const received: Array<{ url: string; origin: string; method: string; headers: IncomingHttpHeaders; body: Buffer; at: number }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const originHeader = req.headers["x-test-origin"];
      const origin = typeof originHeader === "string" ? originHeader : "https://push.example";
      const entry = { url: req.url ?? "/", origin, method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks), at: Date.now() };
      received.push(entry);
      const reply = responder ? await responder(entry) : { status: 201 };
      if (reply.headers) {
        for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
      }
      res.statusCode = reply.status;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const transport: PushTransport = (req) => new Promise((resolve, reject) => {
    const parsed = new URL(req.url);
    const localReq = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: { ...req.headers, "x-test-origin": parsed.origin },
      },
      (res) => {
        const rawRetryAfter = res.headers["retry-after"];
        const retryAfter = Array.isArray(rawRetryAfter) ? rawRetryAfter[0] : rawRetryAfter;
        res.destroy();
        resolve(retryAfter ? { status: res.statusCode ?? 0, retryAfter } : { status: res.statusCode ?? 0 });
      },
    );
    localReq.on("error", reject);
    localReq.end(req.body);
  });

  return { received, transport };
}

class ViewEngine extends FakeTurnEngine {
  readonly views = new Map<string, BotView>();
  override botView(botId: string): BotView | null {
    return this.views.get(botId) ?? null;
  }
}

function makeBotView(id: string, name: string, over: Partial<BotView> = {}): BotView {
  return {
    id,
    name,
    role: "manager",
    avatar: "circle",
    folder: "/work/projects/test",
    phase: "awake",
    working: false,
    approvals: 0,
    unread: 0,
    subagents: 0,
    problem: null,
    heads: ["claude"],
    job: null,
    subagentRows: [],
    ...over,
  };
}

function makeMessage(id: string, over: Partial<MessageView> = {}): MessageView {
  return {
    id,
    role: "bot",
    text: "Default bot message",
    time: new Date().toISOString(),
    ...over,
  };
}

async function deviceAuth() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await generateDhKeyPair();
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  return {
    dh,
    keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) },
  };
}

class DeviceClient {
  readonly got: Message[] = [];
  ended: SessionEnd | null = null;
  link!: SessionLink;
  session!: RemoteSession;

  constructor(
    private readonly remote: RemoteSessions,
    private readonly clusterId: string,
    private readonly serverIdentity: { memberId: string; dhPub: Uint8Array },
    private readonly member: string,
  ) {}

  dial(keys: Awaited<ReturnType<typeof deviceAuth>>): this {
    const toDevice: SessionTransport = {
      send: (frame) => this.link.receive(frame),
      close: () => { void (this.link?.received() ?? Promise.resolve()).then(() => { setTimeout(() => this.link.transportClosed(), 0); }); },
    };
    this.session = this.remote.accept(toDevice, "memory");
    const toServer: SessionTransport = {
      send: (frame) => this.session.receive(frame),
      close: () => { void this.session.link.received().then(() => { setTimeout(() => this.session.transportClosed(), 0); }); },
    };
    this.link = SessionLink.initiate(toServer, {
      mode: "ik",
      transport: "memory",
      cluster: this.clusterId,
      self: { memberId: this.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
      responder: this.serverIdentity,
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
    return until(() => this.got.find((m): m is MessageOf<"welcome"> => m.t === "welcome") ?? null, { timeout: 5_000, what: "welcome" });
  }

  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", REMOTE);
    if (!encoded.ok) throw new Error(encoded.detail);
    this.link.send("control", encoder.encode(encoded.text));
  }

  sendRaw(value: unknown): void {
    this.link.send("control", encoder.encode(JSON.stringify(value)));
  }

  async disconnect(): Promise<void> {
    this.session.close();
    await until(() => (this.session.isOpen ? null : true), { timeout: 5_000, what: "session closed" });
  }
}

class FakeLocalSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly writes: Uint8Array[] = [];
  write(bytes: Uint8Array): boolean { this.writes.push(bytes); return true; }
  end(): void { this.destroyed = true; this.emit("close"); }
  destroy(): void { this.destroyed = true; this.emit("close"); }
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

async function setupHarness(options: {
  ownedBots?: string[];
  withVapid?: boolean;
  sessionOptions?: SessionOptions;
  responder?: FakePushResponder;
  coalesceMs?: number;
  backoffBaseMs?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
  now?: () => number;
  random?: () => number;
  sender?: Pick<PushSender, "notify">;
} = {}) {
  const dir = makeTempDir();
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const logs: string[] = [];
  const roster = await RosterStore.open(store, identity, { log: (line) => logs.push(line) });
  const setup = new ClusterSetup(roster);
  const started = await setup.begin();
  expect((await setup.confirm(started.code)).ok).toBe(true);

  if (options.withVapid !== false) {
    writeVapidKeys(dir, generateTestVapidKeys());
  }

  const fakePush = await startFakePushServer(options.responder);
  const ownedBots = options.ownedBots ?? [OWNED_BOT];
  const engine = new ViewEngine({ bots: ownedBots, hold: true });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });

  let triggers: PushTriggers | null = null;
  let remote: RemoteSessions | null = null;

  const runtime = new IntentRuntime({
    store,
    engine,
    hub,
    live,
    log: (line) => logs.push(line),
    authorize: slotAuthorize(roster),
    serverEvents: "all",
    mirrorBotUpdates: true,
    tapHooks: {
      eventStored: (tx, event) => triggers?.stored(tx, event),
    },
  });

  const sender = options.sender ?? new PushSender({
    dataDir: dir,
    ownsBot: (botId) => engine.hasBot(botId),
    roster,
    transport: fakePush.transport,
    ...(options.now ? { now: options.now } : {}),
    log: (line) => logs.push(line),
  });

  triggers = new PushTriggers({
    scope: runtime.scope,
    sender,
    roster,
    canPushDevice: (member) => {
      const dev = roster.device(member);
      return !!dev && (dev.scope ?? []).includes("read");
    },
    reader: () => hub.reader(),
    botName: (botId) => engine.botView(botId)?.name ?? null,
    attachedDevices: () => (remote ? attachedDeviceIds(remote.open) : []),
    ...(options.coalesceMs !== undefined ? { coalesceMs: options.coalesceMs } : {}),
    ...(options.backoffBaseMs !== undefined ? { backoffBaseMs: options.backoffBaseMs } : {}),
    ...(options.maxBackoffMs !== undefined ? { maxBackoffMs: options.maxBackoffMs } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.random ? { random: options.random } : {}),
    log: (line) => logs.push(line),
  });

  await runtime.start();

  const shell = new ShellBridge();
  const sessionHost: SessionHost = {
    serverId,
    serverName: "Test server",
    startedAt: Date.now(),
    minFeVersion: "3.0.0",
    token: () => TOKEN,
    hub,
    live,
    runtime,
    engine,
    content: null,
    shell,
    nextFor: () => ({}),
    ensureBotStream: async (botId) => {
      if (!engine.hasBot(botId)) return false;
      await store.submit((tx) => {
        // ensureBot handled in IntentRuntime on first event
        void tx;
      });
      return true;
    },
    log: (line) => logs.push(line),
    roster,
    self: { dhPub: identity.dhPub },
  };

  const remoteHost: RemoteHost = {
    ...sessionHost,
    roster,
    self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey },
  };
  remote = new RemoteSessions(remoteHost, options.sessionOptions);

  cleanups.push(async () => {
    triggers?.close();
    await triggers?.idle();
    remote?.close();
    await runtime.scope.submit(() => undefined);
    engine.close();
    runtime.close();
    shell.close();
    live.close();
    hub.close();
    await roster.idle();
    await store.close();
  });

  const addDevice = async (name: string, seed: number, devOpts: { scope?: readonly DeviceScope[]; origin?: string } = {}) => {
    const auth = await deviceAuth();
    const devKeys = makeDevicePushKeys(seed);
    const origin = devOpts.origin ?? "https://push.example";
    const sub: PushSubscription = {
      endpoint: `${origin}/sub/${name}-cap-${seed}`,
      keys: { p256dh: devKeys.p256dh, auth: devKeys.auth },
    };
    const added = await roster.addDevice({
      name,
      keys: auth.keys,
      ...(devOpts.scope ? { scope: devOpts.scope } : {}),
    });
    await roster.writeProfile(added.member, "push", encodePushSubscription(sub));
    return { memberId: added.member, auth, devKeys, sub };
  };

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await runtime.scope.submit(() => undefined);
    }
    await triggers!.idle();
  };

  return {
    dir,
    store,
    identity,
    roster,
    engine,
    hub,
    runtime,
    sender,
    triggers,
    remote,
    sessionHost,
    fakePush,
    logs,
    addDevice,
    settle,
    connectDevice: (member: string, auth: Awaited<ReturnType<typeof deviceAuth>>) =>
      new DeviceClient(remote!, roster.clusterId!, { memberId: identity.memberId, dhPub: identity.dhPub }, member).dial(auth),
  };
}

describe("M4-24 PushTriggers: event selection and deduplication", () => {
  it("pushes once per valid unrevoked device on an open approval card, never to revoked devices and never leaking text", async () => {
    const h = await setupHarness();
    const d1 = await h.addDevice("phone1", 11);
    const d2 = await h.addDevice("phone2", 22);
    const dRevoked = await h.addDevice("stolen", 33);
    await h.roster.revokeDevice(dRevoked.memberId);

    h.engine.views.set(OWNED_BOT, makeBotView(OWNED_BOT, "Researcher", { approvals: 1 }));
    h.engine.emit({ type: "bot.updated", bot: makeBotView(OWNED_BOT, "Researcher", { approvals: 1 }) });
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("card-approval-1", {
        text: "Wants to use Bash: rm -rf /secret/path",
        approval: { tool: "Bash", expires: null },
        choices: [
          { label: "Allow once", recommended: true, action: "allowOnce", detail: null },
          { label: "Don't allow", recommended: false, action: "deny", detail: null },
        ],
      }),
    });

    await h.settle();
    expect(h.fakePush.received).toHaveLength(2);
    const urls = h.fakePush.received.map((r) => r.url).sort();
    expect(urls).toEqual([`/sub/phone1-cap-11`, `/sub/phone2-cap-22`]);

    const req1 = h.fakePush.received.find((r) => r.url === `/sub/phone1-cap-11`)!;
    const plain1 = JSON.parse(Buffer.from(
      decryptAes128Gcm(req1.body, d1.devKeys.privateKey, fromBase64Url(d1.sub.keys.p256dh)!, fromBase64Url(d1.sub.keys.auth)!),
    ).toString("utf8"));
    expect(plain1).toEqual({
      v: 1,
      kind: "needs-you",
      botId: OWNED_BOT,
      botName: "Researcher",
    });

    const req2 = h.fakePush.received.find((r) => r.url === `/sub/phone2-cap-22`)!;
    const plain2 = JSON.parse(Buffer.from(
      decryptAes128Gcm(req2.body, d2.devKeys.privateKey, fromBase64Url(d2.sub.keys.p256dh)!, fromBase64Url(d2.sub.keys.auth)!),
    ).toString("utf8"));
    expect(plain2).toEqual({
      v: 1,
      kind: "needs-you",
      botId: OWNED_BOT,
      botName: "Researcher",
    });
  });

  it("pushes once when a plain message becomes an open question card, skips duplicate updates while open, and ignores answered/ignored/queued cards", async () => {
    const h = await setupHarness({ coalesceMs: 0 });
    await h.addDevice("phone1", 11);

    h.engine.emit({ type: "bot.updated", bot: makeBotView(OWNED_BOT, "Helper") });

    // Plain reply first (not a card yet): no push.
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("msg-q1", { text: "Let me check..." }),
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(0);

    // Same message updated to become an open question card -> 1 push.
    const openQuestionCard = makeMessage("msg-q1", {
      text: "Which database should I use?",
      choices: [
        { label: "SQLite", recommended: true, detail: null, action: null },
        { label: "Postgres", recommended: false, detail: null, action: null },
      ],
      questions: [
        {
          question: "Which database should I use?",
          multiple: false,
          options: [
            { label: "SQLite", recommended: true, detail: null, action: null },
            { label: "Postgres", recommended: false, detail: null, action: null },
          ],
        },
      ],
    });
    h.engine.emit({ type: "message.updated", botId: OWNED_BOT, message: openQuestionCard });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(1);

    // Another message.updated while the card is STILL open -> NO duplicate push.
    h.engine.emit({
      type: "message.updated",
      botId: OWNED_BOT,
      message: { ...openQuestionCard, text: "Which database should I use? (updated)" },
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(1);

    // Answering the card (chosen: 0) -> NO push.
    h.engine.emit({
      type: "message.updated",
      botId: OWNED_BOT,
      message: { ...openQuestionCard, chosen: 0, answer: "SQLite" },
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(1);

    // A queued card (waiting for a called-in bot, not waiting on user yet) -> NO push.
    const queuedCard = makeMessage("msg-q2", {
      text: "Called-in question",
      choices: [{ label: "Yes", recommended: true, detail: null, action: null }],
      queued: true,
    });
    h.engine.emit({ type: "message.added", botId: OWNED_BOT, message: queuedCard });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(1);

    // Once un-queued (now open and waiting on user) -> 1 push.
    h.engine.emit({
      type: "message.updated",
      botId: OWNED_BOT,
      message: { ...queuedCard, queued: false },
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(2);

    // Ignoring or removing the card -> NO push.
    h.engine.emit({
      type: "message.updated",
      botId: OWNED_BOT,
      message: { ...queuedCard, queued: false, ignoredAt: new Date().toISOString() },
    });
    h.engine.emit({ type: "message.removed", botId: OWNED_BOT, messageId: "msg-q2" });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(2);
  });

  it("does NOT push on turn.finished, turn.started, turn.steps, bot.updated, or waiting.updated (Q-P1)", async () => {
    const h = await setupHarness();
    await h.addDevice("phone1", 11);

    h.engine.emit({ type: "bot.updated", bot: makeBotView(OWNED_BOT, "Worker", { working: true, unread: 2, problem: "oops" }) });
    h.engine.emit({ type: "turn.started", botId: OWNED_BOT, turnId: "t1", messageId: "m1" });
    h.engine.emit({ type: "turn.delta", botId: OWNED_BOT, turnId: "t1", messageId: "m1", text: "Hello " });
    h.engine.emit({ type: "turn.steps", botId: OWNED_BOT, turnId: "t1", messageId: "m1", steps: [] });
    h.engine.emit({ type: "message.added", botId: OWNED_BOT, message: makeMessage("m1", { text: "All done!" }) });
    h.engine.emit({ type: "turn.finished", botId: OWNED_BOT, turnId: "t1", messageId: "m1", status: "done", text: "All done!" });
    h.engine.emit({ type: "waiting.updated", waiting: { items: [{ botId: OWNED_BOT, text: "memory item", messageId: null }], doing: {} } });

    await h.settle();
    expect(h.fakePush.received).toHaveLength(0);
  });
});

describe("M4-24 PushTriggers: attached page suppression, ownership, startup seed, and tx safety", () => {
  it("suppresses push for attached RemoteSession devices (multi-tab aware), resumes on disconnect, and ignores pre-hello or local sessions", async () => {
    const h = await setupHarness({ coalesceMs: 0 });
    const d1 = await h.addDevice("phone1", 11);
    const d2 = await h.addDevice("phone2", 22);

    // d1 has two open attached tabs (hello -> welcome).
    const tab1 = h.connectDevice(d1.memberId, d1.auth);
    await tab1.hello();
    const tab2 = h.connectDevice(d1.memberId, d1.auth);
    await tab2.hello();

    // d2 finished Noise handshake only (no hello yet) -> NOT attached yet.
    const d2Early = h.connectDevice(d2.memberId, d2.auth);
    await d2Early.link.established;

    // Local desktop socket session -> does NOT suppress remote paired devices.
    const localSocket = new FakeLocalSocket();
    const localSession = new Session(localSocket as unknown as import("node:net").Socket, h.sessionHost);
    cleanups.push(() => localSession.close());
    localSocket.feedRaw({ t: "hello", deviceId: "desktop", feVersion: "3.0.0", protocol: 1, token: TOKEN, originEpoch: EPOCH, cursors: {}, outbox: [], want: [] });
    await until(() => (localSession.isOpen ? true : null), { timeout: 5_000, what: "local hello" });

    // Card 1: d1 is excluded (attached), d2 receives push.
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("c1", { text: "Need answer 1", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await h.settle();
    expect(h.fakePush.received.map((r) => r.url)).toEqual([`/sub/phone2-cap-22`]);

    // Close d1 tab 1; tab 2 is still open -> d1 STILL excluded.
    await tab1.disconnect();
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("c2", { text: "Need answer 2", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await h.settle();
    expect(h.fakePush.received.map((r) => r.url)).toEqual([`/sub/phone2-cap-22`, `/sub/phone2-cap-22`]);

    // Close d1 tab 2 (d1 now detached) and finish hello on d2 (d2 now attached).
    await tab2.disconnect();
    await d2Early.hello();

    // Card 3: d2 is excluded, d1 now receives push.
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("c3", { text: "Need answer 3", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await h.settle();
    expect(h.fakePush.received.map((r) => r.url)).toEqual([
      `/sub/phone2-cap-22`,
      `/sub/phone2-cap-22`,
      `/sub/phone1-cap-11`,
    ]);
  });

  it("skips non-owned bots, seeds pre-existing open cards without re-pushing, and obeys rollback / same-tx close", async () => {
    const h = await setupHarness({ ownedBots: [OWNED_BOT], coalesceMs: 0 });
    await h.addDevice("phone1", 11);

    // Pre-existing open card stored before a new PushTriggers instance starts (simulating server restart).
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("pre-open", { text: "Existing question", choices: [{ label: "A", recommended: true, detail: null, action: null }] }),
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(1);

    // Replace triggers with a freshly seeded instance (using reader).
    const seededTriggers = new PushTriggers({
      scope: h.runtime.scope,
      sender: h.sender,
      reader: () => h.hub.reader(),
      botName: () => "Researcher",
    });
    // Non-transition message.updated on pre-open card -> 0 new pushes.
    await h.runtime.scope.submit((tx) => {
      seededTriggers.stored(tx, {
        type: "message.updated",
        botId: OWNED_BOT,
        message: makeMessage("pre-open", { text: "Existing question still open", choices: [{ label: "A", recommended: true, detail: null, action: null }] }),
      });
    });
    await seededTriggers.idle();
    expect(h.fakePush.received).toHaveLength(1);
    seededTriggers.close();

    // Non-owned (peer) bot event -> skipped by PushSender.ownsBot.
    h.engine.emit({
      type: "message.added",
      botId: PEER_BOT,
      message: makeMessage("peer-card", { text: "Peer question", choices: [{ label: "A", recommended: true, detail: null, action: null }] }),
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(1);

    // Rolled-back transaction -> openCards state reverted and no push sent.
    await expect(h.runtime.scope.submit((tx) => {
      h.triggers.stored(tx, {
        type: "message.added",
        botId: OWNED_BOT,
        message: makeMessage("rolled-back-card", { text: "Rollback?", choices: [{ label: "Yes", recommended: true, detail: null, action: null }] }),
      });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    await h.triggers.idle();
    expect(h.fakePush.received).toHaveLength(1);

    // Now the same card commits cleanly -> push IS sent once.
    await h.runtime.scope.submit((tx) => {
      h.triggers.stored(tx, {
        type: "message.added",
        botId: OWNED_BOT,
        message: makeMessage("rolled-back-card", { text: "Rollback?", choices: [{ label: "Yes", recommended: true, detail: null, action: null }] }),
      });
    });
    await h.triggers.idle();
    expect(h.fakePush.received).toHaveLength(2);

    // Card opened AND closed in the exact same transaction -> no push sent.
    await h.runtime.scope.submit((tx) => {
      h.triggers.stored(tx, {
        type: "message.added",
        botId: OWNED_BOT,
        message: makeMessage("same-tx-closed", { text: "Instant?", choices: [{ label: "Yes", recommended: true, detail: null, action: null }] }),
      });
      h.triggers.stored(tx, {
        type: "message.updated",
        botId: OWNED_BOT,
        message: makeMessage("same-tx-closed", { text: "Instant?", choices: [{ label: "Yes", recommended: true, detail: null, action: null }], chosen: 0 }),
      });
    });
    await h.triggers.idle();
    expect(h.fakePush.received).toHaveLength(2);
  });
});

describe("M4-24 Botlingd end-to-end wiring", () => {
  it("sends Web Push through Botlingd when fake-claude asks a /choices card while detached, and suppresses while attached", async () => {
    const dataDir = makeTempDir();
    const fakePush = await startFakePushServer();
    const logs: string[] = [];

    const daemon = await Botlingd.start({
      env: botlingdEnv(dataDir, {
        BOTLING_SERVER_PORT: "off",
        BOTLING_SERVER_BACKUP_CHECK_MS: "0",
      }),
      outDir: join(desktop, "out"),
      log: (line) => logs.push(line),
      pushTransport: fakePush.transport,
      pushCoalesceMs: 0,
    });
    cleanups.push(() => daemon.stop());

    const started = await daemon.cluster.begin();
    expect((await daemon.cluster.confirm(started.code)).ok).toBe(true);
    writeVapidKeys(dataDir, generateTestVapidKeys());

    const auth = await deviceAuth();
    const devKeys = makeDevicePushKeys(77);
    const sub: PushSubscription = {
      endpoint: "https://push.example/sub/e2e-phone",
      keys: { p256dh: devKeys.p256dh, auth: devKeys.auth },
    };
    const noReadAuth = await deviceAuth();
    const noReadKeys = makeDevicePushKeys(78);
    const noReadAdded = await daemon.roster.addDevice({ name: "ApproveOnly", keys: noReadAuth.keys, scope: ["approve"] });
    await daemon.roster.writeProfile(noReadAdded.member, "push", encodePushSubscription({
      endpoint: "https://push.example/sub/e2e-approve-only",
      keys: { p256dh: noReadKeys.p256dh, auth: noReadKeys.auth },
    }));

    const added = await daemon.roster.addDevice({ name: "Phone", keys: auth.keys });
    const serverIdentity = await loadOrCreateServerIdentity(dataDir, { create: false });

    // Attach via RemoteSessions, register push subscription with push.subscribe, then disconnect.
    const client1 = new DeviceClient(daemon.remote, daemon.roster.clusterId!, { memberId: serverIdentity.memberId, dhPub: serverIdentity.dhPub }, added.member).dial(auth);
    await client1.hello();
    client1.send({ t: "push.subscribe", ...sub });
    await until(() => daemon.roster.pushSubscription(added.member), { timeout: 5_000, what: "push subscription persisted" });
    await client1.disconnect();

    const mainId = daemon.core.mainBotId;
    const srvSnapLogId = daemon.hub.reader().prepare("SELECT logId FROM streams WHERE stream = ?").get(`srv:${daemon.serverId}`) as { logId: string };

    // Send `/choices` while detached -> fake-claude replies with a <choices> card -> Web Push sent!
    const res1 = await daemon.runtime.receive({
      slot: { origin: "desktop", originEpoch: EPOCH, target: `bot:${mainId}`, n: 1 },
      floor: 1,
      inc: srvSnapLogId.logId,
      cmd: { type: "chat.send", botId: mainId, text: "/choices Pick one" },
    }, { scope: "local" });
    expect(res1).toMatchObject({ status: "result", message: { outcome: { kind: "applied" } } });

    await until(() => (fakePush.received.length >= 1 ? fakePush.received[0] : null), { timeout: 20_000, what: "e2e choice push received" });
    expect(fakePush.received).toHaveLength(1);
    const plain = JSON.parse(Buffer.from(
      decryptAes128Gcm(fakePush.received[0].body, devKeys.privateKey, fromBase64Url(sub.keys.p256dh)!, fromBase64Url(sub.keys.auth)!),
    ).toString("utf8"));
    expect(plain).toMatchObject({ v: 1, kind: "needs-you", botId: mainId });
    expect(typeof plain.botName).toBe("string");
    expect(plain.botName.length).toBeGreaterThan(0);

    // Re-attach the device, then trigger another `/choices` card -> suppressed while attached!
    const client2 = new DeviceClient(daemon.remote, daemon.roster.clusterId!, { memberId: serverIdentity.memberId, dhPub: serverIdentity.dhPub }, added.member).dial(auth);
    await client2.hello();

    const res2 = await daemon.runtime.receive({
      slot: { origin: "desktop", originEpoch: EPOCH, target: `bot:${mainId}`, n: 2 },
      floor: 1,
      inc: srvSnapLogId.logId,
      cmd: { type: "chat.send", botId: mainId, text: "/choices Pick two" },
    }, { scope: "local" });
    expect(res2).toMatchObject({ status: "result", message: { outcome: { kind: "applied" } } });

    await until(
      () => Number(daemon.hub.reader().prepare("SELECT count(*) AS n FROM cards WHERE botId = ? AND state = 'open'").get(mainId)?.n ?? 0) >= 2 ? true : null,
      { timeout: 20_000, what: "second card stored while attached" },
    );
    await daemon.pushTriggers.idle();
    expect(fakePush.received).toHaveLength(1);

    // Disconnect again, then send `/tool echo hi` -> fake-claude asks for Bash tool approval -> second Web Push sent!
    await client2.disconnect();

    const res3 = await daemon.runtime.receive({
      slot: { origin: "desktop", originEpoch: EPOCH, target: `bot:${mainId}`, n: 3 },
      floor: 1,
      inc: srvSnapLogId.logId,
      cmd: { type: "chat.send", botId: mainId, text: "/tool echo hi" },
    }, { scope: "local" });
    expect(res3).toMatchObject({ status: "result", message: { outcome: { kind: "applied" } } });

    await until(() => (fakePush.received.length >= 2 ? fakePush.received[1] : null), { timeout: 20_000, what: "e2e approval push received" });
    expect(fakePush.received).toHaveLength(2);
    expect(fakePush.received.every((r) => r.url === "/sub/e2e-phone")).toBe(true);
  }, 60_000);
});


describe("M4-24 review items: read scope, gone memory, 429 Retry-After, backoff, coalescing, and dynamic retry checks", () => {
  it("R3: skips devices whose scope lacks 'read' (e.g. reply/approve only) and pushes once 'read' is present", async () => {
    const h = await setupHarness({ coalesceMs: 0 });
    await h.addDevice("no-read", 11, { scope: ["reply", "approve"] });
    await h.addDevice("read-only", 12, { scope: ["read"] });

    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("scope-card-1", {
        text: "Secret question",
        choices: [{ label: "Yes", recommended: true, detail: null, action: null }],
      }),
    });
    await h.settle();

    expect(h.fakePush.received.map((r) => r.url)).toEqual(["/sub/read-only-cap-12"]);
  });

  it("R2: never retries 404/410, remembers gone endpoint without logging it, and resumes when the device writes a new subscription", async () => {
    let status = 410;
    const h = await setupHarness({
      coalesceMs: 0,
      backoffBaseMs: 10,
      responder: () => ({ status }),
    });
    const d1 = await h.addDevice("phone1", 41);

    // Card 1 -> 410 Gone: sent once, NEVER retried.
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("gone-1", {
        text: "First card",
        choices: [{ label: "OK", recommended: true, detail: null, action: null }],
      }),
    });
    await h.settle();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.fakePush.received).toHaveLength(1);
    expect(h.fakePush.received[0].url).toBe("/sub/phone1-cap-41");

    // Card 2 while device still has the same gone endpoint -> skipped completely.
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("gone-2", {
        text: "Second card",
        choices: [{ label: "OK", recommended: true, detail: null, action: null }],
      }),
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(1);

    // Same for 404 on a second device.
    status = 404;
    await h.addDevice("phone2", 42);
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("gone-3", {
        text: "Third card",
        choices: [{ label: "OK", recommended: true, detail: null, action: null }],
      }),
    });
    await h.settle();
    await new Promise((r) => setTimeout(r, 50));
    expect(h.fakePush.received.map((r) => r.url)).toEqual(["/sub/phone1-cap-41", "/sub/phone2-cap-42"]);

    // Device 1 writes a new subscription endpoint -> pushing resumes for device 1 (and still skips device 2's gone endpoint).
    status = 201;
    const newKeys = makeDevicePushKeys(43);
    await h.roster.writeProfile(d1.memberId, "push", encodePushSubscription({
      endpoint: "https://push.example/sub/phone1-cap-fresh",
      keys: { p256dh: newKeys.p256dh, auth: newKeys.auth },
    }));
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("gone-4", {
        text: "Fourth card",
        choices: [{ label: "OK", recommended: true, detail: null, action: null }],
      }),
    });
    await h.settle();
    expect(h.fakePush.received.map((r) => r.url)).toEqual([
      "/sub/phone1-cap-41",
      "/sub/phone2-cap-42",
      "/sub/phone1-cap-fresh",
    ]);

    // Never log the full endpoint capability path.
    const joinedLogs = h.logs.join("\n");
    expect(joinedLogs).not.toContain("/sub/phone1-cap-41");
    expect(joinedLogs).not.toContain("/sub/phone2-cap-42");
    expect(joinedLogs).not.toContain("/sub/phone1-cap-fresh");
  });

  it("R2: parses Retry-After (seconds and HTTP-date), honours 429 Retry-After per endpoint origin, and bounds exponential backoff retries", async () => {
    expect(parseRetryAfterMs("3", 1_000)).toBe(3_000);
    expect(parseRetryAfterMs("0", 1_000)).toBe(0);
    expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:05 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"))).toBe(5_000);
    expect(parseRetryAfterMs("not-a-date", 1_000)).toBeUndefined();

    // 1) 429 with Retry-After on origin-a blocks origin-a (defers another device on origin-a) while origin-b sends immediately.
    const bot2 = "6A0B0000-0000-4000-8000-000000000099";
    const h2 = await setupHarness({
      ownedBots: [OWNED_BOT, bot2],
      coalesceMs: 0,
      backoffBaseMs: 10,
      maxBackoffMs: 2_000, // above the 1 s Retry-After, so it is honoured (a longer one schedules no retry)
      maxRetries: 2,
      responder: (req) => {
        if (req.origin === "https://origin-a.example" && req.url === "/sub/a1-cap-61") {
          const hits = h2.fakePush.received.filter((r) => r.url === "/sub/a1-cap-61").length;
          if (hits === 1) return { status: 429, headers: { "Retry-After": "1" } };
        }
        return { status: 201 };
      },
    });
    await h2.addDevice("a1", 61, { origin: "https://origin-a.example" });
    const t0 = Date.now();
    h2.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("ra-bot1", { text: "Q1", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await h2.settle();
    expect(h2.fakePush.received.map((r) => r.url)).toEqual(["/sub/a1-cap-61"]);

    // Now add a2 on origin-a and b1 on origin-b, trigger bot2 immediately while origin-a is cooled down:
    await h2.addDevice("a2", 62, { origin: "https://origin-a.example" });
    await h2.addDevice("b1", 63, { origin: "https://origin-b.example" });
    h2.engine.emit({
      type: "message.added",
      botId: bot2,
      message: makeMessage("ra-bot2", { text: "Q2", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await h2.settle();

    // origin-b receives immediately; origin-a has NOT been hit again yet!
    expect(h2.fakePush.received.filter((r) => r.origin === "https://origin-b.example")).toHaveLength(1);
    expect(h2.fakePush.received.filter((r) => r.origin === "https://origin-a.example")).toHaveLength(1);

    // After the Retry-After cooldown expires, both a1 (retry) and a2 (deferred) deliver cleanly.
    await until(
      () => (h2.fakePush.received.filter((r) => r.origin === "https://origin-a.example").length >= 3 ? true : null),
      { timeout: 5_000, what: "origin-a retry and deferred delivery" },
    );
    await h2.triggers.idle();
    const minOriginARetryAt = Math.min(...h2.fakePush.received.filter((r) => r.origin === "https://origin-a.example").slice(1).map((r) => r.at));
    expect(minOriginARetryAt - t0).toBeGreaterThanOrEqual(1_000);

    // 2) Persistent 503 retries up to maxRetries (2) with bounded backoff and stops (1 + 2 = 3 total attempts).
    const h3 = await setupHarness({
      coalesceMs: 0,
      backoffBaseMs: 10,
      maxBackoffMs: 25,
      maxRetries: 2,
      responder: () => ({ status: 503 }),
    });
    await h3.addDevice("flaky", 64);
    h3.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("retry-cap", { text: "503?", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await until(() => (h3.fakePush.received.length >= 3 ? true : null), { timeout: 5_000, what: "3 attempts for maxRetries=2" });
    await new Promise((r) => setTimeout(r, 80));
    expect(h3.fakePush.received).toHaveLength(3);
  });

  it("R2: coalesces events for the same bot within coalesceMs (default 1 minute) while pushing other bots and after window expiry", async () => {
    let clock = 10_000;
    const bot2 = "6A0B0000-0000-4000-8000-000000000088";
    expect(DEFAULT_PUSH_COALESCE_MS).toBe(60_000);
    const h = await setupHarness({
      ownedBots: [OWNED_BOT, bot2],
      coalesceMs: DEFAULT_PUSH_COALESCE_MS,
      now: () => clock,
    });
    await h.addDevice("phone1", 71);

    // Bot 1 needs user at t = 10s -> pushes.
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("c-1", { text: "First", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(1);

    // Bot 1 needs user again at t = 35s (within 60s) -> coalesced!
    clock = 35_000;
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("c-2", { text: "Second", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(1);

    // Bot 2 needs user at t = 35s -> independent bot, pushes!
    h.engine.emit({
      type: "message.added",
      botId: bot2,
      message: makeMessage("c-b2", { text: "Bot2", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(2);

    // Bot 1 needs user again at t = 71s (>= 60s after t=10s) -> pushes!
    clock = 71_000;
    h.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("c-3", { text: "Third", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await h.settle();
    expect(h.fakePush.received).toHaveLength(3);
  });

  it("R6: re-checks roster revocation, attachment, and open-card state dynamically before firing a scheduled retry, and catches notify rejections", async () => {
    // 1) Revoked before retry fires -> retry sends nothing (L-008).
    const hRevoke = await setupHarness({
      coalesceMs: 0,
      backoffBaseMs: 60,
      maxBackoffMs: 60,
      maxRetries: 2,
      responder: () => ({ status: 503 }),
    });
    const dRev = await hRevoke.addDevice("rev", 81);
    hRevoke.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("r6-rev", { text: "Q", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await hRevoke.settle();
    expect(hRevoke.fakePush.received).toHaveLength(1);
    await hRevoke.roster.revokeDevice(dRev.memberId);
    await new Promise((r) => setTimeout(r, 120));
    expect(hRevoke.fakePush.received).toHaveLength(1);

    // 2) Device attaches before retry fires -> retry sends nothing.
    const hAttach = await setupHarness({
      coalesceMs: 0,
      backoffBaseMs: 60,
      maxBackoffMs: 60,
      maxRetries: 2,
      responder: () => ({ status: 503 }),
    });
    const dAtt = await hAttach.addDevice("att", 82);
    hAttach.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("r6-att", { text: "Q", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await hAttach.settle();
    expect(hAttach.fakePush.received).toHaveLength(1);
    const tab = hAttach.connectDevice(dAtt.memberId, dAtt.auth);
    await tab.hello();
    await new Promise((r) => setTimeout(r, 120));
    expect(hAttach.fakePush.received).toHaveLength(1);

    // 3) Card is answered before retry fires -> retry sends nothing.
    const hClosed = await setupHarness({
      coalesceMs: 0,
      backoffBaseMs: 60,
      maxBackoffMs: 60,
      maxRetries: 2,
      responder: () => ({ status: 503 }),
    });
    await hClosed.addDevice("cls", 83);
    const msg = makeMessage("r6-cls", { text: "Q", choices: [{ label: "OK", recommended: true, detail: null, action: null }] });
    hClosed.engine.emit({ type: "message.added", botId: OWNED_BOT, message: msg });
    await hClosed.settle();
    expect(hClosed.fakePush.received).toHaveLength(1);
    hClosed.engine.emit({ type: "message.updated", botId: OWNED_BOT, message: { ...msg, chosen: 0, answer: "OK" } });
    await hClosed.settle();
    await new Promise((r) => setTimeout(r, 120));
    expect(hClosed.fakePush.received).toHaveLength(1);

    // 4) notify() rejection (e.g. vapid-keys read error) is caught cleanly.
    const hErr = await setupHarness({
      coalesceMs: 0,
      sender: { notify: () => Promise.reject(new Error("vapid-keys vanished")) },
    });
    await hErr.addDevice("err-dev", 84);
    hErr.engine.emit({
      type: "message.added",
      botId: OWNED_BOT,
      message: makeMessage("r6-err", { text: "Q", choices: [{ label: "OK", recommended: true, detail: null, action: null }] }),
    });
    await hErr.settle();
    expect(hErr.logs.some((l) => l.includes("vapid-keys vanished"))).toBe(true);
  });
});

describe("M4-24 review fixes: send cap, jitter, trailing coalesce, long Retry-After", () => {
  const card = (id: string) => makeMessage(id, { text: "Q", choices: [{ label: "OK", recommended: true, detail: null, action: null }] });
  const commits = async (h: { runtime: { scope: { submit: (c: () => undefined) => Promise<unknown> } } }) => {
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await h.runtime.scope.submit(() => undefined);
    }
  };

  it("runs at most 4 sends at once, starts queued ones without losing or doubling any, and re-checks attachment when a queued send starts", async () => {
    const bots = Array.from({ length: 7 }, (_, i) => `6A0B0000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`);
    const calls: PushAlert[] = [];
    const gates: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    const h = await setupHarness({
      ownedBots: bots,
      coalesceMs: 0,
      sender: {
        notify: (alert) => {
          calls.push(alert);
          peak = Math.max(peak, ++running);
          return new Promise<PushSendReport>((resolve) => gates.push(() => { running--; resolve({ sent: 1, results: [] }); }));
        },
      },
    });
    const d = await h.addDevice("phone", 91);
    for (const bot of bots) h.engine.emit({ type: "message.added", botId: bot, message: card(`cap-${bot}`) });
    await commits(h);
    expect(calls).toHaveLength(4);

    gates.splice(0, 2).forEach((open) => open());
    await until(() => (calls.length >= 6 ? true : null), { timeout: 5_000, what: "two queued sends started" });
    expect(peak).toBe(4);

    // The device attaches while the last send waits in the queue: it must not get it.
    const tab = h.connectDevice(d.memberId, d.auth);
    await tab.hello();
    while (gates.length) gates.splice(0).forEach((open) => open());
    await h.triggers.idle();
    expect(calls).toHaveLength(6);
    expect(new Set(calls.map((c) => c.botId)).size).toBe(6);
    expect(peak).toBe(4);
  });

  it("adds jitter to a retry delay (never earlier than the backoff)", async () => {
    const at: number[] = [];
    let device = "";
    const h = await setupHarness({
      coalesceMs: 0,
      backoffBaseMs: 60,
      maxBackoffMs: 1_000,
      maxRetries: 1,
      random: () => 0.99,
      sender: {
        notify: async () => {
          at.push(Date.now());
          return { sent: 0, results: [{ device, ok: false, retryable: true, reason: "http-503" }] };
        },
      },
    });
    device = (await h.addDevice("jit", 92)).memberId;
    h.engine.emit({ type: "message.added", botId: OWNED_BOT, message: card("jit-1") });
    await until(() => (at.length >= 2 ? true : null), { timeout: 5_000, what: "one retry" });
    // 60 ms backoff + floor(0.99 * 30) = 89 ms jitter-added delay.
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(85);
  });

  it("sends one trailing push at the end of a coalescing window when a card opened inside it is still open, and none when it was answered", async () => {
    let clock = 1_000;
    const calls: PushAlert[] = [];
    const h = await setupHarness({
      coalesceMs: 100,
      now: () => clock,
      sender: { notify: async (alert) => { calls.push(alert); return { sent: 1, results: [] }; } },
    });
    await h.addDevice("phone", 93);
    const a = card("tr-a");
    h.engine.emit({ type: "message.added", botId: OWNED_BOT, message: a });
    await h.settle();
    expect(calls).toHaveLength(1);

    clock = 1_010; // inside the window: coalesced, trailing push due in 90 ms
    h.engine.emit({ type: "message.added", botId: OWNED_BOT, message: card("tr-b") });
    h.engine.emit({ type: "message.updated", botId: OWNED_BOT, message: { ...a, chosen: 0, answer: "OK" } });
    await h.settle();
    expect(calls).toHaveLength(1);
    clock = 1_200;
    await until(() => (calls.length >= 2 ? true : null), { timeout: 5_000, what: "trailing push for the card opened in the window" });
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toHaveLength(2);

    clock = 1_250; // inside the new window; the card is answered before the window ends
    const c = card("tr-c");
    h.engine.emit({ type: "message.added", botId: OWNED_BOT, message: c });
    await h.settle();
    h.engine.emit({ type: "message.updated", botId: OWNED_BOT, message: { ...c, chosen: 0, answer: "OK" } });
    await h.settle();
    h.engine.emit({ type: "message.updated", botId: OWNED_BOT, message: { ...card("tr-b"), chosen: 0, answer: "OK" } });
    await h.settle();
    clock = 1_400;
    await new Promise((r) => setTimeout(r, 150));
    expect(calls).toHaveLength(2);
  });

  it("does not retry early when Retry-After is longer than the cap, and keeps the origin closed for new cards", async () => {
    const calls: PushAlert[] = [];
    let device = "";
    const h = await setupHarness({
      coalesceMs: 0,
      backoffBaseMs: 10,
      maxBackoffMs: 50,
      maxRetries: 3,
      sender: {
        notify: async (alert) => {
          calls.push(alert);
          return { sent: 0, results: [{ device, ok: false, retryable: true, retryAfterMs: 10_000, reason: "http-429" }] };
        },
      },
    });
    device = (await h.addDevice("slow", 94)).memberId;
    h.engine.emit({ type: "message.added", botId: OWNED_BOT, message: card("ra-long-1") });
    await h.settle();
    await new Promise((r) => setTimeout(r, 200));
    h.engine.emit({ type: "message.added", botId: OWNED_BOT, message: card("ra-long-2") });
    await h.settle();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(1);
    expect(h.logs.some((line) => line.includes("not retrying"))).toBe(true);
  });
});
