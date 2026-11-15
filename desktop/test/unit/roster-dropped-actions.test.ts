// Botling 3 M4-10: dropped-list actions ("revoke again", "dismiss", audit rows).
// Uses real RosterStore, PairingService, SessionServer (Unix socket), AdminClient, RemoteSession, and SessionCore
// with WebCrypto keys and real server.db stores in temp folders (no windows, no network listener).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  AdminOp, AuditRow, decodeFrame, encodeFrame, memberIdFromKey, roleRefusal, TableRow, toBase64Url,
  type AdminOp as AdminOpType, type Message, type MessageOf, type SignedStatement,
} from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity, recoveryKeyFromCode, type ServerIdentity } from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { AdminClient, droppedMachinesCommand, PairingService, type CliIo } from "../../src/server/pairing";
import { readAudits, RosterError, RosterStore, signStatement, signWith } from "../../src/server/roster";
import { RemoteSessions, SessionCore, SessionServer, slotAuthorize, writeToken, type RemoteHost, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { generateDhKeyPair, SessionLink, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";

const root = testRoot("roster-dropped-actions");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

const BOT = "6A0B0000-0000-4000-8000-000000000002";
const EPOCH = "0123456789abcdef0123456789abcdef";
const encoder = new TextEncoder();
let n = 0;

interface ServerNode {
  dir: string;
  serverName: string;
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
  close(): Promise<void>;
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

async function startNode(dir: string, serverName: string, clock: () => number): Promise<ServerNode> {
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir);
  const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const logs: string[] = [];
  const roster = await RosterStore.open(store, identity, { now: clock, log: (line) => logs.push(line) });
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
  const close = async () => {
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
  };
  cleanups.push(close);

  return { dir, serverName, store, identity, roster, setup, pairing, host, remote, socketPath, token, adminCalls, close };
}

async function makeServer(serverName: string, clock: () => number): Promise<ServerNode> {
  const dir = join(root, `s${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return startNode(dir, serverName, clock);
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

/**
 * Builds s1 ("studio", gen 1 root) -> s2 ("build-box") -> s4 ("edge-box", with phone "Pixel"),
 * s1 revokes s4 at gen 1 (`revS4`), then reroots to s2 (`Root{gen: 2, keep: []}`), leaving `revS4` out.
 * Both s1 and s2 hold all statements after reroot.
 */
async function rerootWithDroppedScenario(options: { arrivedAfter?: boolean; revokeOldRoot?: boolean } = {}) {
  let clock = 1_000;
  const tick = () => (clock += 10);

  let s1 = await makeServer("studio", tick);
  const started = await s1.setup.begin();
  expect((await s1.setup.confirm(started.code)).ok).toBe(true);
  const recovery = await recoveryKeyFromCode(started.code);
  const cluster = s1.roster.clusterId!;

  const s2 = await makeServer("build-box", tick);
  const addS2 = await s1.roster.addServer({ keys: s2.identity.keys, name: "build-box" });
  const addS2Stmt = s1.roster.statements().find((item) => item.id === addS2.addId)!.statement;
  await s2.roster.joinCluster({
    add: addS2Stmt,
    roster: s1.roster.statements().map((item) => item.statement),
    sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "studio" },
  });

  const s4 = await makeServer("edge-box", tick);
  const addS4 = await s1.roster.addServer({ keys: s4.identity.keys, name: "edge-box" });
  const addS4Stmt = s1.roster.statements().find((item) => item.id === addS4.addId)!.statement;
  await s4.roster.joinCluster({
    add: addS4Stmt,
    roster: s1.roster.statements().map((item) => item.statement),
    sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "studio" },
  });

  const pixel = await deviceKeys();
  await s4.roster.addDevice({ keys: pixel.keys, name: "Pixel" });

  // Sync base membership to s1 and s2 before any revocation.
  const baseStatements = [...s1.roster.statements(), ...s2.roster.statements(), ...s4.roster.statements()].map((item) => item.statement);
  await s1.roster.merge(baseStatements);
  await s2.roster.merge(baseStatements);
  // Share s2's automatic Endorse statements back to s1 (as peer gossip does before any partition/reroot).
  await s1.roster.merge(s2.roster.statements().map((item) => item.statement));

  // s1 signs Revoke{s4, gen: 1, cascade: false}.
  const revS4 = await s1.roster.revokeServer(s4.identity.memberId, false, "offline");
  const revS4Stmt = s1.roster.statements().find((item) => item.id === revS4.revokeId)!.statement;
  if (!options.arrivedAfter) {
    // s2 saw revS4 before the reroot, then left it out of keep.
    await s2.roster.merge([revS4Stmt]);
  }

  // Build Root{gen: 2, root: s2, keep: []} signed by recovery key.
  const root1Id = s2.roster.view.root!.id;
  const root2 = await signStatement(
    { type: "root", cluster, gen: 2, root: s2.identity.memberId, recoveryPub: recovery.recoveryPub, keep: [], prev: root1Id },
    "recovery",
    signWith(recovery.privateKey),
  );
  await s2.roster.merge([root2.statement]);

  if (options.arrivedAfter) {
    // revS4 reaches s2 after Root{2}.
    await s2.roster.merge([revS4Stmt]);
  }

  if (options.revokeOldRoot) {
    await s2.roster.revokeServer(s1.identity.memberId, false, "retired");
  }

  // s1 learns of Root{2} (and optional revocation of s1 via D47 revocation exchange).
  await s1.roster.mergeRevocations(s2.roster.revocations().map((item) => item.statement));

  const restartS1 = async () => {
    await s1.close();
    s1 = await startNode(s1.dir, s1.serverName, tick);
    return s1;
  };

  return { s1, s2, s4, pixel, revS4Id: revS4.revokeId, root2, recovery, tick, restartS1 };
}

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

describe("M4-10: dropped-list actions (revoke again, dismiss, audit rows)", () => {
  it("1. 'revoke again' on the new root (cascade) makes s4 and its phone invalid everywhere, and the row disappears on both servers", async () => {
    const { s1, s2, s4, pixel, revS4Id } = await rerootWithDroppedScenario();
    expect(s2.roster.isValid(s4.identity.memberId)).toBe(true);
    expect(s2.roster.isValid(pixel.member)).toBe(true);
    expect(s1.roster.isValid(s4.identity.memberId)).toBe(true);
    expect(s2.roster.dropped().map((r) => r.revokeId)).toEqual([revS4Id]);
    expect(s1.roster.dropped().map((r) => r.revokeId)).toEqual([revS4Id]);

    const client2 = await connectAdmin(s2);
    const { io, out } = scriptedIo(["revoke", "remove"]);
    const code = await droppedMachinesCommand(client2, io);
    expect(code).toBe(0);
    expect(out[0]).toBe("These revocations did not carry over:");
    expect(out.join("\n")).toContain("edge-box");
    expect(out.join("\n")).toContain("left out by you at the reroot");

    expect(s2.roster.isValid(s4.identity.memberId)).toBe(false);
    expect(s2.roster.isValid(pixel.member)).toBe(false);
    expect(s2.roster.dropped()).toEqual([]);

    const gen2Revokes = s2.roster.statements()
      .map((item) => item.statement.body)
      .filter((body) => body.type === "revoke" && body.gen === 2);
    expect(gen2Revokes).toHaveLength(1);
    expect(gen2Revokes[0]).toMatchObject({
      type: "revoke",
      member: s4.identity.memberId,
      by: s2.identity.memberId,
      gen: 2,
      cascade: true,
    });

    // Propagate to s1 (gossip / revocation exchange): s4 and Pixel become invalid on s1 and row disappears there too.
    await s1.roster.merge(s2.roster.statements().map((item) => item.statement));
    expect(s1.roster.isValid(s4.identity.memberId)).toBe(false);
    expect(s1.roster.isValid(pixel.member)).toBe(false);
    expect(s1.roster.dropped()).toEqual([]);
  });

  it("1b. 'revoke again' with 'only' keeps s4's phone valid and clears the dropped row on both servers", async () => {
    const { s1, s2, s4, pixel } = await rerootWithDroppedScenario({ arrivedAfter: true });
    const client2 = await connectAdmin(s2);
    const { io, out } = scriptedIo(["revoke", "only"]);
    expect(await droppedMachinesCommand(client2, io)).toBe(0);
    expect(out.join("\n")).toContain("arrived after the reroot");

    expect(s2.roster.isValid(s4.identity.memberId)).toBe(false);
    expect(s2.roster.isValid(pixel.member)).toBe(true);
    expect(s2.roster.dropped()).toEqual([]);

    await s1.roster.merge(s2.roster.statements().map((item) => item.statement));
    expect(s1.roster.isValid(s4.identity.memberId)).toBe(false);
    expect(s1.roster.isValid(pixel.member)).toBe(true);
    expect(s1.roster.dropped()).toEqual([]);
  });

  it("2. 'dismiss' hides the row only on that server, signs nothing, changes no validity, and is not replicated", async () => {
    const { s1, s2, s4, pixel, revS4Id, tick } = await rerootWithDroppedScenario();
    const beforeStmts = s2.roster.statements().map((item) => item.id);
    const beforeValid = [...s2.roster.view.valid].sort();

    const client2 = await connectAdmin(s2);
    const { io } = scriptedIo(["dismiss"]);
    expect(await droppedMachinesCommand(client2, io)).toBe(0);

    // Hidden on s2, persists across restart, pure view.dropped untouched, no member validity changed, nothing signed.
    expect(s2.roster.dropped()).toEqual([]);
    expect(s2.roster.view.dropped.map((r) => r.revokeId)).toEqual([revS4Id]);
    expect(s2.roster.statements().map((item) => item.id)).toEqual(beforeStmts);
    expect([...s2.roster.view.valid].sort()).toEqual(beforeValid);
    expect(s2.roster.isValid(s4.identity.memberId)).toBe(true);
    expect(s2.roster.isValid(pixel.member)).toBe(true);

    const metaRow = s2.store.openReader().prepare("SELECT value FROM meta WHERE key = ?").get(`dropped.dismissed:${revS4Id}`);
    expect(metaRow).toBeDefined();

    // Restart s2: still dismissed and s4 still valid.
    await s2.close();
    const s2Reopened = await startNode(s2.dir, s2.serverName, tick);
    expect(s2Reopened.roster.dropped()).toEqual([]);
    expect(s2Reopened.roster.isValid(s4.identity.memberId)).toBe(true);

    // Not replicated: s1 still sees the dropped row.
    await s1.roster.merge(s2Reopened.roster.statements().map((item) => item.statement));
    expect(s1.roster.dropped().map((r) => r.revokeId)).toEqual([revS4Id]);

    // Idempotent dismiss and refusal on non-dropped ids.
    expect(await s2Reopened.roster.dismissDropped(revS4Id)).toEqual({ already: true });
    await expect(s2Reopened.roster.dismissDropped("a".repeat(64))).rejects.toMatchObject({ reason: "not-dropped" } satisfies Partial<RosterError>);
  });

  it("3. writes exactly one server.revoke.dropped audit row per revoke id per server, also after restarts", async () => {
    const { s1, s2, s4, revS4Id, tick, restartS1 } = await rerootWithDroppedScenario();

    const checkAudit = (node: ServerNode, expectedWhy: "left-out" | "arrived-after") => {
      const db = node.store.openReader();
      const rows = readAudits(db, 500).filter((row) => row.act === "server.revoke.dropped");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        act: "server.revoke.dropped",
        statement: revS4Id,
        by: s1.identity.memberId,
        member: s4.identity.memberId,
        reason: `gen 1: ${expectedWhy}`,
      });
      // Audit row also fits TableRow / AuditRow wire validation.
      const tableRow = db.prepare("SELECT key, rev, body FROM rows WHERE key LIKE 'audit:dropped:%'").get() as { key: string; rev: number; body: string } | undefined;
      expect(tableRow).toBeDefined();
      expect(AuditRow.safeParse(JSON.parse(tableRow!.body)).success).toBe(true);
      expect(TableRow.safeParse({ key: tableRow!.key, rev: tableRow!.rev, body: JSON.parse(tableRow!.body) }).success).toBe(true);
    };

    checkAudit(s2, "left-out");
    checkAudit(s1, "left-out");

    // Additional merges, dropped queries, and dismiss do not duplicate the audit row.
    await s2.roster.dismissDropped(revS4Id);
    const addExtra = await s2.roster.addDevice({ keys: (await deviceKeys()).keys, name: "Extra" });
    expect(addExtra.created).toBe(true);
    checkAudit(s2, "left-out");

    // Restart both servers: still exactly one server.revoke.dropped row each.
    await s2.close();
    const s2Reopened = await startNode(s2.dir, s2.serverName, tick);
    const s1Reopened = await restartS1();
    checkAudit(s2Reopened, "left-out");
    checkAudit(s1Reopened, "left-out");
  });

  it("4. on the old root, shows 're-do on <new root name>' and offers no sign action", async () => {
    // (a) Old root kept as a member and learns of Root{2}: shows its dropped revocation with 're-do on build-box'.
    {
      const { s1, s2 } = await rerootWithDroppedScenario({ revokeOldRoot: false });
      const client1 = await connectAdmin(s1);
      const { io, out, asked } = scriptedIo(["revoke", "remove"]);
      const code = await droppedMachinesCommand(client1, io);
      expect(code).toBe(0);
      expect(asked).toEqual([]);
      expect(out.join("\n")).toContain("re-do on build-box");
      // No gen-2 revocation was signed.
      expect(s1.roster.statements().some((item) => item.statement.body.type === "revoke" && item.statement.body.gen === 2)).toBe(false);
      // Direct machine.remove on old root is still refused by M4-05.
      await expect(client1.request({ op: "machine.remove", member: s2.identity.memberId, cascade: false })).rejects.toThrow();
    }

    // (b) Even when the old root itself was revoked, roster.dropped does not fail with self-revoked and never signs.
    {
      const { s1 } = await rerootWithDroppedScenario({ revokeOldRoot: true });
      const client1 = await connectAdmin(s1);
      const list = await client1.request({ op: "roster.dropped" }) as { isRoot: boolean; rootName: string | null };
      expect(list.isRoot).toBe(false);
      expect(list.rootName).toBe("build-box");
      const { io, asked } = scriptedIo(["revoke", "remove"]);
      expect(await droppedMachinesCommand(client1, io)).toBe(0);
      expect(asked).toEqual([]);
    }
  });

  it("5. nothing is ever revoked without the user's request, and admin ops are local-socket only", async () => {
    const { s2, s4, revS4Id } = await rerootWithDroppedScenario();
    const client2 = await connectAdmin(s2);
    const beforeCount = s2.roster.statements().length;

    // EOF / non-confirming answers at dropped prompt do nothing.
    for (const answer of [null, "", "yes", "y", "no", "skip"]) {
      const { io } = scriptedIo([answer]);
      expect(await droppedMachinesCommand(client2, io)).toBe(0);
      expect(s2.roster.statements().length).toBe(beforeCount);
      expect(s2.roster.isValid(s4.identity.memberId)).toBe(true);
      expect(s2.roster.dropped().map((r) => r.revokeId)).toEqual([revS4Id]);
    }

    // Choosing "revoke" then giving EOF or "yes" at M4-05's cascade prompt signs nothing.
    for (const cascadeAnswer of [null, "", "yes", "y"]) {
      const { io } = scriptedIo(["revoke", cascadeAnswer]);
      await droppedMachinesCommand(client2, io);
      expect(s2.roster.statements().length).toBe(beforeCount);
      expect(s2.roster.isValid(s4.identity.memberId)).toBe(true);
      expect(s2.roster.dropped().map((r) => r.revokeId)).toEqual([revS4Id]);
    }

    // AdminOp parses roster.dropped and roster.dismiss.
    expect(AdminOp.safeParse({ op: "roster.dropped" }).success).toBe(true);
    expect(AdminOp.safeParse({ op: "roster.dismiss", revokeId: revS4Id }).success).toBe(true);
    expect(AdminOp.safeParse({ op: "roster.dismiss", revokeId: "not-a-statement-id" }).success).toBe(false);

    // Role table & RemoteSession & SessionCore enforce local-socket only.
    const callsBeforeRemote = s2.adminCalls.length;
    expect(roleRefusal("admin", "fe", { local: false })).not.toBeNull();
    const adminDevice = await deviceKeys();
    await s2.roster.addDevice({ keys: adminDevice.keys, name: "Manage Phone", scope: ["read", "reply", "approve", "manage"] });

    const remoteGot: Message[] = [];
    let link!: SessionLink;
    const toDevice: SessionTransport = { send: (frame) => link.receive(frame), close: () => { setTimeout(() => link.transportClosed(), 0); } };
    const session = s2.remote.accept(toDevice, "memory");
    const toServer: SessionTransport = { send: (frame) => session.receive(frame), close: () => { setTimeout(() => session.transportClosed(), 0); } };
    link = SessionLink.initiate(toServer, {
      mode: "ik", transport: "memory", cluster: s2.roster.clusterId!,
      self: { memberId: adminDevice.member, dhPub: adminDevice.dh.publicKey, dhKey: adminDevice.dh.privateKey },
      responder: { memberId: s2.host.self.memberId, dhPub: s2.host.self.dhPub },
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
    link.send("control", encoder.encode(JSON.stringify({ t: "admin", req: "r1", op: { op: "roster.dismiss", revokeId: revS4Id } })));
    await waitFor(() => remoteGot.some((m) => m.t === "bye" && m.reason === "role"), "bye{role}");
    expect(s2.adminCalls.length).toBe(callsBeforeRemote);
    expect(s2.roster.dropped().map((r) => r.revokeId)).toEqual([revS4Id]);
    link.transportClosed();
    session.transportClosed();

    const probe = new NonLocalCoreProbe(s2.host);
    probe.inject({ t: "hello", deviceId: adminDevice.member, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [] } as MessageOf<"hello">);
    probe.inject({ t: "admin", req: "r2", op: { op: "roster.dropped" } } as MessageOf<"admin">);
    probe.inject({ t: "admin", req: "r3", op: { op: "roster.dismiss", revokeId: revS4Id } } as MessageOf<"admin">);
    await waitFor(() => probe.sent.some((m: Message) => m.t === "res" && m.req === "r3"), "forbidden res");
    expect(probe.sent.find((m: Message): m is MessageOf<"res"> => m.t === "res" && m.req === "r2")).toMatchObject({
      t: "res", req: "r2", ok: false, error: { code: "forbidden" },
    });
    expect(probe.sent.find((m: Message): m is MessageOf<"res"> => m.t === "res" && m.req === "r3")).toMatchObject({
      t: "res", req: "r3", ok: false, error: { code: "forbidden" },
    });
    expect(s2.adminCalls.length).toBe(callsBeforeRemote);
    expect(s2.roster.dropped().map((r) => r.revokeId)).toEqual([revS4Id]);
    probe.close();
  });
});
