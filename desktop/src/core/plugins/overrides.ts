// A built-in plugin updated while the app runs (the user's wish: "most things hot reload, only the core does not").
//
// The shipped copy (the app build's own `builtin-plugins`) stays the default. A newer build of one shipped plugin may be pushed into
// `<core data>/builtin-overrides` (Plugins in plugins/index.ts: always that one folder, never one the environment names) by `desktop/scripts/push-builtin-plugin.sh <name>` (scripts/push-builtin-plugin.mjs, run by the
// developer after a merge); the registry then runs that copy in place of the shipped one, with the shipped one's rights (it is a
// built-in), and the plugin reloads the way a library plugin does: the next 1.5 s scan sees new files, the program part is swapped
// in the plugin host, the chat page loads only that web part again and an open frame loads its new source in the same slot.
//
// Layout (the script writes it, the core only reads it, and removes what is stale):
//   <root>/<name>.push.json         the stamp: { v: 1, plugin, dir, folderHash, pushedAt }
//   <root>/<name>@<12 hex>/         the built plugin folder, named by the first 12 hex of its folder hash (never rewritten in place)
// A push writes the new folder beside the old one and moves the stamp with one rename, so a scan never sees half a push and never sees
// the shipped copy between two pushes (no flash back). The script keeps the current folder and the one before it.
//
// What makes a pushed copy run (every one is checked at each scan; a pushed copy that fails any is ignored and the shipped one runs):
//   - the plugin is one the app ships, and not one the core reads from the shipped folder itself (CORE_FIXED_PLUGINS);
//   - the stamp is a plain file of this user, not writable by others, naming this plugin and a folder of this plugin's own;
//   - the folder is a plain folder of this user, not writable by others, with no link in it, whose files hash to the stamp's hash
//     (any file changed, added or removed after the push is ignored);
//   - it passes the same plugin check as any plugin (`loadPlugin`), keeps the shipped plugin's name, and is not an older semver;
//   - it was pushed after this app build was laid down: a newer build drops it (the stale stamp and folders are removed), so a new
//     install never runs a push made for an older one.
// It is not a security boundary against code that can already write the user's files (it can forge a stamp, as it can edit the
// plugin library); it keeps a stale, half-written, edited or foreign copy from running, and keeps everything except a push by the
// developer's own command off the path. Only the user's own program writes here: plugins get a storage folder of their own and no
// path to this one.
import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { folderHash } from "./catalog";
import { loadPlugin, type PluginManifest } from "./manifest";
import { compareVersions } from "./versions";

/** The stamp's file name for a plugin, in the overrides folder. */
export const stampFile = (name: string): string => `${name}.push.json`;

/** The plugins the core reads from the shipped folder itself (the orchestration rules): a pushed copy would not be the one it reads. */
export const CORE_FIXED_PLUGINS: readonly string[] = ["botling.orchestration"];

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HASH = /^[0-9a-f]{64}$/;
const MAX_STAMP_BYTES = 4096;
/** A push may be this much older than the shipped folder's time and still count as later (clocks and file times round). */
const TOLERANCE_MS = 1000;

export interface PushStamp { v: 1; plugin: string; dir: string; folderHash: string; pushedAt: number }

export interface PushedCopy {
  folder: string;
  manifest: PluginManifest;
  pushedAt: number;
  /** The shipped copy's version it replaces. */
  shippedVersion: string;
}

/** Whether a file or folder is the user's own and nobody else may write to it. */
function ownedAndClosed(stat: { uid: number; mode: number }): boolean {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return false;
  return (stat.mode & 0o022) === 0;
}

/** Every file of a plain folder (no link, no special file anywhere in it) with its stat signature; null when it is not plain. */
function plainSignature(folder: string, base = folder): string[] | null {
  const lines: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) { const inner = plainSignature(path, base); if (!inner) return null; lines.push(...inner); continue; }
    if (!entry.isFile()) return null;
    const stat = lstatSync(path);
    lines.push(`${relative(base, path).split(sep).join("/")}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`);
  }
  return lines.sort();
}

/** When the shipped copy of a plugin was laid down: the later of its folder's and its manifest's birth and modification times. */
function shippedLaidDownAt(folder: string): number {
  let at = 0;
  for (const path of [folder, join(folder, "package.json")]) {
    try { const stat = statSync(path); at = Math.max(at, stat.birthtimeMs, stat.mtimeMs); } catch { /* not there */ }
  }
  return at;
}

