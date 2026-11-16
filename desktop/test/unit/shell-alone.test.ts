// @vitest-environment jsdom
// The shell alone (M7-08; plan-change §4.3 check 1): with no plugin installed (the FE build's manifest lists none, no framed plugin rows) the
// shell shows only pairing, the connection state, its sheets and the fallback screen. The airplane half (0 lost, 0 doubled through the fallback)
// is test/acceptance/web-v3/shell-alone-airplane.test.ts; this is its fast part, over the same parts: the host that refuses the built-ins, and
// the page drawn with every built-in refused.
//
// What the tests found (each has a probe here that fails without its fix):
//   1. An empty manifest used to attempt nothing, so nothing was "unavailable" and the page drew the old column and rail as it was (the fallback
//      never came): a bundle built with a manifest now asks for every plugin the shell draws a surface for (shell-plugins.ts) and refuses
//      the ones the manifest lacks.
//   2. (review of 07c) With the shell's own instance not up (ShellFrame draws the page `direct`) the chat column was drawn whatever the host said, a
//      refused `botling.chat` included: it fails closed to the fallback now.
//   3. On the phone page the drawer button (`web.headerLead`) sat in the chat column's header and "This device" (`web.railFooter`) in the
//      rail, both plugin-drawn: with both away the shell's own sheet could not be opened. The fallback header and the rail's unavailable line
//      draw them now.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { rendererKernel, SHELL_SURFACE } from "../../src/renderer/renderer-kernel";
import { RegionSlot } from "../../src/renderer/shell/regions";
import { ShellFrame } from "../../src/renderer/shell/ShellFrame";
import { createRoot } from "react-dom/client";
import { inpagePluginFolders } from "../../fe-build-manifest.mjs";
import { CHAT_UNAVAILABLE } from "../../src/renderer/chat-names";
import { inPageHost, InPageHost } from "../../src/renderer/shell/inpage-host";
import { embeddedFeManifest, feManifestEmbedded } from "../../src/renderer/shell/inpage-loader";
import { SHELL_PLUGINS } from "../../src/renderer/shell/shell-plugins";
import { desktop } from "../helpers";
import { drawPage, type Page } from "../main-slot-harness";

