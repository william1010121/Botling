// @vitest-environment jsdom
// Botling 3: the desktop window's Settings › Plugins approves a plugin that is not allowed yet (an imported 2.x plugin is
// kept at "nothing yet" until the user approves it, B-20(a)). Before this, the window only printed the CLI line, so a
// plugin such as reading-coach (陪讀) opened its panel to "Not sent: the plugin may not do this". The window now shows what
// the plugin asks at its running hash and sends one `plugin.grant` (no `via`, scope local) for the tier the user picks;
// after it the owner's grant check lets the plugin's own commands through.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Command, PluginView, type PluginsView } from "../../src/contract";
import { folderHash } from "../../src/core/plugins/catalog";
import { Plugins, type PluginWorld } from "../../src/core/plugins";
import { PluginsPanel } from "../../src/renderer/Plugins";
import { RequestFailed, type Client } from "../../src/renderer/client";
import { windowGrantCommand } from "../../src/renderer/plugin-grant";
import { Botlingd, readPluginAsks } from "../../src/server/botlingd";
import { grantAllows } from "../../src/server/slots/grant-check";
import { putRow } from "../../src/server/replica/tables";
import { openServerStore, type ServerStore } from "../../src/server/store";
import { PluginRow } from "../../src/protocol/table-rows";
import { botlingdEnv, testRoot } from "../botlingd-harness";
import { desktop, tempDir, until } from "../helpers";

const openStores: ServerStore[] = [];
afterEach(async () => {
  for (const store of openStores.splice(0)) await store.close().catch(() => {});
  document.body.innerHTML = "";
});

const HASH = "4d9bac0566d3ca220a837eba6d48c6496eb75257a36853c7775d662c52634cc8";
const asks = (over: Partial<NonNullable<PluginView["asks"]>> = {}): NonNullable<PluginView["asks"]> => ({
  codeHash: HASH, tier: "write", reads: [], requests: ["bots.create", "chat.send"], ...over,
});
const plugin = (over: Partial<PluginView> = {}): PluginView => ({
  name: "reading-coach", title: "陪讀", version: "0.3.0", description: null, enabled: true, failure: null, installedFrom: null,
  permissions: ["files", "exec", "bots", "network"], parts: ["web", "host"], settings: [], commands: [], panels: [],
  grant: "none", asks: asks(), ...over,
});
const view = (plugins: PluginView[]): PluginsView => ({ plugins, broken: [], host: { running: true, problem: null }, secretsProblem: null });

