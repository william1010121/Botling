// @vitest-environment jsdom
// M7-07d: the phone/browser page runs the same plugin bundle as the desktop window, and a contribution that needs a shell function the page
// does not have (`needsShell`, plan-change §4.3 check 6) is hidden there or says "Not available on this device".
//   1. The page's `needsShell` list (`pageNeedsShell`): what a page offers, and what it never does (`openFile`).
//   2. KernelSlot: a fixture contribution needing `openFile` is hidden on the page (or says so), and shown on the desktop (no provider); a
//      contribution needing only what the page offers is shown; a value that is not a list of strings fails closed.
//   3. A headless page (BridgeV3 over a fake adapter, the renderer's own Client and frames): the Note tab (MainTabFrame) and a settings block
//      (SlotFrame) get their frame, whose page is made by the page itself and handed to the host page by its token; the reads they make
//      (`plugins.panel`) go through, `plugins.web` and `card.page` without the capability stay "not available".
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION, type Command } from "../../src/contract";
import { REMOTE_READS } from "../../src/protocol";
import { Client } from "../../src/renderer/client";
import { MainTabFrame, SlotFrame } from "../../src/renderer/Plugins";
import { rendererKernel } from "../../src/renderer/renderer-kernel";
import { KernelSlot, missingShell, NOT_AVAILABLE_HERE, ShellCapabilitiesProvider, type SlotEntry } from "../../src/renderer/shell/KernelSlot";
import { BridgeV3, NOT_AVAILABLE, pageNeedsShell, pageRefusal, type AdapterPort, type PageCapabilities } from "../../web-v3/bridge-v3";
import { FramePages, KEPT_PAGES, tokenOf } from "../../web-v3/shell/frame-pages";

const unmounts: (() => Promise<void>)[] = [];
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(node: ReactNode) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let mounted = true;
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } host.remove(); };
  unmounts.push(unmount);
  await act(async () => root.render(node));
  return { host, render: async (next: ReactNode) => { await act(async () => root.render(next)); }, unmount };
}

/** A plugin in the renderer kernel contributing `entry` to `app/side`; unloaded after the test. */
function contributor(name: string, entry: SlotEntry) {
  rendererKernel.install({ name, contributes: { slots: ["app/side"] } });
  void rendererKernel.load(name, (plugin) => { rendererKernel.contribute(plugin, "app/side", entry); });
  cleanups.push(async () => { await rendererKernel.requestUnload(name); rendererKernel.uninstall(name); });
}

const BASE = "https://botling.test/v3/";
const pageCaps = (over: Partial<PageCapabilities> = {}): PageCapabilities => ({ openLink: () => undefined, narrow: () => true, scopes: ["read", "reply"], ...over });
const text = (host: HTMLElement) => host.textContent ?? "";

describe("the page's needsShell list", () => {
  it("offers openLink always, uploads and framePage only with their port, and never openFile", () => {
    expect([...pageNeedsShell(pageCaps())].sort()).toEqual(["openLink"]);
    expect([...pageNeedsShell(pageCaps({ uploads: {} as never, framePage: () => "x" }))].sort()).toEqual(["framePage", "openLink", "uploads"]);
    expect(pageNeedsShell(pageCaps({ uploads: {} as never, framePage: () => "x" })).has("openFile" as never)).toBe(false);
  });

  it("missingShell: the desktop (no set) misses nothing; the page misses what it lacks; a malformed list fails closed", () => {
    const page = pageNeedsShell(pageCaps());
    expect(missingShell(["openFile"], null)).toEqual([]);
    expect(missingShell(undefined, page)).toEqual([]);
    expect(missingShell([], page)).toEqual([]);
    expect(missingShell(["openLink"], page)).toEqual([]);
    expect(missingShell(["openLink", "openFile"], page)).toEqual(["openFile"]);
    expect(missingShell("openFile", page)).toEqual(["?"]);
    expect(missingShell([1, "openLink"], page)).toEqual(["?"]);
    expect(missingShell({ length: 0 }, page)).toEqual(["?"]);
  });
});

