// @vitest-environment jsdom
// Settings and the sidebar gear drawn from the settings plugin's slots (M7-02d). Settings reads its pages from `settings/section`
// (core pages: the plugin's registrations; plugins' pages: the feed's rows) and the gear reads `settings/quick`; neither reads
// `PluginsView.settingsSections` / `quickSettings` any more (the `plugins` prop is still handed in, as App does, and a test below
// hands in a stale one to prove it is not read).
//
// The DOM golden (test/fixtures/settings-slots/dom.json) was recorded from the code BEFORE the change (the surfaces read the
// PluginsView arrays) with the step-1 fixture view, and must not change with it: the same view gives the same DOM. Like the other
// goldens it changes only in a change that means to change the page: with the file missing the test prints the new one as
// GOLDEN-KEY / GOLDEN-PART lines (and fails). `:r1:`-style React ids are written as `:rN:`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginsView } from "../../src/contract";
import { settingsView } from "../../src/core/settings";
import type { Client } from "../../src/renderer/client";
import { SettingsSheet, type SettingsSection } from "../../src/renderer/Settings";
import { SidebarSettings } from "../../src/renderer/SidebarSettings";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { SETTINGS_PLUGIN } from "../../src/renderer/settings-names";
import { SETTINGS_GROUPS } from "../../src/renderer/settings-pages";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { desktop } from "../helpers";
import { loadSettingsShell, STAND_IN_MANIFEST, type SettingsShell } from "../settings-shell";

const GOLDEN = join(desktop, "test", "fixtures", "settings-slots", "dom.json");
const fixture = (): PluginsView => JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView;

/** `view` with `name` switched off: its row in every array is gone, and it is listed as off (what the core sends). */
function without(view: PluginsView, name: string): PluginsView {
  const copy = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(copy)) {
    if (key !== "plugins" && Array.isArray(value)) copy[key] = value.filter((row) => (row as { plugin?: string })?.plugin !== name);
  }
  copy.plugins = (view.plugins).map((plugin) => (plugin.name === name ? { ...plugin, enabled: false } : plugin));
  return copy as unknown as PluginsView;
}

let element: HTMLDivElement, root: Root, shell: SettingsShell | null, extra: InPageHost[];
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  shell = null;
  extra = [];
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  for (const one of extra) await one.stop();
  await shell?.stop();
  reconcileView(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

function client() {
  const request = vi.fn(async (command: any) => {
    if (command.type === "plugins.panel") return { title: "t", source: "export const activate = () => {};", settings: {} };
    if (command.type === "card.page") return { url: "botling-card://page/1" };
    if (command.type === "plugins.web") return { specs: [] };
    if (command.type === "settings.get" || command.type === "settings.set") return settingsView({});
    // Any other answer (phone, machines, doctor, …) is a refusal: those pages show their own error line, the same in every run.
    throw new Error(`no stub for ${command.type}`);
  });
  return { request, onEvent: () => () => {} } as unknown as Client;
}
const ids = (html: string) => html.replace(/:r[0-9a-z]+:/g, ":rN:").replace(/_r_[0-9a-z]+_/g, ":rN:");

async function mountSheet(plugins: PluginsView | null, initialSection: SettingsSection = "general") {
  // A new root each time: an open sheet keeps its page, whatever `initialSection` says.
  await act(async () => root.unmount());
  root = createRoot(element);
  await act(async () => root.render(createElement(SettingsSheet, { client: client(), settings: settingsView({}), bot: null, plugins, initialSection, onClose() {} })));
  await act(async () => { await Promise.resolve(); });
}
const q = (selector: string) => element.querySelector(selector);
const tabs = () => [...element.querySelectorAll(".settings-tab")].map((tab) => tab.textContent);
const type = async (value: string) => {
  const search = q(".settings-search") as HTMLInputElement;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value); search.dispatchEvent(new Event("input", { bubbles: true })); });
};
const navAndHeader = () => ids(`${q(".settings-side")!.outerHTML}${q(".settings-header")!.outerHTML}`);
const dialog = () => ids(q(".settings")!.outerHTML);

