// Botling 3's Electron main (M1 step 11, M6-07c):
// - When `--botlingd` is passed, run botlingd's CLI directly without loading `./guard`, `./content-install`,
//   `./editor-packets-install`, `../main/main`, any window, or the single-instance lock, and hide the Dock icon on macOS.
//   When packaged, await `app.whenReady()` so `utilityProcess.fork` can run child Node work (plugin host, PDF text).
//   `start` catches Electron's `before-quit` (`systemQuitSource`): this process is the same app bundle as the window, so
//   `quit app "Botling 3"` may reach it; botlingd passes the quit on to the window instead of being ended at once.
// - Otherwise run the Botling 3 window: `./guard` first, content/editor hooks, then the 2.x main with `./core-client`
//   swapped for `./server-client` (build.mjs `buildMainV3`).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scrubEnvironment } from "../main/packaged";
import type { ServerCliOptions } from "../server/main";
import { electronUtilityOf, isPackagedElectron, loadElectron, type ElectronMainLike } from "../server/packaged-electron";
import type { SystemQuitListener } from "../server/shell-bridge";

export type { SystemQuitListener };

export function botlingdArgs(argv: readonly string[]): string[] | null {
  const at = argv.indexOf("--botlingd");
  return at >= 0 ? argv.slice(at + 1) : null;
}

export function packagedAppId(root = resolve(__dirname, "..", "..")): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { appId?: unknown };
    return typeof pkg.appId === "string" && pkg.appId.length > 0 ? pkg.appId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The commands a packaged botlingd hands Maintainer and the bots (core-process.ts): this build's own flags, as 2.x main
 * names them (main/main.ts `coreEnvironment`). Without them the core falls back to `ELECTRON_RUN_AS_NODE=1 <app> <script>`,
 * which with the RunAsNode fuse off starts the Botling 3 window instead. Always this build's own (scrubbed or inherited
 * values are replaced).
 */
export function setPackagedSelfCommands(env: Record<string, string | undefined>, execPath: string): void {
  const self = `env -u ELECTRON_RUN_AS_NODE '${execPath.replaceAll("'", "'\\''")}'`;
  env.BOTLING_APP_COMMAND = self;
  env.BOTLING_CHECK_COMMAND = `${self} --check-plugin`;
  env.BOTLING_SHOT_COMMAND = `${self} --component-shot`;
}

/**
 * `botlingd start` in Electron: a quit from macOS must not end botlingd at once (Electron would skip `daemon.stop()`, and
 * the window, which never heard of the quit, starts botlingd again). Every `before-quit` is prevented and handed to the
 * server (shell-bridge.ts `answerSystemQuit`); one that comes before the server listens is held until it does.
 * `powerMonitor` "shutdown" (logout, restart, power off) marks the quits after it as the system ending.
 * Undefined when there is no Electron app to listen on.
 */
export function systemQuitSource(electron: ElectronMainLike | undefined): ((listener: SystemQuitListener) => void) | undefined {
  const app = electron?.app;
  if (typeof app?.on !== "function") return undefined;
  let listener: SystemQuitListener | null = null;
  let held: boolean | null = null;
  let systemEnding = false;
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (listener) listener(systemEnding);
    else held = held === true || systemEnding;
  });
  try {
    void Promise.resolve(app.whenReady?.()).then(() => {
      electron?.powerMonitor?.on?.("shutdown", () => { systemEnding = true; });
    }, () => {});
  } catch { /* no powerMonitor: a logout's quit then goes to the window first, and SIGTERM still stops botlingd */ }
  return (next) => {
    listener = next;
    if (held !== null) {
      const ending = held;
      held = null;
      next(ending);
    }
  };
}

export interface MainV3Deps {
  argv?: readonly string[];
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  electron?: ElectronMainLike;
  root?: string;
  outDir?: string;
  execPath?: string;
  runServerCli?: (argv: string[], options: ServerCliOptions) => Promise<void>;
  loadWindowMain?: () => void;
  exit?: (code: number) => void;
}

export async function runMainV3(deps: MainV3Deps = {}): Promise<void> {
  const argv = deps.argv ?? process.argv;
  const botlingd = botlingdArgs(argv);
  if (botlingd !== null) {
    const platform = deps.platform ?? process.platform;
    const env = deps.env ?? process.env;
    const electron = deps.electron ?? loadElectron();
    const app = electron?.app;
    const command = botlingd[0] ?? "start";
    // Before awaiting readiness: a quit can come as soon as Electron is ready.
    const onSystemQuit = command === "start" ? systemQuitSource(electron) : undefined;
    if (platform === "darwin") {
      if (!app?.isReady?.()) app?.setActivationPolicy?.("prohibited");
      app?.dock?.hide?.();
    }
    const packaged = isPackagedElectron(electron);
    scrubEnvironment(env, packaged);
    if (packaged) setPackagedSelfCommands(env, deps.execPath ?? process.execPath);
    if (packaged && !env.BOTLING_BUILTIN_PLUGINS && process.resourcesPath) {
      env.BOTLING_BUILTIN_PLUGINS = join(process.resourcesPath, "builtin-plugins");
    }
    if (packaged) await app?.whenReady?.();
    const root = deps.root ?? resolve(__dirname, "..", "..");
    const appId = packaged ? packagedAppId(root) : undefined;
    const outDir = deps.outDir ?? join(__dirname, "..");
    const electronUtility = packaged ? electronUtilityOf(electron) : undefined;
    const runServerCli = deps.runServerCli ?? (() => {
      (globalThis as { __botlingdManualMain?: boolean }).__botlingdManualMain = true;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require("../server/main") as { main: NonNullable<MainV3Deps["runServerCli"]> }).main;
    })();
    await runServerCli(botlingd, {
      packaged,
      appId,
      outDir,
      ...(electronUtility ? { electronUtility } : {}),
      ...(onSystemQuit ? { onSystemQuit } : {}),
    });
    if (command !== "start") {
      const code = typeof process.exitCode === "number" ? process.exitCode : 0;
      (deps.exit ?? ((c: number) => process.exit(c)))(code);
    }
    return;
  }

  if (deps.loadWindowMain) {
    deps.loadWindowMain();
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./guard");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./content-install");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("./editor-packets-install");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("../main/main");
}

if (!(globalThis as { __vitest_worker__?: unknown }).__vitest_worker__) {
  runMainV3().catch((error) => {
    process.stderr.write(`botlingd: ${(error as Error)?.stack ?? String(error)}\n`);
    process.exit(1);
  });
}
