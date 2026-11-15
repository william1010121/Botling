// @vitest-environment jsdom
// `botling.sidebar`, the second in-page built-in plugin (M7-05a): loaded by the trusted loader from the folder the FE build shipped, it
// occupies `app/rail` (the left column is drawn from the slot), owns `bot/row` (the 2.x status place `botRow`, canonical id
// `statusItem/botRow`), and keeps the column's layout (folded, pinned, Idle) in the shell's per-device storage (M7-05c).
// The DOM goldens in test/fixtures/sidebar/ were recorded from the code before the rail moved (the rail drawn by App.tsx): the plugin's
// slot and the plugin-less path (a page without the shell) both draw exactly those bytes.
// The slot's canonical id is still the 2.x one (`statusItem/botRow`): tests ask by either name and compare with `canonicalSlot`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalSlot, slotName } from "../../../Web/src/plugin-kernel";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { rendererKernel, SHELL_STORAGE, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { sidebarDeclaration } from "../../src/renderer/plugins/sidebar";
import { InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { configureShellStorage, createMemoryShellStorageBackend, serializeNamespaceMap, type ShellStorageBackend } from "../../src/renderer/shell/storage";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { railLayout, type RailLayout } from "../../src/renderer/sidebar-layout";
import { BOT_ROW_SLOT, LAYOUT_STORAGE_KEY, RAIL_SLOT, SIDEBAR_PLUGIN } from "../../src/renderer/sidebar-names";
import { desktop } from "../helpers";
import { ID, mountPage, NOW, RAIL_SELECTOR, type MountedPage, type PageOptions } from "../sidebar-page";

const BOT_ROW = "statusItem/botRow";
const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const shipped = manifest.plugins.find((entry) => entry.name === SIDEBAR_PLUGIN);
const golden = (name: string) => readFileSync(join(desktop, "test", "fixtures", "sidebar", `rail.${name}.html`), "utf8").replace(/^<!-- [^\n]* -->\n/, "").replace(/\n$/, "");

const lines: string[] = [];
const hosts: InPageHost[] = [];
const pages: MountedPage[] = [];
let backend: ShellStorageBackend;
let warnings: string[];

beforeEach(() => {
  backend = createMemoryShellStorageBackend();
  configureShellStorage(backend);
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => { warnings.push(String(line)); });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  for (const page of pages.splice(0)) await page.unmount();
  for (const one of hosts.splice(0)) await one.stop();
  if (rendererKernel.state("test.extra") !== "absent") await rendererKernel.requestUnload("test.extra");
  rendererKernel.uninstall("test.extra");
  reconcileView(null);
  railLayout.detach();
  configureShellStorage(undefined);
  localStorage.clear();
  lines.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

/** Starts a host for the plugins the build ships, as ShellFrame's does (the renderer's own manifest is empty in a test). */
async function shell() {
  const made = new InPageHost({ manifest, log: (line) => lines.push(line) });
  hosts.push(made);
  const results = await made.start();
  return { host: made, results };
}
async function page(options: PageOptions = {}) {
  const mounted = await mountPage(options);
  pages.push(mounted);
  return mounted;
}
/** Seeds the plugin's storage namespace with a layout (what an earlier run left). */
const seed = (layout: unknown) => backend.save(SIDEBAR_PLUGIN, serializeNamespaceMap(new Map([[LAYOUT_STORAGE_KEY, layout]])));
const stored = async (): Promise<unknown> => {
  const raw = await backend.load(SIDEBAR_PLUGIN);
  return raw === null ? undefined : (JSON.parse(raw) as Record<string, unknown>)[LAYOUT_STORAGE_KEY];
};
/** After the storage answered and the store settled against the page's settings. */
const settled = () => act(async () => { await vi.waitFor(() => { expect(railLayout.current()).not.toBeNull(); }); });
const idsOf = (layout: unknown) => (layout as RailLayout);
/** The writes of the three layout keys the page sent (the old keys; the page also writes `botColors` by itself). */
const layoutWrites = (mounted: MountedPage) => mounted.sent
  .filter((command) => command.type === "settings.set")
  .map((command) => command.change as { key: string; value: unknown })
  .filter((change) => ["railCollapsed", "pinnedBots", "idleBots"].includes(change.key));
const click = (mounted: MountedPage, selector: string) => act(async () => { (mounted.host.querySelector(selector) as HTMLElement).click(); });

describe("the sidebar plugin as the FE build ships it", () => {
  it("is a folder of the build: the manifest lists botling.sidebar with its folder's hash, and the loader runs the bundled module", async () => {
    expect(shipped?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const { host, results } = await shell();
    expect(results.find((result) => result.name === SIDEBAR_PLUGIN)).toEqual({ status: "loaded", name: SIDEBAR_PLUGIN, codeHash: shipped!.codeHash });
    expect(host.loaded().map((entry) => entry.name)).toContain(SIDEBAR_PLUGIN);
    expect(rendererKernel.state(SIDEBAR_PLUGIN)).toBe("active");
    expect(lines).toEqual([]);
  });

  it("owns bot/row (the kernel finds it under both names) and contributes the rail to app/rail, which :shell still owns", async () => {
    await shell();
    for (const slot of [BOT_ROW, BOT_ROW_SLOT]) expect(rendererKernel.slotOwner(slot), slot).toBe(SIDEBAR_PLUGIN);
    expect(canonicalSlot(BOT_ROW_SLOT)).toBe(BOT_ROW);
    expect(slotName(BOT_ROW)).toBe(BOT_ROW_SLOT);
    expect(rendererKernel.slotOwner(RAIL_SLOT)).toBe(SHELL_SURFACE);
    const rail = rendererKernel.entries(RAIL_SLOT);
    expect(rail.map(({ plugin }) => plugin)).toEqual([SIDEBAR_PLUGIN]);
    // The declaration is what the kernel holds: it needs the shell's storage service, owns one slot and contributes to one.
    expect(sidebarDeclaration.requires?.services).toEqual([SHELL_STORAGE]);
    expect(rendererKernel.declaration(SIDEBAR_PLUGIN)?.provides?.slots).toEqual([BOT_ROW, "menu/bot/context"]);
    expect(rendererKernel.declaration(SIDEBAR_PLUGIN)?.contributes?.slots).toEqual([RAIL_SLOT]);
  });

  it("takes the rail back when it unloads (the column is not left behind), and draws it again when it loads again", async () => {
    const { host } = await shell();
    expect(rendererKernel.entries(RAIL_SLOT)).toHaveLength(1);
    expect(host.unload(SIDEBAR_PLUGIN)).toBe(true);
    await vi.waitFor(() => { expect(rendererKernel.state(SIDEBAR_PLUGIN)).toBe("absent"); });
    expect(rendererKernel.entries(RAIL_SLOT)).toEqual([]);
    expect(rendererKernel.slotOwner(BOT_ROW)).toBeNull();
    const results = await host.start([shipped!]);
    expect(results[0]?.status).toBe("loaded");
    expect(rendererKernel.entries(RAIL_SLOT)).toHaveLength(1);
  });

  it("accepts a plugin's botRow status item while it is up, and refuses it once it is gone; the rail's markup does not change", async () => {
    await shell();
    const mounted = await page({ shown: ID.alpha });
    const before = mounted.rail();
    rendererKernel.install({ name: "test.extra", contributes: { slots: [BOT_ROW] } });
    let registration: unknown = "unset";
    await rendererKernel.load("test.extra", (plugin) => { registration = rendererKernel.contribute(plugin, BOT_ROW_SLOT, { kind: "status", text: "x" }); });
    expect(registration).not.toBeNull();
    expect(rendererKernel.entries(BOT_ROW).map(({ plugin }) => plugin)).toEqual(["test.extra"]);
    await act(async () => { await Promise.resolve(); });
    expect(mounted.rail()).toBe(before);
    await rendererKernel.requestUnload("test.extra");
    rendererKernel.uninstall("test.extra");
    await hosts[0]!.stop();
    // The owner is away: a contribution is refused (the kernel does not hold a status item nobody owns).
    rendererKernel.install({ name: "test.extra", contributes: { slots: [BOT_ROW] } });
    let after: unknown = "unset";
    await rendererKernel.load("test.extra", (plugin) => { after = rendererKernel.contribute(plugin, BOT_ROW_SLOT, { kind: "status", text: "y" }); });
    expect(after).toBeNull();
    expect(rendererKernel.entries(BOT_ROW)).toEqual([]);
  });
});

describe("the left column as drawn", () => {
  const scenarios: { name: string; options: PageOptions; act?: (mounted: MountedPage) => Promise<void> }[] = [
    { name: "pinned", options: { settings: { pinnedBots: [ID.beta, ID.gamma] }, shown: ID.alpha } },
    { name: "idle", options: { settings: { pinnedBots: [ID.beta], idleBots: [ID.delta, ID.gamma] } } },
    { name: "idle-open", options: { settings: { pinnedBots: [ID.beta], idleBots: [ID.delta, ID.gamma] } }, act: (mounted) => click(mounted, ".rail-idle-row") },
    { name: "folded", options: { settings: { railCollapsed: true, pinnedBots: [ID.beta], idleBots: [ID.delta] } } },
    { name: "subbots", options: { shown: ID.sub } },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.name}: the sidebar's slot draws the recorded markup, and so does a page without the plugin`, async () => {
      // Without the shell's plugins: the column is drawn directly, as before.
      const bare = await page(scenario.options);
      await scenario.act?.(bare);
      expect(bare.rail(), "without the plugin").toBe(golden(scenario.name));
      await bare.unmount();
      pages.splice(pages.indexOf(bare), 1);
      // With the plugin up: drawn from `app/rail`.
      await shell();
      const mounted = await page(scenario.options);
      await settled();
      await scenario.act?.(mounted);
      expect(mounted.rail(), "from the slot").toBe(golden(scenario.name));
      expect(mounted.host.querySelectorAll(RAIL_SELECTOR)).toHaveLength(1);
    });
  }

  it("is drawn from the slot only while the plugin is up: another plugin's contribution to app/rail shows beside it, and goes with the plugin", async () => {
    await shell();
    rendererKernel.install({ name: "test.extra", contributes: { slots: [RAIL_SLOT] } });
    await rendererKernel.load("test.extra", (plugin) => { rendererKernel.contribute(plugin, RAIL_SLOT, { kind: "component", render: () => createElement("i", { id: "extra-rail" }) }); });
    const mounted = await page({ shown: ID.alpha });
    expect(mounted.host.querySelector("#extra-rail")).not.toBeNull();
    // Inside the page's own layout (the column's place beside the chat), after the column.
    const shellEl = mounted.host.querySelector(".shell")!;
    expect([...shellEl.children].slice(0, 2).map((child) => child.id || child.tagName)).toEqual(["ASIDE", "extra-rail"]);
    await act(async () => { hosts[0]!.unload(SIDEBAR_PLUGIN); await vi.waitFor(() => { expect(rendererKernel.state(SIDEBAR_PLUGIN)).toBe("absent"); }); });
    // The page does not go blank (the plugin-less path draws the column), and the slot's other entry is not drawn.
    expect(mounted.host.querySelector("#extra-rail")).toBeNull();
    expect(mounted.host.querySelectorAll("aside.rail")).toHaveLength(1);
  });

  it("the chat-pane and the divider stay where they were (no second column, the page's order is unchanged)", async () => {
    await shell();
    const mounted = await page({ shown: ID.alpha });
    const order = [...mounted.host.querySelector(".shell")!.children].map((child) => child.className.split(" ")[0] || child.tagName);
    expect(order.slice(0, 3)).toEqual(["rail", "col-handle", "chat-pane"]);
  });
});

