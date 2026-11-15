// Botling 3 M5-14a: `plugin.grant` command and its owner-side apply (D54, §11.7, §4.1 check 3).
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { Command, PROTOCOL_VERSION, RENDERER_COMMANDS, parseInbound, type Outbound } from "../../src/contract";
import { Core } from "../../src/core/server";
import {
  COMMAND_SCOPES, decodeFrame, encodeFrame, memberIdFromKey, toBase64Url,
  type CmdBody, type Message, type MessageOf, type Slot, type StreamId, type WireMessage,
} from "../../src/protocol";
import { PluginRow } from "../../src/protocol/table-rows";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { OwnerInbox, type InboxSession } from "../../src/server/forward/owner-inbox";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { COMMAND_ROUTES, IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { ownTableStream, putRow, readRowBody } from "../../src/server/replica/tables";
import { RosterStore } from "../../src/server/roster";
import {
  RemoteSession, RemoteSessions, slotAuthorize, statedScope,
  type DeviceRoster, type RemoteHost, type SessionHost,
} from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type Db, type ServerStore } from "../../src/server/store";
import { generateDhKeyPair, SessionLink, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";
import { EPOCH_A } from "./server-slots-harness";

const root = testRoot("plugin-grant-command");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const EPOCH = "0123456789abcdef0123456789abcdef";
const HASH_1 = "a".repeat(64);
const HASH_2 = "b".repeat(64);
const HASH_UNKNOWN = "f".repeat(64);
const PEER_ID = "srv-peer-1";
const REMOTE = { local: false } as const;
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

function samplePluginRow(over: {
  codeHash?: string;
  tier?: "read" | "request" | "write";
  reads?: string[];
  requests?: string[];
  grants?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    codeHash: over.codeHash ?? HASH_1,
    manifest: {
      tier: over.tier ?? "request",
      reads: over.reads ?? ["chat.snapshot"],
      requests: over.requests ?? ["chat.send", "chat.react"],
      owns: [],
      provides: [],
      requires: [],
      uses: [],
      clients: [],
      needsShell: [],
    },
    author: "user",
    grants: over.grants ?? {},
  };
}

function readGrantAudits(db: Db, stream: string): Array<{ key: string; rev: number; body: Record<string, unknown> }> {
  return db.prepare("SELECT key, rev, body FROM rows WHERE stream = ? AND key LIKE 'audit:%' AND deleted = 0 ORDER BY rev")
    .all(stream)
    .map((row) => ({ key: String(row.key), rev: Number(row.rev), body: JSON.parse(String(row.body)) as Record<string, unknown> }))
    .filter((row) => row.body.act === "plugin.grant");
}

interface Server {
  dir: string;
  store: ServerStore;
  roster: RosterStore;
  runtime: IntentRuntime;
  host: RemoteHost;
  remote: RemoteSessions;
  serverId: string;
  serverStream: string;
  inc(): string;
  db(): Db;
}

async function startTestServer(extraValidServers: Set<string> = new Set([PEER_ID])): Promise<Server> {
  const dir = `${root}/d${++folders}`;
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir, { create: true });
  const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const logs: string[] = [];
  const roster = await RosterStore.open(store, identity, { log: (line) => logs.push(line) });
  const setup = new ClusterSetup(roster);
  const started = await setup.begin();
  expect((await setup.confirm(started.code)).ok).toBe(true);
  const engine = new FakeTurnEngine({ bots: [BOT] });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const deviceRoster: DeviceRoster = {
    memberId: roster.memberId,
    device: (member) => roster.device(member),
    server: (member) => member !== roster.memberId && extraValidServers.has(member),
  };
  const runtime = new IntentRuntime({
    store,
    engine,
    hub,
    live,
    log: (line) => logs.push(line),
    authorize: slotAuthorize(deviceRoster),
    serverEvents: "all",
    mirrorBotUpdates: true,
  });
  await runtime.start();
  const shell = new ShellBridge();
  const base: SessionHost = {
    serverId,
    serverName: "Test server",
    startedAt: Date.now(),
    minFeVersion: "3.0.0",
    token: () => "t".repeat(32),
    hub,
    live,
    runtime,
    engine,
    content: null,
    shell,
    nextFor: (origin, originEpoch) => {
      const next: Record<string, number> = {};
      for (const row of hub.reader().prepare("SELECT target, next FROM slots WHERE origin = ? AND originEpoch = ?").all(origin, originEpoch)) {
        next[String(row.target)] = Number(row.next);
      }
      return next;
    },
    ensureBotStream: async (botId) => {
      if (!engine.hasBot(botId)) return false;
      await store.submit((tx) => { ensureBot(tx, botId); });
      return true;
    },
    log: (line) => logs.push(line),
  };
  const host: RemoteHost = { ...base, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey } };
  const remote = new RemoteSessions(host);
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
    dir,
    store,
    roster,
    runtime,
    host,
    remote,
    serverId,
    serverStream: `srv:${serverId}`,
    inc: () => String(hub.reader().prepare("SELECT logId FROM streams WHERE stream = ?").get(`srv:${serverId}`)!.logId),
    db: () => hub.reader(),
  };
}

