// Botling 3 M2 step 6: botlingd's loopback listener (src/server/net/http.ts) and the device WebSocket (ws.ts), in this
// process, against the real parts (server.db in a temp folder, the roster with a cluster, the log hub, the intent
// runtime with the owner's slot check) and a fake turn engine. Devices dial with Node's WebSocket client (the browser
// API), so each binary message is one session frame, as the page will send them.
// - the listener's address is 127.0.0.1 only; a dial to the same port on any other interface of this machine fails;
// - a paired device completes the IK handshake over a real loopback WebSocket, says hello and sends chat.send →
//   cmd.result{applied};
// - an unpaired key, junk bytes and a text message get no parsed frame (the session opens nothing) and the socket ends;
// - `/v3/` answers with the CSP (`script-src 'self'`) and the other security headers; page files only from the page
//   folder (no traversal, no hidden files, no symlink out); `/v3/ws` upgrades only from no Origin or an allowed one;
//   the handshake-under-way cap answers 503; stopping the listener ends the device sockets.
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { WebSocket as WsClient } from "ws";
import type { Command } from "../../src/contract";
import { decodeFrame, encodeFrame, memberIdFromKey, toBase64Url, type Message, type MessageOf, type Slot, type StreamId } from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import {
  CHAT_CSP, CSP, DEFAULT_LISTEN_PORT, FRAME_HOST_CSP, LISTEN_HOST, listenPort, LoopbackListener, PLACEHOLDER_PAGE, SECURITY_HEADERS, tailscaleServeCommand, WS_MAX_PAYLOAD,
} from "../../src/server/net";
import { RosterStore } from "../../src/server/roster";
import { RemoteSessions, slotAuthorize, type RemoteHost, type RemoteSession, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { generateDhKeyPair, SessionLink, type SessionEnd, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";
import { listeningSockets } from "../support/two-servers";

const root = testRoot("net-listener");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000006";
const EPOCH = "0123456789abcdef0123456789abcdef";
const REMOTE = { local: false } as const;
const encoder = new TextEncoder();
let folders = 0;

async function waitFor<T>(probe: () => T | null | undefined | false, what: string, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Server {
  roster: RosterStore;
  host: RemoteHost;
  remote: RemoteSessions;
  listener: LoopbackListener;
  /** Every session the listener's sockets were given, in order. */
  sessions: RemoteSession[];
  logs: string[];
  url(path: string): string;
  inc(): string;
  entries(stream: string): Array<{ kind: string; slot: Slot | null }>;
}

async function server(options: { pageDir?: string | null; origins?: string[]; maxHandshaking?: number } = {}): Promise<Server> {
  const dir = `${root}/d${++folders}`;
  const store: ServerStore = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const logs: string[] = [];
  const roster = await RosterStore.open(store, identity, { log: (line) => logs.push(line) });
  const setup = new ClusterSetup(roster);
  expect((await setup.confirm((await setup.begin()).code)).ok).toBe(true);
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
  const host: RemoteHost = { ...base, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey } };
  const remote = new RemoteSessions(host);
  const sessions: RemoteSession[] = [];
  const acceptor = { accept: (transport: SessionTransport, kind: "tailnet") => { const session = remote.accept(transport, kind); sessions.push(session); return session; } };
  const listener = await LoopbackListener.start({
    port: 0, remote: acceptor, pageDir: options.pageDir ?? null, origins: () => options.origins ?? [], log: (line) => logs.push(line),
    ...(options.maxHandshaking ? { maxHandshaking: options.maxHandshaking } : {}),
  });
  cleanups.push(async () => {
    remote.close();
    await listener.close();
    await runtime.scope.submit(() => undefined);
    engine.close();
    runtime.close();
    shell.close();
    live.close();
    hub.close();
    await store.close();
  });
  return {
    roster, host, remote, listener, sessions, logs,
    url: (path) => `http://${LISTEN_HOST}:${listener.port}${path}`,
    inc: () => String(hub.reader().prepare("SELECT logId FROM streams WHERE stream = ?").get(`srv:${serverId}`)!.logId),
    entries: (stream) => hub.reader().prepare("SELECT kind, slot FROM entries WHERE stream = ? ORDER BY seq").all(stream)
      .map((row) => ({ kind: String(row.kind), slot: row.slot ? JSON.parse(String(row.slot)) : null })),
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

/** A WebSocket as the browser API has it (Node's global client), carrying one session frame per binary message. */
class SocketTransport implements SessionTransport {
  readonly ws: WebSocket;
  private readonly queue: Uint8Array[] = [];
  closed: { code: number } | null = null;
  received = 0;
  onFrame: (frame: Uint8Array) => void = () => undefined;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => { for (const frame of this.queue.splice(0)) this.ws.send(frame); };
    this.ws.onmessage = (event) => { this.received++; this.onFrame(new Uint8Array(event.data as ArrayBuffer)); };
    this.ws.onclose = (event) => { this.closed = { code: event.code }; };
    this.ws.onerror = () => undefined;
  }

  send(frame: Uint8Array): void { if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame); else if (this.ws.readyState === WebSocket.CONNECTING) this.queue.push(frame); }
  close(): void { this.ws.close(); }
  get open(): Promise<void> { return waitFor(() => this.ws.readyState === WebSocket.OPEN || null, "socket open").then(() => undefined); }
}

class Device {
  readonly got: Message[] = [];
  ended: SessionEnd | null = null;
  readonly socket: SocketTransport;
  readonly link: SessionLink;

  constructor(readonly s: Server, readonly member: string, keys: Awaited<ReturnType<typeof deviceKeys>>) {
    this.socket = new SocketTransport(s.url("/v3/ws"));
    this.link = SessionLink.initiate(this.socket, {
      mode: "ik", transport: "tailnet", cluster: s.roster.clusterId!, self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
      responder: { memberId: s.host.self.memberId, dhPub: s.host.self.dhPub },
    }, {
      onFrame: (bytes) => {
        const decoded = decodeFrame(bytes, "server", REMOTE);
        if (!decoded.ok) throw new Error(`the server sent a bad frame: ${decoded.detail}`);
        this.got.push(decoded.message);
      },
      onEnd: (end) => { this.ended = end; },
    });
    this.socket.onFrame = (frame) => this.link.receive(frame);
    this.socket.ws.addEventListener("close", () => this.link.transportClosed());
  }

  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", REMOTE);
    if (!encoded.ok) throw new Error(encoded.detail);
    this.link.send("control", encoder.encode(encoded.text));
  }

  wait<T extends Message>(match: (message: Message) => message is T, what: string, ms?: number): Promise<T> {
    return waitFor(() => this.got.find(match) as T | undefined, what, ms);
  }
}

const bot = `bot:${BOT}` as StreamId;

/** Dials host:port with TCP: "connected" or the error code. */
function dial(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2_000 });
    socket.once("connect", () => { socket.destroy(); resolve("connected"); });
    socket.once("timeout", () => { socket.destroy(); resolve("ETIMEDOUT"); });
    socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
  });
}

