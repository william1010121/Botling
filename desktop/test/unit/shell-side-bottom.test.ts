// @vitest-environment jsdom
// The right panel and the bottom panels as slots of the shell (M7-03c). The page's DOM with the terminal's bottom panel closed, open and
// hidden (test/fixtures/shell-side-bottom/*.html) was recorded from the code BEFORE the two regions moved out of App's legacy surface and
// stays byte-identical: with no plugin around, with botling.bot-panel loaded, and after it was unloaded and loaded again. The regions are
// contributions: the bottom panels are `:shell`'s to `app/bottom`, the right panel is botling.bot-panel's to `app/side` (a refusal of that
// contribution does not fail the plugin's load), each drawn where the legacy page puts its `<RegionSlot>` (no element of its own).
// A missing golden prints its text (SIDE-BOTTOM-GOLDEN-BEGIN … END) and fails; UPDATE_SIDE_BOTTOM_GOLDEN=1 writes it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotView, PluginsView } from "../../src/contract";
import { settingsView } from "../../src/core/settings";
import { App } from "../../src/renderer/App";
import type { Client } from "../../src/renderer/client";
import { WorkspaceStore, type WorkspaceView } from "../../src/renderer/store";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { Kernel } from "../../../Web/src/plugin-kernel";
import { BOT_PANEL_PLUGIN } from "../../src/renderer/panel-names";
import { botPanelDeclaration } from "../../src/renderer/plugins/bot-panel";
import { TOGGLE_BOTTOM_PANEL } from "../../src/renderer/BottomPanels";
import { rendererKernel, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { InPageHost, inPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { RegionSlot, REGION_SLOTS, type RegionEntry } from "../../src/renderer/shell/regions";
import { ShellFrame } from "../../src/renderer/shell/ShellFrame";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const shipped = manifest.plugins.find((entry) => entry.name === BOT_PANEL_PLUGIN)!;
const hosts: InPageHost[] = [];
/** A host that runs only botling.bot-panel on the renderer's kernel (the build ships others too). */
function botPanelHost(options: ConstructorParameters<typeof InPageHost>[0] = {}) {
  const made = new InPageHost({ manifest: { ...manifest, plugins: [shipped] }, ...options });
  hosts.push(made);
  return made;
}
const settled = () => vi.waitFor(() => { expect(rendererKernel.state(BOT_PANEL_PLUGIN)).toBe("absent"); });
/** What the page reads of the host: the page uses the renderer's own host, so a test host answers for it. */
const seenBy = (one: InPageHost) => vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => one.unavailable(name));
const regionEntries = (slot: string) => rendererKernel.entries<Partial<RegionEntry>>(slot).filter(({ entry }) => entry?.kind === "region");

const GOLDEN_DIR = join(desktop, "test", "fixtures", "shell-side-bottom");
const BOT = "B0000000-0000-4000-8000-000000000001";
const bot: BotView = { id: BOT, name: "Site", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const terminalPanel = { plugin: "botling.terminal", id: "botling.terminal.panel", title: "Terminal", toggle: "botling.terminal.toggle" };
const pluginsView = (): PluginsView => ({ plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, keybindings: [], bottomPanels: [terminalPanel] }) as unknown as PluginsView;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const one of hosts.splice(0)) await one.stop();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  localStorage.clear();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

/** Mounts App with the terminal's panel row; `.markup()` is the page's HTML with the document's counters written as `:rN:` / `/N`. */
async function mountPage(plugins: PluginsView | null = pluginsView()) {
  localStorage.setItem("botling.mainWhiteboard", "0");
  const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
  const view: WorkspaceView = { ...defaults, ready: true, bots: [bot], settings: settingsView({}), plugins, chat: { botId: BOT, messages: [], running: null, live: [] } };
  const store = { getView: () => view, getChatView: () => view, subscribe: () => () => {}, subscribeChat: () => () => {}, showBoard: () => {} } as unknown as WorkspaceStore;
  let pages = 0;
  const client = {
    request: vi.fn(async (command: any) => {
      if (command.type === "plugins.panel") return { title: command.name, source: "", settings: {} };
      if (command.type === "card.page") return { url: `botling-card://page/${++pages}` };
      if (command.type === "plugins.web") return { specs: [] };
      return { result: null };
    }),
    onEvent: () => () => {},
  } as unknown as Client;
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(App, { client, store })));
  const unmount = async () => { await act(async () => root.unmount()); element.remove(); };
  cleanups.push(unmount);
  return { element, client, unmount, markup: () => element.innerHTML.replace(/:r[0-9a-z]+:/g, ":rN:").replace(/botling-card:\/\/page\/\d+/g, "botling-card://page/N") };
}