async function deviceKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await generateDhKeyPair();
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const member = await memberIdFromKey(signPub);
  return { member, dh, keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) } };
}

class DeviceClient {
  readonly got: Message[] = [];
  link!: SessionLink;
  session!: RemoteSession;
  n = 0;

  constructor(readonly s: Server, readonly member: string) {}

  dial(keys: Awaited<ReturnType<typeof deviceKeys>>): this {
    const toDevice: SessionTransport = { send: (frame) => this.link.receive(frame), close: () => { setTimeout(() => this.link.transportClosed(), 0); } };
    this.session = this.s.remote.accept(toDevice, "memory");
    const toServer: SessionTransport = { send: (frame) => this.session.receive(frame), close: () => { setTimeout(() => this.session.transportClosed(), 0); } };
    this.link = SessionLink.initiate(toServer, {
      mode: "ik",
      transport: "memory",
      cluster: this.s.roster.clusterId!,
      self: { memberId: keys.member, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
      responder: { memberId: this.s.host.self.memberId, dhPub: this.s.host.self.dhPub },
    }, {
      onFrame: (bytes) => {
        const frame = decodeFrame(bytes, "server", REMOTE);
        if (!frame.ok) throw new Error(`bad server frame: ${frame.detail}`);
        this.got.push(frame.message);
      },
      onEnd: () => {},
    });
    return this;
  }

  async open(): Promise<void> {
    await this.link.established;
    this.send({
      t: "hello",
      deviceId: this.member,
      feVersion: "3.0.0",
      protocol: 1,
      originEpoch: EPOCH,
      cursors: {},
      outbox: [],
      want: [],
    });
    await waitFor(() => this.got.find((m) => m.t === "welcome"), "welcome");
  }

  send(message: Message): void {
    const encoded = encodeFrame(message, "fe", REMOTE);
    if (!encoded.ok) throw new Error(encoded.detail);
    this.link.send("control", encoder.encode(encoded.text));
  }

  async sendCmd(cmd: Command): Promise<MessageOf<"cmd.result">> {
    const n = ++this.n;
    const target = this.s.serverStream as StreamId;
    this.send({
      t: "cmd",
      slot: { origin: this.member, originEpoch: EPOCH, target, n },
      floor: 1,
      inc: this.s.inc(),
      cmd,
    } as Message);
    return waitFor(
      () => this.got.find((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === n),
      `cmd.result #${n}`,
    );
  }
}

async function seedPlugin(s: Server, name: string, row: Record<string, unknown>): Promise<void> {
  await s.store.submit((tx) => {
    putRow(tx, ownTableStream(tx), `plugin:${name}`, row);
  });
}

describe("M5-14a: plugin.grant command and owner-side apply", () => {
  it("1. from the local window (scope local): applies, writes grants[codeHash] with grantedBy user and one audit row", async () => {
    const s = await startTestServer();
    await seedPlugin(s, "my.plugin", samplePluginRow({ tier: "write", reads: ["chat.snapshot", "notes"], requests: ["chat.send", "chat.react"] }));

    const status = await s.runtime.receive(
      {
        slot: { origin: "desktop", originEpoch: EPOCH_A, target: s.serverStream as StreamId, n: 1 },
        floor: 1,
        inc: s.inc(),
        cmd: {
          type: "plugin.grant",
          plugin: "my.plugin",
          codeHash: HASH_1,
          tier: "request",
          reads: ["chat.snapshot", "chat.snapshot"],
          requests: ["chat.send", "chat.send"],
        },
      } as CmdBody,
      { scope: "local" },
    );

    expect(status).toMatchObject({
      status: "result",
      fresh: true,
      message: {
        t: "cmd.result",
        outcome: { kind: "applied", result: { applied: true } },
      },
    });

    const stored = PluginRow.parse(readRowBody(s.db(), s.serverStream, "plugin:my.plugin"));
    expect(stored.grants[HASH_1]).toMatchObject({
      tier: "request",
      reads: ["chat.snapshot"],
      requests: ["chat.send"],
      grantedBy: "user",
    });
    expect(stored.grants[HASH_1]!.at).toBeGreaterThanOrEqual(0);

    const audits = readGrantAudits(s.db(), s.serverStream);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.body).toMatchObject({
      act: "plugin.grant",
      member: "desktop",
      name: "my.plugin",
      hash: HASH_1,
    });
  });

  it("2. from a device with manage: applies; from a device without manage: refused scope; revoked device: refused origin", async () => {
    const s = await startTestServer();
    await seedPlugin(s, "my.plugin", samplePluginRow({ tier: "request", reads: ["chat.snapshot"], requests: ["chat.send"] }));

    const manager = await deviceKeys();
    const phone = await deviceKeys();
    await s.roster.addDevice({ keys: manager.keys, name: "Manager", scope: ["read", "reply", "approve", "manage"] });
    await s.roster.addDevice({ keys: phone.keys, name: "Phone", scope: ["read", "reply", "approve"] });

    const cmd: Command = {
      type: "plugin.grant",
      plugin: "my.plugin",
      codeHash: HASH_1,
      tier: "request",
      reads: ["chat.snapshot"],
      requests: ["chat.send"],
    };

    const phoneClient = new DeviceClient(s, phone.member).dial(phone);
    await phoneClient.open();
    const denied = await phoneClient.sendCmd(cmd);
    expect(denied.outcome).toMatchObject({ kind: "refused", reason: "scope" });
    expect(PluginRow.parse(readRowBody(s.db(), s.serverStream, "plugin:my.plugin")).grants).toEqual({});
    expect(readGrantAudits(s.db(), s.serverStream)).toHaveLength(0);

    const managerClient = new DeviceClient(s, manager.member).dial(manager);
    await managerClient.open();
    const applied = await managerClient.sendCmd(cmd);
    expect(applied.outcome).toEqual({ kind: "applied", result: { applied: true } });
    const rowAfter = PluginRow.parse(readRowBody(s.db(), s.serverStream, "plugin:my.plugin"));
    expect(rowAfter.grants[HASH_1]).toMatchObject({ tier: "request", grantedBy: "user" });
    expect(readGrantAudits(s.db(), s.serverStream)).toHaveLength(1);
    expect(readGrantAudits(s.db(), s.serverStream)[0]!.body.member).toBe(manager.member);

    // Revoking the manager device blocks subsequent slot authorization.
    await s.roster.revokeDevice(manager.member, "lost");
    const afterRevoke = await s.runtime.receive(
      {
        slot: { origin: manager.member, originEpoch: EPOCH, target: s.serverStream as StreamId, n: 2 },
        floor: 1,
        inc: s.inc(),
        cmd,
      } as CmdBody,
      { scope: "manage" },
    );
    expect(afterRevoke).toMatchObject({
      status: "result",
      message: { outcome: { kind: "refused", reason: "origin" } },
    });
  });

  it("3. from a server origin (including peer OwnerInbox, self, and revoked/unknown server): refused origin", async () => {
    const validServers = new Set([PEER_ID]);
    const s = await startTestServer(validServers);
    await seedPlugin(s, "my.plugin", samplePluginRow());

    const cmd: Command = {
      type: "plugin.grant",
      plugin: "my.plugin",
      codeHash: HASH_1,
      tier: "read",
      reads: [],
      requests: [],
    };

    // Direct slotAuthorize checks for valid peer server (any stated scope), self, revoked, and unknown.
    const authorize = slotAuthorize({
      memberId: s.roster.memberId,
      device: (m) => s.roster.device(m),
      server: (m) => m !== s.roster.memberId && validServers.has(m),
    });
    const tx = null as never;
    const srvSlot = (origin: string): Slot => ({ origin, originEpoch: EPOCH, target: s.serverStream as StreamId, n: 1 });
    expect(authorize(tx, { slot: srvSlot(PEER_ID), cmd, scope: "manage" })).toEqual({
      reason: "origin",
      detail: "plugin.grant is only from a user (a device or this machine's window)",
    });
    expect(authorize(tx, { slot: srvSlot(PEER_ID), cmd, scope: "read" })).toEqual({
      reason: "origin",
      detail: "plugin.grant is only from a user (a device or this machine's window)",
    });
    expect(authorize(tx, { slot: srvSlot(s.roster.memberId), cmd, scope: "manage" })).toMatchObject({ reason: "origin" });

    // Through OwnerInbox (peer server forwarding a `cmd` frame to this owner).
    const inbox = new OwnerInbox({ self: s.serverId, runtime: s.runtime, log: () => {} });
    const sent: WireMessage[] = [];
    const peerSession: InboxSession = {
      peer: PEER_ID,
      state: "open",
      sendWire: (m) => { sent.push(m); return true; },
      bye: () => {},
    };
    inbox.onMessage(peerSession, {
      t: "cmd",
      slot: { origin: PEER_ID, originEpoch: EPOCH, target: s.serverStream as StreamId, n: 1 },
      floor: 1,
      inc: s.inc(),
      scope: "manage",
      cmd,
    } as WireMessage);
    const peerRes = await waitFor(
      () => sent.find((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result"),
      "peer cmd.result",
    );
    expect(peerRes.outcome).toEqual({
      kind: "refused",
      reason: "origin",
      detail: "plugin.grant is only from a user (a device or this machine's window)",
    });

    // Even if the peer server is later revoked, it is still refused with reason `origin`.
    validServers.delete(PEER_ID);
    const revokedStatus = await s.runtime.receive(
      {
        slot: { origin: PEER_ID, originEpoch: EPOCH, target: s.serverStream as StreamId, n: 2 },
        floor: 1,
        inc: s.inc(),
        cmd,
      } as CmdBody,
      { scope: "manage" },
    );
    expect(revokedStatus).toMatchObject({
      status: "result",
      message: { outcome: { kind: "refused", reason: "origin" } },
    });
    expect(PluginRow.parse(readRowBody(s.db(), s.serverStream, "plugin:my.plugin")).grants).toEqual({});
    expect(readGrantAudits(s.db(), s.serverStream)).toHaveLength(0);
  });

  it("4. with via: refused grant even from the local window or a manage device", async () => {
    const s = await startTestServer();
    await seedPlugin(s, "my.plugin", samplePluginRow());

    const status = await s.runtime.receive(
      {
        slot: { origin: "desktop", originEpoch: EPOCH_A, target: s.serverStream as StreamId, n: 1 },
        floor: 1,
        inc: s.inc(),
        via: { plugin: "my.plugin", codeHash: HASH_1 },
        cmd: {
          type: "plugin.grant",
          plugin: "my.plugin",
          codeHash: HASH_1,
          tier: "read",
          reads: [],
          requests: [],
        },
      } as CmdBody,
      { scope: "local" },
    );
    expect(status).toMatchObject({
      status: "result",
      message: { outcome: { kind: "refused", reason: "grant" } },
    });
    expect(PluginRow.parse(readRowBody(s.db(), s.serverStream, "plugin:my.plugin")).grants).toEqual({});
    expect(readGrantAudits(s.db(), s.serverStream)).toHaveLength(0);
  });

  it("5. grant above the manifest's ask (tier, reads, or requests) is refused invalid with 'above what the plugin asks'", async () => {
    const s = await startTestServer();
    await seedPlugin(s, "reader.only", samplePluginRow({ tier: "read", reads: ["chat.snapshot"], requests: [] }));
    await seedPlugin(s, "requester", samplePluginRow({ tier: "request", reads: ["chat.snapshot"], requests: ["chat.send"] }));

    const sendLocal = (n: number, cmd: Command) =>
      s.runtime.receive(
        { slot: { origin: "desktop", originEpoch: EPOCH_A, target: s.serverStream as StreamId, n }, floor: 1, inc: s.inc(), cmd } as CmdBody,
        { scope: "local" },
      );

    const aboveTier = await sendLocal(1, {
      type: "plugin.grant",
      plugin: "reader.only",
      codeHash: HASH_1,
      tier: "write",
      reads: [],
      requests: [],
    });
    expect(aboveTier).toMatchObject({
      status: "result",
      message: { outcome: { kind: "refused", reason: "invalid", detail: "above what the plugin asks" } },
    });

    const aboveReads = await sendLocal(2, {
      type: "plugin.grant",
      plugin: "reader.only",
      codeHash: HASH_1,
      tier: "read",
      reads: ["chat.history"],
      requests: [],
    });
    expect(aboveReads).toMatchObject({
      status: "result",
      message: { outcome: { kind: "refused", reason: "invalid", detail: "above what the plugin asks" } },
    });

    const aboveRequests = await sendLocal(3, {
      type: "plugin.grant",
      plugin: "requester",
      codeHash: HASH_1,
      tier: "request",
      reads: ["chat.snapshot"],
      requests: ["chat.send", "bots.create"],
    });
    expect(aboveRequests).toMatchObject({
      status: "result",
      message: { outcome: { kind: "refused", reason: "invalid", detail: "above what the plugin asks" } },
    });

    // Lowering a request plugin to tier "read" clears requests in the stored grant (even if manifest.requests were echoed).
    const lowerOk = await sendLocal(4, {
      type: "plugin.grant",
      plugin: "requester",
      codeHash: HASH_1,
      tier: "read",
      reads: ["chat.snapshot"],
      requests: ["chat.send"],
    });
    expect(lowerOk).toMatchObject({ status: "result", message: { outcome: { kind: "applied" } } });
    expect(PluginRow.parse(readRowBody(s.db(), s.serverStream, "plugin:requester")).grants[HASH_1]).toMatchObject({
      tier: "read",
      reads: ["chat.snapshot"],
      requests: [],
    });
  });

  it("6. unknown codeHash or missing plugin is refused changed; wrong srv: target is refused invalid", async () => {
    const s = await startTestServer();
    await seedPlugin(s, "my.plugin", samplePluginRow({
      codeHash: HASH_2,
      grants: { [HASH_1]: { tier: "read", reads: [], requests: [], grantedBy: "user", at: 1_000 } },
    }));

    const sendLocal = (n: number, cmd: Command, target: StreamId = s.serverStream as StreamId) =>
      s.runtime.receive(
        { slot: { origin: "desktop", originEpoch: EPOCH_A, target, n }, floor: 1, inc: s.inc(), cmd } as CmdBody,
        { scope: "local" },
      );

    // Unknown hash (neither current codeHash HASH_2 nor in grants) -> changed.
    const unknownHash = await sendLocal(1, {
      type: "plugin.grant",
      plugin: "my.plugin",
      codeHash: HASH_UNKNOWN,
      tier: "read",
      reads: [],
      requests: [],
    });
    expect(unknownHash).toMatchObject({
      status: "result",
      message: { outcome: { kind: "refused", reason: "changed" } },
    });

    // Old hash still in grants (HASH_1) IS known -> applies.
    const oldKnown = await sendLocal(2, {
      type: "plugin.grant",
      plugin: "my.plugin",
      codeHash: HASH_1,
      tier: "request",
      reads: ["chat.snapshot"],
      requests: ["chat.send"],
    });
    expect(oldKnown).toMatchObject({
      status: "result",
      message: { outcome: { kind: "applied", result: { applied: true } } },
    });

    // Missing plugin -> changed.
    const missingPlugin = await sendLocal(3, {
      type: "plugin.grant",
      plugin: "absent.plugin",
      codeHash: HASH_1,
      tier: "read",
      reads: [],
      requests: [],
    });
    expect(missingPlugin).toMatchObject({
      status: "result",
      message: { outcome: { kind: "refused", reason: "changed" } },
    });

    // Wrong srv: target -> invalid.
    const wrongTarget = await sendLocal(
      1,
      { type: "plugin.grant", plugin: "my.plugin", codeHash: HASH_2, tier: "read", reads: [], requests: [] },
      "srv:other-server",
    );
    expect(wrongTarget).toMatchObject({
      status: "result",
      message: { outcome: { kind: "refused", reason: "invalid" } },
    });
  });

  it("7. same slot re-sent: identical command is idempotent duplicate; different tier gets slot conflict", async () => {
    const s = await startTestServer();
    await seedPlugin(s, "my.plugin", samplePluginRow());

    const slot = { origin: "desktop", originEpoch: EPOCH_A, target: s.serverStream as StreamId, n: 1 };
    const first = await s.runtime.receive(
      {
        slot,
        floor: 1,
        inc: s.inc(),
        cmd: { type: "plugin.grant", plugin: "my.plugin", codeHash: HASH_1, tier: "read", reads: [], requests: [] },
      } as CmdBody,
      { scope: "local" },
    );
    expect(first).toMatchObject({
      status: "result",
      fresh: true,
      message: { outcome: { kind: "applied", result: { applied: true } } },
    });

    const dup = await s.runtime.receive(
      {
        slot,
        floor: 1,
        inc: s.inc(),
        cmd: { type: "plugin.grant", plugin: "my.plugin", codeHash: HASH_1, tier: "read", reads: [], requests: [] },
      } as CmdBody,
      { scope: "local" },
    );
    expect(dup).toMatchObject({
      status: "result",
      fresh: false,
      message: { outcome: { kind: "applied", result: { applied: true } } },
    });
    expect(readGrantAudits(s.db(), s.serverStream)).toHaveLength(1);

    const conflict = await s.runtime.receive(
      {
        slot,
        floor: 1,
        inc: s.inc(),
        cmd: { type: "plugin.grant", plugin: "my.plugin", codeHash: HASH_1, tier: "request", reads: [], requests: ["chat.send"] },
      } as CmdBody,
      { scope: "local" },
    );
    expect(conflict).toMatchObject({
      status: "result",
      fresh: false,
      message: { outcome: { kind: "refused", reason: "slot conflict" } },
    });
    expect(PluginRow.parse(readRowBody(s.db(), s.serverStream, "plugin:my.plugin")).grants[HASH_1]?.tier).toBe("read");
    expect(readGrantAudits(s.db(), s.serverStream)).toHaveLength(1);
  });

  it("8. tier 'none' removes the grant at that hash only; > 20 grants prunes oldest non-current hash; schema bounds and 2.x Core refusal", async () => {
    const s = await startTestServer();
    const twenty: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      twenty[`oldhash-${String(i).padStart(2, "0")}`] = {
        tier: "read",
        reads: [],
        requests: [],
        grantedBy: "user",
        at: 1_000 + i,
      };
    }
    await seedPlugin(s, "pruner", samplePluginRow({ codeHash: HASH_1, grants: twenty }));
    await seedPlugin(s, "two-hashes", samplePluginRow({
      codeHash: HASH_2,
      grants: {
        [HASH_1]: { tier: "read", reads: [], requests: [], grantedBy: "user", at: 1_000 },
        [HASH_2]: { tier: "request", reads: ["chat.snapshot"], requests: ["chat.send"], grantedBy: "user", at: 2_000 },
      },
    }));

    // Revoking HASH_1 leaves HASH_2 intact.
    const revoke = await s.runtime.receive(
      {
        slot: { origin: "desktop", originEpoch: EPOCH_A, target: s.serverStream as StreamId, n: 1 },
        floor: 1,
        inc: s.inc(),
        cmd: { type: "plugin.grant", plugin: "two-hashes", codeHash: HASH_1, tier: "none", reads: [], requests: [] },
      } as CmdBody,
      { scope: "local" },
    );
    expect(revoke).toMatchObject({ status: "result", message: { outcome: { kind: "applied", result: { applied: true } } } });
    const afterRevoke = PluginRow.parse(readRowBody(s.db(), s.serverStream, "plugin:two-hashes"));
    expect(afterRevoke.grants[HASH_1]).toBeUndefined();
    expect(afterRevoke.grants[HASH_2]?.tier).toBe("request");

    // Granting HASH_1 when 20 older grants already exist prunes the oldest (oldhash-00) and stays <= 20.
    const pruned = await s.runtime.receive(
      {
        slot: { origin: "desktop", originEpoch: EPOCH_A, target: s.serverStream as StreamId, n: 2 },
        floor: 1,
        inc: s.inc(),
        cmd: { type: "plugin.grant", plugin: "pruner", codeHash: HASH_1, tier: "request", reads: [], requests: ["chat.send"] },
      } as CmdBody,
      { scope: "local" },
    );
    expect(pruned).toMatchObject({ status: "result", message: { outcome: { kind: "applied", result: { applied: true } } } });
    const afterPrune = PluginRow.parse(readRowBody(s.db(), s.serverStream, "plugin:pruner"));
    expect(Object.keys(afterPrune.grants)).toHaveLength(20);
    expect(afterPrune.grants["oldhash-00"]).toBeUndefined();
    expect(afterPrune.grants[HASH_1]?.tier).toBe("request");

    // Schema bounds, routing, and scopes.
    expect(COMMAND_SCOPES["plugin.grant"]).toBe("manage");
    expect(COMMAND_ROUTES["plugin.grant"]).toEqual({ kind: "intent" });
    expect(RENDERER_COMMANDS.has("plugin.grant")).toBe(true);
    expect(statedScope({
      type: "plugin.grant",
      plugin: "p",
      codeHash: HASH_1,
      tier: "read",
      reads: [],
      requests: [],
    })).toBe("manage");

    expect(parseInbound({
      v: PROTOCOL_VERSION,
      id: "g1",
      cmd: { type: "plugin.grant", plugin: "p", codeHash: HASH_1, tier: "none", reads: [], requests: [] },
    }).ok).toBe(true);
    expect(Command.safeParse({
      type: "plugin.grant",
      plugin: "p",
      codeHash: HASH_1,
      tier: "read",
      reads: [],
      requests: [],
      extra: 1,
    }).success).toBe(false);
    expect(Command.safeParse({
      type: "plugin.grant",
      plugin: "Bad Name",
      codeHash: HASH_1,
      tier: "read",
      reads: [],
      requests: [],
    }).success).toBe(false);
    expect(Command.safeParse({
      type: "plugin.grant",
      plugin: "p",
      codeHash: "bad hash!",
      tier: "read",
      reads: [],
      requests: [],
    }).success).toBe(false);
    expect(Command.safeParse({
      type: "plugin.grant",
      plugin: "p",
      codeHash: HASH_1,
      tier: "admin",
      reads: [],
      requests: [],
    }).success).toBe(false);
    expect(Command.safeParse({
      type: "plugin.grant",
      plugin: "p",
      codeHash: HASH_1,
      tier: "read",
      reads: Array.from({ length: 51 }, (_, i) => `r${i}`),
      requests: [],
    }).success).toBe(false);
    expect(Command.safeParse({
      type: "plugin.grant",
      plugin: "p",
      codeHash: HASH_1,
      tier: "request",
      reads: [],
      requests: Array.from({ length: 101 }, () => "chat.send"),
    }).success).toBe(false);
    expect(Command.safeParse({
      type: "plugin.grant",
      plugin: "p",
      codeHash: HASH_1,
      tier: "request",
      reads: [],
      requests: ["not.a.command"],
    }).success).toBe(false);

    // 2.x Core.receive never applies plugin.grant.
    const emitted: Outbound[] = [];
    const coreDir = `${root}/core-${++folders}`;
    const core = new Core({
      dataDir: coreDir,
      headConfig() { throw new Error("No agent allowed"); },
      emit: (outbound) => emitted.push(outbound),
      deferStartup: true,
      routineTickMs: 0,
      componentScanMs: 0,
      waitingScanMs: 0,
      watchMs: 0,
      quitTidyMs: 0,
    });
    core.receive({ v: PROTOCOL_VERSION, id: "boot", cmd: { type: "boot.commit" } });
    await waitFor(() => emitted.find((m) => "id" in m && m.id === "boot"), "core boot");
    core.receive({
      v: PROTOCOL_VERSION,
      id: "grant-2x",
      cmd: { type: "plugin.grant", plugin: "p", codeHash: HASH_1, tier: "read", reads: [], requests: [] },
    });
    const coreRes = await waitFor(
      () => emitted.find((m): m is Extract<Outbound, { id: string }> => "id" in m && m.id === "grant-2x"),
      "core grant refusal",
    );
    expect(coreRes).toMatchObject({ ok: false, error: { code: "not_found" } });
    await core.shutdown();
  });
});
