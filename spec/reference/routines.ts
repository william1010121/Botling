// The routines model (spec/models/routines/Routines.tla) as a pure TypeScript state machine: the same
// variables and actions, plus two observation logs the TLA+ model leaves out (each dispatch with the time
// it ran and the chat it ran in, and how many broken-file notices each chat has).
// SPEC_BUG=routines turns on c0154c79: the startup read counts as having told a broken file.

export type Bot = string;
export type Job = string;
export type JobState = "none" | "pending" | "paused" | "claimed" | "fired" | "cancelled";
export type Kind = "once" | "recurring" | "legacy";
export type FileState = "ok" | "broken";

export const NONE = -1;

export interface Config {
  jobs: Job[];
  bots: Bot[];
  requests: string[];
  maxTime: number;
  /** The minutes recurring and legacy jobs run at. */
  cron: number[];
  bug?: boolean;
}

export interface JobVars {
  st: JobState;
  kind: Kind | "none";
  owner: Bot | "none";
  at: number;
  since: number;
  last: number;
  req: string;
}

export interface Dispatch { job: Job; at: number; chat: Bot }

export interface State {
  now: number;
  up: boolean;
  jobs: Record<Job, JobVars>;
  /** `${job}@${occurrence}` → dispatches, capped at 2. */
  fires: Record<string, number>;
  file: Record<Bot, FileState>;
  told: Record<Bot, boolean>;
  said: Record<Bot, boolean>;
  looked: Record<Bot, boolean>;
  /** Observation only. */
  log: Dispatch[];
  notices: Record<Bot, number>;
}

export type Action =
  | { type: "Tick" } | { type: "Crash" } | { type: "Boot" }
  | { type: "Break"; bot: Bot } | { type: "Mend"; bot: Bot } | { type: "View"; bot: Bot } | { type: "Check"; bot: Bot }
  | { type: "ClaimThenCrash"; job: Job }
  | { type: "Create"; job: Job; req: string; kind: "once" | "recurring"; bot: Bot; at: number }
  | { type: "AddLegacy"; job: Job; bot: Bot }
  | { type: "Pause"; job: Job } | { type: "Resume"; job: Job } | { type: "Cancel"; job: Job };

export const bugFromEnv = (): boolean => typeof process !== "undefined" && process.env.SPEC_BUG === "routines";

const perBot = <T>(cfg: Config, value: T): Record<Bot, T> => Object.fromEntries(cfg.bots.map((b) => [b, value]));

export function init(cfg: Config): State {
  const fires: Record<string, number> = {};
  for (const j of cfg.jobs) for (let t = 0; t <= cfg.maxTime; t++) fires[`${j}@${t}`] = 0;
  return {
    now: 0, up: false,
    jobs: Object.fromEntries(cfg.jobs.map((j) => [j, { st: "none", kind: "none", owner: "none", at: NONE, since: NONE, last: NONE, req: "none" } as JobVars])),
    fires, file: perBot(cfg, "ok" as FileState), told: perBot(cfg, false), said: perBot(cfg, false), looked: perBot(cfg, false),
    log: [], notices: perBot(cfg, 0),
  };
}

const latest = (cfg: Config, t: number) => cfg.cron.filter((c) => c <= t).reduce((a, c) => Math.max(a, c), NONE);
export function occ(s: State, cfg: Config, j: Job): number {
  const v = s.jobs[j]!;
  if (v.kind === "once") return v.at <= s.now ? v.at : NONE;
  return latest(cfg, s.now);
}
const scheduled = (v: JobVars) => v.kind === "once" || v.kind === "recurring";
const readable = (s: State, v: JobVars) => v.kind === "legacy" || s.file[v.owner] === "ok";
export function due(s: State, cfg: Config, j: Job): boolean {
  const v = s.jobs[j]!;
  const o = occ(s, cfg, j);
  return v.st === "pending" && readable(s, v) && o !== NONE && (v.kind === "once" || (v.since !== NONE && o > Math.max(v.since, v.last)));
}
const mark = (s: State, cfg: Config, j: Job) => (s.jobs[j]!.kind === "legacy" ? s.now : occ(s, cfg, j));
const changeable = (s: State, j: Job) => s.up && s.jobs[j]!.st !== "none" && s.file[s.jobs[j]!.owner] === "ok";

