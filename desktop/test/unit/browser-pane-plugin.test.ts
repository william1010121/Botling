// @vitest-environment jsdom
// `botling.browser-pane` (M7-06c): the in-page built-in plugin that owns `browser/tab` in the renderer's kernel. The pane (BrowserPane.tsx)
// is still drawn by App, but the buttons it shows come from the slot (browser-slot.ts `browserPlugins`, called by App) instead of
// `PluginsView.menus`; which tab gets which button is still the row's `when` (browserTabActions). The DOM golden is what the code before
// the move drew (test/fixtures/browser-pane/*.html, browser-tab-golden.test.ts: the same files, drawn there with no plugin host).
// Slot ids in the kernel are still the 2.x ones, so ownership is asked by either name.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalSlot, slotName } from "../../../Web/src/plugin-kernel";
import type { PluginsView } from "../../src/contract";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { BROWSER_PANE_PLUGIN, BROWSER_PANE_SLOTS } from "../../src/renderer/browser-names";
import { browserPlugins } from "../../src/renderer/browser-slot";
import { browserTabActions } from "../../src/renderer/plugin-commands";
import { browserPaneDeclaration } from "../../src/renderer/plugins/browser-pane";
import { rendererKernel, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { FEED_SLOTS, PLUGIN_OWNED_SLOTS } from "../../src/renderer/shell/feed-slots";
import { inPageHost, InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { openPane, paneView, OTHER_ROWS, TAB_ROWS, type Pane } from "../browser-pane-harness";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const shipped = manifest.plugins.find((entry) => entry.name === BROWSER_PANE_PLUGIN)!;
// These hosts run only the browser-pane plugin (the build ships the others too; their own tests cover them).
const paneOnly = { plugins: manifest.plugins.filter((entry) => entry.name === BROWSER_PANE_PLUGIN) };
const SLOT = "browser/tab";
const golden = (name: string): string => readFileSync(join(desktop, "test", "fixtures", "browser-pane", `${name}.html`), "utf8");
const fixture = (): PluginsView => JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView;
/** The kernel-goldens view (zed.tools has a browser/tab row of its own, with a `when`) plus the coach's and the clip's buttons. */
const viewWith = (): PluginsView => ({ ...fixture(), menus: [...(fixture().menus ?? []), TAB_ROWS[0]!, TAB_ROWS[2]!] });
const commandsOf = (markup: string) => [...markup.matchAll(/data-command="([^"]+)"/g)].map((match) => match[1]);

const hosts: InPageHost[] = [];
const panes: Pane[] = [];
function host(options: ConstructorParameters<typeof InPageHost>[0] = {}) {
  const made = new InPageHost({ manifest: paneOnly, log: () => undefined, ...options });
  hosts.push(made);
  return made;
}
/** The page reads the renderer's own `inPageHost`: let it see a test host instead (the page has no shell loader in a test). */
const seenBy = (one: InPageHost) => vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => one.unavailable(name));
/** Waits until the plugin feed has put `count` browser/tab rows in the kernel (a load takes a few microtasks). */
const settled = (count: number) => vi.waitFor(() => { expect(rendererKernel.entries(SLOT)).toHaveLength(count); });
afterEach(async () => {
  for (const pane of panes.splice(0)) await pane.close();
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
  await vi.waitFor(() => { expect(rendererKernel.state(BROWSER_PANE_PLUGIN)).toBe("absent"); });
  vi.restoreAllMocks();
});

describe("the browser-pane plugin as the FE build ships it", () => {
  it("is a folder of the build: the manifest lists botling.browser-pane with its folder's hash and the loader runs it", async () => {
    expect(shipped?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const results = await host().start();
    expect(results.find((result) => result.name === BROWSER_PANE_PLUGIN)).toEqual({ status: "loaded", name: BROWSER_PANE_PLUGIN, codeHash: shipped.codeHash });
    expect(rendererKernel.state(BROWSER_PANE_PLUGIN)).toBe("active");
  });

  it("owns `browser/tab` by either name, and :shell no longer does; the two ownership lists agree", async () => {
    await host().start();
    expect(BROWSER_PANE_SLOTS).toEqual([SLOT]);
    for (const slot of [SLOT, canonicalSlot(SLOT)]) expect(rendererKernel.slotOwner(slot), slot).toBe(BROWSER_PANE_PLUGIN);
    expect(canonicalSlot(SLOT)).toBe("menu/browser/tab");
    expect(slotName("menu/browser/tab")).toBe(SLOT);
    expect(rendererKernel.declaration(SHELL_SURFACE)?.provides?.slots).not.toContain("menu/browser/tab");
    expect(FEED_SLOTS).not.toContain("menu/browser/tab");
    expect(PLUGIN_OWNED_SLOTS).toContain("menu/browser/tab");
    expect(rendererKernel.declaration(BROWSER_PANE_PLUGIN)?.provides?.slots?.map(canonicalSlot)).toEqual(["menu/browser/tab"]);
    expect(browserPaneDeclaration.provides?.slots?.map(canonicalSlot)).toEqual(["menu/browser/tab"]);
  });

  it("takes plugins' browser/tab rows only while it is up (the feed's rows are refused with no owner)", async () => {
    const view = viewWith();
    reconcileView(view);
    await vi.waitFor(() => { expect(rendererKernel.plugins().length).toBeGreaterThan(1); });
    expect(rendererKernel.entries(SLOT)).toEqual([]);
    await host().start();
    await settled(3);
  });
});

describe("browserPlugins: the view the toolbar's buttons are read from", () => {
  const rowsOf = (view: PluginsView | null | undefined) => (view?.menus ?? []).filter((row) => row.menu === SLOT).map((row) => row.command);
  it("holds the rows the slot holds, in the view's order, and leaves every other menu and the rest of the view as it is", async () => {
    await host().start();
    const view = viewWith();
    reconcileView(view);
    await settled(3);
    const shown = browserPlugins(view)!;
    expect(rowsOf(shown)).toEqual(rowsOf(view));
    expect(rowsOf(shown)).toEqual(["zed.tools.run", "coach.start", "clip.save"]);
    expect(shown.menus).toEqual(view.menus);
    expect({ ...shown, menus: null }).toEqual({ ...view, menus: null });
  });

  it("shows no row the slot lacks (the view is ahead of the feed) and none the view dropped (the slot is behind)", async () => {
    await host().start();
    const view = viewWith();
    reconcileView(view);
    await settled(3);
    const late = { menu: "browser/tab" as const, command: "late.one", plugin: "late", title: "Late" };
    expect(rowsOf(browserPlugins({ ...view, menus: [...view.menus!, late] }))).toEqual(rowsOf(view));
    const without = { ...view, menus: view.menus!.filter((row) => row.plugin !== "clip") };
    expect(rowsOf(browserPlugins(without))).not.toContain("clip.save");
    expect(rowsOf(browserPlugins(without))).toEqual(rowsOf(without));
    // A row that the slot holds under another plugin's name is not the view's row either.
    const renamed = { ...view, menus: view.menus!.map((row) => (row.command === "clip.save" ? { ...row, plugin: "other" } : row)) };
    expect(rowsOf(browserPlugins(renamed))).not.toContain("clip.save");
  });

  it("keeps the order of the view's array when a plugin is reloaded (the slot puts a reloaded plugin's rows last)", async () => {
    await host().start();
    const view = viewWith();
    reconcileView(view);
    await settled(3);
    const changed: PluginsView = { ...view, plugins: view.plugins.map((plugin) => (plugin.name === "zed.tools" ? { ...plugin, version: "9.9.9" } : plugin)) };
    reconcileView(changed);
    await vi.waitFor(() => {
      const order = rendererKernel.entries<{ row?: { plugin: string } }>(SLOT).map(({ entry }) => entry.row?.plugin);
      expect(order).toEqual(["coach", "clip", "zed.tools"]);
    });
    expect(rowsOf(browserPlugins(changed))).toEqual(["zed.tools.run", "coach.start", "clip.save"]);
  });

  it("shows no browser/tab row, and the other menus stay, when the plugin was refused; a host that never touched it leaves the view as it is", async () => {
    const view = viewWith();
    const untouched = host();
    expect(browserPlugins(view, rendererKernel, untouched)).toBe(view);
    const refused = host({ manifest: { plugins: [] } });
    await refused.start([{ name: BROWSER_PANE_PLUGIN, codeHash: "0".repeat(64) }]);
    expect(refused.unavailable(BROWSER_PANE_PLUGIN)).toBe(true);
    const shown = browserPlugins(view, rendererKernel, refused)!;
    expect(rowsOf(shown)).toEqual([]);
    expect((shown.menus ?? []).map((row) => row.menu).sort()).toEqual((view.menus ?? []).filter((row) => row.menu !== SLOT).map((row) => row.menu).sort());
    expect(browserPlugins(null)).toBeNull();
    expect(browserPlugins(undefined)).toBeUndefined();
  });

  it("goes when the plugin is unloaded and comes back when it loads again", async () => {
    const one = host();
    await one.start();
    const view = viewWith();
    reconcileView(view);
    await settled(3);
    expect(one.unload(BROWSER_PANE_PLUGIN)).toBe(true);
    await vi.waitFor(() => { expect(rendererKernel.state(BROWSER_PANE_PLUGIN)).toBe("absent"); });
    expect(rendererKernel.entries(SLOT)).toEqual([]);
    expect(rowsOf(browserPlugins(view, rendererKernel, one))).toEqual([]);
    await one.start();
    await settled(3);
    expect(rowsOf(browserPlugins(view, rendererKernel, one))).toEqual(rowsOf(view));
  });

  it("leaves `when` to browserTabActions: the buttons per tab address are the ones the view alone gave", async () => {
    await host().start();
    const view = paneView();
    reconcileView(view);
    await settled(3);
    for (const url of ["file:///p/a.pdf", "https://docs.example.org/x", "https://example.com/", "file:///p/a.txt", null]) {
      expect(browserTabActions(browserPlugins(view), url), String(url)).toEqual(browserTabActions(view, url));
    }
    expect(browserTabActions(browserPlugins(view), "file:///p/a.pdf").map((action) => action.command)).toEqual(["coach.start", "clip.save"]);
    expect(browserTabActions(browserPlugins(view), "https://docs.example.org/x").map((action) => action.command)).toEqual(["zed.tools.run", "clip.save"]);
  });
});

describe("the pane's toolbar through App, with the plugin loaded", () => {
  async function drawn(tab: { url: string; fileUrl?: string }, name: string, language?: string): Promise<Pane> {
    const one = host();
    seenBy(one);
    await one.start();
    const pane = await openPane(paneView(), tab, language);
    panes.push(pane);
    // The feed has the rows in the slot a few microtasks after App drew the page; the page draws again when the slot changes.
    await act(async () => { await vi.waitFor(() => { expect(`<!-- ${name} -->\n${pane.toolbar()}\n`).toBe(golden(name)); }); });
    return pane;
  }

  it("is what the code before the move drew: a local PDF tab", async () => { await drawn({ url: "botling-content://file/abc", fileUrl: "file:///p/a.pdf" }, "pdf"); });
  it("is what the code before the move drew: a page on a matching host", async () => { await drawn({ url: "https://docs.example.org/x" }, "host"); });
  it("is what the code before the move drew: another page, in the page's language", async () => { await drawn({ url: "https://example.com/" }, "other-zh", "zh-Hant"); });

  it("draws no plugin button while the plugin is unloaded, the rest of the toolbar as it was, and the buttons again when it is back", async () => {
    const one = host();
    seenBy(one);
    await one.start();
    const pane = await openPane(paneView(), { url: "https://docs.example.org/x" });
    panes.push(pane);
    await act(async () => { await vi.waitFor(() => { expect(commandsOf(pane.toolbar())).toEqual(["zed.tools.run", "clip.save"]); }); });
    const withButtons = pane.toolbar();
    // The page's own view is not touched: only the owner goes (the slots change, the page draws again by itself).
    await act(async () => { one.unload(BROWSER_PANE_PLUGIN); await vi.waitFor(() => { expect(rendererKernel.state(BROWSER_PANE_PLUGIN)).toBe("absent"); }); });
    await act(async () => { await vi.waitFor(() => { expect(commandsOf(pane.toolbar())).toEqual([]); }); });
    expect(pane.toolbar()).toBe(withButtons.replace(/<button type="button" class="bp-round bp-plugin-action"[^>]*>.*?<\/button>/g, ""));
    await act(async () => { await one.start(); });
    await act(async () => { await vi.waitFor(() => { expect(pane.toolbar()).toBe(withButtons); }); });
  });

  it("keeps the menus that are not browser/tab out of the toolbar (the chat/link and message/context rows of the view are no buttons)", async () => {
    const one = host();
    seenBy(one);
    await one.start();
    const pane = await openPane(paneView([...TAB_ROWS, ...OTHER_ROWS]), { url: "file:///p/a.pdf" });
    panes.push(pane);
    await act(async () => { await vi.waitFor(() => { expect(commandsOf(pane.toolbar())).toEqual(["coach.start", "clip.save"]); }); });
  });

  it("follows a new plugin list: a row added to the view shows once the feed has it in the slot, one dropped goes", async () => {
    const one = host();
    seenBy(one);
    await one.start();
    const pane = await openPane(paneView(), { url: "https://example.com/" });
    panes.push(pane);
    await act(async () => { await vi.waitFor(() => { expect(commandsOf(pane.toolbar())).toEqual(["clip.save"]); }); });
    const extra = { menu: "browser/tab" as const, command: "more.tool", plugin: "more", title: "More tool" };
    await pane.rerender(paneView([...TAB_ROWS, extra]));
    await act(async () => { await vi.waitFor(() => { expect(commandsOf(pane.toolbar())).toEqual(["clip.save", "more.tool"]); }); });
    await pane.rerender(paneView(TAB_ROWS.filter((row) => row.plugin !== "clip")));
    await act(async () => { await vi.waitFor(() => { expect(commandsOf(pane.toolbar())).toEqual([]); }); });
  });
});
