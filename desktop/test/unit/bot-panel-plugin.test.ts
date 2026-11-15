// @vitest-environment jsdom
// `botling.bot-panel`, the second in-page built-in plugin (M7-03a): it owns `panel/main`, `panel/section` and `panel/takeover` (2.x
// `view/rightPanel`, `view/rightPanel.section`, `view/rightPanel.takeover`: the kernel's canonical id is still the 2.x one, so the
// tests ask by either name) and registers the right panel's overview blocks (waiting list, results, settled) in `panel/main`.
//
// DOM goldens (test/fixtures/bot-panel/*.html) were recorded from the code BEFORE the blocks moved: the panel for a main bot, a project
// bot, the folded strip and a takeover. They must stay byte-identical whether the page has no shell around (a component test), or the
// plugin is loaded, or it was unloaded and loaded again. With the plugin away the shell's "panel unavailable" line replaces the
// plugin's part and the chat stays.
// A missing golden prints its text (BOT-PANEL-GOLDEN-BEGIN … END) and fails; UPDATE_BOT_PANEL_GOLDEN=1 writes it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSlot } from "../../../Web/src/plugin-kernel";
import type { BotView, PluginsView, ResultView, SubagentRowView, WaitingItemView } from "../../src/contract";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { settingsView } from "../../src/core/settings";
import { App } from "../../src/renderer/App";
import type { Client } from "../../src/renderer/client";
import { rightPanelSectionsFor } from "../../src/renderer/main-tabs";
import { BOT_PANEL_PLUGIN, MAIN_SLOT, SECTION_SLOT, TAKEOVER_SLOT, PANEL_BLOCKS } from "../../src/renderer/panel-names";
import { panelState, registeredPanelBlocks } from "../../src/renderer/panel-slot";
import { botPanelDeclaration } from "../../src/renderer/plugins/bot-panel";
import { notifySlots, rendererKernel, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { RightPanel, type RightPanelProps } from "../../src/renderer/RightPanel";
import { FEED_SLOTS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { InPageHost, inPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { pluginFeed, reconcileView } from "../../src/renderer/shell/plugin-feed";
import { WorkspaceStore, type WorkspaceView } from "../../src/renderer/store";
import { TakeoverPage } from "../../src/renderer/TakeoverPage";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const shipped = manifest.plugins.find((entry) => entry.name === BOT_PANEL_PLUGIN)!;
const GOLDEN_DIR = join(desktop, "test", "fixtures", "bot-panel");
const SECTION = "view/rightPanel.section";
const TAKEOVER = "view/rightPanel.takeover";
const MAIN = "view/rightPanel";
const UNAVAILABLE = "The panel is unavailable.";

const lines: string[] = [];
const hosts: InPageHost[] = [];
const cleanups: (() => Promise<void>)[] = [];
/** A host that runs only this plugin (the build ships others too; these tests are about this one). */
function host(options: ConstructorParameters<typeof InPageHost>[0] = {}) {
  const made = new InPageHost({ manifest: { ...manifest, plugins: [shipped] }, log: (line) => lines.push(line), ...options });
  hosts.push(made);
  return made;
}
const settled = () => vi.waitFor(() => { expect(rendererKernel.state(BOT_PANEL_PLUGIN)).toBe("absent"); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
  lines.length = 0;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  localStorage.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

/** What the page's surfaces see of the host: the page reads the renderer's own host, so a test host answers for it. */
const seenBy = (one: InPageHost) => vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => one.unavailable(name));

// ---------------------------------------------------------------- fixtures
const settledRow = (n: number): SubagentRowView => ({ id: `w${n}`, title: `Worker ${n}`, status: n === 2 ? "running" : "completed", head: "claude", startedAt: 1_000 + n, endedAt: n === 2 ? null : 2_000 + n, unsettledAt: null, settled: true, prompt: `Do job ${n}` });
const mainBot = { id: "main", name: "Main bot", role: "main", heads: ["claude"], phase: "awake", working: false, approvals: 0, unread: 0, avatar: "robot", subagentRows: [1, 2, 3, 4, 5, 6, 7].map(settledRow) } as unknown as BotView;
const projectBot = { id: "site", name: "Site", role: "manager", heads: ["claude"], phase: "awake", working: true, approvals: 0, unread: 0, avatar: "square", subagentRows: [settledRow(1)] } as unknown as BotView;
const subBot = { id: "sub", name: "Sub", role: "project", parent: "site", heads: ["claude"], phase: "awake", working: false, approvals: 0, unread: 0, avatar: "square", subagentRows: [] } as unknown as BotView;
const waitingItems: WaitingItemView[] = [
  { botId: "site", text: "Pick a color", messageId: "m1" },
  { botId: "ghost", text: "Memory: ship it?", messageId: null },
];
const results: ResultView[] = [
  { label: "Report", url: "https://example.com/r" }, { label: "Artifact", url: "https://claude.ai/artifact/abc" },
  { label: "Notes", url: "https://example.com/n" }, { label: "Fourth", url: "https://example.com/4" },
];
const fixturePlugins = (): PluginsView => JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView;

function props(bot: BotView, over: Partial<RightPanelProps> = {}): RightPanelProps {
  return {
    bot, bots: [mainBot, projectBot], waiting: { items: waitingItems, doing: { site: "Building the pages" } }, look: "original", status: { key: "working", text: "Working" },
    results, watching: null, collapsed: false, onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {}, onSettings() {}, onExpand() {},
    pluginSections: createElement("section", { className: "detail-section plugin-block" }, "Worktrees"),
    ...over,
  };
}

async function mount(element: ReturnType<typeof createElement>) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const element_ = document.createElement("div");
  document.body.append(element_);
  const root = createRoot(element_);
  await act(async () => root.render(element));
  const unmount = async () => { await act(async () => root.unmount()); element_.remove(); };
  cleanups.push(unmount);
  return { element: element_, root, rerender: (next: ReturnType<typeof createElement>) => act(async () => root.render(next)), unmount };
}

function same(name: string, markup: string) {
  const text = `<!-- ${name} -->\n${markup.replace(/:r[0-9a-z]+:/g, ":rN:")}\n`;
  const file = join(GOLDEN_DIR, `${name}.html`);
  if (process.env.UPDATE_BOT_PANEL_GOLDEN === "1") { mkdirSync(GOLDEN_DIR, { recursive: true }); writeFileSync(file, text); }
  if (!existsSync(file)) {
    console.log(`BOT-PANEL-GOLDEN-BEGIN ${name}\n${text}BOT-PANEL-GOLDEN-END ${name}`);
    throw new Error(`No golden ${file}`);
  }
  expect(text, `golden ${name}`).toBe(readFileSync(file, "utf8"));
}
const panelMarkup = async (element: ReturnType<typeof createElement>) => { const view = await mount(element); const markup = view.element.innerHTML; await view.unmount(); return markup; };

const client = { request: vi.fn(async (command: any) => (command.type === "plugins.web" ? { specs: [] } : { result: null })), onEvent: () => () => {} } as unknown as Client;
const takeoverElement = () => createElement(TakeoverPage, { client, plugin: "botling.component-studio", view: "botling.component-studio.spec", title: "Component spec", botId: "main", wide: true, plugins: null, onError() {}, onAsk() {} });

// ---------------------------------------------------------------- the goldens (no shell around: the page as a component test draws it)
describe("the right panel's DOM, as recorded before the blocks moved", () => {
  it("main bot, open: Now, plugin block, Waiting on you, Just done (three of four), Settled (five of seven, Show 2 more)", async () => {
    const markup = await panelMarkup(createElement(RightPanel, props(mainBot)));
    expect(markup).toContain("Waiting on you");
    expect(markup).toContain("Just done");
    expect(markup).toContain("Show 2 more");
    same("main-open", markup);
  });
  it("project bot, open: no waiting list (it is the main bot's), 'Results', what it is doing, Settled", async () => {
    const markup = await panelMarkup(createElement(RightPanel, props(projectBot)));
    expect(markup).not.toContain("Waiting on you");
    expect(markup).toContain("Building the pages");
    same("project-open", markup);
  });
  it("main bot, folded: the face and an icon with a count per block, the bot's settings", async () => {
    same("main-folded", await panelMarkup(createElement(RightPanel, props(mainBot, { collapsed: true }))));
  });
  it("main bot, folded, Waiting on you opened beside the strip", async () => {
    const view = await mount(createElement(RightPanel, props(mainBot, { collapsed: true })));
    await act(async () => view.element.querySelector<HTMLButtonElement>('[data-section="waiting"]')!.click());
    expect(view.element.querySelector(".strip-flyout")).not.toBeNull();
    same("main-folded-waiting", view.element.innerHTML);
  });
  it("a takeover: the page of a plugin's view in the panel's place", async () => {
    same("takeover", await panelMarkup(takeoverElement()));
  });
});

// ---------------------------------------------------------------- forRole, unchanged
describe("which plugin blocks a bot gets (forRole)", () => {
  const view = { rightPanelSections: [
    { plugin: "a", id: "a.any", title: "A", forRole: "any" }, { plugin: "b", id: "b.main", title: "B", forRole: "main" },
    { plugin: "c", id: "c.project", title: "C", forRole: "project" }, { plugin: "d", id: "d.bots", title: "D", forRole: "bots" },
  ] } as unknown as PluginsView;
  const ids = (bot: BotView) => rightPanelSectionsFor(view, bot).map((section) => section.id);
  it("main: any and main; a project bot (manager): any, project and bots; a sub bot (has a parent): the same", () => {
    expect(ids(mainBot)).toEqual(["a.any", "b.main"]);
    expect(ids(projectBot)).toEqual(["a.any", "c.project", "d.bots"]);
    expect(ids(subBot)).toEqual(["a.any", "c.project", "d.bots"]);
  });
});

// ---------------------------------------------------------------- the plugin
describe("the bot-panel plugin as the FE build ships it", () => {
  it("is a folder of the build: the manifest lists botling.bot-panel with its folder's hash, and the loader runs the bundled module", async () => {
    expect(shipped?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const one = host();
    const [result] = await one.start();
    expect(result).toEqual({ status: "loaded", name: BOT_PANEL_PLUGIN, codeHash: shipped.codeHash });
    expect(rendererKernel.state(BOT_PANEL_PLUGIN)).toBe("active");
    expect(lines).toEqual([]);
  });

  it("owns panel/main, panel/section and panel/takeover (the kernel finds them under both names), and :shell does not", async () => {
    await host().start();
    for (const [legacy, name] of [[MAIN, MAIN_SLOT], [SECTION, SECTION_SLOT], [TAKEOVER, TAKEOVER_SLOT]] as const) {
      expect(rendererKernel.slotOwner(legacy), legacy).toBe(BOT_PANEL_PLUGIN);
      expect(rendererKernel.slotOwner(name), name).toBe(BOT_PANEL_PLUGIN);
      expect(canonicalSlot(name)).toBe(legacy);
      expect(rendererKernel.declaration(SHELL_SURFACE)?.provides?.slots, legacy).not.toContain(legacy);
      expect(PLUGIN_OWNED_SLOTS, legacy).toContain(legacy);
      expect(FEED_SLOTS, legacy).not.toContain(legacy);
    }
    expect(botPanelDeclaration.provides?.slots?.map(canonicalSlot).sort()).toEqual([MAIN, SECTION, TAKEOVER].sort());
    expect(rendererKernel.declaration(BOT_PANEL_PLUGIN)?.provides?.slots?.slice().sort()).toEqual([MAIN, SECTION, TAKEOVER].sort());
  });

  it("registers the three overview blocks in panel/main, one registration each, in the panel's order, and nothing in the other two slots", async () => {
    await host().start();
    expect(rendererKernel.entries<{ kind: string; block: string }>(MAIN).map(({ plugin, entry }) => [plugin, entry.kind, entry.block])).toEqual([
      [BOT_PANEL_PLUGIN, "panel-block", "waiting"], [BOT_PANEL_PLUGIN, "panel-block", "results"], [BOT_PANEL_PLUGIN, "panel-block", "settled"],
    ]);
    expect(PANEL_BLOCKS).toEqual(["waiting", "results", "settled"]);
    expect(rendererKernel.allContributions().filter(({ plugin }) => plugin === BOT_PANEL_PLUGIN)).toHaveLength(3);
    expect(registeredPanelBlocks()).toEqual(["waiting", "results", "settled"]);
    expect(rendererKernel.entries(SECTION)).toEqual([]);
    expect(rendererKernel.entries(TAKEOVER)).toEqual([]);
  });

  it("takes a block only from the bot-panel plugin: another plugin's {kind: panel-block} entry is not a block", async () => {
    await host().start();
    // The plugin's own `results` block is taken back, then another plugin contributes one with the same shape.
    await rendererKernel.entries<{ block: string }>(MAIN).find(({ entry }) => entry.block === "results")!.registration.dispose();
    rendererKernel.install({ name: "evil.plugin", contributes: { slots: [MAIN] } });
    await rendererKernel.load("evil.plugin", (plugin) => { rendererKernel.contribute(plugin, MAIN, { kind: "panel-block", block: "results" }); });
    expect(rendererKernel.entries(MAIN).filter(({ plugin }) => plugin === "evil.plugin")).toHaveLength(1);
    expect(registeredPanelBlocks()).toEqual(["waiting", "settled"]);
    await rendererKernel.requestUnload("evil.plugin");
    rendererKernel.uninstall("evil.plugin");
  });

  it("drops a block whose registration is taken back", async () => {
    await host().start();
    const results_ = rendererKernel.entries<{ block: string }>(MAIN).find(({ entry }) => entry.block === "results")!;
    await results_.registration.dispose();
    expect(registeredPanelBlocks()).toEqual(["waiting", "settled"]);
  });
});

describe("plugin blocks and takeovers in the plugin's slots", () => {
  it("rightPanel.section and rightPanel.takeover views land in panel/section and panel/takeover once the owner is up (the feed asks again), and go with it", async () => {
    const view = fixturePlugins();
    reconcileView(view);
    // No owner yet: the kernel refused them.
    expect(pluginFeed.rows(SECTION)).toEqual([]);
    expect(pluginFeed.rows(TAKEOVER)).toEqual([]);
    const one = host();
    await one.start();
    expect(pluginFeed.rows(SECTION)).toEqual(view.rightPanelSections);
    expect(pluginFeed.rows(TAKEOVER)).toEqual(view.takeovers);
    expect(pluginFeed.rows("panel/section")).toEqual(view.rightPanelSections);
    expect(rendererKernel.entries(SECTION).map(({ plugin }) => plugin)).toEqual(view.rightPanelSections!.map((row) => row.plugin));
    expect(one.unload(BOT_PANEL_PLUGIN)).toBe(true);
    await settled();
    expect(pluginFeed.rows(SECTION)).toEqual([]);
    expect(pluginFeed.rows(TAKEOVER)).toEqual([]);
    // Their other rows stay.
    expect(pluginFeed.rows("view/mainTab")).toEqual(view.mainTabs);
    await one.start();
    expect(pluginFeed.rows(SECTION)).toEqual(view.rightPanelSections);
    expect(pluginFeed.rows(TAKEOVER)).toEqual(view.takeovers);
  });
});

describe("panelState: where the panel gets its blocks", () => {
  it("the plugin is up: the slot's blocks; refused, failed or unloaded: none and unavailable; never touched by a host: the plugin's own data", async () => {
    const never = new InPageHost({ manifest: { ...manifest, plugins: [shipped] } });
    expect(panelState(rendererKernel, never)).toEqual({ blocks: ["waiting", "results", "settled"], unavailable: false });
    const one = host();
    await one.start();
    expect(panelState(rendererKernel, one)).toEqual({ blocks: ["waiting", "results", "settled"], unavailable: false });
    one.unload(BOT_PANEL_PLUGIN);
    await settled();
    expect(panelState(rendererKernel, one)).toEqual({ blocks: [], unavailable: true });
    const refused = host({ manifest: { ...manifest, plugins: [] } });
    await refused.start([{ name: BOT_PANEL_PLUGIN, codeHash: shipped.codeHash }]);
    expect(panelState(rendererKernel, refused)).toEqual({ blocks: [], unavailable: true });
  });

  it("is unavailable as soon as the host says so, even while the registrations are still being taken back (fail closed)", async () => {
    const one = host();
    await one.start();
    one.unload(BOT_PANEL_PLUGIN);
    expect(panelState(rendererKernel, one).unavailable).toBe(true);
    await settled();
  });
});

describe("the panel drawn with the plugin loaded", () => {
  it("is the recorded DOM, for the main bot, the project bot and the folded strip", async () => {
    const one = host();
    await one.start();
    seenBy(one);
    same("main-open", await panelMarkup(createElement(RightPanel, props(mainBot))));
    same("project-open", await panelMarkup(createElement(RightPanel, props(projectBot))));
    same("main-folded", await panelMarkup(createElement(RightPanel, props(mainBot, { collapsed: true }))));
    same("takeover", await panelMarkup(takeoverElement()));
  });

  it("unloading botling.bot-panel replaces its blocks with the shell's 'panel unavailable' line (Now card and head stay); reloading restores the same DOM", async () => {
    const one = host();
    await one.start();
    seenBy(one);
    const view = await mount(createElement(RightPanel, props(mainBot)));
    const before = view.element.innerHTML;
    same("main-open", before);
    expect(view.element.querySelector(".panel-unavailable")).toBeNull();
    one.unload(BOT_PANEL_PLUGIN);
    await settled();
    await act(async () => {});
    const note = view.element.querySelector(".panel-unavailable");
    expect(note?.textContent).toBe(UNAVAILABLE);
    expect(note?.getAttribute("role")).toBe("status");
    expect(view.element.querySelector(".detail-head")).not.toBeNull();
    expect(view.element.querySelector(".now-section")).not.toBeNull();
    for (const gone of [".waiting-list", ".results-section", ".settled-section", ".plugin-block"]) expect(view.element.querySelector(gone), gone).toBeNull();
    await one.start();
    await act(async () => {});
    expect(view.element.innerHTML).toBe(before);
  });

  it("the folded strip loses its section icons (and says why) while the plugin is away", async () => {
    const one = host();
    seenBy(one);
    await one.start();
    const view = await mount(createElement(RightPanel, props(mainBot, { collapsed: true })));
    expect(view.element.querySelectorAll(".strip-icon")).toHaveLength(3);
    one.unload(BOT_PANEL_PLUGIN);
    await settled();
    await act(async () => {});
    expect(view.element.querySelectorAll(".strip-icon")).toHaveLength(0);
    expect(view.element.querySelector(".strip-unavailable")?.getAttribute("aria-label")).toBe(UNAVAILABLE);
    expect(view.element.querySelector(".strip-face")).not.toBeNull();
    expect(view.element.querySelector(".strip-settings")).not.toBeNull();
  });

  it("draws only the blocks the plugin has registered: take the results block back and it is gone from the overview and from the strip (the others stay)", async () => {
    const one = host();
    seenBy(one);
    await one.start();
    const open = await mount(createElement(RightPanel, props(mainBot)));
    const folded = await mount(createElement(RightPanel, props(mainBot, { collapsed: true })));
    expect(open.element.querySelector(".results-section")).not.toBeNull();
    await rendererKernel.entries<{ block: string }>(MAIN).find(({ entry }) => entry.block === "results")!.registration.dispose();
    // An owner taking one registration back early is not a kernel step (no log line): tell the page's listeners as the host does after its own changes.
    await act(async () => { notifySlots(); });
    expect(open.element.querySelector(".results-section")).toBeNull();
    expect([...open.element.querySelectorAll(".detail-section h3")].map((h) => h.textContent)).toEqual(["Now", "Waiting on you", "Settled"]);
    expect([...folded.element.querySelectorAll(".strip-icon")].map((icon) => icon.getAttribute("data-section"))).toEqual(["waiting", "settled"]);
    expect(open.element.querySelector(".panel-unavailable")).toBeNull();
  });

  it("a takeover shows the line, and no frame, while the plugin is away; the frame is back when it returns", async () => {
    const one = host();
    seenBy(one);
    await one.start();
    const view = await mount(takeoverElement());
    expect(view.element.querySelector("iframe.takeover-frame")).not.toBeNull();
    one.unload(BOT_PANEL_PLUGIN);
    await settled();
    await act(async () => {});
    expect(view.element.querySelector("iframe")).toBeNull();
    expect(view.element.querySelector(".takeover-panel .panel-unavailable")?.textContent).toBe(UNAVAILABLE);
    expect(view.element.querySelector(".takeover-panel")?.getAttribute("aria-label")).toBe("Component spec");
    await one.start();
    await act(async () => {});
    expect(view.element.querySelector("iframe.takeover-frame")).not.toBeNull();
    expect(view.element.querySelector(".panel-unavailable")).toBeNull();
  });

  it("the settings of the bot (Back, name, page) are the shell's: they show with the plugin away", async () => {
    const one = host();
    seenBy(one);
    await one.start();
    one.unload(BOT_PANEL_PLUGIN);
    await settled();
    const view = await mount(createElement(RightPanel, props(mainBot, { showingSettings: true, settingsPage: createElement("div", { className: "the-page" }, "engines") })));
    expect(view.element.querySelector(".panel-settings .the-page")).not.toBeNull();
    expect(view.element.querySelector(".panel-unavailable")).toBeNull();
  });
});

describe("the whole page with the plugin away", () => {
  it("keeps the chat usable and shows the line in the right panel", async () => {
    const one = host({ manifest: { ...manifest, plugins: [] } });
    await one.start([{ name: BOT_PANEL_PLUGIN, codeHash: shipped.codeHash }]); // refused: not in that manifest
    expect(one.unavailable(BOT_PANEL_PLUGIN)).toBe(true);
    seenBy(one);
    localStorage.setItem("botling.mainWhiteboard", "0");
    const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
    const bot = { ...projectBot, id: "B0000000-0000-4000-8000-000000000001" } as BotView;
    const view: WorkspaceView = { ...defaults, ready: true, bots: [bot], settings: settingsView({}), plugins: fixturePlugins(), chat: { botId: bot.id, messages: [], running: null, live: [] } };
    const store = { getView: () => view, getChatView: () => view, subscribe: () => () => {}, subscribeChat: () => () => {}, showBoard: () => {} } as unknown as WorkspaceStore;
    const page = await mount(createElement(App, { client, store }));
    expect(page.element.querySelector("#chat-frame")).not.toBeNull();
    expect(page.element.querySelector(".detail-panel .panel-unavailable")?.textContent).toBe(UNAVAILABLE);
    expect(page.element.querySelector(".detail-panel .now-section")).not.toBeNull();
  });
});
