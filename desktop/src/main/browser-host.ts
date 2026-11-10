// The in-app browser pane's pages (phase 1): one WebContentsView per tab, in the window beside the chat, under
// the tabs the app page draws (browser-tabs.ts keeps the list; the app page sends bounds over BROWSER_CHANNEL).
//
// Every page is an ordinary website and gets nothing of the app's: its own session ('persist:botling-web', so
// sign-ins last but share nothing with the app's pages), sandboxed, context-isolated, no Node and no preload.
// Only http(s) loads; a site's popup (window.open, target=_blank) becomes a new tab; every permission it asks
// for (camera, notifications, location, …) is refused.
//
// Phase 2: every tab's network traffic is captured in the background (the DevTools protocol's Network domain on its
// page, kept in a bounded NetCapture, browser-bot.ts) for the bot tools; no panel shows it. A bot's extraction runs
// in an isolated world (EXTRACT_WORLD) and the page may not navigate while it runs.
import { BrowserWindow, Menu, WebContentsView, app, clipboard, dialog, session, shell, type Session, type WebContents } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BROWSER_CHANNEL, isWebUrl, urlFromInput, type BrowserDown, type BrowserMenuPick, type BrowserRect, type BrowserToolRun, type BrowserUp } from "../browser-wire";
import { runOptions, siteOf, toolIsOn, toolsFor, type RunFile, type SiteToolOptions } from "../browser-site-tools";
import { NetCapture } from "../browser-bot";
import type { BotBrowserWindow } from "./browser-bot-host";
import { BrowserTabs, type TabPage } from "./browser-tabs";
import { editorBounds } from "./editor-host";
import { runSiteTool } from "./site-tool-runner";
import type { SiteToolStore } from "./site-tools";

export const BROWSER_PARTITION = "persist:botling-web";
/** The top edge of a page, in px, where the pointer brings out the floating toolbar. */
const EDGE = 6;
const FAVICON_MAX = 64_000;
/** The isolated world bot extractions run in (site tools use their own). */
export const EXTRACT_WORLD = 1077;
const EXTRACT_TIMEOUT_MS = 15_000;

const SECURE = {
  partition: BROWSER_PARTITION,
  sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, nodeIntegrationInWorker: false,
  webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, safeDialogs: true, spellcheck: true,
} as const;

let hardened = false;
/** The pane's session: every permission refused, both the asking and the checking. */
export function browserSession(): Session {
  const web = session.fromPartition(BROWSER_PARTITION);
  if (!hardened) {
    hardened = true;
    web.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    web.setPermissionCheckHandler(() => false);
    if (typeof web.setDevicePermissionHandler === "function") web.setDevicePermissionHandler(() => false);
  }
  return web;
}

export interface BrowserHostOptions {
  note(text: string): void;
  /** Tests: never open the default browser. */
  noExternal?: boolean;
  /** Site tools (site-tools.ts), shared by every window. */
  tools?: SiteToolStore;
  /** Tests: files a tool saves go here, with no save dialog. */
  saveFolder?: string;
}

export interface BrowserHost {
  /** A link the user (or a plugin) opened for a bot: a tab, and the pane shows. */
  open(botId: string, url: string): void;
  receive(message: BrowserUp): void;
  closeBot(botId: string): void;
  tabs: BrowserTabs;
  /** What the bot tools read (browser-bot-host.ts). */
  bot: BotBrowserWindow;
  dispose(): void;
}

