// Electron main: thin. It owns windows, sessions and protocols, checks every IPC message (who sent
// it and what it is), and relays the rest to the core process. It runs no agents and keeps no chat.
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeTheme, protocol, safeStorage, session, shell, net, type WebContents, type Session, type IpcMainEvent } from "electron";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isRequested as isShotRequested, withProbe } from "../core/component-shot";
import { runShot, SHOT_HTML, SHOT_JS } from "./shot";
import { scrubEnvironment } from "./packaged";
import {configureHiddenApp,hidden} from "./hidden-mode";
import {nativeEditorNavigation,hasNativeEditorHost,prepareNativeEditorHost,reloadNativeEditor} from "./editor-host";
import {appMenuTemplate} from "./app-menu";
import {CHAT_FILES,preloadFiles,rendererFiles,rendererResponse} from "./renderer-loading";
import { CHECK_EVERY_MS, FEED, Updater } from "./updates";
import { previewResponse } from "./preview-response";
import { VerifiedInstaller, acknowledgeUpdateBoot, recoverUpdates, runningAppBundles } from "./update-install";
import {blockingRecovery,persistentDataIdentity,dataVolumeError,recoveryCopies,deleteRecoveryCopies,commitUpdateReceipt,completeRecovery,dismissRecovery,issueFor,recoveryHTML,visibleRecovery,writeRecord} from "./update-state";
import {RecoveryWindowHost} from "./recovery-window";
import {retainedUpdateCopies,deleteRetainedUpdateCopy} from "./update-copies";
import {InputTraceWriter,syntheticTraceContext,acceptTraceIPC} from "./input-trace";
import {TEST_TRACE_ARGUMENT,TEST_TRACE_CHANNEL} from "../test-trace";
import {directoryDefaults,packagedDataName} from "./main-environment";
declare const __UPDATE_PUBLIC_KEY__: string | null;
import { checkReport } from "../core/plugins/check-report";
import { CoreClient } from "./core-client";
import { installCoreSwap } from "./core-swap-main";
import { HotInstaller } from "./hot-install";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as originalFs from "original-fs";
import { copyDoctorFix } from "./doctor-copy";
import { WebPages } from "./web";
import { cardPage, CARD_CSP, COMPONENT_CSP, PANEL_CSP, PREVIEW_CSP, PREVIEW_TYPES } from "./card-page";
import { PAGE_COMPONENT, previewFile } from "../core/preview-url";
import { attachmentFile, attachmentTarget } from "../contract/attachment-url";
import { randomBytes } from "node:crypto";
import {
  AccountView, MAIN_COMMANDS, PROTOCOL_VERSION, RENDERER_COMMANDS, errorResponse, okResponse, parseInbound,
  type Command, type EventEnvelope, type ResponseEnvelope, type UpdateView,
} from "../contract";

configureHiddenApp(app);
const root = resolve(__dirname, "..", ".."); // desktop/ (packaged: Resources/app.asar)
// Embedded artifact profile, not a runtime test switch. No new editor host is activated.
const devTrial = app.isPackaged && JSON.parse(readFileSync(join(root,"package.json"),"utf8")).botlingDevTrial === true;
// A packaged build ignores the variables tests steer the app with (src/main/packaged.ts), before anything reads them.
const scrubbed = scrubEnvironment(process.env, app.isPackaged);
if (scrubbed.length) console.warn(`[packaged] ignored ${scrubbed.join(", ")}`);
// `--check-plugin <folder>` (1.x's flag): the plugin check Maintainer runs, then exit; no window, no data folder.
const checkAt = process.argv.indexOf("--check-plugin");
if (checkAt >= 0) {
  const report = checkReport(process.argv[checkAt + 1]);
  // Written synchronously, then exit at once: nothing below (data folder, single-instance lock) runs.
  if (report.stdout) writeSync(1, report.stdout);
  if (report.stderr) writeSync(2, report.stderr);
  process.exit(report.code);
}
const renderer = rendererFiles(root, app.isPackaged, devTrial, process.argv, { appData: app.getPath("appData") });
/** Where the shell and chat page come from; a hot install (hot-install.ts) points it at a copy of the new build's. */
let rendererDir = renderer.directory;
/** After a hot install pages are served with no-store, so nothing cached from the previous build is reused. */
let rendererNoStore = renderer.development;
if (renderer.development) console.log(`[renderer] loading ${rendererDir}; Cmd+R reloads the shell, Alt+Cmd+R the chat page`);
// Preloads re-run on each page reload; a developer build dir (--botling-preload-dir) can supply them.
const preloadDir = preloadFiles(root, app.isPackaged, devTrial, process.argv).directory;
/** `--component-shot` (Phase 5a): draw one component and exit; no core, no data folder of the app's. */
const shotMode = isShotRequested(process.argv);
const dataDir = shotMode ? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "botling-shot-"))
  : resolve(process.argv.find(arg => arg.startsWith("--botling-update-data="))?.slice("--botling-update-data=".length) || process.env.BOTLING_DATA_DIR || (app.isPackaged ? join(app.getPath("appData"), packagedDataName(devTrial)) : join(root, ".data")));
