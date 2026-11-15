// @vitest-environment jsdom
// `bot/context`, the bot row's menu, owned by `botling.sidebar` (M7-05b). The menu (Rail.tsx `BotMenu`) draws from the kernel slot: the
// plugin's own items (Pin / Unpin, Restart bot, Remove …) are its contributions, a plugin's `bot/context` rows (the feed's `{kind: "feed"}`
// entries) sit between them, and a plugin item presses through `plugins.command` exactly as before: the same request, with no `via` stamp
// (the app page runs a menu command as itself; a frame's request carries `{ plugin }`, renderer/client.ts RequestVia).
// The DOM goldens in test/fixtures/sidebar/menu.*.html were recorded from the code before this card (the menu drawn from its props):
// the slot's markup, and the markup of a page without the plugin, are those bytes.
// The slot's canonical id is still the 2.x one (`menu/bot/context`): tests ask by either name and compare with `canonicalSlot`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSlot, slotName } from "../../../Web/src/plugin-kernel";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import type { BotView, PluginsView } from "../../src/contract";
import { BotMenu } from "../../src/renderer/Rail";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { sidebarDeclaration } from "../../src/renderer/plugins/sidebar";
import { FEED_SLOTS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { configureShellStorage, createMemoryShellStorageBackend } from "../../src/renderer/shell/storage";
import { railLayout } from "../../src/renderer/sidebar-layout";
import { BOT_CONTEXT_SLOT, SIDEBAR_PLUGIN } from "../../src/renderer/sidebar-names";
import { desktop } from "../helpers";
import { ID, mountPage, NOW, pluginsWithMenus, type MountedPage, type PageOptions } from "../sidebar-page";

const BOT_CONTEXT = "menu/bot/context";
const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const golden = (name: string) => readFileSync(join(desktop, "test", "fixtures", "sidebar", `menu.${name}.html`), "utf8").replace(/^<!-- [^\n]* -->\n/, "").replace(/\n$/, "");

const hosts: InPageHost[] = [];
const pages: MountedPage[] = [];
const roots: { unmount(): void; host: HTMLElement }[] = [];
let warnings: string[];

beforeEach(() => {
  configureShellStorage(createMemoryShellStorageBackend());
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => { warnings.push(String(line)); });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  for (const page of pages.splice(0)) await page.unmount();
  for (const one of roots.splice(0)) { await act(async () => one.unmount()); one.host.remove(); }
  for (const one of hosts.splice(0)) await one.stop();
  if (rendererKernel.state("test.extra") !== "absent") await rendererKernel.requestUnload("test.extra");
  rendererKernel.uninstall("test.extra");
  reconcileView(null);
  railLayout.detach();
  configureShellStorage(undefined);
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

/** Starts a host for the plugins the build ships, as ShellFrame's does (the renderer's own manifest is empty in a test). */
async function shell() {
  const made = new InPageHost({ manifest });
  hosts.push(made);
  const results = await made.start();
  return { host: made, results };
}
async function page(options: PageOptions = {}) {
  const mounted = await mountPage(options);
  pages.push(mounted);
  return mounted;
}

type Row = { plugin: string; menu: string; command: string; title: string };
const ZED: Row = { plugin: "zed.tools", menu: "bot/context", command: "zed.tools.run", title: "Run zed" };
const ACME: Row = { plugin: "acme", menu: "bot/context", command: "acme.sync", title: "Sync <acme> & co" };
const LINK: Row = { plugin: "zed.tools", menu: "chat/link", command: "zed.tools.link", title: "Open link" };
const view = (...rows: Row[]): PluginsView => pluginsWithMenus(rows);
/** The plugin rows the slot holds (the feed's entries; the sidebar's own items are other kinds). */
const feedRows = () => rendererKernel.entries<{ kind: string; row?: { command: string } }>(BOT_CONTEXT).filter(({ entry }) => entry.kind === "feed").map(({ entry }) => entry.row!.command);
const ownItems = () => rendererKernel.entries<{ kind: string; id?: string }>(BOT_CONTEXT).filter(({ entry }) => entry.kind === "bot-menu-item");
/** After the feed's kernel steps (a load is a promise) settled. */
const feedHas = (...commands: string[]) => act(async () => { await vi.waitFor(() => { expect(feedRows()).toEqual(commands); }); });

const bot = (role: string): BotView => ({ id: "p1", name: "botling", role, avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as unknown as BotView);
const commands = [{ command: ZED.command, title: ZED.title }, { command: ACME.command, title: ACME.title }];
const base = { at: { x: 12, y: 34 }, onRemove() {}, onClose() {}, onTogglePin() {}, onRestart() {} };
const staticMenu = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(BotMenu, { ...base, ...props } as never));

const openMenu = async (mounted: MountedPage, id: string = ID.beta) => {
  await act(async () => { mounted.host.querySelector(`.bot-row[data-bot="${id}"]`)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })); });
  expect(mounted.host.querySelector(".bot-menu")).not.toBeNull();
};
const menuHtml = (mounted: MountedPage) => (mounted.host.querySelector(".bot-menu")?.outerHTML ?? "").replace(/:r[0-9a-z]+:/g, ":rN:");
const labels = (mounted: MountedPage) => [...mounted.host.querySelectorAll(".bot-menu [role=menuitem]")].map((item) => item.textContent);
const pressItem = (mounted: MountedPage, text: string) => act(async () => { ([...mounted.host.querySelectorAll<HTMLElement>(".bot-menu [role=menuitem]")].find((item) => item.textContent === text))!.click(); });

