// M6-06: botlingd seals plugin secrets through the attached Botling 3 window (ShellBridge + shell.seal / shell.open
// + Core.reloadPluginSecrets / Plugins.reloadSecrets + secretReportLines). No Electron, no window, no real 2.x data folder.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SealedSecretStore, type Sealer } from "../../src/core/plugins/secrets";
import { NO_SAFE_STORAGE_ERROR, sealWithSafeStorage, type SafeStorageLike } from "../../src/main/safe-seal";
import { ServerClient } from "../../src/main-v3/server-client";
import { decodeFrame, memberIdFromKey, roleRefusal, toBase64Url, type Message, type MessageOf, type Slot } from "../../src/protocol";
import { Botlingd, NO_SAFE_STORAGE as DAEMON_NO_SAFE_STORAGE } from "../../src/server/botlingd";
import { effectCheckpointSink } from "../../src/server/effects";
import { bindServerIdentity, ClusterSetup, loadOrCreateServerIdentity } from "../../src/server/identity";
import { secretReportLines } from "../../src/server/import/secrets-report";
import { IntentRuntime } from "../../src/server/intents";
import { LiveChannel } from "../../src/server/live";
import { LogHub } from "../../src/server/log";
import { RosterStore } from "../../src/server/roster";
import { RemoteSessions, slotAuthorize } from "../../src/server/session";
import { NO_SAFE_STORAGE, ShellBridge, type ShellWindow } from "../../src/server/shell-bridge";
import { openServerStore } from "../../src/server/store";
import { generateDhKeyPair, SessionLink, type SessionTransport } from "../../src/session";
import { botlingdEnv, ScriptClient, testRoot } from "../botlingd-harness";
import { FakeTurnEngine } from "../fixtures/fake-turn-engine";
import { until } from "../helpers";

const EXPECTED_NO_SAFE_STORAGE =
  "Plugin secrets need the Botling 3 window's safe storage (the Keychain), which this M1 server does not reach yet; open Botling 2.x for plugins that keep secrets.";
const DETACHED_ERROR = "The Botling 3 window closed before it answered.";
const EPOCH = "0123456789abcdef0123456789abcdef";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step(); });

function tempFolder(prefix = "bsec"): string {
  const dir = testRoot(prefix);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Reversible byte-XOR cipher so clear secrets never touch disk in tests. */
function fakeSeal(op: "seal" | "open", value: string): string {
  if (op === "seal") return `fake:${Buffer.from(Uint8Array.from(Buffer.from(value, "utf8"), (b) => b ^ 0x5a)).toString("base64")}`;
  if (!value.startsWith("fake:")) throw new Error("bad sealed payload");
  return Buffer.from(Uint8Array.from(Buffer.from(value.slice("fake:".length), "base64"), (b) => b ^ 0x5a)).toString("utf8");
}

function makeFakeOutDir(root: string): string {
  const outDir = join(root, "out");
  mkdirSync(join(outDir, "host"), { recursive: true });
  mkdirSync(join(outDir, "builtin-plugins"), { recursive: true });
  writeFileSync(join(outDir, "host", "host.mjs"), `
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
const specs = new Map();
out({ method: "ready", params: { pid: process.pid } });
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "load") {
    specs.clear();
    const plugins = Array.isArray(msg.params?.plugins) ? msg.params.plugins : [];
    for (const p of plugins) specs.set(p.name, p);
    out({ id: msg.id, result: { loaded: plugins.map((p) => p.name), failed: [], timings: {} } });
    out({ method: "registered", params: { beforeSend: 0, afterReply: 0, commands: plugins.map((p) => p.name + ".token"), exposed: {}, events: [] } });
  } else if (msg.method === "command") {
    const tok = specs.get(String(msg.params?.id ?? "").split(".")[0])?.settings?.token;
    out({ id: msg.id, result: typeof tok === "string" ? createHash("sha256").update(tok).digest("hex") : null });
  } else if (msg.method === "shutdown") {
    out({ id: msg.id, result: null });
    process.exit(0);
  }
});
`);
  return outDir;
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : entry.isFile() ? [full] : [];
  });
}

