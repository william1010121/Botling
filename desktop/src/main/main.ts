// Electron main: thin. It owns windows, sessions and protocols, checks every IPC message (who sent
// it and what it is), and relays the rest to the core process. It runs no agents and keeps no chat.
import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, session, shell, net, type WebContents, type Session, type IpcMainEvent } from "electron";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { CoreClient } from "./core-client";
import { WebPages } from "./web";
import { cardPage, CARD_CSP, COMPONENT_CSP, PANEL_CSP } from "./card-page";
import { randomBytes } from "node:crypto";
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
// Tests: safeStorage seals with Chromium's mock keychain instead of the user's login keychain.
if (process.env.BOTLING_MOCK_KEYCHAIN === "1") app.commandLine.appendSwitch("use-mock-keychain");

const APP_ORIGIN = "app://botling";
const CARD_PREFIX = "botling-card://card/";
/** Component pages (Web/src's `componentPage`) the chat page hands over for its sandboxed frames. */
const PAGE_PREFIX = "botling-card://page/";
/**
 * The reused Web/src chat page, in a frame of the app page, on an origin of its own (Phase 4a): it
 * runs agent markdown and plugins' web parts, so it must not share the app page's origin (which has
 * the bridge). It reaches the app page only with postMessage.
 */
const CHAT_ORIGIN = "botling-chat://chat";
const CHAT_URL = `${CHAT_ORIGIN}/chat.html`;
/** What the chat origin serves from out/renderer: the page, its script and styles, and KaTeX's files. */
const CHAT_FILES = /^\/(?:chat\.html|chat\.js|chat\.js\.map|chat\.css|frame\.css|plugins\/ccb-latex\/(?:katex\.min\.css|fonts\/[A-Za-z0-9_-]+\.woff2))$/;

/** Each app page's CSP. The chat page draws agent text as markdown (raw HTML off) and KaTeX, which
 * needs inline styles; it loads the ccb-latex plugin from a blob: module. Neither page can connect
 * anywhere or frame anything but what is listed. */
const APP_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "font-src 'self'",
  "frame-src botling-chat: botling-card:", "connect-src 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
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
  { scheme: "botling-chat", privileges: { standard: true, secure: true } },
]);

if (!app.requestSingleInstanceLock({ dataDir })) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const appContents = new Set<number>();

const core = new CoreClient({
  script: join(root, "out", "core", "main.cjs"),
  hostScript: join(root, "out", "host", "host-utility.mjs"),
  env: coreEnvironment(),
  onEvent: (event) => {
    // The web AIs' pages are main's to show: it follows the core's view of them.
    if (event.epoch !== lastEpoch) {
      if (lastEpoch !== null) web.coreRestarted();
      lastEpoch = event.epoch;
    }
    if (event.event.type === "web.updated") web.update(event.event.web);
    broadcast(event);
  },
  audit: note,
  seal: (op, text) => {
    // Plugins' secrets: sealed with the OS keychain's key (safeStorage); only the core asks, over its own port.
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer offers no safe storage for secrets.");
    return op === "seal" ? safeStorage.encryptString(text).toString("base64") : safeStorage.decryptString(Buffer.from(text, "base64"));
  },
});

let lastEpoch: string | null = null;

/** The web AIs (Gemini, ChatGPT, Claude): each in its own session, no Node, no preload (main/web.ts). */
const web = new WebPages({
  core,
  note,
  openExternal: (url) => {
    if (!/^https?:\/\//i.test(url) || process.env.BOTLING_NO_EXTERNAL === "1") return;
    void shell.openExternal(url).catch(() => {});
  },
  opened: (opened) => openedSessions.add(opened),
});
(globalThis as unknown as { __botlingWeb: WebPages }).__botlingWeb = web;

function coreEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.BOTLING_DATA_DIR = join(dataDir, "core");
  env.BOTLING_FAKE_CLI ??= join(root, "test", "fixtures", "fake-claude.mjs");
  env.BOTLING_FAKE_CODEX ??= join(root, "test", "fixtures", "fake-codex.mjs");
  // A packaged app imports the user's Botling 1.x folder on its first start (read-only). A
  // development run imports only what BOTLING_IMPORT_FROM names, so tests never see real data.
  if (env.BOTLING_IMPORT_FROM === undefined && app.isPackaged) env.BOTLING_IMPORT_FROM = join(app.getPath("home"), ".claudecodebot");
  // Where 1.x keeps its projects, to tell whether it has a project open (read-only; same rule).
  if (env.BOTLING_1X_DIR === undefined && app.isPackaged) env.BOTLING_1X_DIR = join(app.getPath("home"), ".claudecodebot");
  // Tests show local pages as web AIs; a packaged app lists only the real sites.
  if (app.isPackaged) delete env.BOTLING_TEST_WEB_SITES;
  // The bots reply in the system's language unless settings name one (`AppLanguage.preferred`).
  try { env.BOTLING_LANGUAGES ??= app.getPreferredSystemLanguages().join(","); } catch { /* Intl's locale then */ }
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
    void Promise.resolve().then(() => handleInMain(cmd, event.sender)).then(
      (result) => reply(okResponse(id, result)),
      (error) => {
        const code = (error as { code?: string }).code === "not_found" ? "not_found" : "bad_request";
        reply(errorResponse(id, { code, message: (error as Error).message }));
      },
    );
    return;
  }
  void core.request(cmd, scoped(id)).then((response) => reply({ ...response, id }));
});

