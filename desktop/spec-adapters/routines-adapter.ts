// spec/driver/routines-driver.ts against the real code: Bot objects of a project bot and its sub bots
// (their heads never spawn), each action one call into Bot or ScheduledRoutineStore, and the observation
// read back from the files the app keeps and the chat lines it emitted. Translation only, but for one piece of
// environment: a script's append landing between an app rewrite's read of routines.cron and its rename is played
// by holding the append back and writing it from inside node:fs renameSync, right before that rename.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Bot } from "../src/core/bot";
import { CodexThreads } from "../src/core/agent/codex";
import { botPrompts, profilePaths } from "../src/core/prompts";
import { parseRoutine, RoutineFile, ScheduledRoutineStore } from "../src/core/routines";
import { fromSwiftDate } from "../src/core/store/records";
import { projectProfile, type BotProfile } from "../src/core/store/workspace";
import type { RoutinesDriver, RoutinesSession, RoutinesWorld } from "../../spec/driver/routines-driver";
import type { Bot as BotId, FileState, Job, JobState, JobView, Line, View } from "../../spec/reference/routines";

const MINUTE = 60_000;
const NONE = -1;
/** Minute 0 of the model: 10:00 local time on a fixed day; minute m of the cron runs at 10:m. */
const BASE = new Date(2030, 0, 15, 10, 0, 0, 0).getTime();
const UNREADABLE = "{not json: a broken scheduled-routines.json";
const task = (job: Job) => `${job}: run ${job}`;
const slotOf = (text: string) => text.split(":")[0]!;
const minute = (ms: number) => Math.round((ms - BASE) / MINUTE);
const onceId = (line: Line) => `@once ${task(line)}`;