export function enabled(s: State, cfg: Config, a: Action): boolean {
  switch (a.type) {
    case "Tick": return s.now < cfg.maxTime;
    case "Crash": return s.up;
    case "Boot": return !s.up;
    case "Break": return s.file[a.bot] === "ok";
    case "Mend": return s.file[a.bot] === "broken";
    case "View": case "Check": return s.up;
    case "ClaimThenCrash": return s.up && scheduled(s.jobs[a.job]!) && due(s, cfg, a.job);
    case "Create": {
      if (!s.up || s.file[a.bot] !== "ok") return false;
      if (requestTaken(s, a.bot, a.req)) return true;
      return s.jobs[a.job]!.st === "none" && (a.kind === "once" ? a.at > s.now && a.at <= cfg.maxTime : a.at === NONE);
    }
    case "AddLegacy": return s.up && s.jobs[a.job]!.st === "none";
    case "Pause": case "Resume": case "Cancel": return changeable(s, a.job);
  }
}

const requestTaken = (s: State, bot: Bot, req: string) => Object.values(s.jobs).some((v) => v.st !== "none" && v.owner === bot && v.req === req);

const clone = (s: State): State => structuredClone(s);

/** The state after `a`; throws when `a` is not enabled. */
export function step(s: State, cfg: Config, a: Action): State {
  if (!enabled(s, cfg, a)) throw new Error(`routines: ${JSON.stringify(a)} is not enabled`);
  const n = clone(s);
  switch (a.type) {
    case "Tick": n.now++; break;
    case "Crash": n.up = false; break;
    case "Boot":
      n.up = true;
      for (const b of cfg.bots) n.told[b] = (cfg.bug ?? bugFromEnv()) && s.file[b] === "broken";
      break;
    case "Break": n.file[a.bot] = "broken"; break;
    case "Mend": n.file[a.bot] = "ok"; break;
    case "View": break;
    case "Check": {
      const b = a.bot;
      const broken = s.file[b] === "broken";
      if (broken && !s.told[b]) n.notices[b]!++;
      n.said[b] = broken ? s.said[b]! || !s.told[b] : false;
      n.told[b] = broken;
      n.looked[b] = broken;
      for (const j of cfg.jobs) {
        const v = s.jobs[j]!;
        if (v.owner !== b) continue;
        if (v.kind === "legacy" && v.st === "pending" && v.since === NONE) n.jobs[j]!.since = s.now;
        if (!due(s, cfg, j)) continue;
        const o = occ(s, cfg, j);
        n.jobs[j]!.last = mark(s, cfg, j);
        if (v.kind === "once") n.jobs[j]!.st = "fired";
        n.fires[`${j}@${o}`] = Math.min(s.fires[`${j}@${o}`]! + 1, 2);
        n.log.push({ job: j, at: s.now, chat: b });
      }
      break;
    }
    case "ClaimThenCrash":
      n.jobs[a.job]!.st = "claimed";
      n.jobs[a.job]!.last = occ(s, cfg, a.job);
      n.up = false;
      break;
    case "Create":
      if (requestTaken(s, a.bot, a.req)) break;
      n.jobs[a.job] = { st: "pending", kind: a.kind, owner: a.bot, at: a.at, since: s.now, last: NONE, req: a.req };
      break;
    case "AddLegacy":
      n.jobs[a.job] = { st: "pending", kind: "legacy", owner: a.bot, at: NONE, since: NONE, last: NONE, req: "none" };
      break;
    case "Pause": {
      const v = n.jobs[a.job]!;
      if (v.st === "pending" || v.st === "paused") v.st = "paused";
      break;
    }
    case "Resume": {
      const v = n.jobs[a.job]!;
      if (v.st === "paused") {
        v.st = "pending";
        if (scheduled(v)) v.since = s.now;
      }
      break;
    }
    case "Cancel": {
      const v = n.jobs[a.job]!;
      if (v.st === "pending" || v.st === "paused") v.st = "cancelled";
      break;
    }
  }
  return n;
}