describe("the sidebar plugin owns bot/context", () => {
  it("owns it under both names, and :shell no longer does (the list the shell owns leaves it)", async () => {
    expect(PLUGIN_OWNED_SLOTS).toContain(BOT_CONTEXT);
    expect(FEED_SLOTS).not.toContain(BOT_CONTEXT);
    expect(canonicalSlot(BOT_CONTEXT_SLOT)).toBe(BOT_CONTEXT);
    expect(slotName(BOT_CONTEXT)).toBe(BOT_CONTEXT_SLOT);
    await shell();
    for (const slot of [BOT_CONTEXT, BOT_CONTEXT_SLOT]) expect(rendererKernel.slotOwner(slot), slot).toBe(SIDEBAR_PLUGIN);
    expect(sidebarDeclaration.provides?.slots).toContain(BOT_CONTEXT_SLOT);
    expect(rendererKernel.declaration(SIDEBAR_PLUGIN)?.provides?.slots).toContain(BOT_CONTEXT);
  });

  it("contributes its own items to it: Pin, Restart and Remove, each once, as the plugin's registrations", async () => {
    await shell();
    expect(ownItems().map(({ plugin }) => plugin)).toEqual([SIDEBAR_PLUGIN, SIDEBAR_PLUGIN, SIDEBAR_PLUGIN]);
    expect(ownItems().map(({ entry }) => entry.id).sort()).toEqual(["pin", "remove", "restart"]);
  });

  it("takes them back when it unloads, and gives them again when it loads again", async () => {
    const { host } = await shell();
    expect(ownItems()).toHaveLength(3);
    expect(host.unload(SIDEBAR_PLUGIN)).toBe(true);
    await vi.waitFor(() => { expect(rendererKernel.state(SIDEBAR_PLUGIN)).toBe("absent"); });
    expect(ownItems()).toEqual([]);
    expect(rendererKernel.slotOwner(BOT_CONTEXT)).toBeNull();
    await host.start(manifest.plugins.filter((entry) => entry.name === SIDEBAR_PLUGIN));
    expect(ownItems()).toHaveLength(3);
  });

  it("holds a plugin's bot/context row in the slot while it is up, in either order of loading, and refuses it when nobody owns the slot", async () => {
    await shell();
    reconcileView(view(ZED, ACME, LINK));
    await feedHas(ZED.command, ACME.command);
    reconcileView(null);
    await feedHas();
    // The page's list came first, the owner after: the rows are registered once the owner is up (the host tells the feed).
    await hosts[0]!.stop();
    reconcileView(view(ZED, ACME));
    await act(async () => { await Promise.resolve(); });
    expect(feedRows()).toEqual([]);
    const { host } = await shell();
    await feedHas(ZED.command, ACME.command);
    // The owner goes away: the plugins' rows go with the slot (the kernel does not keep a menu item nobody owns).
    host.unload(SIDEBAR_PLUGIN);
    await vi.waitFor(() => { expect(rendererKernel.state(SIDEBAR_PLUGIN)).toBe("absent"); });
    expect(feedRows()).toEqual([]);
  });
});

