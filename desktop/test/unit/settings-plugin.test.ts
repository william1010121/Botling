// @vitest-environment jsdom
// `botling.settings`, the first in-page built-in plugin (M7-02c): loaded by the trusted loader (M7-10a) from the folder the FE build
// shipped, it owns `settings/section` and `settings/quick` in the renderer's real kernel and registers the core Settings pages there.
// The slot's canonical id is still the 2.x one (`view/settings.section`), so these tests ask by either name and compare ids with
// `canonicalSlot` / `slotName`. The golden is the output of the code before the pages moved (git show HEAD~ settings-pages.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSlot, slotName } from "../../../Web/src/plugin-kernel";
import type { PluginsView } from "../../src/contract";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { SettingsSheet } from "../../src/renderer/Settings";
import type { Client } from "../../src/renderer/client";
import { SETTINGS_PLUGIN } from "../../src/renderer/settings-names";
import { SETTINGS_GROUPS, settingsNav } from "../../src/renderer/settings-pages";
import { coreSettings, registeredCoreGroups } from "../../src/renderer/settings-slot";
import { rendererKernel, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { settingsDeclaration } from "../../src/renderer/plugins/settings";
import { FEED_SLOTS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { InPageHost, inPageHost, type InPageApi } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest, type InPageSource } from "../../src/renderer/shell/inpage-loader";
import { ShellFrame } from "../../src/renderer/shell/ShellFrame";
import { pluginFeed, reconcileView } from "../../src/renderer/shell/plugin-feed";
import { desktop } from "../helpers";
import { loadSettingsShell } from "../settings-shell";

const SECTION = "view/settings.section";
const QUICK = "view/quickSettings";
const built = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const shipped = built.plugins.find((entry) => entry.name === SETTINGS_PLUGIN)!;
// Only this plugin's entry: the build ships other in-page plugins too (botling.bot-panel, …), and these tests are about this one.
const manifest = { ...built, plugins: [shipped] };
const golden = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "settings-nav-golden.json"), "utf8")) as { all: unknown; phone: unknown; none: unknown };
const fixture = (): PluginsView => JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView;

// M7-06a: the build ships a second plugin (botling.chat); these tests are about the settings plugin, so their hosts run only that one.
const settingsOnly = { plugins: manifest.plugins.filter((entry) => entry.name === SETTINGS_PLUGIN) };
const lines: string[] = [];
const hosts: InPageHost[] = [];
function host(options: ConstructorParameters<typeof InPageHost>[0] = {}) {
  const made = new InPageHost({ manifest: settingsOnly, log: (line) => lines.push(line), ...options });
  hosts.push(made);
  return made;
}
const settled = () => vi.waitFor(() => { expect(rendererKernel.state(SETTINGS_PLUGIN)).toBe("absent"); });
afterEach(async () => {
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
  lines.length = 0;
  vi.restoreAllMocks();
});

const coreEntries = () => rendererKernel.entries<{ kind: string; page?: { id: string } }>(SECTION).filter(({ plugin }) => plugin === SETTINGS_PLUGIN);
const pageIds = () => coreEntries().map(({ entry }) => entry.page?.id);
const allPageIds = SETTINGS_GROUPS.flatMap((group) => group.pages.map((page) => page.id));