async function openGear(plugins: PluginsView | null) {
  await act(async () => root.render(createElement(SidebarSettings, { client: client(), settings: settingsView({}), plugins, settingsOpen: false, onOpen() {} })));
  await act(async () => { (q('[aria-label="Quick settings"]') as HTMLButtonElement).click(); });
  await act(async () => { await Promise.resolve(); });
}
const popover = () => ids(q(".sidebar-settings-popover")!.outerHTML);
const links = () => [...element.querySelectorAll(".sidebar-settings-links button")].map((button) => button.textContent);
const frames = () => [...element.querySelectorAll<HTMLElement>(".plugin-slot")].map((slot) => `${slot.dataset.plugin}/${slot.dataset.view}`);

const PLUGIN_PAGES = ["botling.git/botling.git.settings", "botling.usage/botling.usage.settings", "zed.tools/zed.tools.settings"] as const;
const CORE_IDS = SETTINGS_GROUPS.flatMap((group) => group.pages.map((page) => page.id));

describe("the DOM is the one the PluginsView arrays gave (golden recorded before the change)", () => {
  it("Settings and the gear popover, for the step-1 fixture view", async () => {
    const view = fixture();
    shell = await loadSettingsShell(view);
    const got: Record<string, string> = {};
    // Every page: the nav (each group, plugin pages indented under Plugins) and the header, with the page marked as the current one.
    for (const id of [...CORE_IDS, ...PLUGIN_PAGES]) {
      await mountSheet(view, id);
      got[`page:${id}`] = navAndHeader();
    }
    // Whole dialogs: a core page, a plugin page (its frame) and the Plugins page (the shell's grant and approve controls).
    for (const id of ["general", "botling.usage/botling.usage.settings", "plugins"] as const) {
      await mountSheet(view, id);
      got[`dialog:${id}`] = dialog();
    }
    // Search: by a core page's words, by a plugin page's words, and with no match.
    for (const words of ["phone", "worktree", "quota", "zzz nothing"]) {
      await mountSheet(view, "general");
      await type(words);
      got[`search:${words}`] = navAndHeader();
    }
    reconcileView(null);
    await mountSheet(null);
    got["no-plugins"] = navAndHeader();
    // The gear: closed, open with the plugins' blocks and links, open without a plugin list.
    reconcileView(view);
    await act(async () => root.render(createElement(SidebarSettings, { client: client(), settings: settingsView({}), plugins: view, settingsOpen: false, onOpen() {} })));
    got["gear:closed"] = ids(q(".sidebar-settings")!.outerHTML);
    await openGear(view);
    got["gear:open"] = popover();
    await act(async () => root.unmount());
    root = createRoot(element);
    reconcileView(null);
    await openGear(null);
    got["gear:open-no-plugins"] = popover();
    if (!existsSync(GOLDEN)) {
      // One short line per piece: the log keeps long lines cut.
      for (const [key, html] of Object.entries(got)) {
        console.log(`GOLDEN-KEY ${JSON.stringify(key)}`);
        for (let at = 0; at < html.length; at += 1500) console.log(`GOLDEN-PART ${JSON.stringify(html.slice(at, at + 1500))}`);
      }
      throw new Error(`${GOLDEN} is missing: record it from the code before the change`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, string>;
    expect(Object.keys(got)).toEqual(Object.keys(golden));
    // A key that changed prints its new DOM the same way (one short line per piece), so a change that means to change a page can record it.
    for (const key of Object.keys(golden).filter((one) => got[one] !== golden[one])) {
      console.log(`GOLDEN-KEY ${JSON.stringify(key)}`);
      for (let at = 0; at < got[key]!.length; at += 1500) console.log(`GOLDEN-PART ${JSON.stringify(got[key]!.slice(at, at + 1500))}`);
    }
    for (const key of Object.keys(golden)) expect(got[key], key).toBe(golden[key]);
  });
});

describe("a plugin that waits for the user's Allow is counted on the Plugins entry", () => {
  const waiting = { name: "wait.tool", title: "Waiter", version: "1.0.0", description: null, enabled: true, failure: null, installedFrom: null, permissions: ["files"], parts: ["web"], settings: [], commands: [], panels: [],
    grant: "none", asks: { codeHash: "4d9bac0566d3ca220a837eba6d48c6496eb75257a36853c7775d662c52634cc8", tier: "write", reads: [], requests: ["chat.send"] } };

  it("shows a count on the nav entry and Allow on the page, and nothing when no plugin waits", async () => {
    const view = fixture();
    shell = await loadSettingsShell(view);
    await mountSheet(view);
    expect(q(".settings-allow-badge")).toBeNull();
    const withWaiting = { ...view, plugins: [...view.plugins, waiting] } as PluginsView;
    await mountSheet(withWaiting);
    const tab = [...element.querySelectorAll<HTMLElement>(".settings-tab")].find((one) => one.textContent?.startsWith("Plugins"))!;
    expect(tab.querySelector(".settings-allow-badge")?.textContent).toBe("1");
    await mountSheet(withWaiting, "plugins");
    expect(q('[data-testid="allow-banner"]')?.textContent).toContain("Waiter");
    expect(q("li.plugin[data-plugin='wait.tool'] button.plugin-allow-open")?.textContent).toBe("Allow");
  });
});

describe("Settings is drawn from the slots", () => {
  it("shows a plugin's page when its plugin is switched on and takes it away when it is switched off, without reopening Settings", async () => {
    const view = fixture();
    shell = await loadSettingsShell(view);
    await mountSheet(view);
    const all = tabs();
    expect(all).toContain("Zed settings");
    // The page is open, then its plugin goes: the sheet falls back to the first page and the nav loses the entry.
    await act(async () => { [...element.querySelectorAll<HTMLElement>(".settings-tab")].find((tab) => tab.textContent === "Zed settings")!.click(); });
    expect(q(".settings-header h2")!.textContent).toBe("Zed settings");
    expect(frames()).toEqual(["zed.tools/zed.tools.settings"]);
    // The `plugins` prop stays the old fixture: only the slot changes.
    await act(async () => { reconcileView(without(view, "zed.tools")); });
    expect(tabs()).toEqual(all.filter((title) => title !== "Zed settings"));
    expect(q(".settings-header h2")!.textContent).toBe("General");
    expect(frames()).toEqual([]);
    await act(async () => { reconcileView(view); });
    expect(tabs()).toEqual(all);
  });

  it("does not read PluginsView.settingsSections: a prop that lists a page the slot does not have draws nothing for it, and a slot page the prop lacks is drawn", async () => {
    const view = fixture();
    shell = await loadSettingsShell(view);
    const stale: PluginsView = { ...view, settingsSections: [{ plugin: "ghost.plugin", id: "ghost.page", title: "Ghost", terms: "boo" }] };
    await mountSheet(stale);
    expect(tabs()).not.toContain("Ghost");
    expect(tabs()).toEqual(expect.arrayContaining(["Worktrees", "Usage", "Zed settings"]));
  });

  it("keeps a plugin's place in the list when it is switched off and on again (the slot's order is registration order, the page's is the plugin list's)", async () => {
    const view = fixture();
    shell = await loadSettingsShell(view);
    await mountSheet(view);
    const order = () => tabs().filter((title) => ["Worktrees", "Usage", "Zed settings"].includes(title ?? ""));
    const before = order();
    expect(before).toEqual(["Worktrees", "Usage", "Zed settings"]);
    await act(async () => { reconcileView(without(view, "botling.usage")); });
    expect(order()).toEqual(before.filter((title) => title !== "Usage"));
    await act(async () => { reconcileView(view); });
    // botling.usage is registered last now (P2), but the page lists it where the plugin list has it.
    expect(order()).toEqual(before);
  });

  it("draws the core pages the plugin registered, in the nav", async () => {
    shell = await loadSettingsShell(null);
    await mountSheet(null);
    expect(tabs()).toEqual(["General", "Appearance", "Shortcuts", "Models & workers", "Permissions", "Chat & reports", "Engine setup", "Plugins", "Phone", "Machines", "Updates", "Developer"]);
  });
});

describe("a settings plugin that is not there shows the shell's 'unavailable' line, in every case", () => {
  const unavailable = () => {
    expect(q(".settings-unavailable")?.textContent).toBe("Settings are unavailable.");
    expect(q(".settings-unavailable")?.getAttribute("role")).toBe("status");
    expect(tabs()).toEqual([]);
    expect(q(".settings-header h2")!.textContent).toBe("Settings");
    expect(frames()).toEqual([]);
    expect(q(".settings-body")!.textContent).toBe("");
  };

  it("the host never loaded it (no shell around the page)", async () => {
    const view = fixture();
    reconcileView(view);
    await mountSheet(view);
    unavailable();
  });

  it("the host refused it (a hash that is not the manifest's)", async () => {
    const view = fixture();
    const host = new InPageHost({ manifest: STAND_IN_MANIFEST, log: () => undefined });
    extra.push(host);
    const [result] = await host.start([{ name: SETTINGS_PLUGIN, codeHash: "f".repeat(64) }]);
    expect(result).toMatchObject({ status: "refused" });
    reconcileView(view);
    await mountSheet(view);
    unavailable();
    reconcileView(null);
  });

  it("it failed to load", async () => {
    const view = fixture();
    const host = new InPageHost({ manifest: STAND_IN_MANIFEST, log: () => undefined, source: () => ({ activate() { throw new Error("broken"); } }) });
    extra.push(host);
    const [result] = await host.start();
    expect(result).toMatchObject({ status: "failed" });
    reconcileView(view);
    await mountSheet(view);
    unavailable();
    reconcileView(null);
  });

  it("the host unloaded it while Settings was open, and it is back when the host loads it again", async () => {
    const view = fixture();
    shell = await loadSettingsShell(view);
    await mountSheet(view);
    expect(tabs()).toHaveLength(15);
    await act(async () => { shell!.host.unload(SETTINGS_PLUGIN); await vi.waitFor(() => expect(rendererKernel.state(SETTINGS_PLUGIN)).toBe("absent")); });
    unavailable();
    await act(async () => { await shell!.host.start(); });
    expect(q(".settings-unavailable")).toBeNull();
    expect(tabs()).toHaveLength(15);
  });

  it("the kernel unloaded it behind the host's back", async () => {
    const view = fixture();
    shell = await loadSettingsShell(view);
    await mountSheet(view);
    await act(async () => { await rendererKernel.requestUnload(SETTINGS_PLUGIN); });
    unavailable();
  });
});

describe("the gear is drawn from settings/quick", () => {
  it("draws each quick block, and the link of each plugin page, from the slots (a stale prop is not read)", async () => {
    const view = fixture();
    shell = await loadSettingsShell(view);
    await openGear({ ...view, quickSettings: [], settingsSections: [] });
    expect(frames()).toEqual(["botling.usage/botling.usage.quota", "zed.tools/zed.tools.quick"]);
    expect(links()).toEqual(["Plugins18 on", "Usage by bot›", "Zed by bot›", "Developer settings…›", expect.stringMatching(/^All settings…/)]);
  });

  it("follows a plugin being switched off and on, live, in the plugin list's order", async () => {
    const view = fixture();
    shell = await loadSettingsShell(view);
    await openGear(view);
    await act(async () => { reconcileView(without(view, "botling.usage")); });
    expect(frames()).toEqual(["zed.tools/zed.tools.quick"]);
    expect(links()).not.toContain("Usage by bot›");
    await act(async () => { reconcileView(view); });
    expect(frames()).toEqual(["botling.usage/botling.usage.quota", "zed.tools/zed.tools.quick"]);
    expect(links().slice(1, 3)).toEqual(["Usage by bot›", "Zed by bot›"]);
  });

  it("without the settings plugin the popover has no plugin block and no plugin link, and the shell's own controls work", async () => {
    await openGear(fixture());
    expect(frames()).toEqual([]);
    expect(links().map((text) => text?.replace(/[›0-9 ]+on$|›$/, ""))).toEqual(["Plugins", "Developer settings…", expect.stringMatching(/^All settings…/)]);
    expect(q('[role="switch"]')).not.toBeNull();
  });
});
