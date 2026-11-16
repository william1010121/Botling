// @vitest-environment jsdom
// Botling 3: the desktop window's Settings › Plugins approves a plugin that is not allowed yet (an imported 2.x plugin is
// kept at "nothing yet" until the user approves it, B-20(a)). Before this, the window only printed the CLI line, so a
// plugin such as reading-coach (陪讀) opened its panel to "Not sent: the plugin may not do this". The window now shows what
// the plugin asks at its running hash and sends one `plugin.grant` (no `via`, scope local) at the tier it asks, from one
// Install tap (2026-11-16: no tiers to pick); after it the owner lets the plugin and its new versions through.
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
import { installCommand } from "../../src/renderer/plugin-grant";
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
/** The card's confirm button: only there once the card is open (the row's or the detail's Allow opens it, over Settings). */
const allowButton = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button.plugin-grant-allow");
const openCard = (host: HTMLElement) => act(async () => { host.querySelector<HTMLButtonElement>("button.plugin-allow-open")!.click(); });
const tap = async (host: HTMLElement) => { if (!allowButton(host)) await openCard(host); await act(async () => { allowButton(host)!.click(); }); };

describe("PluginView.asks", () => {
  it("accepts the running hash with its asks and refuses a malformed hash, an unknown tier or an unknown command", () => {
    expect(PluginView.safeParse(plugin()).success).toBe(true);
    expect(PluginView.safeParse(plugin({ asks: undefined })).success).toBe(true);
    expect(PluginView.safeParse({ ...plugin(), asks: asks({ codeHash: "a b" }) }).success).toBe(false);
    expect(PluginView.safeParse({ ...plugin(), asks: { ...asks(), tier: "admin" } }).success).toBe(false);
    expect(PluginView.safeParse({ ...plugin(), asks: { ...asks(), requests: ["no.such"] } }).success).toBe(false);
  });
});

