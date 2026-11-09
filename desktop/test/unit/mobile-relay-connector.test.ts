// The whole relay path without a network: the relay's own room logic (relay/src/relay.ts), the desktop connector
// (src/mobile-relay/connector.ts) and the phone client (mobile/relay-client.ts), joined by in-memory sockets.
// Pairing from the QR link, commands through the encrypted channel, change notices, reconnecting, single-use codes,
// revocation, and that the relay only ever carries ciphertext.
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { okResponse, errorResponse, type ResponseEnvelope } from "../../src/contract";
import type { MobileCore } from "../../src/mobile-bridge/bridge";
import { MutationLedger } from "../../src/mobile-bridge/ledger";
import { RelayConnector, type SocketLike } from "../../src/mobile-relay/connector";
import { parseRelayFragment } from "../../src/mobile-relay/protocol";
import { RelayStore } from "../../src/mobile-relay/store";
import { RelayClient, type RelaySession } from "../../mobile/relay-client";
import { MobileError } from "../../mobile/transport";
import { tempDir } from "../helpers";

interface RelayLike { attach(socket: { send(t: string): void; close(c: number, r: string): void }, ip: string): { message(t: string): void; closed(): void }; shutdown(): void; stats(): { rooms: number; peers: number } }
// relay/ is its own package (Node type stripping, `.ts` imports); load it at run time so tsc does not type-check it here.
const relayModule = new URL("../../../relay/src/relay.ts", import.meta.url).href;
const configModule = new URL("../../../relay/src/config.ts", import.meta.url).href;
async function makeRelay(): Promise<RelayLike> {
  const { Relay } = await import(/* @vite-ignore */ relayModule);
  const { loadConfig } = await import(/* @vite-ignore */ configModule);
  return new Relay({ ...loadConfig({}), helloTimeoutSeconds: 5 });
}

/** What crossed the relay, both ways (to check it is all ciphertext). */
const wire: string[] = [];
function sockets(relay: RelayLike) {
  return (_url: string): SocketLike => {
    const sock: SocketLike & { readyState: number } = {
      readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
      send(text: string) { wire.push(text); queueMicrotask(() => { if (sock.readyState === 1) handlers.message(text); }); },
      close() { if (sock.readyState === 3) return; sock.readyState = 3; hungUp = true; handlers.closed(); queueMicrotask(() => sock.onclose?.({ code: 1000 })); },
    };
    // As a real WebSocket: what the relay sent before closing still arrives; nothing arrives after the phone closed.
    let hungUp = false;
    const handlers = relay.attach({
      send: text => { wire.push(text); queueMicrotask(() => { if (!hungUp) sock.onmessage?.({ data: text }); }); },
      close: code => { if (sock.readyState === 3) return; sock.readyState = 3; queueMicrotask(() => { hungUp = true; sock.onclose?.({ code }); }); },
    }, "127.0.0.1");
    queueMicrotask(() => { sock.readyState = 1; sock.onopen?.({}); });
    return sock;
  };
}

function fakeCore() {
  const calls: any[] = [];
  let listener: ((change: { botId?: string }) => void) | undefined;
  const core: MobileCore = {
    async mobileCommand(raw: any, allowed): Promise<ResponseEnvelope> {
      calls.push({ cmd: raw.cmd, allowed });
      if (raw.cmd.type === "chat.snapshot") return okResponse(raw.id, { epoch: "e", seq: calls.length, bots: [], chat: { botId: raw.cmd.botId, messages: [], tasks: [] } });
      if (raw.cmd.type === "chat.send") return okResponse(raw.id, { messageId: "m1", turnId: null });
      if (raw.cmd.type === "turn.stop") return okResponse(raw.id, { stopped: true, killed: [], forced: false });
      return errorResponse(raw.id, { code: "bad_request", message: "no" });
    },
    onChange(fn) { listener = fn; return () => { listener = undefined; }; },
  };
  return { core, calls, change: (botId?: string) => listener?.({ botId }) };
}