/** The browser of one app window. */
export function createBrowserHost(owner: BrowserWindow, options: BrowserHostOptions): BrowserHost {
  const send = (message: BrowserDown) => { if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send(BROWSER_CHANNEL, message); };
  let fullscreen = false;
  let htmlFull: WebContentsView | null = null;
  let lastBounds: BrowserRect | null = null;
  const views = new Map<string, WebContentsView>();
  const execs = new Map<string, (worldId: number, code: string) => Promise<unknown>>();
  const running = new Set<string>();
  const captures = new Map<string, NetCapture>();
  /** Tabs a bot's extraction runs in now: their page may not navigate. */
  const extracting = new Set<string>();

  const tabs: BrowserTabs = new BrowserTabs({
    create: (botId, tabId) => makePage(botId, tabId),
    onChange: (state, reveal) => send({ type: "state", ...state, ...(reveal ? { reveal: true } : {}) }),
  });

  function makePage(botId: string, tabId: string): TabPage {
    browserSession();
    const view = new WebContentsView({ webPreferences: { ...SECURE } });
    const contents = view.webContents;
    view.setBackgroundColor("#FFFFFF");
    view.setVisible(false);
    // Just above the app page's own view and under every other one: the native chat stays on top of it.
    const children = owner.contentView.children;
    const shellIndex = children.findIndex((child) => (child as Partial<WebContentsView>).webContents === owner.webContents);
    owner.contentView.addChildView(view, shellIndex + 1);
    views.set(tabId, view);
    // Site tools run in an isolated world of the page: they see its DOM, never its scripts, and it never sees them.
    execs.set(tabId, (worldId, code) => contents.isDestroyed() ? Promise.reject(new Error("the page is gone")) : contents.executeJavaScriptInIsolatedWorld(worldId, [{ code }], true));
    wire(botId, tabId, view, contents);
    capture(tabId, contents);
    return {
      load: (url) => { if (isWebUrl(url)) void contents.loadURL(url).catch(() => {}); },
      back: () => { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); },
      forward: () => { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); },
      reload: () => contents.reload(),
      stop: () => contents.stop(),
      canGoBack: () => !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: () => !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      show: (bounds) => { lastBounds = bounds; if (htmlFull !== view) view.setBounds(bounds); view.setVisible(true); },
      hide: () => { view.setVisible(false); },
      focus: () => { if (!contents.isDestroyed()) contents.focus(); },
      destroy: () => {
        views.delete(tabId);
        execs.delete(tabId);
        captures.delete(tabId);
        extracting.delete(tabId);
        try { if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach(); } catch { /* going anyway */ }
        if (htmlFull === view) htmlFull = null;
        if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
        if (!contents.isDestroyed()) contents.close();
      },
    };
  }

  function wire(botId: string, tabId: string, view: WebContentsView, contents: WebContents) {
    const update = (change: Parameters<BrowserTabs["update"]>[2]) => tabs.update(botId, tabId, change);
    // A popup or target=_blank: a new tab of the same bot (web pages only), never a window of its own.
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) setImmediate(() => tabs.open(botId, url, { reveal: false }));
      else options.note(`browser: refused a popup to ${url.slice(0, 200)}`);
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("will-navigate", (event) => { if (extracting.has(tabId)) { event.preventDefault(); options.note("browser: refused a navigation during a bot's extraction"); return; } if (!isWebUrl(event.url)) { event.preventDefault(); options.note(`browser: refused a navigation to ${event.url.slice(0, 200)}`); } });
    contents.on("did-start-loading", () => update({ loading: true }));
    contents.on("did-stop-loading", () => update({ loading: false, url: contents.getURL() || tabs.tab(botId, tabId)?.url, title: contents.getTitle() }));
    contents.on("did-navigate", (_event, url) => update({ url }));
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => { if (isMainFrame) update({ url }); });
    contents.on("page-title-updated", (_event, title) => update({ title: title.slice(0, 300) }));
    contents.on("page-favicon-updated", (_event, favicons) => { void favicon(favicons[0]).then((icon) => update({ favicon: icon })); });
    // Toggle tools turned on for this site come back on every load.
    contents.on("did-finish-load", () => applyToggles(botId, tabId));
    contents.on("render-process-gone", () => update({ loading: false, crashed: true }));
    // A video going full screen fills the window, then goes back.
    contents.on("enter-html-full-screen", () => { htmlFull = view; const { width, height } = owner.getContentBounds(); view.setBounds({ x: 0, y: 0, width, height }); });
    contents.on("leave-html-full-screen", () => { if (htmlFull === view) htmlFull = null; if (lastBounds) view.setBounds(lastBounds); });
    // The pointer at the page's top edge: the app page shows the floating toolbar.
    let lastEdge = 0;
    contents.on("input-event", (_event, input) => {
      if (input.type !== "mouseMove") return;
      const y = (input as { y?: number }).y;
      if (typeof y === "number" && y <= EDGE && Date.now() - lastEdge > 250) { lastEdge = Date.now(); send({ type: "edge", botId }); }
    });
    // Keys the app keeps while the page has the focus (before the page and the app menu see them).
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const command = process.platform === "darwin" ? input.meta : input.control;
      const key = input.key.toLowerCase();
      if (command && !input.alt && !input.shift && key === "l") { event.preventDefault(); owner.webContents.focus(); send({ type: "key", botId, key: "focusUrl" }); }
      else if (command && !input.alt && key === "r") { event.preventDefault(); contents.reload(); }
      else if (command && !input.alt && !input.shift && key === "[") { event.preventDefault(); tabs.back(botId); }
      else if (command && !input.alt && !input.shift && key === "]") { event.preventDefault(); tabs.forward(botId); }
      else if (key === "escape" && fullscreen && htmlFull !== view) { event.preventDefault(); send({ type: "key", botId, key: "escape" }); }
    });
  }

  /** The tab's traffic, always on (no panel): the Network domain of its page's DevTools protocol, into a bounded ring. */
  function capture(tabId: string, contents: WebContents) {
    const ring = new NetCapture();
    captures.set(tabId, ring);
    const cdp = contents.debugger;
    try { cdp.attach("1.3"); } catch (error) { options.note(`browser: no network capture for a tab (${(error as Error).message})`); return; }
    cdp.on("message", (_event, method, params) => {
      const wanted = ring.handle(method, params);
      if (!wanted) return;
      void (cdp.sendCommand("Network.getResponseBody", { requestId: wanted }) as Promise<{ body: string; base64Encoded: boolean }>)
        .then((got) => ring.setBody(wanted, got.body, got.base64Encoded), () => {});
    });
    cdp.on("detach", (_event, reason) => { if (reason !== "target closed") options.note(`browser: network capture stopped for a tab (${reason})`); });
    void cdp.sendCommand("Network.enable", { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 10_000_000 }).catch(() => {});
  }

  const bot: BotBrowserWindow = {
    tabs,
    open: (botId, url) => tabs.open(botId, url),
    capture: (tabId) => captures.get(tabId) ?? null,
    fetchBody: async (tabId, requestId) => {
      const contents = views.get(tabId)?.webContents;
      if (!contents || contents.isDestroyed() || !contents.debugger.isAttached()) return null;
      try {
        const got = await contents.debugger.sendCommand("Network.getResponseBody", { requestId: requestId.split(":")[0] }) as { body: string; base64Encoded: boolean };
        return { body: got.body, base64: got.base64Encoded };
      } catch { return null; }
    },
    run: async (tabId, code) => {
      const contents = views.get(tabId)?.webContents;
      if (!contents || contents.isDestroyed()) throw new Error("That tab's page is gone.");
      if (contents.isCrashed()) throw new Error("That tab's page crashed; ask the user to select it so it loads again.");
      extracting.add(tabId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          contents.executeJavaScriptInIsolatedWorld(EXTRACT_WORLD, [{ code }], false),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("The extraction took over 15 s.")), EXTRACT_TIMEOUT_MS); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        extracting.delete(tabId);
      }
    },
  };

  /** The site's icon as a data: URL (the app page's CSP takes no remote pictures); null when it cannot be had. */
  async function favicon(url: string | undefined): Promise<string | null> {
    if (!url || !isWebUrl(url)) return null;
    try {
      const response = await browserSession().fetch(url);
      if (!response.ok) return null;
      const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim();
      if (!/^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp)$/.test(type)) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      return bytes.length > 0 && bytes.length <= FAVICON_MAX ? `data:${type};base64,${bytes.toString("base64")}` : null;
    } catch { return null; }
  }

  // --- Site tools ---------------------------------------------------------------------------------------------
  const store = options.tools;
  const sendCatalog = () => { if (store) send({ type: "tools", ...store.catalog() }); };
  const stopCatalog = store?.subscribe(sendCatalog);
  const report = (run: BrowserToolRun) => send({ type: "toolRun", ...run });

  /** A file a tool asked to save: where the person picks (Downloads to start with), or the tests' folder. */
  async function saveToolFile(file: RunFile): Promise<string | null> {
    const extension = file.name.slice(file.name.lastIndexOf(".") + 1);
    let path: string | null = null;
    if (options.saveFolder) { await mkdir(options.saveFolder, { recursive: true }); path = join(options.saveFolder, file.name); }
    else {
      if (owner.isDestroyed()) return null;
      const picked = await dialog.showSaveDialog(owner, { defaultPath: join(app.getPath("downloads"), file.name), filters: [{ name: extension.toUpperCase(), extensions: [extension] }] });
      if (picked.canceled || !picked.filePath) return null;
      path = picked.filePath;
    }
    await writeFile(path, file.content, "utf8");
    return path;
  }

  async function runTool(botId: string, tabId: string, toolId: string, given: SiteToolOptions | undefined, active: boolean | null, quiet = false) {
    const tool = store?.tool(toolId);
    const tab = tabs.tab(botId, tabId);
    const exec = execs.get(tabId);
    const key = `${tabId}/${toolId}`;
    if (!tool || !tab || !exec || running.has(key)) return;
    const site = siteOf(tab.url);
    if (!site || !toolsFor([tool], tab.url).length) { if (!quiet) report({ botId, tabId, toolId, status: "failed", text: "This tool is not for this site." }); return; }
    if (tool.kind === "action" && !toolIsOn(store!.siteState(), tool, site)) return;
    running.add(key);
    if (!quiet) report({ botId, tabId, toolId, status: "running" });
    try {
      const result = await runSiteTool({
        tool, options: runOptions(tool, given), exec,
        active: tool.kind === "toggle" ? active ?? toolIsOn(store!.siteState(), tool, site) : null,
        save: tool.kind === "action" ? saveToolFile : undefined,
        onProgress: quiet ? undefined : (text) => report({ botId, tabId, toolId, status: "running", text }),
      });
      if (tool.kind === "toggle" && result.active !== null && result.active !== toolIsOn(store!.siteState(), tool, site)) store!.setOn(tool.id, site, result.active);
      if (!result.ok) options.note(`site tool ${tool.id} on ${site}: ${result.text}`);
      if (!quiet || !result.ok) report({ botId, tabId, toolId, status: result.ok ? "done" : "failed", text: result.text, ...(result.saved.length ? { saved: result.saved } : {}) });
    } catch (error) {
      report({ botId, tabId, toolId, status: "failed", text: `Failed: ${String((error as Error)?.message ?? error).slice(0, 300)}` });
    } finally { running.delete(key); }
  }

  function applyToggles(botId: string, tabId: string) {
    const tab = tabs.tab(botId, tabId);
    const site = tab ? siteOf(tab.url) : null;
    if (!store || !tab || !site) return;
    for (const tool of toolsFor(store.all(), tab.url)) {
      if (tool.kind === "toggle" && toolIsOn(store.siteState(), tool, site)) void runTool(botId, tabId, tool.id, undefined, true, true);
    }
  }

  function setTool(botId: string, tabId: string, toolId: string, on: boolean) {
    const tool = store?.tool(toolId);
    const tab = tabs.tab(botId, tabId);
    const site = tab ? siteOf(tab.url) : null;
    if (!store || !tool || !tab || !site || !toolsFor([tool], tab.url).length) return;
    store.setOn(tool.id, site, on);
    if (tool.kind === "toggle") void runTool(botId, tabId, tool.id, undefined, on);
  }

  const openOutside = (url: string) => { if (!options.noExternal && isWebUrl(url)) void shell.openExternal(url); };

  /** "Open in its own window": a plain window of its own on the same session, as safe as a tab. */
  function ownWindow(url: string) {
    if (!isWebUrl(url)) return;
    const window = new BrowserWindow({ width: 1100, height: 800, title: url, webPreferences: { ...SECURE } });
    window.webContents.setWindowOpenHandler(({ url: next }) => { if (isWebUrl(next)) ownWindow(next); return { action: "deny" }; });
    window.webContents.on("will-navigate", (event) => { if (!isWebUrl(event.url)) event.preventDefault(); });
    void window.loadURL(url).catch(() => {});
  }

  function act(botId: string, pick: BrowserMenuPick | "copy" | "external" | "window") {
    const tab = tabs.active(botId);
    switch (pick) {
      case "forward": tabs.forward(botId); break;
      case "reload": tabs.reload(botId); break;
      case "copy": if (tab) clipboard.writeText(tab.url); break;
      case "external": if (tab) openOutside(tab.url); break;
      case "window": if (tab) { ownWindow(tab.url); tabs.close(botId, tab.id); } break;
      case "close": tabs.closeBot(botId); send({ type: "closePane", botId }); break;
    }
  }

  function menu(botId: string, x: number, y: number) {
    const tab = tabs.active(botId);
    const mac = process.platform === "darwin";
    const item = (label: string, pick: BrowserMenuPick, accelerator?: string, enabled = true) =>
      ({ label, enabled, ...(accelerator ? { accelerator, registerAccelerator: false } : {}), click: () => act(botId, pick) });
    const template: Electron.MenuItemConstructorOptions[] = [
      item("Forward", "forward", mac ? "Cmd+]" : "Ctrl+]", !!tab?.canGoForward),
      item("Reload", "reload", mac ? "Cmd+R" : "Ctrl+R", !!tab),
      item("Copy link", "copy", undefined, !!tab),
      { type: "separator" },
      item("Open in default browser", "external", undefined, !!tab),
      item("Open in its own window", "window", undefined, !!tab),
      { type: "separator" },
      item("Close browser", "close"),
    ];
    const zoom = owner.webContents.getZoomFactor();
    Menu.buildFromTemplate(template).popup({ window: owner, x: Math.round(x * zoom), y: Math.round(y * zoom) });
  }

  function receive(message: BrowserUp) {
    switch (message.type) {
      case "hello": for (const botId of tabs.botIds()) send({ type: "state", ...tabs.state(botId) }); sendCatalog(); break;
      case "tool.run": void runTool(message.botId, message.tabId, message.toolId, message.options, null); break;
      case "tool.set": setTool(message.botId, message.tabId, message.toolId, message.on); break;
      case "mode": fullscreen = message.fullscreen; break;
      case "layout": {
        const bounds = message.bounds ? editorBounds(message.bounds, owner.getContentBounds(), owner.webContents.getZoomFactor()) : null;
        tabs.layout(message.botId, bounds);
        break;
      }
      case "open": if (isWebUrl(message.url)) tabs.open(message.botId, message.url, { newTab: message.newTab !== false, reveal: false }); break;
      case "select": tabs.select(message.botId, message.tabId); break;
      case "close": tabs.close(message.botId, message.tabId); break;
      case "navigate": {
        const url = urlFromInput(message.input);
        if (!url) { options.note("browser: refused an address that is not a web page"); break; }
        if (message.tabId) tabs.navigate(message.botId, url, message.tabId);
        else tabs.open(message.botId, url, { reveal: false });
        tabs.focus(message.botId);
        break;
      }
      case "back": tabs.back(message.botId); break;
      case "forward": tabs.forward(message.botId); break;
      case "reload": tabs.reload(message.botId); break;
      case "stop": tabs.stop(message.botId); break;
      case "focus": tabs.focus(message.botId); break;
      case "copy": case "external": case "window": act(message.botId, message.type); break;
      case "menu": menu(message.botId, message.x, message.y); break;
    }
  }

  const resize = () => { if (htmlFull && !owner.isDestroyed()) { const { width, height } = owner.getContentBounds(); htmlFull.setBounds({ x: 0, y: 0, width, height }); } };
  owner.on("resize", resize);
  const dispose = () => { owner.removeListener("resize", resize); stopCatalog?.(); tabs.dispose(); views.clear(); execs.clear(); captures.clear(); };
  owner.once("closed", dispose);

  return {
    open: (botId, url) => { if (isWebUrl(url)) tabs.open(botId, url); },
    receive,
    closeBot: (botId) => tabs.closeBot(botId),
    tabs,
    bot,
    dispose,
  };
}
