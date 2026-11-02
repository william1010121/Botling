// @vitest-environment jsdom
// The two places a plugin's view can sit inside the app page's own surfaces: a page of Settings (`settings.section`) and a
// block in the sidebar gear's popover (`quickSettings`). Each is the plugin's sandboxed frame, sized to its content
// (the frame's `resize`); without such a plugin neither shows anything, and the popover is placed as before.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginsView } from "../../src/contract";
import { settingsView } from "../../src/core/settings";
import type { Client } from "../../src/renderer/client";
import { SettingsSheet } from "../../src/renderer/Settings";
import { SidebarSettings } from "../../src/renderer/SidebarSettings";
import { panelPage } from "../../src/renderer/panel-page";

const plugins: PluginsView = {
  plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null,
  settingsSections: [{ plugin: "meter", id: "meter.page", title: "Meter", terms: "quota rings", after: "engines", link: "Meter by bot" }],
  quickSettings: [{ plugin: "meter", id: "meter.rings", title: "Rings" }],
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

function client() {
  const requests: any[] = [];
  const request = vi.fn(async (command: any) => {
    requests.push(command);
    if (command.type === "plugins.panel") return { title: "t", source: "export const activate = () => {};", settings: {} };
    if (command.type === "card.page") return { url: `botling-card://page/${requests.length}` };
    return settingsView({});
  });
  return { requests, client: { request, onEvent: () => () => {} } as unknown as Client };
}
const frameOf = () => host.querySelector<HTMLIFrameElement>("iframe.plugin-slot-frame");
const resizeTo = async (height: number) => {
  const frame = frameOf()!;
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { data: { ccb: "resize", height }, origin: "null", source: frame.contentWindow })); });
};

it("Settings: a plugin's page follows the core page it names, is found by its terms, and its frame is sized to its content", async () => {
  const { client: c, requests } = client();
  await act(async () => root.render(createElement(SettingsSheet, { client: c, settings: settingsView({}), bot: null, plugins, onClose() {} })));
  const tabs = () => [...host.querySelectorAll(".settings-tab")].map((tab) => tab.textContent?.replace("New", ""));
  expect(tabs().slice(0, 4)).toEqual(["General", "Appearance", "Engines and subagents", "Meter"]);
  expect(tabs()).not.toContain("Usage");
  const search = host.querySelector<HTMLInputElement>(".settings-search")!;
  const type = async (value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, value); search.dispatchEvent(new Event("input", { bubbles: true })); });
  await type("rings");
  expect(tabs()).toEqual(["Meter"]);
  expect(host.querySelector(".settings-header h2")?.textContent).toBe("Meter");
  await vi.waitFor(() => expect(frameOf()).not.toBeNull());
  expect(requests).toContainEqual({ type: "plugins.panel", name: "meter", panel: "meter.page" });
  expect(frameOf()!.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frameOf()!.style.height).toBe("0px");
  await resizeTo(321);
  expect(frameOf()!.style.height).toBe("321px");
});

it("Settings: without a plugin page the core pages are the same, and Usage is not one of them", async () => {
  const { client: c } = client();
  await act(async () => root.render(createElement(SettingsSheet, { client: c, settings: settingsView({}), bot: null, plugins: null, onClose() {} })));
  expect([...host.querySelectorAll(".settings-tab")].map((tab) => tab.textContent?.replace("New", ""))).toEqual(
    ["General", "Appearance", "Engines and subagents", "Reports and results", "Plugins", "Doctor", "Updates", "Shortcuts", "Phone", "Developer"]);
  expect(frameOf()).toBeNull();
});

it("the gear popover draws each quickSettings block above the switch, links to the plugin's page, and opens it by its qualified id", async () => {
  const { client: c, requests } = client();
  const onOpen = vi.fn();
  await act(async () => root.render(createElement(SidebarSettings, { client: c, settings: settingsView({}), plugins, settingsOpen: false, onOpen })));
  expect(frameOf()).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Quick settings"]')!.click());
  await vi.waitFor(() => expect(frameOf()).not.toBeNull());
  expect(requests).toContainEqual({ type: "plugins.panel", name: "meter", panel: "meter.rings" });
  const popover = host.querySelector(".sidebar-settings-popover")!;
  const order = [...popover.children].map((child) => child.className || child.tagName.toLowerCase());
  expect(order.indexOf("plugin-slot")).toBeLessThan(order.indexOf("sidebar-settings-switch"));
  const link = [...popover.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Meter by bot"))!;
  const labels = [...popover.querySelectorAll(".sidebar-settings-links button")].map((button) => button.textContent);
  expect(labels.indexOf(link.textContent)).toBe(1); // after Plugins, before Developer settings
  await act(async () => link.click());
  expect(onOpen).toHaveBeenLastCalledWith("meter/meter.page");
});

it("the gear popover without plugin blocks has no frame and no extra link", async () => {
  const { client: c } = client();
  await act(async () => root.render(createElement(SidebarSettings, { client: c, settings: settingsView({}), plugins: null, settingsOpen: false, onOpen() {} })));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Quick settings"]')!.click());
  expect(frameOf()).toBeNull();
  expect([...host.querySelectorAll(".sidebar-settings-links button")].map((button) => button.textContent)).toHaveLength(3);
});

it("repositions the popup when a block's height changes after it was placed", async () => {
  let resize!: () => void;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect = disconnect;
  });
  let height = 300;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { top: this.classList.contains("strip-gear") ? 700 : 0, left: 24, right: 48,
      width: 300, height: this.classList.contains("sidebar-settings-popover") ? height : 24 } as DOMRect;
  });
  const { client: c } = client();
  await act(async () => root.render(createElement(SidebarSettings, { client: c, settings: null, plugins: null, settingsOpen: false, onOpen() {} })));
  const toggle = async () => act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Quick settings"]')!.click());
  await toggle();
  const popup = () => host.querySelector<HTMLElement>(".sidebar-settings-popover")!;
  expect(popup().style.top).toBe("392px");
  height = 500;
  await act(async () => resize());
  expect(popup().style.top).toBe("192px");
  await toggle();
  expect(disconnect).toHaveBeenCalledOnce();
});

it("a fit page sizes to its content and tells the page; an ordinary panel page does not", () => {
  const fit = panelPage("meter", "meter.rings", "export const activate = () => {}", {}, { fontSize: 14 });
  expect(fit).toContain('const FIT = true');
  expect(fit).toContain('post({ ccb: "resize", height })');
  expect(fit).toContain("background: transparent");
  expect(fit).toContain("14px/1.5");
  const panel = panelPage("meter", "meter.rings", "export const activate = () => {}", {});
  expect(panel).toContain("const FIT = false");
  expect(panel).toContain("#panel-root { padding: 12px;");
});

it("a page is told which bot it is about (ccb.context), and has none otherwise", () => {
  const page = panelPage("botling.git", "botling.git.worktrees", "export const activate = () => {}", {}, { fontSize: 13 }, { botId: "B1" });
  expect(page).toContain('const CONTEXT = Object.freeze({"botId":"B1"});');
  expect(page).toContain("context: CONTEXT,");
  expect(panelPage("meter", "meter.rings", "export const activate = () => {}", {})).toContain("const CONTEXT = Object.freeze({});");
});
