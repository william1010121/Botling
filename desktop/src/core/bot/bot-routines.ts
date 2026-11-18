// BotRoutines (M7-S42): a bot's routines. `routines.cron`, the app-owned schedules (`scheduled-routines.json`), when each cron
// job last ran, its watch routines and their last runs; the clock's look (`checkRoutines`), what the app shows
// (`routinesView`), the app's own changes (`changeRoutine`, `routinesTool`) and what runs when a routine's time comes.
// It owns the eight fields below; `Bot` keeps a one-line delegate for every method and accessor of this class.
// The bridge block follows the convention of `context.ts` (M7-S41): one forwarder per name borrowed from `Bot`.
import { dirname, join } from "node:path";
import { ContractError, type ResultOf, type RoutineView } from "../../contract";
import type { Bot } from "../bot";
import type { Engine } from "../heads";
import {
  appRoutinesCall, CronSchedule, DAILY_SUMMARY, RoutineFile, routine, ScheduledRoutineStore, dueTime, fromRoutineRuns, legacyRoutineLines, routineDivider, routinePrompt,
  routineStatus, routineTitle, routinesSpecState, scheduledRoutine, type Routine, type ScheduledRoutine,
} from "../routines";
import { fromRoutineLast, type LastRun } from "../routine-last";
import { fromRoutineWatches, nextWatchState, runWatch, watchCommand, watchPrompt, type WatchState } from "../routine-watch";
import { specTrace } from "../spec-trace";
import { fromSwiftDate as fromSwiftDateMs, newId, toSwiftDate, type ChatRecord } from "../store/records";
import type { BotStore } from "../store/bot-store";
import type { BotContext } from "./context";
import type { BotOptions } from "./types";
import { clip, iso, routinesKey } from "./view-functions";

export class BotRoutines {
  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: the names borrowed from `Bot` (one line each) ----
  private get options(): BotOptions { return this.ctx.options; }
  private get store(): BotStore { return this.ctx.store; }
  private get engine(): Engine { return this.ctx.engine; }
  private get owner(): Bot { return this.ctx.owner; }
  private get id() { return this.ctx.id; }
  private get profile() { return this.ctx.profile; }
  private get paths() { return this.ctx.paths; }
  private log(line: string) { this.ctx.log(line); }
  private get readOnly() { return this.host.readOnly; }
  private get problem() { return this.host.problem; }
  private get shuttingDown() { return this.host.shuttingDown; }
  private notice(text: string) { this.host.notice(text); }
  private add(record: ChatRecord) { this.host.add(record); }
  private deliverTo(...args: Parameters<Bot["deliverTo"]>) { return this.host.deliverTo(...args); }

  // ---- Moved from `Bot`: the fields it owns ----

  /** Its routines (the primary's): routines.cron, the app-owned schedules, when each cron job last ran. */
  private routineFile: RoutineFile | null = null;
  scheduledStore: ScheduledRoutineStore | null = null;
  private routineRuns: Record<string, number> = {};
  /** Its watch routines' last runs (bot.json `routineWatches`, by routine id as the view gives it), and those running now. */
  private routineWatches: Record<string, WatchState> = {};
  /** When each prompt routine last ran, kept when it runs (bot.json `routineLast`, by routine id as the view gives it); a watch keeps its own. */
  private routineLast: Record<string, LastRun> = {};
  private watchesRunning = new Set<string>();
  private routineError: string | null = null;
  /** The error the clock last told in the chat: any read of the routines sets `routineError`, so it cannot be what says the notice was given. */
  private routineTold: string | null = null;
  /** What the app last showed of its routines (`routinesKey`), so a change to the files is shown once. */
  private routinesShown = "";

  /** Any crontab schedule, for plugins (`Bot.addRoutine(cron:task:)`); the same job twice is kept once. */
  addRoutine(cron: string, task: string): boolean {
    if (this.options.primary) return this.options.primary.addRoutine(cron, task);
    const words = task.trim();
    const schedule = CronSchedule.parse(cron);
    if (!schedule || !words || !this.routineFile || this.readOnly || this.profile.problem) return false;
    const specBefore = this.routinesSpec();
    if (!this.routineFile.load().some((job) => job.schedule.text === schedule.text && job.task === words)) this.routineFile.add(routine(schedule, words));
    if (specBefore) specTrace("routines", "AddLegacy", { bot: this.id, cron, task: words, before: specBefore, after: this.routinesSpec() });
    this.routinesChanged();
    return true;
  }

