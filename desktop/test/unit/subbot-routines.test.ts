// A sub bot's routines (its own .bot/sub-bots/<id>/routines.cron) belong to the sub bot: its chat
// shows them with the rest of its scheduled work, they run in its own chat, and a job the bot adds
// by editing the file reaches the chat without waiting for the job to run. Its project bot and an
// unrelated project never show them.
import { afterEach, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const fixture = vi.hoisted(() => {
  class Head {
    running = false; pid = 0; exited = Promise.resolve(); completionDependencies: any[] = []; sent: string[] = [];
    constructor(readonly config: any, readonly handlers: any) {}
    start() { this.running = true; queueMicrotask(() => this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId })); }
    send(text: string) { this.sent.push(text); }
    steer(text: string) { this.sent.push(text); return true; }
    finish() { this.running = false; this.handlers.onExit({ code: 0, signal: null, stderr: "", expected: true, silent: false }); }
    async terminate() { this.finish(); return { killed: [], forced: false }; }
  }
  return { Head };
});
vi.mock("../../src/core/agent/head", async (original) => ({ ...await original<any>(), ClaudeHead: class extends fixture.Head {} }));
vi.mock("../../src/core/agent/codex", async (original) => ({ ...await original<any>(), CodexHead: class extends fixture.Head {} }));
vi.mock("../../src/core/agent/agy-acp", () => ({ verifyAcpRuntime() {}, AgyAcpHead: class extends fixture.Head {} }));
import { Bot } from "../../src/core/bot";
import { projectProfile, type BotProfile } from "../../src/core/store/workspace";
import { botPrompts } from "../../src/core/prompts";
import { CodexThreads } from "../../src/core/agent/codex";
import { tempDir } from "../helpers";

const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.shutdown({ tidy: false }); });

const EEG = "525203F0-FF85-4BAD-92D3-C77EA8B633F2";
const SUB = "55AF89BC-26C8-4FA0-96B2-A01777280D81";
const BOTLING = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const JOB = "0,30 * * * * Baseline progress: ssh 4090-2 and report done/running/queued in 3 sentences";
const swiftDate = (ms: number) => (ms - Date.UTC(2001, 0, 1)) / 1000;

function make(root: string, profile: BotProfile, events: any[], routineRuns?: Record<string, number>) {
  mkdirSync(profile.storeDir, { recursive: true });
  writeFileSync(join(profile.storeDir, "bot.json"), JSON.stringify({ engine: "claude", heads: { engines: ["claude"], answerWith: "claude" }, ...(routineRuns ? { routineRuns } : {}) }));
  const bot = new Bot({
    profile, deferStartup: true, welcome: false, ledger: { record() {}, forget() {} } as any,
    headConfig(_p, c) { return { ...c, command: "/never-spawn", cwd: profile.folder, allowedTools: [] }; },
    codexConfig(_p, c) { return { command: "/never-spawn", cwd: profile.folder, threads: new CodexThreads(join(root, "threads")), sessionId: c.sessionId, resume: c.resume, model: c.codexModel, effort: c.effort, instructions: c.systemPrompt, workerInstructions: null }; },
    prompts: (engine, heads) => botPrompts({ profile, engine, heads }),
    emit(event: any) { events.push(event); }, log() {}, idleMs: 600_000, approvalTimeoutMs: 1_000, interruptGraceMs: 10,
  });
  bot.activateStartup();
  bots.push(bot);
  return bot;
}

function workspace() {
  const root = tempDir("subbot-routines-root"), eeg = tempDir("subbot-routines-eeg"), botling = tempDir("subbot-routines-botling");
  const subNotes = join(eeg, ".bot", "sub-bots", SUB);
  mkdirSync(subNotes, { recursive: true });
  writeFileSync(join(subNotes, "routines.cron"), `# Routines: one job per line, crontab format.\n${JOB}\n`);
  const profiles = {
    eeg: projectProfile(root, { id: EEG, name: "eeg", folder: eeg, avatar: "triangle" }),
    sub: projectProfile(root, { id: SUB, name: "bench-correction", folder: eeg, avatar: "triangle", job: "Benchmark-correction owner", parent: EEG }),
    botling: projectProfile(root, { id: BOTLING, name: "botling", folder: botling, avatar: "cloud" }),
  };
  return { root, subNotes, profiles };
}

it("a sub bot's routine shows in its own chat snapshot, never its project bot's or another project's", () => {
  const { root, profiles } = workspace();
  const events: any[] = [];
  const sub = make(root, profiles.sub, events), eeg = make(root, profiles.eeg, events), botling = make(root, profiles.botling, events);
  expect(sub.snapshot().routines).toEqual([expect.objectContaining({ kind: "legacy", title: "Baseline progress", cron: "0,30 * * * *", status: "enabled" })]);
  const titles = (bot: Bot) => (bot.snapshot().routines ?? []).map((routine) => routine.title);
  expect(titles(eeg)).not.toContain("Baseline progress");
  expect(titles(botling)).not.toContain("Baseline progress");
});

it("pressing the routine in the background-work row says what it is and which bot's file keeps it", async () => {
  const { root, subNotes, profiles } = workspace();
  const sub = make(root, profiles.sub, []);
  const { text } = await sub.taskOutput("any", `routine:cron:${JOB}`);
  expect(text.split("\n")).toEqual([expect.stringMatching(/^Botling routine · /), "Baseline progress: ssh 4090-2 and report done/running/queued in 3 sentences", `Kept in ${join(subNotes, "routines.cron")}`]);
});

it("a due sub bot routine runs in the sub bot's own chat", () => {
  const { root, profiles } = workspace();
  const events: any[] = [];
  const sub = make(root, profiles.sub, events, { [JOB]: swiftDate(Date.now() - 86_400_000) });
  const eeg = make(root, profiles.eeg, events);
  const now = Date.now();
  sub.checkRoutines(now);
  eeg.checkRoutines(now);
  const dividers = (bot: Bot) => bot.snapshot().messages.filter((message) => message.role === "divider" && message.text.startsWith("Baseline progress"));
  expect(dividers(sub)).toHaveLength(1);
  expect(dividers(eeg)).toHaveLength(0);
});

it("a job the bot writes into its routines.cron reaches its chat at the next routine check", () => {
  const { root, subNotes, profiles } = workspace();
  const events: any[] = [];
  const sub = make(root, profiles.sub, events);
  sub.checkRoutines();
  events.length = 0;
  appendFileSync(join(subNotes, "routines.cron"), "0 9 * * * Morning check: read STATUS.md\n");
  sub.checkRoutines();
  const updated = events.filter((event) => event.type === "routines.updated" && event.botId === SUB).at(-1);
  expect(updated?.routines.map((routine: any) => routine.title)).toEqual(["Baseline progress", "Morning check"]);
  // Nothing changed since: no event again.
  events.length = 0;
  sub.checkRoutines();
  expect(events.filter((event) => event.type === "routines.updated")).toHaveLength(0);
});