/** This machine's addresses other than 127.0.0.1 (every interface; link-local IPv6 with its scope). */
function otherAddresses(): string[] {
  const found = new Set<string>(["::1"]);
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.address === LISTEN_HOST) continue;
      found.add(info.family === "IPv6" && info.address.toLowerCase().startsWith("fe80") ? `${info.address}%${name}` : info.address);
    }
  }
  return [...found];
}

describe("the loopback listener", () => {
  it("is bound to 127.0.0.1 only: its address, the process's sockets, and a dial on every other interface fails", async () => {
    const s = await server();
    const address = s.listener.address;
    expect(address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    const mine = listeningSockets(process.pid).filter((socket) => socket.port === address.port);
    expect(mine).toEqual([{ proto: "tcp", address: "127.0.0.1", port: address.port }]);
    expect(await dial(LISTEN_HOST, address.port)).toBe("connected");
    const others = otherAddresses();
    expect(others.length).toBeGreaterThan(0);
    const results = await Promise.all(others.map(async (host) => [host, await dial(host, address.port)]));
    for (const [host, result] of results) expect([host, result]).not.toEqual([host, "connected"]);
    // The count is evidence (no addresses printed: they name this machine).
    console.log(`dialled ${others.length} other address(es) on the listener's port: none connected`);
  });

  it("takes its port from BOTLING_SERVER_PORT (default, 0, off) and refuses a taken port", async () => {
    expect(listenPort({})).toBe(DEFAULT_LISTEN_PORT);
    expect(listenPort({ BOTLING_SERVER_PORT: "0" })).toBe(0);
    expect(listenPort({ BOTLING_SERVER_PORT: " 9001 " })).toBe(9001);
    expect(listenPort({ BOTLING_SERVER_PORT: "off" })).toBeNull();
    for (const bad of ["70000", "-1", "0.0.0.0:80", "abc"]) expect(() => listenPort({ BOTLING_SERVER_PORT: bad })).toThrow(/BOTLING_SERVER_PORT/);
    expect(tailscaleServeCommand(8744)).toBe("tailscale serve --bg http://127.0.0.1:8744");
    const s = await server();
    await expect(LoopbackListener.start({ port: s.listener.port, remote: s.remote, pageDir: null, origins: () => [], log: () => undefined })).rejects.toThrow(/EADDRINUSE/);
  });
});

describe("a device over a real loopback WebSocket", () => {
  it("completes the IK handshake, says hello, and chat.send → cmd.result{applied} and the bot's entries", async () => {
    const s = await server();
    const keys = await deviceKeys();
    await s.roster.addDevice({ keys: keys.keys, name: "Phone" });
    const device = new Device(s, keys.member, keys);
    const info = await device.link.established;
    expect(info.transport).toBe("tailnet");
    device.send({ t: "hello", deviceId: keys.member, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [] } as Message);
    await device.wait((m): m is MessageOf<"welcome"> => m.t === "welcome", "welcome");
    await waitFor(() => s.remote.open.length === 1 || null, "registered session");
    expect(s.remote.open[0]!.memberId).toBe(keys.member);
    expect(s.remote.open[0]!.link.info?.transport).toBe("tailnet");

    device.send({ t: "sub", stream: bot, cursor: null } as Message);
    await device.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === bot, "bot snap");
    const slot: Slot = { origin: keys.member, originEpoch: EPOCH, target: bot, n: 1 };
    device.send({ t: "cmd", slot, floor: 1, inc: s.inc(), cmd: { type: "chat.send", botId: BOT, text: "hello over the tailnet" } as Command } as Message);
    const result = await device.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1, "cmd.result");
    expect(result.outcome.kind).toBe("applied");
    await waitFor(() => device.got.some((m) => m.t === "batch" && m.stream === bot && m.entries.some((e) => e.kind === "turn.finished")), "turn.finished batch");
    expect(s.entries(bot).find((e) => e.kind === "message.added" && e.slot?.origin === keys.member)?.slot).toEqual(slot);

    // Stopping the listener ends the socket (the session said bye first when botlingd stops; here the socket goes).
    s.remote.close();
    await device.wait((m): m is MessageOf<"bye"> => m.t === "bye", "bye");
    await s.listener.close();
    await waitFor(() => device.socket.closed, "socket closed");
  });

  it("an unpaired key, junk bytes and a text message get no parsed frame; the socket ends", async () => {
    const s = await server();
    // Unpaired: valid keys, never added to the roster.
    const keys = await deviceKeys();
    const device = new Device(s, keys.member, keys);
    await expect(device.link.established).rejects.toThrow();
    await waitFor(() => device.socket.closed, "socket closed (unpaired)");
    await waitFor(() => s.sessions[0]?.link.state === "ended" || null, "server side ended");
    expect(s.sessions[0]!.link.delivered).toBe(0);
    expect(device.socket.received).toBe(0); // not even an HS2: the roster check comes first
    expect(device.got).toEqual([]);
    expect(s.remote.open).toEqual([]);
    expect(s.logs.join("\n")).not.toContain(keys.member);

    // Junk binary bytes in place of HS1.
    const junk = new SocketTransport(s.url("/v3/ws"));
    await junk.open;
    junk.send(crypto.getRandomValues(new Uint8Array(200)));
    await waitFor(() => junk.closed, "socket closed (junk)");
    expect(s.sessions[1]!.link.delivered).toBe(0);
    expect(junk.received).toBe(0);

    // A text message: binary frames only (1003), nothing reaches the session.
    const text = new SocketTransport(s.url("/v3/ws"));
    await text.open;
    text.ws.send(JSON.stringify({ t: "hello" }));
    const closed = await waitFor(() => text.closed, "socket closed (text)");
    expect(closed.code).toBe(1003);
    expect(s.sessions[2]!.link.delivered).toBe(0);
    expect(text.received).toBe(0);

    // A message larger than any session frame is refused by ws before it is buffered (1009).
    const big = new SocketTransport(s.url("/v3/ws"));
    await big.open;
    big.ws.send(new Uint8Array(WS_MAX_PAYLOAD + 1));
    expect((await waitFor(() => big.closed, "socket closed (too big)")).code).toBe(1009);
    expect(s.sessions[3]!.link.delivered).toBe(0);
    expect(s.remote.open).toEqual([]);
  });
});