/** Every action enabled in `s` (the model's Next). */
export function actions(s: State, cfg: Config): Action[] {
  const all: Action[] = [{ type: "Tick" }, { type: "Crash" }, { type: "Boot" }];
  for (const bot of cfg.bots) all.push({ type: "Break", bot }, { type: "Mend", bot }, { type: "View", bot }, { type: "Check", bot });
  for (const job of cfg.jobs) {
    all.push({ type: "ClaimThenCrash", job }, { type: "Pause", job }, { type: "Resume", job }, { type: "Cancel", job });
    for (const bot of cfg.bots) {
      all.push({ type: "AddLegacy", job, bot });
      for (const req of cfg.requests) {
        all.push({ type: "Create", job, req, kind: "recurring", bot, at: NONE });
        for (let at = s.now + 1; at <= cfg.maxTime; at++) all.push({ type: "Create", job, req, kind: "once", bot, at });
      }
    }
  }
  return all.filter((a) => enabled(s, cfg, a));
}

/** The model's safety invariants; the names of those that do not hold. */
export function violations(s: State, cfg: Config): string[] {
  const out: string[] = [];
  if (Object.values(s.fires).some((n) => n > 1)) out.push("AtMostOncePerDue");
  for (const j of cfg.jobs) {
    const v = s.jobs[j]!;
    if (v.kind === "once" && v.at !== NONE && s.fires[`${j}@${v.at}`]! > 0 && v.st !== "fired") out.push("OnceFiresOnce");
  }
  const made = cfg.jobs.map((j) => s.jobs[j]!).filter((v) => v.st !== "none" && scheduled(v));
  if (new Set(made.map((v) => `${v.owner}/${v.req}`)).size !== made.length) out.push("OneSchedulePerRequest");
  if (cfg.bots.some((b) => s.looked[b] && !s.said[b])) out.push("BrokenIsTold");
  return out;
}

/** The model's action properties for one step. */
export function stepViolations(s: State, n: State, cfg: Config): string[] {
  const out: string[] = [];
  const firesOf = (x: State, j: Job) => Object.entries(x.fires).filter(([k]) => k.startsWith(`${j}@`)).map(([, v]) => v).join();
  for (const j of cfg.jobs) {
    const v = s.jobs[j]!;
    const keptFires = firesOf(s, j) === firesOf(n, j);
    if (["none", "paused", "cancelled", "claimed", "fired"].includes(v.st) && !keptFires) out.push("InactiveNeverFires");
    if (scheduled(v) && s.file[v.owner] === "broken") {
      const w = n.jobs[j]!;
      if (w.st !== v.st || w.since !== v.since || w.last !== v.last || w.req !== v.req || !keptFires) out.push("BrokenKeepsJobs");
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------
// What the app can be seen to hold, in the driver's vocabulary (spec/driver/routines-driver.ts).

export interface JobView { st: JobState; kind: Kind; owner: Bot; at: number; since: number; last: number; req: string }
export interface View {
  now: number;
  up: boolean;
  file: Record<Bot, FileState>;
  /** The jobs each bot's files hold; a broken scheduled-routines.json shows none of its jobs. */
  jobs: Record<Job, JobView>;
  /** Dispatches as (job, minute it ran, chat), sorted. */
  log: string[];
  notices: Record<Bot, number>;
}

/**
 * The abstraction both sides are compared in. routines.cron keeps one time per job (bot.json
 * routineRuns: first seen, then last run), so a legacy job shows since = the later of the two, last = NONE.
 */
export function view(s: State): View {
  const jobs: Record<Job, JobView> = {};
  for (const [j, v] of Object.entries(s.jobs)) {
    if (v.st === "none" || v.kind === "none" || v.owner === "none") continue;
    if (scheduled(v) && s.file[v.owner] === "broken") continue;
    jobs[j] = v.kind === "legacy"
      ? { st: v.st, kind: v.kind, owner: v.owner, at: NONE, since: Math.max(v.since, v.last), last: NONE, req: "none" }
      : { st: v.st, kind: v.kind, owner: v.owner, at: v.at, since: v.since, last: v.last, req: v.req };
  }
  return { now: s.now, up: s.up, file: { ...s.file }, jobs, log: logView(s.log), notices: { ...s.notices } };
}

export const logView = (log: Dispatch[]) => log.map((d) => `${d.job}@${d.at}:${d.chat}`).sort();
