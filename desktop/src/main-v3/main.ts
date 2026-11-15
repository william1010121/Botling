// Botling 3's Electron main (M1 step 11, M6-07c):
// - When `--botlingd` is passed, run botlingd's CLI directly without loading `./guard`, `./content-install`,
//   `./editor-packets-install`, `../main/main`, any window, or the single-instance lock, and hide the Dock icon on macOS.
//   When packaged, await `app.whenReady()` so `utilityProcess.fork` can run child Node work (plugin host, PDF text).
// - Otherwise run the Botling 3 window: `./guard` first, content/editor hooks, then the 2.x main with `./core-client`
//   swapped for `./server-client` (build.mjs `buildMainV3`).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scrubEnvironment } from "../main/packaged";
import type { ServerCliOptions } from "../server/main";
import { electronUtilityOf, isPackagedElectron, loadElectron, type ElectronMainLike } from "../server/packaged-electron";

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

export interface MainV3Deps {
  argv?: readonly string[];
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  electron?: ElectronMainLike;
  root?: string;
  outDir?: string;
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
    if (platform === "darwin") {
      if (!app?.isReady?.()) app?.setActivationPolicy?.("prohibited");
      app?.dock?.hide?.();
    }
    const packaged = isPackagedElectron(electron);
    scrubEnvironment(env, packaged);
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
    const command = botlingd[0] ?? "start";
    await runServerCli(botlingd, {
      packaged,
      appId,
      outDir,
      ...(electronUtility ? { electronUtility } : {}),
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
