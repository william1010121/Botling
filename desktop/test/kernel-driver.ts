// Test tools for the plugin kernel (Web/src/plugin-kernel): a seeded random source, a hand-driven clock for the undo time
// limit, promises the test settles itself, and a flush that lets every queued promise reaction run.
import type { KernelTimers } from "../../Web/src/plugin-kernel";

/** mulberry32: the same seed gives the same numbers on every machine. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (below: number) => Math.floor(next() * below),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    chance: (p: number) => next() < p,
  };
}

/** A clock the test moves (`advance`); the kernel's undo time limit runs on it. */
export function manualTimers(): KernelTimers & { now: number; advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const queue = new Map<number, { at: number; run: () => void }>();
  return {
    get now() { return now; },
    set: (run, ms) => { const id = next++; queue.set(id, { at: now + ms, run }); return id; },
    clear: (handle) => { queue.delete(handle as number); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
    pending: () => queue.size,
  };
}

/** A promise and the hands that settle it. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Lets every promise reaction queued so far (and those they queue) run. */
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
