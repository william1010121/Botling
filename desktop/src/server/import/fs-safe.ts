// Safe file helpers of the 2.x -> 3.x import (moved unchanged out of run.ts, M7-S21a): real-path and nesting checks,
// the write guard that keeps the import out of the 2.x folder, and the read-only copy of the source's files.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readLockHolder } from "../../core/store/data-dir-lock";
import { ImportError } from "./run";


function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function holderPid(dataDir: string): number | null {
  const holder = readLockHolder(dataDir);
  return holder && alive(holder.pid) ? holder.pid : null;
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const FIRMLINK_DATA = "/System/Volumes/Data";

/**
 * The real path as the file system spells it. The OS realpath (`realpathSync.native`), not Node's JS one: on a
 * case-insensitive volume (the Mac's default) the JS one keeps the caller's case, so `/x/V2` and `/x/v2` would look like
 * two folders. Every path used to compare or identify folders here goes through it.
 */
export function realPath(path: string): string {
  const real = realpathSync.native(path);
  // A macOS firmlink spelling (/System/Volumes/Data/Users/... for /Users/...) is not folded by any realpath: fold it
  // when the short spelling is the same folder, so one folder has one identity (`sourceHash`) and one spelling.
  if (process.platform === "darwin" && real.startsWith(`${FIRMLINK_DATA}/`)) {
    const short = real.slice(FIRMLINK_DATA.length);
    try {
      const a = statSync(real);
      const b = statSync(short);
      if (a.dev === b.dev && a.ino === b.ino) return short;
    } catch {
      // the short spelling is not there: keep the long one
    }
  }
  return real;
}

/** The ancestors of `path` (itself first) that exist, with their device and inode. */
function existingChain(path: string): { dev: number; ino: number }[] {
  const chain: { dev: number; ino: number }[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const stat = statSync(current);
      chain.push({ dev: stat.dev, ino: stat.ino });
    } catch {
      // not there (yet): only existing folders can be shared
    }
    const parent = dirname(current);
    if (parent === current) return chain;
    current = parent;
  }
}

/**
 * True when one folder is the other or inside it, by device and inode as well as by path: catches spellings no
 * realpath folds (macOS firmlinks such as /System/Volumes/Data/Users, a case-insensitive volume reached by another
 * path).
 */
export function sameOrNested(a: string, b: string): boolean {
  if (isInside(a, b) || isInside(b, a)) return true;
  const chainA = existingChain(a);
  const chainB = existingChain(b);
  // `b` is `a` or one of a's existing ancestors (a may not exist yet: its nearest existing folder stands in for it),
  // or the other way round. A folder that does not exist cannot contain the other one.
  const nodeA = existsSync(a) ? chainA[0] : undefined;
  const nodeB = existsSync(b) ? chainB[0] : undefined;
  const has = (chain: readonly { dev: number; ino: number }[], node: { dev: number; ino: number } | undefined) =>
    node !== undefined && chain.some((other) => other.dev === node.dev && other.ino === node.ino);
  return has(chainA, nodeB) || has(chainB, nodeA);
}

/** `path` with symlinks resolved, also when its last parts do not exist yet (the nearest existing folder is resolved). */
export function realPathOrNearest(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realPath(current), ...tail);
  } catch {
    return join(current, ...tail);
  }
}

/** Throws before a write that would land in the 2.x folder. Every write of the import goes through one. */
export type WriteGuard = (path: string) => void;

/**
 * Where a write to `path` lands: its real path, or its nearest existing parent's real path plus the rest. A symbolic
 * link on the way that points nowhere is refused: creating a file through it would create the link's target, wherever
 * that is.
 */
