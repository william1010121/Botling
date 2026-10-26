// Plugins: the manifest check and engines ranges (ported from PluginTests.swift), the registry (on/off,
// settings, a broken plugin off until its files change, three crashes in ten minutes), sealed secrets
// (never plain text in a file), and the plugin host client against a host that misbehaves.
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, until } from "../helpers";
import { checkPlugin, compatible } from "../../src/core/plugins/manifest";
import { PluginRegistry, swiftPrettyJSON } from "../../src/core/plugins/registry";
import { MemorySecretStore, SealedSecretStore, PortSealer, testSealer } from "../../src/core/plugins/secrets";
import { PluginHostClient } from "../../src/core/plugins/host-client";

function plugin(root: string, name: string, options: { version?: string; engines?: string; ccb?: unknown; web?: string | null; host?: string } = {}) {
  const folder = join(root, name);
  mkdirSync(join(folder, "dist"), { recursive: true });
  const ccb = options.ccb ?? { web: "dist/web.js", contributes: { settings: { "x.on": { type: "boolean", default: true, title: "On" } } } };
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version: options.version ?? "1.0.0", engines: { ccb: options.engines ?? "^2.0.0" }, ccb }));
  const web = options.web === undefined ? "export function activate() {}" : options.web;
  if (web !== null) writeFileSync(join(folder, "dist", "web.js"), web);
  if (options.host) writeFileSync(join(folder, "dist", "host.mjs"), options.host);
  return folder;
}

describe("the manifest check", () => {
  it("catches what is wrong (PluginTests.checkCatchesWhatIsWrong)", () => {
    const root = tempDir("plugins");
    expect(checkPlugin(plugin(root, "good"))).toEqual([]);
    expect(checkPlugin(plugin(root, "missing", { web: null })).some((p) => p.includes("dist/web.js"))).toBe(true);
    expect(checkPlugin(plugin(root, "old", { engines: "^1.0.0" })).some((p) => p.includes("not compatible"))).toBe(true);
    expect(checkPlugin(plugin(root, "bad-setting", { ccb: { contributes: { settings: { a: { type: "enum", options: ["x"], default: "y", title: "A" } } } } })).some((p) => p.includes("options"))).toBe(true);
    expect(checkPlugin(plugin(root, "escape", { ccb: { web: "../../etc/passwd" } })).some((p) => p.includes("relative path"))).toBe(true);
    expect(checkPlugin(plugin(root, "permission", { ccb: { permissions: ["root"] } })).some((p) => p.includes("root"))).toBe(true);
    const broken = join(root, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "package.json"), "{ nope");
    expect(checkPlugin(broken)[0]).toMatch(/^package\.json is malformed/);
    expect(checkPlugin(plugin(root, "Upper", { engines: "^2.0.0" }))).toEqual(['name "Upper" may only use lowercase letters, digits, - . _.']);
    expect(checkPlugin(plugin(root, "keys", { ccb: { contributes: { commands: [{ id: "a", title: "A", key: "cmd++" }, { id: "a", title: "B" }] } } }))).toEqual([
      'Command "a" has an unreadable shortcut "cmd++" (for example cmd+shift+l).', 'Command "a" is declared twice.',
    ]);
    expect(checkPlugin(plugin(root, "panel", { ccb: { contributes: { panels: [{ id: "p", title: "P" }] } } }))).toEqual(['Panel "p" needs a web part (ccb.web) to draw it.']);
    expect(checkPlugin(plugin(root, "env", { ccb: { contributes: { settings: { t: { type: "string", title: "T", secret: true, env: "lower" } } } } }))).toEqual(['Setting "t": env "lower" must use uppercase letters, digits and underscores.']);
  });

  it("reads engines ranges as npm does (PluginTests.enginesRanges)", () => {
    for (const yes of ["^2.0.0", "~2.0.1", ">=1.5.0", "*", "<2.1.0", ">=1.0.0 <3.0.0", "^1.0.0 || ^2.0.0", "2.x", "1.5 - 2.0"]) expect(compatible(yes), yes).toBe(true);
    for (const no of ["^3.0.0", "^2.4.0", "<2.0.0", ">=1.0.0 <2.0.0", ">2", "not a range"]) expect(compatible(no), no).toBe(false);
  });

  it("writes manifests as Swift's JSONEncoder does (pretty, sorted, ` : `)", () => {
    expect(swiftPrettyJSON({ b: [], a: { c: "x/y" } }, { escapeSlashes: false })).toBe('{\n  "a" : {\n    "c" : "x/y"\n  },\n  "b" : [\n\n  ]\n}');
    expect(swiftPrettyJSON({ path: "a/b" })).toBe('{\n  "path" : "a\\/b"\n}');
  });
});

