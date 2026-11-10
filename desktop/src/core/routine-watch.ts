// Watch routines (2026-11-11, the user: "定時跑某一個東西，只有在出問題的時候會把他叫起來"; a problem wakes the bot
// and it decides). A routine whose instruction starts with "!" is a check, not a prompt:
//
//   */10 * * * * Disk: !./check-disk.sh          (routines.cron)
//   app_routines create kind=watch cron=… task=Disk command=./check-disk.sh   (saved as recurring "Disk: !./check-disk.sh")
//
// At its time the app runs the command itself, in the bot's folder, with a time limit, and wakes nobody (no tokens).
// It fails on a non-zero exit, a timeout, or an output line starting with "ALERT"; a failure wakes the bot with the
// watch's name, the command, why, and the tail of its output. The storm rule (`nextWatchState`): the bot is woken
// when a watch starts failing; while it keeps failing it is woken again only once WATCH_REWAKE_MS have passed since
// the last wake; a passing run re-arms it, so the next failure wakes at once. Recovery itself wakes nobody.
//
// The command runs as the bot or user wrote it, with the same trust as the routine lines it lives in (the bot writes
// routines.cron itself); no card is asked for.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { killTree } from "./process/kill-tree";
import { commandEnvironment, commandProgram } from "./components/commands";

/** How long a watch may run before it is stopped (and counts as failed). */
export const WATCH_TIMEOUT_MS = 120_000;
/** While a watch keeps failing, the bot is woken again only after this long (6 hours). */
export const WATCH_REWAKE_MS = 6 * 3600_000;
/** How much output is kept from a run (its tail). */
const KEPT_OUTPUT = 64_000;
/** How much of the output's tail the bot is shown. */
const SHOWN_OUTPUT = 1_500;

/** The command of a watch routine ("Name: !command"), or null when the routine is a prompt. A watch needs a name. */
export function watchCommand(task: string): string | null {
  const match = /^([^:：]*?\S)\s*(?::\s|：)\s*!([\s\S]*)$/.exec(task.trim());
  if (!match) return null;
  const command = match[2]!.trim();
  return command || null;
}

export interface WatchResult {
  /** null: it did not exit by itself (timed out, killed, or could not start). */
  exit: number | null;
  timedOut: boolean;
  /** stdout and stderr together, its tail. */
  output: string;
  /** Epoch ms. */
  ranAt: number;
}

/** Why a run counts as a problem, or null when it passed. */
export function watchFailure(result: WatchResult): string | null {
  if (result.timedOut) return "timed out";
  if (result.exit !== 0) return result.exit === null ? "did not finish" : `exit code ${result.exit}`;
  if (/^ALERT/m.test(result.output)) return "ALERT line";
  return null;
}

/** What the app keeps of a watch (bot.json `routineWatches`, by routine id); times are epoch ms. */
export interface WatchState {
  lastRun: number;
  ok: boolean;
  exit: number | null;
  timedOut: boolean;
  /** When the current failing streak began (null: passing). */
  failingSince: number | null;
  /** When the bot was last woken in this streak (null: not woken). */
  wokeAt: number | null;
}

/** The storm rule: wake on the first failure of a streak, then only after WATCH_REWAKE_MS; a pass re-arms. */
export function nextWatchState(previous: WatchState | undefined, result: WatchResult): { state: WatchState; wake: boolean } {
  const base = { lastRun: result.ranAt, exit: result.exit, timedOut: result.timedOut };
  if (watchFailure(result) === null) return { state: { ...base, ok: true, failingSince: null, wokeAt: null }, wake: false };
  const streak = previous && !previous.ok && previous.failingSince !== null;
  const failingSince = streak ? previous!.failingSince : result.ranAt;
  const lastWake = streak ? previous!.wokeAt : null;
  const wake = lastWake === null || result.ranAt - lastWake >= WATCH_REWAKE_MS;
  return { state: { ...base, ok: false, failingSince, wokeAt: wake ? result.ranAt : lastWake }, wake };
}

/** What the bot is told when its watch fails: the app ran it, what failed, the output's tail; the bot decides. */
export function watchPrompt(name: string, command: string, result: WatchResult, failingSince?: number | null): string {
  let tail = result.output.trimEnd();
  if (tail.length > SHOWN_OUTPUT) tail = `…${tail.slice(-SHOWN_OUTPUT)}`;
  const since = failingSince && failingSince < result.ranAt ? ` It has been failing since ${new Date(failingSince).toISOString()}.` : "";
  return `(App: Your watch "${name}" found a problem: ${watchFailure(result) ?? "failed"}. The app ran its command in your folder: ${command}${since}\n`
    + `Output (tail):\n${tail || "(none)"}\n`
    + "Decide what to do: look into it, fix it, or tell the user. While it keeps failing you are woken again only every 6 hours; once it passes, the next failure wakes you at once.)";
}

/**
 * Runs a watch's command in `folder` (the user's shell, as component commands), stopping its whole group after
 * `timeoutMs`. `onPid` hears its group start and end (the process ledger: if the app dies meanwhile, the next start
 * ends the group, so a watch never runs beside one an earlier app life left; spec/models/routines/RoutineWatch.tla).
 */
export function runWatch(command: string, folder: string, timeoutMs = WATCH_TIMEOUT_MS, onPid?: (pid: number, alive: boolean) => void): Promise<WatchResult> {
  return new Promise((done) => {
    let isFolder = false;
    try { isFolder = statSync(folder).isDirectory(); } catch { /* not there */ }
    if (!isFolder) return done({ exit: null, timedOut: false, output: `The folder ${folder} is not there.`, ranAt: Date.now() });
    const [file, args] = commandProgram(command);
    const child = spawn(file, args, { cwd: folder, env: commandEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let output = "";
    let timedOut = false;
    let finished = false;
    const pid = child.pid;
    if (pid) onPid?.(pid, true);
    const forget = () => { if (pid) onPid?.(pid, false); };
    const keep = (chunk: Buffer) => { output = (output + chunk.toString("utf8")).slice(-KEPT_OUTPUT); };
    const signal = (name: NodeJS.Signals) => {
      if (child.pid && killTree(child.pid, name)) return;
      try { child.kill(name); } catch { /* gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      setTimeout(() => signal("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.once("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      forget();
      done({ exit: null, timedOut: false, output: `Couldn't start the command: ${error.message}`, ranAt: Date.now() });
    });
    child.once("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal("SIGKILL"); // Whatever it left behind in its group goes too.
      forget();
      done({ exit: timedOut ? null : code, timedOut, output, ranAt: Date.now() });
    });
  });
}

/** bot.json's `routineWatches`, as it is (bad entries left out). */
export function fromRoutineWatches(value: unknown): Record<string, WatchState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, WatchState> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = entry as Partial<WatchState> | null;
    if (!e || typeof e !== "object" || typeof e.lastRun !== "number" || typeof e.ok !== "boolean") continue;
    out[id] = {
      lastRun: e.lastRun, ok: e.ok, exit: typeof e.exit === "number" ? e.exit : null, timedOut: e.timedOut === true,
      failingSince: typeof e.failingSince === "number" ? e.failingSince : null, wokeAt: typeof e.wokeAt === "number" ? e.wokeAt : null,
    };
  }
  return out;
}
