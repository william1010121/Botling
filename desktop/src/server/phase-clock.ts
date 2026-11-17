// Where the time goes when botlingd starts and stops. An install restarts the app, and what the user waits for is these
// phases one after another; until now the log named none of them, so a slow restart could not be told apart from a
// stuck one. A phase that took `slowMs` or more is logged with its length (fast ones add no lines, so a normal start and
// stop keep their golden order, test/unit/botlingd-start-order.test.ts). It never changes what a phase does.

export const SLOW_PHASE_MS = 500;
/** Start phases are logged from this length on (startup_perf.py reads them); stop keeps SLOW_PHASE_MS. */
export const START_PHASE_LOG_MS = 100;

export class PhaseClock {
  constructor(
    private readonly log: (line: string) => void,
    private readonly slowMs: number = SLOW_PHASE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Runs `run`, logs `<kind>: <what> took N ms` when slow (also when it throws), and returns or rethrows what it did. */
  async time<T>(kind: "start" | "stop", what: string, run: () => T | Promise<T>): Promise<Awaited<T>> {
    const began = this.now();
    try {
      return await run();
    } finally {
      const took = this.now() - began;
      if (took >= this.slowMs) this.log(`${kind}: ${what} took ${took} ms`);
    }
  }
}

/** How long the network closes at stop may take together before botlingd goes on to stop the core. */
export const NETWORK_STOP_BUDGET_MS = 5_000;

/**
 * Runs a network close (a session, a socket, a peer link) within what is left of a shared budget. When the budget is
 * gone first, the close is left to finish by itself (the process is ending anyway) and the stop goes on, so one link
 * that never answers cannot hold the whole stop (an install waits for it, then the new build waits for the install).
 * Returns whether `run` finished in time; a close that throws throws here, as it did before.
 */
export async function withinBudget(until: number, what: string, run: () => unknown, log: (line: string) => void, now: () => number = Date.now): Promise<boolean> {
  const left = until - now();
  const pending = Promise.resolve().then(run);
  if (left <= 0) {
    // Its sync part has run; do not wait for the rest.
    pending.catch(() => undefined);
    log(`stop: ${what} was not waited for (the network budget was used up)`);
    return false;
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), left); timer.unref?.(); });
  try {
    const result = await Promise.race([pending.then(() => "done" as const), late]);
    if (result === "late") {
      pending.catch(() => undefined);
      log(`stop: ${what} did not finish within the network budget; going on without it`);
      return false;
    }
    return true;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
