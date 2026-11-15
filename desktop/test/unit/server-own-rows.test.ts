// M5-14e: a front end that subs the attached server's own `srv:` stream gets the table's `plugin:` rows as `rows` frames,
// beside the log (session-core.ts `sub`, `ownTableFrame`). Real remote sessions over the encrypted link, a real
// TableFeeds on the server's store. Checks: a device with the `read` scope gets the whole table first (`after: 0`), cut to
// `plugin:` rows (no `machine`, `settings`, `audit:` or `bot:` rows, no `reset`), then deltas (new row, tombstone), and
// still the log's own frames; a device without `read` gets nothing (the sub is refused as before); `unsub` and the end of
// the session stop the feed.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  decodeWireFrame, encodeFrame, memberIdFromKey, toBase64Url, type Message, type WireMessage,
} from "../../src/protocol";
import type { Rows } from "../../src/protocol/table-rows";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { effectCheckpointSink, ensureBot } from "../../src/server/effects";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { deleteRow, putRow, TableFeeds, tableRev } from "../../src/server/replica";
import { RosterStore } from "../../src/server/roster";
import { RemoteSessions, slotAuthorize, type RemoteHost, type SessionHost } from "../../src/server/session";
import { ownTableFrame, type SessionTables } from "../../src/server/session/session-core";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { importDhKeyPair, SessionLink, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";
import { flush } from "./fe-link-harness";

const REMOTE = { local: false } as const;
const EPOCH = "0123456789abcdef0123456789abcdef";
const BOT = "b1";
const EMPTY = { reads: [], requests: [], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] };
const pluginBody = (name: string) => ({ codeHash: `sha256:${name}`, manifest: { tier: "read", ...EMPTY }, author: "user", grants: {} });

const root = testRoot("server-own-rows");
const stores: ServerStore[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const store of stores.splice(0)) await store.close();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

let dirSeq = 0;
async function makeDeviceKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const rawDh = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const dh = await importDhKeyPair(new Uint8Array(await crypto.subtle.exportKey("pkcs8", rawDh.privateKey)));
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const member = await memberIdFromKey(signPub);
  return { member, dh, keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) } };
}

