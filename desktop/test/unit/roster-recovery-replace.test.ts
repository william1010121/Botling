// Botling 3 M4-12: `botlingd recovery replace` (`replaceRecovery` / `confirmRecovery` two-step, CLI, secret handling, §4.8).
// Uses real WebCrypto keys, real server.db stores, PairingService, SessionServer (Unix socket), and AdminClient in temp
// folders (no windows, no network listener).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { clusterIdFromRecoveryKey, memberIdFromKey, toBase64Url, toHex, type SignedStatement } from "../../src/protocol";
import {
  bindServerIdentity,
  ClusterSetup,
  loadOrCreateServerIdentity,
  newRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_INFO,
  RECOVERY_SALT,
  recoveryKeyFromCode,
  type ServerIdentity,
} from "../../src/server/identity";
import { AdminClient, PairingService, recoveryReplaceCommand, type CliIo } from "../../src/server/pairing";
import { readAudits, RosterError, RosterStore } from "../../src/server/roster";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { RemoteSessions, SessionServer, slotAuthorize, writeToken, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";

const root = testRoot("roster-recovery-replace");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

let n = 0;
function folder(): string {
  const dir = join(root, `d${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

interface Node {
  dir: string;
  serverName: string;
  store: ServerStore;
  identity: ServerIdentity;
  roster: RosterStore;
  setup: ClusterSetup;
  pairing: PairingService;
  socketPath: string;
  token: string;
  logs: string[];
  close(): Promise<void>;
}

async function makeServer(serverName: string, now: () => number = () => 1_000_000): Promise<Node> {
  const dir = folder();
  const logs: string[] = [];
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir);
  const { serverId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const roster = await RosterStore.open(store, identity, { now, log: (line) => logs.push(line) });
  const setup = new ClusterSetup(roster, { now });
  const pairing = new PairingService({
    roster,
    cluster: setup,
    identity,
    serverName,
    addresses: () => ({ tailnet: "https://tailnet-name.invalid" }),
    pageUrl: () => "https://tailnet-name.invalid/v3/",
    log: (line) => logs.push(line),
  });
  const engine = new FakeTurnEngine({ bots: ["6A0B0000-0000-4000-8000-000000000001"], chunks: ["ok"], chunkMs: 1 });
  const hub = new LogHub(store, { serverStreams: true });
  const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
  const runtime = new IntentRuntime({
    store, engine, hub, live, log: (line) => logs.push(line), authorize: slotAuthorize(roster), serverEvents: "all", mirrorBotUpdates: true,
  });
  await runtime.start();
  const shell = new ShellBridge();
  const socketPath = join(dir, "botlingd.sock");
  const token = writeToken(join(dir, "botlingd.token"));
  const host: SessionHost = {
    serverId,
    serverName,
    startedAt: Date.now(),
    minFeVersion: "3.0.0",
    token: () => token,
    hub,
    live,
    runtime,
    engine,
    content: null,
    shell,
    nextFor: () => ({}),
    ensureBotStream: async (botId) => { if (!engine.hasBot(botId)) return false; await store.submit((tx) => { ensureBot(tx, botId); }); return true; },
    log: (line) => logs.push(line),
    admin: {
      handle: (op) => pairing.admin(op),
      onEvent: (listener) => pairing.onEvent(listener),
    },
  };
  const remote = new RemoteSessions({ ...host, roster, self: { memberId: identity.memberId, dhPub: identity.dhPub, dhKey: identity.dhKey }, pairing });
  const local = new SessionServer(socketPath, host);
  await local.listen();

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
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
  return { dir, serverName, store, identity, roster, setup, pairing, socketPath, token, logs, close };
}

async function threeServers(now?: () => number) {
  let clock = 1_000;
  const tick = now ?? (() => ++clock);
  const s1 = await makeServer("Root One", tick);
  const started = await s1.setup.begin();
  expect((await s1.setup.confirm(started.code)).ok).toBe(true);

  const s2 = await makeServer("Server Two", tick);
  const addS2 = await s1.roster.addServer({ keys: s2.identity.keys, name: "Server Two" });
  const addS2Stmt = s1.roster.statements().find((item) => item.id === addS2.addId)!.statement;
  await s2.roster.joinCluster({
    add: addS2Stmt,
    roster: s1.roster.statements().map((item) => item.statement),
    sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "Root One" },
  });

  const s3 = await makeServer("Server Three", tick);
  const addS3 = await s1.roster.addServer({ keys: s3.identity.keys, name: "Server Three" });
  const addS3Stmt = s1.roster.statements().find((item) => item.id === addS3.addId)!.statement;
  await s3.roster.joinCluster({
    add: addS3Stmt,
    roster: s1.roster.statements().map((item) => item.statement),
    sponsor: { member: s1.identity.memberId, keys: s1.identity.keys, name: "Root One" },
  });

  const all = [...s1.roster.statements(), ...s2.roster.statements(), ...s3.roster.statements()].map((item) => item.statement);
  await s1.roster.merge(all);
  await s2.roster.merge(all);
  await s3.roster.merge(all);

  return { s1, s2, s3, code: started.code, clusterId: started.clusterId, tick };
}

async function rawSeedFromCode(typed: string): Promise<Uint8Array> {
  const normal = normalizeRecoveryCode(typed)!;
  const enc = new TextEncoder();
  const ikm = await crypto.subtle.importKey("raw", enc.encode(normal), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode(RECOVERY_SALT), info: enc.encode(RECOVERY_INFO) },
      ikm,
      256,
    ),
  );
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkFiles(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

function spellingsOf(code: string): string[] {
  const raw = normalizeRecoveryCode(code)!;
  return [
    raw,
    raw.match(/.{1,4}/g)!.join("-"),
    raw.match(/.{1,4}/g)!.join(" "),
    raw.toLowerCase(),
    raw.toLowerCase().match(/.{1,4}/g)!.join("-"),
    raw.toLowerCase().match(/.{1,4}/g)!.join(" "),
  ];
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

async function connectAdmin(node: Node): Promise<AdminClient> {
  const client = await AdminClient.connect(node.socketPath, node.token);
  cleanups.push(() => client.close());
  return client;
}

describe("M4-12: botlingd recovery replace", () => {
  it("1. only the current root can replace the code (and rejects unclustered / wrong old code)", async () => {
    const fresh = await makeServer("Lone");
    await expect(fresh.roster.replaceRecovery(newRecoveryCode())).rejects.toMatchObject({ reason: "no-cluster" });

    const { s1, s2, code } = await threeServers();
    // Non-root server s2 refuses even with the valid recovery code.
    await expect(s2.roster.replaceRecovery(code)).rejects.toMatchObject({ reason: "not-root" });

    // Current root s1 refuses wrong or malformed old code without containing the code in error text.
    const wrong = newRecoveryCode();
    let err: unknown;
    try {
      await s1.roster.replaceRecovery(wrong);
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(RosterError);
    expect((err as RosterError).reason).toBe("bad-code");
    expect((err as Error).message).not.toContain(wrong);
    await expect(s1.roster.replaceRecovery("not-a-code")).rejects.toMatchObject({ reason: "bad-code" });

    // After s2 reroots, s1 is no longer the root and cannot replace the code either.
    const rerootRes = await s2.roster.reroot({ code, oldRootLost: false, keep: [] });
    const root2 = s2.roster.statements().find((item) => item.id === rerootRes.rootId)!.statement;
    await s1.roster.merge([root2]);
    await expect(s1.roster.replaceRecovery(code)).rejects.toMatchObject({ reason: "not-root" });
  });

  it("2. nothing is written until the new code is typed back", async () => {
    let clock = 10_000;
    const { s1, s2, code, clusterId } = await threeServers(() => ++clock);
    const beforeIds = s1.roster.statements().map((item) => item.id);
    const beforeAudits = readAudits(s1.store.openReader()).length;
    const beforeRoot = s1.roster.view.root!;

    const started = await s1.roster.replaceRecovery(code);
    expect(started.code).toMatch(/^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/);
    expect(started.clusterId).toBe(clusterId);

    // Nothing committed yet!
    expect(s1.roster.statements().map((item) => item.id)).toEqual(beforeIds);
    expect(readAudits(s1.store.openReader()).length).toBe(beforeAudits);
    expect(s1.roster.view.root).toEqual(beforeRoot);

    // Unconfirmed new code cannot reroot yet; old code still works.
    await expect(s2.roster.reroot({ code: started.code, oldRootLost: false, keep: [] })).rejects.toMatchObject({ reason: "bad-code" });

    // Wrong confirmation code (and malformed input) write nothing and allow retry.
    const wrong = started.code.startsWith("A") ? `B${started.code.slice(1)}` : `A${started.code.slice(1)}`;
    expect(await s1.roster.confirmRecovery("bad")).toMatchObject({ ok: false, reason: "malformed" });
    expect(await s1.roster.confirmRecovery(wrong)).toMatchObject({ ok: false, reason: "wrong-code" });
    expect(s1.roster.statements().map((item) => item.id)).toEqual(beforeIds);
    expect(readAudits(s1.store.openReader()).length).toBe(beforeAudits);

    // Cancelling clears pending without writing anything.
    s1.roster.cancelRecoveryReplace();
    expect(await s1.roster.confirmRecovery(started.code)).toMatchObject({ ok: false, reason: "no-setup" });
    expect(s1.roster.statements().map((item) => item.id)).toEqual(beforeIds);

    // Expiry clears pending without writing anything.
    const started2 = await s1.roster.replaceRecovery(code);
    clock = started2.expiresAt + 1;
    expect(await s1.roster.confirmRecovery(started2.code)).toMatchObject({ ok: false, reason: "expired" });
    expect(s1.roster.statements().map((item) => item.id)).toEqual(beforeIds);
  });

  it("3 & 4. after Root{g+2}, old code fails a reroot, new code works, cluster id is unchanged, and prior revocations stay counting", async () => {
    const { s1, s2, s3, code: oldCode, clusterId } = await threeServers();

    // Reroot onto s2 with oldRootLost: true -> Root{2} + Revoke{s1, gen: 2}.
    const rerooted = await s2.roster.reroot({ code: oldCode, oldRootLost: true, keep: [] });
    expect(rerooted.gen).toBe(2);
    expect(s2.roster.isValid(s1.identity.memberId)).toBe(false);

    // Replace the recovery code on s2 -> Root{3} signed by old recovery key.
    const started = await s2.roster.replaceRecovery(oldCode.toLowerCase().replace(/-/g, " "));
    const confirmed = await s2.roster.confirmRecovery(started.code.toLowerCase().replace(/-/g, " "));
    expect(confirmed).toMatchObject({ ok: true, clusterId, gen: 3 });
    if (!confirmed.ok) throw new Error("expected ok");

    const newKey = await recoveryKeyFromCode(started.code);
    try {
      // Cluster id stays the original cluster id (NOT derived from the new recovery key).
      expect(await clusterIdFromRecoveryKey(newKey.publicKey)).not.toBe(clusterId);
      expect(s2.roster.clusterId).toBe(clusterId);
      expect(s2.roster.view.root).toMatchObject({
        id: confirmed.rootId,
        gen: 3,
        root: s2.identity.memberId,
        recoveryPub: newKey.recoveryPub,
      });
    } finally {
      newKey.publicKey.fill(0);
    }

    const root3 = s2.roster.statements().find((item) => item.id === confirmed.rootId)!.statement;
    expect(root3.signer).toBe("recovery");
    expect(root3.body).toMatchObject({
      type: "root",
      cluster: clusterId,
      gen: 3,
      root: s2.identity.memberId,
      prev: rerooted.rootId,
    });
    // Revoke{s1, gen: 2} must be carried over in Root{3}.keep so s1 stays revoked!
    expect(s2.roster.isValid(s1.identity.memberId)).toBe(false);
    expect(s2.roster.dropped()).toEqual([]);

    const audits = readAudits(s2.store.openReader());
    expect(audits[0]).toMatchObject({ act: "root.change", statement: confirmed.rootId, by: "recovery", member: s2.identity.memberId });

    // Sync Root{2}, Revoke{s1}, Root{3} to s3 (via mergeRevocations / D47 as well as merge).
    await s3.roster.mergeRevocations(s2.roster.revocations().map((item) => item.statement));
    expect(s3.roster.clusterId).toBe(clusterId);
    expect(s3.roster.view.root?.id).toBe(confirmed.rootId);
    expect(s3.roster.isValid(s1.identity.memberId)).toBe(false);

    // Old code now fails reroot on s3; new code succeeds!
    await expect(s3.roster.reroot({ code: oldCode, oldRootLost: false, keep: [] })).rejects.toMatchObject({ reason: "bad-code" });
    const s3Reroot = await s3.roster.reroot({ code: started.code, oldRootLost: false, keep: [] });
    expect(s3Reroot.gen).toBe(4);
    expect(s3.roster.view.root?.root).toBe(s3.identity.memberId);

    // Reopen s2 from disk: Root{3} and clusterId persist.
    await s2.close();
    const reopenedStore = await openServerStore(s2.dir);
    cleanups.push(() => reopenedStore.close());
    const reopened = await RosterStore.open(reopenedStore, s2.identity);
    expect(reopened.clusterId).toBe(clusterId);
    expect(reopened.view.root?.id).toBe(confirmed.rootId);
    expect(reopened.isValid(s1.identity.memberId)).toBe(false);
  });

  it("5. byte scan of disk and logs finds neither the old nor the new code or seed", async () => {
    const { s2, code: oldCode } = await threeServers();
    await s2.roster.reroot({ code: oldCode, oldRootLost: true, keep: [] });

    const client = await connectAdmin(s2);
    const started = await client.request({ op: "recovery.replace", code: oldCode }) as { code: string; clusterId: string; expiresAt: number };
    const newCode = started.code;
    expect(await client.request({ op: "recovery.confirm", code: newCode })).toMatchObject({ ok: true, gen: 3 });

    const oldSeed = await rawSeedFromCode(oldCode);
    const newSeed = await rawSeedFromCode(newCode);
    try {
      const patterns: Buffer[] = [];
      for (const seed of [oldSeed, newSeed]) {
        patterns.push(Buffer.from(seed), Buffer.from(toHex(seed), "utf8"), Buffer.from(toBase64Url(seed), "utf8"));
      }
      for (const code of [oldCode, newCode]) {
        for (const spelling of spellingsOf(code)) patterns.push(Buffer.from(spelling, "utf8"));
      }

      const scanDisk = () => {
        for (const file of walkFiles(s2.dir)) {
          const bytes = readFileSync(file);
          for (const pat of patterns) expect(bytes.indexOf(pat), `secret pattern found in ${file}`).toBe(-1);
        }
      };

      scanDisk();
      await s2.close();
      scanDisk();

      const logText = s2.logs.join("\n");
      for (const code of [oldCode, newCode]) {
        for (const spelling of spellingsOf(code)) expect(logText).not.toContain(spelling);
      }
    } finally {
      oldSeed.fill(0);
      newSeed.fill(0);
    }
  });

  it("CLI over local socket: refuses non-root, handles wrong codes, and replaces on root", async () => {
    const { s1, s2, s3, code: oldCode, clusterId } = await threeServers();
    await s2.roster.reroot({ code: oldCode, oldRootLost: true, keep: [] });
    await s1.roster.mergeRevocations(s2.roster.revocations().map((item) => item.statement));

    // Non-root (s1) refuses without asking for any code.
    const c1 = await connectAdmin(s1);
    const ioNonRoot = scriptedIo([]);
    expect(await recoveryReplaceCommand(c1, ioNonRoot.io)).toBe(1);
    expect(ioNonRoot.asked).toEqual([]);
    expect(ioNonRoot.out.join("\n")).toContain("Only the revocation root");

    // Current root (s2): 3 wrong old codes exit 1 and change nothing.
    const c2 = await connectAdmin(s2);
    const wrongOld = newRecoveryCode();
    const ioBadOld = scriptedIo([wrongOld, wrongOld, wrongOld]);
    expect(await recoveryReplaceCommand(c2, ioBadOld.io)).toBe(1);
    expect(ioBadOld.out.join("\n")).toContain("Nothing was changed");
    expect(s2.roster.view.root?.gen).toBe(2);

    // Current root (s2): right old code -> new code printed once -> wrong confirm -> right confirm.
    const ioGood = scriptedIo([oldCode, "not-valid", newRecoveryCode()]);
    let printedNewCode = "";
    const wrappedIo: CliIo = {
      out: (line) => {
        ioGood.out.push(line);
        const match = line.match(/^\s*([A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}-[A-Z2-7]{2})\s*$/);
        if (match) printedNewCode = match[1]!;
      },
      ask: async (prompt) => {
        ioGood.asked.push(prompt);
        if (ioGood.asked.length === 1) return oldCode;
        if (ioGood.asked.length === 2) return "not-valid";
        return printedNewCode.toLowerCase().replace(/-/g, " ");
      },
    };
    expect(await recoveryReplaceCommand(c2, wrappedIo)).toBe(0);
    expect(printedNewCode).toMatch(/^([A-Z2-7]{4}-){6}[A-Z2-7]{2}$/);
    expect(s2.roster.view.root?.gen).toBe(3);
    expect(s2.roster.clusterId).toBe(clusterId);

    // Typed codes are never echoed back in stdout.
    const joinedOut = ioGood.out.join("\n");
    for (const spelling of spellingsOf(oldCode)) expect(joinedOut).not.toContain(spelling);
    expect(joinedOut).not.toContain(printedNewCode.toLowerCase());

    // Confirm the new code works for a subsequent reroot on s3.
    await s3.roster.merge(s2.roster.statements().map((item) => item.statement));
    await expect(s3.roster.reroot({ code: oldCode, oldRootLost: false, keep: [] })).rejects.toMatchObject({ reason: "bad-code" });
    const r4 = await s3.roster.reroot({ code: printedNewCode, oldRootLost: false, keep: [] });
    expect(r4.gen).toBe(4);
  });

  it("preserves gen-1 revocations across direct replace on root, supports chained replacements, and cancels on 3 wrong confirm codes", async () => {
    const { s1, s2, s3, code: code1, clusterId } = await threeServers();

    // Revoke s3 on initial root s1 (gen 1), then replace recovery code directly on s1 -> Root{2}.
    await s1.roster.revokeServer(s3.identity.memberId, false, "retired");
    expect(s1.roster.isValid(s3.identity.memberId)).toBe(false);

    const step1 = await s1.roster.replaceRecovery(code1);
    const conf1 = await s1.roster.confirmRecovery(step1.code);
    expect(conf1).toMatchObject({ ok: true, clusterId, gen: 2 });
    expect(s1.roster.isValid(s3.identity.memberId)).toBe(false);
    expect(s1.roster.dropped()).toEqual([]);

    // Chained replacement: code2 -> code3 (Root{3}).
    const step2 = await s1.roster.replaceRecovery(step1.code);
    const conf2 = await s1.roster.confirmRecovery(step2.code);
    expect(conf2).toMatchObject({ ok: true, clusterId, gen: 3 });

    // CLI 3 wrong confirmation codes cancels cleanly and writes nothing (stays gen 3 with code3).
    const c1 = await connectAdmin(s1);
    const ioBadConfirm = scriptedIo([step2.code, "wrong-1", "wrong-2", "wrong-3"]);
    expect(await recoveryReplaceCommand(c1, ioBadConfirm.io)).toBe(1);
    expect(ioBadConfirm.out.join("\n")).toContain("nothing was changed");
    expect(s1.roster.view.root?.gen).toBe(3);

    // Sync to s2: only code3 works for reroot; code1 and code2 fail.
    await s2.roster.merge(s1.roster.statements().map((item) => item.statement));
    await expect(s2.roster.reroot({ code: code1, oldRootLost: false, keep: [] })).rejects.toMatchObject({ reason: "bad-code" });
    await expect(s2.roster.reroot({ code: step1.code, oldRootLost: false, keep: [] })).rejects.toMatchObject({ reason: "bad-code" });
    const r4 = await s2.roster.reroot({ code: step2.code, oldRootLost: false, keep: [] });
    expect(r4.gen).toBe(4);
  });
});
