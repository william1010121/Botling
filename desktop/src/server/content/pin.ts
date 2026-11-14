// Pinned versions (protocol v1 §9A.3): a line never shows newer bytes than it was posted with.
//
// | where the file is          | how the version is kept                                   |
// | APFS (the Mac)             | `clonefile` into the content store (copy-on-write)        |
// | ≤ 64 MiB, elsewhere        | a copy in the content store                               |
// | > 64 MiB, elsewhere        | `pin: path`: the path and its stat signature (size, mtime |
// |                            | in ns, inode); chunk hashes once hashed                   |
//
// Pins are made when the line finishes, before its entry commits, as `<data>/content/pins/<hex>` (a new random name per
// pin, never renamed and never rewritten). A pin file that no content row names (a crash between the pin and the
// commit, or a pin whose bytes were already stored) is removed by `sweepPins` at start.
import { execFile } from "node:child_process";
import { constants, copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, statfsSync, statSync } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/** `statfs.f_type` of APFS. */
const APFS_TYPE = 0x1a;

/** Same as 2.x `LINE_MEDIA_MAX_BYTES` (core/chat-media.ts): above this a file that cannot be cloned is pinned by path. */
export const COPY_MAX_BYTES = 64 * 1024 * 1024;

export type PinKind = "clone" | "copy" | "path";

export interface StatSig { size: number; mtimeNs: string; ino: string }

export interface Pin {
  /** `pending:<hex>` until hashed; `hex` also names the pin file. */
  pendingId: string;
  pin: PinKind;
  /** What is served: the pin file (clone, copy) or the source itself (path). */
  file: string;
  /** The source's real path. */
  source: string;
  /** Of `file`, when the pin was made. */
  sig: StatSig;
  size: number;
}

export interface PinOptions {
  /** Tests: force a pin kind ("path" never copies; "copy" skips the clone; "clone" fails rather than copy). */
  force?: PinKind;
  copyMaxBytes?: number;
}

export function statSig(path: string): StatSig {
  const stat = statSync(path, { bigint: true });
  return { size: Number(stat.size), mtimeNs: String(stat.mtimeNs), ino: String(stat.ino) };
}

export function sameSig(a: StatSig | null | undefined, b: StatSig | null | undefined): boolean {
  return !!a && !!b && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ino === b.ino;
}

export function pinsDir(dataDir: string): string {
  return join(dataDir, "content", "pins");
}

export function newPendingHex(): string {
  return randomBytes(16).toString("hex");
}

/** Keeps the version of `sourcePath` as it is now. Throws when the source is not a readable regular file. */
export async function pinFile(sourcePath: string, dir: string, options: PinOptions = {}): Promise<Pin> {
  const source = realpathSync(sourcePath);
  const before = statSync(source);
  if (!before.isFile()) throw new Error("not a regular file");
  mkdirSync(dir, { recursive: true });
  const hex = newPendingHex();
  const pendingId = `pending:${hex}`;
  const file = join(dir, hex);
  if (options.force !== "path" && options.force !== "copy") {
    try {
      if (!(await cloneFile(source, file))) throw new Error("this file cannot be cloned here");
      const sig = statSig(file);
      return { pendingId, pin: "clone", file, source, sig, size: sig.size };
    } catch (error) {
      rmSync(file, { force: true });
      if (options.force === "clone") throw error;
    }
  }
  if (options.force !== "path" && before.size <= (options.copyMaxBytes ?? COPY_MAX_BYTES)) {
    const partial = `${file}.partial`;
    try {
      await copyFile(source, partial);
      await rename(partial, file);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    const sig = statSig(file);
    return { pendingId, pin: "copy", file, source, sig, size: sig.size };
  }
  const sig = statSig(source);
  return { pendingId, pin: "path", file: source, source, sig, size: sig.size };
}

/**
 * A copy-on-write clone of `source` at `file`; false when it cannot be one (then nothing was written).
 * - macOS: clonefile(2) works only within one APFS volume. Node's COPYFILE_FICLONE_FORCE answers ENOSYS there and
 *   COPYFILE_FICLONE silently copies every byte (measured: 200 MB in 9.5 s on a busy Mac), so the clone is made by
 *   `/bin/cp -c` (clonefile(2), ≈ 9 ms for the same file) after checking that both sides are on the same APFS volume
 *   (elsewhere `cp -c` would fall back to a full copy).
 * - Other systems: COPYFILE_FICLONE_FORCE (FICLONE on Linux btrfs/xfs), which fails rather than copy.
 */
export async function cloneFile(source: string, file: string): Promise<boolean> {
  if (process.platform === "darwin") {
    try {
      if (statSync(source).dev !== statSync(dirname(file)).dev) return false;
      if (statfsSync(source).type !== APFS_TYPE) return false;
    } catch { return false; }
    await execFileAsync("/bin/cp", ["-c", source, file]);
    return true;
  }
  try {
    copyFileSync(source, file, constants.COPYFILE_FICLONE_FORCE);
    return true;
  } catch {
    rmSync(file, { force: true });
    return false;
  }
}

/** Removes pin files that `keep` does not name (and `.partial` leftovers). Run at start, before any pin is made. */
export function sweepPins(dir: string, keep: ReadonlySet<string>): number {
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const file = join(dir, name);
    if (keep.has(file)) continue;
    try { rmSync(file, { force: true }); removed += 1; } catch { /* left for the next start */ }
  }
  return removed;
}