describe("the settings plugin as the FE build ships it", () => {
  it("is a folder of the build: the manifest lists botling.settings with its folder's hash, and the loader runs the bundled module", async () => {
    expect(shipped?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const one = host();
    const [result] = await one.start();
    expect(result).toEqual({ status: "loaded", name: SETTINGS_PLUGIN, codeHash: shipped.codeHash });
    expect(one.loaded()).toEqual([{ name: SETTINGS_PLUGIN, codeHash: shipped.codeHash }]);
    expect(rendererKernel.state(SETTINGS_PLUGIN)).toBe("active");
    expect(lines).toEqual([]);
  });

  it("owns settings/section and settings/quick (the kernel finds them under both names), and :shell no longer does", async () => {
    await host().start();
    for (const slot of [SECTION, QUICK]) {
      expect(rendererKernel.slotOwner(slot), slot).toBe(SETTINGS_PLUGIN);
      expect(rendererKernel.slotOwner(slotName(slot)), slotName(slot)).toBe(SETTINGS_PLUGIN);
    }
    expect(rendererKernel.slotOwner("settings/section")).toBe(SETTINGS_PLUGIN);
    expect(rendererKernel.declaration(SHELL_SURFACE)?.provides?.slots).not.toEqual(expect.arrayContaining([SECTION]));
    expect(rendererKernel.declaration(SHELL_SURFACE)?.provides?.slots).not.toEqual(expect.arrayContaining([QUICK]));
    // The two lists agree: what the plugin provides is what left FEED_SLOTS.
    expect(rendererKernel.declaration(SETTINGS_PLUGIN)?.provides?.slots?.slice().sort()).toEqual([SECTION, QUICK].sort());
    expect(settingsDeclaration.provides?.slots?.map(canonicalSlot).sort()).toEqual([SECTION, QUICK].sort());
    for (const slot of [SECTION, QUICK]) { expect(PLUGIN_OWNED_SLOTS, slot).toContain(slot); expect(FEED_SLOTS, slot).not.toContain(slot); }
  });

  it("registers the core pages in the slot, one registration each, in today's order", async () => {
    await host().start();
    expect(pageIds()).toEqual(allPageIds);
    expect(allPageIds).toHaveLength(12);
    expect(coreEntries().every(({ entry }) => entry.kind === "settings-page")).toBe(true);
    expect(rendererKernel.allContributions().filter(({ plugin, slot }) => plugin === SETTINGS_PLUGIN && slot === SECTION)).toHaveLength(12);
    // Nothing core in quick settings.
    expect(rendererKernel.entries(QUICK)).toEqual([]);
    expect(registeredCoreGroups().map((group) => group.title)).toEqual(SETTINGS_GROUPS.map((group) => group.title));
  });
});

describe("settingsNav over the slot", () => {
  it("returns exactly what it did before the pages moved (the golden of the old code) for '' and 'phone'", async () => {
    await host().start();
    const { groups, unavailable } = coreSettings(rendererKernel);
    expect(unavailable).toBe(false);
    expect(groups).toEqual(SETTINGS_GROUPS);
    const view = fixture();
    expect(settingsNav(view.settingsSections ?? [], "", groups)).toEqual(golden.all);
    expect(settingsNav(view.settingsSections ?? [], "phone", groups)).toEqual(golden.phone);
    expect(settingsNav([], "", groups)).toEqual(golden.none);
    // The plugin pages are indented under Plugins, the legacy ids still resolve (settings-redesign-ui-model.test.ts, unedited).
    const titles = settingsNav(view.settingsSections ?? [], "", groups).find((group) => group.title === "Connect")!.pages.map((page) => page.title);
    expect(titles.slice(titles.indexOf("Plugins"), titles.indexOf("Plugins") + 4)).toEqual(["Plugins", "Worktrees", "Usage", "Zed settings"]);
    // The nav alone (no slot read: the default is the core pages as data): the same pages.
    expect(settingsNav(view.settingsSections ?? [], "")).toEqual(golden.all);
  });

  it("is drawn from the registrations, not from the data: a page the plugin did not register is not in the nav", async () => {
    await host().start();
    const dropped = rendererKernel.allContributions<{ page?: { id: string } }>().length;
    expect(dropped).toBeGreaterThan(0);
    // Take one registration back: the page is gone from what the slot gives (and from the nav drawn from it).
    const some = rendererKernel.entries<{ page: { id: string } }>(SECTION).find(({ entry }) => entry.page?.id === "machines")!;
    await some.registration.dispose();
    const ids = settingsNav([], "", registeredCoreGroups()).flatMap((group) => group.pages.map((page) => page.id));
    expect(ids).toEqual(allPageIds.filter((id) => id !== "machines"));
  });

  it("takes a core page only from the settings plugin: another plugin's {kind: settings-page} entry is not a page", async () => {
    await host().start();
    rendererKernel.install({ name: "evil.plugin", contributes: { slots: [SECTION] } });
    await rendererKernel.load("evil.plugin", (plugin) => {
      rendererKernel.contribute(plugin, SECTION, { kind: "settings-page", group: "App", page: { id: "general", title: "Hijacked", terms: "" } });
      rendererKernel.contribute(plugin, SECTION, { kind: "settings-page", group: "Evil", page: { id: "updates", title: "Evil", terms: "" } });
    });
    expect(rendererKernel.entries(SECTION).filter(({ plugin }) => plugin === "evil.plugin")).toHaveLength(2);
    const groups = registeredCoreGroups();
    expect(groups).toEqual(SETTINGS_GROUPS);
    expect(groups.some((group) => group.title === "Evil")).toBe(false);
    await rendererKernel.requestUnload("evil.plugin");
    rendererKernel.uninstall("evil.plugin");
  });
});

describe("plugins' pages in the same slot", () => {
  const rows = () => pluginFeed.rows<{ plugin: string }>(SECTION);

  it("land after the core pages when the plugin list was there first (the feed asks again once the owner is up)", async () => {
    const view = fixture();
    reconcileView(view);
    // No owner yet: the kernel refused the plugins' settings rows (their other rows are held).
    expect(rows()).toEqual([]);
    expect(pluginFeed.rows("view/mainTab")).toEqual(view.mainTabs);
    await host().start();
    expect(rows()).toEqual(view.settingsSections);
    expect(pluginFeed.rows(QUICK)).toEqual(view.quickSettings);
    // Core pages first, then each plugin's own registration: the order of the slot is registration order.
    const owners = rendererKernel.entries(SECTION).map(({ plugin }) => plugin);
    expect(owners.slice(0, 12)).toEqual(Array(12).fill(SETTINGS_PLUGIN));
    expect(new Set(owners.slice(12))).toEqual(new Set(view.settingsSections!.map((row) => row.plugin)));
    expect(rendererKernel.entries(SECTION)).toHaveLength(12 + view.settingsSections!.length);
  });

  it("are there when the plugin list comes after the settings plugin loaded", async () => {
    await host().start();
    const view = fixture();
    reconcileView(view);
    expect(rows()).toEqual(view.settingsSections);
    expect(rendererKernel.entries(SECTION).filter(({ plugin }) => plugin !== SETTINGS_PLUGIN)).toHaveLength(view.settingsSections!.length);
  });

  it("unloading botling.settings empties the slot of core pages and plugin pages alike (nothing is drawn without its owner), the plugins keep their other rows, and everything comes back, core first, when it reloads", async () => {
    const view = fixture();
    const one = host();
    await one.start();
    reconcileView(view);
    expect(pageIds()).toEqual(allPageIds);
    expect(one.unload(SETTINGS_PLUGIN)).toBe(true);
    await settled();
    expect(rendererKernel.entries(SECTION)).toEqual([]);
    expect(pageIds()).toEqual([]);
    expect(registeredCoreGroups()).toEqual([]);
    expect(coreSettings(rendererKernel)).toEqual({ groups: [], unavailable: true });
    expect(rendererKernel.declaration(SETTINGS_PLUGIN)).toBeUndefined();
    // The plugins stay registered: they are loaded, and every row that does not need the settings slots is still there.
    for (const name of ["botling.git", "botling.usage", "zed.tools"]) expect(rendererKernel.state(name), name).toBe("active");
    expect(pluginFeed.rows("view/mainTab")).toEqual(view.mainTabs);
    // (a menu :shell keeps for good, `app/palette`; `chat/link` is botling.chat's since M7-06a, `browser/tab` botling.browser-pane's since M7-06c)
    expect(pluginFeed.rows("app/palette")).toEqual(view.menus!.filter((row) => row.menu === "commandPalette"));
    expect(rows()).toEqual([]);
    // Back: core pages first, the plugins' pages after them.
    await one.start();
    expect(coreSettings(rendererKernel).unavailable).toBe(false);
    expect(pageIds()).toEqual(allPageIds);
    expect(rows()).toEqual(view.settingsSections);
    expect(rendererKernel.entries(SECTION).map(({ plugin }) => plugin).slice(0, 12)).toEqual(Array(12).fill(SETTINGS_PLUGIN));
    expect(rendererKernel.entries(SECTION)).toHaveLength(12 + view.settingsSections!.length);
  });

  it("a name from the card: the same list through the new slot name", async () => {
    await host().start();
    reconcileView(fixture());
    expect(rendererKernel.entries("settings/section").map(({ registration }) => registration.id)).toEqual(rendererKernel.entries(SECTION).map(({ registration }) => registration.id));
    expect(canonicalSlot("settings/section")).toBe(SECTION);
  });
});

describe("who holds the host", () => {
  it("is held while there is a holder: the first one starts it, the last one to let go unloads it, a double release counts once", async () => {
    const one = host();
    const first = one.acquire();
    const second = one.acquire();
    await vi.waitFor(() => { expect(one.loaded()).toHaveLength(1); });
    first();
    first();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(one.loaded()).toHaveLength(1);
    expect(rendererKernel.state(SETTINGS_PLUGIN)).toBe("active");
    second();
    await vi.waitFor(() => { expect(one.loaded()).toEqual([]); expect(rendererKernel.state(SETTINGS_PLUGIN)).toBe("absent"); });
    expect(rendererKernel.declaration(SETTINGS_PLUGIN)).toBeUndefined();
    // Let go is not "refused": the surface is simply not up, and nothing says unavailable.
    expect(one.unavailable(SETTINGS_PLUGIN)).toBe(false);
  });

  it("the shell frame holds the renderer's host while it is up and lets go when it unmounts", async () => {
    const start = vi.spyOn(inPageHost, "start");
    const stop = vi.spyOn(inPageHost, "stop");
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const element = document.createElement("div");
    const root = createRoot(element);
    try {
      await act(async () => root.render(createElement(ShellFrame, { legacy: createElement("main", null, "page") })));
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      expect(stop).toHaveBeenCalledTimes(1);
    } finally { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
  });
});

describe("what the host refuses", () => {
  const source = (module: { activate(api: unknown): unknown }): InPageSource => () => module as never;

  it("a module that defines a plugin the manifest does not list fails to load and installs nothing", async () => {
    const one = host({ source: source({ activate: (api) => (api as InPageApi).define({ name: "botling.evil", provides: { slots: ["settings/section"] } }, () => undefined) }) });
    const [result] = await one.start();
    expect(result).toMatchObject({ status: "failed", name: SETTINGS_PLUGIN });
    expect(rendererKernel.declaration("botling.evil")).toBeUndefined();
    expect(rendererKernel.declaration(SETTINGS_PLUGIN)).toBeUndefined();
    expect(one.unavailable(SETTINGS_PLUGIN)).toBe(true);
  });

  it("a module that provides a slot :shell owns is refused by the kernel and leaves no half-installed plugin", async () => {
    const one = host({ source: source({ activate: (api) => (api as InPageApi).define({ name: SETTINGS_PLUGIN, provides: { slots: ["app/main"] } }, () => undefined) }) });
    const [result] = await one.start();
    expect(result).toMatchObject({ status: "failed" });
    expect(rendererKernel.declaration(SETTINGS_PLUGIN)).toBeUndefined();
    expect(rendererKernel.slotOwner("app/main")).toBe(SHELL_SURFACE);
    expect(rendererKernel.state(SHELL_SURFACE)).toBe("active");
  });

  it("a plugin that is already held is not loaded twice", async () => {
    const first = host();
    await first.start();
    const second = host();
    const [again] = await second.start();
    expect(again).toMatchObject({ status: "failed", name: SETTINGS_PLUGIN });
    expect(rendererKernel.state(SETTINGS_PLUGIN)).toBe("active");
    expect(pageIds()).toEqual(allPageIds);
  });

  it("a register step that throws fails the load and takes back what it registered", async () => {
    const one = host({ source: source({ activate: (api) => (api as InPageApi).define(settingsDeclaration, (kernel, plugin) => { kernel.provideSlot(plugin, "settings/section"); throw new Error("boom"); }) }) });
    const [result] = await one.start();
    expect(result).toMatchObject({ status: "failed", message: "boom" });
    await vi.waitFor(() => { expect(rendererKernel.declaration(SETTINGS_PLUGIN)).toBeUndefined(); });
    expect(rendererKernel.state(SETTINGS_PLUGIN)).toBe("absent");
    expect(rendererKernel.slotOwner(SECTION)).toBeNull();
  });

  it("reads the manifest from the bundle, never over the network", async () => {
    const fetcher = vi.fn(() => { throw new Error("no network"); });
    vi.stubGlobal("fetch", fetcher);
    try {
      const one = new InPageHost({ log: (line) => lines.push(line) });
      hosts.push(one);
      // No manifest was defined in a test, so the build shipped no in-page plugin: nothing is attempted, nothing is fetched.
      expect(await one.start()).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("Settings when the settings plugin is refused", () => {
  const mount = async (node: ReturnType<typeof createElement>) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const element = document.createElement("div");
    const root = createRoot(element);
    await act(async () => root.render(node));
    return { element, unmount: async () => { await act(async () => root.unmount()); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; } };
  };
  const client = { request: vi.fn(() => new Promise(() => {})), onEvent: () => () => {} } as unknown as Client;
  const sheet = () => createElement(SettingsSheet, { client, settings: null, bot: null, plugins: null, onClose() {} });
  const tabs = (element: HTMLElement) => [...element.querySelectorAll(".settings-tab")].map((button) => button.textContent);

  it("shows the 'unavailable' line while no shell has loaded the plugin (nothing is drawn from data the plugin did not register), and the pages once a host has", async () => {
    const view = await mount(sheet());
    try {
      expect(tabs(view.element)).toEqual([]);
      expect(view.element.querySelector(".settings-unavailable")?.textContent).toBe("Settings are unavailable.");
    } finally { await view.unmount(); }
    // With a host (the stand-in a component test uses) the same sheet draws every page.
    const shell = await loadSettingsShell();
    const loaded = await mount(sheet());
    try {
      expect(tabs(loaded.element)).toEqual(SETTINGS_GROUPS.flatMap((group) => group.pages.map((page) => page.title)));
      expect(loaded.element.querySelector(".settings-unavailable")).toBeNull();
    } finally { await loaded.unmount(); await shell.stop(); }
  });

  it("shows the shell's 'unavailable' line, not a blank page, when the loader refuses it (a hash the manifest does not list)", async () => {
    // The page's own manifest is empty in a test: the pair is not listed, so the loader refuses and offers it to a frame.
    const [result] = await inPageHost.start([{ name: SETTINGS_PLUGIN, codeHash: shipped.codeHash }]);
    expect(result).toMatchObject({ status: "refused", reason: "not-in-manifest", offered: true });
    expect(inPageHost.offered()).toEqual([{ name: SETTINGS_PLUGIN, codeHash: shipped.codeHash }]);
    expect(rendererKernel.declaration(SETTINGS_PLUGIN)).toBeUndefined();
    const view = await mount(sheet());
    try {
      const note = view.element.querySelector(".settings-unavailable");
      expect(note?.textContent).toBe("Settings are unavailable.");
      expect(note?.getAttribute("role")).toBe("status");
      expect(tabs(view.element)).toEqual([]);
      expect(view.element.querySelector("h2")?.textContent).toBe("Settings");
      expect(view.element.querySelector("[role=dialog]")).not.toBeNull();
    } finally { await view.unmount(); }
  });
});
