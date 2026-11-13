// Electron main: thin. It owns windows, sessions and protocols, checks every IPC message (who sent
// it and what it is), and relays the rest to the core process. It runs no agents and keeps no chat.
import { app, BrowserWindow, Menu, clipboard, dialog, ipcMain, nativeImage, nativeTheme, protocol, safeStorage, session, shell, net, type WebContents, type Session, type IpcMainEvent } from "electron";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isRequested as isShotRequested, withProbe } from "../core/component-shot";
import { runShot, SHOT_HTML, SHOT_JS } from "./shot";
import { scrubEnvironment } from "./packaged";
import {configureHiddenApp,hidden} from "./hidden-mode";
import { permissionAllowed } from "./permissions";
import {nativeEditorNavigation,hasNativeEditorHost,isNativeEditorHost,prepareNativeEditorHost,reloadNativeEditor,nativeEditorLayer} from "./editor-host";
import {captureScale,composeWindow} from "./window-capture";
import {appMenuTemplate} from "./app-menu";
import {bindingsFor} from "../contract/shortcuts";
import {CHAT_FILES,preloadFiles,rendererFiles,rendererResponse} from "./renderer-loading";
import { autoUpdater } from "electron-updater";
import { CHECK_EVERY_MS, Updater } from "./updates";
import { linkOpenWay, markdownLinkPath, reportPreviewURL, shellReportNavigation } from "./report-preview";
import { MARKDOWN_CSP, markdownPage, markdownResponse, markdownStyles } from "./markdown-page";
import { pluginLinkRoute } from "../core/plugin-link";
import { createBrowserHost, type BrowserHost } from "./browser-host";
import { SiteToolStore } from "./site-tools";
import { SITE_TOOLS_GUIDE_TEXT } from "./site-tools-guide";
import { SITE_TOOLS_FOLDER } from "../core/site-tools-guard";
import { BrowserBotHost } from "./browser-bot-host";
import { parseBrowserBotRequest } from "../browser-bot";
import { BROWSER_CHANNEL, isWebUrl, parseBrowserUp } from "../browser-wire";
import { previewResponse } from "./preview-response";
import { reportNeedsMark, resolveReportTheme, themeHtml, type ReportTheme } from "./report-theme";
import { themeSourceFor, windowBackground, type AppTheme } from "./app-theme";
import {InputTraceWriter,syntheticTraceContext,acceptTraceIPC} from "./input-trace";
import {TEST_TRACE_ARGUMENT,TEST_TRACE_CHANNEL} from "../test-trace";
import {directoryDefaults,packagedDataDir} from "./main-environment";
import { StartupMarks } from "../startup-marks";
import { checkReport } from "../core/plugins/check-report";
import { INSPECT_FLAG, inspectReport } from "../core/plugins/inspect-report";
import { appCommandScript } from "../core/plugins/app-command";
import { CoreClient } from "./core-client";
import { readLockHolder } from "../core/store/data-dir-lock";
import { copyDoctorFix } from "./doctor-copy";
import { COMPONENT_CSP, PANEL_CSP, PREVIEW_CSP, PREVIEW_TYPES, tileNavigation, cardPreviewNavigation } from "./card-page";
import { PAGE_COMPONENT, previewFile } from "../core/preview-url";
import { linkDragTarget } from "./link-drag";
import { attachmentFile, attachmentLine, attachmentTarget, cardImageToken } from "../contract/attachment-url";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { openWorkerFile } from "./worker-file";
import { createRequire } from "node:module";
import {
  MAIN_COMMANDS, PROTOCOL_VERSION, RENDERER_COMMANDS, errorResponse, okResponse, parseInbound,
  type Command, type EventEnvelope, type ResponseEnvelope, type UpdateView,
} from "../contract";

// Startup milestones (startup-marks.ts), written to <logs>/startup.log once the log folder is known.
const startup = new StartupMarks({ file: null });
startup.mark("process.entry");
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
// `--inspect-plugins list | <query> [json]` (ADR-006 M2): the Maintainer's read-only questions about the plugin world, then exit.
const inspectAt = process.argv.indexOf(INSPECT_FLAG);
if (inspectAt >= 0) {
  const report = inspectReport(process.argv.slice(inspectAt + 1), {
    cwd: process.cwd(),
    builtIns: app.isPackaged ? join(process.resourcesPath, "builtin-plugins") : join(root, "out", "builtin-plugins"),
    themeCssFile: join(root, "out", "renderer", "styles.css"),
  });
  if (report.stdout) writeSync(1, report.stdout);
  if (report.stderr) writeSync(2, report.stderr);
  process.exit(report.code);
}
// `--render-report <spec.json> <…/artifacts/page.html> [--slides] [--force] | --check <spec.json>`: the report
// command bots run (desktop/reports/cli.ts, bundled to the plugin's report.cjs), then exit; synchronous,
// no window, no data folder.
// The command is botling.report's (`contributes.agentCommands`), found in the plugins shipped with the app, or in
// <data dir>/plugin-overrides/botling.report when that folder has one (a rebuilt renderer, used from the next call on, and its guide,
// which the core links bots to: app-command.ts).
// A bot runs this with the core's environment, where BOTLING_DATA_DIR is <data dir>/core and BOTLING_APP_DATA_DIR the data dir.
const reportAt = process.argv.indexOf("--render-report");
if (reportAt >= 0) {
  const overrides = join(resolve(process.env.BOTLING_APP_DATA_DIR || process.env.BOTLING_DATA_DIR || (app.isPackaged ? packagedDataDir(app.getPath("appData"), devTrial) : join(root, ".data"))), "plugin-overrides");
  const script = appCommandScript(app.isPackaged ? join(process.resourcesPath, "builtin-plugins") : join(root, "out", "builtin-plugins"), "--render-report", overrides);
  if (!script) { writeSync(2, "--render-report: the botling.report plugin is not in this build.\n"); process.exit(1); }
  const { runCli } = createRequire(__filename)(script) as { runCli(args: string[]): number };
  process.exit(runCli(process.argv.slice(reportAt + 1)));
}
/** `--component-shot` (Phase 5a): draw one component and exit; no core, no data folder of the app's. */
const shotMode = isShotRequested(process.argv);
const dataDir = shotMode ? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "botling-shot-"))
  : resolve(process.env.BOTLING_DATA_DIR || (app.isPackaged ? packagedDataDir(app.getPath("appData"), devTrial) : join(root, ".data")));