function same(name: string, markup: string) {
  const text = `<!-- ${name} -->\n${markup}\n`;
  const file = join(GOLDEN_DIR, `${name}.html`);
  if (process.env.UPDATE_SIDE_BOTTOM_GOLDEN === "1") { mkdirSync(GOLDEN_DIR, { recursive: true }); writeFileSync(file, text); }
  if (!existsSync(file)) {
    console.log(`SIDE-BOTTOM-GOLDEN-BEGIN ${name}\n${text}SIDE-BOTTOM-GOLDEN-END ${name}`);
    throw new Error(`No golden ${file}`);
  }
  expect(text, `golden ${name}`).toBe(readFileSync(file, "utf8"));
}

const toggleButton = (element: HTMLElement) => element.querySelector<HTMLButtonElement>("button.bottom-toggle")!;
const openTerminal = async (page: Awaited<ReturnType<typeof mountPage>>) => {
  await act(async () => { toggleButton(page.element).click(); });
  await vi.waitFor(() => expect(page.element.querySelector('[data-plugin="botling.terminal"] iframe.bottom-panel-frame')).not.toBeNull());
};

describe("the app page's DOM with the terminal panel, as recorded before the regions moved", () => {
  it("terminal panel closed: the header's toggle, the right panel, no panel section", async () => {
    const page = await mountPage();
    expect(toggleButton(page.element).getAttribute("aria-expanded")).toBe("false");
    expect(page.element.querySelector("section.bottom-panel")).toBeNull();
    expect(page.element.querySelector("aside.detail-panel")).not.toBeNull();
    same("terminal-closed", page.markup());
  });
  it("terminal panel open: the section under the chat with its divider and frame", async () => {
    const page = await mountPage();
    await openTerminal(page);
    const section = page.element.querySelector<HTMLElement>("section.bottom-panel")!;
    expect(section.hidden).toBe(false);
    expect(toggleButton(page.element).getAttribute("aria-expanded")).toBe("true");
    same("terminal-open", page.markup());
  });
  it("terminal panel opened and hidden again: the section stays mounted but hidden", async () => {
    const page = await mountPage();
    await openTerminal(page);
    await act(async () => { toggleButton(page.element).click(); });
    expect(page.element.querySelector<HTMLElement>("section.bottom-panel")!.hidden).toBe(true);
    same("terminal-hidden", page.markup());
  });
  it("no plugins view: no toggle, no panel (the right panel is still drawn)", async () => {
    const page = await mountPage(null);
    expect(page.element.querySelector("button.bottom-toggle")).toBeNull();
    same("no-plugins", page.markup());
  });
});

// ---------------------------------------------------------------- the regions are contributions
describe("the regions as contributions", () => {
  it("the bottom region is a contribution of :shell to app/bottom while the page is up (found under view/bottomPanel too), one for one page, and it goes with the page", async () => {
    expect(regionEntries("app/bottom")).toHaveLength(0);
    const page = await mountPage();
    const held = regionEntries("app/bottom");
    expect(held).toHaveLength(1);
    expect(held[0]!.plugin).toBe(SHELL_SURFACE);
    expect(held[0]!.entry).toMatchObject({ kind: "region", region: "bottom" });
    expect(regionEntries("view/bottomPanel")).toHaveLength(1);
    await page.unmount();
    expect(regionEntries("app/bottom")).toHaveLength(0);
  });

  it("the side region is botling.bot-panel's contribution to app/side: declared, there once the plugin is up, gone with it, back when it is back", async () => {
    expect(botPanelDeclaration.contributes?.slots).toEqual([REGION_SLOTS.side]);
    expect(REGION_SLOTS).toEqual({ side: "app/side", bottom: "app/bottom" });
    expect(regionEntries("app/side")).toHaveLength(0);
    const one = botPanelHost();
    await one.start();
    const held = regionEntries("app/side");
    expect(held).toHaveLength(1);
    expect(held[0]!.plugin).toBe(BOT_PANEL_PLUGIN);
    expect(held[0]!.entry).toEqual({ kind: "region", region: "side" });
    one.unload(BOT_PANEL_PLUGIN);
    await settled();
    expect(regionEntries("app/side")).toHaveLength(0);
    await one.start();
    expect(regionEntries("app/side")).toHaveLength(1);
  });

  it("the plugin still loads where nobody owns app/side (a kernel without :shell): the refusal is the kernel's, not a failed load, and the plugin's own slots are there", async () => {
    const kernel = new Kernel();
    const private_ = botPanelHost({ kernel, feed: { refresh: () => [] }, notify() {} });
    const [result] = await private_.start();
    expect(result!.status).toBe("loaded");
    expect(kernel.state(BOT_PANEL_PLUGIN)).toBe("active");
    expect(kernel.entries("app/side")).toEqual([]);
    expect(kernel.entries("panel/main").length).toBe(3);
    await private_.stop();
  });

  it("another plugin cannot take the side region: a contribution from a plugin that does not declare app/side is refused", async () => {
    const one = botPanelHost();
    await one.start();
    rendererKernel.install({ name: "x.intruder" });
    await rendererKernel.load("x.intruder", (plugin) => { rendererKernel.contribute(plugin, "app/side", { kind: "region", region: "side" } satisfies RegionEntry); });
    expect(regionEntries("app/side").map(({ plugin }) => plugin)).toEqual([BOT_PANEL_PLUGIN]);
    await rendererKernel.requestUnload("x.intruder");
    rendererKernel.uninstall("x.intruder");
  });
});

