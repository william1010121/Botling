// Botling 3 M4-12: `botlingd recovery replace` (`replaceRecovery` / `confirmRecovery` two-step, CLI, secret handling, §4.8).
// Uses real WebCrypto keys, real server.db stores, PairingService, SessionServer (Unix socket), and AdminClient in temp
// folders (no windows, no network listener).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { clusterIdFromRecoveryKey, toBase64Url, toHex } from "../../src/protocol";
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
import { AdminClient, AdminRefused, PairingError, PairingService, recoveryReplaceCommand, type CliIo } from "../../src/server/pairing";
import { readAudits, RECOVERY_REPLACE_TTL_MS, RosterError, RosterStore } from "../../src/server/roster";
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

async function waitFor<T>(probe: () => T | null | undefined | false, what: string, ms = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
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
      handle: (op, session) => pairing.admin(op, session),
      onEvent: (listener) => pairing.onEvent(listener),
      sessionClosed: (session) => pairing.adminClosed(session),
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
  const askOptions: Array<{ secret?: boolean } | undefined> = [];
  const io: CliIo = {
    out: (line) => { out.push(line); },
    ask: async (prompt, options) => {
      asked.push(prompt);
      askOptions.push(options);
      return answers.length ? answers.shift()! : null;
    },
  };
  return { io, out, asked, askOptions };
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

  it("3 & 4. after Root{g+2}, old code fails a reroot, new code works, cluster id is unchanged, and prior revocations stay counting while dropped ones stay out", async () => {
    const { s1, s2, s3, code: oldCode, clusterId } = await threeServers();

    // Revoke s3 on s1, then reroot onto s2 leaving out revS3 (dropped per D63) and revoking s1.
    const revS3 = await s1.roster.revokeServer(s3.identity.memberId, false, "old-revoke");
    await s2.roster.merge(s1.roster.statements().map((item) => item.statement));
    const rerooted = await s2.roster.reroot({ code: oldCode, oldRootLost: true, keep: [] });
    expect(rerooted.gen).toBe(2);
    expect(s2.roster.isValid(s1.identity.memberId)).toBe(false);
    expect(s2.roster.isValid(s3.identity.memberId)).toBe(true);

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
    // Revoke{s1, gen: 2} must be carried over in Root{3}.keep, while revS3 (dropped at Root{2}) stays out!
    if (root3.body.type === "root") {
      expect(root3.body.keep).toEqual([rerooted.revokeId]);
      expect(root3.body.keep).not.toContain(revS3.revokeId);
    }
    expect(s2.roster.isValid(s1.identity.memberId)).toBe(false);
    expect(s2.roster.isValid(s3.identity.memberId)).toBe(true);
    expect(s2.roster.dropped().map((d) => d.revokeId)).toEqual([revS3.revokeId]);

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

  it("5. byte scan of disk, logs, and console.* finds neither the old nor the new code or seed (incl. standard base64)", async () => {
    const { s2, code: oldCode } = await threeServers();
    await s2.roster.reroot({ code: oldCode, oldRootLost: true, keep: [] });

    const consoleLines: string[] = [];
    const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
    const consoleSpies = consoleMethods.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(format(...args));
      }),
    );

    const client = await connectAdmin(s2);
    const started = await client.request({ op: "recovery.replace", code: oldCode }) as { code: string; clusterId: string; expiresAt: number };
    const newCode = started.code;
    expect(await client.request({ op: "recovery.confirm", code: newCode })).toMatchObject({ ok: true, gen: 3 });

    const oldSeed = await rawSeedFromCode(oldCode);
    const newSeed = await rawSeedFromCode(newCode);
    try {
      const seedStrings: string[] = [];
      const patterns: Buffer[] = [];
      for (const seed of [oldSeed, newSeed]) {
        const hex = toHex(seed);
        const b64u = toBase64Url(seed);
        const b64 = Buffer.from(seed).toString("base64");
        seedStrings.push(hex, b64u, b64);
        patterns.push(Buffer.from(seed), Buffer.from(hex, "utf8"), Buffer.from(b64u, "utf8"), Buffer.from(b64, "utf8"));
      }
      for (const code of [oldCode, newCode]) {
        for (const spelling of spellingsOf(code)) patterns.push(Buffer.from(spelling, "utf8"));
      }

      const scanDisk = () => {
        for (const file of walkFiles(s2.dir)) {
          const bytes = readFileSync(file);
          for (const pat of patterns) {
            expect(bytes.indexOf(pat), `secret pattern found in ${file}`).toBe(-1);
          }
        }
      };

      scanDisk();
      await s2.close();
      scanDisk();

      const logText = `${s2.logs.join("\n")}\n${consoleLines.join("\n")}`;
      for (const code of [oldCode, newCode]) {
        for (const spelling of spellingsOf(code)) expect(logText).not.toContain(spelling);
      }
      for (const seedText of seedStrings) expect(logText).not.toContain(seedText);
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
      oldSeed.fill(0);
      newSeed.fill(0);
    }
  });

  it("CLI over local socket: refuses non-root, handles wrong codes, passes secret:true, and replaces on root", async () => {
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
    expect(ioBadOld.askOptions).toEqual([{ secret: true }, { secret: true }, { secret: true }]);
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
      ask: async (prompt, options) => {
        ioGood.asked.push(prompt);
        ioGood.askOptions.push(options);
        if (ioGood.asked.length === 1) return oldCode;
        if (ioGood.asked.length === 2) return "not-valid";
        return printedNewCode.toLowerCase().replace(/-/g, " ");
      },
    };
    expect(await recoveryReplaceCommand(c2, wrappedIo)).toBe(0);
    expect(ioGood.askOptions).toEqual([{ secret: true }, { secret: true }, { secret: true }]);
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

  it("distinguishes errors by PairingError code (not English text) and gives bad-keep its own message", async () => {
    const { s1, code } = await threeServers();
    const client = await connectAdmin(s1);

    // AdminRefused exposes code and detail parsed from wire message.
    const refused = new AdminRefused("bad-keep: keep exceeds the maximum of 1000 revocations");
    expect((refused as unknown as { code: string | null }).code).toBe("bad-keep");
    expect((refused as unknown as { detail: string }).detail).toBe("keep exceeds the maximum of 1000 revocations");

    // Step 1: non-bad-code PairingError with custom (non-English) text stops on first try instead of retrying as wrong code.
    const spyBegin = vi.spyOn(s1.pairing, "beginRecoveryReplace").mockRejectedValueOnce(
      new PairingError("not-root", "non-english-refusal-text"),
    );
    const ioNotRoot = scriptedIo([code, code, code]);
    expect(await recoveryReplaceCommand(client, ioNotRoot.io)).toBe(1);
    expect(ioNotRoot.asked).toHaveLength(1);
    expect(ioNotRoot.out.join("\n")).toContain("non-english-refusal-text");
    expect(ioNotRoot.out.join("\n")).not.toContain("That is not the recovery code.");
    spyBegin.mockRestore();

    // Step 1: self-revoked RosterError maps to PairingError("self-revoked") and stops on first try.
    const spyReplace = vi.spyOn(s1.roster, "replaceRecovery").mockRejectedValueOnce(
      new RosterError("self-revoked", "this server was removed from the cluster"),
    );
    const ioSelfRevoked = scriptedIo([code, code]);
    expect(await recoveryReplaceCommand(client, ioSelfRevoked.io)).toBe(1);
    expect(ioSelfRevoked.asked).toHaveLength(1);
    expect(ioSelfRevoked.out.join("\n")).toContain("this server was removed from the cluster");
    expect(ioSelfRevoked.out.join("\n")).not.toContain("That is not the recovery code.");
    spyReplace.mockRestore();

    // Step 2: RosterError("bad-keep") in confirmRecovery maps to PairingError("bad-keep"), prints its own message, cancels pending, and stops immediately.
    const spyConfirm = vi.spyOn(s1.roster, "confirmRecovery").mockRejectedValueOnce(
      new RosterError("bad-keep", "keep exceeds the maximum of 1000 revocations"),
    );
    let printedNewCode = "";
    const step2Answers: string[] = [];
    const ioBadKeep: CliIo = {
      out: (line) => {
        step2Answers.push(line);
        const match = line.match(/^\s*([A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}-[A-Z2-7]{2})\s*$/);
        if (match) printedNewCode = match[1]!;
      },
      ask: async () => (printedNewCode ? printedNewCode : code),
    };
    expect(await recoveryReplaceCommand(client, ioBadKeep)).toBe(1);
    const step2Out = step2Answers.join("\n");
    expect(step2Out).toContain("Cannot replace the recovery code: keep list exceeds the limit (keep exceeds the maximum of 1000 revocations).");
    expect(step2Out).not.toContain("That is not a recovery code");
    expect(step2Out).toContain("nothing was changed");
    // Pending replacement was cancelled on the server.
    expect(await s1.roster.confirmRecovery(printedNewCode)).toMatchObject({ ok: false, reason: "no-setup" });
    spyConfirm.mockRestore();
  });

  it("clears the old recovery signing handle when the 10-minute TTL expires", async () => {
    const fixedClock = () => 1_000_000;
    const { s1, code } = await threeServers(fixedClock);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const started1 = await s1.roster.replaceRecovery(code);
      // Halfway through TTL, starting a second replace supersedes the first timer.
      vi.advanceTimersByTime(RECOVERY_REPLACE_TTL_MS / 2);
      const started2 = await s1.roster.replaceRecovery(code);

      // Advancing past started1's original deadline must NOT clear started2.
      vi.advanceTimersByTime(RECOVERY_REPLACE_TTL_MS / 2 + 1);
      const wrong = started2.code.startsWith("A") ? `B${started2.code.slice(1)}` : `A${started2.code.slice(1)}`;
      expect(await s1.roster.confirmRecovery(wrong)).toMatchObject({ ok: false, reason: "wrong-code" });

      // Advancing to started2's 10-minute expiry clears pendingReplace even without clock advancing (`now()` is still 1_000_000),
      // so confirmRecovery sees `no-setup` rather than `expired`.
      vi.advanceTimersByTime(RECOVERY_REPLACE_TTL_MS / 2);
      expect(await s1.roster.confirmRecovery(started2.code)).toMatchObject({ ok: false, reason: "no-setup" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the old recovery signing handle when the CLI admin session disconnects", async () => {
    const { s1, code } = await threeServers();

    const c1 = await connectAdmin(s1);
    const c2 = await connectAdmin(s1);

    const started = await c1.request({ op: "recovery.replace", code }) as { code: string; clusterId: string; expiresAt: number };

    // Disconnecting an unrelated admin client must NOT clear c1's pending replacement.
    c2.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await s1.roster.confirmRecovery("not-a-code")).toMatchObject({ ok: false, reason: "malformed" });

    // Disconnecting the client that started recovery.replace without sending recovery.cancel clears the pending handle.
    c1.close();
    let cleared = false;
    await waitFor(() => {
      void s1.roster.confirmRecovery("not-a-code").then((res) => {
        if (!res.ok && res.reason === "no-setup") cleared = true;
      });
      return cleared;
    }, "pending recovery replace cleared on CLI disconnect");
    expect(await s1.roster.confirmRecovery(started.code)).toMatchObject({ ok: false, reason: "no-setup" });
  });
});
