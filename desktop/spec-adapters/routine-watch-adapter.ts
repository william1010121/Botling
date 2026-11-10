// spec/driver/routine-watch-driver.ts against the real code: a project Bot (its head never spawns) with one watch
// routine, written as app_routines kind=watch or as a "Name: !command" line in routines.cron, its command a real
// shell script in the bot's folder that runs until the test tells it how to end. Each action is one call into the
// Bot (checkRoutines) or what the world does (a command ends, the app dies, the core starts: server.ts's
// ProcessLedger.endLeftovers, then the bot). The observation is read back from the files the app keeps (bot.json
// routineWatches, the process ledger), the processes alive, the bot's snapshot and the chat lines it emitted.
// Translation only, but for the crash: the dropped Bot is shut down without its tidy, so a result that comes back to
// it is dropped (bot.ts: `shuttingDown`) as a dead app's would be; the processes it started live on.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "../src/core/bot";
import { CodexThreads } from "../src/core/agent/codex";
import { botPrompts } from "../src/core/prompts";
import { ProcessLedger } from "../src/core/process/ledger";
import { projectProfile } from "../src/core/store/workspace";
import type { RoutineWatchDriver, RoutineWatchSession, RoutineWatchWorld } from "../../spec/driver/routine-watch-driver";
import { NONE, type Kept, type View } from "../../spec/reference/routine-watch";

