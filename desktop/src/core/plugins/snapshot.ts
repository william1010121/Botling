// Plugin snapshots (moved out of index.ts, M7-S12): a content-addressed copy of a plugin's folder, checked before it is reused.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import { folderHash } from "./catalog";
import { sha, type SnapshotFile } from "./types";

/**
 * Reads every file under `dir` once (matching `folderHash`'s traversal and sort order) and computes its hash
 * from the exact bytes read, avoiding a TOCTOU window between hashing and copying.
 */
function readPluginSnapshot(dir: string): { codeHash: string; files: SnapshotFile[] } {
  const files: SnapshotFile[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Plugin folder cannot contain symbolic links: ${entry.name}`);
      const full = join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = relative(dir, full).split(sep).join("/");
        const data = readFileSync(full);
        const mode = statSync(full).mode;
        files.push({ rel, data, mode });
      }
    }
  };
  walk(dir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const codeHash = sha(files.map((file) => `${file.rel}\0${sha(file.data)}\n`).join(""));
  return { codeHash, files };
}

/**
 * Materializes a verified content-addressed copy of `files` at `<snapshotRoot>/<codeHash>` so lazy `import()`
 * and `api.plugin.dir` read only the bytes that were hashed.
 */
/** The copy is the same user's files: reuse it only as a real folder, with no links, holding exactly these bytes. */
function snapshotIntact(dest: string, codeHash: string): boolean {
  try {
    return !lstatSync(dest).isSymbolicLink() && readPluginSnapshot(dest).codeHash === codeHash;
  } catch { return false; /* missing or corrupt snapshot */ }
}

function materializeSnapshot(snapshotRoot: string, codeHash: string, files: readonly SnapshotFile[]): { dir: string; repaired: boolean } {
  const dest = join(snapshotRoot, codeHash);
  let repaired = false;
  if (lstatSync(dest, { throwIfNoEntry: false })) {
    // M5-18b review: an edit or a link planted in it is replaced, and the caller starts that host afresh.
    if (snapshotIntact(dest, codeHash)) return { dir: dest, repaired };
    rmSync(dest, { recursive: true, force: true });
    repaired = true;
  }
  mkdirSync(snapshotRoot, { recursive: true });
  const tmp = join(snapshotRoot, `.tmp-${codeHash}-${randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    for (const file of files) {
      const target = join(tmp, file.rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.data, { mode: (file.mode & 0o111) ? 0o555 : 0o444 });
    }
    if (folderHash(tmp) !== codeHash) throw new Error("Snapshot hash mismatch after materialization.");
    try {
      renameSync(tmp, dest);
    } catch (error) {
      if (snapshotIntact(dest, codeHash)) {
        rmSync(tmp, { recursive: true, force: true });
        return { dir: dest, repaired };
      }
      throw error;
    }
    return { dir: dest, repaired };
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
}

function pruneSnapshots(snapshotRoot: string, active: ReadonlySet<string>) {
  if (!existsSync(snapshotRoot)) return;
  try {
    for (const entry of readdirSync(snapshotRoot, { withFileTypes: true })) {
      if (active.has(entry.name)) continue;
      rmSync(join(snapshotRoot, entry.name), { recursive: true, force: true });
    }
  } catch { /* best-effort cleanup */ }
}

export const SERVER_PART_HELD_NOTICE = "Its program part is off until you allow it to change its own data on this server.";

const str = (max: number) => z.string().max(max);

export { readPluginSnapshot, materializeSnapshot, pruneSnapshots, str };
