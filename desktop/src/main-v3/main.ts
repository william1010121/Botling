// Botling 3's Electron main (M1 step 11, M6-07c):
// - When `--botlingd` is passed, run botlingd's CLI directly without loading `./guard`, `./content-install`,
//   `./editor-packets-install`, `../main/main`, any window, or the single-instance lock, and hide the Dock icon on macOS.
// - Otherwise run the Botling 3 window: `./guard` first, content/editor hooks, then the 2.x main with `./core-client`
//   swapped for `./server-client` (build.mjs `buildMainV3`).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { scrubEnvironment } from "../main/packaged";
import type { ServerCliOptions } from "../server/main";

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
  electron?: {
    app?: {
      isPackaged?: boolean;
      isReady?: () => boolean;
      setActivationPolicy?: (policy: "regular" | "accessory" | "prohibited") => void;
      dock?: { hide?: () => void };
    };
  };
  root?: string;
  outDir?: string;
  runServerCli?: (argv: string[], options: ServerCliOptions) => Promise<void>;
  loadWindowMain?: () => void;
  exit?: (code: number) => void;
}

function loadElectron(): MainV3Deps["electron"] | undefined {
  if (!process.versions.electron) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("electron") as MainV3Deps["electron"] | string;
  return typeof mod === "object" && mod !== null ? mod : undefined;
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
    const packaged = app?.isPackaged === true;
    scrubEnvironment(env, packaged);
    if (packaged && !env.BOTLING_BUILTIN_PLUGINS && process.resourcesPath) {
      env.BOTLING_BUILTIN_PLUGINS = join(process.resourcesPath, "builtin-plugins");
    }
    const root = deps.root ?? resolve(__dirname, "..", "..");
    const appId = packaged ? packagedAppId(root) : undefined;
    const outDir = deps.outDir ?? join(__dirname, "..");
    const runServerCli = deps.runServerCli ?? (() => {
      (globalThis as { __botlingdManualMain?: boolean }).__botlingdManualMain = true;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return (require("../server/main") as { main: NonNullable<MainV3Deps["runServerCli"]> }).main;
    })();
    const command = botlingd[0] ?? "start";
    await runServerCli(botlingd, { packaged, appId, outDir });
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
