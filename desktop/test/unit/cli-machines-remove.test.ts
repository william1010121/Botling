// Botling 3 M4-05: `botlingd machines remove` CLI and local-only admin ops (`machine.removePreview`, `machine.remove`).
// Uses real RosterStore, PairingService, SessionServer (Unix socket), AdminClient, RemoteSession, and SessionCore
// with WebCrypto keys in temp folders (no window, no network listener).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  AdminOp, decodeFrame, encodeFrame, memberFingerprint, memberIdFromKey, roleRefusal, toBase64Url,
  type AdminOp as AdminOpType, type Message, type MessageOf,
} from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity, type ServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { AdminClient, PairingService, removeMachineCommand, type CliIo } from "../../src/server/pairing";
import { readAudits, RosterStore } from "../../src/server/roster";
import { RemoteSessions, SessionCore, SessionServer, slotAuthorize, writeToken, type RemoteHost, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { generateDhKeyPair, SessionLink, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";

const root = testRoot("cli-machines-remove");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const EPOCH = "0123456789abcdef0123456789abcdef";
const encoder = new TextEncoder();
let n = 0;

interface ServerNode {
  dir: string;
  store: ServerStore;
  identity: ServerIdentity;
  roster: RosterStore;
  setup: ClusterSetup;
  pairing: PairingService;
  host: RemoteHost;
  remote: RemoteSessions;
  socketPath: string;
  token: string;
  adminCalls: AdminOpType[];
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

async function makeServer(serverName: string): Promise<ServerNode> {
  const dir = join(root, `s${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir);
  const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const logs: string[] = [];
  let clock = 1_000;
  const roster = await RosterStore.open(store, identity, { now: () => ++clock, log: (line) => logs.push(line) });
  const setup = new ClusterSetup(roster);
  const pairing = new PairingService({
    roster, cluster: setup, identity, serverName,
    addresses: () => ({ tailnet: "https://tailnet-name.invalid" }),
    pageUrl: () => "https://tailnet-name.invalid/v3/",
    log: (line) => logs.push(line),
  });
  const engine = new FakeTurnEngine({ bots: [BOT], chunks: ["ok"], chunkMs: 1 });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const runtime = new IntentRuntime({ store, engine, hub, live, log: (line) => logs.push(line), authorize: slotAuthorize(roster), serverEvents: "all", mirrorBotUpdates: true });
  await runtime.start();
  const shell = new ShellBridge();
  const socketPath = join(dir, "botlingd.sock");
  const token = writeToken(join(dir, "botlingd.token"));
  const adminCalls: AdminOpType[] = [];
  const base: SessionHost = {
    serverId, serverName, startedAt: Date.now(), minFeVersion: "3.0.0", token: () => token,
    hub, live, runtime, engine, content: null, shell,
    nextFor: () => ({}),
    ensureBotStream: async (botId) => { if (!engine.hasBot(botId)) return false; await store.submit((tx) => { ensureBot(tx, botId); }); return true; },
    log: (line) => logs.push(line),
    admin: {
      handle: (op) => { adminCalls.push(op); return pairing.admin(op); },
      onEvent: (listener) => pairing.onEvent(listener),
    },
  };
  const host: RemoteHost = { ...base, roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, pairing };
  const remote = new RemoteSessions(host);
  const local = new SessionServer(socketPath, base);
  await local.listen();

  let stopped = false;
  cleanups.push(async () => {
    if (stopped) return;
    stopped = true;
    local.close();
    pairing.close();
    remote.close();
    await runtime.scope.submit(() => undefined);
    engine.close();
    runtime.close();
    shell.close();
    live.close();
    hub.close();
    await store.close();
  });

  return { dir, store, identity, roster, setup, pairing, host, remote, socketPath, token, adminCalls };
}

async function deviceKeys() {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await generateDhKeyPair();
  const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  const member = await memberIdFromKey(signPub);
  return { member, sign, dh, keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) } };
}

async function connectAdmin(node: ServerNode): Promise<AdminClient> {
  const client = await AdminClient.connect(node.socketPath, node.token);
  cleanups.push(() => client.close());
  return client;
}

function scriptedIo(answers: Array<string | null>) {
  const out: string[] = [];
  const asked: string[] = [];
  const io: CliIo = {
    out: (line) => { out.push(line); },
    ask: async (prompt) => { asked.push(prompt); return answers.length ? answers.shift()! : null; },
  };
  return { io, out, asked };
}

/** Builds root s1 ("studio") → s2 ("build-box") with phone "Pixel" on s2, synced across s1 and s2. */
async function twoServerCluster() {
  const s1 = await makeServer("studio");
  const started = await s1.setup.begin();
  expect((await s1.setup.confirm(started.code)).ok).toBe(true);

  const s2 = await makeServer("build-box");
  const addS2 = await s1.roster.addServer({ keys: s2.identity.keys, name: "build-box" });
  const addS2Stmt = s1.roster.statements().find((item) => item.id === addS2.addId)!.statement;
  await s2.roster.joinCluster({
    add: addS2Stmt,
    roster: s1.roster.statements().map((item) => item.statement),
    sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "studio" },
  });

  const pixel = await deviceKeys();
  await s2.roster.addDevice({ keys: pixel.keys, name: "Pixel" });

  const all = [...s1.roster.statements(), ...s2.roster.statements()].map((item) => item.statement);
  await s1.roster.merge(all);
  await s2.roster.merge(all);
  return { s1, s2, pixel };
}

/** A minimal non-local SessionCore subclass that bypasses decodeFrame to test SessionCore's own !this.kind.local check. */
class NonLocalCoreProbe extends SessionCore {
  constructor(host: SessionHost) { super(host); }
  protected readonly kind = { local: false } as const;
  readonly sent: Message[] = [];
  protected get writable() { return true; }
  protected writeTexts(texts: string[]) { for (const text of texts) this.sent.push(JSON.parse(text) as Message); return true; }
  protected endTransport() {}
  protected destroyTransport() {}
  protected checkHello() { return null; }
  protected cmdScope() { return { scope: "read" as const }; }
  protected reqRefusal() { return null; }
  inject(message: Message) { this.onMessage(message); }
}

describe("M4-05: botlingd machines remove", () => {
  it("AdminOp parses machine.removePreview and machine.remove", () => {
    const id = "a".repeat(26);
    expect(AdminOp.safeParse({ op: "machine.removePreview", member: "build-box" }).success).toBe(true);
    expect(AdminOp.safeParse({ op: "machine.remove", member: id, cascade: true }).success).toBe(true);
    expect(AdminOp.safeParse({ op: "machine.remove", member: id, cascade: false }).success).toBe(true);
    expect(AdminOp.safeParse({ op: "machine.remove", member: "not-an-id", cascade: true }).success).toBe(false);
  });

  it("1. on the root, typing 'remove' shows the preview and signs a revocation with cascade", async () => {
    const { s1, s2, pixel } = await twoServerCluster();
    const client = await connectAdmin(s1);
    const { io, out, asked } = scriptedIo(["remove"]);

    const code = await removeMachineCommand(client, io, "build-box");
    expect(code).toBe(0);

    const fp = memberFingerprint(s2.identity.memberId);
    expect(out[0]).toBe(`Remove "build-box" (fingerprint ${fp})?`);
    expect(out[1]).toBe('It also removes what it added: 1 phone ("Pixel"), 0 machines.');
    expect(asked).toEqual([
      'Type "remove" to remove it and what it added, "only" to remove just build-box, anything else to stop: ',
    ]);

    expect(s1.roster.isValid(s2.identity.memberId)).toBe(false);
    expect(s1.roster.isValid(pixel.member)).toBe(false);
    const revokes = s1.roster.statements().filter((item) => item.statement.body.type === "revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.statement.body).toMatchObject({
      type: "revoke",
      member: s2.identity.memberId,
      by: s1.identity.memberId,
      gen: 1,
      cascade: true,
    });
    expect(readAudits(s1.store.openReader()).filter((row) => row.act === "server.revoke")).toHaveLength(1);
  });

  it("2. typing 'only' signs a revocation without cascade (phone stays valid)", async () => {
    const { s1, s2, pixel } = await twoServerCluster();
    const client = await connectAdmin(s1);
    const { io } = scriptedIo(["only"]);

    const code = await removeMachineCommand(client, io, "build-box");
    expect(code).toBe(0);
    expect(s1.roster.isValid(s2.identity.memberId)).toBe(false);
    expect(s1.roster.isValid(pixel.member)).toBe(true);

    const revokes = s1.roster.statements().filter((item) => item.statement.body.type === "revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.statement.body).toMatchObject({
      type: "revoke",
      member: s2.identity.memberId,
      cascade: false,
    });
  });

  it("3. anything else (including EOF on stdin) signs nothing and exits 1", async () => {
    const { s1, s2, pixel } = await twoServerCluster();
    const client = await connectAdmin(s1);
    const beforeCount = s1.roster.statements().length;

    for (const answer of [null, "", "yes", "y", "no", "rem"]) {
      const { io, out } = scriptedIo([answer]);
      const code = await removeMachineCommand(client, io, "build-box");
      expect(code).toBe(1);
      expect(out.at(-1)).toMatch(/stopped|nothing was removed/i);
      expect(s1.roster.statements().length).toBe(beforeCount);
      expect(s1.roster.isValid(s2.identity.memberId)).toBe(true);
      expect(s1.roster.isValid(pixel.member)).toBe(true);
    }
    expect(readAudits(s1.store.openReader()).filter((row) => row.act === "server.revoke")).toHaveLength(0);
  });

  it("4. on a non-root server, prints the exact root message, exits 1, and signs nothing", async () => {
    const { s1, s2 } = await twoServerCluster();
    const s3 = await makeServer("edge-box");
    const addS3 = await s2.roster.addServer({ keys: s3.identity.keys, name: "edge-box" });
    const addS3Stmt = s2.roster.statements().find((item) => item.id === addS3.addId)!.statement;
    await s3.roster.joinCluster({
      add: addS3Stmt,
      roster: s2.roster.statements().map((item) => item.statement),
      sponsor: { member: s2.identity.memberId, keys: s2.identity.keys, name: "build-box" },
    });
    await s1.roster.merge(s3.roster.statements().map((item) => item.statement));
    await s2.roster.merge(s3.roster.statements().map((item) => item.statement));

    const client2 = await connectAdmin(s2);
    const beforeS2 = s2.roster.statements().length;
    const beforeS1 = s1.roster.statements().length;

    const { io, out, asked } = scriptedIo(["remove"]);
    const code = await removeMachineCommand(client2, io, "edge-box");
    expect(code).toBe(1);
    expect(asked).toEqual([]);
    expect(out).toEqual(["Only the revocation root (studio) can remove a machine. Run this there."]);
    expect(s2.roster.statements().length).toBe(beforeS2);
    expect(s1.roster.statements().length).toBe(beforeS1);

    // Direct machine.remove admin op on non-root also refuses and signs nothing.
    await expect(client2.request({ op: "machine.remove", member: s3.identity.memberId, cascade: true })).rejects.toThrow();
    expect(s2.roster.statements().length).toBe(beforeS2);
  });

  it("5. the preview lists the cascade (phones and machines) by name and excludes already-removed members", async () => {
    const { s1, s2 } = await twoServerCluster();
    const gonePhone = await deviceKeys();
    await s2.roster.addDevice({ keys: gonePhone.keys, name: "Old Phone" });
    await s2.roster.revokeDevice(gonePhone.member, "retired");

    const s3 = await makeServer("edge-box");
    const addS3 = await s2.roster.addServer({ keys: s3.identity.keys, name: "edge-box" });
    const addS3Stmt = s2.roster.statements().find((item) => item.id === addS3.addId)!.statement;
    await s3.roster.joinCluster({
      add: addS3Stmt,
      roster: s2.roster.statements().map((item) => item.statement),
      sponsor: { member: s2.identity.memberId, keys: s2.identity.keys, name: "build-box" },
    });
    const watch = await deviceKeys();
    await s3.roster.addDevice({ keys: watch.keys, name: "Watch" });

    await s1.roster.merge([...s2.roster.statements(), ...s3.roster.statements()].map((item) => item.statement));

    const client = await connectAdmin(s1);
    const { io, out } = scriptedIo([null]); // EOF after reading preview
    expect(await removeMachineCommand(client, io, "build-box")).toBe(1);

    expect(out[1]).toContain("2 phones");
    expect(out[1]).toContain('"Pixel"');
    expect(out[1]).toContain('"Watch"');
    expect(out[1]).not.toContain('"Old Phone"');
    expect(out[1]).toContain('1 machine ("edge-box")');
  });

  it("6. the admin op is refused on a remote (non-local) session (both role table and session check)", async () => {
    const { s1, s2 } = await twoServerCluster();
    const adminDevice = await deviceKeys();
    await s1.roster.addDevice({ keys: adminDevice.keys, name: "Manage Phone", scope: ["read", "reply", "approve", "manage"] });

    // 6a: role table rejects `admin` on non-local sessions (and decodeFrame turns it into bye{role}).
    expect(roleRefusal("admin", "fe", { local: false })).not.toBeNull();
    const encodedRemove = encodeFrame(
      { t: "admin", req: "r1", op: { op: "machine.remove", member: s2.identity.memberId, cascade: true } },
      "fe",
      { local: true },
    );
    expect(encodedRemove.ok).toBe(true);
    if (encodedRemove.ok) {
      const decoded = decodeFrame(encodedRemove.text, "fe", { local: false });
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.bye.reason).toBe("role");
    }

    // 6b: real RemoteSession over SessionLink ends with bye{role} and never reaches admin.handle.
    const remoteGot: Message[] = [];
    let link!: SessionLink;
    const toDevice: SessionTransport = { send: (frame) => link.receive(frame), close: () => { setTimeout(() => link.transportClosed(), 0); } };
    const session = s1.remote.accept(toDevice, "memory");
    const toServer: SessionTransport = { send: (frame) => session.receive(frame), close: () => { setTimeout(() => session.transportClosed(), 0); } };
    link = SessionLink.initiate(toServer, {
      mode: "ik", transport: "memory", cluster: s1.roster.clusterId!,
      self: { memberId: adminDevice.member, dhPub: adminDevice.dh.publicKey, dhKey: adminDevice.dh.privateKey },
      responder: { memberId: s1.host.self.memberId, dhPub: s1.host.self.dhPub },
    }, {
      onFrame: (bytes) => {
        const parsed = decodeFrame(bytes, "server", { local: false });
        if (parsed.ok) remoteGot.push(parsed.message);
      },
      onEnd: () => undefined,
    });
    await link.established;
    link.send("control", encoder.encode(JSON.stringify({
      t: "hello", deviceId: adminDevice.member, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH,
      cursors: {}, outbox: [], want: [],
    })));
    await waitFor(() => remoteGot.some((m) => m.t === "welcome"), "welcome");
    link.send("control", encoder.encode(JSON.stringify({
      t: "admin", req: "r1", op: { op: "machine.remove", member: s2.identity.memberId, cascade: true },
    })));
    await waitFor(() => remoteGot.some((m) => m.t === "bye" && m.reason === "role"), "bye{role}");
    expect(s1.adminCalls).toEqual([]);
    expect(s1.roster.isValid(s2.identity.memberId)).toBe(true);
    link.transportClosed();
    session.transportClosed();

    // 6c: SessionCore's own !this.kind.local guard refuses both machine.remove and machine.removePreview even if decodeFrame is bypassed.
    const probe = new NonLocalCoreProbe(s1.host);
    probe.inject({ t: "hello", deviceId: adminDevice.member, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [] } as MessageOf<"hello">);
    probe.inject({ t: "admin", req: "r2", op: { op: "machine.remove", member: s2.identity.memberId, cascade: true } } as MessageOf<"admin">);
    probe.inject({ t: "admin", req: "r3", op: { op: "machine.removePreview", member: "build-box" } } as MessageOf<"admin">);
    await waitFor(() => probe.sent.some((m: Message) => m.t === "res" && m.req === "r3"), "forbidden res");
    expect(probe.sent.find((m: Message): m is MessageOf<"res"> => m.t === "res" && m.req === "r2")).toMatchObject({
      t: "res", req: "r2", ok: false, error: { code: "forbidden" },
    });
    expect(probe.sent.find((m: Message): m is MessageOf<"res"> => m.t === "res" && m.req === "r3")).toMatchObject({
      t: "res", req: "r3", ok: false, error: { code: "forbidden" },
    });
    expect(s1.adminCalls).toEqual([]);
    expect(s1.roster.isValid(s2.identity.memberId)).toBe(true);
    probe.close();
  });

  it("supports --yes and --only for scripts, refuses ambiguous names until given an id, and refuses removing the root", async () => {
    const { s1, s2, pixel } = await twoServerCluster();
    const dup = await makeServer("build-box");
    const addDup = await s1.roster.addServer({ keys: dup.identity.keys, name: "build-box" });
    const addDupStmt = s1.roster.statements().find((item) => item.id === addDup.addId)!.statement;
    await dup.roster.joinCluster({
      add: addDupStmt,
      roster: s1.roster.statements().map((item) => item.statement),
      sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "studio" },
    });

    const client = await connectAdmin(s1);

    // Ambiguous name: asks for the id instead, signs nothing.
    const ambig = scriptedIo(["remove"]);
    expect(await removeMachineCommand(client, ambig.io, "build-box")).toBe(1);
    expect(ambig.asked).toEqual([]);
    expect(ambig.out.join("\n")).toMatch(/id/i);
    expect(s1.roster.isValid(s2.identity.memberId)).toBe(true);
    expect(s1.roster.isValid(dup.identity.memberId)).toBe(true);

    // Removing the root itself is refused.
    const selfTry = scriptedIo(["remove"]);
    expect(await removeMachineCommand(client, selfTry.io, "studio")).toBe(1);
    expect(selfTry.asked).toEqual([]);
    expect(s1.roster.isValid(s1.identity.memberId)).toBe(true);

    // --only removes dup by id without prompting, keeping anything it could have added.
    const onlyRun = scriptedIo([]);
    expect(await removeMachineCommand(client, onlyRun.io, dup.identity.memberId, { only: true })).toBe(0);
    expect(onlyRun.asked).toEqual([]);
    expect(s1.roster.isValid(dup.identity.memberId)).toBe(false);

    // --yes removes s2 by id with cascade without prompting.
    const yesRun = scriptedIo([]);
    expect(await removeMachineCommand(client, yesRun.io, s2.identity.memberId, { yes: true })).toBe(0);
    expect(yesRun.asked).toEqual([]);
    expect(s1.roster.isValid(s2.identity.memberId)).toBe(false);
    expect(s1.roster.isValid(pixel.member)).toBe(false);
  });
});
