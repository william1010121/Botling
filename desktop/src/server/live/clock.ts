// The time source of the live channel. Injected so tests drive frames and checkpoints with a fake clock and never sleep.

export type TimerHandle = { readonly __timer: unique symbol } | object;

export interface Clock {
  /** Milliseconds; only differences matter, except for `bots.liveAt`, which stores the value as given. */
  now(): number;
  setTimeout(run: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => {
    const timer = setTimeout(run, ms);
    timer.unref?.(); // a pending frame or checkpoint never keeps botlingd alive by itself
    return timer as unknown as TimerHandle;
  },
  clearTimeout: (handle) => clearTimeout(handle as unknown as ReturnType<typeof setTimeout>),
};