async function startServer() {
  const dir = join(root, `s${++dirSeq}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  stores.push(store);
  const identity = await loadOrCreateServerIdentity(dir);
  await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity, { now: () => 1_000_000 });
  const setup = new ClusterSetup(roster);
  const started = await setup.begin();
  expect((await setup.confirm(started.code)).ok).toBe(true);
  const own = `srv:${identity.memberId}`;

  const engine = new FakeTurnEngine({ bots: [BOT] });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const runtime = new IntentRuntime({
    store, engine, hub, live, log: () => undefined,
    authorize: slotAuthorize(roster), serverEvents: "all", mirrorBotUpdates: true,
  });
  await runtime.start();
  const shell = new ShellBridge();
  // The own table's feed, as botlingd makes it; the rows it holds: plugin rows and rows of the other kinds.
  const feeds = new TableFeeds({ reader: () => hub.reader(), ownStream: own, pollMs: 20 });
  feeds.start();
  const write = async (change: (tx: Parameters<Parameters<ServerStore["submit"]>[0]>[0]) => void) => {
    await store.submit(change);
    feeds.notify(own);
  };
  await write((tx) => {
    putRow(tx, own, "plugin:alpha", pluginBody("alpha"));
    putRow(tx, own, "plugin:beta", pluginBody("beta"));
    putRow(tx, own, "audit:one", { act: "device.add", at: 1 });
    putRow(tx, own, "settings", { theme: "dark" });
  });
  const tables: SessionTables = {
    peers: () => [], onPeer: () => () => undefined,
    isPeerTable: () => false,
    isOwnTable: (stream) => stream === feeds.ownStream,
    subscribe: (stream, cursor, sink) => feeds.subscribe(stream, cursor, sink),
  };
  const base: SessionHost = {
    serverId: identity.memberId, serverName: "Mac Studio", startedAt: 1_000, minFeVersion: "3.0.0", token: () => "t".repeat(32),
    hub, live, runtime, engine, content: null, shell, nextFor: () => ({}),
    ensureBotStream: async (botId) => { if (!engine.hasBot(botId)) return false; await store.submit((tx) => { ensureBot(tx, botId); }); return true; },
    log: () => undefined, tables,
  };
  const host: RemoteHost = { ...base, roster, self: { memberId: identity.memberId, dhPub: identity.dhPub, dhKey: identity.dhKey } };
  const remote = new RemoteSessions(host);
  cleanups.push(async () => {
    remote.close(); feeds.close();
    await runtime.scope.submit(() => undefined);
    engine.close(); runtime.close(); shell.close(); live.close(); hub.close();
  });

  return { identity, roster, store, own, feeds, write, remote, hub };
}

type Server = Awaited<ReturnType<typeof startServer>>;

async function connect(server: Server, device: Awaited<ReturnType<typeof makeDeviceKeys>>) {
  const got: WireMessage[] = [];
  let session!: ReturnType<RemoteSessions["accept"]>;
  const toDevice: SessionTransport = { send: (frame) => link.receive(frame), close: () => setTimeout(() => link.transportClosed(), 0) };
  session = server.remote.accept(toDevice, "memory");
  const toServer: SessionTransport = { send: (frame) => session.receive(frame), close: () => setTimeout(() => session.transportClosed(), 0) };
  const link = SessionLink.initiate(toServer, {
    mode: "ik", transport: "memory", cluster: server.roster.clusterId!,
    self: { memberId: device.member, dhPub: device.dh.publicKey, dhKey: device.dh.privateKey },
    responder: { memberId: server.identity.memberId, dhPub: server.identity.dhPub },
  }, {
    onFrame: (bytes) => { const decoded = decodeWireFrame(bytes, "server", REMOTE); if (decoded.ok) got.push(decoded.message); },
    onEnd: () => undefined,
  });
  await link.established;
  const send = (message: Message) => {
    const encoded = encodeFrame(message, "fe", REMOTE);
    if (!encoded.ok) throw new Error(encoded.detail);
    link.send("control", new TextEncoder().encode(encoded.text));
  };
  send({ t: "hello", deviceId: device.member, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [] });
  await flush();
  cleanups.push(() => { link.close(); session.close(); });
  return { got, send, session, close: () => { link.close(); session.close(); } };
}

const rowsOf = (got: WireMessage[], stream: string) => got.filter((m): m is Rows => m.t === "rows" && m.stream === stream);

describe("M5-14e: the own table's plugin rows to a front end", () => {
  it("a device with the read scope gets the plugin rows whole, then deltas, beside the log; never the other rows or a reset", async () => {
    const server = await startServer();
    const phone = await makeDeviceKeys();
    await server.roster.addDevice({ keys: phone.keys, name: "Phone", scope: ["read", "reply"] });
    const fe = await connect(server, phone);
    fe.send({ t: "sub", stream: server.own as never, cursor: null });
    await flush();

    const first = rowsOf(fe.got, server.own);
    expect(first).toHaveLength(1);
    expect(first[0].after).toBe(0);
    expect(first[0].more).toBe(false);
    expect(first[0].rows.map((row) => row.key).sort()).toEqual(["plugin:alpha", "plugin:beta"]);
    expect(first[0].to).toBe(tableRev(server.hub.reader(), server.own));
    // The log path still answers the same sub (a snapshot of the own stream), and no `reset` came from the table feed.
    expect(fe.got.some((m) => m.t === "snap" && m.stream === server.own)).toBe(true);
    expect(fe.got.some((m) => m.t === "reset")).toBe(false);

    // A new plugin row, a tombstone and a row of another kind: a delta of the plugin rows only (rev still moves).
    await server.write((tx) => {
      putRow(tx, server.own, "plugin:gamma", pluginBody("gamma"));
      deleteRow(tx, server.own, "plugin:alpha", 1_000);
      putRow(tx, server.own, "audit:two", { act: "device.add", at: 2 });
    });
    await flush();
    const deltas = rowsOf(fe.got, server.own).slice(1);
    expect(deltas.length).toBeGreaterThan(0);
    const last = deltas[deltas.length - 1];
    expect(last.after).toBe(first[0].to);
    expect(last.to).toBe(tableRev(server.hub.reader(), server.own));
    expect(deltas.flatMap((delta) => delta.rows).map((row) => [row.key, row.deleted === true]).sort()).toEqual([["plugin:alpha", true], ["plugin:gamma", false]]);
  });

  it("a device without the read scope gets no rows (its sub is refused, as before)", async () => {
    const server = await startServer();
    const watcher = await makeDeviceKeys();
    await server.roster.addDevice({ keys: watcher.keys, name: "Reply only", scope: ["reply"] });
    const fe = await connect(server, watcher);
    fe.send({ t: "sub", stream: server.own as never, cursor: null });
    await flush();
    expect(rowsOf(fe.got, server.own)).toEqual([]);
    expect(server.feeds.count(server.own)).toBe(0);
  });

  it("unsub and the end of the session stop the feed; a second sub does not double it", async () => {
    const server = await startServer();
    const phone = await makeDeviceKeys();
    await server.roster.addDevice({ keys: phone.keys, name: "Phone", scope: ["read"] });
    const fe = await connect(server, phone);
    fe.send({ t: "sub", stream: server.own as never, cursor: null });
    await flush();
    fe.send({ t: "sub", stream: server.own as never, cursor: null });
    await flush();
    expect(server.feeds.count(server.own)).toBe(1);
    fe.send({ t: "unsub", stream: server.own as never });
    await flush();
    expect(server.feeds.count(server.own)).toBe(0);
    fe.send({ t: "sub", stream: server.own as never, cursor: null });
    await flush();
    expect(server.feeds.count(server.own)).toBe(1);
    fe.close();
    await flush();
    expect(server.feeds.count(server.own)).toBe(0);
  });
});

describe("M5-14e: ownTableFrame", () => {
  const frame = (rows: Array<Record<string, unknown>>) => ({ t: "rows", stream: "srv:x", logId: "incown01", after: 2, to: 9, rows, more: false }) as unknown as WireMessage;
  it("keeps the batch's after/to and only the plugin rows (tombstones included); drops other kinds of rows", () => {
    const out = ownTableFrame(frame([
      { key: "machine", rev: 3, body: {} }, { key: "plugin:a", rev: 4, body: {} }, { key: "plugin:b", rev: 5, deleted: true },
      { key: "settings", rev: 6, body: {} }, { key: "audit:1", rev: 7, body: {} }, { key: "bot:b1", rev: 8, body: {} },
      { key: "weird:kind", rev: 9, body: {} },
    ])) as Rows;
    expect(out.rows.map((row) => row.key)).toEqual(["plugin:a", "plugin:b"]);
    expect([out.after, out.to, out.more, out.logId]).toEqual([2, 9, false, "incown01"]);
  });
  it("drops a reset and every frame that is not rows", () => {
    expect(ownTableFrame({ t: "reset", stream: "srv:x", logId: "incown01", retired: [], reason: "restored" } as unknown as WireMessage)).toBeNull();
  });
});