const installedApp = dirname(dirname(dirname(process.execPath)));
const renderer = rendererFiles(root, app.isPackaged, devTrial, process.argv, { appData: app.getPath("appData") });
/** Where the shell and chat page come from (a developer build can name its own folder). */
const rendererDir = renderer.directory;
/** Developer builds serve pages with no-store, so nothing cached is reused. */
const rendererNoStore = renderer.development;
/** The chat's and KaTeX's stylesheets a Markdown result page is drawn with (read on first use). */
const markdownPageStyles = markdownStyles(rendererDir, app.isPackaged ? join(process.resourcesPath, "builtin-plugins") : join(root, "out", "builtin-plugins"));
if (renderer.development) console.log(`[renderer] loading ${rendererDir}; Cmd+R reloads the shell, Alt+Cmd+R the chat page`);
// Preloads re-run on each page reload; a developer build dir (--botling-preload-dir) can supply them.
const preloadDir = preloadFiles(root, app.isPackaged, devTrial, process.argv).directory;
const traceContext=!shotMode?syntheticTraceContext({packaged:app.isPackaged,dataDir,syntheticBase:join(root,".cache/test-data"),env:process.env}):null;
let traceWriter:InputTraceWriter|null=null;
mkdirSync(dataDir, { recursive: true });
const profileDir = join(dataDir,"electron");
// Everything Electron keeps (partitions, caches, logs) lives under the data dir, never the default.
app.setPath("userData", profileDir);
app.setPath("sessionData", profileDir);
app.setPath("crashDumps", join(profileDir, "crashes"));
app.setPath("logs", join(profileDir, "logs"));
if (!shotMode) startup.setFile(join(profileDir, "logs", "startup.log"));
// Tests: safeStorage seals with Chromium's mock keychain instead of the user's login keychain.
if (process.env.BOTLING_MOCK_KEYCHAIN === "1") app.commandLine.appendSwitch("use-mock-keychain");

const APP_ORIGIN = "app://botling";
/** Component pages (Web/src's `componentPage`) the chat page hands over for its sandboxed frames. */
const PAGE_PREFIX = "botling-card://page/";
/** Settings → Appearance → Report pages (kept in step with the core's settings). */
let reportTheme: ReportTheme = "dark";
/** Settings → Appearance → App: drives nativeTheme (every page's prefers-color-scheme) live, no restart. */
function applyAppTheme(setting: AppTheme | null | undefined) {
  const source = themeSourceFor(setting);
  if (nativeTheme.themeSource !== source) nativeTheme.themeSource = source;
}
/**
 * The saved shortcuts, report look and app look, once the core is started (it cannot answer before): the menu starts on
 * the defaults and the app dark, and both follow the saved settings here (and on every change, `settings.updated`).
 */
function applySavedSettings() {
  void core.call({ type: "settings.get" }).then(settings => { applyMenu((settings as { shortcuts?: unknown }).shortcuts); reportTheme = (settings as { reportTheme?: ReportTheme }).reportTheme ?? "dark"; applyAppTheme((settings as { appTheme?: AppTheme }).appTheme); }, (error) => note(`Saved settings not applied: ${String(error)}`));
}
/** Whether the app is drawn dark now (the setting, or the system's look for "system"). */
function appDark(): boolean { return nativeTheme.shouldUseDarkColors; }

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
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
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

