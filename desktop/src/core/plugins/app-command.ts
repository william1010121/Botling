// A command a plugin shipped with the app gives the bots (`contributes.agentCommands`, contributions.ts) and that the app runs as one
// of its own flags (`Botling 2 --render-report spec.json page.html`): the script that flag names, found in the built-in plugins.
// Read before the app is ready, with no registry: only the shipped folder is looked in, never the user's plugin library.
//
// One exception, so a command's code can change without rebuilding or restarting the app: an override folder (main passes
// `<data dir>/plugin-overrides`) laid out as the shipped one. A plugin there replaces the shipped plugin's script for a flag
// only when it has the same name and declares the same flag as the shipped one: it can change how a command a shipped plugin
// already gives works, never add a command or a flag. The script is required afresh by each run (one process per call), so a
// rebuilt override takes effect on the next call (`node build-builtin-plugins.mjs --only botling.report --out <folder>`).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { insidePlugin } from "./contributions";

interface Found { name: string; script: string }

/** The plugin in `root` that declares `flag` (its manifest name and absolute script path), with `name` only that one plugin. */
function findCommand(root: string, flag: string, name?: string): Found | null {
  let folders: string[] = [];
  try { folders = readdirSync(root).filter((entry) => !entry.startsWith(".")).sort(); } catch { return null; }
  for (const folder of folders) {
    try {
      const manifest = JSON.parse(readFileSync(join(root, folder, "package.json"), "utf8")) as { name?: unknown; ccb?: { contributes?: { agentCommands?: { flag?: unknown; script?: unknown }[] } } };
      if (name !== undefined && manifest.name !== name) continue;
      for (const command of manifest.ccb?.contributes?.agentCommands ?? []) {
        if (command.flag === flag && typeof command.script === "string" && insidePlugin(command.script)) {
          return { name: typeof manifest.name === "string" ? manifest.name : folder, script: join(root, folder, command.script) };
        }
      }
    } catch { /* not a plugin */ }
  }
  return null;
}

/** The script for `flag`: an override's for the same shipped plugin when there is one, else the shipped plugin's (null: none ships it). */
export function appCommandScript(builtIns: string, flag: string, overrides?: string | null): string | null {
  const shipped = findCommand(builtIns, flag);
  if (!shipped) return null;
  const override = overrides ? findCommand(overrides, flag, shipped.name) : null;
  return override && existsSync(override.script) ? override.script : shipped.script;
}
