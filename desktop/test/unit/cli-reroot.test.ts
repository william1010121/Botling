// Botling 3 M4-11: `botlingd reroot` CLI and local-only admin ops (`roster.rerootPreview`, `roster.reroot`).
// Uses real RosterStore, PairingService, SessionServer (Unix socket), AdminClient, RemoteSession, and SessionCore
// with WebCrypto keys and real server.db stores in temp folders (no windows, no network listener).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminOp, decodeFrame, encodeFrame, memberIdFromKey, roleRefusal, toBase64Url, toHex,
  type AdminOp as AdminOpType, type Message, type MessageOf,
} from "../../src/protocol";
import { effectCheckpointSink } from "../../src/server/effects";
import { ensureBot } from "../../src/server/effects/log-ops";
import {
  bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity, newRecoveryCode, normalizeRecoveryCode,
  RECOVERY_INFO, RECOVERY_SALT, type ServerIdentity,
} from "../../src/server/identity";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import {
  AdminClient, PairingError, PairingService, parseRerootArgs, RerootArgsError, rerootCommand, type CliIo,
} from "../../src/server/pairing";
import { readAudits, RosterStore } from "../../src/server/roster";
import { RemoteSessions, SessionCore, SessionServer, slotAuthorize, writeToken, type RemoteHost, type SessionHost } from "../../src/server/session";
import { ShellBridge } from "../../src/server/shell-bridge";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { generateDhKeyPair, SessionLink, type SessionTransport } from "../../src/session";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { testRoot } from "../botlingd-harness";

const root = testRoot("cli-reroot");
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
  logs: string[];
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