// The application menu's accelerators follow Settings > Shortcuts; rebuilt whenever they change.
let shortcutOverrides: unknown = {};
let menuSignature = "";
let menuSuspended = false;
let suspendTimer: NodeJS.Timeout | undefined;
function applyMenu(overrides: unknown) {
  if (!app.isReady()) { shortcutOverrides = overrides; return; }
  const bindings = bindingsFor(overrides);
  const signature = JSON.stringify([bindings, menuSuspended]);
  shortcutOverrides = overrides;
  if (signature === menuSignature) return;
  menuSignature = signature;
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(process.platform, { reloadChat: reloadNativeEditor }, bindings, menuSuspended)));
}
const core: CoreClient = new CoreClient({
  script: join(root, "out", "core", "main.cjs"),
  hostScript: join(root, "out", "host", "host-utility.mjs"),
  ledgerFile: join(dataDir, "core", "children.json"),
  env: coreEnvironment(),
  onEvent: (event) => {
    if (event.event.type === 'settings.updated') { applyMenu(event.event.settings.shortcuts); reportTheme = event.event.settings.reportTheme; applyAppTheme(event.event.settings.appTheme); }
    broadcast(event);
  },
  audit: note,
  milestone: (name) => startup.mark(name),
  // Another Botling owns this data folder (its core holds core/core.lock): this app is the extra one.
  // It quits rather than run a window on nobody's data; the other one keeps the folder.
  dataDirInUse: () => {
    const holder = readLockHolder(join(dataDir, "core"));
    const from = holder?.app ? ` from ${holder.app}` : "";
    const version = holder?.version ? ` (version ${holder.version})` : "";
    note(`another Botling core owns the data folder (pid ${holder?.pid ?? "?"}${from}${version}); quitting`);
    if (!shotMode && process.env.BOTLING_QUIET !== "1") {
      dialog.showErrorBox("Botling is already running", `Botling is already running${from}${version}, using ${dataDir}.\n\nThis copy will quit without changing anything; use the one that is already open.`);
    }
    app.quit();
  },
  app: async (op, args): Promise<{ ok: boolean; file?: string; error?: string; data?: unknown }> => {
    if (op === "browser") {
      // A bot's tool on the in-app browser (browser-bot.ts): its own pane's tabs only.
      let request: ReturnType<typeof parseBrowserBotRequest> = null;
      try { request = parseBrowserBotRequest(JSON.parse(args.request ?? "")); } catch { /* refused below */ }
      if (!request) return { ok: false, error: "Refused: not a browser request." };
      return browserBot.answer(request);
    }
    if (op === "quit") {
      // An install of a developer build: the script outside the app waits for it to quit.
      note("quitting to install a developer build");
      setTimeout(() => app.quit(), 100);
      return { ok: true };
    }
    if (op === "installRelease") return withInstallRequest(async () => {
      // The user picked Install and restart on the update notice in the main bot's chat (botling.dev and core/self-update.ts):
      // download the newer release unless it is already, then restart on it.
      try {
        await installRelease();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 500) };
      }
    });
    // A picture of the main window as it is (no focus change, nothing shown).
    const window = mainWindow;
    if (!window || window.isDestroyed()) return { ok: false, error: "No window." };
    const image = await windowPicture(window.webContents);
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

// One install request at a time (a release's download and restart).
let installRequestBusy = false;
async function withInstallRequest<T>(action: () => Promise<T>): Promise<T> {
  if (installRequestBusy) throw new Error("Another install is in progress");
  installRequestBusy = true;
  try { return await action(); } finally { installRequestBusy = false; }
}

/**
 * Released versions (updates.ts): electron-updater against GitHub Releases, the same on every platform.
 * A development run and a Linux .deb cannot update themselves; they only see that a newer version exists.
 */
const updatesFile = join(dataDir, "updates.json");
const updater = new Updater({
  current: app.getVersion(),
  updater: autoUpdater,
  unavailable: () => !app.isPackaged ? "this is a development run, which does not update itself."
    : process.platform === "linux" && !process.env.APPIMAGE ? "this Linux package (.deb) cannot update itself; download the new version from the release page."
    : null,
  enabled: async () => ((await core.call({ type: "settings.get" })) as { updateCheck?: boolean }).updateCheck === true,
  load: () => {
    try {
      const value = JSON.parse(readFileSync(updatesFile, "utf8"));
      return typeof value?.checkedAt === "number" ? { checkedAt: value.checkedAt, newer: value.newer ?? null } : null;
    } catch { return null; }
  },
  save: (state) => { try { writeFileSync(updatesFile, JSON.stringify(state)); } catch { /* the next check tries again */ } },
});
/** Downloads the newer release if needed, saves running work, then quits and installs. */
async function installRelease() {
  const state = await updater.check(true);
  if (!state.newer) throw new Error("There is no newer release.");
  if (updater.ready !== state.newer.version) await updater.download();
  note(`installing release ${state.newer.version} and restarting`);
  await restartWithContinuation();
}
async function restartWithContinuation() {
  await core.prepareRestart();
  try { updater.restart(); }
  catch (error) { core.cancelRestart(); throw error; }
}
/**
 * A newer release goes to the main bot's chat as an update notice, in developer mode only (botling.dev and core/self-update.ts, once per version and
 * run); installing it waits for the user's pick there. Everyone else has the sidebar's update entry. Checked at start and every 6 hours, as Settings has it.
 */
function announce(view: UpdateView): UpdateView {
  if (view.enabled && view.newer) {
    core.announceRelease({ version: view.newer.version, name: view.newer.name, url: view.newer.url, current: app.getVersion(), unavailable: view.installError ?? null });
  }
  return view;
}
const checkForRelease = () => { void updater.check(false).then(announce, (error) => note(`update check: ${String(error)}`)); };
/** Tests: the release pages main opened (BOTLING_NO_EXTERNAL=1 opens nothing for real). */
const openedReleases: string[] = [];
(globalThis as unknown as { __botlingOpenedReleases: string[] }).__botlingOpenedReleases = openedReleases;

function coreEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  env.BOTLING_DATA_DIR = join(dataDir, "core");
  // Developer mode's builds (botling.dev and core/self-update.ts): main's pid (the install script waits for it to quit), the
  // data folder the new build opens with, and the bundle this is (macOS app bundles only).
  env.BOTLING_MAIN_PID = String(process.pid);
  // The core adds its own milestone (its bots loaded) to main's startup log.
  if (!shotMode) env.BOTLING_STARTUP_LOG = join(profileDir, "logs", "startup.log");
  env.BOTLING_APP_DATA_DIR = dataDir;
  // Written into the data folder's lock (core/store/data-dir-lock.ts): a second Botling names this one.
  env.BOTLING_APP_VERSION = app.getVersion();
  env.BOTLING_APP_PATH = app.isPackaged ? (installedApp.endsWith(".app") ? installedApp : process.execPath) : root;
  delete env.BOTLING_APP_LOCAL_DATA_DIR;
  if (app.isPackaged && process.platform === "darwin" && installedApp.endsWith(".app")) env.BOTLING_APP_BUNDLE = installedApp;
  else delete env.BOTLING_APP_BUNDLE;
  env.BOTLING_UPDATE_PENDING = "0";
  // Maintainer's component-shot command: this build in shot mode (1.x: "'<botling>' --component-shot").
  const quoted = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
  const self = `env -u ELECTRON_RUN_AS_NODE ${quoted(process.execPath)}${app.isPackaged ? "" : ` ${quoted(root)}`}`;
  env.BOTLING_SHOT_COMMAND ??= `${self} --component-shot`;
  // And its plugin check (1.x: "'<botling>' --check-plugin"); a packaged build cannot run Electron as Node.
  env.BOTLING_CHECK_COMMAND ??= `${self} --check-plugin`;
  // The app itself, for the commands shipped plugins give the bots (botling.report: `--render-report`; its guide is in the plugin, outside app.asar).
  env.BOTLING_APP_COMMAND ??= self;
  // The plugins shipped with the app (step M11), outside app.asar so bots can read them too.
  env.BOTLING_BUILTIN_PLUGINS ??= app.isPackaged ? join(process.resourcesPath, "builtin-plugins") : join(root, "out", "builtin-plugins");
  // The fake CLIs are development's (a packaged build ships neither and always runs the real ones).
  if (!app.isPackaged) {
    env.BOTLING_FAKE_CLI ??= join(root, "test", "fixtures", "fake-claude.mjs");
    env.BOTLING_FAKE_CODEX ??= join(root, "test", "fixtures", "fake-codex.mjs");
  }
  // Trial artifacts skip automatic 1.x import. Explicit imports and read-only project-lock
  // detection remain separate; ordinary packaged behavior is unchanged.
  directoryDefaults(env, process.env.HOME || homedir(), app.isPackaged, devTrial);
  // The bots reply in the system's language unless settings name one (`AppLanguage.preferred`).
  try { env.BOTLING_LANGUAGES ??= app.getPreferredSystemLanguages().join(","); } catch { /* Intl's locale then */ }
  return env;
}