/** A client whose `plugin.grant` answers when the test says so (`settle`), so a second tap lands while the first is in flight. */
function fakeClient() {
  const sent: Command[] = [];
  const waiting: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const client = {
    request: (cmd: Command) => {
      sent.push(cmd);
      if (cmd.type === "plugins.store") return new Promise(() => {});
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    onEvent: () => () => {},
  } as unknown as Client;
  const grants = () => sent.filter((cmd) => cmd.type === "plugin.grant");
  return { client, grants, settle: async (outcome: "ok" | Error) => act(async () => { const next = waiting.shift()!; if (outcome === "ok") next.resolve({ applied: true }); else next.reject(outcome); }) };
}

async function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(element));
  return { host, rerender: async (next: ReturnType<typeof createElement>) => { await act(async () => root.render(next)); }, done: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const panel = (client: Client, plugins: PluginView[]) => createElement(PluginsPanel, { client, plugins: view(plugins), onPanel() {}, onClose() {}, embedded: true });
const tiers = (host: HTMLElement) => [...host.querySelectorAll<HTMLInputElement>(".plugin-grant input[type=radio]")].map((input) => input.value);
const allowButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button.plugin-grant-allow");
const pick = (host: HTMLElement, tier: string) => act(async () => { host.querySelector<HTMLInputElement>(`.plugin-grant input[value="${tier}"]`)!.click(); });
const tap = (host: HTMLElement) => act(async () => { allowButton(host)!.click(); });

describe("PluginView.asks", () => {
  it("accepts the running hash with its asks and refuses a malformed hash, an unknown tier or an unknown command", () => {
    expect(PluginView.safeParse(plugin()).success).toBe(true);
    expect(PluginView.safeParse(plugin({ asks: undefined })).success).toBe(true);
    expect(PluginView.safeParse({ ...plugin(), asks: asks({ codeHash: "a b" }) }).success).toBe(false);
    expect(PluginView.safeParse({ ...plugin(), asks: { ...asks(), tier: "admin" } }).success).toBe(false);
    expect(PluginView.safeParse({ ...plugin(), asks: { ...asks(), requests: ["no.such"] } }).success).toBe(false);
  });
});

describe("Settings › Plugins: approving a plugin from the window", () => {
  it("offers the tiers up to what the plugin asks, with what it asks, and Allow only once a tier is picked", async () => {
    const { client } = fakeClient();
    const ui = await render(panel(client, [plugin()]));
    try {
      expect(tiers(ui.host)).toEqual(["read", "request", "write"]);
      expect(ui.host.querySelector(".plugin-asks")?.textContent).toBe("It asks to: read the chat it is shown in; send bots.create; send messages in that chat (chat.send); change its own data on the server.");
      expect(allowButton(ui.host)?.disabled).toBe(true);
      await pick(ui.host, "write");
      expect(allowButton(ui.host)?.disabled).toBe(false);
    } finally { await ui.done(); }

    const request = await render(panel(fakeClient().client, [plugin({ asks: asks({ tier: "request" }) })]));
    try { expect(tiers(request.host)).toEqual(["read", "request"]); } finally { await request.done(); }
  });

  it("sends one plugin.grant at the shown hash with the shown asks, even on a double tap", async () => {
    const { client, grants, settle } = fakeClient();
    const ui = await render(panel(client, [plugin()]));
    try {
      await pick(ui.host, "write");
      await tap(ui.host);
      await tap(ui.host);
      expect(grants()).toEqual([{ type: "plugin.grant", plugin: "reading-coach", codeHash: HASH, tier: "write", reads: [], requests: ["bots.create", "chat.send"] }]);
      expect(allowButton(ui.host)?.disabled).toBe(true);
      await settle("ok");
      // The server re-announces the list with the new grant: the line says so and Allow has nothing to do.
      await ui.rerender(panel(client, [plugin({ grant: "write" })]));
      expect(ui.host.textContent).toContain("Allowed on this machine: Change its own data on the server");
      expect(allowButton(ui.host)?.disabled).toBe(true);
      expect(grants()).toHaveLength(1);
    } finally { await ui.done(); }
  });

  it("a read grant carries no requests, and a refused grant shows why and can be tried again", async () => {
    const { client, grants, settle } = fakeClient();
    const ui = await render(panel(client, [plugin()]));
    try {
      await pick(ui.host, "read");
      await tap(ui.host);
      expect(grants()[0]).toMatchObject({ tier: "read", requests: [] });
      await settle(new RequestFailed({ code: "conflict", message: "Not sent: codeHash is not known for plugin reading-coach" }));
      expect(ui.host.querySelector("[role=alert]")?.textContent).toContain("codeHash is not known");
      expect(allowButton(ui.host)?.disabled).toBe(false);
      await tap(ui.host);
      expect(grants()).toHaveLength(2);
    } finally { await ui.done(); }
  });

  it("offers nothing for a built-in plugin, a 2.x core (no grant) or a server that sends no asks", async () => {
    for (const one of [plugin({ builtIn: true, grant: "write" }), plugin({ grant: undefined, asks: undefined }), plugin({ asks: undefined })]) {
      const ui = await render(panel(fakeClient().client, [one]));
      try {
        expect(ui.host.querySelector(".plugin-grant")).toBeNull();
        expect(allowButton(ui.host)).toBeNull();
      } finally { await ui.done(); }
    }
  });

  it("windowGrantCommand never puts plugin.grant in the requests and refuses a tier above the asks", () => {
    const shown = plugin({ asks: asks({ tier: "request", requests: ["chat.send", "plugin.grant"] as never }) });
    expect(windowGrantCommand(shown, "request")).toEqual({ type: "plugin.grant", plugin: "reading-coach", codeHash: HASH, tier: "request", reads: [], requests: ["chat.send"] });
    expect(windowGrantCommand(shown, "write")).toBeNull();
    expect(windowGrantCommand(plugin({ asks: undefined }), "read")).toBeNull();
    expect(windowGrantCommand(plugin({ builtIn: true }), "read")).toBeNull();
  });
});

function stubWorld(): PluginWorld {
  return new Proxy({}, { get: (_target, key) => (key === "workspace" ? new Proxy({}, { get: () => () => [] }) : () => null) }) as PluginWorld;
}

describe("Plugins.view() and readPluginAsks", () => {
  it("puts pluginAsks' answer on each plugin and leaves asks out when it answers null or is unset (2.x)", () => {
    const dir = tempDir("plugin-asks-view");
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(dir, "plugins", name, "dist"), { recursive: true });
      writeFileSync(join(dir, "plugins", name, "package.json"), JSON.stringify({ name, version: "1.0.0", engines: { ccb: "^2.0.0" }, ccb: { web: "dist/web.js" } }));
      writeFileSync(join(dir, "plugins", name, "dist", "web.js"), "export function activate() {}");
    }
    const v3 = new Plugins({ dataDir: dir, world: stubWorld(), node: null, hostScript: "", sealer: null, pluginGrant: () => "none", pluginAsks: (name) => (name === "alpha" ? asks() : null) });
    const list = v3.view().plugins;
    expect(list.find((p) => p.name === "alpha")?.asks).toEqual(asks());
    expect("asks" in list.find((p) => p.name === "beta")!).toBe(false);
    const v2 = new Plugins({ dataDir: dir, world: stubWorld(), node: null, hostScript: "", sealer: null });
    for (const item of v2.view().plugins) expect("asks" in item).toBe(false);
  });

  it("reads the row's running hash and manifest asks (never plugin.grant), and null for a missing or malformed row or a failing reader", async () => {
    const dir = tempDir("read-plugin-asks");
    const store = await openServerStore(dir);
    openStores.push(store);
    const serverId = "srv-local-1";
    const stream = `srv:${serverId}`;
    const reader = store.openReader();
    expect(readPluginAsks(reader, serverId, "reading-coach")).toBeNull();
    const row: PluginRow = {
      codeHash: HASH,
      manifest: { tier: "write", reads: ["bot:main"], requests: ["bots.create", "chat.send", "plugin.grant"], owns: [], provides: [], requires: [], uses: [], clients: [], needsShell: [] },
      author: "import",
      grants: {},
    };
    await store.submit((tx) => { putRow(tx, stream, "plugin:reading-coach", row); });
    expect(readPluginAsks(reader, serverId, "reading-coach")).toEqual({ codeHash: HASH, tier: "write", reads: ["bot:main"], requests: ["bots.create", "chat.send"] });
    await store.submit((tx) => {
      tx.prepare("INSERT OR REPLACE INTO rows (stream, key, rev, body, deleted) VALUES (?, ?, 99, ?, 0)").run(stream, "plugin:broken", JSON.stringify({ codeHash: HASH, grants: "bad" }));
    });
    expect(readPluginAsks(reader, serverId, "broken")).toBeNull();
    const throwing = { prepare() { throw new Error("database is closed"); } } as unknown as typeof reader;
    expect(readPluginAsks(throwing, serverId, "reading-coach")).toBeNull();
  });
});

