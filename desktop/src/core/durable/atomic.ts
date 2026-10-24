// Atomic JSON files and a cross-process lock, in portable Node (no flock, no native addon).
//
// Write: a temp file next to the target, fsync, rename over the target, fsync the folder. A crash
// at any point leaves either the old file or the new one, never half of one. (On Windows rename
// over an open file can fail with EPERM/EBUSY when another process — often an antivirus scanner —
// has it open; `replaceFile` retries for a short while. Unverified on Windows.)
//
// Lock: `<file>.lock` created with O_EXCL holding {pid, boot, at}. A lock whose holder process is
// gone is stale and is broken. A lock held longer than `staleMs` by a live pid is also broken,
// since no transaction here takes that long; pids can be reused, so `boot` identifies the run.
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";

export const BOOT_ID = `${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;

function fsyncDir(dir: string) {
  if (process.platform === "win32") return; // Directories cannot be opened for fsync on Windows.
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* best effort */ }
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeFileAtomic(file: string, text: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    replaceFile(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  fsyncDir(dir);
}

function replaceFile(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < 20 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        sleepSync(25 + attempt * 10);
        continue;
      }
      throw error;
    }
  }
}

interface LockOwner { pid: number; boot: string; at: number }

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class LockTimeout extends Error {}

/** Runs `body` holding `<file>.lock`. Synchronous: transactions are short and must not interleave. */
export function withFileLock<T>(file: string, body: () => T, { timeoutMs = 5_000, staleMs = 10_000 } = {}): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const start = Date.now();
  for (let attempt = 0; ; attempt++) {
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (breakIfStale(lock, staleMs)) continue;
      if (Date.now() - start > timeoutMs) throw new LockTimeout(`Could not lock ${basename(file)} within ${timeoutMs} ms.`);
      sleepSync(Math.min(5 + attempt * 2, 50));
      continue;
    }
    try {
      const owner: LockOwner = { pid: process.pid, boot: BOOT_ID, at: Date.now() };
      writeSync(fd, JSON.stringify(owner));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      return body();
    } finally {
      // Only remove the lock if it is still ours (a stale-breaker may have taken it over).
      try {
        const owner = JSON.parse(readFileSync(lock, "utf8")) as LockOwner;
        if (owner.boot === BOOT_ID) unlinkSync(lock);
      } catch { /* gone already */ }
    }
  }
}

function breakIfStale(lock: string, staleMs: number): boolean {
  const judge = (): { stale: boolean; key: string } | null => {
    let text: string;
    try {
      text = readFileSync(lock, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; // Released meanwhile.
      throw error;
    }
    try {
      const owner = JSON.parse(text) as LockOwner;
      return { stale: !pidAlive(owner.pid) || Date.now() - owner.at > staleMs, key: text };
    } catch {
      // Created but not written yet (or its creator died in between): stale once it is old.
      let age = 0;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { return null; }
      return { stale: age > 1_000, key: text };
    }
  };
  const first = judge();
  if (!first) return true;
  if (!first.stale) return false;
  // Breaking is serialized by a second lock, so two breakers cannot remove each other's fresh lock.
  const breaker = `${lock}.break`;
  let fd: number;
  try {
    fd = openSync(breaker, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      if (Date.now() - statSync(breaker).mtimeMs > staleMs) unlinkSync(breaker);
    } catch { /* gone */ }
    return false;
  }
  closeSync(fd);
  try {
    const again = judge();
    if (!again) return true;
    if (again.stale && again.key === first.key) unlinkSync(lock);
    return true;
  } finally {
    rmSync(breaker, { force: true });
  }
}