/** Each app window's in-app browser (browser-host.ts), by its page's contents id. */
const browserHosts = new Map<number, BrowserHost>();
const browserFor = (contents: WebContents) => browserHosts.get(contents.id) ?? null;
/** The browser's site tools (site-tools.ts): `<data>/browser-tools/<id>/`, watched, shared by every window. */
let siteTools: SiteToolStore | null = null;
function siteToolStore(): SiteToolStore {
  if (!siteTools) {
    siteTools = new SiteToolStore({ folder: join(dataDir, SITE_TOOLS_FOLDER), stateFile: join(dataDir, "browser-tools-state.json"), guide: SITE_TOOLS_GUIDE_TEXT, note });
    app.once("will-quit", () => siteTools?.dispose());
  }
  return siteTools;
}
/** The bot tools on the browser (browser-bot-host.ts): the main window's first, then the others. */
const browserBot = new BrowserBotHost(() => {
  const first = mainWindow && !mainWindow.isDestroyed() ? browserFor(mainWindow.webContents) : null;
  return [...(first ? [first] : []), ...[...browserHosts.values()].filter((host) => host !== first)].map((host) => host.bot);
});
function broadcast(event: EventEnvelope) {
  // A removed bot's browser tabs go with it.
  if (event.event.type === "bot.removed") for (const host of browserHosts.values()) host.closeBot(event.event.botId);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!appContents.has(window.webContents.id) || window.webContents.isDestroyed()) continue;
    window.webContents.send("botling:message", event);
  }
}

const hardened = new WeakSet<Session>();
/** The app's own pages: its windows' shells, and the native chat view (the main chat) in them. */
const ownedContents = (contents: WebContents | null | undefined) => !!contents && (appContents.has(contents.id) || isNativeEditorHost(contents));
function hardenSession(target: Session) {
  if (hardened.has(target)) return;
  hardened.add(target);
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const ok = permissionAllowed({ permission, owned: ownedContents(contents), requestingUrl: details?.requestingUrl ?? contents?.getURL() ?? "" });
    if (!ok) note(`denied permission ${permission} for ${contents?.getURL() ?? "?"}`);
    callback(ok);
  });
  target.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    permissionAllowed({ permission, owned: ownedContents(contents), requestingUrl: requestingOrigin }));
  target.on("will-download", (event) => { event.preventDefault(); note("blocked a download"); });
}

// ----------------------------------------------------------------------------------------------
// IPC from the app's renderer

function fromAppFrame(event: Pick<IpcMainEvent, "sender" | "senderFrame">): boolean {
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

// Settings > Shortcuts is recording a key: the menu's accelerators step aside so the key reaches the page (a minute at most).
ipcMain.on("botling:shortcuts:suspend", (event, on: unknown) => {
  if (!fromAppFrame(event)) return;
  clearTimeout(suspendTimer);
  menuSuspended = on === true;
  if (menuSuspended) suspendTimer = setTimeout(() => { menuSuspended = false; applyMenu(shortcutOverrides); }, 60_000);
  applyMenu(shortcutOverrides);
});

// The in-app browser pane (browser-host.ts): the app page's tab strip and toolbar, and where the page goes.
ipcMain.on(BROWSER_CHANNEL, (event, raw: unknown) => {
  if (!fromAppFrame(event)) return;
  const message = parseBrowserUp(raw);
  if (!message) { note("refused a malformed browser message"); return; }
  browserFor(event.sender)?.receive(message);
});

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
  void core.request(cmd, scoped(id)).then((response) => {
    if (cmd.type === "chat.snapshot") startup.mark("snapshot.first", { ok: response.ok });
    reply({ ...response, id });
  });
});

/**
 * Component pages by token: what the chat page built for a component frame (its template, the
 * data, the `ccb` runtime), served once from botling-card://page/<token> under COMPONENT_CSP. The
 * frame is still sandboxed (opaque origin) and reaches nothing; only the app page can add one.
 */
