// Electron main: thin. It owns windows, sessions and protocols, checks every IPC message (who sent
// it and what it is), and relays the rest to the core process. It runs no agents and keeps no chat.
import { app, BrowserWindow, ipcMain, protocol, session, net, type WebContents, type Session, type IpcMainEvent } from "electron";
import { join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { CoreClient } from "./core-client";
import { cardPage, CARD_CSP } from "./card-page";
import {
  AccountView, MAIN_COMMANDS, PROTOCOL_VERSION, RENDERER_COMMANDS, errorResponse, okResponse, parseInbound,
  type Command, type EventEnvelope, type ResponseEnvelope,
} from "../contract";

const root = resolve(__dirname, "..", ".."); // desktop/
const rendererDir = join(root, "out", "renderer");
const dataDir = resolve(process.env.BOTLING_DATA_DIR ?? (app.isPackaged ? join(app.getPath("appData"), "Botling 2") : join(root, ".data")));
mkdirSync(dataDir, { recursive: true });
// Everything Electron keeps (partitions, caches, logs) lives under the data dir, never the default.
app.setPath("userData", join(dataDir, "electron"));
app.setPath("sessionData", join(dataDir, "electron"));
app.setPath("crashDumps", join(dataDir, "electron", "crashes"));
app.setPath("logs", join(dataDir, "electron", "logs"));

const APP_ORIGIN = "app://botling";
const CARD_PREFIX = "botling-card://card/";
/** The reused Web/src chat page, in a frame of the app page. */
const CHAT_URL = `${APP_ORIGIN}/chat.html`;

/** Each app page's CSP. The chat page draws agent text as markdown (raw HTML off) and KaTeX, which
 * needs inline styles; it loads the ccb-latex plugin from a blob: module. Neither page can connect
 * anywhere or frame anything but what is listed. */
const APP_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "frame-src 'self'", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
].join("; ");
const CHAT_CSP = [
  "default-src 'none'", "script-src 'self' blob:", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
  "media-src 'self' data: blob:", "frame-src botling-card:", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
].join("; ");

/** What the security checks refused or noticed, for tests (read through Playwright's main-process evaluate). */
const audit: string[] = [];
(globalThis as unknown as { __botlingAudit: string[] }).__botlingAudit = audit;
function note(entry: string) {
  audit.push(entry);
  if (audit.length > 500) audit.shift();
  if (process.env.BOTLING_QUIET !== "1") console.warn(`[security] ${entry}`);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: "botling-card", privileges: { standard: true, secure: true } },
]);

if (!app.requestSingleInstanceLock({ dataDir })) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const appContents = new Set<number>();

const core = new CoreClient({
  script: join(root, "out", "core", "main.cjs"),
  env: coreEnvironment(),
  onEvent: broadcast,
  audit: note,
});

function coreEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.BOTLING_DATA_DIR = join(dataDir, "core");
  env.BOTLING_FAKE_CLI ??= join(root, "test", "fixtures", "fake-claude.mjs");
  // A packaged app imports the user's Botling 1.x folder on its first start (read-only). A
  // development run imports only what BOTLING_IMPORT_FROM names, so tests never see real data.
  if (env.BOTLING_IMPORT_FROM === undefined && app.isPackaged) env.BOTLING_IMPORT_FROM = join(app.getPath("home"), ".claudecodebot");
  return env;
}

function broadcast(event: EventEnvelope) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!appContents.has(window.webContents.id) || window.webContents.isDestroyed()) continue;
    window.webContents.send("botling:message", event);
  }
}

// ----------------------------------------------------------------------------------------------
// Accounts: one persistent partition each. Remote sites get no preload and no IPC.

function accounts(): AccountView[] {
  const file = join(dataDir, "accounts.json");
  if (!existsSync(file)) {
    const initial: AccountView[] = [
      { id: "work", name: "Work", partition: "persist:account-work" },
      { id: "personal", name: "Personal", partition: "persist:account-personal" },
    ];
    writeFileSync(file, JSON.stringify(initial, null, 2));
  }
  return (JSON.parse(readFileSync(file, "utf8")) as unknown[]).map((entry) => AccountView.parse(entry));
}