  /** routines.cron (made with the old bot.json routines, or the main bot's daily summary) and scheduled-routines.json beside it. */
  setUpRoutines() {
    const file = join(this.profile.folder, this.paths.routines);
    this.routineFile = new RoutineFile(file);
    this.scheduledStore = new ScheduledRoutineStore(join(dirname(file), "scheduled-routines.json"));
    const settings = this.store.loadSettings();
    this.routineRuns = fromRoutineRuns(settings.routineRuns);
    this.routineWatches = fromRoutineWatches(settings.routineWatches);
    this.routineLast = fromRoutineLast(settings.routineLast);
    if (!this.readOnly && !this.profile.problem) {
      try {
        this.routineFile.create(legacyRoutineLines(settings.routines) ?? (this.profile.role === "main" ? [DAILY_SUMMARY] : []));
      } catch (error) {
        this.log(`routines.cron could not be made: ${(error as Error).message}`);
      }
    }
    // A snapshot from now on carries these, so the clock's first look tells only a change. A deferred
    // startup may have served one before they were read: then that first look tells them. Reading them
    // here must not take the clock's notice of a broken schedule file away.
    if (!this.options.deferStartup) {
      const error = this.routineError;
      this.routinesShown = routinesKey(this.routinesView());
      this.routineError = error;
    }
    const spec = this.routinesSpec();
    if (spec) specTrace("routines", "Boot", { bot: this.id, after: spec });
  }

  /** Its routines for spec/models/routines' trace lines (null unless BOTLING_SPEC_TRACE is set). */
  routinesSpec() {
    return routinesSpecState(this.routineFile, this.routineRuns, this.scheduledStore);
  }

  /** The store Codex's `app_routines` uses (null for a partner: its primary's). */
  get routineStorePath(): string | null {
    return (this.owner.routines.scheduledStore ?? null)?.file ?? null;
  }

  loadRoutines(): { jobs: Routine[]; scheduled: ScheduledRoutine[] } {
    const jobs = this.routineFile?.load() ?? [];
    let scheduled: ScheduledRoutine[] = [];
    try {
      scheduled = this.scheduledStore?.load() ?? [];
      this.routineError = null;
    } catch (error) {
      this.routineError = (error as Error).message;
    }
    return { jobs, scheduled };
  }

  /** What the app shows of its routines. */
  routinesView(now = Date.now()): ResultOf<"routines.list"> {
    if (this.options.primary) return this.options.primary.routines.routinesView(now);
    const { jobs, scheduled } = this.loadRoutines();
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const views: RoutineView[] = scheduled.slice(-150).map((job) => {
      const schedule = job.kind === "once" ? iso(fromSwiftDateMs(job.at ?? 0))! : CronSchedule.parse(job.cron ?? "")?.description ?? job.cron ?? "";
      const status = routineStatus(job, now);
      let next: number | null = null;
      if (job.state === "pending") {
        if (job.kind === "once") next = fromSwiftDateMs(job.at ?? 0);
        else next = dueTime(job, now) ?? CronSchedule.parse(job.cron ?? "")?.nextTime(now, job.timezone) ?? null;
      }
      // A run from before the app kept its own record: a scheduled routine still says when it was last handed to the bot.
      const dispatched = job.dispatchedAt === undefined ? null : fromSwiftDateMs(job.dispatchedAt);
      return { id: job.id, kind: job.kind, task: clip(job.task, 2_000) ?? "", title: clip(routineTitle(job.task), 400) ?? "", schedule: clip(schedule, 400) ?? "", cron: job.kind === "once" ? null : clip(job.cron ?? "", 400) ?? null, timezone: job.timezone.slice(0, 100), status, next: iso(next), ...this.lastView(job.id, job.task, dispatched), ...this.watchView(job.id, job.task) };
    });
    for (const job of jobs.slice(0, 50)) {
      views.push({
        id: `cron:${job.id}`.slice(0, 2_200), kind: "legacy", task: clip(job.task, 2_000) ?? "", title: clip(routineTitle(job.task), 400) ?? "",
        schedule: job.once ? "Once, at the next check" : clip(job.schedule.description, 400) ?? "", cron: job.once ? "@once" : clip(job.schedule.text, 400) ?? null, timezone: "system_local", status: job.enabled ? "enabled" : "paused",
        next: job.enabled ? iso(job.once ? now : job.schedule.nextTime(now, null)) : null, ...this.lastView(`cron:${job.id}`.slice(0, 2_200), job.task, null), ...this.watchView(`cron:${job.id}`.slice(0, 2_200), job.task),
      });
    }
    return { routines: views, error: this.routineError?.slice(0, 2_000) ?? null };
  }