describe("/v3/ over HTTP", () => {
  it("answers with the CSP (script-src 'self') and the security headers; page files only from the page folder", async () => {
    const page = join(root, `page${++folders}`);
    mkdirSync(join(page, "assets"), { recursive: true });
    writeFileSync(join(page, "index.html"), "<!doctype html><title>page</title><script src=\"app.js\"></script>");
    writeFileSync(join(page, "app.js"), "console.log(1)");
    writeFileSync(join(page, "assets", "a.css"), "body{}");
    writeFileSync(join(page, ".hidden"), "no");
    writeFileSync(join(root, "outside.txt"), "secret outside the page folder");
    symlinkSync(join(root, "outside.txt"), join(page, "link.txt"));
    const s = await server({ pageDir: page });

    const index = await fetch(s.url("/v3/"));
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = index.headers.get("content-security-policy")!;
    expect(csp).toBe(CSP);
    expect(csp.split("; ")).toEqual(expect.arrayContaining(["script-src 'self'", "default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'self'"]));
    expect(csp).not.toMatch(/script-src[^;]*(unsafe-inline|unsafe-eval|\*)/);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(index.headers.get(name)).toBe(value);
    expect(index.headers.get("x-content-type-options")).toBe("nosniff");
    expect(index.headers.get("referrer-policy")).toBe("no-referrer");
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(await index.text()).toContain("<title>page</title>");

    const js = await fetch(s.url("/v3/app.js"));
    expect([js.status, js.headers.get("content-type"), js.headers.get("content-security-policy")]).toEqual([200, "text/javascript; charset=utf-8", CSP]);
    expect((await fetch(s.url("/v3/assets/a.css"))).headers.get("content-type")).toBe("text/css; charset=utf-8");
    const head = await fetch(s.url("/v3/"), { method: "HEAD" });
    expect([head.status, await head.text()]).toEqual([200, ""]);

    const status = async (path: string, init?: RequestInit) => {
      const response = await fetch(s.url(path), { redirect: "manual", ...init });
      await response.arrayBuffer();
      expect(response.headers.get("content-security-policy")).toBe(CSP); // on every answer, errors included
      return response.status;
    };
    expect(await status("/v3")).toBe(301);
    expect(await status("/")).toBe(301);
    expect(await status("/v3/ws")).toBe(426);
    expect(await status("/v3/c/owner/id/original")).toBe(501);
    expect(await status("/v3/", { method: "POST", body: "x" })).toBe(405);
    expect(await status("/mobile/")).toBe(404);
    expect(await status("/v3/missing.js")).toBe(404);
    expect(await status("/v3/.hidden")).toBe(404);
    expect(await status("/v3/link.txt")).toBe(404);
    expect(await status("/v3/assets")).toBe(404);
    expect(await status("/v3/%2e%2e/outside.txt")).toBe(404);
    expect(await status("/v3/assets/%2e%2e%2f%2e%2e%2foutside.txt")).toBe(404);
    expect(await status("/v3/%E0%A4%A")).toBe(400);
    expect(await status("/v3/a%5c..%5coutside.txt")).toBe(400);
    // fetch would normalize "..": send it raw.
    const raw = await new Promise<string>((resolve) => {
      const socket = connect({ host: LISTEN_HOST, port: s.listener.port }, () => socket.end("GET /v3/../../outside.txt HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      let text = "";
      socket.on("data", (chunk) => { text += chunk; });
      socket.on("close", () => resolve(text));
    });
    expect(raw).toMatch(/^HTTP\/1\.1 404 /);
    expect(raw).not.toContain("secret");
  });

  it("gives the sandboxed chat page and the component frame host their own policies; the page's assets any-origin readable (step 8)", async () => {
    const page = join(root, `page${++folders}`);
    mkdirSync(page, { recursive: true });
    for (const name of ["index.html", "chat.html", "frame-host.html"]) writeFileSync(join(page, name), "<!doctype html><title>x</title>");
    writeFileSync(join(page, "chat.js"), "1");
    const s = await server({ pageDir: page });
    const head = async (path: string) => (await fetch(s.url(path))).headers;
    const index = await head("/v3/");
    expect([index.get("content-security-policy"), index.get("x-frame-options"), index.get("cross-origin-resource-policy")]).toEqual([CSP, "SAMEORIGIN", "same-origin"]);
    const chat = await head("/v3/chat.html");
    expect([chat.get("content-security-policy"), chat.get("x-frame-options"), chat.get("cross-origin-resource-policy")]).toEqual([CHAT_CSP, "SAMEORIGIN", "same-origin"]);
    expect(CHAT_CSP.split("; ")).toEqual(expect.arrayContaining(["default-src 'none'", "script-src 'self' blob:", "connect-src 'none'", "frame-ancestors 'self'"]));
    const host = await head("/v3/frame-host.html");
    expect([host.get("content-security-policy"), host.get("x-frame-options")]).toEqual([FRAME_HOST_CSP, null]);
    expect(FRAME_HOST_CSP.split("; ")).toEqual(expect.arrayContaining(["sandbox allow-scripts", "connect-src 'none'", "frame-src 'none'"]));
    const js = await head("/v3/chat.js");
    expect([js.get("content-security-policy"), js.get("cross-origin-resource-policy")]).toEqual([CSP, "cross-origin"]);
    expect((await fetch(s.url("/v3/missing.js"))).headers.get("cross-origin-resource-policy")).toBe("same-origin");
  });

  it("serves a placeholder page (no script) until the page is built", async () => {
    const s = await server({ pageDir: join(root, "no-such-page") });
    const index = await fetch(s.url("/v3/"));
    expect([index.status, index.headers.get("content-security-policy")]).toEqual([200, CSP]);
    const body = await index.text();
    expect(body).toBe(PLACEHOLDER_PAGE);
    expect(body).not.toContain("<script");
    expect((await fetch(s.url("/v3/app.js"))).status).toBe(404);
  });

  it("upgrades /v3/ws only from no Origin or an allowed one, only on that path, and caps handshakes under way", async () => {
    const s = await server({ origins: ["https://tailnet-name.invalid"], maxHandshaking: 2 });
    const tryOpen = (path: string, origin?: string) => new Promise<string>((resolve) => {
      const ws = new WsClient(`ws://${LISTEN_HOST}:${s.listener.port}${path}`, origin ? { origin } : {});
      ws.on("open", () => { ws.close(); resolve("open"); });
      ws.on("unexpected-response", (...args: unknown[]) => { resolve(String((args[1] as { statusCode: number }).statusCode)); ws.terminate(); });
      ws.on("error", () => undefined);
    });
    expect(await tryOpen("/v3/ws")).toBe("open");
    expect(await tryOpen("/v3/ws", "https://tailnet-name.invalid")).toBe("open");
    expect(await tryOpen("/v3/ws", `http://127.0.0.1:${s.listener.port}`)).toBe("open");
    expect(await tryOpen("/v3/ws", "https://evil.example")).toBe("403");
    expect(await tryOpen("/v3/ws", "http://127.0.0.1:1")).toBe("403");
    expect(await tryOpen("/ws")).toBe("404");
    expect(await tryOpen("/v3/")).toBe("404");
    await waitFor(() => s.sessions.every((session) => session.link.state === "ended") || null, "test sockets' sessions ended");

    // Two sockets that never send HS1 hold both handshake places: a third is answered 503.
    const held = [new SocketTransport(s.url("/v3/ws")), new SocketTransport(s.url("/v3/ws"))];
    await Promise.all(held.map((socket) => socket.open));
    expect(await tryOpen("/v3/ws")).toBe("503");
    held[0]!.close();
    await waitFor(() => held[0]!.closed, "held socket closed");
    let again = "";
    for (let i = 0; i < 100 && again !== "open"; i++) { again = await tryOpen("/v3/ws"); if (again !== "open") await new Promise((resolve) => setTimeout(resolve, 20)); }
    expect(again).toBe("open");
    held[1]!.close();
  });
});