const hardened = new WeakSet<Session>();
/** Account sessions opened this run (only these need their cookies flushed at quit). */
const openedSessions = new Set<Session>();
function hardenSession(target: Session) {
  if (hardened.has(target)) return;
  hardened.add(target);
  target.setPermissionRequestHandler((contents, permission, callback) => {
    note(`denied permission ${permission} for ${contents?.getURL() ?? "?"}`);
    callback(false);
  });
  target.setPermissionCheckHandler(() => false);
  target.on("will-download", (event) => { event.preventDefault(); note("blocked a download"); });
}

function openSite(accountId: string, url: string): number {
  const account = accounts().find((candidate) => candidate.id === accountId);
  if (!account) throw Object.assign(new Error("No such account."), { code: "not_found" });
  const siteSession = session.fromPartition(account.partition);
  hardenSession(siteSession);
  openedSessions.add(siteSession);
  const window = new BrowserWindow({
    width: 1000, height: 760, title: `${account.name} — ${new URL(url).host}`,
    backgroundColor: "#0E0E10",
    webPreferences: {
      session: siteSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false,
      // No preload: a website has no Botling API at all.
    },
  });
  void window.loadURL(url);
  return window.id;
}

// ----------------------------------------------------------------------------------------------
// IPC from the app's renderer

function fromAppFrame(event: IpcMainEvent): boolean {
  const frame = event.senderFrame;
  const ok = !!frame && appContents.has(event.sender.id) && frame === event.sender.mainFrame && frame.url.startsWith(`${APP_ORIGIN}/`);
  if (!ok) note(`refused IPC from ${frame?.url ?? "an unknown frame"} (contents ${event.sender.id})`);
  return ok;
}

ipcMain.on("botling:post", (event, raw: unknown) => {
  if (!fromAppFrame(event)) return;
  const parsed = parseInbound(raw);
  const reply = (response: ResponseEnvelope) => { if (!event.sender.isDestroyed()) event.sender.send("botling:message", response); };
  if (!parsed.ok) {
    note(`refused a malformed message: ${parsed.error.code} ${parsed.error.message}`);
    if (parsed.id) reply(errorResponse(parsed.id, parsed.error));
    return;
  }
  const message = parsed.value;
  // Renderer ids are scoped per window so two windows cannot collide in (or cancel) each other's.
  const scoped = (id: string) => `w${event.sender.id}.${id}`.slice(0, 64);
  if ("cancel" in message) {
    core.cancel(scoped(message.cancel));
    return;
  }
  const { id, cmd } = message;
  if (!RENDERER_COMMANDS.has(cmd.type)) {
    note(`refused renderer command ${cmd.type}`);
    reply(errorResponse(id, { code: "forbidden", message: `${cmd.type} is not available to the app page.` }));
    return;
  }
  if (MAIN_COMMANDS.has(cmd.type)) {
    try {
      reply(okResponse(id, handleInMain(cmd)));
    } catch (error) {
      const code = (error as { code?: string }).code === "not_found" ? "not_found" : "bad_request";
      reply(errorResponse(id, { code, message: (error as Error).message }));
    }
    return;
  }
  void core.request(cmd, scoped(id)).then((response) => reply({ ...response, id }));
});

function handleInMain(cmd: Command): unknown {
  switch (cmd.type) {
    case "accounts.list": return { accounts: accounts() };
    case "site.open": return { windowId: openSite(cmd.accountId, cmd.url) };
    default: throw new Error(`main does not handle ${cmd.type}`);
  }
}

// ----------------------------------------------------------------------------------------------
// Every web contents: no popups, no navigation away, no <webview>.