const until = async (check: () => boolean, ms = 3_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 5)); } };
const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); wire.length = 0; });

/** A phone's socket factory whose first socket loses the phone's third encrypted frame (after {h:'pair'} and
 * {t:'pair'}: the ack of `paired`): swallowed (the connection stays up), or the connection drops in its place. */
function losingAck(connect: (url: string) => SocketLike, how: "swallow" | "drop") {
  let first = true;
  return (url: string): SocketLike => {
    const sock = connect(url);
    if (!first) return sock;
    first = false;
    let frames = 0;
    const send = sock.send.bind(sock);
    sock.send = (text: string) => {
      if (JSON.parse(text).t === "d" && ++frames === 3) { if (how === "drop") sock.close(); return; }
      send(text);
    };
    return sock;
  };
}

async function setup(options: { ackMs?: number } = {}) {
  const relay = await makeRelay();
  const dir = tempDir("relay-desk");
  const store = new RelayStore(join(dir, "mobile"));
  const { core, calls, change } = fakeCore();
  const connect = sockets(relay);
  const connector = new RelayConnector({ store, core, ledger: () => new MutationLedger(join(dir, "mobile-mutations")), coreId: () => "c".repeat(32), socket: connect, waits: [20], ...options });
  connector.start();
  await connector.setURL("wss://relay.example/ws");
  await until(() => connector.view().state === "online");
  cleanup.push(() => { connector.stop(); relay.shutdown(); });
  const pairPhone = async (botIds: string[] | "default" = ["main"], name = "Test phone") => {
    const offer = await (botIds === "default" ? connector.pair() : connector.pair(botIds));
    const link = parseRelayFragment(new URL(offer.url).hash)!;
    expect(new URL(offer.url).origin).toBe("https://relay.example");
    const result = await RelayClient.pair(link, "https://relay.example", name, { socket: connect, waits: [20] });
    cleanup.push(() => result.client.close());
    // The phone's ack follows `paired`: the device is stored when it arrives.
    await until(() => connector.devices().some(d => d.id === result.session.deviceId));
    return { ...result, link, offer };
  };
  return { relay, store, connector, core, calls, change, connect, pairPhone };
}

