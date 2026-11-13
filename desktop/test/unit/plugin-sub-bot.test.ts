// A plugin's own bots (`bots.create` with parent, instructions and delegation): a hidden sub bot under a project bot,
// instructions longer than a job kept in a file the bot is told to read, and delegation "onRequest" swapping the
// "hand real work to subagents/workers by default" line for "do the work yourself; start one only when asked".
// Every other bot's prompt stays as it was (the snapshot and golden tests hold the shared texts).
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { botPrompts, CLAUDE_WORKERS_RULE, desktopPrompts, instructionsFileLine, NATIVE_SUBAGENT_LINE, ON_REQUEST_SUBAGENT_LINE, ON_REQUEST_WORKERS_RULE } from "../../src/core/prompts";
import { saveProjectRow } from "../../src/core/projects";
import { projectProfile } from "../../src/core/store/workspace";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { tempDir } from "../helpers";

const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const SUB = "A1B2C3D4-0000-4000-8000-000000000001";

type Role = "main" | "manager" | "bot";
const manager = { name: "botling", role: "manager" as Role, folder: "/p", memoryPath: ".bot/memory.md", job: null as string | null, id: PROJECT };
const ownBot = { ...manager, name: "News", role: "bot" as Role, job: "Collect news", id: "B0000000-0000-4000-8000-000000000001" };
const subBot = { ...manager, name: "Reader", role: "bot" as Role, job: "Read with me", id: SUB, parent: PROJECT, memoryPath: `.bot/sub-bots/${SUB}/memory.md` };
const system = (profile: Record<string, unknown>, engine: "claude" | "codex" | "agy" = "claude", workers = true) =>
  desktopPrompts(botPrompts({ profile: profile as never, engine, parentName: "botling" }), profile as never, engine, workers).system;

describe("delegation \"onRequest\" in the prompt", () => {
  it("leaves every bot made without it byte for byte as it was, on every engine", () => {
    for (const profile of [manager, ownBot, subBot]) {
      for (const [engine, workers] of [["claude", true], ["claude", false], ["codex", true], ["agy", true]] as const) {
        expect(system({ ...profile, delegation: "default" }, engine, workers), `${profile.name} ${engine}`).toBe(system(profile, engine, workers));
      }
    }
  });

  it("a Claude bot with app workers does the work itself and starts a worker only when the user asks", () => {
    for (const profile of [ownBot, subBot]) {
      const text = system({ ...profile, delegation: "onRequest" });
      expect(system(profile)).toContain(CLAUDE_WORKERS_RULE);
      expect(text).not.toContain(CLAUDE_WORKERS_RULE);
      expect(text).toContain(ON_REQUEST_WORKERS_RULE);
      expect(text).not.toContain("Hand all real work");
      expect(text).toContain("app_handoff");
      // Nothing else of its prompt changed.
      expect(text.replace(ON_REQUEST_WORKERS_RULE, CLAUDE_WORKERS_RULE).replace(ON_REQUEST_SUB_BOT_WORDS, "you may start your own workers with app_handoff.")).toBe(system(profile));
    }
  });

  it("a Claude bot with native subagents does the work itself and uses the Agent tool only when the user asks", () => {
    const text = system({ ...subBot, delegation: "onRequest" }, "claude", false);
    expect(system(subBot, "claude", false)).toContain(NATIVE_SUBAGENT_LINE);
    expect(text).not.toContain(NATIVE_SUBAGENT_LINE);
    expect(text).toContain(ON_REQUEST_SUBAGENT_LINE);
    expect(text).not.toContain("you may start your own subagents with the Agent tool.");
  });

  it("a bot whose instructions are in a file is told to read it; none is told without one", () => {
    const file = `/p/.bot/sub-bots/${SUB}/instructions.md`;
    expect(system({ ...subBot, instructionsFile: file })).toContain(instructionsFileLine(file));
    expect(system({ ...subBot, instructionsFile: file }, "codex")).toContain(file);
    expect(system(subBot)).not.toContain("instructions.md");
  });

  it("a profile keeps delegation and the instructions file from its projects.json row", () => {
    const profile = projectProfile("/data", { id: SUB, name: "R", folder: "/tmp", avatar: "x", job: "j", parent: PROJECT, delegation: "onRequest", instructionsFile: "/tmp/i.md" });
    expect(profile).toMatchObject({ delegation: "onRequest", instructionsFile: "/tmp/i.md" });
    const plain = projectProfile("/data", { id: SUB, name: "R", folder: "/tmp", avatar: "x", job: "j", delegation: "sometimes" });
    expect(plain.delegation).toBeUndefined();
    expect(plain.instructionsFile).toBeUndefined();
  });
});

const ON_REQUEST_SUB_BOT_WORDS = "you do the work yourself and start a subagent or worker only when the user explicitly asks.";