async function makeServer(serverName: string, now: () => number): Promise<ServerNode> {
  const dir = join(root, `s${++n}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = await openServerStore(dir);
  const identity = await loadOrCreateServerIdentity(dir);
  const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
  const logs: string[] = [];
  const roster = await RosterStore.open(store, identity, { now, log: (line) => logs.push(line) });
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
      handle: (op, session) => { adminCalls.push(op); return pairing.admin(op, session); },
      onEvent: (listener) => pairing.onEvent(listener),
      sessionClosed: (session) => pairing.adminClosed(session),
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

  return { dir, store, identity, roster, setup, pairing, host, remote, socketPath, token, logs, adminCalls, close };
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

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkFiles(full));
    else if (stat.isFile()) out.push(full);
  }
  return out;
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

function localMinute(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Builds studio (gen 1 root) + build-box + laptop (2026-11-01) + Pixel (2026-11-10) +
 * optionally two prior server revocations (laptop-old, test-vm), synced to build-box.
 */
async function clusterFixture(options: { withRemovals?: boolean } = {}) {
  let clock = Date.UTC(2026, 10, 1, 10, 0, 0);
  const tick = () => (clock += 60_000);

  const studio = await makeServer("studio", tick);
  const started = await studio.setup.begin();
  expect((await studio.setup.confirm(started.code)).ok).toBe(true);

  const buildBox = await makeServer("build-box", tick);
  const addBuild = await studio.roster.addServer({ keys: buildBox.identity.keys, name: "build-box" });
  await buildBox.roster.joinCluster({
    add: studio.roster.statements().find((item) => item.id === addBuild.addId)!.statement,
    roster: studio.roster.statements().map((item) => item.statement),
    sponsor: { member: studio.identity.memberId, keys: studio.identity.keys, name: "studio" },
  });

  // laptop added on 2026-11-01
  clock = Date.UTC(2026, 10, 1, 12, 0, 0);
  const laptop = await makeServer("laptop", tick);
  const addLaptop = await studio.roster.addServer({ keys: laptop.identity.keys, name: "laptop" });
  await laptop.roster.joinCluster({
    add: studio.roster.statements().find((item) => item.id === addLaptop.addId)!.statement,
    roster: studio.roster.statements().map((item) => item.statement),
    sponsor: { member: studio.identity.memberId, keys: studio.identity.keys, name: "studio" },
  });

  // Pixel added by studio on 2026-11-10 (at 20:00 UTC so UTC+8 local day differs from UTC day)
  clock = Date.UTC(2026, 10, 10, 20, 0, 0);
  const pixel = await deviceKeys();
  await studio.roster.addDevice({ keys: pixel.keys, name: "Pixel" });
  const pixelAddedAt = Date.UTC(2026, 10, 10, 20, 0, 0) + 60_000;
  const laptopAddedAt = Date.UTC(2026, 10, 1, 12, 0, 0) + 60_000;

  let laptopOld: ServerNode | null = null;
  let testVm: ServerNode | null = null;
  let revLaptopOldId = "";
  let revTestVmId = "";
  const rev1At = Date.UTC(2026, 10, 2, 14, 10, 0);
  const rev2At = Date.UTC(2026, 10, 14, 9, 31, 0);

  if (options.withRemovals) {
    clock = Date.UTC(2026, 10, 2, 14, 0, 0);
    laptopOld = await makeServer("laptop-old", tick);
    const addOld = await studio.roster.addServer({ keys: laptopOld.identity.keys, name: "laptop-old" });
    await laptopOld.roster.joinCluster({
      add: studio.roster.statements().find((item) => item.id === addOld.addId)!.statement,
      roster: studio.roster.statements().map((item) => item.statement),
      sponsor: { member: studio.identity.memberId, keys: studio.identity.keys, name: "studio" },
    });

    clock = Date.UTC(2026, 10, 14, 9, 0, 0);
    testVm = await makeServer("test-vm", tick);
    const addVm = await studio.roster.addServer({ keys: testVm.identity.keys, name: "test-vm" });
    await testVm.roster.joinCluster({
      add: studio.roster.statements().find((item) => item.id === addVm.addId)!.statement,
      roster: studio.roster.statements().map((item) => item.statement),
      sponsor: { member: studio.identity.memberId, keys: studio.identity.keys, name: "studio" },
    });

    clock = rev1At - 60_000;
    const rev1 = await studio.roster.revokeServer(laptopOld.identity.memberId, false, "retired");
    revLaptopOldId = rev1.revokeId;
    clock = rev2At - 60_000;
    const rev2 = await studio.roster.revokeServer(testVm.identity.memberId, false, "compromised");
    revTestVmId = rev2.revokeId;

    // Sync statements to buildBox with matching receivedAt timestamps.
    const allBase = [
      ...studio.roster.statements().filter((s) => s.id !== revLaptopOldId && s.id !== revTestVmId),
      ...laptop.roster.statements(),
      ...laptopOld.roster.statements(),
      ...testVm.roster.statements(),
    ].map((item) => item.statement);
    await buildBox.roster.merge(allBase);
    clock = rev1At - 60_000;
    await buildBox.roster.merge([studio.roster.statements().find((s) => s.id === revLaptopOldId)!.statement]);
    clock = rev2At - 60_000;
    await buildBox.roster.merge([studio.roster.statements().find((s) => s.id === revTestVmId)!.statement]);
  } else {
    const all = [...studio.roster.statements(), ...laptop.roster.statements()].map((item) => item.statement);
    await buildBox.roster.merge(all);
  }

  return {
    studio, buildBox, laptop, pixel, laptopOld, testVm, revLaptopOldId, revTestVmId,
    rev1At, rev2At, pixelAddedAt, laptopAddedAt,
    code: started.code,
  };
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

describe("M4-11: botlingd reroot CLI", () => {
  it("AdminOp parses roster.rerootPreview and roster.reroot", () => {
    const code = newRecoveryCode();
    const stmtId = "a".repeat(64);
    expect(AdminOp.safeParse({ op: "roster.rerootPreview" }).success).toBe(true);
    expect(AdminOp.safeParse({ op: "roster.reroot", code, oldRootLost: true, keep: [stmtId] }).success).toBe(true);
    expect(AdminOp.safeParse({ op: "roster.reroot", code: "bad", oldRootLost: false, keep: [] }).success).toBe(false);
  });

  it("1. full flow with right code signs Root{g+1} and Revoke{oldRoot, cascade: false}, lists what old root added newest first", async () => {
    const { studio, buildBox, laptop, pixel, pixelAddedAt, laptopAddedAt, code } = await clusterFixture();
    const client = await connectAdmin(buildBox);
    const spaced = code.toLowerCase().replace(/-/g, " ");
    const { io, out, asked, askOptions } = scriptedIo([spaced, "lost"]);

    const exit = await rerootCommand(client, io);
    expect(exit).toBe(0);

    expect(out[0]).toBe('This makes "build-box" the revocation root of your machines.');
    expect(asked[0]).toBe("Type the recovery code (26 characters; spaces and dashes are fine): ");
    expect(askOptions[0]).toEqual({ secret: true });
    expect(asked[1]).toBe('Is the old root "studio" lost or stolen? Type "lost" to remove it (what it added stays), or "keep" to leave it a member: ');
    expect(askOptions[1]?.secret).toBeFalsy();

    const text = out.join("\n");
    expect(text).toContain('Done. "build-box" is the revocation root. "studio" was removed; what it added stays.');
    expect(text).toContain('Machines and phones "studio" added, newest first (remove any you do not know with "botlingd machines remove"):');
    expect(text).toContain('Replace the recovery code now? Run "botlingd recovery replace".');

    // Pixel appears before laptop, with local dates.
    const pixelAt = text.indexOf(`phone "Pixel"   ${localDay(pixelAddedAt)}`);
    const laptopAt = text.indexOf(`"laptop"        ${localDay(laptopAddedAt)}`);
    expect(pixelAt).toBeGreaterThan(-1);
    expect(laptopAt).toBeGreaterThan(pixelAt);

    expect(buildBox.roster.view.root?.gen).toBe(2);
    expect(buildBox.roster.view.root?.root).toBe(buildBox.identity.memberId);
    expect(buildBox.roster.isValid(studio.identity.memberId)).toBe(false);
    expect(buildBox.roster.isValid(laptop.identity.memberId)).toBe(true);
    expect(buildBox.roster.isValid(pixel.member)).toBe(true);
    const revokes = buildBox.roster.statements().filter((s) => s.statement.body.type === "revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]!.statement.body).toMatchObject({
      type: "revoke",
      member: studio.identity.memberId,
      by: buildBox.identity.memberId,
      gen: 2,
      cascade: false,
    });
    expect(readAudits(buildBox.store.openReader()).some((row) => row.act === "root.change")).toBe(true);
  });

  it("1b. typing 'keep' leaves the old root a valid member and signs no Revoke", async () => {
    const { studio, buildBox, code } = await clusterFixture();
    const client = await connectAdmin(buildBox);
    const { io, out } = scriptedIo([code, "keep"]);

    expect(await rerootCommand(client, io)).toBe(0);
    expect(buildBox.roster.view.root?.gen).toBe(2);
    expect(buildBox.roster.view.root?.root).toBe(buildBox.identity.memberId);
    expect(buildBox.roster.isValid(studio.identity.memberId)).toBe(true);
    expect(buildBox.roster.statements().filter((s) => s.statement.body.type === "revoke")).toHaveLength(0);
    expect(out.join("\n")).toContain('Done. "build-box" is the revocation root.');
    expect(out.join("\n")).not.toContain("Machines and phones");
  });

  it("2. wrong code changes nothing (exit 1); three wrong codes end the run; EOF stops with nothing changed", async () => {
    const { studio, buildBox, code } = await clusterFixture();
    const client = await connectAdmin(buildBox);
    const wrong = newRecoveryCode();
    expect(wrong).not.toBe(normalizeRecoveryCode(code));

    // One wrong code + EOF on retry -> prints message and exits 1 with nothing changed.
    const oneWrong = scriptedIo([wrong, "lost"]);
    expect(await rerootCommand(client, oneWrong.io)).toBe(1);
    expect(oneWrong.out).toContain("That is not the recovery code. Nothing was changed.");
    expect(buildBox.roster.view.root?.gen).toBe(1);
    expect(buildBox.roster.view.root?.root).toBe(studio.identity.memberId);

    // Three wrong codes in one run end it (all recovery code prompts use secret: true).
    const threeWrong = scriptedIo(["not-a-code", "lost", wrong, newRecoveryCode()]);
    expect(await rerootCommand(client, threeWrong.io)).toBe(1);
    expect(threeWrong.out.filter((line) => line === "That is not the recovery code. Nothing was changed.")).toHaveLength(3);
    expect(threeWrong.asked.filter((p) => p.startsWith("Type the recovery code"))).toHaveLength(3);
    expect(threeWrong.askOptions[0]).toEqual({ secret: true });
    expect(threeWrong.askOptions[2]).toEqual({ secret: true });
    expect(threeWrong.askOptions[3]).toEqual({ secret: true });
    expect(buildBox.roster.view.root?.gen).toBe(1);

    // EOF at any prompt stops with nothing changed.
    for (const answers of [[], [code], [code, "maybe"]]) {
      const eofRun = scriptedIo(answers);
      expect(await rerootCommand(client, eofRun.io)).toBe(1);
      expect(buildBox.roster.view.root?.gen).toBe(1);
    }
  });

  it("3. keep follows the unticks (unticking '2' keeps 1 revoked and brings 2 back) and displays local time", async () => {
    const prevTz = process.env.TZ;
    process.env.TZ = "Asia/Taipei";
    try {
      const { buildBox, laptopOld, testVm, revLaptopOldId, revTestVmId, code } = await clusterFixture({ withRemovals: true });
      const client = await connectAdmin(buildBox);

      expect(buildBox.roster.isValid(laptopOld!.identity.memberId)).toBe(false);
      expect(buildBox.roster.isValid(testVm!.identity.memberId)).toBe(false);

      const { io, out, asked } = scriptedIo([code, "lost", "2"]);
      expect(await rerootCommand(client, io)).toBe(0);

      const text = out.join("\n");
      expect(text).toContain("Removals made by earlier roots (untick any you did not make):");
      // rev1At = 14:10 UTC = 22:10 Asia/Taipei; rev2At = 09:31 UTC = 17:31 Asia/Taipei; Pixel = 20:00 UTC = next day 04:00
      expect(text).toContain('[x] 1  "laptop-old"   removed by studio   2026-11-02 22:10');
      expect(text).toContain('[x] 2  "test-vm"      removed by studio   2026-11-14 17:31');
      expect(text).toContain('phone "Pixel"   2026-11-11');
      expect(asked[2]).toBe('Type the numbers to UNtick (e.g. "2"), or press Enter to keep all: ');

      const root2 = buildBox.roster.statements().find((s) => s.id === buildBox.roster.view.root?.id)?.statement;
      expect(root2?.body.type).toBe("root");
      if (root2?.body.type === "root") {
        expect(root2.body.keep).toEqual([revLaptopOldId]);
        expect(root2.body.keep).not.toContain(revTestVmId);
      }
      expect(buildBox.roster.isValid(laptopOld!.identity.memberId)).toBe(false);
      expect(buildBox.roster.isValid(testVm!.identity.memberId)).toBe(true);
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  it("4. the recovery code never appears in stdout, logs, console.*, errors, or the data folder (byte scan), and admin ops stay local-only", async () => {
    const { studio, buildBox, code } = await clusterFixture();
    const raw = normalizeRecoveryCode(code)!;
    const wrong = newRecoveryCode();
    const seed = await rawSeedFromCode(code);

    const spellings = (c: string) => [
      c,
      c.match(/.{1,4}/g)!.join("-"),
      c.match(/.{1,4}/g)!.join(" "),
      c.toLowerCase(),
      c.toLowerCase().match(/.{1,4}/g)!.join("-"),
      c.toLowerCase().match(/.{1,4}/g)!.join(" "),
    ];
    const seedStrings = [
      toHex(seed),
      toBase64Url(seed),
      Buffer.from(seed).toString("base64"),
    ];

    const consoleLines: string[] = [];
    const consoleMethods = ["log", "info", "warn", "error", "debug"] as const;
    const consoleSpies = consoleMethods.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleLines.push(format(...args));
      }),
    );

    try {
      const client = await connectAdmin(buildBox);
      // Try one wrong code, then succeed on second try.
      const { io, out } = scriptedIo([wrong, "lost", code]);
      expect(await rerootCommand(client, io)).toBe(0);

      const allOut = out.join("\n");
      const allLogs = `${buildBox.logs.join("\n")}\n${consoleLines.join("\n")}`;
      for (const s of [...spellings(raw), ...spellings(wrong), ...seedStrings]) {
        expect(allOut).not.toContain(s);
        expect(allLogs).not.toContain(s);
      }

      const patterns: Buffer[] = [
        Buffer.from(seed),
        ...seedStrings.map((s) => Buffer.from(s, "utf8")),
        ...spellings(raw).map((s) => Buffer.from(s, "utf8")),
        ...spellings(wrong).map((s) => Buffer.from(s, "utf8")),
      ];

      const scan = () => {
        for (const file of walkFiles(buildBox.dir)) {
          const bytes = readFileSync(file);
          for (const pat of patterns) {
            expect(bytes.indexOf(pat), `secret found in ${file}`).toBe(-1);
          }
        }
      };
      scan();

      // Local-only guard: non-local SessionCore and remote role refuse roster.reroot and roster.rerootPreview.
      expect(roleRefusal("admin", "fe", { local: false })).not.toBeNull();
      const encoded = encodeFrame(
        { t: "admin", req: "r1", op: { op: "roster.reroot", code, oldRootLost: true, keep: [] } },
        "fe",
        { local: true },
      );
      expect(encoded.ok).toBe(true);
      if (encoded.ok) {
        const decoded = decodeFrame(encoded.text, "fe", { local: false });
        expect(decoded.ok).toBe(false);
        if (!decoded.ok) expect(decoded.bye.reason).toBe("role");
      }

      const probe = new NonLocalCoreProbe(studio.host);
      probe.inject({ t: "hello", deviceId: "d".repeat(26), feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [] } as MessageOf<"hello">);
      probe.inject({ t: "admin", req: "r2", op: { op: "roster.rerootPreview" } } as MessageOf<"admin">);
      probe.inject({ t: "admin", req: "r3", op: { op: "roster.reroot", code, oldRootLost: true, keep: [] } } as MessageOf<"admin">);
      await waitFor(() => probe.sent.some((m) => m.t === "res" && m.req === "r3"), "forbidden res");
      expect(probe.sent.find((m): m is MessageOf<"res"> => m.t === "res" && m.req === "r2")).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(probe.sent.find((m): m is MessageOf<"res"> => m.t === "res" && m.req === "r3")).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(studio.adminCalls).toEqual([]);
      probe.close();

      // Close DB and re-scan data folder.
      await buildBox.close();
      scan();
    } finally {
      for (const spy of consoleSpies) spy.mockRestore();
      seed.fill(0);
    }
  });

  it("5. --keep-all and --old-root lost|keep work for scripts with code on stdin only, and CLI args reject any code", async () => {
    const secretLike = newRecoveryCode();
    expect(parseRerootArgs([])).toEqual({});
    expect(parseRerootArgs(["--keep-all", "--old-root", "lost"])).toEqual({ keepAll: true, oldRoot: "lost" });
    expect(parseRerootArgs(["--old-root", "keep"])).toEqual({ oldRoot: "keep" });

    // Positional code or --code=... is refused without echoing the secret.
    for (const bad of [[secretLike], ["--old-root", "lost", secretLike], [`--code=${secretLike}`], ["--code", secretLike], ["--old-root", "maybe"]]) {
      let caught: unknown;
      try { parseRerootArgs(bad); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(RerootArgsError);
      expect((caught as Error).message).not.toContain(secretLike);
    }

    const { studio, buildBox, laptopOld, testVm, revLaptopOldId, revTestVmId, code } = await clusterFixture({ withRemovals: true });
    const client = await connectAdmin(buildBox);
    const { io, asked, out } = scriptedIo([code]);

    const exit = await rerootCommand(client, io, parseRerootArgs(["--keep-all", "--old-root", "keep"]));
    expect(exit).toBe(0);
    // Only the recovery code was asked on stdin.
    expect(asked).toEqual(["Type the recovery code (26 characters; spaces and dashes are fine): "]);
    expect(out.join("\n")).toContain('Done. "build-box" is the revocation root. "studio" remains a member.');
    expect(buildBox.roster.isValid(studio.identity.memberId)).toBe(true);
    expect(buildBox.roster.isValid(laptopOld!.identity.memberId)).toBe(false);
    expect(buildBox.roster.isValid(testVm!.identity.memberId)).toBe(false);
    const root2 = buildBox.roster.statements().find((s) => s.id === buildBox.roster.view.root?.id)?.statement;
    if (root2?.body.type === "root") {
      expect(root2.body.keep.sort()).toEqual([revLaptopOldId, revTestVmId].sort());
    }
  });

  it("6. bad-keep refusal from PairingService prints its own message instead of a generic error", async () => {
    const { buildBox, code } = await clusterFixture();
    const origReroot = buildBox.pairing.reroot.bind(buildBox.pairing);
    vi.spyOn(buildBox.pairing, "reroot").mockRejectedValueOnce(new PairingError("bad-keep", "keep exceeds the maximum of 1000 revocations"));
    const client = await connectAdmin(buildBox);
    const { io, out } = scriptedIo([code, "keep"]);

    expect(await rerootCommand(client, io)).toBe(1);
    expect(out.join("\n")).toContain("Cannot reroot: keep list could not be accepted (keep exceeds the maximum of 1000 revocations).");
    expect(origReroot).toBeTypeOf("function");
  });
});
