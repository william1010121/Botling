// spec/driver/datalock-driver.ts against the real DataDirLock: one per core, all on `<root>/data`, each with its
// own pid and boot (the core's name). Which pids run, and when they started, is kept here: a killed core's pid
// is not running until it is reused, and then by a process started an hour after any record was written.
// A core killed in the middle of a call stops at its next step (its onStep throws).
import { cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DataLockDriver, DataLockDriverOptions, DataLockEvent, DataLockOutcome } from "../../spec/driver/datalock-driver";
import { DataDirLock, LOCK_DIR, readLockHolder } from "../src/core/store/data-dir-lock";

class Killed extends Error {}

export function datalockDriver({ cores, maxSwap, root }: DataLockDriverOptions): DataLockDriver {
  const data = join(root, "data");
  /** Where folder `f` is once it was swapped out. */
  const aside = (f: number) => join(root, `data.${f}`);
  const pids = new Map(cores.map((core, i) => [core, 1_000 + i] as const));
  const dead = new Set<string>();
  const reused = new Set<number>();
  const locks = new Map<string, DataDirLock>();
  let listener: ((event: DataLockEvent) => void) | null = null;
  let gen = 0;
  mkdirSync(data, { recursive: true });

  const coreOf = (pid: number) => cores.find((core) => pids.get(core) === pid);
  const lockOf = (core: string) => {
    let lock = locks.get(core);
    if (!lock) {
      lock = new DataDirLock(data, {
        pid: pids.get(core)!, boot: core, machineBoot: () => 1_000_000,
        alive: (pid) => reused.has(pid) || (coreOf(pid) !== undefined && !dead.has(coreOf(pid)!)),
        startTime: (pid) => (reused.has(pid) ? Date.now() + 3_600_000 : null),
        onStep: (step) => {
          if (dead.has(core)) throw new Killed();
          listener?.({ core, step });
          if (dead.has(core)) throw new Killed();
        },
      });
      locks.set(core, lock);
    }
    return lock;
  };
  const run = (core: string, call: () => DataLockOutcome): DataLockOutcome => {
    try {
      return call();
    } catch (error) {
      if (error instanceof Killed) return "dead";
      throw error;
    }
  };
  const claim = (core: string) => run(core, () => (lockOf(core).claim().ok ? "writing" : "wait"));

  return {
    onStep(next) { listener = next; },
    start: claim,
    retry: claim,
    check: (core) => run(core, () => (lockOf(core).owns() ? "writing" : "exit")),
    leave(core) {
      run(core, () => { lockOf(core).release(); return "dead"; });
      dead.add(core);
    },
    crash(core) { dead.add(core); },
    reuse(core) { reused.add(pids.get(core)!); },
    swap(copy) {
      renameSync(data, aside(gen));
      mkdirSync(data);
      if (copy && existsSync(join(aside(gen), LOCK_DIR))) cpSync(join(aside(gen), LOCK_DIR), join(data, LOCK_DIR), { recursive: true });
      gen++;
    },
    observe() {
      const holderOf = (dir: string) => readLockHolder(dir)?.boot ?? null;
      return { gen, lock: Array.from({ length: maxSwap + 1 }, (_, f) => (f > gen ? null : holderOf(f === gen ? data : aside(f)))) };
    },
  };
}