describe("the layout in the shell storage", () => {
  const layout = (over: Partial<RailLayout> = {}): RailLayout => ({ railCollapsed: false, pinnedBots: [], idleBots: [], ...over });

  it("reads the stored layout (the settings keys hold none): the same markup as the settings-keyed golden", async () => {
    await seed(layout({ pinnedBots: [ID.beta, ID.gamma] }));
    await shell();
    const mounted = await page({ settings: {}, shown: ID.alpha });
    await settled();
    expect(mounted.rail()).toBe(golden("pinned"));
    expect(railLayout.current()).toEqual(layout({ pinnedBots: [ID.beta, ID.gamma] }));
  });

  it("folded and Idle come from the storage too", async () => {
    await seed(layout({ railCollapsed: true, pinnedBots: [ID.beta], idleBots: [ID.delta] }));
    await shell();
    const mounted = await page({ settings: {} });
    await settled();
    expect(mounted.rail()).toBe(golden("folded"));
  });

  it("the first time (nothing stored) copies the settings keys into the storage once, and never touches the keys", async () => {
    const settings = { railCollapsed: true, pinnedBots: [ID.beta], idleBots: [ID.delta] };
    await shell();
    const mounted = await page({ settings });
    await settled();
    await vi.waitFor(async () => { expect(await stored()).toEqual(layout(settings)); });
    // Read old, write new, delete nothing: the page sent no write of a layout key at all.
    expect(layoutWrites(mounted)).toEqual([]);
    expect(mounted.rail()).toBe(golden("folded"));
  });

  it("migrates only once: a layout already stored wins over the settings keys on the next start", async () => {
    await seed(layout({ pinnedBots: [ID.gamma] }));
    await shell();
    const mounted = await page({ settings: { pinnedBots: [ID.beta], idleBots: [ID.delta] }, shown: ID.alpha });
    await settled();
    expect(railLayout.current()).toEqual(layout({ pinnedBots: [ID.gamma] }));
    expect(await stored()).toEqual(layout({ pinnedBots: [ID.gamma] }));
    expect(mounted.rail()).toContain('aria-label="Unpin Gamma"');
    expect(mounted.rail()).not.toContain('aria-label="Unpin Beta"');
    expect(layoutWrites(mounted)).toEqual([]);
  });

  it("pinning in the column writes the storage and the old key (the core still reads pinnedBots), and the column shows it", async () => {
    await shell();
    const mounted = await page({ settings: {}, shown: ID.alpha });
    await settled();
    await click(mounted, '[aria-label="Pin Beta"]');
    await vi.waitFor(async () => { expect(idsOf(await stored()).pinnedBots).toEqual([ID.beta]); });
    expect(layoutWrites(mounted)).toEqual([{ key: "pinnedBots", value: [ID.beta] }]);
    expect(mounted.rail()).toContain('aria-label="Unpin Beta"');
    expect(mounted.rail()).toContain('<h4 class="rail-section">Pinned</h4>');
  });

  it("sending a bot to Idle and back writes both places, and the folded state too", async () => {
    await shell();
    const mounted = await page({ settings: {}, shown: ID.alpha });
    await settled();
    await click(mounted, '[aria-label="Send Delta to Idle"]');
    await vi.waitFor(async () => { expect(idsOf(await stored()).idleBots).toEqual([ID.delta]); });
    expect(layoutWrites(mounted)).toEqual([{ key: "idleBots", value: [ID.delta] }]);
    expect(mounted.rail()).toContain("Idle, 1 bot");
    await click(mounted, '[aria-label="Collapse sidebar"]');
    await vi.waitFor(async () => { expect(idsOf(await stored()).railCollapsed).toBe(true); });
    expect(layoutWrites(mounted).at(-1)).toEqual({ key: "railCollapsed", value: true });
    expect(mounted.host.querySelector("aside.rail-strip")).not.toBeNull();
  });

  it("a layout survives the plugin's unload and load (the storage, not the page's memory, holds it)", async () => {
    const { host } = await shell();
    const mounted = await page({ settings: {}, shown: ID.alpha });
    await settled();
    await click(mounted, '[aria-label="Pin Gamma"]');
    await vi.waitFor(async () => { expect(idsOf(await stored()).pinnedBots).toEqual([ID.gamma]); });
    await act(async () => { host.unload(SIDEBAR_PLUGIN); await vi.waitFor(() => { expect(rendererKernel.state(SIDEBAR_PLUGIN)).toBe("absent"); }); });
    expect(railLayout.current()).toBeNull();
    await act(async () => { await host.start([shipped!]); });
    await settled();
    expect(railLayout.current()).toEqual(layout({ pinnedBots: [ID.gamma] }));
    expect(mounted.rail()).toContain('aria-label="Unpin Gamma"');
  });

  it("takes over a change made in the old key by someone else (a message to an idle bot takes it out of Idle), but not its own write coming back", async () => {
    const settings = { idleBots: [ID.delta, ID.gamma] };
    await shell();
    const mounted = await page({ settings, shown: ID.alpha });
    await settled();
    // The core's send.ts: `idleBots` without Delta.
    await mounted.settings({ idleBots: [ID.gamma] });
    await vi.waitFor(async () => { expect(idsOf(await stored()).idleBots).toEqual([ID.gamma]); });
    expect(mounted.rail()).toContain("Idle, 1 bot");
    // Our own write: Gamma back from Idle; the answer arrives later as the settings changing to the same value, and then a second write.
    await click(mounted, ".rail-idle-row");
    await click(mounted, '[aria-label="Bring Gamma back from Idle"]');
    expect(railLayout.current()?.idleBots).toEqual([]);
    await click(mounted, '[aria-label="Send Delta to Idle"]');
    expect(railLayout.current()?.idleBots).toEqual([ID.delta]);
    // The first answer (idle [], the older write) arrives after the second write was made: it must not undo it.
    await mounted.settings({ idleBots: [] });
    expect(railLayout.current()?.idleBots).toEqual([ID.delta]);
    await mounted.settings({ idleBots: [ID.delta] });
    expect(railLayout.current()?.idleBots).toEqual([ID.delta]);
    // An older value is a change again once our writes have all come back.
    await mounted.settings({ idleBots: [] });
    expect(railLayout.current()?.idleBots).toEqual([]);
  });

  it("a page of Botling Web keeps its layout in the settings (the bridge's), and leaves the storage alone", async () => {
    await seed(layout({ pinnedBots: [ID.gamma] }));
    await shell();
    const mounted = await page({ settings: { pinnedBots: [ID.beta] }, shown: ID.alpha, web: { railFooter: null } });
    await act(async () => { await Promise.resolve(); });
    expect(mounted.rail()).toContain('aria-label="Unpin Beta"');
    expect(mounted.rail()).not.toContain('aria-label="Unpin Gamma"');
    await click(mounted, '[aria-label="Pin Delta"]');
    expect(layoutWrites(mounted)).toEqual([{ key: "pinnedBots", value: [ID.beta, ID.delta] }]);
    expect(await stored()).toEqual(layout({ pinnedBots: [ID.gamma] }));
  });

  it("falls back to the settings keys (one warning, no crash) when the storage cannot be read, and when what it holds is not a layout", async () => {
    backend = { load: async () => { throw new Error("Validation: broken"); }, save: async () => {} };
    configureShellStorage(backend);
    await shell();
    const mounted = await page({ settings: { pinnedBots: [ID.beta] }, shown: ID.alpha });
    await act(async () => { await vi.waitFor(() => { expect(warnings.some((line) => line.includes("[sidebar]"))).toBe(true); }); });
    expect(warnings.filter((line) => line.includes("[sidebar]"))).toHaveLength(1);
    expect(railLayout.current()).toBeNull();
    expect(mounted.rail()).toContain('aria-label="Unpin Beta"');
    // A change still reaches the old key.
    await click(mounted, '[aria-label="Pin Delta"]');
    expect(layoutWrites(mounted)).toHaveLength(1);
    await mounted.unmount();
    pages.splice(0);
    await hosts[0]!.stop();
    // Not a layout (wrong kinds, a missing key, a prototype key): the settings keys are copied in instead.
    backend = createMemoryShellStorageBackend();
    configureShellStorage(backend);
    await seed({ railCollapsed: "yes", pinnedBots: [ID.gamma], idleBots: [] });
    await shell();
    const again = await page({ settings: { pinnedBots: [ID.beta] }, shown: ID.alpha });
    await settled();
    expect(railLayout.current()).toEqual(layout({ pinnedBots: [ID.beta] }));
    expect(again.rail()).toContain('aria-label="Unpin Beta"');
  });
});