describe("Settings › Plugins: the install card (2026-11-16: one tap, no tiers)", () => {
  it("a plugin that waits for Allow has Allow on its row and at the top of its detail; the card opens only on that tap", async () => {
    const { client } = fakeClient();
    const ui = await render(panel(client, [plugin()]));
    try {
      expect(ui.host.querySelector("li.plugin[data-plugin=reading-coach] button.plugin-allow-open")?.textContent).toBe("Allow");
      const box = ui.host.querySelector(".plugin-detail .plugin-allow-box");
      expect(box?.querySelector("button.plugin-allow-open")?.textContent).toBe("Allow");
      // The box comes before everything else in the detail (the permission chips, the settings).
      expect(box?.compareDocumentPosition(ui.host.querySelector(".plugin-detail .plugin-section")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(ui.host.querySelector(".plugin-grant")).toBeNull();
      await openCard(ui.host);
      expect(ui.host.querySelector(".plugin-install-card.plugin-grant")).not.toBeNull();
    } finally { await ui.done(); }
  });

  it("shows what the plugin asks and one Install button, with no tier to pick", async () => {
    const { client } = fakeClient();
    const ui = await render(panel(client, [plugin()]));
    try {
      await openCard(ui.host);
      expect(ui.host.querySelectorAll(".plugin-grant input[type=radio]")).toHaveLength(0);
      expect(ui.host.querySelector(".plugin-asks")?.textContent).toBe("It asks to: read the chat it is shown in; send bots.create; send messages in that chat (chat.send); change its own data on the server.");
      expect(allowButton(ui.host)?.textContent).toBe("Install and allow");
      expect(allowButton(ui.host)?.disabled).toBe(false);
      expect(ui.host.textContent).toContain("Not installed on this machine");
    } finally { await ui.done(); }
  });

  it("sends one plugin.grant at the shown hash, at the tier the plugin asks, with the shown asks, even on a double tap", async () => {
    const { client, grants, settle } = fakeClient();
    const ui = await render(panel(client, [plugin()]));
    try {
      // Two taps before React draws the disabled button: only the in-flight guard stops the second.
      await openCard(ui.host);
      await act(async () => { allowButton(ui.host)!.click(); allowButton(ui.host)!.click(); });
      await tap(ui.host);
      expect(grants()).toEqual([{ type: "plugin.grant", plugin: "reading-coach", codeHash: HASH, tier: "write", reads: [], requests: ["bots.create", "chat.send"] }]);
      expect(allowButton(ui.host)?.disabled).toBe(true);
      await settle("ok");
      // The server re-announces the list with the plugin installed: the card says it is done (nothing left to confirm), and the
      // list no longer asks for Allow.
      await ui.rerender(panel(client, [plugin({ grant: "write" })]));
      expect(ui.host.textContent).toContain("Installed on this machine");
      expect(allowButton(ui.host)).toBeNull();
      expect(ui.host.querySelector(".plugin-card-done")?.textContent).toContain("Installed.");
      expect(ui.host.querySelector(".plugin-allow-open")).toBeNull();
      expect(grants()).toHaveLength(1);
    } finally { await ui.done(); }
  });

  it("a plugin that asks for less is sent at that tier (a read ask carries no requests); a refused install shows why and can be tried again", async () => {
    const { client, grants, settle } = fakeClient();
    const ui = await render(panel(client, [plugin({ asks: asks({ tier: "read", requests: ["chat.send"] }) })]));
    try {
      await tap(ui.host);
      expect(grants()[0]).toMatchObject({ tier: "read", requests: [] });
      await settle(new RequestFailed({ code: "conflict", message: "Not sent: codeHash is not known for plugin reading-coach" }));
      expect(ui.host.querySelector("[role=alert]")?.textContent).toContain("codeHash is not known");
      expect(allowButton(ui.host)?.disabled).toBe(false);
      await tap(ui.host);
      expect(grants()).toHaveLength(2);
    } finally { await ui.done(); }
  });

  it("offers no card for a built-in plugin, an installed one, a 2.x core (no grant) or a server that sends no asks", async () => {
    for (const one of [plugin({ builtIn: true, grant: "write" }), plugin({ grant: "write" }), plugin({ grant: "request" }), plugin({ grant: undefined, asks: undefined }), plugin({ grant: undefined }), plugin({ asks: undefined })]) {
      const ui = await render(panel(fakeClient().client, [one]));
      try {
        expect(ui.host.querySelector(".plugin-grant")).toBeNull();
        expect(allowButton(ui.host)).toBeNull();
      } finally { await ui.done(); }
    }
  });

  it("review: a new running hash starts a fresh card, and Install sends the hash it shows", async () => {
    const { client, grants } = fakeClient();
    const NEW = "5e0cbd1677e4db331b948fcb7e59d7d57fc86368b47964d8886e773d63745dd9";
    const ui = await render(panel(client, [plugin()]));
    try {
      await ui.rerender(panel(client, [plugin({ asks: asks({ codeHash: NEW }) })]));
      await tap(ui.host);
      expect(grants()).toEqual([expect.objectContaining({ codeHash: NEW, tier: "write" })]);
    } finally { await ui.done(); }
  });

  it("installCommand never puts plugin.grant in the requests, and offers nothing for a built-in, an installed plugin or no asks", () => {
    const shown = plugin({ asks: asks({ tier: "request", requests: ["chat.send", "plugin.grant"] as never }) });
    expect(installCommand(shown)).toEqual({ type: "plugin.grant", plugin: "reading-coach", codeHash: HASH, tier: "request", reads: [], requests: ["chat.send"] });
    expect(installCommand(plugin({ asks: undefined }))).toBeNull();
    expect(installCommand(plugin({ builtIn: true }))).toBeNull();
    expect(installCommand(plugin({ grant: "write" }))).toBeNull();
    expect(installCommand(plugin({ grant: undefined }))).toBeNull();
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
    // Review: asks the row allows but PluginView (and plugin.grant) cannot carry offer no approval instead of an invalid view.
    for (const reads of [[""], Array.from({ length: 51 }, (_, i) => `r${i}`)]) {
      await store.submit((tx) => { putRow(tx, stream, "plugin:wide", { ...row, manifest: { ...row.manifest, reads } }); });
      expect(readPluginAsks(reader, serverId, "wide")).toBeNull();
    }
    const throwing = { prepare() { throw new Error("database is closed"); } } as unknown as typeof reader;
    expect(readPluginAsks(throwing, serverId, "reading-coach")).toBeNull();
  });
});

describe("botlingd: the window's approval lets the plugin's commands through the grant check", () => {
  it("a plugin that is not installed is refused, and after the window's install card (plugin.grant) its commands pass", async () => {
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
      expect(grantAllows(row(), via, call, "This Mac", ["probe-coach"])).toEqual({ ok: false, detail: "plugin probe-coach is not installed on This Mac" });

      const cmd = installCommand(shown()!);
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