  /** When a routine last ran and how that went, for its row: a watch's own last run, else when its prompt was last handed to the bot (`fallback`: a time the schedule file kept). */
  lastView(key: string, task: string, fallback: number | null): Pick<RoutineView, "lastRun" | "lastResult"> {
    if (watchCommand(task)) {
      const state = this.routineWatches[key];
      return state ? { lastRun: new Date(state.lastRun).toISOString(), lastResult: state.ok ? "ok" : "failed" } : { lastRun: null, lastResult: null };
    }
    const last = Object.hasOwn(this.routineLast, key) ? this.routineLast[key]! : fallback === null ? null : { at: fallback, result: "sent" as const };
    return last ? { lastRun: new Date(last.at).toISOString(), lastResult: last.result } : { lastRun: null, lastResult: null };
  }

  /** A watch routine's command and last run, for its row; nothing for a prompt routine. */
  watchView(key: string, task: string): Pick<RoutineView, "watch"> {
    const command = watchCommand(task);
    if (!command) return {};
    const state = this.routineWatches[key];
    return { watch: { command: clip(command, 2_000) ?? "", state: !state ? "never" : state.ok ? "ok" : "failing", lastRun: state ? new Date(state.lastRun).toISOString() : null, exit: state?.exit ?? null, timedOut: state?.timedOut ?? false } };
  }

  routinesChanged(view = this.routinesView()) {
    this.routinesShown = routinesKey(view);
    this.options.emit({ type: "routines.updated", botId: this.id, ...view });
  }

  /** The app's own change to a routine (`app_routines`' operations); errors are the store's, as Codex sees them. */
  changeRoutine(args: Record<string, unknown>): ResultOf<"routines.change"> {
    if (this.options.primary) return this.options.primary.changeRoutine(args);
    if (!this.scheduledStore || this.readOnly) throw new ContractError("conflict", this.problem ?? "This bot's routines cannot be changed here.");
    const specBefore = this.routinesSpec();
    try {
      this.scheduledStore.perform(args);
    } catch (error) {
      throw new ContractError("bad_request", (error as Error).message);
    }
    if (specBefore) specTrace("routines", String(args.operation).replace(/^./, (c) => c.toUpperCase()), { bot: this.id, args, before: specBefore, after: this.routinesSpec() });
    this.routinesChanged();
    return this.routinesView();
  }

  /** Codex changed its routines through `app_routines`: the app's view follows. */
  routinesEdited() {
    this.owner.routines.routinesChanged();
  }

  /**
   * A Claude or Antigravity head's `app_routines` (its botling MCP server): the same store and words as Codex's
   * (codex.ts `routinesTool`); a failure is thrown, so the model reads it as the tool's error.
   */
  routinesTool(args: Record<string, unknown>): Record<string, unknown> {
    const { payload, success } = appRoutinesCall(this.routineStorePath, args);
    if (!success) throw new Error(String(payload.error));
    if (args.operation !== "list") this.routinesEdited();
    return payload;
  }

  /** `isDue`: its latest time today has passed and it has not run since; a job seen for the first time starts from now. */
  isDue(job: Routine, now: number): boolean {
    if (!job.enabled) return false;
    // A one-shot line runs at the first check that sees it (it is taken out of the file before it runs).
    if (job.once) return true;
    const last = this.routineRuns[job.id];
    if (last === undefined) {
      this.routineRuns[job.id] = toSwiftDate(now);
      this.saveRoutineRuns();
      return false;
    }
    const time = job.schedule.lastTimeToday(now, null);
    return time !== null && last < toSwiftDate(time);
  }

  saveRoutineRuns() {
    if (!this.readOnly) this.store.saveSetting("routineRuns", this.routineRuns);
  }

  /**
   * The core's clock (every 15 s; 1.x's `Workspace.checkRoutines` every 30 s): routines.cron jobs that are due run;
   * app-owned schedules are claimed (written before dispatch) and run. Nothing runs while the bot is
   * read-only here or its folder is gone.
   */
  checkRoutines(now = Date.now()) {
    if (this.options.primary || this.shuttingDown || this.readOnly || this.problem || this.profile.problem || !this.routineFile) return;
    const before = this.routineError;
    const specBefore = this.routinesSpec();
    const { jobs, scheduled } = this.loadRoutines();
    let ran = false;
    let noticed = false;
    for (const job of jobs) {
      if (!this.isDue(job, now)) continue;
      if (job.once) {
        // Out of the file first: a line that is already gone (taken by an earlier check) never runs twice.
        let taken = false;
        try { taken = this.routineFile.takeOnce(job.id); } catch (error) { this.log(`routine ${job.id}: ${(error as Error).message}`); }
        if (!taken) continue;
        this.runRoutine(`cron:${job.id}`.slice(0, 2_200), job, now);
        ran = true;
        continue;
      }
      this.routineRuns[job.id] = toSwiftDate(now);
      this.saveRoutineRuns();
      this.runRoutine(`cron:${job.id}`.slice(0, 2_200), job, now);
      ran = true;
    }
    for (const job of scheduled) {
      if (dueTime(job, now) === null) continue;
      try {
        const claimed = this.scheduledStore!.claim(job.id, now);
        if (!claimed) continue;
        this.runRoutine(job.id, scheduledRoutine(claimed), now);
        this.scheduledStore!.didDispatch(job.id, now);
      } catch (error) {
        this.routineError = (error as Error).message;
        this.log(`routine ${job.id}: ${this.routineError}`);
      }
      ran = true;
    }
    this.forgetWatches(jobs, scheduled);
    if (this.routineError && this.routineError !== this.routineTold) { this.notice(`Routines: ${this.routineError}`); noticed = true; }
    this.routineTold = this.routineError;
    if (specBefore) specTrace("routines", "Check", { bot: this.id, now, noticed, before: specBefore, after: this.routinesSpec() });
    // A job the bot wrote into routines.cron (or Codex's app_routines) shows in its chat without waiting for it to run.
    const view = this.routinesView(now);
    if (ran || this.routineError !== before || routinesKey(view) !== this.routinesShown) this.routinesChanged(view);
  }