const hosts: InPageHost[] = [];
const pages: Page[] = [];
afterEach(async () => {
  for (const page of pages.splice(0)) await page.close();
  for (const one of hosts.splice(0)) await one.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const logs: string[] = [];
const host = (options: ConstructorParameters<typeof InPageHost>[0] = {}): InPageHost => {
  const one = new InPageHost({ log: (line) => logs.push(line), source: () => { throw new Error("nothing may be run"); }, ...options });
  hosts.push(one);
  return one;
};

describe("the host with a manifest that lists no plugin", () => {
  it("names only plugins the build has a folder for", () => {
    const folders = inpagePluginFolders(desktop).map(({ name }) => name);
    expect(SHELL_PLUGINS.length).toBeGreaterThan(0);
    for (const name of SHELL_PLUGINS) expect(folders, `${name} has no folder under src/renderer/plugins`).toContain(name);
  });

  it("refuses every plugin the shell draws a surface for, runs none, and offers each to the frame host", async () => {
    const one = host({ manifest: { plugins: [] }, expected: SHELL_PLUGINS });
    const results = await one.start();
    expect(results.map((result) => [result.name, result.status])).toEqual(SHELL_PLUGINS.map((name) => [name, "refused"]));
    expect(results.every((result) => result.status === "refused" && result.reason === "not-in-manifest")).toBe(true);
    expect(one.loaded()).toEqual([]);
    for (const name of SHELL_PLUGINS) expect(one.unavailable(name), name).toBe(true);
    expect(one.offered().map((offer) => offer.name)).toEqual([...SHELL_PLUGINS]);
  });

  it("still loads a plugin the manifest lists, and refuses only the ones it lacks", async () => {
    const listed = SHELL_PLUGINS[0]!;
    const hash = "c".repeat(64);
    const one = host({ manifest: { plugins: [{ name: listed, codeHash: hash }] }, expected: SHELL_PLUGINS, source: () => ({ activate: () => undefined }) });
    // Before the answers: a listed plugin is about to load ("undecided", no fallback flash); only the ones the manifest lacks are away already.
    expect(one.unavailable(listed)).toBe(false);
    for (const name of SHELL_PLUGINS.slice(1)) expect(one.unavailable(name), name).toBe(true);
    const results = await one.start();
    expect(results.find((result) => result.name === listed)?.status).toBe("loaded");
    expect(one.unavailable(listed)).toBe(false);
    for (const name of SHELL_PLUGINS.slice(1)) expect(one.unavailable(name), name).toBe(true);
    expect(results).toHaveLength(SHELL_PLUGINS.length);
  });

  it("attempts nothing when the bundle has no manifest at all (a test, a build without one): the page as it was", async () => {
    expect(feManifestEmbedded()).toBe(false);
    const one = host();
    expect(await one.start()).toEqual([]);
    for (const name of SHELL_PLUGINS) expect(one.unavailable(name)).toBe(false);
  });

  it("asks for the shell's plugins by default exactly when the bundle carries a manifest, even an empty one", async () => {
    vi.stubGlobal("__FE_MANIFEST__", JSON.stringify({ version: 1, plugins: [] }));
    expect(feManifestEmbedded()).toBe(true);
    expect(embeddedFeManifest().plugins).toEqual([]);
    const one = host();
    const results = await one.start();
    expect(results.map((result) => result.name)).toEqual([...SHELL_PLUGINS]);
    for (const name of SHELL_PLUGINS) expect(one.unavailable(name), name).toBe(true);
  });

  it("counts an unreadable or malformed manifest as one that lists nothing: the shell's plugins are refused (fail closed)", async () => {
    for (const text of ["{not json", JSON.stringify({ version: 1 })]) {
      vi.stubGlobal("__FE_MANIFEST__", text);
      expect(feManifestEmbedded(), text).toBe(true);
      expect(embeddedFeManifest().plugins, text).toEqual([]);
      const one = host();
      await one.start();
      for (const name of SHELL_PLUGINS) expect(one.unavailable(name), `${text} ${name}`).toBe(true);
    }
  });
});

describe("the page with every in-page built-in refused", () => {
  const chrome = {
    headerLead: createElement("button", { type: "button", className: "web-nav-button", "aria-label": "Bots" }),
    railFooter: createElement("button", { type: "button", className: "rail-button web-sign-out" }, "This device"),
  };
  const draw = async (web = chrome): Promise<Page> => {
    const refusing = host({ manifest: { plugins: [] }, expected: SHELL_PLUGINS });
    vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => refusing.unavailable(name));
    await refusing.start();
    const page = await drawPage({ web });
    pages.push(page);
    return page;
  };
  const settle = (check: () => void) => act(async () => { await vi.waitFor(check); });

  it("shows the fallback screen, the shell's own lines where the plugins were, and nothing a plugin draws", async () => {
    const page = await draw();
    await settle(() => { expect(page.host.querySelector(".chat-fallback")).not.toBeNull(); });
    expect(page.host.querySelector(".chat-fallback [role=status]")?.textContent).toBe(CHAT_UNAVAILABLE);
    expect(page.host.querySelector("aside.rail.rail-unavailable [role=status]")?.textContent).toBe("The sidebar is unavailable.");
    // Nothing the plugins draw: no chat frame (or any frame), no bot rows of the rail, no search box.
    expect(page.host.querySelectorAll("iframe")).toHaveLength(0);
    for (const selector of ["#chat-frame", ".chat-frame", ".bot-row", ".rail-search", ".rail-add"]) expect(page.host.querySelector(selector), selector).toBeNull();
    // The fallback is the way into a chat: its bot list and its plain box.
    expect(page.host.querySelector(".fallback-bots")).not.toBeNull();
    expect(page.host.querySelector(".fallback-input textarea")).not.toBeNull();
  });

  it("keeps the shell's own sheet reachable on the browser page: the drawer button in the fallback's header, \"This device\" in the rail's line", async () => {
    const page = await draw();
    await settle(() => { expect(page.host.querySelector(".chat-fallback")).not.toBeNull(); });
    expect(page.host.querySelector(".chat-fallback .chat-header .web-nav-button")).not.toBeNull();
    const footer = page.host.querySelector("aside.rail-unavailable .web-rail-footer button");
    expect(footer?.textContent).toBe("This device");
  });

  it("draws neither on the desktop's page (no browser chrome): the fallback without the drawer button, the unavailable line without a footer", async () => {
    const refusing = host({ manifest: { plugins: [] }, expected: SHELL_PLUGINS });
    vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => refusing.unavailable(name));
    await refusing.start();
    const page = await drawPage();
    pages.push(page);
    await settle(() => { expect(page.host.querySelector(".chat-fallback")).not.toBeNull(); });
    expect(page.host.querySelector(".web-nav-button")).toBeNull();
    expect(page.host.querySelector("aside.rail-unavailable .web-rail-footer")).toBeNull();
  });

  it("is the shell alone from the first paint, before the host has started (no frame of the old column or the plugin's rail)", async () => {
    // The frame starts the host in an effect, after its first commit: the page's first paint must not wait for the loader's answers.
    const fresh = host({ manifest: { plugins: [] }, expected: SHELL_PLUGINS });
    for (const name of SHELL_PLUGINS) expect(fresh.unavailable(name), name).toBe(true);
    vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => fresh.unavailable(name));
    const page = await drawPage({ web: chrome });
    pages.push(page);
    expect(page.host.querySelector(".chat-fallback")).not.toBeNull();
    expect(page.host.querySelector("aside.rail.rail-unavailable")).not.toBeNull();
    for (const selector of ["iframe", ".chat-frame", ".bot-row", ".rail-search"]) expect(page.host.querySelector(selector), selector).toBeNull();
    expect(fresh.loaded()).toEqual([]);
  });

  it("is what a host that never refused is not: the same page, no plugin touched, draws the old column (the page as it was)", async () => {
    const untouched = host({ manifest: { plugins: [] } });
    await untouched.start();
    vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => untouched.unavailable(name));
    const page = await drawPage({ web: chrome });
    pages.push(page);
    await settle(() => { expect(page.host.querySelector(".chat-pane")).not.toBeNull(); });
    expect(page.host.querySelector(".chat-fallback")).toBeNull();
    expect(page.host.querySelector("aside.rail-unavailable")).toBeNull();
  });
});