function fixture() {
  const dir = tempDir("plugin-sub-bot");
  const folder = tempDir("plugin-sub-bot-project");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: PROJECT, name: "botling", folder, avatar: "triangle" });
  const open = () => new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  return { dir, folder, open };
}
const bots = (core: Core): Map<string, Bot> => (core as any).bots;
const rows = (dir: string) => JSON.parse(readFileSync(join(dir, "projects.json"), "utf8")) as Record<string, unknown>[];

describe("bots.create in the core", () => {
  it("makes a hidden sub bot under a project bot, with long instructions in a file and delegation onRequest, on Claude", async () => {
    const h = fixture();
    let core = h.open();
    const long = `Coach rules.\n${"Be patient. ".repeat(800)}`;
    try {
      const made = core.createPluginBot("reading-coach", "Reading coach", { name: "Paper: Attention", job: "Read one paper with the user.", parent: PROJECT, instructions: long, delegation: "onRequest" });
      expect(made).toMatchObject({ name: "Paper: Attention", role: "bot", created: true });
      const sub = bots(core).get(made.id)!;
      expect(sub.profile).toMatchObject({ parent: PROJECT, plugin: "reading-coach", delegation: "onRequest", folder: h.folder });
      const file = join(h.folder, ".bot", "sub-bots", made.id, "instructions.md");
      expect(sub.profile.instructionsFile).toBe(file);
      expect(readFileSync(file, "utf8")).toBe(long);
      expect(sub.engine).toBe("claude");
      expect(rows(h.dir).find((row) => row.id === made.id)).toMatchObject({ parent: PROJECT, plugin: "reading-coach", delegation: "onRequest", instructionsFile: file });
      const prompt = core.prompts(sub.profile, "claude").system;
      expect(prompt).toContain(ON_REQUEST_WORKERS_RULE);
      expect(prompt).toContain(instructionsFileLine(file));
      // The project bot lists it among its sub bots.
      expect(core.snapshot().bots.find((bot) => bot.id === PROJECT)!.subagentRows.some((row) => row.subBot === made.id)).toBe(true);
      // Asked again: the same bot, its instructions rewritten.
      const again = core.createPluginBot("reading-coach", "Reading coach", { name: "paper: attention", job: "x", parent: PROJECT, instructions: "New rules." });
      expect(again).toMatchObject({ id: made.id, created: false });
      expect(readFileSync(file, "utf8")).toBe("New rules.");
      await core.shutdown();
      core = h.open();
      expect(bots(core).get(made.id)!.profile).toMatchObject({ parent: PROJECT, delegation: "onRequest", instructionsFile: file });
    } finally { await core.shutdown(); }
  });

  it("makes a bot of its own with them too, its instructions under its own .bot/", async () => {
    const h = fixture(), core = h.open();
    try {
      const made = core.createPluginBot("reading-coach", "Reading coach", { name: "Coach", job: "Coach me.", instructions: "Rules.", delegation: "onRequest" });
      const bot = bots(core).get(made.id)!;
      expect(bot.profile.parent ?? null).toBeNull();
      expect(bot.profile.delegation).toBe("onRequest");
      expect(readFileSync(bot.profile.instructionsFile!, "utf8")).toBe("Rules.");
      expect(bot.profile.instructionsFile).toBe(join(bot.profile.folder, ".bot", "instructions.md"));
    } finally { await core.shutdown(); }
  });

  it("without the new fields makes the same bot as before: no delegation, no instructions file", async () => {
    const h = fixture(), core = h.open();
    try {
      const made = core.createPluginBot("news", "News", { name: "Morning news", job: "x" });
      const row = rows(h.dir).find((r) => r.id === made.id)!;
      expect(row.delegation).toBeUndefined();
      expect(row.instructionsFile).toBeUndefined();
      expect(bots(core).get(made.id)!.profile.delegation).toBeUndefined();
    } finally { await core.shutdown(); }
  });

  it("refuses a parent that is no project bot or bot of its own, and a sub bot name another plugin owns", async () => {
    const h = fixture(), core = h.open();
    try {
      expect(() => core.createPluginBot("p", "P", { name: "A", job: "j", parent: "00000000-0000-4000-8000-000000000000" })).toThrow(/No such bot/);
      expect(() => core.createPluginBot("p", "P", { name: "A", job: "j", parent: "main" })).toThrow(/project bot/);
      expect(() => core.createPluginBot("p", "P", { name: "A", job: "j", parent: MAIN_BOT_ID })).toThrow(/project bot/);
      const sub = core.createPluginBot("p", "P", { name: "A", job: "j", parent: PROJECT });
      expect(() => core.createPluginBot("p", "P", { name: "B", job: "j", parent: sub.id })).toThrow(/sub bot/);
      expect(() => core.createPluginBot("other", "Other", { name: "A", job: "j", parent: PROJECT })).toThrow(/taken/);
      expect(() => core.createPluginBot("p", "P", { name: "  ", job: "j", parent: PROJECT })).toThrow(/name and a job/);
    } finally { await core.shutdown(); }
  });
});