describe("the menu as drawn", () => {
  const scenarios: { name: string; props: Record<string, unknown>; menus?: Row[] }[] = [
    { name: "bot", props: { bot: bot("bot"), pinned: false } },
    { name: "pinned", props: { bot: bot("bot"), pinned: true } },
    { name: "project", props: { bot: bot("manager"), pinned: false } },
    { name: "zh", props: { bot: bot("bot"), pinned: false, lang: "zh-Hant" } },
    { name: "plugins", props: { bot: bot("bot"), pinned: false, commands, onCommand() {} }, menus: [ZED, ACME] },
  ];
  for (const scenario of scenarios) {
    it(`${scenario.name}: a page without the plugin draws the recorded markup, and so does the slot`, async () => {
      expect(staticMenu(scenario.props), "without the plugin").toBe(golden(scenario.name));
      await shell();
      if (scenario.menus) { reconcileView(view(...scenario.menus)); await feedHas(...scenario.menus.map((row) => row.command)); }
      expect(staticMenu(scenario.props), "from the slot").toBe(golden(scenario.name));
    });
  }

  it("draws a plugin's items from the slot, not from the props: with no commands given, the slot's rows show, between Restart and Remove", async () => {
    await shell();
    reconcileView(view(ZED, ACME));
    await feedHas(ZED.command, ACME.command);
    const html = staticMenu({ bot: bot("bot"), pinned: false, commands: [], onCommand() {} });
    expect(html).toBe(golden("plugins"));
  });

  it("draws the page's menu as recorded, from the slot and without the plugin (a right click on a row)", async () => {
    const rows = [ZED, LINK, ACME];
    const bare = await page({ shown: ID.alpha, plugins: view(...rows) });
    await openMenu(bare);
    expect(menuHtml(bare), "without the plugin").toBe(golden("page"));
    await bare.unmount();
    pages.splice(pages.indexOf(bare), 1);
    await shell();
    const mounted = await page({ shown: ID.alpha, plugins: view(...rows) });
    await feedHas(ZED.command, ACME.command);
    await openMenu(mounted);
    expect(menuHtml(mounted), "from the slot").toBe(golden("page"));
    expect(mounted.host.querySelectorAll(".bot-menu")).toHaveLength(1);
  });

  it("puts the plugin's own items first and last whatever the order they were registered in (the plugin registers after the feed row)", async () => {
    reconcileView(view(ZED, ACME));
    await shell();
    await feedHas(ZED.command, ACME.command);
    // Registration order: the plugin's items were registered after nothing; the rows after them. The menu is Pin, Restart, rule, rows, rule, Remove.
    const html = staticMenu({ bot: bot("bot"), pinned: false, commands, onCommand() {} });
    expect(html).toBe(golden("plugins"));
    expect(html.indexOf("Pin")).toBeLessThan(html.indexOf("Run zed"));
    expect(html.indexOf("Run zed")).toBeLessThan(html.indexOf("Remove bot"));
  });

  it("follows the plugin list while the page is up: a row that goes away leaves the menu, and a new one shows", async () => {
    await shell();
    const mounted = await page({ shown: ID.alpha, plugins: view(ZED) });
    await feedHas(ZED.command);
    await openMenu(mounted);
    expect(labels(mounted)).toEqual(["Pin", "Restart bot", "Run zed", "Remove project…"]);
    reconcileView(view(ZED, ACME));
    await feedHas(ZED.command, ACME.command);
    expect(labels(mounted)).toEqual(["Pin", "Restart bot", "Run zed", "Sync <acme> & co", "Remove project…"]);
    reconcileView(view());
    await feedHas();
    expect(labels(mounted)).toEqual(["Pin", "Restart bot", "Remove project…"]);
    expect(mounted.host.querySelectorAll(".bot-menu-rule")).toHaveLength(1);
  });

  it("ignores a built-in item contributed by another plugin, and an item id it does not know", async () => {
    await shell();
    rendererKernel.install({ name: "test.extra", contributes: { slots: [BOT_CONTEXT] } });
    await rendererKernel.load("test.extra", (plugin) => {
      rendererKernel.contribute(plugin, BOT_CONTEXT_SLOT, { kind: "bot-menu-item", id: "remove", place: "bottom" });
      rendererKernel.contribute(plugin, BOT_CONTEXT_SLOT, { kind: "bot-menu-item", id: "format-disk", place: "top" });
      rendererKernel.contribute(plugin, BOT_CONTEXT_SLOT, { kind: "component", render: () => createElement("i", { id: "intruder" }) });
    });
    expect(rendererKernel.entries(BOT_CONTEXT)).toHaveLength(6);
    expect(staticMenu({ bot: bot("bot"), pinned: false })).toBe(golden("bot"));
    expect(staticMenu({ bot: bot("bot"), pinned: false })).not.toContain("intruder");
  });

  it("draws a plugin's row as text, not markup, and keeps a hostile command id off the menu's own items", async () => {
    const hostile: Row = { plugin: "acme", menu: "bot/context", command: "acme.__proto__", title: "<img src=x onerror=alert(1)>" };
    await shell();
    reconcileView(view(hostile));
    await feedHas(hostile.command);
    const html = staticMenu({ bot: bot("bot"), pinned: false, commands: [], onCommand() {} });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });
});

