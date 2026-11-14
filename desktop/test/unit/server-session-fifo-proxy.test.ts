// D58 / F1 (plan-change-routing-fixes.md): one device session is a FIFO stream. A real front end (fe-link with its
// outbox and wsDial over Node's WebSocket) talks to botlingd's loopback listener in this process (server.db in a temp
// folder, the roster, the intent runtime with the owner's slot check, a fake turn engine) through the M3 fault proxy
// (test/support/fault-proxy.ts). The proxy drops one frame of the device's session on its way up: the server sees the
// next frame out of order, ends the session, the front end re-attaches and re-sends its outbox. Every command is
// applied exactly once, in slot order.
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { FeLink, MemoryFeStorage, wsDial, type OutboxItem } from "../../src/fe-link";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { LoopbackListener } from "../../src/server/net";
import { RosterStore } from "../../src/server/roster";
import { RemoteSessions, slotAuthorize, type RemoteHost, type RemoteSession, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore } from "../../src/server/store";
import { generateDhKeyPair, type SessionEnd, type SessionTransport } from "../../src/session";
import { memberIdFromKey, toBase64Url, type Slot, type StreamId, type Target } from "../../src/protocol";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";
import { FaultProxy } from "../support/fault-proxy";

const root = testRoot("session-fifo-proxy");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000058";
const bot = `bot:${BOT}` as StreamId;

async function waitFor<T>(probe: () => T | null | undefined | false, what: string, ms = 15_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function server() {
  const dir = `${root}/d${cleanups.length}-${Date.now()}`;
  const store = await openServerStore(dir);
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
  const sessions: Array<{ session: RemoteSession; end: SessionEnd | null }> = [];
  const acceptor = {
    accept: (transport: SessionTransport, kind: "tailnet") => {
      const session = remote.accept(transport, kind);
      const entry = { session, end: null as SessionEnd | null };
      session.onClosed(() => { entry.end = session.link.ending; });
      sessions.push(entry);
      return session;
    },
  };
  const listener = await LoopbackListener.start({ port: 0, remote: acceptor, pageDir: null, origins: () => [], log: (line) => logs.push(line) });
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
    roster, host, listener, sessions, logs,
    cmdEntries: () => hub.reader().prepare("SELECT kind, slot FROM entries WHERE stream = ? AND kind LIKE 'cmd.%' ORDER BY seq").all(bot)
      .map((row) => `${String(row.kind)}#${(JSON.parse(String(row.slot)) as Slot).n}`),
    messages: () => hub.reader().prepare("SELECT body FROM entries WHERE stream = ? AND kind = 'message.added' ORDER BY seq").all(bot)
      .map((row) => JSON.parse(String(row.body)) as Record<string, unknown>),
  };
}

describe("F1 (D58): a frame the network drops ends the device session; the front end re-sends from its outbox", () => {
  it("one dropped frame → the session ends (order), the outbox re-sends, slots 1–3 are applied once each, in order", async () => {
    const s = await server();
    const proxy = await FaultProxy.start({ target: s.listener.port, framing: "websocket" });
    cleanups.push(() => proxy.close());

    // A paired device: its keys made with WebCrypto as the page makes them.
    const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const dh = await generateDhKeyPair();
    const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
    const member = await memberIdFromKey(signPub);
    await s.roster.addDevice({ keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) }, name: "Phone" });

    const link = await FeLink.open({
      storage: new MemoryFeStorage(), deviceId: member, feVersion: "3.0.0", local: false, reconnectMinMs: 20, reconnectMaxMs: 100,
      dial: wsDial({
        url: () => `${proxy.url}/v3/ws`,
        identity: { cluster: s.roster.clusterId!, memberId: member, dh, server: { memberId: s.host.self.memberId, dhPub: s.host.self.dhPub } },
      }),
    });
    cleanups.push(() => link.close());
    const outcomes: OutboxItem[] = [];
    link.on((event) => { if (event.type === "outcome") outcomes.push(event.item); });
    const target = bot as unknown as Target;
    link.start();
    await waitFor(() => link.state === "live" || null, "the first session");

    await link.submit(target, { type: "chat.send", botId: BOT, text: "one" });
    await waitFor(() => outcomes.length === 1 || null, "slot 1's outcome");
    // Let the session go quiet (acks of slot 1's entries), then lose exactly the next frame up: slot 2's `cmd`.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = proxy.count("drop", "up");
    proxy.drop("up");
    await link.submit(target, { type: "chat.send", botId: BOT, text: "two" });
    await waitFor(() => proxy.count("drop", "up") === before + 1 || null, "the proxy drops one frame");
    await link.submit(target, { type: "chat.send", botId: BOT, text: "three" });

    await waitFor(() => outcomes.length === 3 || null, "slots 2 and 3 after the re-send");
    // The first session ended on the gap (the session layer's `order`), not by a timeout; a second one carried the re-send.
    expect(s.sessions.length).toBeGreaterThanOrEqual(2);
    expect(s.sessions[0]!.end).toMatchObject({ reason: "order" });
    expect(outcomes.map((item) => [item.slot.n, item.outcome?.kind])).toEqual([[1, "applied"], [2, "applied"], [3, "applied"]]);
    // Nothing applied twice or out of order: one cmd.applied per slot, in slot order, and three messages in send order.
    expect(s.cmdEntries()).toEqual(["cmd.applied#1", "cmd.applied#2", "cmd.applied#3"]);
    const users = s.messages().map((body) => body.message as { role: string; text?: string; content?: unknown }).filter((m) => m.role === "user");
    expect(users.map((m) => JSON.stringify(m)).map((text) => ["one", "two", "three"].find((word) => text.includes(`"${word}"`)))).toEqual(["one", "two", "three"]);
  }, 30_000);
});
