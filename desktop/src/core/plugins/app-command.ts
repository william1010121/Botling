// A command a plugin shipped with the app gives the bots (`contributes.agentCommands`, contributions.ts) and that the app runs as one
// of its own flags (`Botling 2 --render-report spec.json page.html`): the script that flag names, found in the built-in plugins.
// Read before the app is ready, with no registry: only the shipped folder is looked in, never the user's plugin library.
//
// One exception, so a command's code can change without rebuilding or restarting the app: an override folder (main passes
// `<data dir>/plugin-overrides`) laid out as the shipped one. A plugin there replaces the shipped plugin's script for a flag
// only when it has the same name and declares the same flag as the shipped one: it can change how a command a shipped plugin
// already gives works, never add a command or a flag. The script is required afresh by each run (one process per call), so a
// rebuilt override takes effect on the next call (`node build-builtin-plugins.mjs --only botling.report --out <folder>`).
//
// The command's guide (its `docs`, botling.report's report-blocks.md) comes from the same plugin as the script that runs, so the
// rules a bot reads match the renderer it runs. Bots are told one stable path for it (`guideLink`, a symlink the core points at the
// override's plugin folder or the shipped one), so the system prompt stays the same when an override comes or goes, and a rebuilt
// guide is what the next report a bot writes reads: no new app build, no restart, no new Claude session.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { insidePlugin } from "./contributions";

interface Found { name: string; folder: string; script: string; docs: string | null }

/** The plugin in `root` that declares `flag` (its manifest name and absolute script path), with `name` only that one plugin. */
function findCommand(root: string, flag: string, name?: string): Found | null {
  let folders: string[] = [];
  try { folders = readdirSync(root).filter((entry) => !entry.startsWith(".")).sort(); } catch { return null; }
  for (const folder of folders) {
    try {
      const manifest = JSON.parse(readFileSync(join(root, folder, "package.json"), "utf8")) as { name?: unknown; ccb?: { contributes?: { agentCommands?: { flag?: unknown; script?: unknown; docs?: unknown }[] } } };
      if (name !== undefined && manifest.name !== name) continue;
      for (const command of manifest.ccb?.contributes?.agentCommands ?? []) {
        if (command.flag === flag && typeof command.script === "string" && insidePlugin(command.script)) {
          const docs = typeof command.docs === "string" && insidePlugin(command.docs) ? join(root, folder, command.docs) : null;
          return { name: typeof manifest.name === "string" ? manifest.name : folder, folder: join(root, folder), script: join(root, folder, command.script), docs };
        }
      }
    } catch { /* not a plugin */ }
  }
  return null;
}

/** The override of shipped plugin `name`'s `flag` in `overrides`, when it has one whose script is there (null: none). */
function overrideOf(overrides: string | null | undefined, flag: string, name: string): Found | null {
  const override = overrides ? findCommand(overrides, flag, name) : null;
  return override && existsSync(override.script) ? override : null;
}

/** The script for `flag`: an override's for the same shipped plugin when there is one, else the shipped plugin's (null: none ships it). */
export function appCommandScript(builtIns: string, flag: string, overrides?: string | null): string | null {
  const shipped = findCommand(builtIns, flag);
  if (!shipped) return null;
  return overrideOf(overrides, flag, shipped.name)?.script ?? shipped.script;
}

/**
 * The plugin folder whose guide goes with `flag` of shipped plugin `plugin` (its folder `shippedFolder`): the override's, when
 * `overrides` has one for it (its script and guide both there), else the shipped one.
 */
export function appCommandFolder(shippedFolder: string, plugin: string, flag: string, overrides?: string | null): string {
  const override = overrideOf(overrides, flag, plugin);
  return override?.docs && existsSync(override.docs) ? override.folder : shippedFolder;
}

/**
 * Points the symlink `link` at `target` (replacing it in one rename when it points elsewhere) and gives the path bots are told:
 * `link`, or `target` itself when no link can be made there.
 */
export function guideLink(link: string, target: string): string {
  try {
    if (readlinkSync(link) === target) return link;
  } catch { /* none yet, or not a link */ }
  try {
    mkdirSync(dirname(link), { recursive: true });
    const next = `${link}.${process.pid}.next`;
    rmSync(next, { force: true });
    symlinkSync(target, next, "dir");
    // A folder (not a link) in the way is left alone: bots are told the target instead.
    if (existsSync(link) && !lstatSync(link).isSymbolicLink()) { rmSync(next, { force: true }); return target; }
    // Windows renames nothing onto an existing link: the old one goes first (not atomic there).
    if (process.platform === "win32") { try { unlinkSync(link); } catch { /* none */ } }
    renameSync(next, link);
    return link;
  } catch {
    return target;
  }
}

/**
 * The path bots are told for a shipped command's guide (`docs`, absolute, inside the shipped plugin `folder`):
 * `<guides>/<plugin>/<docs inside the plugin>`, through a link to the plugin folder whose script the command runs (an override's
 * in `overrides`, else the shipped one), re-pointed on every call. The path stays the same when an override comes or goes, so the
 * prompt that names it does too.
 */
export function commandGuidePath(command: { plugin: string; folder: string; flag: string; docs: string }, guides: string, overrides?: string | null): string {
  const target = appCommandFolder(command.folder, command.plugin, command.flag, overrides);
  return join(guideLink(join(guides, command.plugin), target), relative(command.folder, command.docs));
}