function readStamp(file: string, name: string): PushStamp | null {
  let stat;
  try { stat = lstatSync(file); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_STAMP_BYTES || !ownedAndClosed(stat)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { v, plugin, dir, folderHash: hash, pushedAt } = raw as Record<string, unknown>;
  if (v !== 1 || plugin !== name || typeof dir !== "string" || typeof hash !== "string" || !HASH.test(hash) || typeof pushedAt !== "number" || !Number.isFinite(pushedAt)) return null;
  // The folder is this plugin's own, named by its hash: never a path that leads anywhere else.
  if (dir !== `${name}@${hash.slice(0, 12)}`) return null;
  return { v: 1, plugin: name, dir, folderHash: hash, pushedAt };
}

/** Removes a plugin's stamp and folders from the overrides folder (what a stale push leaves; the script's `--remove` does the same). */
export function dropPush(root: string, name: string): void {
  if (!NAME.test(name)) return;
  try { rmSync(join(root, stampFile(name)), { force: true }); } catch { /* gone */ }
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return; }
  for (const entry of entries) {
    if (entry.startsWith(`${name}@`)) { try { rmSync(join(root, entry), { recursive: true, force: true }); } catch { /* gone */ } }
  }
}

/** What the last look at a pushed folder found, by its stat signature (so a scan every 1.5 s does not hash every file again). */
interface Look { dir: string; signature: string; hash: string; ok: boolean }

/** Reads the overrides folder for the registry: one plugin's pushed copy, or null (the shipped copy runs). */
export class PushedCopies {
  private looks = new Map<string, Look>();
  /** The problems already said, by plugin, so a scan every 1.5 s says each once. */
  private said = new Map<string, string>();

  constructor(private readonly root: string, private readonly say: (text: string) => void = () => {}) {}

  /** The pushed copy that may run in place of shipped plugin `name` (`shipped`: its folder and manifest), or null. */
  find(name: string, shipped: { folder: string; version: string }): PushedCopy | null {
    if (!NAME.test(name) || CORE_FIXED_PLUGINS.includes(name)) return null;
    const stamp = readStamp(join(this.root, stampFile(name)), name);
    if (!stamp) return null;
    // A build newer than the push: the push is for an older install. Dropped for good, with its folders.
    if (stamp.pushedAt + TOLERANCE_MS < shippedLaidDownAt(shipped.folder)) {
      dropPush(this.root, name);
      this.looks.delete(name);
      this.say(`Plugin "${name}": the pushed copy is older than this build of the app and was dropped; the build's own copy runs.`);
      return null;
    }
    const folder = join(this.root, stamp.dir);
    let stat;
    try { stat = lstatSync(folder); } catch { return this.refuse(name, stamp.dir, "its folder is missing"); }
    if (!stat.isDirectory() || !ownedAndClosed(stat)) return this.refuse(name, stamp.dir, "its folder is not a plain folder of this user that others cannot write to");
    let signature: string;
    try {
      const lines = plainSignature(folder);
      if (!lines) return this.refuse(name, stamp.dir, "it holds a link or a special file");
      signature = lines.join("|");
    } catch {
      return this.refuse(name, stamp.dir, "its folder could not be read");
    }
    const known = this.looks.get(name);
    let ok: boolean;
    if (known && known.dir === stamp.dir && known.signature === signature && known.hash === stamp.folderHash) ok = known.ok;
    else {
      try { ok = folderHash(folder) === stamp.folderHash; } catch { ok = false; }
      this.looks.set(name, { dir: stamp.dir, signature, hash: stamp.folderHash, ok });
    }
    if (!ok) return this.refuse(name, stamp.dir, "its files are not the ones that were pushed");
    const loaded = loadPlugin(folder, "builtIn");
    if (!loaded.ok) return this.refuse(name, stamp.dir, `it fails the plugin check: ${loaded.problems.join("; ")}`);
    if (loaded.manifest.name !== name) return this.refuse(name, stamp.dir, `its manifest is for "${loaded.manifest.name}"`);
    const order = compareVersions(loaded.manifest.version, shipped.version);
    if (order !== null && order < 0) return this.refuse(name, stamp.dir, `its version ${loaded.manifest.version} is older than the build's ${shipped.version}`);
    this.said.delete(name);
    return { folder, manifest: loaded.manifest, pushedAt: stamp.pushedAt, shippedVersion: shipped.version };
  }

  private refuse(name: string, dir: string, why: string): null {
    const text = `Plugin "${name}": the pushed copy (${dir}) is ignored, the build's own copy runs: ${why}.`;
    if (this.said.get(name) !== text) { this.said.set(name, text); this.say(text); }
    return null;
  }
}