const pages = new Map<string, { html: string; panel: boolean; markdown?: boolean }>();
const PAGE_LIMIT = 400;
/** `markdown`: a Markdown file drawn as a report page (markdown-page.ts), served under MARKDOWN_CSP (no scripts at all). */
function addPage(html: string, panel = false, markdown = false): string {
  const token = randomBytes(18).toString("hex");
  // A component shot measures every component page: the probe goes first in its head.
  pages.set(token, { html: shotMode && !panel && !markdown ? withProbe(html) : html, panel, ...(markdown ? { markdown } : {}) });
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
 * The Storage tab's files dropped in (from Finder: their paths; from the chat: a file: link or a chat attachment of this bot):
 * only files that are there are remembered, by path (references, nothing copied; core/storage.ts). A folder is left out.
 */
async function storageAdd(botId: string, paths: string[], urls: string[]): Promise<{ added: number }> {
  const named = [...paths, ...urls.map((url) => {
    const link = attachmentFile(url, botId) ?? url;
    try { return link.startsWith("file:") ? fileURLToPath(link) : ""; } catch { return ""; }
  })];
  const files = [...new Set(named.filter((path) => {
    if (!path.startsWith("/")) return false;
    try { return statSync(path).isFile(); } catch { return false; }
  }).map((path) => normalize(path)))].slice(0, 50);
  if (!files.length) return { added: 0 };
  return core.call({ type: "storage.add", botId, paths: files, urls: [] });
}

/** The Storage tab's "Add files": main's own picker (as the + button's); tests (unpackaged only) answer with BOTLING_TEST_PICK. */
async function storagePick(botId: string, sender: WebContents): Promise<{ added: number }> {
  let paths: string[];
  if (!app.isPackaged && process.env.BOTLING_TEST_PICK) {
    paths = JSON.parse(process.env.BOTLING_TEST_PICK) as string[];
  } else {
    const owner = BrowserWindow.fromWebContents(sender);
    const options: Electron.OpenDialogOptions = { properties: ["openFile", "multiSelections"], buttonLabel: "Add" };
    const answer = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    if (answer.canceled) return { added: 0 };
    paths = answer.filePaths;
  }
  return storageAdd(botId, paths, []);
}

/** A Storage row's file, as the core lists it for that bot now (a page cannot name another path); missing: not_found. */
async function storageFile(botId: string, id: string): Promise<string> {
  const { items } = await core.call({ type: "storage.list", botId });
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw Object.assign(new Error("That file is no longer in Storage."), { code: "not_found" });
  if (item.missing || !existsSync(item.path)) throw Object.assign(new Error("That file is not there any more (moved or deleted)."), { code: "not_found" });
  return item.path;
}

/**
 * Opens a Storage row: a page or Markdown file in the app's report preview (from the preview origin when it is in an
 * artifacts folder, a Markdown file elsewhere drawn once as a page), anything else (PDF, pictures, documents) with its
 * app, as a chat result opens; `reveal`: shown in Finder.
 */
async function storageOpen(botId: string, id: string, reveal: boolean): Promise<{ opened: boolean; previewURL?: string }> {
  const path = await storageFile(botId, id);
  if (reveal) return openLink(path, true);
  if (/\.(md|markdown)$/i.test(path)) return markdownPreview(path);
  if (/\.html?$/i.test(path)) {
    try { const previewURL = reportPreviewURL(path); openedResults.push(path); return { opened: true, previewURL }; } catch { /* not in an artifacts folder: its app */ }
  }
  return openLink(path);
}

/** Tests: the files a Storage drag started with (the OS drag itself needs a real pointer). */
const storageDrags: string[] = [];
(globalThis as unknown as { __botlingStorageDrags: string[] }).__botlingStorageDrags = storageDrags;

/**
 * A Storage row's drag began in the app page: an OS-level file drag of that file (webContents.startDrag), so it can be
 * dropped anywhere a file can: a web page's file input or drop zone in the Browser pane (its own WebContentsView) gets
 * it as a real upload, and Finder or another app gets the file too.
 */
async function storageDrag(botId: string, id: string, sender: WebContents): Promise<{ started: boolean }> {
  const path = await storageFile(botId, id);
  return startFileDrag(path, sender, storageDrags);
}
/** Tests: the files a chat link drag started with. */
const linkDrags: string[] = [];
(globalThis as unknown as { __botlingLinkDrags: string[] }).__botlingLinkDrags = linkDrags;
/**
 * A local file's link, file chip or picture dragged out of the chat: the same OS file drag as a Storage row, so a web page
 * in the Browser pane takes it as an upload (and Finder as the file). Only a file that is there, and only one a line of
 * this chat links or attaches (the core's link.authorize, as a click on it): the page cannot ask for any path it likes.
 */
async function linkDrag(botId: string, url: string, sender: WebContents): Promise<{ started: boolean }> {
  const target = linkDragTarget(url, botId, (path) => statSync(path).isFile());
  if (!target) throw Object.assign(new Error("That file is not there."), { code: "not_found" });
  const access = await core.call({ type: "link.authorize", source: "user", botId, url: target.link });
  if (!access.linked) throw Object.assign(new Error("That link is not in this chat."), { code: "not_found" });
  // startDrag drags from the sender's window (macOS: its content view), so the shell's own contents serve the native chat too.
  return startFileDrag(target.path, sender, linkDrags);
}
/** An OS-level file drag of `path` from `sender` (webContents.startDrag), with the file's icon when the system has one. */
async function startFileDrag(path: string, sender: WebContents, record: string[]): Promise<{ started: boolean }> {
  let icon: Electron.NativeImage | null = null;
  try { icon = await Promise.race([app.getFileIcon(path, { size: "normal" }), new Promise<null>((done) => setTimeout(() => done(null), 150))]); } catch { icon = null; }
  if (!icon || icon.isEmpty()) icon = nativeImage.createFromDataURL(DRAG_ICON);
  if (sender.isDestroyed()) return { started: false };
  record.push(path);
  sender.startDrag({ file: path, icon });
  return { started: true };
}
/** A plain 16×16 document glyph for a drag when the system has no icon for the file. */
const DRAG_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJklEQVR4nGNgoCY4ceLcf2IwXgNsbFye4cOjBowaMFIMoCgzkQMAtlQwzK1akYkAAAAASUVORK5CYII=";

/**
 * A file dropped on the chat, by its path on disk: it waits in the input box like a picked one, so the
 * message attaches the original where it is (copied only from a temporary place). A folder is refused.
 */
async function droppedFile(botId: string, path: string): Promise<boolean> {
  try { if (!statSync(path).isFile()) return false; } catch { return false; }
  const answer = await core.request({ type: "files.add", botId, paths: [path] });
  return answer.ok;
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
async function openResult(botId: string, url: string): Promise<{ opened: boolean; previewURL?: string }> {
  const access = await core.call({type:"link.authorize",botId,url});
  if (!access.result) throw Object.assign(new Error("That link is not one of this bot's results."), { code: "not_found" });
  const markdown = markdownLinkPath(url);
  return markdown ? markdownPreview(markdown, url) : openLink(url);
}
async function openOrdinaryLink(botId: string, url: string, source: "user" | "component", messageId?:string,pinId?:string,reveal=false,preview=false,cardImage?:string,external=false,sender?:WebContents): Promise<{opened:boolean;previewURL?:string}> {
  // A file attached in this chat, as the chat page shows it (served by the chat origin): the file it
  // names, which the core accepts only when a line of this chat has it (1.x opens it like any link).
  url = attachmentFile(url, botId) ?? url;
  const access = await core.call({type:"link.authorize",source,botId,url,...(messageId?{messageId}:{}),...(pinId?{pinId}:{}),...(cardImage?{cardImage}:{})});
  if (!(source === "user" && /^(https?|mailto):/i.test(url)) && !access.linked) throw Object.assign(new Error("That link is not in this chat."),{code:"not_found"});
  const pane = sender ? browserFor(sender) : null;
  const way = linkOpenWay({ url, source, preview, reveal, external, pane: !!pane });
  if (way === "pane") { openedResults.push(url); pane!.open(botId, url); return { opened: true }; }
  if (way === "markdown") return markdownPreview(markdownLinkPath(url)!, url);
  if (way === "preview") return { opened: true, previewURL: reportPreviewURL(url) };
  return openLink(url, reveal);
}
/**
 * A local Markdown file in the app's report preview (chat links, plugin links): an artifacts one from the preview origin
 * like a chat report, any other drawn once as a page. Never the system's app for .md.
 */
function markdownPreview(path: string, link = path): { opened: boolean; previewURL: string } {
  if (!existsSync(path)) throw Object.assign(new Error("That file is not there."), { code: "not_found" });
  openedResults.push(link);
  try { return { opened: true, previewURL: reportPreviewURL(path) }; } catch { /* not in an artifacts folder */ }
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { throw Object.assign(new Error("That file could not be read."), { code: "not_found" }); }
  const page = markdownPage(text, path, markdownPageStyles(), resolveReportTheme(reportTheme, appDark));
  return { opened: true, previewURL: addPage(page, false, true) };
}
/**
 * A plugin frame's `ccb.openLink` (the Note tab's links): the core says what the href names (plugin-link.ts), and it opens
 * as a chat link does. A web link in the default browser; a Markdown file in the app's report preview (an artifacts one
 * from the preview origin like a chat report, any other drawn once as a page; the page shows `previewURL`); any other file
 * with its app when it is a page, picture, video or document, else in Finder (never run). No prompt.
 */
async function openPluginLink(cmd: Extract<Command, { type: "plugins.openLink" }>, sender?: WebContents): Promise<{ opened: boolean; previewURL?: string }> {
  const target = await core.call({ type: "plugins.linkTarget", name: cmd.name, botId: cmd.botId, href: cmd.href });
  const route = pluginLinkRoute(target);
  // A web page opens in the app's browser pane, for the bot the plugin named (mailto: still goes outside).
  const pane = sender ? browserFor(sender) : null;
  if (target.kind === "web" && pane && isWebUrl(target.url)) { openedResults.push(target.url); pane.open(cmd.botId, target.url); return { opened: true }; }
  if (target.kind === "web") return openLink(target.url);
  if (route === "markdown") return markdownPreview(target.path);
  return openLink(target.path);
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
 * The shell's window as the user sees it: the shell's pixels with the native chat view drawn in
 * (window-capture.ts). The shell's capturePage alone has an empty chat column, since the chat lives
 * in its own WebContentsView. `rect` (window DIPs) crops the result, as capturePage(rect) did.
 */
async function windowPicture(contents: WebContents, rect?: Electron.Rectangle): Promise<Electron.NativeImage> {
  const owner = BrowserWindow.fromWebContents(contents);
  const width = owner && !owner.isDestroyed() && owner.webContents === contents ? owner.getContentBounds().width : 0;
  // Not a window's own page (no chat drawn over it): its capture is already the whole picture.
  if (!width) return contents.capturePage(rect);
  const shellImage = await contents.capturePage();
  const picture = await composeWindow(shellImage, width, nativeEditorLayer(contents),
    (bitmap) => nativeImage.createFromBitmap(bitmap.data, { width: bitmap.width, height: bitmap.height })) as Electron.NativeImage;
  if (!rect) return picture;
  const scale = captureScale(shellImage, width);
  return picture.crop({ x: Math.round(rect.x * scale), y: Math.round(rect.y * scale), width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) });
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
      const image = await windowPicture(sender, rect);
      if (!image.isEmpty()) screenshot = image.toPNG().toString("base64");
    } catch (error) {
      note(`component report: no screenshot (${(error as Error).message})`);
    }
  }
  return core.call({ ...rest, ...(screenshot ? { screenshot } : {}) });
}