// ---------------------------------------------------------------- ShellFrame and RegionSlot
describe("ShellFrame and RegionSlot", () => {
  const frame = (props: Record<string, unknown>) => createElement(ShellFrame, props as never);
  async function mountFrame(element: ReturnType<typeof createElement>) {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(element));
    cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
    return host;
  }

  it("draws a region where the legacy page puts its slot, with no element of its own, and nowhere else (the root slots do not draw it a second time)", async () => {
    const host = await mountFrame(frame({
      regions: { bottom: createElement("i", { id: "b" }), side: createElement("i", { id: "s" }) },
      legacy: createElement("div", { id: "page" }, createElement("p", null, "chat"), createElement(RegionSlot, { region: "bottom" })),
    }));
    expect(host.innerHTML).toBe('<div id="page"><p>chat</p><i id="b"></i></div>');
  });

  it("a region the page does not supply draws nothing; a page that places no slot draws no region", async () => {
    const empty = await mountFrame(frame({ legacy: createElement("div", { id: "page" }, createElement(RegionSlot, { region: "bottom" })) }));
    expect(empty.innerHTML).toBe('<div id="page"></div>');
    const unplaced = await mountFrame(frame({ regions: { bottom: createElement("i", { id: "b2" }) }, legacy: createElement("div", { id: "page2" }) }));
    expect(unplaced.innerHTML).toBe('<div id="page2"></div>');
  });

  it("two frames in one document each draw their own bottom region", async () => {
    const a = await mountFrame(frame({ regions: { bottom: createElement("i", { id: "a" }) }, legacy: createElement("div", null, createElement(RegionSlot, { region: "bottom" })) }));
    const b = await mountFrame(frame({ regions: { bottom: createElement("i", { id: "b" }) }, legacy: createElement("div", null, createElement(RegionSlot, { region: "bottom" })) }));
    expect(a.innerHTML).toBe('<div><i id="a"></i></div>');
    expect(b.innerHTML).toBe('<div><i id="b"></i></div>');
  });

  it("a region the page re-supplies is drawn fresh on each render of the page (the page's own state reaches it)", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const show = (text: string) => frame({ regions: { bottom: createElement("i", null, text) }, legacy: createElement("div", null, createElement(RegionSlot, { region: "bottom" })) });
    await act(async () => root.render(show("one")));
    await act(async () => root.render(show("two")));
    expect(host.innerHTML).toBe("<div><i>two</i></div>");
    await act(async () => root.unmount());
    host.remove();
  });

  it("when the kernel did not take the page, the regions are drawn directly rather than not at all", async () => {
    vi.spyOn(rendererKernel, "contribute").mockReturnValue(null);
    const host = await mountFrame(frame({ regions: { bottom: createElement("i", { id: "d" }) }, legacy: createElement("div", null, createElement(RegionSlot, { region: "bottom" })) }));
    expect(host.innerHTML).toBe('<div><i id="d"></i></div>');
  });

  it("the side region needs botling.bot-panel's contribution while the plugin is up, and is drawn while the plugin is not (its own data, or the shell's unavailable line)", async () => {
    const side = frame({ regions: { side: createElement("i", { id: "side" }) }, legacy: createElement("div", null, createElement(RegionSlot, { region: "side" })) });
    const never = await mountFrame(side);
    expect(never.querySelector("#side")).not.toBeNull();
    const one = botPanelHost();
    await one.start();
    await act(async () => {});
    expect(never.querySelector("#side")).not.toBeNull();
    const [held] = regionEntries("app/side");
    await act(async () => { await held!.registration.dispose(); });
    expect(never.querySelector("#side"), "active but not claiming it").toBeNull();
    one.unload(BOT_PANEL_PLUGIN);
    await settled();
    await act(async () => {});
    expect(never.querySelector("#side")).not.toBeNull();
  });
});