/** Runs `write` with every rename onto `file` preceded by `before()` (once): the app's atomic writes import renameSync from node:fs. */
function withRenameHook(file: string, before: () => void, write: () => void) {
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const original = fs.renameSync;
  let fired = false;
  fs.renameSync = ((from: string, to: string) => {
    if (!fired && String(to) === file) { fired = true; before(); }
    return original(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { write(); } finally {
    fs.renameSync = original;
    syncBuiltinESMExports();
  }
  if (!fired) throw new Error(`routines adapter: the rewrite never renamed ${file}`);
}

export const routinesAdapter: RoutinesDriver = {
  open(world: RoutinesWorld): RoutinesSession {
    const root = mkdtempSync(join(tmpdir(), "spec-routines-"));
    const folder = join(root, "project");
    mkdirSync(folder, { recursive: true });
    const [project, ...subs] = world.bots;
    const ids = Object.fromEntries(world.bots.map((bot, i) => [bot, `5EC00000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`]));
    const profiles: Record<BotId, BotProfile> = {};
    profiles[project!] = projectProfile(root, { id: ids[project!]!, name: project!, folder, avatar: "triangle" });
    for (const sub of subs) profiles[sub] = projectProfile(root, { id: ids[sub]!, name: sub, folder, avatar: "triangle", job: "spec", parent: ids[project!]! });
    const cronFile = (bot: BotId) => join(folder, profilePaths(profiles[bot]!).routines);
    const storeFile = (bot: BotId) => join(dirname(cronFile(bot)), "scheduled-routines.json");
    const cron = `${world.cron.join(",")} 10 * * *`;

    let now = 0;
    let bots: Record<BotId, Bot> | null = null;
    const everyBot: Bot[] = [];
    const kept: Record<BotId, string | null> = {};
    const legacy = new Map<Job, BotId>();
    const onceLines = new Map<Line, BotId>();
    /** A rewrite in flight: what it read, and the appends that landed after (held back until its rename). */
    let window: { bot: BotId; line: Line | null; text: string; appended: string[] } | null = null;
    const emitted: { botId: string; role: string; text: string; time: string }[] = [];
    const botOf = (id: string) => world.bots.find((bot) => ids[bot] === id)!;
    world.setClock(BASE);

    const live = (bot: BotId) => {
      if (!bots) throw new Error("routines adapter: the app is not running");
      return bots[bot]!;
    };
    const ownerOf = (job: Job): BotId => {
      if (legacy.has(job)) return legacy.get(job)!;
      for (const bot of world.bots) if (scheduled(bot)?.some((saved) => slotOf(saved.task) === job)) return bot;
      throw new Error(`routines adapter: no job ${job}`);
    };
    const idOf = (job: Job): string => {
      const bot = ownerOf(job);
      if (legacy.has(job)) return `cron:${cron} ${task(job)}`;
      return scheduled(bot)!.find((saved) => slotOf(saved.task) === job)!.id;
    };
    const change = (job: Job, args: Record<string, unknown>) => {
      try { live(ownerOf(job)).changeRoutine({ ...args, id: idOf(job) }); } catch { /* refused: nothing changed */ }
    };
    const raw = (bot: BotId): string | null => (existsSync(storeFile(bot)) ? readFileSync(storeFile(bot), "utf8") : null);
    function scheduled(bot: BotId): any[] | null {
      const text = raw(bot);
      if (text === null) return [];
      try { return JSON.parse(text).routines; } catch { return null; }
    }

    const session: RoutinesSession = {
      tick() { now++; world.setClock(BASE + now * MINUTE); },
      crash() { bots = null; window = null; },
      boot() {
        const next: Record<BotId, Bot> = {};
        for (const bot of world.bots) {
          const profile = profiles[bot]!;
          mkdirSync(profile.storeDir, { recursive: true });
          const settings = join(profile.storeDir, "bot.json");
          if (!existsSync(settings)) writeFileSync(settings, JSON.stringify({ engine: "claude", heads: { engines: ["claude"], answerWith: "claude" } }));
          next[bot] = new Bot({
            profile, ledger: { record() {}, forget() {} } as any,
            headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: profile.folder, allowedTools: [] }; },
            codexConfig(_p, c) { return { command: "/never-spawn", cwd: profile.folder, threads: new CodexThreads(join(root, "threads")), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null }; },
            prompts: (engine, heads) => botPrompts({ profile, engine, heads }),
            emit(event: any) { if (event.type === "message.added") emitted.push({ botId: event.botId, ...event.message }); },
            log() {}, idleMs: 600_000, approvalTimeoutMs: 1_000, interruptGraceMs: 10,
          });
          everyBot.push(next[bot]!);
        }
        bots = next;
      },
      break(bot) { kept[bot] = raw(bot); mkdirSync(dirname(storeFile(bot)), { recursive: true }); writeFileSync(storeFile(bot), UNREADABLE); },
      mend(bot) { const before = kept[bot]; if (before === null || before === undefined) rmSync(storeFile(bot), { force: true }); else writeFileSync(storeFile(bot), before); },
      view(bot) { live(bot).snapshot(); },
      check(bot) { live(bot).checkRoutines(BASE + now * MINUTE); },
      claimThenCrash(job) {
        new ScheduledRoutineStore(storeFile(ownerOf(job))).claim(idOf(job), BASE + now * MINUTE);
        bots = null;
      },
      create(job, { req, kind, bot, at }) {
        const args = kind === "once" ? { at: new Date(BASE + at * MINUTE).toISOString() } : { cron };
        try { live(bot).changeRoutine({ operation: "create", kind, task: task(job), request_id: req, ...args }); } catch { /* refused */ }
      },
      addLegacy(job, bot) { legacy.set(job, bot); live(bot).addRoutine(cron, task(job)); },
      pause(job) { change(job, { operation: "pause" }); },
      resume(job) { change(job, { operation: "resume" }); },
      cancel(job) { change(job, { operation: "cancel" }); },
      append(line, bot, paused) {
        onceLines.set(line, bot);
        const file = cronFile(bot);
        mkdirSync(dirname(file), { recursive: true });
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        const added = `${text && !text.endsWith("\n") ? "\n" : ""}${paused ? "#" : ""}${onceId(line)}\n`;
        appendFileSync(file, added);
        if (window?.bot === bot) window.appended.push(added);
      },
      takeRead(bot, line) { window = { bot, line, text: readFileSync(cronFile(bot), "utf8"), appended: [] }; },
      editRead(bot) { window = { bot, line: null, text: readFileSync(cronFile(bot), "utf8"), appended: [] }; },
      rewrite(bot) {
        const open = window!;
        window = null;
        const file = cronFile(bot);
        // The file as the rewrite read it; what was appended since lands right before the rename.
        writeFileSync(file, open.text);
        const land = () => { for (const added of open.appended) appendFileSync(file, added); };
        if (open.line !== null) {
          // The check that took the line (tests call it only when that check has nothing else to do).
          withRenameHook(file, land, () => live(bot).checkRoutines(BASE + now * MINUTE));
          return;
        }
        // app_routines pause/resume of a line, as it is: a rewrite that changes nothing of its own.
        const first = open.text.split("\n").map(parseRoutine).find((job) => job !== null);
        if (!first) throw new Error("routines adapter: editRead needs a line in routines.cron to rewrite");
        withRenameHook(file, land, () => new RoutineFile(file).update(first.id, first.enabled ? "resume" : "pause"));
      },
      takeThenCrash(bot, line) {
        new RoutineFile(cronFile(bot)).takeOnce(onceId(line));
        bots = null;
        window = null;
      },
      observe(): View {
        const file: Record<BotId, FileState> = {};
        const onceView: View["lines"] = {};
        const jobs: Record<Job, JobView> = {};
        for (const bot of world.bots) {
          const saved = scheduled(bot);
          file[bot] = saved === null ? "broken" : "ok";
          for (const job of saved ?? []) {
            jobs[slotOf(job.task)] = {
              st: job.state as JobState, kind: job.kind, owner: bot, at: job.at === undefined ? NONE : minute(fromSwiftDate(job.at)),
              since: minute(fromSwiftDate(job.baseline)), last: job.lastClaim === undefined ? NONE : minute(fromSwiftDate(job.lastClaim)), req: job.requestID,
            };
          }
          const settings = join(profiles[bot]!.storeDir, "bot.json");
          const runs: Record<string, number> = existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")).routineRuns ?? {} : {};
          const lines = existsSync(cronFile(bot)) ? readFileSync(cronFile(bot), "utf8").split("\n") : [];
          for (const [line, owner] of onceLines) {
            if (owner !== bot) continue;
            const job = lines.map(parseRoutine).find((routine) => routine?.once && routine.task === task(line));
            onceView[line] = { st: job ? (job.enabled ? "in" : "paused") : "out", owner: bot };
          }
          for (const [job, owner] of legacy) {
            if (owner !== bot) continue;
            const line = lines.map(parseRoutine).find((routine) => routine?.task === task(job));
            const run = runs[`${cron} ${task(job)}`];
            jobs[job] = { st: line ? (line.enabled ? "pending" : "paused") : "cancelled", kind: "legacy", owner: bot, at: NONE, since: run === undefined ? NONE : minute(fromSwiftDate(run)), last: NONE, req: "none" };
          }
        }
        const log = emitted.filter((m) => m.role === "divider").map((m) => `${slotOf(m.text.split(" · ")[0]!)}@${minute(Date.parse(m.time))}:${botOf(m.botId)}`).sort();
        const notices = Object.fromEntries(world.bots.map((bot) => [bot, emitted.filter((m) => m.role === "notice" && m.botId === ids[bot] && m.text.startsWith("Routines:")).length]));
        return { now, up: bots !== null, file, jobs, lines: onceView, log, notices };
      },
      minute,
      async close() {
        for (const bot of everyBot.splice(0)) await bot.shutdown({ tidy: false }).catch(() => {});
        rmSync(root, { recursive: true, force: true });
      },
    };
    return session;
  },
};