/**
 * Component pages by token: what the chat page built for a component frame (its template, the
 * data, the `ccb` runtime), served once from botling-card://page/<token> under COMPONENT_CSP. The
 * frame is still sandboxed (opaque origin) and reaches nothing; only the app page can add one.
 */
const pages = new Map<string, { html: string; panel: boolean }>();
const PAGE_LIMIT = 400;
function addPage(html: string, panel = false): string {
  const token = randomBytes(18).toString("hex");
  pages.set(token, { html, panel });
  while (pages.size > PAGE_LIMIT) pages.delete(pages.keys().next().value!);
  return `${PAGE_PREFIX}${token}`;
}

/**
 * The + button's picker: main's own dialog, so the paths that reach the core are ones you chose
 * (a page never names a path). Tests (unpackaged only) answer it with BOTLING_TEST_PICK, a JSON list.
 */
async function pickFiles(botId: string, sender: WebContents): Promise<unknown> {
  let paths: string[];
  if (!app.isPackaged && process.env.BOTLING_TEST_PICK) {
    paths = JSON.parse(process.env.BOTLING_TEST_PICK) as string[];
  } else {
    const owner = BrowserWindow.fromWebContents(sender);
    const options: Electron.OpenDialogOptions = { properties: ["openFile", "multiSelections"], buttonLabel: "Add" };
    const answer = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (answer.canceled) return { files: [] };
    paths = answer.filePaths;
  }
  if (!paths.length) return { files: [] };
  return core.call({ type: "files.add", botId, paths: paths.slice(0, 50) });
}

/**
 * "Add project": main's folder picker (1.x's NSOpenPanel, "Add as project"), then the core makes it a
 * project (or finds the one it already is). Tests (unpackaged only) answer with BOTLING_TEST_PICK_FOLDER.
 */
async function pickProject(sender: WebContents): Promise<unknown> {
  let folder: string | undefined;
  if (!app.isPackaged && process.env.BOTLING_TEST_PICK_FOLDER !== undefined) {
    folder = process.env.BOTLING_TEST_PICK_FOLDER || undefined;
  } else {
    const owner = BrowserWindow.fromWebContents(sender);
    const options: Electron.OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"], buttonLabel: "Add as project",
      message: "Pick a project folder; Botling will give it a manager.",
    };
    const answer = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    folder = answer.canceled ? undefined : answer.filePaths[0];
  }
  if (!folder) return { botId: null, added: false };
  return core.call({ type: "projects.add", folder });
}

/** Files a result may open with their own app (1.x opens a result page in a window of its own); anything else is shown in Finder. */
const RESULT_TYPES = new Set([".html", ".htm", ".md", ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".csv", ".json", ".mp4", ".mov", ".m4v", ".webm", ".mp3", ".m4a", ".wav"]);
/** Tests: the results main opened (BOTLING_NO_EXTERNAL=1 opens nothing for real). */
const openedResults: string[] = [];
(globalThis as unknown as { __botlingOpenedResults: string[] }).__botlingOpenedResults = openedResults;

/**
 * One of a bot's results (the right panel's Results): only a link that is in that bot's chat. A web link
 * opens in the browser; a local file opens with its app when it is a page, a picture, a video or a
 * document, and is shown in Finder otherwise (never run).
 */
async function openResult(botId: string, url: string): Promise<{ opened: boolean }> {
  const { results } = await core.call({ type: "results.list", botId }) as { results: { url: string }[] };
  if (!results.some((result) => result.url === url)) throw Object.assign(new Error("That link is not one of this bot's results."), { code: "not_found" });
  const external = process.env.BOTLING_NO_EXTERNAL === "1";
  if (/^(https?|mailto):/i.test(url)) {
    openedResults.push(url);
    if (!external) await shell.openExternal(url);
    return { opened: true };
  }
  let path: string;
  try { path = url.startsWith("file:") ? fileURLToPath(url) : url.startsWith("/") ? url : ""; } catch { path = ""; }
  if (!path || !existsSync(path)) throw Object.assign(new Error("That result's file is not there."), { code: "not_found" });
  openedResults.push(url);
  if (external) return { opened: true };
  const dot = path.lastIndexOf(".");
  if (RESULT_TYPES.has(dot >= 0 ? path.slice(dot).toLowerCase() : "")) {
    const problem = await shell.openPath(path);
    if (problem) throw new Error(problem);
  } else {
    shell.showItemInFolder(path);
  }
  return { opened: true };
}