describe("ShellBridge sealer (M6-06)", () => {
  it("1. with an attached fake window, sealer().seal and sealer().open round-trip through shell.seal / shell.open", async () => {
    const bridge = new ShellBridge();
    const seen: Message[] = [];
    let attached = 0;
    const off = bridge.onAttach(() => { attached++; });
    const window: ShellWindow = {
      send(message) {
        seen.push(message);
        queueMicrotask(() => {
          if (message.t === "shell.seal") bridge.answer(window, { t: "shell.done", req: message.req, ok: true, data: { sealed: fakeSeal("seal", message.text) } });
          else if (message.t === "shell.open") bridge.answer(window, { t: "shell.done", req: message.req, ok: true, data: { text: fakeSeal("open", message.sealed) } });
        });
        return true;
      },
    };
    bridge.attach(window);
    expect(attached).toBe(1);
    off();
    bridge.attach(window);
    expect(attached).toBe(1);

    const sealer = bridge.sealer();
    const sealed = await sealer.seal("s3cret");
    expect(sealed).not.toContain("s3cret");
    expect(await sealer.open(sealed)).toBe("s3cret");
    expect(seen).toEqual([
      { t: "shell.seal", req: expect.any(String), text: "s3cret" },
      { t: "shell.open", req: expect.any(String), sealed },
    ]);
  });

  it("2. with no window, seal and open both reject with NO_SAFE_STORAGE byte for byte", async () => {
    expect(NO_SAFE_STORAGE).toBe(EXPECTED_NO_SAFE_STORAGE);
    expect(DAEMON_NO_SAFE_STORAGE).toBe(NO_SAFE_STORAGE);
    const sealer = new ShellBridge().sealer();
    const exact = new RegExp(`^${NO_SAFE_STORAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
    await expect(sealer.seal("s3cret")).rejects.toThrow(exact);
    await expect(sealer.open("fake:AA==")).rejects.toThrow(exact);
  });

  it("3. window detaches while seal/open waits -> rejects with DETACHED_ERROR; ok: false -> rejects with its error", async () => {
    const bridge = new ShellBridge();
    const silent: ShellWindow = { send: () => true };
    bridge.attach(silent);
    const sealer = bridge.sealer();
    const sealing = sealer.seal("s3cret");
    const opening = sealer.open("fake:AA==");
    bridge.detach(silent);
    await expect(sealing).rejects.toThrow(DETACHED_ERROR);
    await expect(opening).rejects.toThrow(DETACHED_ERROR);

    const failing: ShellWindow = {
      send(message) {
        if (message.t === "shell.seal" || message.t === "shell.open") {
          queueMicrotask(() => bridge.answer(failing, { t: "shell.done", req: message.req, ok: false, error: "User denied keychain access" }));
        }
        return true;
      },
    };
    bridge.attach(failing);
    await expect(sealer.seal("s3cret")).rejects.toThrow("User denied keychain access");
    await expect(sealer.open("fake:AA==")).rejects.toThrow("User denied keychain access");
  });
});

describe("botlingd secrets lifecycle (M6-06)", () => {
  it("4 & 5 (Probe A). keeps plugin secrets through window, forgets without window on restart, reloads on attach, and never writes clear secret to server or app SQLite files", async () => {
    const root = tempFolder("bsec-daemon");
    const dataDir = join(root, "data");
    const appDir1 = join(root, "app1");
    const appDir2 = join(root, "app2");
    const outDir = makeFakeOutDir(root);
    mkdirSync(appDir1, { recursive: true });
    mkdirSync(appDir2, { recursive: true });

    const pluginDir = join(dataDir, "plugins", "my-tool");
    mkdirSync(join(pluginDir, "dist"), { recursive: true });
    writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
      name: "my-tool", version: "1.0.0", engines: { ccb: "^2.0.0" },
      ccb: { host: "dist/host.mjs", contributes: { settings: { token: { type: "string", title: "Token", secret: true } } } },
    }));
    writeFileSync(join(pluginDir, "dist", "host.mjs"), "export function activate() {}");

    const logs: string[] = [];
    const expectedDigest = createHash("sha256").update("s3cret").digest("hex");
    const env = botlingdEnv(dataDir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0" });
    const openWindow = (appDir: string) => {
      const w = new ServerClient(
        { script: join(outDir, "core", "main.cjs"), env: { BOTLING_APP_DATA_DIR: appDir, BOTLING_SERVER_DATA_DIR: dataDir }, onEvent: () => undefined, audit: () => undefined, seal: fakeSeal },
        { launch: () => { throw new Error("unexpected launch"); } },
      );
      cleanups.push(async () => { await w.stop().catch(() => undefined); await w.linkForTests?.close().catch(() => undefined); });
      return w;
    };

    const daemon1 = await Botlingd.start({ env, outDir, log: (line) => logs.push(line) });
    cleanups.push(async () => { await daemon1.stop().catch(() => undefined); });
    const window1 = openWindow(appDir1);
    window1.start();
    await window1.ready();
    await until(async () => {
      const r = await window1.request({ type: "plugins.list" });
      return r.ok && (r.result as { host?: { running?: boolean } }).host?.running ? true : null;
    }, { timeout: 15_000, what: "plugin host running in daemon1" });

    await window1.call({ type: "plugins.secret", name: "my-tool", key: "token", value: "s3cret" });
    await until(async () => ((await window1.call({ type: "plugins.command", id: "my-tool.token" })) as { result?: unknown }).result === expectedDigest || null, { timeout: 15_000, what: "plugin reads secret" });
    // F3: botlingd writes bound secret blobs ({ v: 1, plugin, key, text }).
    const rawFile = JSON.parse(readFileSync(join(dataDir, "plugin-secrets.json"), "utf8")) as Record<string, Record<string, string>>;
    expect(JSON.parse(fakeSeal("open", rawFile["my-tool"]!.token!))).toEqual({ v: 1, plugin: "my-tool", key: "token", text: "s3cret" });
    await window1.stop();
    await daemon1.stop();

    // Restart without a window -> secret is unknown and secretsProblem names NO_SAFE_STORAGE.
    const daemon2 = await Botlingd.start({ env, outDir, log: (line) => logs.push(line) });
    cleanups.push(async () => { await daemon2.stop().catch(() => undefined); });
    const observer = new ScriptClient("observer");
    cleanups.push(() => { observer.close(); });
    await observer.connect(join(dataDir, "botlingd.sock"), daemon2.token);
    await observer.sub(observer.srv);
    const srvSnap = await observer.wait((m): m is MessageOf<"snap"> => m.t === "snap" && m.stream === observer.srv, "srv snap");
    await until(async () => {
      const r = await observer.req({ type: "plugins.list" });
      return r.ok && (r.result as { host?: { running?: boolean } }).host?.running ? r.result : null;
    }, { timeout: 15_000, what: "plugin host running in daemon2" });
    expect(daemon2.core.plugins.secrets.get("my-tool", "token")).toBeNull();
    expect(daemon2.core.plugins.secrets.problem).toContain(NO_SAFE_STORAGE);
    const slot: Slot = { origin: "observer", originEpoch: observer.originEpoch, target: observer.srv, n: 1 };
    observer.cmd(slot, { type: "plugins.command", id: "my-tool.token" }, srvSnap.logId);
    const withoutWindow = await observer.wait((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.origin === "observer" && m.slot.n === 1, "command without window");
    expect(withoutWindow.outcome).toEqual({ kind: "applied", result: { result: null } });
    observer.close();

    // Window attaches -> shell.onAttach -> core.reloadPluginSecrets() -> plugin reads secret again.
    const window2 = openWindow(appDir2);
    window2.start();
    await window2.ready();
    await until(async () => ((await window2.call({ type: "plugins.command", id: "my-tool.token" })) as { result?: unknown }).result === expectedDigest || null, { timeout: 15_000, what: "plugin reads secret after attach" });
    expect((await window2.call({ type: "plugins.list" })).secretsProblem).toBeNull();
    await window2.stop();
    // F1: calling plugins.secret after detach fails immediately with core_unavailable and never persists to fe-link.sqlite.
    const detachedRes = await window2.request({ type: "plugins.secret", name: "my-tool", key: "token", value: "s3cret" });
    expect(detachedRes).toMatchObject({ ok: false, error: { code: "core_unavailable" } });
    await daemon2.stop();

    const needle = Buffer.from("s3cret", "utf8");
    const appFiles = [...walkFiles(appDir1), ...walkFiles(appDir2)];
    expect(appFiles.some((file) => file.endsWith("fe-link.sqlite"))).toBe(true);
    const files = [...walkFiles(dataDir), ...appFiles];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file).includes(needle), `clear secret found in ${file}`).toBe(false);
    expect(logs.join("\n")).not.toContain("s3cret");
  }, 60_000);
});

describe("protocol role check, remote refusal, race guard, bound format, safe-seal, and 2.x secret report (M6-06)", () => {
  it("6 & 7. a remote device session is refused shell.seal/shell.open (bye{role}) and plugins.secret (forbidden / refused{scope})", async () => {
    expect(roleRefusal("shell.seal", "fe", { local: false })).toMatch(/may not send/);
    expect(roleRefusal("shell.open", "fe", { local: false })).toMatch(/may not send/);
    expect(roleRefusal("shell.seal", "server", { local: false })).toMatch(/local socket/);
    expect(roleRefusal("shell.open", "server", { local: false })).toMatch(/local socket/);
    expect(decodeFrame(JSON.stringify({ t: "shell.seal", req: "r1", text: "x" }), "fe", { local: false })).toMatchObject({ ok: false, reason: "role", bye: { t: "bye", reason: "role" } });

    const dir = tempFolder("bsec-role");
    const store = await openServerStore(dir);
    const identity = await loadOrCreateServerIdentity(dir, { create: true });
    const { serverId, memberId } = await store.submit((tx) => bindServerIdentity(tx, identity));
    const roster = await RosterStore.open(store, identity);
    const setup = new ClusterSetup(roster);
    expect((await setup.confirm((await setup.begin()).code)).ok).toBe(true);
    const engine = new FakeTurnEngine({ bots: [] });
    const hub = new LogHub(store, { serverStreams: true });
    const live = new LiveChannel({ sink: effectCheckpointSink(store), checkpointIntervalMs: 5 });
    const runtime = new IntentRuntime({ store, engine, hub, live, authorize: slotAuthorize(roster), serverEvents: "all" });
    await runtime.start();
    const srvInc = String((hub.reader().prepare("SELECT logId FROM streams WHERE stream = ?").get(`srv:${serverId}`) as { logId: string }).logId);
    const shell = new ShellBridge();
    const remote = new RemoteSessions({
      serverId, serverName: "Test server", startedAt: Date.now(), minFeVersion: "3.0.0", token: () => "t".repeat(32),
      hub, live, runtime, engine, content: null, shell, nextFor: () => ({}), ensureBotStream: async () => false, log: () => undefined,
      roster, self: { memberId, dhPub: identity.dhPub, dhKey: identity.dhKey },
    });
    cleanups.push(async () => {
      remote.close(); await runtime.scope.submit(() => undefined); engine.close(); runtime.close(); shell.close(); live.close(); hub.close(); await store.close();
    });

    const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const dh = await generateDhKeyPair();
    const signPub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
    const deviceMember = await memberIdFromKey(signPub);
    await roster.addDevice({ keys: { sign: toBase64Url(signPub), dh: toBase64Url(dh.publicKey) }, name: "Phone", scope: ["read", "reply", "approve", "manage"] });

    const got: Message[] = [];
    let link!: SessionLink;
    const session = remote.accept({ send: (f) => link.receive(f), close: () => setTimeout(() => link.transportClosed(), 0) } as SessionTransport, "memory");
    link = SessionLink.initiate(
      { send: (f) => session.receive(f), close: () => setTimeout(() => link.transportClosed(), 0) } as SessionTransport,
      { mode: "ik", transport: "memory", cluster: roster.clusterId!, self: { memberId: deviceMember, dhPub: dh.publicKey, dhKey: dh.privateKey }, responder: { memberId, dhPub: identity.dhPub } },
      { onFrame: (bytes) => { const d = decodeFrame(bytes, "server", { local: false }); if (d.ok) got.push(d.message); }, onEnd: () => undefined },
    );
    await link.established;
    const enc = new TextEncoder();
    link.send("control", enc.encode(JSON.stringify({ t: "hello", deviceId: deviceMember, feVersion: "3.0.0", protocol: 1, originEpoch: EPOCH, cursors: {}, outbox: [], want: [] })));
    await until(() => got.some((m) => m.t === "welcome") || null, { what: "remote welcome" });

    // F1 part 3: even a manage-scoped remote device is refused plugins.secret (as req and as cmd).
    const secretCmd = { type: "plugins.secret", name: "my-tool", key: "token", value: "x" };
    link.send("control", enc.encode(JSON.stringify({ t: "req", req: "r-sec", cmd: secretCmd })));
    expect(await until(() => got.find((m): m is MessageOf<"res"> => m.t === "res" && m.req === "r-sec") ?? null, { what: "remote req plugins.secret refusal" })).toMatchObject({
      ok: false, error: { code: "forbidden" },
    });
    link.send("control", enc.encode(JSON.stringify({
      t: "cmd",
      slot: { origin: deviceMember, originEpoch: EPOCH, target: `srv:${serverId}`, n: 1 },
      floor: 1,
      inc: srvInc,
      cmd: secretCmd,
    })));
    expect(await until(() => got.find((m): m is MessageOf<"cmd.result"> => m.t === "cmd.result" && m.slot.n === 1) ?? null, { what: "remote cmd plugins.secret refusal" })).toMatchObject({
      outcome: { kind: "refused", reason: "scope" },
    });

    link.send("control", enc.encode(JSON.stringify({ t: "shell.seal", req: "r1", text: "x" })));
    expect(await until(() => got.find((m): m is MessageOf<"bye"> => m.t === "bye") ?? null, { what: "remote bye{role}" })).toMatchObject({ reason: "role" });
  });

  it("8 (Probe B). load() does not restore a secret removed or replaced while open() was in flight", async () => {
    const dir = tempFolder("bsec-race");
    const file = join(dir, "plugin-secrets.json");
    const immediate: Sealer = {
      seal: async (text) => fakeSeal("seal", text),
      open: async (sealed) => fakeSeal("open", sealed),
    };
    const seed = new SealedSecretStore(file, immediate, { bound: true });
    await seed.set("p", "k", "old");
    await seed.set("p", "k2", "old2");

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let openCalls = 0;
    let firstStarted!: () => void;
    const firstInFlight = new Promise<void>((resolve) => { firstStarted = resolve; });
    const gated: Sealer = {
      seal: async (text) => fakeSeal("seal", text),
      open: async (sealed) => {
        openCalls++;
        if (openCalls === 1) firstStarted();
        await gate;
        return fakeSeal("open", sealed);
      },
    };
    const store = new SealedSecretStore(file, gated, { bound: true });
    const loading = store.load();
    await firstInFlight;

    await store.set("p", "k", null);
    await store.set("p", "k2", "new2");
    release();
    await loading;

    expect(store.get("p", "k")).toBeNull();
    expect(store.has("p", "k")).toBe(false);
    expect(store.get("p", "k2")).toBe("new2");
  });

  it("9 (F3). bound SealedSecretStore rejects cross-plugin, cross-key, and raw 2.x blobs while keeping 2.x default unchanged", async () => {
    const dir = tempFolder("bsec-bound");
    const boundFile = join(dir, "bound.json");
    const sealer: Sealer = {
      seal: async (text) => fakeSeal("seal", text),
      open: async (sealed) => fakeSeal("open", sealed),
    };
    const store = new SealedSecretStore(boundFile, sealer, { bound: true });
    await store.set("plugin-a", "token", "secret-a");
    await store.set("plugin-b", "token", "secret-b");

    // Tamper: move plugin-a's blob under plugin-b/token, and under plugin-a/otherKey, plus a raw unbound blob.
    const raw = JSON.parse(readFileSync(boundFile, "utf8")) as Record<string, Record<string, string>>;
    raw["plugin-b"]!.token = raw["plugin-a"]!.token!;
    raw["plugin-a"]!.otherKey = raw["plugin-a"]!.token!;
    raw["plugin-c"] = { rawKey: fakeSeal("seal", "raw-2x-secret") };
    writeFileSync(boundFile, JSON.stringify(raw, null, 2));

    const reloaded = new SealedSecretStore(boundFile, sealer, { bound: true });
    await reloaded.load();
    expect(reloaded.get("plugin-a", "token")).toBe("secret-a");
    expect(reloaded.get("plugin-b", "token")).toBeNull();
    expect(reloaded.get("plugin-a", "otherKey")).toBeNull();
    expect(reloaded.get("plugin-c", "rawKey")).toBeNull();
    expect(reloaded.problem).toContain("Sealed secret");
    expect(reloaded.problem).not.toContain("secret-a");
    expect(reloaded.problem).not.toContain("raw-2x-secret");

    // 2.x default (bound unset) keeps raw value format.
    const legacyFile = join(dir, "legacy.json");
    const legacy = new SealedSecretStore(legacyFile, sealer);
    await legacy.set("plugin-a", "token", "legacy-secret");
    const legacyRaw = JSON.parse(readFileSync(legacyFile, "utf8")) as Record<string, Record<string, string>>;
    expect(fakeSeal("open", legacyRaw["plugin-a"]!.token!)).toBe("legacy-secret");
  });

  it("10 (F5). sealWithSafeStorage refuses Linux basic_text/unknown backends and allows strong backends / macOS", () => {
    const stub = (available: boolean, backend: string): SafeStorageLike => ({
      isEncryptionAvailable: () => available,
      getSelectedStorageBackend: () => backend,
      encryptString: (text) => Buffer.from(text, "utf8"),
      decryptString: (buf) => buf.toString("utf8"),
    });
    expect(() => sealWithSafeStorage(stub(false, "gnome_libsecret"), "seal", "x", "linux")).toThrow(NO_SAFE_STORAGE_ERROR);
    expect(() => sealWithSafeStorage(stub(true, "basic_text"), "seal", "x", "linux")).toThrow(NO_SAFE_STORAGE_ERROR);
    expect(() => sealWithSafeStorage(stub(true, "unknown"), "open", "eA==", "linux")).toThrow(NO_SAFE_STORAGE_ERROR);
    const sealed = sealWithSafeStorage(stub(true, "gnome_libsecret"), "seal", "x", "linux");
    expect(sealWithSafeStorage(stub(true, "gnome_libsecret"), "open", sealed, "linux")).toBe("x");
    expect(sealWithSafeStorage(stub(true, "unknown"), "open", sealed, "darwin")).toBe("x");
  });

  it("11. secretReportLines emits one exact line per plugin with secret keys, none for others", () => {
    expect(secretReportLines([
      { name: "my-tool", secretKeys: ["token"] },
      { name: "plain-plugin", secretKeys: [] },
      { name: "second-tool", secretKeys: ["apiKey", "password"] },
    ])).toEqual([
      "my-tool: enter its secret settings again (Botling 2 keeps them sealed to its own app).",
      "second-tool: enter its secret settings again (Botling 2 keeps them sealed to its own app).",
    ]);
    expect(secretReportLines([])).toEqual([]);
    expect(secretReportLines([{ name: "none", secretKeys: [] }])).toEqual([]);
  });
});