describe("the plugin registry", () => {
  it("keeps on/off and settings in plugins.json (1.x's format); a broken folder is listed, not loaded", () => {
    const dir = tempDir("plugins");
    const library = join(dir, "plugins");
    plugin(library, "helper", { ccb: { host: "dist/host.mjs", contributes: { settings: { "x.on": { type: "boolean", default: true, title: "On" }, token: { type: "string", title: "Token", secret: true } } } }, host: "export function activate() {}" });
    plugin(library, "bad", { engines: "^9.0.0" });
    const secrets = new MemorySecretStore();
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), secrets);
    expect(registry.plugins.map((p) => p.manifest.name)).toEqual(["helper"]);
    expect(registry.problems.bad?.[0]).toMatch(/not compatible/);
    expect(registry.hostSpecs(join(dir, "data"))[0]).toMatchObject({ name: "helper", settings: { "x.on": true, token: null }, storageDir: join(dir, "data", "helper") });
    registry.set("helper", "x.on", false);
    void secrets.set("helper", "token", "s3cret");
    registry.setEnabled("helper", false);
    expect(registry.hostSpecs(join(dir, "data"))).toEqual([]);
    const state = readFileSync(join(dir, "plugins.json"), "utf8");
    expect(JSON.parse(state)).toEqual({ disabled: ["helper"], settings: { helper: { "x.on": false } }, failures: {}, installed: {} });
    expect(state).not.toContain("s3cret");
    const again = new PluginRegistry(library, join(dir, "plugins.json"), secrets);
    expect(again.plugin("helper")?.enabled).toBe(false);
    again.setEnabled("helper", true);
    // The program part gets its secret; a page never does (settingsView says only that it is set).
    expect(again.hostSpecs(join(dir, "data"))[0]!.settings).toEqual({ "x.on": false, token: "s3cret" });
    expect(again.settingsView(again.plugin("helper")!)).toEqual([
      { key: "x.on", type: "boolean", title: "On", options: [], secret: false, value: false, set: true },
      { key: "token", type: "string", title: "Token", options: [], secret: true, value: null, set: true },
    ]);
  });

  it("the Claude parts' MCP servers are tools bots use without asking (1.x's claudeTools)", () => {
    const dir = tempDir("plugins");
    const library = join(dir, "plugins");
    const folder = plugin(library, "gh", { ccb: { claude: "claude" }, web: null });
    mkdirSync(join(folder, "claude", ".claude-plugin"), { recursive: true });
    writeFileSync(join(folder, "claude", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "github-tools", version: "1.0.0" }));
    writeFileSync(join(folder, "claude", ".mcp.json"), JSON.stringify({ mcpServers: { issues: {}, actions: {} } }));
    plugin(library, "plain");
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore());
    expect(registry.claudeTools()).toEqual(["mcp__plugin_github-tools_actions", "mcp__plugin_github-tools_issues"]);
    registry.setEnabled("gh", false);
    expect(registry.claudeTools()).toEqual([]);
  });

  it("a broken plugin is off until its files change, said once; three crashes in ten minutes turn one off", () => {
    const dir = tempDir("plugins");
    const library = join(dir, "plugins");
    const folder = plugin(library, "helper", { ccb: { host: "dist/host.mjs" }, host: "export function activate() {}" });
    const registry = new PluginRegistry(library, join(dir, "plugins.json"), new MemorySecretStore());
    const notices: string[] = [];
    const broken: string[] = [];
    registry.onNotice = (text) => notices.push(text);
    registry.onBroken = (name, problem) => broken.push(`${name}: ${problem}`);
    registry.markFailed("helper", "boom");
    expect(registry.plugin("helper")).toMatchObject({ failure: "boom", enabled: false });
    registry.markFailed("helper", "boom");
    expect(notices).toEqual(['Plugin "helper" failed and was disabled for now: boom']);
    expect(broken).toEqual(["helper: boom"]);
    // A fixed version gets another try.
    writeFileSync(join(folder, "dist", "host.mjs"), "export function activate() { /* fixed */ }");
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(folder, "dist", "host.mjs"), later, later);
    expect(registry.rescan()).toBe(true);
    expect(registry.plugin("helper")).toMatchObject({ failure: null, enabled: true });
    const start = 1_000_000;
    registry.recordHostFailure("helper", "a", false, start);
    registry.recordHostFailure("helper", "b", false, start + 700_000);
    registry.recordHostFailure("helper", "c", false, start + 800_000);
    expect(registry.plugin("helper")?.enabled).toBe(true);
    registry.recordHostFailure("helper", "d", false, start + 900_000);
    expect(registry.plugin("helper")?.failure).toBe("d");
    expect(registry.hostSpecs(dir)).toEqual([]);
    // A folder that turns broken after the first scan is handed to Maintainer.
    writeFileSync(join(folder, "package.json"), "{ nope");
    registry.rescan();
    expect(broken.at(-1)).toMatch(/^helper: Check failed: package\.json is malformed/);
  });
});