describe("pressing an item", () => {
  it("a plugin's item sends plugins.command with the bot's id, no `from`, and no `via` stamp: the same request as a page without the plugin", async () => {
    const rows = [ZED, ACME];
    const bare = await page({ shown: ID.alpha, plugins: view(...rows) });
    await openMenu(bare);
    await pressItem(bare, "Run zed");
    const direct = bare.sent.filter((command) => command.type === "plugins.command");
    expect(direct).toEqual([{ type: "plugins.command", id: "zed.tools.run", args: [ID.beta] }]);
    await bare.unmount();
    pages.splice(pages.indexOf(bare), 1);
    await shell();
    const mounted = await page({ shown: ID.alpha, plugins: view(...rows) });
    await feedHas(ZED.command, ACME.command);
    await openMenu(mounted);
    await pressItem(mounted, "Sync <acme> & co");
    await openMenu(mounted);
    await pressItem(mounted, "Run zed");
    const sent = mounted.calls.filter(([command]) => (command as { type: string }).type === "plugins.command");
    // One argument each: the command alone. A `via` would be a third argument (renderer/client.ts), `from` and `name` a caller.
    expect(sent).toEqual([[{ type: "plugins.command", id: "acme.sync", args: [ID.beta] }], [{ type: "plugins.command", id: "zed.tools.run", args: [ID.beta] }]]);
    expect(mounted.host.querySelector(".bot-menu")).toBeNull();
  });

  it("Pin pins the bot (the old key, as the column's own pin does) and closes the menu; the menu then says Unpin", async () => {
    await shell();
    const mounted = await page({ shown: ID.alpha });
    await act(async () => { await vi.waitFor(() => { expect(railLayout.current()).not.toBeNull(); }); });
    await openMenu(mounted);
    expect(labels(mounted)[0]).toBe("Pin");
    await pressItem(mounted, "Pin");
    expect(mounted.host.querySelector(".bot-menu")).toBeNull();
    const writes = mounted.sent.filter((command) => command.type === "settings.set").map((command) => command.change as { key: string; value: unknown }).filter((change) => change.key === "pinnedBots");
    expect(writes).toEqual([{ key: "pinnedBots", value: [ID.beta] }]);
    await openMenu(mounted);
    expect(labels(mounted)[0]).toBe("Unpin");
  });

  it("Restart bot sends bot.restart for that bot once and closes the menu", async () => {
    await shell();
    const mounted = await page({ shown: ID.alpha });
    await openMenu(mounted);
    await pressItem(mounted, "Restart bot");
    expect(mounted.sent.filter((command) => command.type === "bot.restart")).toEqual([{ type: "bot.restart", botId: ID.beta }]);
    expect(mounted.host.querySelector(".bot-menu")).toBeNull();
  });

  it("Remove asks first (the confirm dialog), and sends nothing yet", async () => {
    await shell();
    const mounted = await page({ shown: ID.alpha });
    await openMenu(mounted);
    await pressItem(mounted, "Remove project…");
    expect(mounted.host.querySelector('[role="alertdialog"] h2')?.textContent).toBe('Remove "Beta"?');
    expect(mounted.host.querySelector(".bot-menu")).toBeNull();
    expect(mounted.sent.filter((command) => command.type === "bot.remove" || command.type === "project.remove")).toEqual([]);
  });

  it("the menu closes on Escape and on a click elsewhere, as before", async () => {
    await shell();
    const mounted = await page({ shown: ID.alpha });
    await openMenu(mounted);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(mounted.host.querySelector(".bot-menu")).toBeNull();
    await openMenu(mounted);
    await act(async () => { document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
    expect(mounted.host.querySelector(".bot-menu")).toBeNull();
  });
});

describe("a menu drawn alone (no page)", () => {
  it("is drawn by a component test with the plugin up and with it down, the same", async () => {
    const draw = async () => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      roots.push({ unmount: () => root.unmount(), host });
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
      await act(async () => root.render(createElement(BotMenu, { ...base, bot: bot("bot"), pinned: false } as never)));
      return host.innerHTML;
    };
    const without = await draw();
    await shell();
    const within = await draw();
    // (innerHTML spells the style attribute its own way; the recorded markup is the static one.)
    expect(without).toContain("Remove bot…");
    expect(within).toBe(without);
  });
});