describe("KernelSlot and needsShell", () => {
  const entry = (label: string, extra: Partial<SlotEntry> = {}): SlotEntry => ({ kind: "component", render: () => createElement("i", { "data-label": label }, label), ...extra }) as SlotEntry;
  const labels = (host: HTMLElement) => [...host.querySelectorAll("i")].map((node) => node.textContent);
  const onPage = pageNeedsShell(pageCaps());

  it("shows a contribution that needs openFile on the desktop (no provider), hides it on the page, and shows the rest of the slot there", async () => {
    contributor("fixture.opens", entry("opens", { needsShell: ["openFile"] }));
    contributor("fixture.plain", entry("plain"));
    contributor("fixture.link", entry("link", { needsShell: ["openLink"] }));
    const desktop = await mount(createElement(KernelSlot, { slot: "app/side" }));
    expect(labels(desktop.host)).toEqual(["opens", "plain", "link"]);
    const page = await mount(createElement(ShellCapabilitiesProvider, { value: onPage }, createElement(KernelSlot, { slot: "app/side" })));
    expect(labels(page.host)).toEqual(["plain", "link"]);
    expect(text(page.host)).not.toContain(NOT_AVAILABLE_HERE);
  });

  it("says 'Not available on this device' in its place when the contribution asks for it (whenMissing: say), naming what is missing", async () => {
    contributor("fixture.says", entry("says", { needsShell: ["openFile", "openLink"], whenMissing: "say", title: "Files" } as Partial<SlotEntry>));
    const page = await mount(createElement(ShellCapabilitiesProvider, { value: onPage }, createElement(KernelSlot, { slot: "app/side" })));
    const line = page.host.querySelector(".plugin-unavailable");
    expect(line?.textContent).toBe(`Files: ${NOT_AVAILABLE_HERE}`);
    expect(line?.getAttribute("data-needs-shell")).toBe("openFile");
    expect(labels(page.host)).toEqual([]);
    const desktop = await mount(createElement(KernelSlot, { slot: "app/side" }));
    expect(labels(desktop.host)).toEqual(["says"]);
    expect(desktop.host.querySelector(".plugin-unavailable")).toBeNull();
  });

  it("hides a frame entry that needs openFile on the page, and draws it on the desktop", async () => {
    contributor("fixture.frame", { kind: "frame", frame: "slot", plugin: "acme.files", view: "acme.files.view", title: "Files", needsShell: ["openFile"] });
    const client = { request: vi.fn(async (command: { type: string }) => command.type === "plugins.list" ? { plugins: [] } : { title: "t", source: "", settings: {} }), onEvent: () => () => {} } as unknown as Client;
    const page = await mount(createElement(ShellCapabilitiesProvider, { value: onPage }, createElement(KernelSlot, { slot: "app/side", frames: { client } })));
    expect(page.host.querySelector(".plugin-slot")).toBeNull();
    expect(client.request).not.toHaveBeenCalled(); // a frame that is not drawn never asks for its source
    const desktop = await mount(createElement(KernelSlot, { slot: "app/side", frames: { client } }));
    expect(desktop.host.querySelector(".plugin-slot")?.getAttribute("data-plugin")).toBe("acme.files");
  });

  it("fails closed on the page for a needsShell that is not a list of strings", async () => {
    contributor("fixture.odd", entry("odd", { needsShell: "openLink" as never }));
    const page = await mount(createElement(ShellCapabilitiesProvider, { value: onPage }, createElement(KernelSlot, { slot: "app/side" })));
    expect(labels(page.host)).toEqual([]);
  });
});

