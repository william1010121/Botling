// A command a plugin shipped with the app gives the bots (`contributes.agentCommands`, contributions.ts) and that the app runs as one
// of its own flags (`Botling 2 --render-report spec.json page.html`): the script that flag names, found in the built-in plugins.
// Read before the app is ready, with no registry: only the shipped folder is looked in, never the user's plugin library.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { insidePlugin } from "./contributions";

export function appCommandScript(builtIns: string, flag: string): string | null {
  let names: string[] = [];
  try { names = readdirSync(builtIns).filter((name) => !name.startsWith(".")).sort(); } catch { return null; }
  for (const name of names) {
    try {
      const manifest = JSON.parse(readFileSync(join(builtIns, name, "package.json"), "utf8")) as { ccb?: { contributes?: { agentCommands?: { flag?: unknown; script?: unknown }[] } } };
      for (const command of manifest.ccb?.contributes?.agentCommands ?? []) {
        if (command.flag === flag && typeof command.script === "string" && insidePlugin(command.script)) return join(builtIns, name, command.script);
      }
    } catch { /* not a plugin */ }
  }
  return null;
}
