// Breaking a stale data-folder lock while other cores claim it (spec/models/datalock, TLC's counterexample for
// DataLock_bug_restore.cfg). 7be956c7 broke a lock by renaming core.lock aside and linking it back when it turned out
// to be a fresh one; between the two the name was free, a fourth core took it, and two cores wrote the folder.
// The file system is wrapped so other cores can act between any two operations of the breaking core.
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../helpers";

const hook = vi.hoisted(() => ({ on: null as ((call: { name: string; error?: string }) => void) | null }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const wrap = <F extends (...args: any[]) => any>(name: string, fn: F) => ((...args: Parameters<F>) => {
    try {
      const result = fn(...args);
      hook.on?.({ name });
      return result;
    } catch (error) {
      hook.on?.({ name, error: (error as NodeJS.ErrnoException).code });
      throw error;
    }
  }) as F;
  const names = ["linkSync", "renameSync", "unlinkSync", "rmdirSync", "readFileSync", "readdirSync", "mkdirSync", "writeFileSync", "rmSync", "statSync"] as const;
  return { ...fs, ...Object.fromEntries(names.map((name) => [name, wrap(name, fs[name] as (...args: any[]) => any)])) };
});
const { DataDirLock, readLockHolder } = await import("../../src/core/store/data-dir-lock");

afterEach(() => { hook.on = null; });

describe("breaking a stale lock", () => {
  it("never lets two cores hold the folder (a holder exits, three cores claim)", () => {
    const dir = tempDir("lock-race");
    const alive = new Set([1, 2, 3, 4]);
    const lockIn = (pid: number, boot: string) => new DataDirLock(dir, { pid, boot, alive: (p) => alive.has(p), startTime: () => null, machineBoot: () => 1_000_000 });
    const x = lockIn(1, "x"), b = lockIn(2, "b"), c = lockIn(3, "c"), e = lockIn(4, "e");
    expect(x.claim()).toEqual({ ok: true });

    // While b claims: once its first attempt is refused (x holds), x exits; right after b reads the holder (none),
    // c claims; right after b's next change to the folder (breaking what it judged), e claims.
    const got: Record<string, boolean> = {};
    let phase = 0;
    hook.on = (call) => {
      const write = ["linkSync", "renameSync", "unlinkSync", "rmdirSync"].includes(call.name);
      const read = ["readFileSync", "readdirSync"].includes(call.name);
      const at = phase;
      if (at === 0 && write && (call.error === "EEXIST" || call.error === "ENOTEMPTY")) phase = 1;
      else if (at === 1 && read) phase = 2;
      else if (at === 2 && write) phase = 3;
      else return;
      const on = hook.on;
      hook.on = null;
      if (at === 0) { x.release(); alive.delete(1); }
      if (at === 1) got.c = c.claim().ok;
      if (at === 2) got.e = e.claim().ok;
      hook.on = on;
    };
    got.b = b.claim().ok;
    hook.on = null;

    expect(phase).toBe(3);
    const holders = Object.keys(got).filter((name) => got[name]);
    expect(holders).toHaveLength(1);
    expect(readLockHolder(dir)?.boot).toBe(holders[0]);
    // Only the holder still owns it.
    for (const [name, lock] of Object.entries({ b, c, e })) expect(lock.owns(), name).toBe(name === holders[0]);
  });
});
