// The one door spec tests use into the app's watch routines (spec/models/routines/RoutineWatch.tla): one method per
// action, and an observation in spec/reference/routine-watch.ts's `View` vocabulary. One project bot with one watch;
// a tick of the model is one occurrence of the watch's schedule (the test owns the clock, see `setClock`).
import type { Result, View } from "../reference/routine-watch";

export interface RoutineWatchWorld {
  /** How the watch is written: app_routines kind=watch (scheduled-routines.json) or a "Name: !command" line in routines.cron. */
  form: "scheduled" | "legacy";
  /** Milliseconds of one tick (the model's Rewake ticks are the app's 6 hours). */
  tickMs: number;
  /** Sets the app's wall clock (the test owns time); called with milliseconds. */
  setClock(ms: number): void;
}

export interface RoutineWatchSession {
  /** The clock moves to the next occurrence. */
  tick(): Promise<void>;
  /** The clock's check: the watch's time has come. */
  due(): Promise<void>;
  /** The command the app runs ends: it passes (exit 0) or fails (exit 1); resolves once the app has taken it. */
  finish(r: Result): Promise<void>;
  /** A command an earlier app life started ends by itself. */
  orphanEnds(): Promise<void>;
  /** The app dies: what is under way is lost to it, the processes it started live on. */
  crash(): Promise<void>;
  /** The app starts (the core's start, then the bot's). */
  boot(): Promise<void>;
  view(): View;
  close(): Promise<void>;
}

export interface RoutineWatchDriver {
  open(world: RoutineWatchWorld): Promise<RoutineWatchSession>;
}