describe("the frame's page, made by the page itself", () => {
  const html = "<!doctype html><html><head></head><body><script>1</script></body></html>";

  it("answers a url on the host page with an unguessable token, and hands the page to the frame of that token only", async () => {
    const pages = new FramePages(document, BASE);
    const stop = pages.start();
    cleanups.push(stop);
    const url = pages.make(html, true);
    expect(url).toMatch(/^https:\/\/botling\.test\/v3\/frame-host\.html#ccb-page=[0-9a-f]{32}$/);
    expect(pages.make(html)).not.toBe(url);
    const make = (src: string) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("src", src);
      const post = vi.fn();
      Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
      document.body.append(frame);
      cleanups.push(() => frame.remove());
      return { frame, post };
    };
    const mine = make(url);
    mine.frame.dispatchEvent(new Event("load"));
    expect(mine.post).toHaveBeenCalledTimes(1);
    const [message, target] = mine.post.mock.calls[0]!;
    expect(target).toBe("*");
    expect(message.botlingHost).toBe("page");
    expect(message.html).toContain("Content-Security-Policy");
    expect(message.html).toContain("<script>1</script>");
    // A token this page never made, another file, another origin and a plain url get nothing.
    for (const src of [`${BASE}frame-host.html#ccb-page=${"0".repeat(32)}`, `${BASE}other.html#ccb-page=${url.slice(-32)}`, `https://evil.test/v3/frame-host.html#ccb-page=${url.slice(-32)}`, `${BASE}frame-host.html`, "about:blank"]) {
      const other = make(src);
      other.frame.dispatchEvent(new Event("load"));
      expect(other.post, src).not.toHaveBeenCalled();
    }
    // After stop nobody is served.
    stop();
    const late = make(url);
    late.frame.dispatchEvent(new Event("load"));
    expect(late.post).not.toHaveBeenCalled();
  });

  it("keeps only the newest KEPT_PAGES pages, and tokenOf reads only its own urls", () => {
    const pages = new FramePages(document, BASE);
    const urls = Array.from({ length: KEPT_PAGES + 3 }, () => pages.make(html));
    expect(tokenOf(urls[0], BASE)).toMatch(/^[0-9a-f]{32}$/);
    expect(tokenOf("not a url at all", "not a base")).toBeNull();
    expect(tokenOf(null, BASE)).toBeNull();
  });

  // Review (M7-07d): the guards above that no test pinned yet.
  const framed = (src: string, tag = "iframe") => {
    const frame = document.createElement(tag);
    frame.setAttribute("src", src);
    const post = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage: post } });
    document.body.append(frame);
    cleanups.push(() => frame.remove());
    frame.dispatchEvent(new Event("load"));
    return post;
  };

  it("serves nothing for a page pushed out by newer ones, and still serves the newest", () => {
    const pages = new FramePages(document, BASE);
    cleanups.push(pages.start());
    const urls = Array.from({ length: KEPT_PAGES + 3 }, () => pages.make(html));
    for (const old of urls.slice(0, 3)) expect(framed(old)).not.toHaveBeenCalled();
    expect(framed(urls[3]!)).toHaveBeenCalledTimes(1);
    expect(framed(urls[urls.length - 1]!)).toHaveBeenCalledTimes(1);
  });

  it("forgets its pages on stop: started again, an old token gets nothing; an element that is not an iframe gets nothing", () => {
    const pages = new FramePages(document, BASE);
    const stop = pages.start();
    const url = pages.make(html);
    expect(framed(url, "div")).not.toHaveBeenCalled();
    stop();
    cleanups.push(pages.start());
    expect(framed(url)).not.toHaveBeenCalled();
    expect(framed(pages.make(html))).toHaveBeenCalledTimes(1);
  });

  it("missingShell fails closed for null on the page", () => {
    expect(missingShell(null, pageNeedsShell(pageCaps()))).toEqual(["?"]);
  });
});