describe("relay connector + phone client", () => {
  it("pairs from the QR link and carries commands through the encrypted channel", async () => {
    const { connector, calls, pairPhone } = await setup();
    const { client, session } = await pairPhone(["main", "project"]);
    expect(session.botIds).toEqual(["main", "project"]);
    expect(session.coreId).toBe("c".repeat(32));
    expect(connector.devices()).toMatchObject([{ id: session.deviceId, label: "Test phone", botIds: ["main", "project"] }]);
    const snapshot: any = await client.request({ type: "chat.snapshot", botId: "project" });
    expect(snapshot.chat.botId).toBe("project");
    expect(await client.request({ type: "chat.send", botId: "main", text: "a private message for the desktop" })).toEqual({ messageId: "m1", turnId: null });
    expect(await client.request({ type: "turn.stop", botId: "main", turnId: "t1" })).toEqual({ stopped: true, killed: [], forced: false });
    expect(calls.map(c => c.cmd.type)).toEqual(["chat.snapshot", "chat.send", "turn.stop"]);
    expect(calls[1].allowed).toEqual(["main", "project"]);
    // The relay carried only ciphertext: the message text never crossed it in the clear.
    expect(wire.length).toBeGreaterThan(5);
    expect(wire.some(frame => frame.includes("private message"))).toBe(false);
    expect(wire.some(frame => frame.includes("chat.send"))).toBe(false);
  });

  it("refuses bots the phone was not given and commands outside the phone set", async () => {
    const { calls, pairPhone } = await setup();
    const { client } = await pairPhone(["project"]);
    await expect(client.request({ type: "chat.send", botId: "main", text: "x" })).rejects.toMatchObject({ denied: true });
    await expect(client.request({ type: "bots.remove", botId: "project" } as any)).rejects.toThrow();
    // A snapshot without a bot reads the phone's first bot, never Main.
    const view: any = await client.request({ type: "chat.snapshot" });
    expect(view.chat.botId).toBe("project");
    expect(calls.map(c => c.cmd.type)).toEqual(["chat.snapshot"]);
  });

  it("a pairing code gives every bot by default: Main on the first read, and bots added later", async () => {
    const { connector, calls, change, pairPhone } = await setup();
    const { client, session } = await pairPhone("default");
    expect(session.botIds).toEqual(["*"]);
    expect(connector.devices()[0].botIds).toEqual(["*"]);
    // The phone page's first read: no bot, so the core's default (Main) with the all-bots scope (the full sidebar).
    await client.request({ type: "chat.snapshot" });
    expect(calls[0].cmd.botId).toBeUndefined();
    expect(calls[0].allowed).toEqual(["*"]);
    expect(await client.request({ type: "chat.send", botId: "made-after-pairing", text: "hi" })).toEqual({ messageId: "m1", turnId: null });
    let changed = 0;
    client.watch(() => { changed++; }, () => {});
    change("made-after-pairing");
    await until(() => changed === 1);
    // Still only the phone's commands.
    await expect(client.request({ type: "bots.remove", botId: "main" } as any)).rejects.toThrow();
  });

  it("tells the phone when something changed in a bot it may read, and nothing else", async () => {
    const { change, connect, pairPhone } = await setup();
    const { session, client } = await pairPhone(["main"]);
    client.close();
    let changes = 0;
    const again = await RelayClient.connect(session, { socket: connect, onChange: () => changes++ });
    cleanup.push(() => again.close());
    change("other-bot");
    await new Promise(r => setTimeout(r, 400));
    expect(changes).toBe(0);
    change("main"); change("main"); change();
    await until(() => changes === 1);
    await new Promise(r => setTimeout(r, 400));
    expect(changes).toBe(1); // a burst is one notice
  });

  it("reconnects as the paired phone after the connection drops", async () => {
    const { relay, connect, pairPhone } = await setup();
    const { session, client } = await pairPhone();
    client.close();
    const again = await RelayClient.connect(session, { socket: connect });
    cleanup.push(() => again.close());
    expect(((await again.request({ type: "chat.snapshot", botId: "main" })) as any).chat.botId).toBe("main");
    expect(relay.stats().peers).toBe(1);
  });

  it("a pairing code works once", async () => {
    const { connect, pairPhone } = await setup();
    const { link } = await pairPhone();
    await expect(RelayClient.pair(link, "https://relay.example", "Second", { socket: connect })).rejects.toMatchObject({ auth: true });
  });

  it("two phones scanning one code at once: one pairs, the other is told the code is used", async () => {
    const { connector, connect } = await setup();
    const offer = await connector.pair(["main"]);
    const link = parseRelayFragment(new URL(offer.url).hash)!;
    const tries = await Promise.allSettled(["First", "Second"].map(name => RelayClient.pair(link, "https://relay.example", name, { socket: connect, waits: [20] })));
    for (const t of tries) if (t.status === "fulfilled") cleanup.push(() => t.value.client.close());
    expect(tries.map(t => t.status).sort()).toEqual(["fulfilled", "rejected"]);
    const refused = tries.find(t => t.status === "rejected") as PromiseRejectedResult;
    // A clear "used" (the handshake's nope), not "could not reach Botling" (a kick after the first phone won).
    expect(refused.reason).toMatchObject({ auth: true, message: expect.stringMatching(/already been used/) });
    await until(() => connector.devices().length === 1);
  });

  it("a pairing whose ack never arrives (the connection drops first) stores nothing, and the code pairs again", async () => {
    const { connector, connect } = await setup();
    const offer = await connector.pair(["main"]);
    const link = parseRelayFragment(new URL(offer.url).hash)!;
    expect(link.v).toBe(2);
    let lost: MobileError | undefined;
    const first = await RelayClient.pair(link, "https://relay.example", "First", { socket: losingAck(connect, "drop"), waits: [20], onRevoked: error => { lost = error; } });
    cleanup.push(() => first.client.close());
    // Its token was never let in: connecting again is refused, and the phone says the pairing did not finish.
    await until(() => lost !== undefined);
    expect(lost).toMatchObject({ auth: true, message: expect.stringMatching(/did not finish/) });
    expect(connector.devices()).toEqual([]);
    const second = await RelayClient.pair(link, "https://relay.example", "Second", { socket: connect, waits: [20] });
    cleanup.push(() => second.client.close());
    await until(() => connector.devices().length === 1);
    expect(connector.devices()[0]!.id).toBe(second.session.deviceId);
  });

  it("a pairing whose ack does not come in time is ended, and the code pairs again", async () => {
    const { connector, connect } = await setup({ ackMs: 100 });
    const offer = await connector.pair(["main"]);
    const link = parseRelayFragment(new URL(offer.url).hash)!;
    let lost: MobileError | undefined;
    const first = await RelayClient.pair(link, "https://relay.example", "First", { socket: losingAck(connect, "swallow"), waits: [20], onRevoked: error => { lost = error; } });
    cleanup.push(() => first.client.close());
    await until(() => lost !== undefined);
    expect(lost!.message).toMatch(/did not finish/);
    expect(connector.devices()).toEqual([]);
    const second = await RelayClient.pair(link, "https://relay.example", "Second", { socket: connect, waits: [20] });
    cleanup.push(() => second.client.close());
    await until(() => connector.devices().length === 1);
  });

  it("a phone app from before pairing v2 sends no ack: its pairing is final when `paired` is sent", async () => {
    const { connector, connect } = await setup({ ackMs: 50 });
    const offer = await connector.pair(["main"]);
    const { v, ...older } = parseRelayFragment(new URL(offer.url).hash)!;
    expect(v).toBe(2);
    const { client, session } = await RelayClient.pair(older, "https://relay.example", "Older", { socket: connect, waits: [20] });
    cleanup.push(() => client.close());
    expect(connector.devices().map(d => d.id)).toEqual([session.deviceId]); // stored before `paired` left
    await new Promise(r => setTimeout(r, 100)); // no ack timer ends it
    expect(((await client.request({ type: "chat.snapshot", botId: "main" })) as any).chat.botId).toBe("main");
  });

  it("a revoked phone is told, disconnected, and cannot connect again", async () => {
    const { connector, connect, pairPhone } = await setup();
    const { session, client } = await pairPhone();
    client.close();
    let revoked: MobileError | undefined;
    const live = await RelayClient.connect(session, { socket: connect, onRevoked: error => { revoked = error; } });
    cleanup.push(() => live.close());
    expect(await connector.revoke(session.deviceId)).toBe(true);
    await until(() => revoked !== undefined);
    expect(revoked!.auth).toBe(true);
    expect(live.closed).toBe(true);
    await expect(RelayClient.connect(session, { socket: connect })).rejects.toMatchObject({ auth: true });
    expect(connector.devices()).toEqual([]);
  });

  it("a stolen session record without the phone's private key is refused", async () => {
    const { connect, pairPhone } = await setup();
    const { session, client } = await pairPhone();
    client.close();
    const { generateKeyPair } = await import("../../src/mobile-relay/e2e");
    const stolen: RelaySession = { ...session, keys: await generateKeyPair() };
    await expect(RelayClient.connect(stolen, { socket: connect })).rejects.toBeInstanceOf(MobileError);
  });

  it("keeps the desktop's identity across restarts and turns off cleanly", async () => {
    const { store, connector } = await setup();
    const key = store.settings()!.publicKey;
    await connector.setURL("wss://relay.example/ws");
    expect(store.settings()!.publicKey).toBe(key);
    expect((await connector.setURL(null)).state).toBe("off");
    await expect(connector.pair(["main"])).rejects.toThrow(/relay on/);
    expect(() => store.setURL("http://relay.example")).rejects.toThrow(/wss/);
  });
});
