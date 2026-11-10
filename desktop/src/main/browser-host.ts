// The in-app browser pane's pages (phase 1): one WebContentsView per tab, in the window beside the chat, under
// the tabs the app page draws (browser-tabs.ts keeps the list; the app page sends bounds over BROWSER_CHANNEL).
//
// Every page is an ordinary website and gets nothing of the app's: its own session ('persist:botling-web', so
// sign-ins last but share nothing with the app's pages), sandboxed, context-isolated, no Node and no preload.
// Only http(s) loads; a site's popup (window.open, target=_blank) becomes a new tab; every permission it asks
// for (camera, notifications, location, …) is refused.
import { BrowserWindow, Menu, WebContentsView, clipboard, session, shell, type Session, type WebContents } from "electron";
import { BROWSER_CHANNEL, isWebUrl, urlFromInput, type BrowserDown, type BrowserMenuPick, type BrowserRect, type BrowserUp } from "../browser-wire";
import { BrowserTabs, type TabPage } from "./browser-tabs";
import { editorBounds } from "./editor-host";

export const BROWSER_PARTITION = "persist:botling-web";
/** The top edge of a page, in px, where the pointer brings out the floating toolbar. */
const EDGE = 6;
const FAVICON_MAX = 64_000;

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
}

export interface BrowserHost {
  /** A link the user (or a plugin) opened for a bot: a tab, and the pane shows. */
  open(botId: string, url: string): void;
  receive(message: BrowserUp): void;
  closeBot(botId: string): void;
  tabs: BrowserTabs;
  dispose(): void;
}

/** The browser of one app window. */
export function createBrowserHost(owner: BrowserWindow, options: BrowserHostOptions): BrowserHost {
  const send = (message: BrowserDown) => { if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) owner.webContents.send(BROWSER_CHANNEL, message); };
  let fullscreen = false;
  let htmlFull: WebContentsView | null = null;
  let lastBounds: BrowserRect | null = null;
  const views = new Map<string, WebContentsView>();

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
    wire(botId, tabId, view, contents);
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
    contents.on("will-navigate", (event) => { if (!isWebUrl(event.url)) { event.preventDefault(); options.note(`browser: refused a navigation to ${event.url.slice(0, 200)}`); } });
    contents.on("did-start-loading", () => update({ loading: true }));
    contents.on("did-stop-loading", () => update({ loading: false, url: contents.getURL() || tabs.tab(botId, tabId)?.url, title: contents.getTitle() }));
    contents.on("did-navigate", (_event, url) => update({ url }));
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => { if (isMainFrame) update({ url }); });
    contents.on("page-title-updated", (_event, title) => update({ title: title.slice(0, 300) }));
    contents.on("page-favicon-updated", (_event, favicons) => { void favicon(favicons[0]).then((icon) => update({ favicon: icon })); });
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
      case "hello": for (const botId of tabs.botIds()) send({ type: "state", ...tabs.state(botId) }); break;
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
  const dispose = () => { owner.removeListener("resize", resize); tabs.dispose(); views.clear(); };
  owner.once("closed", dispose);

  return {
    open: (botId, url) => { if (isWebUrl(url)) tabs.open(botId, url); },
    receive,
    closeBot: (botId) => tabs.closeBot(botId),
    tabs,
    dispose,
  };
}