describe("botlingd: the window's approval lets the plugin's commands through the grant check", () => {
  it("an imported-style plugin at nothing yet is refused, and after the window's plugin.grant its own commands pass", async () => {
    const dir = testRoot("plugin-grant-approve-daemon");
    const daemon = await Botlingd.start({ env: botlingdEnv(dir, { BOTLING_SERVER_PORT: "off", BOTLING_SERVER_BACKUP_CHECK_MS: "0" }), outDir: join(desktop, "out") });
    const stream = `srv:${daemon.serverId}`;
    const sql = <T>(q: string, ...args: string[]): T | undefined => {
      const db = new DatabaseSync(join(dir, "server.db"), { readOnly: true });
      try { db.exec("PRAGMA busy_timeout = 10000"); return db.prepare(q).get(...args) as T | undefined; } finally { db.close(); }
    };
    const row = (): PluginRow | null => {
      const found = sql<{ body: string }>("SELECT body FROM rows WHERE stream = ? AND key = 'plugin:probe-coach' AND deleted = 0", stream);
      return found ? PluginRow.parse(JSON.parse(found.body)) : null;
    };
    const shown = () => (JSON.parse((daemon.core as any).lastPlugins).plugins as PluginView[]).find((p) => p.name === "probe-coach");
    try {
      const folder = join(dir, "plugins", "probe-coach");
      mkdirSync(join(folder, "dist"), { recursive: true });
      writeFileSync(join(folder, "package.json"), JSON.stringify({ name: "probe-coach", version: "0.3.0", engines: { ccb: "^2.0.0" }, ccb: { permissions: ["files", "bots"], web: "dist/web.js" } }));
      writeFileSync(join(folder, "dist", "web.js"), "export function activate() {}\n");
      daemon.core.plugins.scan();
      const hash = folderHash(folder);
      await until(() => (row()?.codeHash === hash && shown()?.asks?.codeHash === hash) || null, { timeout: 5_000, every: 50, what: "row and window list at the running hash" });
      expect(shown()?.grant).toBe("none");
      expect(shown()?.asks).toEqual({ codeHash: hash, tier: "write", reads: [], requests: ["bots.create", "chat.send"] });

      const via = { plugin: "probe-coach", codeHash: hash };
      const call = Command.parse({ type: "plugins.call", name: "probe-coach", method: "list", params: null, from: "frame" });
      const send = { type: "chat.send", botId: "main", text: "hi" } as unknown as Command;
      expect(grantAllows(row(), via, call, "This Mac", ["probe-coach"])).toEqual({ ok: false, detail: "plugin probe-coach may not do this on This Mac" });

      const cmd = windowGrantCommand(shown()!, "write");
      expect(cmd).not.toBeNull();
      const status = await daemon.runtime.receive({
        slot: { origin: "desktop", originEpoch: "a".repeat(32), target: stream, n: 1 }, floor: 1,
        inc: String(sql<{ logId: string }>("SELECT logId FROM streams WHERE stream = ?", stream)!.logId),
        cmd,
      } as any, { scope: "local" });
      expect((status as any).message.outcome).toMatchObject({ kind: "applied" });
      await until(() => shown()?.grant === "write" || null, { timeout: 2_000, every: 20, what: "window shows the grant" });
      expect(grantAllows(row(), via, call, "This Mac", ["probe-coach"])).toEqual({ ok: true });
      expect(grantAllows(row(), via, send, "This Mac", ["probe-coach"])).toEqual({ ok: true });
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
