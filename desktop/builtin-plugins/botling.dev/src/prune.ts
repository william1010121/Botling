// Old app copies the self-update leaves behind, removed once an update has succeeded:
//  - core/self-update/backups: the running build moved aside by each install (`Botling-2-<version>-<date>-<epoch>.app`,
//    swap.ts); only the newest KEEP_BACKUPS stay;
//  - ~/Applications: `.botling-update-*`, `update-after-*` and `.botling-hot-*` leftovers.
// Both take the folder as a parameter (tests use temp folders). Only direct children with those exact name patterns
// are touched; symlinks are never followed or removed; anything named in `protect` (the build running, the one just
// installed, the backup an in-flight rollback needs), or inside / containing one of those, stays.
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Backups kept after an update. */
export const KEEP_BACKUPS = 2;

/** The name swap.ts gives a backup: `Botling-2-<version>-<yyyy-mm-dd>-<epoch seconds>.app`. */
const BACKUP_NAME = /^Botling-2-[0-9A-Za-z._-]+-\d{4}-\d{2}-\d{2}-(\d+)\.app$/;
/** Leftovers in ~/Applications (the whole name must match). */
export const LEFTOVER_NAME = /^(?:\.botling-update-.+|update-after-.+|\.botling-hot-.+)$/;

export interface PruneOptions {
  /** Paths that must survive: the running app, the installed one, the in-flight rollback backup. */
  protect?: string[];
}

const physical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/** Whether `entry` is one of `protect`, holds one, or is inside one. */
function protectedBy(entry: string, protect: string[]): boolean {
  const here = physical(entry);
  return protect.some((raw) => {
    const other = physical(raw);
    return other === here || other.startsWith(here + sep) || here.startsWith(other + sep);
  });
}

/** Direct children of `dir` that are real folders or files (not symlinks) with a name `pattern` accepts. */
function candidates(dir: string, pattern: RegExp, foldersOnly: boolean): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  return entries.filter((name) => pattern.test(name)).flatMap((name) => {
    try {
      const stat = lstatSync(join(dir, name));
      if (stat.isSymbolicLink() || (foldersOnly && !stat.isDirectory())) return [];
      return [name];
    } catch { return []; }
  });
}

function remove(path: string): boolean {
  try { rmSync(path, { recursive: true, force: true }); return true; } catch { return false; }
}

/** Keeps the newest `keep` backups (by the stamp in the name) and anything protected; removes the rest. */
export function pruneBackups(dir: string, options: PruneOptions & { keep?: number } = {}): { removed: string[]; kept: string[] } {
  const keep = Math.max(0, options.keep ?? KEEP_BACKUPS);
  const protect = options.protect ?? [];
  const names = candidates(dir, BACKUP_NAME, true)
    .map((name) => ({ name, epoch: Number(BACKUP_NAME.exec(name)![1]) }))
    .sort((a, b) => b.epoch - a.epoch || (a.name < b.name ? 1 : -1));
  const removed: string[] = [];
  const kept: string[] = [];
  names.forEach(({ name }, index) => {
    const path = join(dir, name);
    if (index < keep || protectedBy(path, protect)) { kept.push(path); return; }
    if (remove(path)) removed.push(path); else kept.push(path);
  });
  return { removed, kept };
}

/** Removes the update leftovers directly inside `dir` (~/Applications), except what is protected. */
export function pruneUpdateLeftovers(dir: string, options: PruneOptions = {}): { removed: string[]; kept: string[] } {
  const protect = options.protect ?? [];
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of candidates(dir, LEFTOVER_NAME, false)) {
    const path = join(dir, name);
    if (protectedBy(path, protect)) { kept.push(path); continue; }
    if (remove(path)) removed.push(path); else kept.push(path);
  }
  return { removed, kept };
}