const installedApp = dirname(dirname(dirname(process.execPath)));
const volumeRecovery = () => {const error=dataVolumeError(dataDir);return error?{...issueFor(dataDir,installedApp,dirname(installedApp),27),blocked:true,message:error}:null;};
const originalDataIdentity=!dataVolumeError(dataDir)?persistentDataIdentity(dataDir):undefined; // Captured before mkdir/profile/core can create data.
const startupRecovery = shotMode ? null : volumeRecovery() || blockingRecovery(dataDir,installedApp);
const traceContext=!shotMode&&!startupRecovery?syntheticTraceContext({packaged:app.isPackaged,dataDir,syntheticBase:join(root,".cache/test-data"),env:process.env}):null;
let traceWriter:InputTraceWriter|null=null;
if(!startupRecovery)mkdirSync(dataDir, { recursive: true });
const profileDir = startupRecovery ? mkdtempSync(join(process.env.TMPDIR || tmpdir(), "botling-recovery-ui-")) : join(dataDir,"electron");
// Everything Electron keeps (partitions, caches, logs) lives under the data dir, never the default.
app.setPath("userData", profileDir);
app.setPath("sessionData", profileDir);
app.setPath("crashDumps", join(profileDir, "crashes"));
app.setPath("logs", join(profileDir, "logs"));
// Tests: safeStorage seals with Chromium's mock keychain instead of the user's login keychain.
if (process.env.BOTLING_MOCK_KEYCHAIN === "1") app.commandLine.appendSwitch("use-mock-keychain");

const APP_ORIGIN = "app://botling";
const CARD_PREFIX = "botling-card://card/";
/** Component pages (Web/src's `componentPage`) the chat page hands over for its sandboxed frames. */
const PAGE_PREFIX = "botling-card://page/";
/** Result pages for preview cards (Phase 5c; core/page-preview.ts). */
const PREVIEW_PREFIX = "botling-card://preview/";
/**
 * The reused Web/src chat page, in a frame of the app page, on an origin of its own (Phase 4a): it
 * runs agent markdown and plugins' web parts, so it must not share the app page's origin (which has
 * the bridge). It reaches the app page only with postMessage.
 */
const CHAT_ORIGIN = "botling-chat://chat";
const CHAT_URL = `${CHAT_ORIGIN}/chat.html`;

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

if (!shotMode && !app.requestSingleInstanceLock({ dataDir })) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const openingWindows = new WeakMap<BrowserWindow, Promise<boolean>>();
const appContents = new Set<number>();
const recoveryContents = new Set<number>();

const core: CoreClient = new CoreClient({
  script: join(root, "out", "core", "main.cjs"),
  hostScript: join(root, "out", "host", "host-utility.mjs"),
  ledgerFile: join(dataDir, "core", "children.json"),
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
  app: async (op, args): Promise<{ ok: boolean; file?: string; error?: string; plan?: unknown }> => {
    if (op === "planBuild") {
      // A developer build's card (core/self-update.ts): would it install without a restart?
      const { plan } = await hotInstaller.plan(args.path ?? "");
      return { ok: true, plan };
    }
    if (op === "installBuild") {
      // The user confirmed a hot install on the card. Main compares again and only installs in place when the kernel is the same.
      return hotInstaller.install({ path: args.path ?? "", requester: args.requester ?? "", note: args.note ?? "", from: args.from ?? "", to: args.to ?? "" });
    }
    if (op === "quit") {
      // An install of a developer build: the script outside the app waits for it to quit.
      note("quitting to install a developer build");
      setTimeout(() => app.quit(), 100);
      return { ok: true };
    }
    if (op === "installRelease") {
      // The user picked Install and restart on the update notice in the main bot's chat (core/self-update.ts):
      // download and verify the newer release unless it is already, then restart on it.
      try {
        const state = await updater.check(true);
        if (!state.newer) return { ok: false, error: "There is no newer release." };
        if (installer.ready !== state.newer.version) await installer.stage(state.newer);
        note(`installing release ${state.newer.version} and restarting`);
        await installer.restart(process.pid);
        setImmediate(() => app.quit());
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 500) };
      }
    }
    // A picture of the main window as it is (no focus change, nothing shown).
    const window = mainWindow;
    if (!window || window.isDestroyed()) return { ok: false, error: "No window." };
    const image = await window.webContents.capturePage();
    if (image.isEmpty()) return { ok: false, error: "The window drew nothing." };
    const folder = join(dataDir, "core", "self-update", "screenshots");
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `window-${Date.now()}.png`);
    writeFileSync(file, image.toPNG());
    return { ok: true, file };
  },
  seal: (op, text) => {
    // Plugins' secrets: sealed with the OS keychain's key (safeStorage); only the core asks, over its own port.
    if (!safeStorage.isEncryptionAvailable()) throw new Error("This computer offers no safe storage for secrets.");
    return op === "seal" ? safeStorage.encryptString(text).toString("base64") : safeStorage.decryptString(Buffer.from(text, "base64"));
  },
});

let lastEpoch: string | null = null;
// Core hot swap (docs/core-hot-swap.md): a newer core build replaces the running one without an app restart.
const coreSwap = installCoreSwap({ core, root, dataDir, packaged: app.isPackaged, devTrial, argv: process.argv, note });

/**
 * Developer builds installed without a restart when the kernel is the same (hot-install.ts, docs/core-hot-swap.md):
 * only for a packaged app bundle, only the build the core's confirmed card names (never a folder from argv).
 * Reads bundles with original-fs: app.asar as the file it is, not through Electron's cache of the running one.
 */