/**
 * A plugin frame's `ccb.snapshot` (the Note tab's "freeze to image"): that part of the app's window, taken here (a page
 * cannot hand in its own), as PNG, or JPEG when the PNG is past what a note takes as bytes; the core keeps it in the note.
 */
async function noteSnapshot(cmd: Extract<Command, { type: "plugins.noteSnapshot" }>, sender: WebContents): Promise<unknown> {
  const { picture: _ignored, ...rest } = cmd;
  let picture: { base64: string; name: string } | undefined;
  try {
    const rect = { x: Math.max(0, Math.round(cmd.rect.x)), y: Math.max(0, Math.round(cmd.rect.y)), width: Math.max(1, Math.round(cmd.rect.width)), height: Math.max(1, Math.round(cmd.rect.height)) };
    const image = await windowPicture(sender, rect);
    if (!image.isEmpty()) {
      const png = image.toPNG();
      picture = png.length <= 2_400_000 ? { base64: png.toString("base64"), name: "card.png" } : { base64: image.toJPEG(85).toString("base64"), name: "card.jpg" };
    }
  } catch (error) {
    note(`note snapshot: no picture (${(error as Error).message})`);
  }
  return core.call({ ...rest, ...(picture ? { picture } : {}) });
}

/** "Not right" on a reply: the chat as you saw it (its frame's rect), then the core sends the report. */
async function withScreenshot(cmd: Extract<Command, { type: "chat.feedback" }>, sender: WebContents): Promise<unknown> {
  const { screenshot: _ignored, ...rest } = cmd;
  let screenshot: string | undefined;
  try {
    const rect = cmd.rect ? { x: Math.max(0, Math.round(cmd.rect.x)), y: Math.max(0, Math.round(cmd.rect.y)), width: Math.max(1, Math.round(cmd.rect.width)), height: Math.max(1, Math.round(cmd.rect.height)) } : undefined;
    const image = await windowPicture(sender, rect);
    if (!image.isEmpty()) screenshot = image.toPNG().toString("base64");
  } catch (error) {
    note(`feedback: no screenshot (${(error as Error).message})`);
  }
  return core.call({ ...rest, ...(screenshot ? { screenshot } : {}) });
}

