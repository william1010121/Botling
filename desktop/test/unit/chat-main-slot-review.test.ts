// @vitest-environment jsdom
// M7-07a review probes: the main tab a bot last showed across the chat plugin's load and across a hot reload (unload, load again), and the
// main column drawn while botling.chat is loading or unloading in the kernel (not only while absent), as the side region is (M7-03c).
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { feBuildManifestFile } from "../../fe-build-manifest.mjs";
import { CHAT_PLUGIN, CHAT_UNAVAILABLE } from "../../src/renderer/chat-names";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { inPageHost, InPageHost } from "../../src/renderer/shell/inpage-host";
import { parseFeManifest } from "../../src/renderer/shell/inpage-loader";
import { reconcileView } from "../../src/renderer/shell/plugin-feed";
import { regionShown } from "../../src/renderer/shell/regions";
import { drawPage, NOTE_TAB, SITE, type Page } from "../main-slot-harness";
import { desktop } from "../helpers";

const manifest = parseFeManifest(JSON.parse(feBuildManifestFile(desktop).toString("utf8")));
const chatOnly = { plugins: manifest.plugins.filter((entry) => entry.name === CHAT_PLUGIN) };
const hosts: InPageHost[] = [];
const pages: Page[] = [];
afterEach(async () => {
  for (const page of pages.splice(0)) await page.close();
  for (const one of hosts.splice(0)) await one.stop();
  reconcileView(null);
  await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); });
  vi.restoreAllMocks();
});
function host(): InPageHost {
  const made = new InPageHost({ manifest: chatOnly, log: () => undefined });
  hosts.push(made);
  vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => made.unavailable(name));
  return made;
}
const settle = (check: () => void) => act(async () => { await vi.waitFor(check); });
const pressed = (page: Page) => page.host.querySelector('.board-switch button[aria-pressed="true"]')?.getAttribute("data-tab") ?? (page.host.querySelector(".board-switch") ? "chat" : null);
const asks = (page: Page) => page.requests.filter((request) => request.type === "settings.set" && (request as { change?: { key?: string } }).change?.key === "mainTab");

describe("M7-07a review: the remembered tab", () => {
  it("P1: keeps the remembered plugin tab (its frame element) across the chat plugin's load: no flash to Chat", async () => {
    const page = await drawPage({ mainTabs: { [SITE]: NOTE_TAB } });
    pages.push(page);
    await settle(() => { expect(pressed(page)).toBe(NOTE_TAB); });
    const frame = page.host.querySelector("iframe.main-tab-frame");
    expect(frame).not.toBeNull();
    let lost = 0;
    const watch = new MutationObserver(() => { if (!page.host.contains(frame)) lost += 1; });
    watch.observe(page.host, { childList: true, subtree: true });
    const one = host();
    await act(async () => { await one.start(); });
    await settle(() => { expect(rendererKernel.entries("app/main")).toHaveLength(1); expect(rendererKernel.entries("main/tab").length).toBeGreaterThan(0); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    watch.disconnect();
    expect(pressed(page)).toBe(NOTE_TAB);
    expect(page.host.querySelector("iframe.main-tab-frame")).toBe(frame);
    expect(lost).toBe(0);
    expect(asks(page)).toEqual([]);
  });

  it("P2: a hot reload of botling.chat (unload, load again) shows the line, then the column on the remembered tab, and asks main nothing", async () => {
    const one = host();
    await one.start();
    const page = await drawPage({ mainTabs: { [SITE]: NOTE_TAB } });
    pages.push(page);
    await settle(() => { expect(pressed(page)).toBe(NOTE_TAB); });
    await act(async () => { one.unload(CHAT_PLUGIN); await vi.waitFor(() => { expect(rendererKernel.state(CHAT_PLUGIN)).toBe("absent"); }); });
    await settle(() => { expect(page.host.querySelector(".chat-unavailable [role=status]")?.textContent).toBe(CHAT_UNAVAILABLE); });
    expect(page.host.querySelector("iframe.main-tab-frame")).toBeNull();
    await act(async () => { await one.start(); });
    await settle(() => { expect(pressed(page)).toBe(NOTE_TAB); });
    expect(page.host.querySelector(".chat-unavailable")).toBeNull();
    expect(page.host.querySelector("#chat-frame")).not.toBeNull();
    expect(asks(page)).toEqual([]);
  });

  it("P3: the main column is drawn while botling.chat is loading and while it is unloading (the page as it was), not only while it is absent", async () => {
    const never = { unavailable: () => false };
    rendererKernel.install({ name: CHAT_PLUGIN });
    let open!: () => void; let release!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const hang = new Promise<void>((resolve) => { release = resolve; });
    try {
      const loaded = rendererKernel.load(CHAT_PLUGIN, async (plugin) => { rendererKernel.register(plugin, "test", "hold", () => hang); await gate; });
      expect(rendererKernel.state(CHAT_PLUGIN)).toBe("loading");
      expect(regionShown("main", "s", never), "loading").toBe(true);
      open();
      await loaded;
      expect(regionShown("main", "s", never), "active without its claim").toBe(false);
      const unloaded = rendererKernel.requestUnload(CHAT_PLUGIN);
      expect(rendererKernel.state(CHAT_PLUGIN)).toBe("unloading");
      expect(regionShown("main", "s", never), "unloading").toBe(true);
      release();
      await unloaded;
    } finally {
      open(); release();
      if (rendererKernel.state(CHAT_PLUGIN) !== "absent") await rendererKernel.requestUnload(CHAT_PLUGIN);
      rendererKernel.uninstall(CHAT_PLUGIN);
    }
  });
});
