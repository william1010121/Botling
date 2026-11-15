// The data folder of the Botling 3 window: <appData>/Botling 3 when packaged, <desktop>/.data-v3 in dev;
// never 2.x's packaged folders or `<desktop>/.data`.
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { packagedDataDir } from "../main/main-environment";

export const REFUSE_2X_DATA_DIR = "Botling 3 will not open the Botling 2 data folder; set BOTLING_DATA_DIR to another folder.";

/** macOS and Windows folders are case-insensitive (`botling 2` is `Botling 2`), and APFS ignores Unicode normalization. */
function samePathKey(path: string): string {
  const nfc = path.normalize("NFC");
  return process.platform === "darwin" || process.platform === "win32" ? nfc.toLowerCase() : nfc;
}

/** Whether `dataDir` (or the nearest folder it would be made in) is one of `forbidden` or inside one, by the folder
 * itself (dev and inode after `realpathSync.native`), so a symlink, firmlink or other spelling cannot reach 2.x's data. */
function insideOnDisk(dataDir: string, forbidden: string[]): boolean {
  const ids = new Set<string>();
  for (const dir of forbidden) {
    try { const st = statSync(dir); ids.add(`${st.dev}:${st.ino}`); } catch { /* not there: nothing to protect on disk */ }
  }
  if (ids.size === 0) return false;
  let at = dataDir;
  while (!existsSync(at) && dirname(at) !== at) at = dirname(at);
  try {
    for (at = realpathSync.native(at); ; at = dirname(at)) {
      const st = statSync(at);
      if (ids.has(`${st.dev}:${st.ino}`)) return true;
      if (dirname(at) === at) return false;
    }
  } catch {
    return true; // cannot tell: refuse
  }
}

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
  const key = samePathKey(dataDir);
  if (forbidden.some((dir) => key === samePathKey(dir) || key.startsWith(samePathKey(dir) + sep)) || insideOnDisk(dataDir, forbidden)) {
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