async function handleInMain(cmd: Command, sender: WebContents): Promise<unknown> {
  switch (cmd.type) {
    case "result.open": return openResult(cmd.botId, cmd.url);
    case "files.pick": return pickFiles(cmd.botId, sender);
    case "projects.pick": return pickProject(sender);
    case "card.page": return { url: addPage(cmd.html, cmd.panel === true) };
    case "accounts.list": return { accounts: accounts() };
    case "site.open": return { windowId: openSite(cmd.accountId, cmd.url) };
    case "web.place": {
      const owner = BrowserWindow.fromWebContents(sender);
      if (!owner) throw new Error("No window.");
      return { shown: await web.place(owner, cmd.site, cmd.bounds) };
    }
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
    } else if (details.url.startsWith(CARD_PREFIX) || details.url.startsWith(PAGE_PREFIX)) {
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

const NO_SNIFF = { "X-Content-Type-Options": "nosniff" };

/** A file of the chat origin: the page's own, a plugin's stylesheet (and its fonts), or an attachment the chat names. */
async function chatFile(url: URL): Promise<Response | null> {
  const path = url.pathname;
  if (CHAT_FILES.test(path)) {
    const response = await net.fetch(pathToFileURL(join(rendererDir, path)).toString());
    const headers = new Headers(response.headers);
    if (path === "/chat.html") headers.set("Content-Security-Policy", CHAT_CSP);
    return new Response(response.body, { status: response.status, headers });
  }
  // A plugin's stylesheet or a font beside it (only files the core says the plugin ships for its web part).
  const style = /^\/plugin-files\/([a-z0-9][a-z0-9._-]*)\/(.+)$/.exec(path);
  if (style) {
    const answer = await core.request({ type: "plugins.file", name: style[1]!, path: decodeURIComponent(style[2]!) });
    if (!answer.ok) return null;
    const { path: file, type } = answer.result as { path: string; type: string };
    try { return new Response(readFileSync(file), { headers: { "Content-Type": type, ...NO_SNIFF, "Cache-Control": "no-store" } }); } catch { return null; }
  }
  // A file a message (or the input box) in this bot's chat has attached; never any other path.
  const attached = /^\/attachment\/([A-Za-z0-9_.:-]{1,64})\/([A-Za-z0-9_-]{1,8000})$/.exec(path);
  if (attached) {
    const answer = await core.request({ type: "attachment.file", botId: attached[1]!, ref: Buffer.from(attached[2]!, "base64url").toString("utf8") });
    if (!answer.ok) return null;
    const { path: file, type } = answer.result as { path: string; type: string };
    try {
      return new Response(readFileSync(file), { headers: {
        "Content-Type": type, ...NO_SNIFF, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'", "Cache-Control": "no-store",
      } });
    } catch { return null; }
  }
  return null;
}

function serveApp() {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "botling") return new Response("Not found", { status: 404 });
    const file = normalize(join(rendererDir, decodeURIComponent(url.pathname)));
    // The chat page and its files are the chat origin's, not the app's.
    if (!file.startsWith(rendererDir + sep) || CHAT_FILES.test(url.pathname)) return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    if (file.endsWith(".html")) headers.set("Content-Security-Policy", APP_CSP);
    return new Response(response.body, { status: response.status, headers });
  });
  protocol.handle("botling-chat", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "chat") return new Response("Not found", { status: 404 });
    const served = await chatFile(url);
    if (!served) return new Response("Not found", { status: 404 });
    return served;
  });
  protocol.handle("botling-card", async (request) => {
    const url = new URL(request.url);
    if (url.host === "page") {
      const page = pages.get(url.pathname.slice(1));
      if (page === undefined) return new Response("Not found", { status: 404 });
      return new Response(page.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": page.panel ? PANEL_CSP : COMPONENT_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
    }
    if (url.host === "image") {
      // Only a picture some component's data named (the core keeps which, by token).
      const token = url.pathname.slice(1);
      if (!/^[0-9a-f]{40}$/.test(token)) return new Response("Not found", { status: 404 });
      const response = await core.request({ type: "card.image", token });
      if (!response.ok) return new Response("Not found", { status: 404 });
      const { path, type } = response.result as { path: string; type: string };
      try {
        return new Response(readFileSync(path), { headers: { "Content-Type": type, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", "X-Content-Type-Options": "nosniff" } });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
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
  web.closeAll();
  void Promise.all([core.stop(), ...flushes]).finally(() => app.exit(0));
});

// For tests: which pid the core has.
(globalThis as unknown as { __botlingCorePid: () => number | undefined }).__botlingCorePid = () => core.pid;
(globalThis as unknown as { __botlingHostPids: () => number[] }).__botlingHostPids = () => core.hostPids;
void PROTOCOL_VERSION;