describe("sealed secrets", () => {
  it("keep only sealed bytes in plugin-secrets.json (0600) and open them again after a restart", async () => {
    const dir = tempDir("secrets");
    const file = join(dir, "plugin-secrets.json");
    const store = new SealedSecretStore(file, testSealer("key-1"));
    await store.load();
    await store.set("helper", "token", "hunter2-plain");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("hunter2");
    expect(Object.keys(JSON.parse(text).helper)).toEqual(["token"]);
    expect((await import("node:fs")).statSync(file).mode & 0o777).toBe(0o600);
    const again = new SealedSecretStore(file, testSealer("key-1"));
    await again.load();
    expect(again.get("helper", "token")).toBe("hunter2-plain");
    // Another key cannot open it: it stays sealed, and the problem is said.
    const wrong = new SealedSecretStore(file, testSealer("key-2"));
    await wrong.load();
    expect(wrong.get("helper", "token")).toBeNull();
    expect(wrong.problem).toMatch(/could not be opened/);
    // No safe storage: nothing can be kept.
    const none = new SealedSecretStore(join(dir, "none.json"), null);
    await none.load();
    expect(none.problem).toMatch(/no safe storage/);
    await expect(none.set("helper", "token", "x")).rejects.toThrow(/safe storage/);
    await again.set("helper", "token", null);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({});
  });
});

