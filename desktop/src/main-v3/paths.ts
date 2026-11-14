// The data folder of the Botling 3 developer window: never 2.x's (`<desktop>/.data`).
import { join, resolve } from "node:path";

export function v3DataDir(root: string, env: Record<string, string | undefined>): { ok: true; dataDir: string } | { ok: false; error: string } {
  const dataDir = resolve(env.BOTLING_DATA_DIR || join(root, ".data-v3"));
  if (dataDir === resolve(root, ".data")) return { ok: false, error: "Botling 3 (main-v3) will not open the 2.x data folder; set BOTLING_DATA_DIR to another folder." };
  return { ok: true, dataDir };
}