describe("the frame drawn directly (the shell's own kernel instance is not up)", () => {
  const column = (label: string) => createElement("main", { className: "page" }, createElement(RegionSlot, { region: "main" }), createElement("i", { className: "tail" }, label));
  const mount = async (host: InPageHost | null) => {
    await rendererKernel.requestUnload(SHELL_SURFACE);
    restore.push(async () => { await rendererKernel.load(SHELL_SURFACE); });
    expect(rendererKernel.state(SHELL_SURFACE)).toBe("absent");
    if (host) vi.spyOn(inPageHost, "unavailable").mockImplementation((name) => host.unavailable(name));
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    restore.push(async () => { await act(async () => root.unmount()); node.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });
    await act(async () => root.render(createElement(ShellFrame, { legacy: column("x"), regions: { main: createElement("section", { className: "old-column" }, "the chat column"), away: { parts: {} } } })));
    return node;
  };
  const restore: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const undo of restore.splice(0).reverse()) await undo(); });

  it("draws the fallback, not the chat column, once the host says botling.chat was refused (fail closed)", async () => {
    const refusing = host({ manifest: { plugins: [] }, expected: SHELL_PLUGINS });
    await refusing.start();
    const node = await mount(refusing);
    expect(node.querySelector(".chat-fallback")).not.toBeNull();
    expect(node.querySelector(".old-column")).toBeNull();
    expect(node.querySelector(".tail")).not.toBeNull();
  });

  it("still draws the page as it was when the host has said nothing (no shell, no manifest)", async () => {
    const node = await mount(null);
    expect(node.querySelector(".old-column")).not.toBeNull();
    expect(node.querySelector(".chat-fallback")).toBeNull();
  });
});