describe("the plugin host client", () => {
  const clients: PluginHostClient[] = [];
  afterEach(async () => { for (const client of clients.splice(0)) await client.shutdown(); });

  it("checks what the host sends: junk, unknown shapes and over-long lines are dropped; requests are answered once", async () => {
    const dir = tempDir("host");
    // A host that says ready, then sends junk, a malformed message, a request, and answers `load`.
    const script = join(dir, "host.mjs");
    writeFileSync(script, `
      import { createInterface } from "node:readline";
      const out = (v) => process.stdout.write((typeof v === "string" ? v : JSON.stringify(v)) + "\\n");
      out({ method: "ready", params: { pid: process.pid } });
      out("not json at all");
      out({ method: "notify", extra: "smuggled", params: {} });
      out("x".repeat(5 * 1024 * 1024));
      out({ id: 7, method: "bots.list", params: {} });
      out({ method: "pluginError", params: { plugin: "p", message: "thrown" } });
      createInterface({ input: process.stdin }).on("line", (line) => {
        const m = JSON.parse(line);
        if (m.method === "load") { out({ id: m.id, result: { loaded: ["p"], failed: [{ name: "q", message: "kaput" }] } }); out({ method: "registered", params: { beforeSend: 1, afterReply: 0, commands: ["p.go", 5] } }); }
        if (m.method === "beforeSend") out({ id: m.id, result: { text: m.params.text + "!" } });
        if (m.method === "shutdown") { out({ id: m.id, result: null }); process.exit(0); }
        if (m.id === 7) out({ method: "notify", params: { plugin: "p", text: "answered " + JSON.stringify(m.result) } });
      });
    `);
    const client = new PluginHostClient(script, { command: process.execPath }, join(dir, "data"));
    clients.push(client);
    const requests: string[] = [];
    const notes: unknown[] = [];
    const failures: string[] = [];
    client.onRequest = async (method) => { requests.push(method); return [{ id: "main" }]; };
    client.onNotification = (method, params) => notes.push([method, params]);
    client.onPluginFailure = (plugin, message, fatal) => failures.push(`${plugin}:${message}:${fatal}`);
    client.update([{ name: "p", version: "1.0.0", main: join(dir, "p.mjs"), fingerprint: "f", settings: {}, storageDir: join(dir, "data", "p") }]);
    expect(await client.waitUntilReady(10_000)).toBe(true);
    await until(() => client.commands.length > 0);
    expect(client.commands).toEqual(["p.go"]);
    expect(await client.beforeSend({ id: "main" }, "hi")).toEqual({ send: "hi!" });
    await until(() => notes.length > 0);
    expect(requests).toEqual(["bots.list"]);
    expect(notes).toEqual([["notify", { plugin: "p", text: 'answered [{"id":"main"}]' }]]);
    expect(failures).toEqual(["p:thrown:false", "q:The program part failed to load: kaput:true"]);
  });

  it("starts the host with an allow-listed environment and restarts it when it dies, blaming the plugin it was running", async () => {
    const dir = tempDir("host");
    const script = join(dir, "host.mjs");
    writeFileSync(script, `
      import { createInterface } from "node:readline";
      const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
      out({ method: "ready", params: {} });
      createInterface({ input: process.stdin }).on("line", (line) => {
        const m = JSON.parse(line);
        if (m.method === "load") { out({ id: m.id, result: { loaded: [], failed: [] } }); out({ method: "notify", params: { env: Object.keys(process.env).sort(), pid: process.pid } }); }
        if (m.method === "command") process.exit(9);
      });
    `);
    process.env.BOTLING_SECRET_TEST = "must-not-pass";
    const client = new PluginHostClient(script, { command: process.execPath }, join(dir, "data"), () => {}, { hook: 1_000, call: 2_000, load: 2_000, ready: 2_000, restartDelay: 50 });
    clients.push(client);
    const notes: any[] = [];
    const failures: string[] = [];
    client.onNotification = (_, params) => notes.push(params);
    client.onPluginFailure = (plugin, message) => failures.push(`${plugin}: ${message}`);
    client.update([{ name: "p", version: "1.0.0", main: join(dir, "p.mjs"), fingerprint: "f", settings: {}, storageDir: join(dir, "data", "p") }]);
    await until(() => notes.length > 0);
    delete process.env.BOTLING_SECRET_TEST;
    const env: string[] = notes[0].env;
    expect(env).toContain("CCB_PLUGIN_HOST");
    expect(env.filter((key) => key.startsWith("BOTLING") || key.startsWith("FAKE_") || key.startsWith("ELECTRON"))).toEqual([]);
    const first = notes[0].pid;
    await expect(client.command("p.crash")).rejects.toThrow(/exited/);
    await until(() => notes.length > 1, { timeout: 5_000 });
    expect(notes[1].pid).not.toBe(first);
    expect(client.restarts).toBe(1);
    expect(failures).toEqual(["p: The plugin host crashed while running it (9)"]);
  });
});

void chmodSync;


it('A2 keychain API denial is a nonfatal warning and preserves sealed bytes', async()=>{
 const dir=tempDir('keychain-denied'),file=join(dir,'plugin-secrets.json');
 const original=JSON.stringify({synthetic:{token:'synthetic-ciphertext'}});writeFileSync(file,original);
 const sealer=new PortSealer(message=>sealer.answer({id:message.id,ok:false,error:'User denied keychain access'}));
 const store=new SealedSecretStore(file,sealer);await expect(store.load()).resolves.toBeUndefined();
 expect(store.get('synthetic','token')).toBeNull();expect(store.has('synthetic','token')).toBe(true);
 expect(store.problem).toContain('User denied keychain access');expect(readFileSync(file,'utf8')).toBe(original);
 await expect(store.set('synthetic','other','no plaintext persistence')).rejects.toThrow('User denied keychain access');
 expect(readFileSync(file,'utf8')).toBe(original);
});
