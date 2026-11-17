// @vitest-environment jsdom
// M7 acceptance, plan-change §4.3 check 2, rendering half (M7-30): with EVERY in-page built-in plugin of the FE build loaded (the end state of M7)
// and the 2.7 fixture plugin list fed to the renderer's kernel (test/fixtures/kernel-goldens/plugins-list.json: the built-in plugins and the
// third-party fixture `zed.tools`, recorded from the 2.x platform before the kernel went under it), each of the 2.x places (11 views, 7 menus,
// `commandPalette` among them) holds the same contributions in the same order, and every surface draws the DOM recorded BEFORE its card moved it
// (test/fixtures/{app-dom,chat-main,bot-panel,chat-header,browser-pane,sidebar,settings-slots}). The ownership half is slot-owners.test.ts.
//
// The per-card tests draw each golden with only the card's own plugin loaded; this one draws them with all of them loaded at once, headless
// (jsdom, no window), so a plugin that disturbs another one's surface fails here. No golden is recorded or changed by this file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { slotName } from "../../../Web/src/plugin-kernel";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import type { BotView, PluginsView, SubagentRowView } from "../../src/contract";
import { MENU_SLOTS, VIEW_SLOTS } from "../../src/core/plugins/contributions";
import { settingsView } from "../../src/core/settings";
import { BotMenu } from "../../src/renderer/Rail";
import { ChatHeaderViews } from "../../src/renderer/ChatHeaderViews";
import type { Client } from "../../src/renderer/client";
import { RightPanel, type RightPanelProps } from "../../src/renderer/RightPanel";
import { SettingsSheet, type SettingsSection } from "../../src/renderer/Settings";
import { SidebarSettings } from "../../src/renderer/SidebarSettings";
import { TakeoverPage } from "../../src/renderer/TakeoverPage";
import { App } from "../../src/renderer/App";
import { SETTINGS_GROUPS } from "../../src/renderer/settings-pages";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { FEED_VIEWS } from "../../src/renderer/shell/feed-slots";
import { InPageHost, inPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { WorkspaceStore, type WorkspaceView } from "../../src/renderer/store";
import { openPane, paneView, type Pane } from "../browser-pane-harness";
import { desktop } from "../helpers";
import { drawPage, fixtureView, mainBot as mainSlotBot, NOTE_TAB, siteBot, SITE, type Page, type PageOptions } from "../main-slot-harness";
import { pluginsWithMenus } from "../sidebar-page";
import { STORAGE_TAB } from "../../src/renderer/main-tabs";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const fixtures = (...parts: string[]) => join(desktop, "test", "fixtures", ...parts);
const read = (...parts: string[]) => readFileSync(fixtures(...parts), "utf8");
const ids = (html: string) => html.replace(/:r[0-9a-z]+:/g, ":rN:").replace(/_r_[0-9a-z]+_/g, ":rN:");

const hosts: InPageHost[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
  await vi.waitFor(() => { expect(rendererKernel.plugins().filter((name) => !name.startsWith(":"))).toEqual([]); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  localStorage.clear();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** Starts a host for the plugins of `entries` (default: every plugin the FE build ships) and lets the page see it (the page reads the renderer's own host). */
async function started(entries = manifest.plugins): Promise<InPageHost> {
  const host = new InPageHost({ manifest: { ...manifest, plugins: entries }, log: () => undefined });
  hosts.push(host);
  const results = await host.start();
  expect(results.filter((result) => result.status !== "loaded"), "every built-in plugin loads").toEqual([]);
  expect(results).toHaveLength(entries.length);
  vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => host.unavailable(name));
  return host;
}

// ---------------------------------------------------------------- every 2.x place holds the fixture's contributions

type Row = { plugin?: string; id?: string; command?: string; menu?: string };
type Held = { kind?: string; row?: Row };
/** The rows the feed put in `slot`, as the ids a golden row names (a view's `id`, a menu's `command`). */
const feedIds = (slot: string): (string | undefined)[] =>
  rendererKernel.entries<Held>(slot).filter(({ entry }) => entry.kind === "feed").map(({ entry }) => (entry.row?.id ?? entry.row?.command));

/** One line per place whose rows differ from the 2.x list the fixture holds (empty: every place is as the 2.x page had it). */
function placeDiffs(view: PluginsView): string[] {
  const diffs: string[] = [];
  const check = (slot: string, want: (string | undefined)[]) => {
    for (const name of [slot, slotName(slot)]) {
      const got = feedIds(name);
      if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`${name}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
    }
  };
  for (const [key, slot] of FEED_VIEWS) check(slot, (view[key] ?? []).map((row) => row.id));
  for (const menu of MENU_SLOTS) check(`menu/${menu}`, (view.menus ?? []).filter((row) => row.menu === menu).map((row) => row.command));
  return diffs;
}
const PLACES = [...VIEW_SLOTS.map((where) => `view/${where}`), ...MENU_SLOTS.map((menu) => `menu/${menu}`)];
/** The places the 2.x list has rows for, fed to the kernel by the plugin feed. The rest (main, window, rightPanel) are drawn by the shell itself (page DOM below). */
const FED = [...FEED_VIEWS.map(([, slot]) => slot), ...MENU_SLOTS.map((menu) => `menu/${menu}`)];

describe("every 2.x place holds the 2.7 fixture's contributions (all built-in plugins loaded)", () => {
  it("is the 11 view places and 7 menus the contributions list names", () => {
    expect(VIEW_SLOTS).toHaveLength(11);
    expect(MENU_SLOTS).toHaveLength(7);
    expect(PLACES).toHaveLength(18);
    // Every place is either fed with the fixture's rows (checked below) or drawn by the shell: main, window and rightPanel have no row in a plugin list.
    expect(PLACES.filter((place) => !FED.includes(place)).sort()).toEqual(["view/main", "view/rightPanel", "view/window"]);
  });

  it("gives each place the rows of the 2.x plugin list, in its order, under the 2.x name and the new one", async () => {
    await started();
    const view = fixtureView();
    reconcileView(view);
    await vi.waitFor(() => { expect(placeDiffs(view)).toEqual([]); });
    // The fixture really fills every fed place (a place with no row in it would pass for nothing), `zed.tools` is in all of them.
    for (const slot of FED) expect(feedIds(slot).length, slot).toBeGreaterThan(0);
    for (const slot of FED) {
      if (slot === "view/rightPanel.section" || slot === "view/composerBar" || slot.startsWith("menu/") || slot === "view/mainTab" || slot === "view/settings.section" || slot === "view/quickSettings" || slot === "view/bottomPanel" || slot === "view/chatHeader" || slot === "view/rightPanel.takeover") {
        const plugins = rendererKernel.entries<Held>(slot).filter(({ entry }) => entry.kind === "feed").map(({ plugin }) => plugin);
        expect(plugins, slot).toContain("zed.tools");
      }
    }
  });

  it("fails when a place lacks its owner: with only the settings plugin loaded the chat's and the panel's places refuse their rows", async () => {
    await started(manifest.plugins.filter((entry) => entry.name === "botling.settings"));
    const view = fixtureView();
    reconcileView(view);
    await act(async () => { await Promise.resolve(); });
    const diffs = placeDiffs(view);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((line) => line.startsWith("view/mainTab:"))).toBe(true);
  });
});

// ---------------------------------------------------------------- the whole app page

const BOT = "B0000000-0000-4000-8000-000000000001";
const siteLike: BotView = { id: BOT, name: "Site", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };

/** app-dom-golden.test.ts's page: the step-1 view surfaces as the plugin list, a manager bot with a chat, or no bot and no plugin list. */
async function appDomMarkup(bots: BotView[], plugins: PluginsView | null): Promise<string> {
  localStorage.setItem("botling.mainWhiteboard", "0");
  const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
  const view: WorkspaceView = { ...defaults, ready: true, bots, settings: settingsView({}), plugins, chat: bots[0] ? { botId: bots[0].id, messages: [], running: null, live: [] } : defaults.chat };
  const store = { getView: () => view, getChatView: () => view, subscribe: () => () => {}, subscribeChat: () => () => {}, showBoard: () => {} } as unknown as WorkspaceStore;
  const client = {
    request: vi.fn(async (command: { type: string; name?: string }) => {
      if (command.type === "plugins.panel") return { title: command.name, source: "", settings: {} };
      if (command.type === "card.page") return { url: "botling-card://page/1" };
      if (command.type === "plugins.web") return { specs: [] };
      if (command.type === "plugins.list") return { plugins: [] };
      return { result: null };
    }),
    onEvent: () => () => {},
  } as unknown as Client;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(App, { client, store })));
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return ids(host.innerHTML);
}
const surfaces = () => ({ plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, keybindings: [], ...(JSON.parse(read("kernel-goldens", "view-surfaces.json")) as Record<string, unknown>) }) as unknown as PluginsView;

describe("the whole app page, drawn with every built-in plugin loaded, is the page the 2.x code drew", () => {
  it("app-dom: a manager bot with a chat, and no bot with no plugin list (test/fixtures/app-dom)", async () => {
    await started();
    for (const [name, bots, plugins] of [["bot-fixture", [siteLike], surfaces()], ["no-bot", [], null]] as const) {
      await act(async () => { await Promise.resolve(); });
      const markup = await appDomMarkup([...bots], plugins);
      await vi.waitFor(() => { expect(`<!-- ${name} -->\n${markup}\n`).toBe(read("app-dom", `app-shell.${name}.html`)); });
      await cleanups.pop()!();
      localStorage.clear();
    }
  });

  const CASES: { name: string; options: PageOptions }[] = [
    { name: "chat", options: {} },
    { name: "note-tab", options: { mainTabs: { [SITE]: NOTE_TAB } } },
    { name: "storage-tab", options: { mainTabs: { [SITE]: STORAGE_TAB } } },
    { name: "main-whiteboard", options: { bots: [mainSlotBot], shown: mainSlotBot.id, whiteboard: null } },
  ];
  for (const { name, options } of CASES) {
    it(`chat-main: ${name} (the chat column, the tabs, the rail, the right panel, the bottom panel and the gear in one page)`, async () => {
      await started();
      const page: Page = await drawPage(options);
      cleanups.push(() => page.close());
      // The feed has the rows in the slots a few microtasks after the page drew; the page draws again when a slot changes.
      await act(async () => { await vi.waitFor(() => { expect(rendererKernel.entries("view/mainTab").length).toBeGreaterThan(0); }); });
      await act(async () => { await vi.waitFor(() => { expect(`<!-- ${name} -->\n${page.markup()}\n`).toBe(read("chat-main", `${name}.html`)); }); });
    });
  }
  it("is not a trivial page: the Site bot is on the page and the golden has the chat column", () => {
    expect(siteBot.id).toBe(SITE);
    expect(read("chat-main", "chat.html")).toContain("chat-pane");
  });
});

// ---------------------------------------------------------------- the right panel and its takeover (bot-panel)

const settledRow = (n: number): SubagentRowView => ({ id: `w${n}`, title: `Worker ${n}`, status: n === 2 ? "running" : "completed", head: "claude", startedAt: 1_000 + n, endedAt: n === 2 ? null : 2_000 + n, unsettledAt: null, settled: true, prompt: `Do job ${n}` });
const panelMain = { id: "main", name: "Main bot", role: "main", heads: ["claude"], phase: "awake", working: false, approvals: 0, unread: 0, avatar: "robot", subagentRows: [1, 2, 3, 4, 5, 6, 7].map(settledRow) } as unknown as BotView;
const panelProject = { id: "site", name: "Site", role: "manager", heads: ["claude"], phase: "awake", working: true, approvals: 0, unread: 0, avatar: "square", subagentRows: [settledRow(1)] } as unknown as BotView;
const waiting = [{ botId: "site", text: "Pick a color", messageId: "m1" }, { botId: "ghost", text: "Memory: ship it?", messageId: null }];
const results = [{ label: "Report", url: "https://example.com/r" }, { label: "Artifact", url: "https://claude.ai/artifact/abc" }, { label: "Notes", url: "https://example.com/n" }, { label: "Fourth", url: "https://example.com/4" }];
function panelProps(bot: BotView, over: Partial<RightPanelProps> = {}): RightPanelProps {
  return {
    bot, bots: [panelMain, panelProject], waiting: { items: waiting, doing: { site: "Building the pages" } }, look: "original", status: { key: "working", text: "Working" },
    results, watching: null, collapsed: false, onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {},
    pluginSections: createElement("section", { className: "detail-section plugin-block" }, "Worktrees"),
    ...over,
  } as unknown as RightPanelProps;
}
/** Mounts `node`, gives its markup and unmounts. */
async function markupOf(node: ReturnType<typeof createElement>): Promise<string> {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(node));
  const html = element.innerHTML;
  await act(async () => root.unmount());
  element.remove();
  return html;
}
const stubClient = (): Client => ({ request: vi.fn(async (command: { type: string; name?: string }) => (command.type === "plugins.list" ? { plugins: [] } : command.type === "plugins.web" ? { specs: [] } : command.type === "plugins.panel" ? { title: command.name, source: "", settings: {} } : command.type === "card.page" ? { url: "botling-card://page/1" } : { result: null })), onEvent: () => () => {} }) as unknown as Client;
/** A client whose `card.page` answers one new page address per call, as the chat-header goldens were recorded. */
function countingClient(): Client {
  let pages = 0;
  return { request: vi.fn(async (command: { type: string; name?: string }) => (command.type === "plugins.list" ? { plugins: [] } : command.type === "plugins.panel" ? { title: command.name, source: "", settings: {} } : command.type === "card.page" ? { url: `botling-card://page/${++pages}` } : { result: null })), onEvent: () => () => {} } as unknown as Client;
}
const golden = (dir: string, file: string, markup: string) => expect(`<!-- ${file.replace(/\.html$/, "")} -->\n${ids(markup)}\n`).toBe(read(dir, file));

describe("the right panel, its takeover and the chat header, drawn with every built-in plugin loaded", () => {
  it("bot-panel: main bot open, project bot open, main bot folded, a takeover", async () => {
    await started();
    golden("bot-panel", "main-open.html", await markupOf(createElement(RightPanel, panelProps(panelMain))));
    golden("bot-panel", "project-open.html", await markupOf(createElement(RightPanel, panelProps(panelProject))));
    golden("bot-panel", "main-folded.html", await markupOf(createElement(RightPanel, panelProps(panelMain, { collapsed: true }))));
    golden("bot-panel", "takeover.html", await markupOf(createElement(TakeoverPage, { client: stubClient(), plugin: "botling.component-studio", view: "botling.component-studio.spec", title: "Component spec", botId: "main", wide: true, plugins: null, onError() {}, onAsk() {} })));
  });

  it("chat-header: the plugin views closed, with a popover open, with the second one open", async () => {
    await started();
    const feed = surfaces();
    reconcileView(feed);
    await vi.waitFor(() => { expect(rendererKernel.entries("chat/header")).toHaveLength(2); expect(rendererKernel.entries("composer/bar")).toHaveLength(1); });
    const views = feed.chatHeaderViews ?? [];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(ChatHeaderViews, { client: countingClient(), views, botId: "B1" })));
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
    const same = (file: string) => expect(ids(host.innerHTML) + "\n").toBe(read("chat-header", file));
    same("header-closed.html");
    await act(async () => { (host.querySelectorAll("button")[0] as HTMLButtonElement).click(); });
    same("header-popover-open.html");
    await act(async () => { (host.querySelectorAll("button")[1] as HTMLButtonElement).click(); });
    same("header-popover-second.html");
  });
});

// ---------------------------------------------------------------- the menus: browser tab, bot row, commandPalette is in the page golden

describe("the menus, drawn with every built-in plugin loaded", () => {
  const TAB_CASES: { name: string; tab: { url: string; fileUrl?: string }; language?: string }[] = [
    { name: "pdf", tab: { url: "botling-content://file/abc", fileUrl: "file:///p/a.pdf" } },
    { name: "host", tab: { url: "https://docs.example.org/x" } },
    { name: "other-zh", tab: { url: "https://example.com/", }, language: "zh-Hant" },
  ];
  for (const { name, tab, language } of TAB_CASES) {
    it(`browser/tab: the toolbar's plugin buttons, ${name}`, async () => {
      await started();
      const pane: Pane = await openPane(paneView(), tab, language);
      cleanups.push(() => pane.close());
      await act(async () => { await vi.waitFor(() => { expect(`<!-- ${name} -->\n${pane.toolbar()}\n`).toBe(read("browser-pane", `${name}.html`)); }); });
    });
  }

  it("bot/context: the bot row's menu with a plugin's two items between Restart and Remove", async () => {
    await started();
    const ZED = { plugin: "zed.tools", menu: "bot/context" as const, command: "zed.tools.run", title: "Run zed" };
    const ACME = { plugin: "acme", menu: "bot/context" as const, command: "acme.sync", title: "Sync <acme> & co" };
    reconcileView(pluginsWithMenus([ZED, ACME]));
    await vi.waitFor(() => { expect(feedIds("menu/bot/context")).toEqual([ZED.command, ACME.command]); });
    const bot = { id: "p1", name: "botling", role: "bot", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as unknown as BotView;
    const props = { at: { x: 12, y: 34 }, onRemove() {}, onClose() {}, onTogglePin() {}, onRestart() {}, bot, pinned: false, commands: [{ command: ZED.command, title: ZED.title }, { command: ACME.command, title: ACME.title }], onCommand() {} };
    const html = renderToStaticMarkup(createElement(BotMenu, props as never));
    expect(html).toBe(read("sidebar", "menu.plugins.html").replace(/^<!-- [^\n]* -->\n/, "").replace(/\n$/, ""));
  });
});

// ---------------------------------------------------------------- Settings and the gear (settings-slots)

describe("Settings and the gear, drawn with every built-in plugin loaded", () => {
  let element: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    element = document.createElement("div");
    document.body.append(element);
    root = createRoot(element);
    cleanups.push(async () => { await act(async () => root.unmount()); element.remove(); });
  });
  const client = () => ({
    request: vi.fn(async (command: { type: string }) => {
      if (command.type === "plugins.panel") return { title: "t", source: "export const activate = () => {};", settings: {} };
      if (command.type === "card.page") return { url: "botling-card://page/1" };
      if (command.type === "plugins.web") return { specs: [] };
      if (command.type === "settings.get" || command.type === "settings.set") return settingsView({});
      throw new Error(`no stub for ${command.type}`);
    }),
    onEvent: () => () => {},
  }) as unknown as Client;
  const q = (selector: string) => element.querySelector(selector);
  async function mountSheet(plugins: PluginsView | null, initialSection: SettingsSection = "general") {
    await act(async () => root.unmount());
    root = createRoot(element);
    await act(async () => root.render(createElement(SettingsSheet, { client: client(), settings: settingsView({}), bot: null, plugins, initialSection, onClose() {} })));
    await act(async () => { await Promise.resolve(); });
  }
  const navAndHeader = () => ids(`${q(".settings-side")!.outerHTML}${q(".settings-header")!.outerHTML}`);

  it("every page's nav and header, three whole dialogs and the gear, as the golden recorded before the settings plugin", async () => {
    await started();
    // dom.json was recorded from the 18-plugin list with three plugin pages; botling.deps (its settings page) and botling.pin-area
    // came into the shared fixture later, so this golden reads the list without them (the feed still holds every row it is given)
    const LATER = new Set(["botling.deps", "botling.pin-area"]);
    const full = fixtureView();
    const view: PluginsView = { ...full, plugins: full.plugins.filter((plugin) => !LATER.has(plugin.name)), settingsSections: (full.settingsSections ?? []).filter((row) => !LATER.has(row.plugin)) };
    expect(full.settingsSections!.map((row) => row.plugin)).toEqual(["botling.deps", "botling.git", "botling.usage", "zed.tools"]);
    expect(view.plugins).toHaveLength(18);
    reconcileView(view);
    const golden = JSON.parse(read("settings-slots", "dom.json")) as Record<string, string>;
    const pages = SETTINGS_GROUPS.flatMap((group) => group.pages.map((page) => page.id));
    const PLUGIN_PAGES = ["botling.git/botling.git.settings", "botling.usage/botling.usage.settings", "zed.tools/zed.tools.settings"] as const;
    // A page's nav shows the plugin pages once the feed holds their rows.
    await vi.waitFor(() => { expect(feedIds("view/settings.section")).toHaveLength(3); });
    const got: Record<string, string> = {};
    for (const id of [...pages, ...PLUGIN_PAGES]) { await mountSheet(view, id as SettingsSection); got[`page:${id}`] = navAndHeader(); }
    // the Plugins list and the gear's count were re-recorded with all 20 plugins (d26e08bc); the settings pages stay the three of the 18-plugin record
    const all: PluginsView = { ...full, settingsSections: view.settingsSections };
    for (const id of ["general", "botling.usage/botling.usage.settings", "plugins"] as const) { await mountSheet(id === "plugins" ? all : view, id as SettingsSection); got[`dialog:${id}`] = ids(q(".settings")!.outerHTML); }
    await act(async () => root.render(createElement(SidebarSettings, { client: client(), settings: settingsView({}), plugins: all, settingsOpen: false, onOpen() {} })));
    got["gear:closed"] = ids(q(".sidebar-settings")!.outerHTML);
    await act(async () => { (q('[aria-label="Quick settings"]') as HTMLButtonElement).click(); });
    await act(async () => { await Promise.resolve(); });
    got["gear:open"] = ids(q(".sidebar-settings-popover")!.outerHTML);
    for (const key of Object.keys(got)) expect(got[key], key).toBe(golden[key]);
    expect(Object.keys(got).length).toBe(Object.keys(golden).filter((key) => !key.startsWith("search:") && key !== "no-plugins" && key !== "gear:open-no-plugins").length);
  });
});