async function handleInMain(cmd: Command, sender: WebContents): Promise<unknown> {
  switch (cmd.type) {
    case "result.open": return openResult(cmd.botId, cmd.url);
    case "worker.file": {
      const steps = (await core.call({ type: "subagent.view", botId: cmd.botId, subagentId: cmd.subagentId })).subagent.steps;
      const { cwd } = await core.call({ type: "worker.cwd", botId: cmd.botId, subagentId: cmd.subagentId });
      return openWorkerFile(steps, cwd, cmd.path, {
        exists: existsSync, realpath: (path) => realpathSync(path),
        preview: async (path) => { openedResults.push(path); if (process.env.BOTLING_NO_EXTERNAL !== "1") await new Promise<void>((done, fail) => execFile("open", ["-a", "Preview", path], (error) => error ? fail(error) : done())); },
        open: async (path) => { openedResults.push(path); if (process.env.BOTLING_NO_EXTERNAL !== "1") { const problem = await shell.openPath(path); if (problem) throw new Error(problem); } },
        reveal: (path) => { openedResults.push(path); if (process.env.BOTLING_NO_EXTERNAL !== "1") shell.showItemInFolder(path); },
      });
    }
    case "link.open": return openOrdinaryLink(cmd.botId, cmd.url, cmd.source,cmd.messageId,cmd.pinId,cmd.reveal===true,cmd.preview===true,cmd.cardImage,cmd.external===true,sender);
    case "doctor.copy": return copyDoctorFix(cmd.tool, await core.call({ type: "doctor.view" }), text => clipboard.writeText(text));
    case "chat.reloadPage": return { reloaded: await reloadNativeEditor(sender) };
    case "updates.check": return announce(await updater.check(cmd.manual));
    case "updates.stage": return withInstallRequest(async () => {
      const state = await updater.check(true);
      if (!state.newer) throw new Error("There is no newer release to download");
      return updater.download();
    });
    case "updates.restart": return withInstallRequest(async () => {
      await restartWithContinuation();
      return { restarting: true };
    });
    case "updates.open": {
      const page = updater.releasePage();
      if (!page) throw Object.assign(new Error("There is no newer release to open."), { code: "not_found" });
      openedReleases.push(page);
      if (process.env.BOTLING_NO_EXTERNAL !== "1") await shell.openExternal(page);
      return { opened: true };
    }
    case "component.report": return reportComponent(cmd, sender);
    case "plugins.noteSnapshot": return noteSnapshot(cmd, sender);
    case "plugins.openLink": return openPluginLink(cmd, sender);
    case "chat.feedback": return withScreenshot(cmd, sender);
    case "files.pick": return pickFiles(cmd.botId, sender);
    case "storage.add": return storageAdd(cmd.botId, cmd.paths, cmd.urls);
    case "storage.pick": return storagePick(cmd.botId, sender);
    case "storage.open": return storageOpen(cmd.botId, cmd.id, cmd.reveal === true);
    case "storage.drag": return storageDrag(cmd.botId, cmd.id, sender);
    case "link.drag": return linkDrag(cmd.botId, cmd.url, sender);
    case "projects.pick": return pickProject(sender);
    case "card.page": return { url: addPage(cmd.html, cmd.panel === true) };
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
    // it) or a component page (put there by the app page or the chat page). A page that navigates
    // itself (to anything) is refused: it would otherwise take over another page's identity.
    const mainFrame = contents.mainFrame;
    const initiator = details.initiator;
    const chatFrame = (frame: Electron.WebFrameMain | null | undefined) =>
      !!frame && frame.parent === mainFrame && frame.url.startsWith(CHAT_URL);
    const parent = details.frame?.parent ?? null;
    let allowed = false;
    if (details.url === CHAT_URL || details.url.startsWith(`${CHAT_URL}?`)) {
      allowed = (!hasNativeEditorHost(contents)||details.url.startsWith(`${CHAT_URL}?panel=`)) && parent === mainFrame && (!initiator || initiator === mainFrame);
    } else if (details.url.startsWith(PAGE_PREFIX)) {
      allowed = (!initiator || initiator === mainFrame || chatFrame(initiator)) && (parent === mainFrame || chatFrame(parent));
      // A tile a plugin's panel asked for (`ccb.tile`), inside that panel.
      if (!allowed) allowed = tileNavigation(details.url, parent ? { url: parent.url, childOfApp: parent.parent === mainFrame } : null, !initiator || initiator === parent,
        (token) => { const page = pages.get(token); return page ? (page.panel ? "panel" : "component") : null; });
    } else if (details.url.startsWith(PREVIEW_PREFIX)) {
      // A result page: a shell-owned full-page viewer, or a component-owned preview card child.
      // The sandboxed report itself still cannot initiate navigation.
      // The card page sits in the chat page, or in a main tab's panel page (the Note tab's cards).
      allowed = shellReportNavigation(parent, initiator, mainFrame) || cardPreviewNavigation(parent, initiator ?? null, mainFrame, chatFrame,
        (token) => { const page = pages.get(token); return page ? (page.panel ? "panel" : "component") : null; });
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
    title: "Botling", backgroundColor: windowBackground(appDark()), show: false,
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
  browserHosts.set(id, createBrowserHost(window, { note, shortcuts: () => bindingsFor(shortcutOverrides), noExternal: process.env.BOTLING_NO_EXTERNAL === "1", tools: siteToolStore(), ...(process.env.BOTLING_SITE_TOOL_SAVE_DIR ? { saveFolder: process.env.BOTLING_SITE_TOOL_SAVE_DIR } : {}) }));
  window.on("closed", () => { appContents.delete(id); browserHosts.delete(id); if (mainWindow === window) mainWindow = null; });
  window.webContents.once('did-finish-load',()=>startup.mark('window.loaded'));
  const ownerReady=window.loadURL(`${APP_ORIGIN}/index.html`);
  const editor=prepareNativeEditorHost(window,root,ownerReady,preloadDir,{onDroppedFile:droppedFile});
  const opening=editor.revealWhenReady(hidden);
  // First paint: the window revealed (with the chat's input ready, or after the reveal gate's timeout).
  void opening.then(shown=>{if(shown)startup.mark('window.shown');},()=>{});
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
  // A component card's picture opened full size (the lightbox): only one some component's data named,
  // by the token its card already loads it with (`botling-card://image/<token>`), never by path.
  const cardToken = cardImageToken(path);
  if (cardToken) {
    const answer = await core.request({ type: "card.image", token: cardToken });
    if (!answer.ok) return null;
    const { path: file, type } = answer.result as { path: string; type: string };
    try {
      return new Response(readFileSync(file), { headers: { "Content-Type": type, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'", ...NO_SNIFF, "Cache-Control": "no-store" } });
    } catch { return null; }
  }
  // A file a message (or the input box) in this bot's chat has attached, or a picture or video a line
  // shows by its local path; never any other path.
  const attached = attachmentTarget(path);
  if (attached) {
    const line = attachmentLine(url.searchParams);
    const answer = await core.request({ type: "attachment.file", botId: attached.botId, ref: attached.ref, ...(line ? { line } : {}) });
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
        // A Markdown result is drawn as the chat draws a reply (markdown-page.ts), never served as text.
        // It takes the look result pages take (Settings → Appearance → Report pages).
        if (/\.(md|markdown)$/i.test(file)) return markdownResponse(file, markdownPageStyles(), request.method, resolveReportTheme(reportTheme, appDark));
        // Settings → Appearance → Report pages: a look other than the app's is asked for with data-theme (report-theme.ts).
        const theme = resolveReportTheme(reportTheme, appDark);
        return await previewResponse(file, request, reportNeedsMark(theme, appDark()) ? { html: (text) => themeHtml(text, theme) } : {});
      } catch {
        return new Response("Not found", { status: 404 });
      }
    }
    if (url.host === "page") {
      const page = pages.get(url.pathname.slice(1));
      if (page === undefined) return new Response("Not found", { status: 404 });
      return new Response(page.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": page.markdown ? MARKDOWN_CSP : page.panel ? PANEL_CSP : COMPONENT_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
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
    return new Response("Not found", { status: 404 });
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
  startup.mark("app.ready");
  applyMenu(shortcutOverrides);
  // The app starts dark, as 1.x's windows (`preferredColorScheme(.dark)`), until the saved Settings → Appearance → App
  // look arrives (applySavedSettings, once the core is started); pages and component frames that ask (prefers-color-scheme) follow it (Phase 5c).
  nativeTheme.themeSource = "dark";
  // A window's background (seen while resizing, before its page draws) follows the look.
  nativeTheme.on("updated", () => { for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.setBackgroundColor(windowBackground(appDark())); });
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
  startup.mark("recovery.done");
  if(traceContext){try{traceWriter=await InputTraceWriter.open(traceContext);}catch(error){note('Synthetic trace disabled: '+String(error));}}
  app.on("activate", () => { if (!mainWindow) createWindow(); });
  startup.mark("core.start");
  core.start();
  // Only now: asked before core.start() the core cannot answer, and the saved look and shortcuts were lost on every restart.
  applySavedSettings();
  createWindow();
  checkForRelease();
  setInterval(checkForRelease, CHECK_EVERY_MS).unref();
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
  // A plain quit keeps in-flight work: checkpoint it first (bounded), then stop. Failure only means no continuation.
  const armed = core.prepareRestart({ onlyIfBusy: true, timeoutMs: 4_000 }).catch((error) => { note(`quit continuation not saved: ${String(error)}`); core.cancelRestart(); });
  void Promise.allSettled([armed.then(() => core.stop())]).then(async () => {
    ipcMain.removeAllListeners(TEST_TRACE_CHANNEL);
    try{await traceWriter?.close();}catch(error){note('Synthetic trace flush failed: '+String(error));}
    app.exit(0);
  });
});

// For tests: which pid the core has.
(globalThis as unknown as { __botlingCorePid: () => number | undefined }).__botlingCorePid = () => core.pid;
(globalThis as unknown as { __botlingWindowPicture: () => Promise<string | null> }).__botlingWindowPicture = async () => {
  const window = mainWindow;
  return window && !window.isDestroyed() ? (await windowPicture(window.webContents)).toDataURL() : null;
};
(globalThis as unknown as { __botlingShotCommand: string | undefined }).__botlingShotCommand = shotMode ? undefined : coreEnvironment().BOTLING_SHOT_COMMAND;
(globalThis as unknown as { __botlingCheckCommand: string | undefined }).__botlingCheckCommand = shotMode ? undefined : coreEnvironment().BOTLING_CHECK_COMMAND;
(globalThis as unknown as { __botlingHostPids: () => number[] }).__botlingHostPids = () => core.hostPids;
(globalThis as unknown as { __botlingPluginGroups: () => number[] }).__botlingPluginGroups = () => core.pluginGroups;
void PROTOCOL_VERSION;