app.on("web-contents-created", (_, contents: WebContents) => {
  contents.setWindowOpenHandler(({ url }) => {
    note(`blocked a popup to ${url} from ${contents.getURL()}`);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => { event.preventDefault(); note("blocked a <webview>"); });
  contents.on("will-frame-navigate", (details) => {
    const isApp = appContents.has(contents.id);
    if (details.isMainFrame) {
      if (isApp && !details.url.startsWith(`${APP_ORIGIN}/`)) {
        details.preventDefault();
        note(`blocked top-frame navigation of the app to ${details.url}`);
      } else if (!isApp && !/^https?:/.test(details.url)) {
        details.preventDefault();
        note(`blocked a site navigating to ${details.url}`);
      }
      return;
    }
    if (!isApp) return; // A website's own frames are the website's business.
    // In the app, a frame may show the chat page (only as the app page's own child, put there by
    // it) or a card (put there by the app page or the chat page). A card that navigates itself (to
    // anything) is refused: it would otherwise take over another card's identity.
    const mainFrame = contents.mainFrame;
    const initiator = details.initiator;
    const chatFrame = (frame: Electron.WebFrameMain | null | undefined) =>
      !!frame && frame.parent === mainFrame && frame.url.startsWith(CHAT_URL);
    const parent = details.frame?.parent ?? null;
    let allowed = false;
    if (details.url === CHAT_URL || details.url.startsWith(`${CHAT_URL}?`)) {
      allowed = parent === mainFrame && (!initiator || initiator === mainFrame);
    } else if (details.url.startsWith(CARD_PREFIX)) {
      allowed = (!initiator || initiator === mainFrame || chatFrame(initiator)) && (parent === mainFrame || chatFrame(parent));
    }
    if (!allowed) {
      details.preventDefault();
      note(`blocked a frame navigating to ${details.url} (initiator ${initiator?.url ?? "none"})`);
    }
  });
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1120, height: 820, minWidth: 640, minHeight: 480,
    title: "Botling", backgroundColor: "#0E0E10", show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(root, "out", "preload", "preload.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: false,
    },
  });
  appContents.add(window.webContents.id);
  const id = window.webContents.id;
  window.on("closed", () => { appContents.delete(id); if (mainWindow === window) mainWindow = null; });
  window.once("ready-to-show", () => { if (process.env.BOTLING_HIDDEN !== "1") window.show(); });
  void window.loadURL(`${APP_ORIGIN}/index.html`);
  mainWindow = window;
  return window;
}

function serveApp() {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "botling") return new Response("Not found", { status: 404 });
    const file = normalize(join(rendererDir, decodeURIComponent(url.pathname)));
    if (!file.startsWith(rendererDir + sep)) return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    if (file.endsWith(".html")) headers.set("Content-Security-Policy", file.endsWith(`${sep}chat.html`) ? CHAT_CSP : APP_CSP);
    return new Response(response.body, { status: response.status, headers });
  });
  protocol.handle("botling-card", async (request) => {
    const url = new URL(request.url);
    const [botId, messageId, cardId] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.host !== "card" || !botId || !messageId || !cardId) return new Response("Not found", { status: 404 });
    const response = await core.request({ type: "card.html", botId, messageId, cardId });
    if (!response.ok) return new Response("Not found", { status: 404 });
    return new Response(cardPage((response.result as { html: string }).html), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CARD_CSP, "X-Content-Type-Options": "nosniff" },
    });
  });
}

app.whenReady().then(() => {
  hardenSession(session.defaultSession);
  serveApp();
  core.start();
  createWindow();
  app.on("activate", () => { if (!mainWindow) createWindow(); });
});

app.on("second-instance", () => { mainWindow?.show(); mainWindow?.focus(); });

// Closing the window does not stop work: the core keeps running (macOS convention). Quitting does.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || process.env.BOTLING_QUIT_ON_CLOSE === "1") app.quit();
});

let stopping = false;
app.on("before-quit", (event) => {
  if (stopping) return;
  stopping = true;
  event.preventDefault();
  // Cookies are written to disk lazily; make sure each account's are there before exiting.
  const flushes = [...openedSessions].map((opened) => opened.cookies.flushStore().catch(() => {}));
  void Promise.all([core.stop(), ...flushes]).finally(() => app.exit(0));
});

// For tests: which pid the core has.
(globalThis as unknown as { __botlingCorePid: () => number | undefined }).__botlingCorePid = () => core.pid;
void PROTOCOL_VERSION;