describe("a headless page runs plugin frames", () => {
  /** The page's side: the bridge over a fake adapter that answers what a server would, and the renderer's own Client over it. */
  function headless(capabilities: PageCapabilities) {
    const asked: Command[] = [];
    const adapter: AdapterPort = {
      request: async (cmd: Command) => {
        asked.push(cmd);
        if (cmd.type === "plugins.panel") return { ok: true, result: { title: cmd.name, source: `export function activate() { /* ${cmd.name} */ }`, settings: {} } };
        return { ok: false, error: { code: "bad_request", message: "no" } };
      },
    } as unknown as AdapterPort;
    const bridge = new BridgeV3(adapter, capabilities);
    const client = new Client(bridge);
    cleanups.push(() => bridge.close());
    return { client, asked, bridge };
  }
  const pages = () => { const made = new FramePages(document, BASE); cleanups.push(made.start()); return made; };

  it("renders the Note tab: its iframe is on the host page with the page the plugin's source made", async () => {
    const made = pages();
    const { client, asked } = headless(pageCaps({ framePage: (html, panel) => made.make(html, panel) }));
    const tab = await mount(createElement(MainTabFrame, { client, plugin: "botling.note", view: "botling.note.tab", title: "Note", onBuiltin: () => undefined }));
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(tab.host.querySelector(".plugins-problem")).toBeNull();
    const frame = tab.host.querySelector<HTMLIFrameElement>("iframe.main-tab-frame");
    expect(frame?.getAttribute("src")).toMatch(/^https:\/\/botling\.test\/v3\/frame-host\.html#ccb-page=[0-9a-f]{32}$/);
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(asked.map((cmd) => cmd.type)).toEqual(["plugins.panel"]);
    const post = vi.fn();
    Object.defineProperty(frame!, "contentWindow", { value: { postMessage: post }, configurable: true });
    frame!.dispatchEvent(new Event("load"));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]![0].html).toContain("botling.note");
  });

  it("renders a settings block (SlotFrame) the same way", async () => {
    const made = pages();
    const { client } = headless(pageCaps({ framePage: (html, panel) => made.make(html, panel) }));
    const block = await mount(createElement(SlotFrame, { client, plugin: "acme.settings", view: "acme.settings.section", title: "Acme", fontSize: 15 }));
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(block.host.querySelector(".plugins-problem")).toBeNull();
    expect(block.host.querySelector(".plugin-slot")?.getAttribute("data-plugin")).toBe("acme.settings");
    expect(block.host.querySelector("iframe.plugin-slot-frame")?.getAttribute("src")).toContain("frame-host.html#ccb-page=");
  });

  it("says 'not available' (no frame) when the page cannot make frame pages, and sends nothing for card.page to the server", async () => {
    const { client, asked } = headless(pageCaps());
    const tab = await mount(createElement(MainTabFrame, { client, plugin: "botling.note", view: "botling.note.tab", title: "Note", onBuiltin: () => undefined }));
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(tab.host.querySelector("iframe")).toBeNull();
    expect(tab.host.querySelector(".plugins-problem")?.textContent).toBe(NOT_AVAILABLE);
    expect(asked.some((cmd) => cmd.type === "card.page")).toBe(false);
  });

  it("answers card.page itself, with or without a plugin's via, and refuses a failing maker", async () => {
    const framePage = vi.fn((html: string, panel: boolean) => `u:${panel}:${html.length}`);
    const { bridge, asked } = headless(pageCaps({ framePage }));
    const heard: any[] = [];
    bridge.subscribe((message) => heard.push(message));
    bridge.post({ v: PROTOCOL_VERSION, id: "a", cmd: { type: "card.page", html: "<p>x</p>", panel: true } } as never);
    bridge.post({ v: PROTOCOL_VERSION, id: "b", cmd: { type: "card.page", html: "<p>y</p>" } } as never, { plugin: "acme.tool" } as never);
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(heard.map((message) => message.result ?? message.error)).toEqual([{ url: "u:true:8" }, { url: "u:false:8" }]);
    expect(asked).toEqual([]);
    framePage.mockImplementationOnce(() => { throw new Error("no"); });
    bridge.post({ v: PROTOCOL_VERSION, id: "c", cmd: { type: "card.page", html: "<p>z</p>" } } as never);
    await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    expect(heard[2]).toMatchObject({ error: { code: "bad_request" } });
  });

  it("lets a read device ask for a plugin's panel source, and still refuses plugins.web, other reads and a device without the read scope", () => {
    expect(REMOTE_READS.has("plugins.panel")).toBe(true);
    const panel = { type: "plugins.panel", name: "botling.note", panel: "botling.note.tab" } as Command;
    expect(pageRefusal(panel, { scopes: ["read"] })).toBeNull();
    expect(pageRefusal(panel, { scopes: ["reply"] })).toBe(NOT_AVAILABLE);
    expect(REMOTE_READS.has("plugins.web")).toBe(false);
    expect(pageRefusal({ type: "plugins.web" } as Command, { scopes: ["read"] })).toBe(NOT_AVAILABLE);
    expect(pageRefusal({ type: "plugins.list" } as Command, { scopes: ["read"] })).toBe(NOT_AVAILABLE);
    expect(pageRefusal({ type: "card.page", html: "x" } as Command, { scopes: ["read", "reply", "approve", "manage"] })).toBe(NOT_AVAILABLE);
  });
});