const run = promisify(execFile);
const hotInstaller: HotInstaller = new HotInstaller({
  target: app.isPackaged && process.platform === "darwin" && installedApp.endsWith(".app") ? installedApp : null,
  dataDir,
  fs: originalFs as unknown as typeof import("node:fs"),
  run: (file, args) => run(file, args, { timeout: 10 * 60_000 }),
  notify: (report) => { note(`hot install: ${JSON.stringify({ ok: report.ok, applied: report.applied, disk: report.disk, error: report.error })}`); core.reportInstall(report); },
  ports: {
    coreScript: (): string => core.script,
    swapCore: (script) => coreSwap.swap({ script }),
    useRenderer: (dir) => { const before = rendererDir; rendererDir = dir; rendererNoStore = true; return before; },
    reloadChat: async () => {
      const window = mainWindow;
      if (!window || window.isDestroyed()) return true;
      await session.defaultSession.clearCache().catch(() => {});
      return reloadNativeEditor(window.webContents);
    },
    reloadShell: async () => {
      const window = mainWindow;
      if (!window || window.isDestroyed()) return true; // The next window loads the new shell.
      await session.defaultSession.clearCache().catch(() => {});
      const contents = window.webContents;
      const loaded = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 30_000);
        contents.once("did-finish-load", () => { clearTimeout(timer); resolve(true); });
      });
      contents.reloadIgnoringCache();
      if (!(await loaded)) return false;
      // Up means React has the core's first state, as for an update's boot receipt.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !window.isDestroyed()) {
        if (await contents.executeJavaScript(`Boolean(document.querySelector('.shell[data-ready="1"]'))`).catch(() => false)) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    },
    log: note,
  },
});

/**
 * GitHub Releases discovery, enabled by default. Installation is verified and requires a click.
 * Tests (unpackaged only) point it at a JSON file with BOTLING_TEST_UPDATE_FEED.
 */
