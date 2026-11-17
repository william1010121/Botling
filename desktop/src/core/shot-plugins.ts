// What `--component-shot` hands its chat page in place of the core's `plugins.web` / `plugins.file`: shot mode
// starts no core, so those two commands used to answer `core_unavailable` and botling.board's web part (it
// draws the pins above the input box and the floating cards) never loaded: the "pinned" and "floating"
// surfaces then had no component frame at all ("No component frame was drawn on this surface").
// Only botling.board is given, read straight from the built-in plugins folder, as the core's
// `webSpecs()` / `webFile()` (core/plugins/registry.ts) would give it.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, sep } from "node:path";

/** The one plugin a shot needs: the pins (chips, the opened sheet, floating cards). */
export const SHOT_PLUGIN = "botling.board";

/** `WebPluginSpecView` (contract/commands.ts), the part a shot fills. */
export interface ShotWebSpec {
  name: string;
  version: string;
  source: string;
  styles: string[];
  settings: Record<string, unknown>;
  commands: { id: string; title: string; key?: string }[];
  builtIn: true;
}

/** What a stylesheet may bring along (the core's `WEB_FILE_TYPES`). */
const FILE_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

interface Manifest { version: string; web: string; styles: string[] }

/** The manifest fields a shot reads, or null when the folder has no usable botling.board. */
function manifest(pluginsDir: string): Manifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(pluginsDir, SHOT_PLUGIN, "package.json"), "utf8")) as { version?: unknown; ccb?: { web?: unknown; styles?: unknown } };
    const { version, ccb } = raw;
    if (typeof version !== "string" || typeof ccb?.web !== "string") return null;
    const styles = Array.isArray(ccb.styles) ? ccb.styles.filter((style): style is string => typeof style === "string") : [];
    return { version, web: ccb.web, styles };
  } catch {
    return null;
  }
}

/** A file inside the plugin's folder, by real path (a link out of the folder is refused); null when it is not a regular file there. */
function insideFile(pluginsDir: string, relative: string): string | null {
  try {
    const real = realpathSync.native(join(pluginsDir, SHOT_PLUGIN, relative));
    const root = realpathSync.native(join(pluginsDir, SHOT_PLUGIN));
    return real.startsWith(root + sep) && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** `plugins.web` for a shot: botling.board's web part, its stylesheets named as the chat origin serves them. Empty when the build lacks it. */
export function shotWebSpecs(pluginsDir: string): ShotWebSpec[] {
  const found = manifest(pluginsDir);
  if (!found) return [];
  const web = insideFile(pluginsDir, normalize(found.web));
  if (!web) return [];
  let source: string;
  try { source = readFileSync(web, "utf8"); } catch { return []; }
  return [{
    name: SHOT_PLUGIN, version: found.version, source,
    styles: found.styles.map((style) => `botling-chat://chat/plugin-files/${SHOT_PLUGIN}/${style.split("/").map(encodeURIComponent).join("/")}`),
    settings: {}, commands: [], builtIn: true,
  }];
}

/** `plugins.file` for a shot: a stylesheet botling.board names, or a font or picture beside one (as the core's `webFile`). */
export function shotPluginFile(pluginsDir: string, name: string, path: string): { path: string; type: string } | null {
  if (name !== SHOT_PLUGIN) return null;
  const found = manifest(pluginsDir);
  if (!found) return null;
  const wanted = normalize(path);
  if (wanted.startsWith("..") || wanted.startsWith(sep) || wanted.split(sep).some((part) => part.startsWith("."))) return null;
  const type = FILE_TYPES[extname(wanted).toLowerCase()];
  if (!type) return null;
  const styles = found.styles.map((style) => normalize(style));
  const listed = styles.includes(wanted);
  const beside = styles.some((style) => {
    const folder = dirname(style);
    return (folder === "." || wanted.startsWith(folder + sep)) && extname(wanted).toLowerCase() !== ".css";
  });
  if (!listed && !beside) return null;
  const file = existsSync(join(pluginsDir, SHOT_PLUGIN, wanted)) ? insideFile(pluginsDir, wanted) : null;
  return file ? { path: file, type } : null;
}