// ---------------------------------------------------------------- the page
describe("the app page with the regions drawn from the slots", () => {
  it("is the recorded DOM with botling.bot-panel loaded (closed, open, hidden), and again after it was unloaded and loaded again", async () => {
    const one = botPanelHost();
    await one.start();
    seenBy(one);
    const page = await mountPage();
    same("terminal-closed", page.markup());
    await openTerminal(page);
    same("terminal-open", page.markup());
    await act(async () => { toggleButton(page.element).click(); });
    same("terminal-hidden", page.markup());
    one.unload(BOT_PANEL_PLUGIN);
    await settled();
    await act(async () => {});
    expect(page.element.querySelector(".panel-unavailable")?.textContent).toBe("The panel is unavailable.");
    expect(page.element.querySelector("section.bottom-panel"), "the bottom panels are not the plugin's").not.toBeNull();
    await one.start();
    await act(async () => {});
    same("terminal-hidden", page.markup());
  });

  it("draws the right panel from app/side: with the plugin up and its registration taken back, the column is gone and the chat and the bottom toggle stay", async () => {
    const one = botPanelHost();
    await one.start();
    seenBy(one);
    const page = await mountPage();
    expect(page.element.querySelectorAll("aside.detail-panel")).toHaveLength(1);
    const [held] = regionEntries("app/side");
    await act(async () => { await held!.registration.dispose(); });
    expect(page.element.querySelector("aside.detail-panel")).toBeNull();
    expect(page.element.querySelector("aside.right-strip")).toBeNull();
    expect(page.element.querySelector("#chat-frame")).not.toBeNull();
    expect(toggleButton(page.element)).not.toBeNull();
    await one.start().catch(() => {});
  });

  it("draws the bottom panels from app/bottom: with :shell's registration taken back, no toggle and no panel; the chat stays and the right panel stays", async () => {
    const page = await mountPage();
    await openTerminal(page);
    const [held] = regionEntries("app/bottom");
    await act(async () => { await held!.registration.dispose(); });
    expect(page.element.querySelector("button.bottom-toggle")).toBeNull();
    expect(page.element.querySelector("section.bottom-panel")).toBeNull();
    expect(page.element.querySelector("#chat-frame")).not.toBeNull();
    expect(page.element.querySelectorAll("aside.detail-panel")).toHaveLength(1);
  });

  it("the chat header's toggle shows and hides the panel, and so does the plugin's toggle command (the page-wide signal)", async () => {
    const page = await mountPage();
    await openTerminal(page);
    const section = () => page.element.querySelector<HTMLElement>("section.bottom-panel")!;
    expect(section().hidden).toBe(false);
    await act(async () => { toggleButton(page.element).click(); });
    expect(section().hidden).toBe(true);
    expect(toggleButton(page.element).getAttribute("aria-expanded")).toBe("false");
    await act(async () => { window.dispatchEvent(new CustomEvent(TOGGLE_BOTTOM_PANEL, { detail: "botling.terminal.toggle" })); });
    expect(section().hidden).toBe(false);
    await act(async () => { window.dispatchEvent(new CustomEvent(TOGGLE_BOTTOM_PANEL, { detail: "botling.terminal.toggle" })); });
    expect(section().hidden).toBe(true);
    await act(async () => { window.dispatchEvent(new CustomEvent(TOGGLE_BOTTOM_PANEL, { detail: "someone.else" })); });
    expect(section().hidden).toBe(true);
  });

  it("keeps the opened panel's frame (same element) while the page redraws, and the column dividers are the page's own", async () => {
    const page = await mountPage();
    await openTerminal(page);
    const frame = page.element.querySelector("iframe.bottom-panel-frame");
    const dividers = page.element.querySelectorAll('[role="separator"]').length;
    expect(dividers).toBeGreaterThanOrEqual(2); // the rail's, the panel's own height divider (column-resize.ts is not touched)
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(page.element.querySelector("iframe.bottom-panel-frame")).toBe(frame);
  });
});