const updatesFile = join(dataDir, "updates.json");
const installer = new VerifiedInstaller({
  current: app.getVersion(), appPath: installedApp, dataDir,
  publicKey: __UPDATE_PUBLIC_KEY__, platform: app.isPackaged ? process.platform : "development", arch: process.arch,
  fetch: (url) => net.fetch(url, { signal: AbortSignal.timeout(120_000) }),
  launchArgs: process.argv.filter(arg => arg === "--use-mock-keychain" || /^--remote-debugging-port=\d+$/.test(arg)),
});
const updater = new Updater({
  current: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  installStatus: () => ({ installError: installer.unavailable(), readyVersion: installer.ready, ...visibleRecovery(dataDir) }),
  enabled: async () => ((await core.call({ type: "settings.get" })) as { updateCheck?: boolean }).updateCheck === true,
  fetchFeed: async () => {
    const test = !app.isPackaged ? process.env.BOTLING_TEST_UPDATE_FEED : undefined;
    if (test) return JSON.parse(readFileSync(test, "utf8"));
    const response = await net.fetch(FEED, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `Botling/${app.getVersion()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  },
  load: () => {
    try {
      const value = JSON.parse(readFileSync(updatesFile, "utf8"));
      return typeof value?.checkedAt === "number" ? { checkedAt: value.checkedAt, newer: value.newer ?? null } : null;
    } catch { return null; }
  },
  save: (state) => { try { writeFileSync(updatesFile, JSON.stringify(state)); } catch { /* the next check tries again */ } },
});
/**
 * A newer release goes to the main bot's chat as an update notice (core/self-update.ts, once per version and
 * run); installing it waits for the user's pick there. Checked at start and every 6 hours, as Settings has it.
 */
function announce(view: UpdateView): UpdateView {
  if (view.enabled && view.newer) {
    const unavailable = installer.unavailable() ?? (view.newer.asset ? null : "this release has no download for this computer.");
    core.announceRelease({ version: view.newer.version, name: view.newer.name, url: view.newer.url, current: app.getVersion(), unavailable });
  }
  return view;
}
const checkForRelease = () => { void updater.check(false).then(announce, (error) => note(`update check: ${String(error)}`)); };
/** Tests: the release pages main opened (BOTLING_NO_EXTERNAL=1 opens nothing for real). */
const openedReleases: string[] = [];
(globalThis as unknown as { __botlingOpenedReleases: string[] }).__botlingOpenedReleases = openedReleases;

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
  // Developer mode's builds (core/self-update.ts): main's pid (the install script waits for it to quit), the
  // data folder the new build opens with, and the bundle this is (macOS app bundles only).
  env.BOTLING_MAIN_PID = String(process.pid);
  env.BOTLING_APP_DATA_DIR = dataDir;
  if (app.isPackaged && process.platform === "darwin" && installedApp.endsWith(".app")) env.BOTLING_APP_BUNDLE = installedApp;
  else delete env.BOTLING_APP_BUNDLE;
  env.BOTLING_UPDATE_PENDING = process.argv.some(arg => arg.startsWith("--botling-update-token=")) ? "1" : "0";
  // Maintainer's component-shot command: this build in shot mode (1.x: "'<botling>' --component-shot").
  const quoted = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
  const self = `env -u ELECTRON_RUN_AS_NODE ${quoted(process.execPath)}${app.isPackaged ? "" : ` ${quoted(root)}`}`;
  env.BOTLING_SHOT_COMMAND ??= `${self} --component-shot`;
  // And its plugin check (1.x: "'<botling>' --check-plugin"); a packaged build cannot run Electron as Node.
  env.BOTLING_CHECK_COMMAND ??= `${self} --check-plugin`;
  // The fake CLIs are development's (a packaged build ships neither and always runs the real ones).
  if (!app.isPackaged) {
    env.BOTLING_FAKE_CLI ??= join(root, "test", "fixtures", "fake-claude.mjs");
    env.BOTLING_FAKE_CODEX ??= join(root, "test", "fixtures", "fake-codex.mjs");
  }
  // Trial artifacts skip automatic 1.x import. Explicit imports and read-only project-lock
  // detection remain separate; ordinary packaged behavior is unchanged.
  directoryDefaults(env, process.env.HOME || homedir(), app.isPackaged, devTrial);
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
    backgroundColor: "#0E0E10", show:false,
    webPreferences: {
      session: siteSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false,
      // No preload: a website has no Botling API at all.
    },
  });
  window.once("ready-to-show",()=>{if(!hidden)window.show();});
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

// A separate diagnostic channel: renderer arguments cannot grant main persistence authority.
ipcMain.on(TEST_TRACE_CHANNEL,(event,record:unknown)=>acceptTraceIPC(traceWriter,()=>{
  const frame=event.senderFrame;if(!frame)return null;
  return{owned:appContents.has(event.sender.id),isMainFrame:frame===event.sender.mainFrame,
    url:frame.url,contentsId:event.sender.id,processId:frame.processId,routingId:frame.routingId};
},record));

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
  // A component shot measures every component page: the probe goes first in its head.
  pages.set(token, { html: shotMode && !panel ? withProbe(html) : html, panel });
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
  const access = await core.call({type:"link.authorize",botId,url});
  if (!access.result) throw Object.assign(new Error("That link is not one of this bot's results."), { code: "not_found" });
  return openLink(url);
}
async function openOrdinaryLink(botId: string, url: string, source: "user" | "component", messageId?:string,pinId?:string,reveal=false): Promise<{opened:boolean}> {
  // A file attached in this chat, as the chat page shows it (served by the chat origin): the file it
  // names, which the core accepts only when a line of this chat has it (1.x opens it like any link).
  url = attachmentFile(url, botId) ?? url;
  const access = await core.call({type:"link.authorize",source,botId,url,...(messageId?{messageId}:{}),...(pinId?{pinId}:{})});
  if (!(source === "user" && /^(https?|mailto):/i.test(url)) && !access.linked) throw Object.assign(new Error("That link is not in this chat."),{code:"not_found"});
  return openLink(url, reveal);
}
/** `reveal`: the lightbox's "Show in Finder" (a local file only, shown in Finder rather than opened). */
async function openLink(url: string, reveal = false): Promise<{opened:boolean}> {
  const external = process.env.BOTLING_NO_EXTERNAL === "1";
  if (/^(https?|mailto):/i.test(url)) {
    if (reveal) throw Object.assign(new Error("Only a file can be shown in Finder."), { code: "not_found" });
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
  if (!reveal && RESULT_TYPES.has(dot >= 0 ? path.slice(dot).toLowerCase() : "")) {
    const problem = await shell.openPath(path);
    if (problem) throw new Error(problem);
  } else {
    shell.showItemInFolder(path);
  }
  return { opened: true };
}

/**
 * A component card's report: the card as it looks now (1.x's `snapshot(of:in:)`), taken from the app's
 * window at `rect`, goes to the core with the user's words and pictures. A page cannot supply its own.
 */
async function reportComponent(cmd: Extract<Command, { type: "component.report" }>, sender: WebContents): Promise<unknown> {
  const { screenshot: _ignored, ...rest } = cmd;
  let screenshot: string | undefined;
  if (cmd.rect) {
    try {
      const rect = { x: Math.max(0, Math.round(cmd.rect.x)), y: Math.max(0, Math.round(cmd.rect.y)), width: Math.max(1, Math.round(cmd.rect.width)), height: Math.max(1, Math.round(cmd.rect.height)) };
      const image = await sender.capturePage(rect);
      if (!image.isEmpty()) screenshot = image.toPNG().toString("base64");
    } catch (error) {
      note(`component report: no screenshot (${(error as Error).message})`);
    }
  }
  return core.call({ ...rest, ...(screenshot ? { screenshot } : {}) });
}

/** "Not right" on a reply: the chat as you saw it (its frame's rect), then the core sends the report. */
async function withScreenshot(cmd: Extract<Command, { type: "chat.feedback" }>, sender: WebContents): Promise<unknown> {
  const { screenshot: _ignored, ...rest } = cmd;
  let screenshot: string | undefined;
  try {
    const rect = cmd.rect ? { x: Math.max(0, Math.round(cmd.rect.x)), y: Math.max(0, Math.round(cmd.rect.y)), width: Math.max(1, Math.round(cmd.rect.width)), height: Math.max(1, Math.round(cmd.rect.height)) } : undefined;
    const image = await sender.capturePage(rect);
    if (!image.isEmpty()) screenshot = image.toPNG().toString("base64");
  } catch (error) {
    note(`feedback: no screenshot (${(error as Error).message})`);
  }
  return core.call({ ...rest, ...(screenshot ? { screenshot } : {}) });
}

async function handleInMain(cmd: Command, sender: WebContents): Promise<unknown> {
  switch (cmd.type) {
    case "result.open": return openResult(cmd.botId, cmd.url);
    case "link.open": return openOrdinaryLink(cmd.botId, cmd.url, cmd.source,cmd.messageId,cmd.pinId,cmd.reveal===true);
    case "doctor.copy": return copyDoctorFix(cmd.tool, await core.call({ type: "doctor.view" }), text => clipboard.writeText(text));
    case "updates.dismiss": { await dismissRecovery(dataDir,cmd.id); return {dismissed:true}; }
    case "chat.reloadPage": return { reloaded: await reloadNativeEditor(sender) };
    case "updates.check": return announce(await updater.check(cmd.manual));
    case "updates.copies": return retainedUpdateCopies(dataDir,installedApp,await runningAppBundles());
    case "updates.deleteCopy": {
      const copy=(await retainedUpdateCopies(dataDir,installedApp,await runningAppBundles())).find(copy=>copy.id===cmd.id);
      if(!copy)throw new Error("The recovery copy changed. Refresh the list.");
      if(!copy.deletable)throw new Error(copy.reason!);
      const confirmation=await dialog.showMessageBox(BrowserWindow.fromWebContents(sender)!,{type:'warning',buttons:['Keep copy','Permanently delete this copy'],defaultId:0,cancelId:0,
        message:copy.role==='newer'?'Delete NEWER candidate user data?':'Delete this retained recovery copy?',
        detail:copy.path+'\n'+copy.bytes.toLocaleString()+' bytes\n'+(copy.role==='newer'?'This is data written by the newer candidate, possibly containing messages absent from the older snapshot. ':'')+'This deletes only the selected copy and cannot be undone.'});
      if(confirmation.response!==1)return{deleted:false};
      await deleteRetainedUpdateCopy(dataDir,installedApp,cmd.id,await runningAppBundles());return{deleted:true};
    }
    case "updates.stage": {
      const state = await updater.check(true);
      if (!state.newer) throw new Error("There is no newer release to download");
      await installer.stage(state.newer);
      return updater.view(state.enabled);
    }
    case "updates.restart": {
      await installer.restart(process.pid);
      // Let the explicit click's response reach the renderer before normal core shutdown.
      setImmediate(() => app.quit());
      return { restarting: true };
    }
    case "updates.open": {
      const page = updater.releasePage();
      if (!page) throw Object.assign(new Error("There is no newer release to open."), { code: "not_found" });
      openedReleases.push(page);
      if (process.env.BOTLING_NO_EXTERNAL !== "1") await shell.openExternal(page);
      return { opened: true };
    }
    case "component.report": return reportComponent(cmd, sender);
    case "chat.feedback": return withScreenshot(cmd, sender);
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
    const nativeRule=nativeEditorNavigation(contents,details);
    if(nativeRule!==null){if(!nativeRule){details.preventDefault();note("blocked native editor navigation");}return;}
    const isApp = appContents.has(contents.id);
    if (details.isMainFrame) {
      if(recoveryContents.has(contents.id))return; // The recovery window refuses every navigation in will-navigate.
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
      allowed = (!hasNativeEditorHost(contents)||details.url===`${CHAT_URL}?spec=1`) && parent === mainFrame && (!initiator || initiator === mainFrame);
    } else if (details.url.startsWith(CARD_PREFIX) || details.url.startsWith(PAGE_PREFIX)) {
      allowed = (!initiator || initiator === mainFrame || chatFrame(initiator)) && (parent === mainFrame || chatFrame(parent));
    } else if (details.url.startsWith(PREVIEW_PREFIX)) {
      // A result page in a preview card: only as a component page's own child, put there by that page (Phase 5c).
      const componentPage = (frame: Electron.WebFrameMain | null | undefined) => !!frame && frame.url.startsWith(PAGE_PREFIX) && chatFrame(frame.parent);
      allowed = componentPage(parent) && (!initiator || initiator === parent);
    }
    if (!allowed) {
      details.preventDefault();
      note(`blocked a frame navigating to ${details.url} (initiator ${initiator?.url ?? "none"})`);
    }
  });
});

function traceFrameIdentity(frame:{processId:number;routingId:number;frameTreeNodeId:number}|null){
  try{return frame?{processId:frame.processId,routingId:frame.routingId,frameTreeNodeId:frame.frameTreeNodeId}:null;}catch{return null;}
}
function createWindow() {
  const window = new BrowserWindow({
    width: 1120, height: 820, minWidth: 640, minHeight: 480,
    title: "Botling", backgroundColor: "#0E0E10", show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(preloadDir, "preload.cjs"),
      additionalArguments:["--botling-editor-shell=1",...(traceWriter?[TEST_TRACE_ARGUMENT]:[])],
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, allowRunningInsecureContent: false, navigateOnDragDrop: false, spellcheck: false,
    },
  });
  appContents.add(window.webContents.id);
  const id = window.webContents.id;
  window.on('focus',()=>traceWriter?.observe('native.window.focus',{contentsId:id}));
  window.on('blur',()=>traceWriter?.observe('native.window.blur',{contentsId:id}));
  window.webContents.on('focus',()=>traceWriter?.observe('native.contents.focus',{contentsId:id}));
  window.webContents.on('blur',()=>traceWriter?.observe('native.contents.blur',{contentsId:id}));
  window.webContents.on('did-start-navigation',(details)=>traceWriter?.observe('native.navigation.start',{contentsId:id,url:details.url.slice(0,2048),isMainFrame:details.isMainFrame,frame:traceFrameIdentity(details.frame)}));
  window.webContents.on('did-frame-finish-load',(_event,isMainFrame,processId,routingId)=>traceWriter?.observe('native.frame.loaded',{contentsId:id,isMainFrame,processId,routingId}));
  window.webContents.on('did-finish-load',()=>traceWriter?.observe('native.document.loaded',{contentsId:id}));
  window.on("closed", () => { appContents.delete(id); if (mainWindow === window) mainWindow = null; });
  const ownerReady=window.loadURL(`${APP_ORIGIN}/index.html`);
  const editor=prepareNativeEditorHost(window,root,ownerReady,preloadDir);
  const opening=editor.revealWhenReady(hidden);
  openingWindows.set(window,opening);
  void opening.catch(error=>note(`native editor initialization failed: ${String(error)}`));
  mainWindow = window;
  return window;
}

const NO_SNIFF = { "X-Content-Type-Options": "nosniff" };

/** A file of the chat origin: the page's own, a plugin's stylesheet (and its fonts), or an attachment or local picture/video the chat names. */
async function chatFile(url: URL, request: Request): Promise<Response | null> {
  const path = url.pathname;
  if (CHAT_FILES.test(path)) {
    const response = await net.fetch(pathToFileURL(join(rendererDir, path)).toString());
    return rendererResponse(response, rendererNoStore, path === "/chat.html" ? CHAT_CSP : undefined);
  }
  // A plugin's stylesheet or a font beside it (only files the core says the plugin ships for its web part).
  const style = /^\/plugin-files\/([a-z0-9][a-z0-9._-]*)\/(.+)$/.exec(path);
  if (style) {
    const answer = await core.request({ type: "plugins.file", name: style[1]!, path: decodeURIComponent(style[2]!) });
    if (!answer.ok) return null;
    const { path: file, type } = answer.result as { path: string; type: string };
    try { return new Response(readFileSync(file), { headers: { "Content-Type": type, ...NO_SNIFF, "Cache-Control": "no-store" } }); } catch { return null; }
  }
  // A file a message (or the input box) in this bot's chat has attached, or a picture or video a line
  // shows by its local path; never any other path.
  const attached = attachmentTarget(path);
  if (attached) {
    const answer = await core.request({ type: "attachment.file", botId: attached.botId, ref: attached.ref });
    if (!answer.ok) return null;
    const { path: file, type } = answer.result as { path: string; type: string };
    // Streamed, with byte ranges, so a video plays and seeks as in 1.x.
    try {
      return await previewResponse(file, request, { type, follow: true, csp: "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'" });
    } catch { return null; }
  }
  return null;
}

function serveApp() {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "botling") return new Response("Not found", { status: 404 });
    // The component shot's host page (shot mode only).
    if (shotMode && url.pathname === "/shot.html") return new Response(SHOT_HTML, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": APP_CSP.replace("img-src 'self' data:", "img-src 'self' data: blob:") } });
    if (shotMode && url.pathname === "/shot.js") return new Response(SHOT_JS(PROTOCOL_VERSION), { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    const file = normalize(join(rendererDir, decodeURIComponent(url.pathname)));
    // The chat page and its files are the chat origin's, not the app's.
    if (!file.startsWith(rendererDir + sep) || CHAT_FILES.test(url.pathname)) return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString());
    return rendererResponse(response, rendererNoStore, file.endsWith(".html") ? APP_CSP : undefined);
  });
  protocol.handle("botling-chat", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "chat") return new Response("Not found", { status: 404 });
    const served = await chatFile(url, request);
    if (!served) return new Response("Not found", { status: 404 });
    return served;
  });
  protocol.handle("botling-card", async (request) => {
    const url = new URL(request.url);
    if (url.host === "preview") {
      // A result page (or a file beside it) for a preview card's frame: only inside an artifacts folder, through symlinks.
      const file = previewFile(request.url);
      if (!file) return new Response("Not found", { status: 404 });
      try {
        return await previewResponse(file, request);
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
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

/** A hidden window of the shot's, an app window (its host page talks to main as the app page does). */
function shotWindow(size: { width: number; height: number }): BrowserWindow {
  const window = new BrowserWindow({
    width: size.width, height: size.height, useContentSize: true, show: false, paintWhenInitiallyHidden: true, backgroundColor: "#0E0E10",
    webPreferences: { preload: join(preloadDir, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true },
  });
  appContents.add(window.webContents.id);
  const id = window.webContents.id;
  window.on("closed", () => { appContents.delete(id); });
  mainWindow = window;
  return window;
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([...appMenuTemplate(process.platform,{reloadChat:reloadNativeEditor}), ...coreSwap.menu]));
  // The app is dark whatever the system says, as 1.x's windows (`preferredColorScheme(.dark)`): pages and component
  // frames that ask (prefers-color-scheme) draw their dark look (Phase 5c).
  nativeTheme.themeSource = "dark";
  hardenSession(session.defaultSession);
  serveApp();
  if (shotMode) {
    const giveUp = setTimeout(() => { process.stderr.write("Gave up: drawing took over 3 minutes.\n"); app.exit(3); }, 180_000);
    void runShot(process.argv, shotWindow, (text) => process.stdout.write(text + "\n"), (text) => process.stderr.write(text + "\n"))
      .then((code) => code, (error) => { process.stderr.write(`It could not draw: ${(error as Error).message}\n`); return 3; })
      .then((code) => {
        clearTimeout(giveUp);
        try { rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Chromium may still write its profile there */ }
        app.exit(code);
      });
    return;
  }
  let recoveryMode=Boolean(startupRecovery);
  const restartNormal = () => {
    app.relaunch({args:[...process.argv.slice(1).filter(arg=>!arg.startsWith('--botling-update-token=')&&!arg.startsWith('--botling-update-data=')),'--botling-update-data='+dataDir]});app.quit();
  };
  const recoveryHost=new RecoveryWindowHost<BrowserWindow>();
  let recoveryIssue:NonNullable<ReturnType<typeof blockingRecovery>>;
  let acting=false,renderGeneration=0;
  let cachedCopies:Awaited<ReturnType<typeof recoveryCopies>>=[],copiesIssue='';
  const renderRecovery=async(error?:string,busy?:string)=>{
    const generation=++renderGeneration,issue=recoveryIssue;
    const window=recoveryHost.get(makeRecoveryWindow);
    if(!busy||copiesIssue!==issue.id){
      if(!busy)await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(recoveryHTML(issue,error,cachedCopies,'Inspecting retained copies…')));
      cachedCopies=await recoveryCopies(issue);copiesIssue=issue.id;
    }
    const copies=cachedCopies;
    if(generation===renderGeneration&&!window.isDestroyed())await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(recoveryHTML(issue,error,copies,busy)));
  };
  function makeRecoveryWindow(){
    const previousWindow=mainWindow;
    const window=new BrowserWindow({width:900,height:700,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    window.once("ready-to-show",()=>{if(!hidden)window.show();});mainWindow=window;
    if(previousWindow&&!previousWindow.isDestroyed())previousWindow.destroy();
    recoveryContents.add(window.webContents.id);const recoveryID=window.webContents.id;
    window.on("closed",()=>{recoveryContents.delete(recoveryID);if(mainWindow===window)mainWindow=null;});
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',(event,url)=>{
      event.preventDefault();if(acting)return;
      const issue=recoveryIssue;let action:URL;try{action=new URL(url);}catch{return;}
      if(action.protocol!=='botling-recovery:'||action.hostname!=='action'||action.searchParams.get('id')!==issue.id)return;
      if(action.pathname==='/retry'&&issue.code===27){if(volumeRecovery())showRecovery(volumeRecovery()!);else restartNormal();return;}
      if(action.pathname==='/open'){
        const path=issue.paths?.find(p=>p.label!=='Current data'&&existsSync(p.path))?.path;
        if(path)void shell.openPath(path).catch(()=>{});return;
      }
      if(!['/continue','/delete'].includes(action.pathname))return;
      acting=true;let lastProgress=0;
      const progress=(message:string)=>{if(Date.now()-lastProgress>250){lastProgress=Date.now();void renderRecovery(undefined,message).catch(error=>note(String(error)));}};
      void (async()=>{
        if(action.pathname==='/delete'){
          const copies=await recoveryCopies(issue),older=copies.filter(copy=>copy.role!=='newer');
          const confirmation=await dialog.showMessageBox(window,{type:'warning',buttons:['Keep copies','Delete older recovery copies'],defaultId:0,cancelId:0,message:'Permanently delete older recovery copies?',detail:older.map(copy=>copy.path+' ('+copy.bytes.toLocaleString()+' bytes)').join('\n')+'\nNewer candidate data is kept. The live core data must be validated. A running or only available app is kept.'});
          if(confirmation.response===1)await deleteRecoveryCopies(issue,await runningAppBundles(),false,progress);
          // Newer candidate data requires its own confirmation identifying the exact path/size.
          const newer=copies.find(copy=>copy.role==='newer');
          if(newer){const choice=await dialog.showMessageBox(window,{type:'warning',buttons:['Keep newer data','Delete this NEWER data copy'],defaultId:0,cancelId:0,message:'Delete NEWER candidate user data?',detail:newer.path+'\n'+newer.bytes.toLocaleString()+' bytes\nThis may contain newer messages absent from the older snapshot. This cannot be undone.'});
            if(choice.response===1){const copy=(await retainedUpdateCopies(dataDir,installedApp,await runningAppBundles())).find(copy=>copy.path===newer.path);if(!copy)throw new Error('The newer copy changed. Refresh the page.');await deleteRetainedUpdateCopy(dataDir,installedApp,copy.id,await runningAppBundles());}}
          acting=false;showRecovery(issue);return;
        }
        const current=blockingRecovery(dataDir,installedApp);
        if(current)await completeRecovery(dataDir,installedApp,issue.id,progress);
        else if(!existsSync(dataDir)||volumeRecovery())throw new Error('The original data directory is unavailable.');
        restartNormal();
      })().catch(error=>{acting=false;showRecovery(blockingRecovery(dataDir,installedApp)||issue,String(error.message||error));});
    });return window;
  }
  const showRecovery = (issue: NonNullable<ReturnType<typeof blockingRecovery>>,error?:string) => {
    recoveryMode=true;recoveryIssue=issue;
    if(issue.code!==27)recoveryIssue={...issue,...issueFor(issue.dataDir,issue.target,issue.root,issue.code,issue.id.slice(0,issue.id.lastIndexOf(':')),issue.at)};
    void renderRecovery(error).catch(error=>note('Recovery display: '+String(error)));
  };
  app.on("activate", () => { if (!mainWindow) {const blocked=volumeRecovery()||blockingRecovery(dataDir,installedApp);if(blocked)showRecovery(blocked);else if(recoveryMode)restartNormal();else createWindow();} });
  if(startupRecovery){showRecovery(startupRecovery);return;}
  await recoverUpdates(dataDir, installedApp, false);
  const blocked=blockingRecovery(dataDir,installedApp);
  if(blocked){showRecovery(blocked);return;}
  if(traceContext){try{traceWriter=await InputTraceWriter.open(traceContext);}catch(error){note('Synthetic trace disabled: '+String(error));}}
  const collect=()=>void recoverUpdates(dataDir,installedApp).catch(error=>note('Update cleanup: '+String(error)));
  const sweep=setInterval(collect,30_000);sweep.unref();
  core.start();
  createWindow();
  collect();
  checkForRelease();
  setInterval(checkForRelease, CHECK_EVERY_MS).unref();
  mainWindow?.webContents.once("did-finish-load", () => {
    if (!process.argv.some((arg) => arg.startsWith("--botling-update-token="))) return;
    // A loaded HTML file alone is not a healthy boot: React must receive the core's first state.
    void (async () => {
      await core.call({ type: "settings.get" });
      while (mainWindow && !mainWindow.isDestroyed()) {
        const ready = await mainWindow.webContents.executeJavaScript(`Boolean(document.querySelector('.shell[data-ready="1"]'))`);
        if (ready && acknowledgeUpdateBoot(dataDir, installedApp, app.getVersion(), process.argv)) {
          const pending = JSON.parse(readFileSync(join(dataDir, "update-pending.json"), "utf8"));
          while (mainWindow && !mainWindow.isDestroyed()) {
            const decision=await commitUpdateReceipt(dataDir,installedApp,app.getVersion(),process.argv,originalDataIdentity);
            if(decision==='committed'){
              await core.commitUpdateBoot();
              await writeRecord(join(dataDir,'update-last-boot.json'),{token:pending.token,receipt:readFileSync(join(pending.root,'boot.ok'),'utf8'),version:app.getVersion(),activated:true,orphan:existsSync(join(dataDir,'update-orphan-commit.json'))});
              writeFileSync(join(pending.root,"activated.ok"),pending.token,{mode:0o600});
              collect();return;
            }
            if(decision==='blocked'){
              await core.stop();const issue=blockingRecovery(dataDir,installedApp)||issueFor(dataDir,installedApp,dirname(installedApp),25);showRecovery(issue);return;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })().catch(error => note("Update boot handoff: "+String(error)));
  });
});

app.on("second-instance", () => {
  const window=mainWindow;
  if(hidden||!window)return;
  void (openingWindows.get(window)??Promise.resolve(true)).then(ready=>{
    if(ready&&!window.isDestroyed()){window.show();window.focus();}
  },()=>{});
});

// Closing the window does not stop work: the core keeps running (macOS convention). Quitting does.
app.on("window-all-closed", () => {
  if (shotMode) return;
  if (process.platform !== "darwin" || process.env.BOTLING_QUIT_ON_CLOSE === "1") app.quit();
});

process.on("SIGTERM", () => app.quit());
let stopping = false;
app.on("before-quit", (event) => {
  if (stopping) return;
  stopping = true;
  event.preventDefault();
  // Cookies are written to disk lazily; make sure each account's are there before exiting.
  const flushes = [...openedSessions].map((opened) => opened.cookies.flushStore().catch(() => {}));
  web.closeAll();
  void Promise.allSettled([core.stop(), installer.discard(), ...flushes]).then(async () => {
    ipcMain.removeAllListeners(TEST_TRACE_CHANNEL);
    try{await traceWriter?.close();}catch(error){note('Synthetic trace flush failed: '+String(error));}
    if(startupRecovery)rmSync(profileDir,{recursive:true,force:true});app.exit(0);
  });
});

// For tests: which pid the core has.
(globalThis as unknown as { __botlingCorePid: () => number | undefined }).__botlingCorePid = () => core.pid;
(globalThis as unknown as { __botlingSwapCore: typeof coreSwap.swap }).__botlingSwapCore = coreSwap.swap;
(globalThis as unknown as { __botlingShotCommand: string | undefined }).__botlingShotCommand = shotMode ? undefined : coreEnvironment().BOTLING_SHOT_COMMAND;
(globalThis as unknown as { __botlingCheckCommand: string | undefined }).__botlingCheckCommand = shotMode ? undefined : coreEnvironment().BOTLING_CHECK_COMMAND;
(globalThis as unknown as { __botlingHostPids: () => number[] }).__botlingHostPids = () => core.hostPids;
(globalThis as unknown as { __botlingPluginGroups: () => number[] }).__botlingPluginGroups = () => core.pluginGroups;
void PROTOCOL_VERSION;
