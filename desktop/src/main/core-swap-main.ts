// Main's entry points for a core hot swap (docs/core-hot-swap.md): `swap()` for the install flow and
// tests, a Develop ▸ Swap Core menu item and SIGUSR2 in source runs and dev-trial builds.
import type { MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import type { CoreClient } from "./core-client";
import { CoreSwapper, coreBuild, stageCoreBuild, type SwapOptions, type SwapOutcome } from "./core-swap";
import { SWAP_FILE } from "../core/hot-swap";

export interface CoreSwapSetup {
  core: CoreClient;
  /** desktop/ (packaged: Resources/app.asar). */
  root: string;
  /** Main's data folder (the core's is `<dataDir>/core`). */
  dataDir: string;
  packaged: boolean;
  devTrial: boolean;
  argv: string[];
  note: (line: string) => void;
}

export interface CoreSwap {
  /** Swaps to the configured build (or `script`, an already checked core entry). */
  swap(options?: SwapOptions & { script?: string }): Promise<SwapOutcome>;
  /** Menu entries (none for ordinary packaged builds). */
  menu: MenuItemConstructorOptions[];
  /** Where swaps take the core from. */
  directory: string;
}

export function installCoreSwap(setup: CoreSwapSetup): CoreSwap {
  const build = coreBuild(setup.root, setup.packaged, setup.devTrial, setup.argv);
  const staging = join(setup.dataDir, "core-builds");
  const scratch = join(process.env.TMPDIR ?? tmpdir(), "botling-core-probe");
  const swapper = new CoreSwapper(setup.core.swapPorts(join(setup.dataDir, "core", SWAP_FILE), scratch));
  let current: string | null = null;
  const swap = async (options: SwapOptions & { script?: string } = {}): Promise<SwapOutcome> => {
    let script = options.script;
    try {
      mkdirSync(scratch, { recursive: true });
      // A development build is copied first, so rebuilding never changes files under a running core.
      script ??= build.development ? stageCoreBuild(build.directory, staging, current) : build.script;
    } catch (error) {
      const outcome: SwapOutcome = { ok: false, stage: "self-check", error: (error as Error).message };
      setup.note(`core swap: ${outcome.error}`);
      return outcome;
    }
    const outcome = await swapper.swap(script, options);
    if (outcome.ok && script.startsWith(staging)) current = script;
    if (!outcome.ok) setup.note(`core swap failed at ${outcome.stage}: ${outcome.error}`);
    return outcome;
  };
  const enabled = !setup.packaged || setup.devTrial;
  const run = () => void swap().then((outcome) => console.log(`[core swap] ${JSON.stringify(outcome)}`));
  if (enabled) process.on("SIGUSR2", run);
  const menu: MenuItemConstructorOptions[] = enabled
    ? [{ label: "Develop", submenu: [{ label: "Swap Core from Build", click: run }] }]
    : [];
  if (enabled) console.log(`[core swap] builds come from ${build.directory}; Develop ▸ Swap Core or SIGUSR2 swaps`);
  return { swap, menu, directory: build.directory };
}