  /** A routine whose time came: a watch's command runs in the app (the bot is woken only when it fails); any other is dispatched. */
  runRoutine(key: string, job: Routine, now: number) {
    const command = watchCommand(job.task);
    if (command) this.startWatch(key, job, command);
    else {
      this.dispatchRoutine(job, now);
      this.routineLast[key] = { at: now, result: "sent" };
      if (!this.readOnly) this.store.saveSetting("routineLast", this.routineLast);
    }
  }

  /**
   * Runs a watch's command in the bot's folder, without waking it (routine-watch.ts). A failure wakes it once per
   * failing streak (`nextWatchState`); a run still going when its next time comes is not started twice.
   */
  startWatch(key: string, job: Routine, command: string) {
    if (this.watchesRunning.has(key)) return;
    this.watchesRunning.add(key);
    const title = routineTitle(job.task);
    this.log(`watch "${title}" runs`);
    // Its group is in the process ledger while it runs: a start after the app died ends it (no run beside it).
    void runWatch(command, this.profile.folder, undefined, (pid, alive) => (alive ? this.options.ledger.record(pid) : this.options.ledger.forget(pid))).then((result) => {
      this.watchesRunning.delete(key);
      if (this.shuttingDown || this.readOnly) return;
      const { state, wake } = nextWatchState(this.routineWatches[key], result);
      this.routineWatches[key] = state;
      this.store.saveSetting("routineWatches", this.routineWatches);
      if (wake) {
        this.log(`watch "${title}" failed: the bot is woken`);
        this.add({ id: newId(), role: "divider", text: routineDivider(job, result.ranAt), date: toSwiftDate(result.ranAt) });
        this.deliverTo(this.engine, watchPrompt(title, command, result, state.failingSince), null, { origin: "app", routine: true });
      }
      this.routinesChanged();
    }, (error) => {
      this.watchesRunning.delete(key);
      this.log(`watch "${title}": ${(error as Error).message}`);
    });
  }

  /** Drops what it kept of watches that are gone (not while the schedules cannot be read). */
  forgetWatches(jobs: Routine[], scheduled: ScheduledRoutine[]) {
    if (this.routineError) return;
    const live = new Set([...jobs.map((job) => `cron:${job.id}`.slice(0, 2_200)), ...scheduled.map((job) => job.id)]);
    const gone = Object.keys(this.routineWatches).filter((key) => !live.has(key) && !this.watchesRunning.has(key));
    if (gone.length) {
      for (const key of gone) delete this.routineWatches[key];
      if (!this.readOnly) this.store.saveSetting("routineWatches", this.routineWatches);
    }
    // A routine that is gone (a one-time `cron:` line leaves the file as it runs) loses its last-run record at the next look.
    const lost = Object.keys(this.routineLast).filter((key) => !live.has(key));
    if (lost.length) {
      for (const key of lost) delete this.routineLast[key];
      if (!this.readOnly) this.store.saveSetting("routineLast", this.routineLast);
    }
  }

  /** A divider with its time, then its prompt as a message nobody typed, to this bot's (first) head (`Bot.run`). */
  dispatchRoutine(job: Routine, now: number) {
    this.add({ id: newId(), role: "divider", text: routineDivider(job, now), date: toSwiftDate(now) });
    const prompt = routinePrompt(job, this.profile.role, () => this.options.projectBriefing?.() ?? "");
    this.log(`routine "${routineTitle(job.task)}" runs`);
    this.deliverTo(this.engine, prompt, null, { origin: "app", routine: true });
  }
}
