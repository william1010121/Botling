// Plugins' skills for every engine (plugin-platform.md §4.4; agent-contributions.ts lists them). Each engine is pointed at
// the plugin's own skill folder in its native way, never at a copy, so a rebuilt skill (botling.report's, from
// <data dir>/plugin-overrides) is what the next turn reads:
//   Claude       a small Claude plugin folder per skill folder, handed over with --plugin-dir: `.claude-plugin/plugin.json`
//                and `skills`, a link to the plugin's folder (`claudeSkillFolders`). A Claude part (`ccb.claude`) needs none.
//   Codex        `skills/extraRoots/set` on its app-server, before the first thread (codex.ts `skillRoots`), so the
//                coordinator and its workers (threads of the same app-server) see them.
//   Antigravity  `skills.json` in the app-owned profile's customization root (`<GEMINI_HOME>/config`, agy-acp.ts
//                `writeAgySkills`), written at every head and worker start.
// A plugin turned off is in none of them: its folders leave the list, and the stamp change restarts heads once free.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { appCommandFolder, guideLink } from "./app-command";

/** A Claude plugin name for a Botling plugin's (`botling.report` → `botling-report`): kebab case, as `claude plugin validate` asks. */
export function claudePluginName(plugin: string): string {
  return plugin.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
}

/**
 * Makes (or keeps) `<base>/<plugin>[.<n>]/` for each skill folder `roots` names (already placed: the paths engines are told)
 * and gives those folders, for --plugin-dir. Each has `.claude-plugin/plugin.json` and `skills`, a link to the root, so its
 * skills are `<claude name>:<skill>` and read from the plugin's own files. One that cannot be made is left out.
 */
export function claudeSkillFolders(roots: readonly { plugin: string; root: string }[], base: string): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (const { plugin, root } of roots) {
    const count = (seen.get(plugin) ?? 0) + 1;
    seen.set(plugin, count);
    const folder = join(base, count === 1 ? plugin : `${plugin}.${count}`);
    try {
      const manifest = join(folder, ".claude-plugin", "plugin.json");
      const text = `${JSON.stringify({ name: claudePluginName(count === 1 ? plugin : `${plugin}-${count}`), description: `Skills of the Botling plugin ${plugin}.` }, null, 2)}\n`;
      // Written only when it differs: an unchanged folder stays byte for byte as it was.
      if (!existsSync(manifest) || readFileSync(manifest, "utf8") !== text) {
        mkdirSync(join(folder, ".claude-plugin"), { recursive: true });
        writeFileSync(manifest, text);
      }
      if (guideLink(join(folder, "skills"), root) !== join(folder, "skills")) continue;
      out.push(folder);
    } catch { /* left out */ }
  }
  return out;
}

/**
 * The path engines are told for a plugin's skill folder `root`. For a shipped plugin whose command has a guide (`command`,
 * botling.report's `--render-report`): the same folder under `<guides>/<plugin>`, the link `commandGuidePath` keeps pointed
 * at the override's plugin folder in `overrides` or the shipped one, so the skill, its guide and the renderer come from one
 * plugin and a rebuilt override is read with no restart. Any other folder (no such command, or not inside its plugin): as it is.
 */
export function placedSkillRoot(root: string, command: { plugin: string; folder: string; flag: string } | undefined, guides: string, overrides?: string | null): string {
  if (!command) return root;
  const inside = relative(command.folder, root);
  if (!inside || inside === ".." || inside.startsWith("../") || isAbsolute(inside)) return root;
  return join(guideLink(join(guides, command.plugin), appCommandFolder(command.folder, command.plugin, command.flag, overrides)), inside);
}
