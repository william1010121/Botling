// The only door spec/tests/routines.spec.test.ts uses into the app's routines: one method per action of
// spec/models/routines/Routines.tla, and an observation in spec/reference/routines.ts's `View` vocabulary.
// Times are the model's minutes; jobs are the model's slots (their task starts with the slot name).
import type { Bot, Job, View } from "../reference/routines";

export interface RoutinesWorld {
  /** Bot ids; the first is a project bot, every other one a sub bot of it (with .bot/sub-bots/<id>/). */
  bots: Bot[];
  /** The minutes recurring and legacy jobs run at. */
  cron: number[];
  /** Sets the app's wall clock (the test owns time); called with milliseconds. */
  setClock(ms: number): void;
}

export interface RoutinesSession {
  /** One minute passes, whether or not the app runs. */
  tick(): void;
  /** The app dies at once: nothing is shut down or saved beyond what was already written. */
  crash(): void;
  /** The app starts: every bot reads its routines. */
  boot(): void;
  /** Its scheduled-routines.json becomes unreadable (the bytes are kept aside for `mend`). */
  break(bot: Bot): void;
  /** Its scheduled-routines.json gets back what it held before `break`. */
  mend(bot: Bot): void;
  /** The app shows the bot's chat (its snapshot carries the routines). */
  view(bot: Bot): void;
  /** The clock's look at one bot. */
  check(bot: Bot): void;
  /** The store writes the job's claim, then the app dies before dispatching it. */
  claimThenCrash(job: Job): void;
  /** app_routines create (refusals are swallowed: a refused change changes nothing). */
  create(job: Job, args: { req: string; kind: "once" | "recurring"; bot: Bot; at: number }): void;
  /** A new line in the bot's routines.cron. */
  addLegacy(job: Job, bot: Bot): void;
  pause(job: Job): void;
  resume(job: Job): void;
  cancel(job: Job): void;
  observe(): View;
  /** The model minute of an app time in milliseconds (to read trace lines). */
  minute(ms: number): number;
  close(): Promise<void>;
}

export interface RoutinesDriver {
  open(world: RoutinesWorld): RoutinesSession;
}