/** Minute 0 of the model: 10:00 local time on a fixed day; the watch runs every two hours. */
const BASE = new Date(2030, 0, 15, 10, 0, 0, 0).getTime();
const CRON = "0 */2 * * *";
const COMMAND = "exec sh ./watch.sh";
/** The watch's command: says it started, then waits until the test writes its exit code into go-<its pid>. */
const SCRIPT = 'echo $$ >> started\nwhile [ ! -f "go-$$" ]; do sleep 0.01; done\nexit "$(cat "go-$$")"\n';
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(what: string, ok: () => boolean, ms = 10_000) {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() > end) throw new Error(`routine-watch adapter: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await flush();
}

export const routineWatchAdapter: RoutineWatchDriver = {
  async open(world: RoutineWatchWorld): Promise<RoutineWatchSession> {
    const plainBefore = process.env.BOTLING_PLAIN_SHELL;
    process.env.BOTLING_PLAIN_SHELL = "1";
    const root = mkdtempSync(join(tmpdir(), "spec-routine-watch-"));
    const folder = join(root, "project");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "watch.sh"), SCRIPT);
    const profile = projectProfile(root, { id: "5EC00000-0000-4000-8000-0000000000a1", name: "watcher", folder, avatar: "triangle" });
    mkdirSync(profile.storeDir, { recursive: true });
    const settingsFile = join(profile.storeDir, "bot.json");
    writeFileSync(settingsFile, JSON.stringify({ engine: "claude", heads: { engines: ["claude"], answerWith: "claude" } }));
    const ledgerFile = join(root, "children.json");
    const at = (tick: number) => BASE + tick * world.tickMs;
    const tickOf = (ms: number) => Math.round((ms - BASE) / world.tickMs);

    let now = 0;
    let life = 0;
    let bot: Bot | null = null;
    const bots: Bot[] = [];
    /** The watch's command processes (group leaders), by the app life that started them. */
    const runs = new Map<number, number>();
    const emitted: { role: string }[] = [];
    const ledgerPids = (): number[] => (existsSync(ledgerFile) ? (JSON.parse(readFileSync(ledgerFile, "utf8")) as { pgid: number }[]).map((e) => e.pgid) : []);

    const start = () => {
      // The core's start (server.ts): it ends what an earlier core left, then the bot reads its routines.
      new ProcessLedger(ledgerFile).endLeftovers();
      life += 1;
      bot = new Bot({
        profile, ledger: new ProcessLedger(ledgerFile),
        headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: folder, allowedTools: [] }; },
        codexConfig(_p, c) { return { command: "/never-spawn", cwd: folder, threads: new CodexThreads(join(root, "threads")), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null }; },
        prompts: (engine, heads) => botPrompts({ profile, engine, heads }),
        emit(event: any) { if (event.type === "message.added") emitted.push(event.message); },
        log() {}, idleMs: 600_000, approvalTimeoutMs: 1_000, interruptGraceMs: 10,
      });
      bots.push(bot);
    };
    const live = () => { if (!bot) throw new Error("routine-watch adapter: the app is not running"); return bot; };
    const mine = () => [...runs].filter(([pid, l]) => l === life && alive(pid)).map(([pid]) => pid);
    const earlier = () => [...runs].filter(([pid, l]) => l !== life && alive(pid)).map(([pid]) => pid);
    const end = (pid: number, code: number) => writeFileSync(join(folder, `go-${pid}`), String(code));

    // The watch, made an hour before minute 0 (a legacy line is seen by a check then, so it runs from minute 0).
    world.setClock(at(0) - 3600_000);
    start();
    if (world.form === "scheduled") live().changeRoutine({ operation: "create", kind: "watch", cron: CRON, task: "Disk", command: COMMAND, request_id: "spec-watch" });
    else live().addRoutine(CRON, `Disk: !${COMMAND}`);
    live().checkRoutines(at(0) - 3600_000);
    world.setClock(at(0));

    const session: RoutineWatchSession = {
      async tick() { now += 1; world.setClock(at(now)); await flush(); },
      async due() {
        const before = new Set(ledgerPids());
        live().checkRoutines(at(now));
        for (const pid of ledgerPids()) if (!before.has(pid)) runs.set(pid, life);
        await flush();
      },
      async finish(r) {
        const pid = mine()[0]!;
        end(pid, r === "pass" ? 0 : 1);
        // Taken: its group is out of the ledger (runWatch's close), and the bot's step on the result has run.
        await until(`the app to take run ${pid}`, () => !alive(pid) && !ledgerPids().includes(pid));
      },
      async orphanEnds() {
        const pid = earlier()[0]!;
        end(pid, 0);
        await until(`run ${pid} to end`, () => !alive(pid));
      },
      async crash() {
        const old = live();
        bot = null;
        life += 1; // What it started belongs to an earlier life now.
        await old.shutdown({ tidy: false }).catch(() => {});
      },
      async boot() {
        const left = earlier();
        start();
        // What the core's start ended goes at once; anything still alive after that was not in the ledger.
        await until("the groups an earlier core left to end", () => left.every((pid) => !alive(pid)), 2_000).catch(() => undefined);
      },
      view(): View {
        const saved = existsSync(settingsFile) ? (JSON.parse(readFileSync(settingsFile, "utf8")).routineWatches ?? {}) : {};
        const entry = Object.values(saved)[0] as { ok: boolean; wokeAt: number | null } | undefined;
        const disk: Kept = !entry ? { state: "never", wokeAt: NONE } : { state: entry.ok ? "ok" : "failing", wokeAt: entry.wokeAt === null ? NONE : tickOf(entry.wokeAt) };
        const row = bot ? (bot.snapshot() as { routines?: { watch?: { state: Kept["state"] } }[] }).routines?.find((routine) => routine.watch) : undefined;
        return {
          now, up: bot !== null, running: mine().length > 0, orphan: earlier().length > 0, disk,
          shown: bot ? row?.watch?.state ?? null : null, woken: emitted.filter((m) => m.role === "divider").length,
        };
      },
      async close() {
        for (const pid of runs.keys()) if (alive(pid)) end(pid, 0);
        for (const b of bots.splice(0)) await b.shutdown({ tidy: false }).catch(() => {});
        await until("every run to end", () => [...runs.keys()].every((pid) => !alive(pid)), 5_000).catch(() => {});
        if (plainBefore === undefined) delete process.env.BOTLING_PLAIN_SHELL; else process.env.BOTLING_PLAIN_SHELL = plainBefore;
        rmSync(root, { recursive: true, force: true });
      },
    };
    return session;
  },
};
