// The data folder of the Botling 3 window: <appData>/Botling 3 when packaged, <desktop>/.data-v3 in dev;
// never 2.x's packaged folders or `<desktop>/.data`.
import { join, resolve, sep } from "node:path";
import { packagedDataDir } from "../main/main-environment";

export const REFUSE_2X_DATA_DIR = "Botling 3 will not open the Botling 2 data folder; set BOTLING_DATA_DIR to another folder.";

export function v3DataDir(
  root: string,
  env: Record<string, string | undefined>,
  packaged?: { appData: string },
): { ok: true; dataDir: string } | { ok: false; error: string } {
  const defaultDir = packaged ? join(packaged.appData, "Botling 3") : join(root, ".data-v3");
  const dataDir = resolve(env.BOTLING_DATA_DIR || defaultDir);
  const forbidden = [
    resolve(root, ".data"),
    ...(packaged ? [resolve(packagedDataDir(packaged.appData, false)), resolve(packagedDataDir(packaged.appData, true))] : []),
  ];
  if (forbidden.some((dir) => dataDir === dir || dataDir.startsWith(dir + sep))) {
    return { ok: false, error: REFUSE_2X_DATA_DIR };
  }
  return { ok: true, dataDir };
}

export function applyV3Guard(options: {
  root: string;
  env: Record<string, string | undefined>;
  packaged?: { appData: string };
}): string {
  const chosen = v3DataDir(options.root, options.env, options.packaged);
  if (!chosen.ok) throw new Error(chosen.error);
  options.env.BOTLING_DATA_DIR = chosen.dataDir;
  options.env.BOTLING_UPDATE_CHANNEL = "v3";
  return chosen.dataDir;
}
