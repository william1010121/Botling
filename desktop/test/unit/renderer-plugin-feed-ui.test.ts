// @vitest-environment jsdom
// The plugin feed in the page (M7-02b): ShellFrame hands each `PluginsView` App has to the feed, which makes the renderer's kernel hold
// it (shell/plugin-feed.ts), and takes it all back when the frame unmounts. The rows are a mirror: nothing draws them, so the page's DOM
// is what it was (the whole page's markup is in app-dom-golden.test.ts, drawn with the same fixture).
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginsView } from "../../src/contract";
import type { Client } from "../../src/renderer/client";
import { rendererKernel, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { KernelSlot } from "../../src/renderer/shell/KernelSlot";
import { pluginFeed, reconcileView } from "../../src/renderer/shell/plugin-feed";
import { ShellFrame } from "../../src/renderer/shell/ShellFrame";
import { desktop } from "../helpers";

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  reconcileView(null);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(node: ReactNode) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  unmounts.push(async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } host.remove(); });
  await act(async () => root.render(node));
  return {
    host,
    render: (next: ReactNode) => act(async () => root.render(next)),
    unmount: async () => { mounted = false; await act(async () => root.unmount()); },
  };
}

const fixture = (): PluginsView => JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView;
const held = () => rendererKernel.plugins().filter((name) => !name.startsWith(":"));
const page = createElement("main", { className: "shell" }, "page");

describe("ShellFrame and the plugin feed", () => {
  it("makes the renderer's kernel hold the plugin list the page has, and draws nothing more for it", async () => {
    const view = fixture();
    const shown = await mount(createElement(ShellFrame, { legacy: page, plugins: view }));
    expect(shown.host.innerHTML).toBe('<main class="shell">page</main>');
    expect(held()).toEqual(view.plugins.map((plugin) => plugin.name));
    expect(pluginFeed.rows("view/mainTab")).toEqual(view.mainTabs);
    expect(pluginFeed.rows("browser/tab")).toEqual(view.menus!.filter((row) => row.menu === "browser/tab"));
    // `chat/link` is botling.chat's slot since M7-06a (a test has an empty FE manifest, so the plugin is not loaded and the slot has no owner: it takes nothing).
    expect(pluginFeed.rows("chat/link")).toEqual([]);
    expect(pluginFeed.rows("app/bottom")).toEqual(view.bottomPanels);
    expect(rendererKernel.state(SHELL_SURFACE)).toBe("active");
  });

  it("follows the plugin list as it changes (`plugins.updated`) and takes it all back when the frame unmounts", async () => {
    const view = fixture();
    const shown = await mount(createElement(ShellFrame, { legacy: page, plugins: view }));
    // As the core sends it for a plugin that is off: gone from the list's `enabled` and from every array.
    const off = Object.fromEntries(Object.entries(view).map(([key, value]) => [key, Array.isArray(value) ? (value as { plugin?: string; name?: string }[]).filter((row) => row.plugin !== "zed.tools" && row.name !== "zed.tools") : value])) as unknown as PluginsView;
    await shown.render(createElement(ShellFrame, { legacy: page, plugins: off }));
    expect(held()).not.toContain("zed.tools");
    expect(pluginFeed.rows("main/tab")).toEqual(off.mainTabs);
    await shown.render(createElement(ShellFrame, { legacy: page, plugins: null }));
    expect(held()).toEqual([]);
    await shown.render(createElement(ShellFrame, { legacy: page, plugins: view }));
    expect(held()).toHaveLength(view.plugins.length);
    await shown.unmount();
    expect(rendererKernel.plugins()).toEqual([SHELL_SURFACE]);
    expect(pluginFeed.loaded()).toEqual([]);
  });

  it("holds nothing for a frame given no plugin list", async () => {
    await mount(createElement(ShellFrame, { legacy: page }));
    expect(rendererKernel.plugins()).toEqual([SHELL_SURFACE]);
  });
});

describe("KernelSlot and the feed's rows", () => {
  it("draws nothing for them, also when it is given a client to draw frames with", async () => {
    reconcileView(fixture());
    expect(rendererKernel.entries("app/bottom")).toHaveLength(2);
    const client = { request: vi.fn(async () => ({ result: null })), onEvent: () => () => {} } as unknown as Client;
    const shown = await mount(createElement(KernelSlot, { slot: "app/bottom", frames: { client } }));
    expect(shown.host.innerHTML).toBe("");
    expect(client.request).not.toHaveBeenCalled();
  });
});