function writeDestination(path: string): string {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    let isLink = false;
    let present = true;
    try {
      isLink = lstatSync(current).isSymbolicLink();
    } catch {
      present = false;
    }
    if (present) {
      if (isLink && !existsSync(current)) {
        throw new ImportError(`${current} is a broken symbolic link; the import does not write through it.`, 2);
      }
      return join(realPath(current), ...tail);
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...tail);
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * The guard for one import: a write is refused when its destination is the 2.x folder or inside it, by real path or by
 * device and inode (a symlink, another case, a firmlink, a bind mount). The 2.x folder is never written, even through a
 * link the user made in botlingd's folder.
 */
export function makeWriteGuard(sourceReal: string): WriteGuard {
  const source = statSync(sourceReal);
  return (path) => {
    const real = writeDestination(path);
    const inside =
      isInside(real, sourceReal) ||
      existingChain(real).some((node) => node.dev === source.dev && node.ino === source.ino);
    if (inside) {
      throw new ImportError(`${path} leads into the Botling 2 folder, which the import never changes; nothing was written there.`, 2);
    }
  };
}

/** The target folder and each entry at its top, checked before the lock, server.db and the identity are written. */
export function guardTargetTop(targetDir: string, guard: WriteGuard): void {
  guard(targetDir);
  let names: string[] = [];
  try {
    names = readdirSync(targetDir);
  } catch {
    return;
  }
  for (const name of names.sort()) guard(join(targetDir, name));
}

/** The 2.x plugin-secrets.json's device and inode, so a hard link to it is not copied either. */
export function secretsNode(sourceReal: string): { dev: number; ino: number } | null {
  try {
    const stat = statSync(join(sourceReal, "plugin-secrets.json"));
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

export function sameNode(stat: { dev: number; ino: number }, node: { dev: number; ino: number } | null): boolean {
  return node !== null && stat.dev === node.dev && stat.ino === node.ino;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function parseImportedAt(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { at?: unknown };
    if (typeof parsed.at === "string" && parsed.at) return parsed.at;
  } catch {
    // fall back to raw string
  }
  return raw;
}

export function defaultBuiltInsDir(): string | null {
  const envDir = process.env.BOTLING_BUILTIN_PLUGINS;
  if (envDir && existsSync(envDir)) return envDir;
  const candidate = join(__dirname, "..", "builtin-plugins");
  if (existsSync(candidate)) return candidate;
  return null;
}

function readFileReadOnly(file: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeBytesAtomic(file: string, data: Buffer, guard: WriteGuard): void {
  guard(file);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function copyTreeReadOnly(srcDir: string, dstDir: string, srcBoundary: string, guard: WriteGuard): void {
  if (!existsSync(srcDir)) return;
  let rootStat;
  try {
    rootStat = lstatSync(srcDir);
  } catch {
    return;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return;
  const srcRootReal = realPath(srcBoundary);
  const secrets = secretsNode(srcRootReal);
  guard(dstDir);
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const srcPath = join(srcDir, entry.name);
    if (srcPath === join(srcBoundary, "plugin-secrets.json") || srcPath === join(srcRootReal, "plugin-secrets.json")) continue;
    const dstPath = join(dstDir, entry.name);
    let stat;
    try {
      stat = lstatSync(srcPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      try {
        const real = realPath(srcPath);
        if (!isInside(real, srcRootReal)) continue;
        if (real === join(srcRootReal, "plugin-secrets.json")) continue;
        const realStat = statSync(real);
        if (realStat.isDirectory() || sameNode(realStat, secrets)) continue;
        const data = readFileReadOnly(real);
        if (data !== null) writeBytesAtomic(dstPath, data, guard);
      } catch (error) {
        if (error instanceof ImportError) throw error;
        continue;
      }
      continue;
    }
    if (stat.isDirectory()) {
      copyTreeReadOnly(srcPath, dstPath, srcBoundary, guard);
    } else if (stat.isFile()) {
      if (sameNode(stat, secrets)) continue; // a hard link to plugin-secrets.json
      const data = readFileReadOnly(srcPath);
      if (data !== null) writeBytesAtomic(dstPath, data, guard);
    }
  }
}

export function copyIfMissing(srcFile: string, dstFile: string, guard: WriteGuard): void {
  if (existsSync(dstFile)) return;
  const data = readFileReadOnly(srcFile);
  if (data !== null) {
    guard(dstFile);
    mkdirSync(dirname(dstFile), { recursive: true });
    writeBytesAtomic(dstFile, data, guard);
  }
}
