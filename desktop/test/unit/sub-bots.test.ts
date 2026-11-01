// Sub bots: a running subagent moved out into a hidden bot under its project bot. The tag, the hand-off
// (wait, force only on timeout, handoff.md written by the app), the hidden bot's profile and view, what
// every walk over the bots skips, and what the project bot wakes with.
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BotView } from "../../src/contract";
import { Core } from "../../src/core/server";
import { Bot } from "../../src/core/bot";
import { parseReply, unsupportedRequest } from "../../src/core/reply";
import { botPrompts, desktopPrompts, RELAY_PREFIX, SUB_BOT_RELAY_PREFIX } from "../../src/core/prompts";
import { saveProjectRow } from "../../src/core/projects";
import { fallbackHandoff, handoffFile, progressFile, progressStatus, runHandoff, safeToken, subBotBriefing, subBotEngine, wrapUpMessage, type HandoffPorts } from "../../src/core/sub-bots";
import { Layout, projectProfile } from "../../src/core/store/workspace";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { tempDir } from "../helpers";

const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const SUB = "A1B2C3D4-0000-4000-8000-000000000001";

describe("the <sub-bot> tag", () => {
  it("is read from the tail of a reply and taken out of the text", () => {
    const parsed = parseReply('Moved to the settings bot.\n<sub-bot name="Settings page" subagent="a1b2c3"/>');
    expect(parsed.body).toBe("Moved to the settings bot.");
    expect(parsed.requests).toEqual([{ kind: "subBot", name: "Settings page", subagent: "a1b2c3", note: "" }]);
  });
  it("may carry words, in either attribute order, and ignores one in code or missing an attribute", () => {
    expect(parseReply("<sub-bot subagent='x1' name='API'>keep the schema</sub-bot>").requests).toEqual([{ kind: "subBot", name: "API", subagent: "x1", note: "keep the schema" }]);
    expect(parseReply('`<sub-bot name="A" subagent="b"/>`').requests).toEqual([]);
    expect(parseReply('```\n<sub-bot name="A" subagent="b"/>\n```').requests).toEqual([]);
    expect(parseReply('<sub-bot name="A"/>').requests).toEqual([]);
    expect(parseReply('<sub-bot name="A"/>').body).toBe("");
  });
  it("says out loud, never silently, what an engine that cannot do it was refused", () => {
    expect(unsupportedRequest({ kind: "subBot", name: "A", subagent: "b", note: "" })).toMatch(/sub bot/);
  });
});

function ports(over: Partial<HandoffPorts> & { statuses?: HandoffPorts["status"] extends () => infer R ? R[] : never }) {
  let t = 0;
  const statuses = [...(over.statuses ?? ["completed"])];
  const calls: string[] = [];
  let text: string | null = null;
  const p: HandoffPorts = {
    status: () => (statuses.length > 1 ? statuses.shift()! : statuses[0]!),
    forceStop: async () => { calls.push("force"); statuses.splice(0, statuses.length, "stopped"); },
    fallbackText: (reason) => { calls.push("fallback"); return `FALLBACK ${reason}`; },
    written: () => text !== null && text.trim().length > 0,
    write: (value) => { text = value; calls.push("write"); },
    sleep: async (ms) => { t += ms; },
    now: () => t,
    waitMs: 1_000, pollMs: 100,
    ...over,
  };
  return { p, calls, text: () => text, setText: (value: string) => { text = value; } };
}

describe("the hand-off wait", () => {
  it("lets a subagent that wrote handoff.md and ended go, with nothing forced or written by the app", async () => {
    const h = ports({ statuses: ["running", "running", "completed"] });
    h.setText("# handoff\nnext: x");
    expect(await runHandoff(h.p)).toEqual({ outcome: "ended", wroteFallback: false });
    expect(h.calls).toEqual([]);
  });
  it("stops the whole turn and writes handoff.md itself when the subagent is still running at the deadline", async () => {
    const h = ports({ statuses: ["running"] });
    expect(await runHandoff(h.p)).toEqual({ outcome: "forced", wroteFallback: true });
    expect(h.calls).toEqual(["force", "fallback", "write"]);
    expect(h.text()).toContain("did not end in time");
  });
  it("keeps a handoff.md the subagent wrote before it was cut off", async () => {
    const h = ports({ statuses: ["running"] });
    h.setText("partial but real");
    expect(await runHandoff(h.p)).toEqual({ outcome: "forced", wroteFallback: false });
    expect(h.text()).toBe("partial but real");
  });
  it("writes the file when the subagent ended without writing one, without stopping anything", async () => {
    const h = ports({ statuses: ["completed"] });
    expect(await runHandoff(h.p)).toEqual({ outcome: "ended", wroteFallback: true });
    expect(h.calls).toEqual(["fallback", "write"]);
  });
  it("waits no longer than waitMs", async () => {
    const h = ports({ statuses: ["running"], waitMs: 90_000, pollMs: 500 });
    let slept = 0;
    h.p.sleep = async (ms) => { slept += ms; };
    let t = 0; h.p.now = () => (t += 0) + slept;
    await runHandoff(h.p);
    expect(slept).toBe(90_000);
  });
});

describe("the hand-off for Codex and Antigravity workers", () => {
  it("asks a running Codex worker to wrap up once, then waits for it like a Claude subagent", async () => {
    let asked = 0;
    const h = ports({ statuses: ["running", "running", "completed"], ask: () => { asked++; } });
    h.setText("# handoff");
    expect(await runHandoff(h.p)).toEqual({ outcome: "ended", wroteFallback: false });
    expect(asked).toBe(1);
    expect(h.calls).toEqual([]);
  });
  it("does not ask a worker that already ended", async () => {
    let asked = 0;
    const h = ports({ statuses: ["completed"], ask: () => { asked++; } });
    expect(await runHandoff(h.p)).toEqual({ outcome: "ended", wroteFallback: true });
    expect(asked).toBe(0);
  });
  it("cancels a Codex worker that ignores the request at the deadline and writes handoff.md from its record", async () => {
    let asked = 0;
    const h = ports({ statuses: ["running"], ask: () => { asked++; } });
    expect(await runHandoff(h.p)).toEqual({ outcome: "forced", wroteFallback: true });
    expect(asked).toBe(1);
    expect(h.calls).toEqual(["force", "fallback", "write"]);
    expect(h.text()).toContain("did not end in time");
  });
  it("stops a worker that takes no message (Antigravity, busy) at once, without waiting", async () => {
    let slept = 0;
    const h = ports({ statuses: ["running"], stopAtOnce: true, sleep: async () => { slept++; } });
    expect(await runHandoff(h.p)).toEqual({ outcome: "forced", wroteFallback: true });
    expect(slept).toBe(0);
    expect(h.calls).toEqual(["force", "fallback", "write"]);
    expect(h.text()).toContain("cannot take a message");
  });
  it("keeps a handoff.md an Antigravity worker wrote before it was stopped", async () => {
    const h = ports({ statuses: ["running"], stopAtOnce: true });
    h.setText("real");
    expect(await runHandoff(h.p)).toEqual({ outcome: "forced", wroteFallback: false });
    expect(h.text()).toBe("real");
  });
  it("the wrap-up request names the file and says to end", () => {
    const text = wrapUpMessage("/p/.bot/subagents/t1/handoff.md");
    expect(text).toContain("/p/.bot/subagents/t1/handoff.md");
    expect(text).toMatch(/end your turn/);
  });
  it("a sub bot runs on the worker's engine when its project bot has it, else on the project bot's own, with a note", () => {
    expect(subBotEngine("codex", { engine: "claude", heads: ["claude", "codex"] })).toEqual({ engine: "codex", note: "" });
    expect(subBotEngine("agy", { engine: "agy", heads: ["agy"] })).toEqual({ engine: "agy", note: "" });
    const fallback = subBotEngine("codex", { engine: "agy", heads: ["agy"] });
    expect(fallback.engine).toBe("agy");
    expect(fallback.note).toMatch(/Codex/);
    expect(fallback.note).toMatch(/Antigravity/);
  });
  it("handoff.md names where a Codex worker's own record is", () => {
    const text = fallbackHandoff({ name: "X", description: "d", prompt: "p", steps: [], status: "stopped", result: "", reason: "r", engine: "codex", id: "task-1", threadId: "thr-9", run: 2 });
    expect(text).toContain("Codex worker (task task-1, run 2, thread thr-9)");
    expect(fallbackHandoff({ name: "X", description: "d", prompt: "p", steps: [], status: "stopped", result: "", reason: "r", engine: "claude" })).not.toContain("worker");
  });
});

describe("handoff.md written by the app", () => {
  it("lists what it was asked and what it is known to have done, from its recorded steps", () => {
    const text = fallbackHandoff({
      name: "Settings", description: "build the settings page", prompt: "Build the settings page with tabs", status: "stopped", result: "",
      reason: "the subagent did not end in time.",
      steps: [
        { id: "1", kind: "tool", tool: "Edit", title: "settings.tsx", done: true, failed: false },
        { id: "2", kind: "tool", tool: "Bash", title: "npm test", done: true, failed: true },
        { id: "3", kind: "text", title: "tabs done, api next", done: true, failed: false },
      ],
    });
    expect(text).toContain("# Handoff: Settings");
    expect(text).toContain("Build the settings page with tabs");
    expect(text).toContain("- Edit: settings.tsx");
    expect(text).toContain("- Bash: npm test (failed)");
    expect(text).toContain("tabs done, api next");
    expect(text).toContain("## Next steps");
  });
  it("puts files under the shared folder's .bot/subagents/<id>/, with an id that cannot leave it", () => {
    expect(handoffFile("/p/", "abc-1")).toBe("/p/.bot/subagents/abc-1/handoff.md");
    expect(progressFile("/p", "abc-1")).toBe("/p/.bot/subagents/abc-1/progress.md");
    expect(safeToken("../../etc/x")).toBe("______etc_x");
    expect(handoffFile("/p", "../../x")).not.toContain("..");
  });
  it("reads a progress file's status and lists sub bots for the wake note", () => {
    expect(progressStatus("Status: Done\nmore")).toBe("done");
    expect(progressStatus("nothing")).toBeNull();
    expect(subBotBriefing([])).toBe("");
    const note = subBotBriefing([{ name: "Settings", progress: "/p/.bot/subagents/a/progress.md", working: true, status: "working" }]);
    expect(note).toContain("Settings (working) (working now): progress file /p/.bot/subagents/a/progress.md");
    expect(note).toContain("do not wake it");
  });
});

function fixture(extra: { sub?: boolean } = {}) {
  const dir = tempDir("sub-bot");
  const folder = tempDir("sub-bot-project");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: PROJECT, name: "botling", folder, avatar: "triangle" });
  if (extra.sub !== false) saveProjectRow(dir, { id: SUB, name: "Settings page", folder, avatar: "triangle", job: "Continue the settings page", parent: PROJECT, createdAt: 1_700_000_000_000, handoff: "a1b2c3" });
  const events: any[] = [];
  const open = (more: Record<string, unknown> = {}) => new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit(event) { events.push(event); }, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0, ...more });
  return { dir, folder, events, open };
}
const bots = (core: Core): Map<string, Bot> => (core as any).bots;

describe("a sub bot in the core", () => {
  it("is a full bot hidden from the left column: its view names its project bot, and the project bot's rows list it", async () => {
    const h = fixture(), core = h.open();
    try {
      const snapshot = core.snapshot();
      const sub = snapshot.bots.find((bot) => bot.id === SUB)!;
      expect(BotView.safeParse(sub).success).toBe(true);
      expect(sub.parent).toBe(PROJECT);
      expect(snapshot.bots.find((bot) => bot.id === PROJECT)!.parent ?? null).toBeNull();
      const row = snapshot.bots.find((bot) => bot.id === PROJECT)!.subagentRows.find((r) => r.id === SUB)!;
      expect(row).toMatchObject({ subBot: SUB, title: "Settings page", status: "running", prompt: "Continue the settings page" });
      expect(sub.subagentRows).toEqual([]);
    } finally { await core.shutdown(); }
  });

  it("shares the folder but keeps its own notes, memory and tools; the project bot has no worktree for it", () => {
    const profile = projectProfile("/data", { id: SUB, name: "S", folder: "/tmp", avatar: "x", job: "j", parent: PROJECT });
    expect(profile.parent).toBe(PROJECT);
    expect(profile.memoryPath).toBe(`.bot/sub-bots/${SUB}/memory.md`);
    expect(profile.tools).toContain("Bash");
    expect(profile.role).toBe("bot");
  });

  it("is skipped by every walk over the bots: briefing, inboxes, waiting, whiteboard, @ members", async () => {
    const h = fixture(), core = h.open();
    try {
      expect(core.projectBriefing()).not.toContain("Settings page");
      expect(core.projectBriefing()).toContain("botling");
      // The folder's inbox is the project bot's: delivered once, to it, never to the sub bot.
      writeFileSync(join(h.folder, ".bot", "inbox.md"), "do the thing");
      const relayed: string[] = [];
      for (const [id, bot] of bots(core)) vi.spyOn(bot, "relay").mockImplementation(() => { relayed.push(id); return { messageId: "m", turnId: "t" } as any; });
      core.deliverInboxes();
      expect(relayed).toEqual([PROJECT]);
      expect(core.whiteboard().bots.map((bot) => bot.botId)).not.toContain(SUB);
      expect(core.waiting().items.map((item) => item.botId)).not.toContain(SUB);
      expect(await core.addProject(h.folder)).toEqual({ botId: PROJECT, added: false });
    } finally { await core.shutdown(); }
  });

  it("is listed in the project bot's wake note with its progress file, and only there", async () => {
    const h = fixture(), core = h.open();
    try {
      mkdirSync(join(h.folder, ".bot", "subagents", "a1b2c3"), { recursive: true });
      writeFileSync(progressFile(h.folder, "a1b2c3"), "Status: working\n");
      const note = (core as any).subBotNote((core as any).profiles.find((p: any) => p.id === PROJECT));
      expect(note).toContain(`Settings page (working): progress file ${progressFile(h.folder, "a1b2c3")}`);
      expect((core as any).subBotNote((core as any).profiles.find((p: any) => p.id === SUB))).toBe("");
    } finally { await core.shutdown(); }
  });

  it("removing the project bot removes its sub bots", async () => {
    const h = fixture(), core = h.open();
    try {
      await core.removeBot(PROJECT);
      expect(bots(core).has(SUB)).toBe(false);
      expect(core.snapshot().bots.map((bot) => bot.id)).not.toContain(SUB);
    } finally { await core.shutdown(); }
  });

  it("tells its project bot once when its progress file says done", async () => {
    const h = fixture(), core = h.open();
    try {
      mkdirSync(join(h.folder, ".bot", "subagents", "a1b2c3"), { recursive: true });
      const parent = bots(core).get(PROJECT)!;
      const notice = vi.spyOn(parent, "appNotice");
      const note = vi.spyOn(parent, "queueNote");
      const sub = bots(core).get(SUB)!;
      writeFileSync(progressFile(h.folder, "a1b2c3"), "Status: working\n");
      (core as any).subBotReplied(sub);
      expect(notice).not.toHaveBeenCalled();
      writeFileSync(progressFile(h.folder, "a1b2c3"), "Status: done\nall shipped\n");
      (core as any).subBotReplied(sub);
      (core as any).subBotReplied(sub);
      expect(notice).toHaveBeenCalledTimes(1);
      expect(note.mock.calls[0]![0]).toContain("Settings page");
    } finally { await core.shutdown(); }
  });
});

describe("making a sub bot from a subagent", () => {
  const found = (over: Record<string, unknown> = {}) => ({ id: "toolu_1", status: "running" as const, head: "claude" as const, engine: "claude" as const, description: "build settings", prompt: "Build the settings page", result: "", steps: [], threadId: null, run: null, ...over });

  async function run(opts: { statuses: string[]; head?: string; engine?: string; subagent?: unknown; handoffBefore?: boolean; parentId?: string; mode?: "ask" | "steer" | "stop"; heads?: string[]; over?: Record<string, unknown>; wrapUp?: (text: string, statuses: string[]) => void }) {
    const h = fixture({ sub: false }), core = h.open({ subBotWaitMs: 100 });
    const parent = bots(core).get(opts.parentId ?? PROJECT)!;
    const statuses = [...opts.statuses];
    const lookup = opts.subagent === null ? () => null : () => found({ status: statuses.length > 1 ? statuses.shift() : statuses[0], ...(opts.head ? { head: opts.head } : {}), ...(opts.engine ? { engine: opts.engine } : {}), ...(opts.over ?? {}) });
    vi.spyOn(parent, "findSubagent").mockImplementation(lookup as any);
    vi.spyOn(parent, "handoffMode").mockImplementation(() => opts.mode ?? "ask");
    if (opts.heads) vi.spyOn(parent, "headEngines", "get").mockReturnValue(opts.heads as any);
    const asks: string[] = [];
    vi.spyOn(parent, "askForHandoff").mockImplementation(((_id: string, text: string) => { asks.push(text); opts.wrapUp?.(text, statuses); return true; }) as any);
    const stop = vi.spyOn(parent, "stopForHandoff").mockImplementation(async () => { statuses.splice(0, statuses.length, "stopped"); });
    const notices: string[] = [];
    vi.spyOn(parent, "appNotice").mockImplementation(((text: string) => { notices.push(text); return "n"; }) as any);
    vi.spyOn(parent, "queueNote").mockImplementation(() => {});
    const relays: { text: string; id: string }[] = [];
    vi.spyOn(Bot.prototype, "relay").mockImplementation(function (this: Bot, text: string) { relays.push({ text, id: this.id }); return { messageId: "m", turnId: "t" } as any; });
    const file = handoffFile(h.folder, "agent-1");
    if (opts.handoffBefore) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, "# written by the subagent\nnext: finish tabs"); }
    await (core as any).subBotRequested(parent, { name: "Settings page", subagent: "agent-1", note: "" });
    return { h, core, notices, relays, stop, asks, file, subs: [...bots(core).values()].filter((bot) => bot.profile.parent) };
  }

  it("a subagent that wrote its handoff and ended becomes a hidden sub bot that is told to read it", async () => {
    const r = await run({ statuses: ["running", "completed"], handoffBefore: true });
    try {
      expect(r.stop).not.toHaveBeenCalled();
      expect(r.subs).toHaveLength(1);
      const sub = r.subs[0]!;
      expect(sub.profile.parent).toBe(PROJECT);
      expect(sub.profile.folder).toBe(r.h.folder);
      expect(readFileSync(r.file, "utf8")).toContain("written by the subagent");
      expect(readFileSync(progressFile(r.h.folder, "agent-1"), "utf8")).toBe("Status: working\n");
      expect(r.relays).toHaveLength(1);
      expect(r.relays[0]!.id).toBe(sub.id);
      expect(r.relays[0]!.text).toContain(r.file);
      expect(r.relays[0]!.text).toContain(progressFile(r.h.folder, "agent-1"));
      expect(r.notices.join("\n")).toContain('Moved "build settings" to the sub bot "Settings page"');
      // It is saved: a restart finds it again under its project bot.
      const rows = JSON.parse(readFileSync(join(r.h.dir, "projects.json"), "utf8"));
      expect(rows.find((row: any) => row.id === sub.id)).toMatchObject({ parent: PROJECT, handoff: "agent-1" });
      expect(r.core.snapshot().bots.find((bot) => bot.id === PROJECT)!.subagentRows.some((row) => row.subBot === sub.id)).toBe(true);
    } finally { vi.restoreAllMocks(); await r.core.shutdown(); }
  });

  it("a subagent still running at the deadline: the turn is stopped and the app writes handoff.md from the known steps", async () => {
    const r = await run({ statuses: ["running"] });
    try {
      expect(r.stop).toHaveBeenCalledWith("toolu_1");
      expect(readFileSync(r.file, "utf8")).toContain("Build the settings page");
      expect(readFileSync(r.file, "utf8")).toContain("did not end in time");
      expect(r.subs).toHaveLength(1);
      expect(r.notices.join("\n")).toContain("did not end in time");
    } finally { vi.restoreAllMocks(); await r.core.shutdown(); }
  });

  it("a Codex worker is asked by the app to write handoff.md and end; no stop, and the sub bot runs on Codex", async () => {
    const r = await run({ statuses: ["running"], head: "codex", engine: "codex", mode: "steer", heads: ["claude", "codex"], handoffBefore: true,
      wrapUp: (_text, statuses) => { statuses.splice(0, statuses.length, "completed"); } });
    try {
      expect(r.asks).toHaveLength(1);
      expect(r.asks[0]).toContain(r.file);
      expect(r.stop).not.toHaveBeenCalled();
      expect(r.subs).toHaveLength(1);
      expect(readFileSync(r.file, "utf8")).toContain("written by the subagent");
      expect(r.subs[0]!.engine).toBe("codex");
      expect(r.relays[0]!.text).toContain(r.file);
      const settings = JSON.parse(readFileSync(join(Layout.bot(r.h.dir, r.subs[0]!.id), "bot.json"), "utf8"));
      expect(settings.engine).toBe("codex");
      expect(settings.heads.engines).toEqual(["codex"]);
    } finally { vi.restoreAllMocks(); await r.core.shutdown(); }
  });

  it("a Codex worker that ignores the request is cancelled at the deadline and handoff.md is written from its record", async () => {
    const r = await run({ statuses: ["running"], head: "codex", engine: "codex", mode: "steer", heads: ["claude", "codex"], over: { steps: [{ id: "1", kind: "tool", tool: "Bash", title: "npm test", done: true, failed: false }], threadId: "thr-1", run: 3 } });
    try {
      expect(r.asks).toHaveLength(1);
      expect(r.stop).toHaveBeenCalledWith("toolu_1");
      const text = readFileSync(r.file, "utf8");
      expect(text).toContain("did not end in time");
      expect(text).toContain("Bash: npm test");
      expect(text).toContain("thread thr-1");
      expect(r.subs).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await r.core.shutdown(); }
  });

  it("a busy Antigravity worker takes no message: it is stopped at once and handoff.md is written from its record", async () => {
    const started = Date.now();
    const r = await run({ statuses: ["running"], head: "agy", engine: "agy", mode: "stop", heads: ["agy"], over: { result: "half done" } });
    try {
      expect(Date.now() - started).toBeLessThan(90);
      expect(r.asks).toEqual([]);
      expect(r.stop).toHaveBeenCalledWith("toolu_1");
      const text = readFileSync(r.file, "utf8");
      expect(text).toContain("cannot take a message");
      expect(text).toContain("half done");
      expect(r.subs).toHaveLength(1);
      expect(r.subs[0]!.engine).toBe("agy");
      expect(r.notices.join("\n")).toContain("stopped at once");
    } finally { vi.restoreAllMocks(); await r.core.shutdown(); }
  });

  it("an Antigravity worker that already finished moves from its record, without a stop", async () => {
    const r = await run({ statuses: ["completed"], head: "agy", engine: "agy", mode: "stop", heads: ["agy"], over: { result: "all done" } });
    try {
      expect(r.stop).not.toHaveBeenCalled();
      expect(readFileSync(r.file, "utf8")).toContain("all done");
      expect(r.subs).toHaveLength(1);
    } finally { vi.restoreAllMocks(); await r.core.shutdown(); }
  });

  it("a worker whose engine the project bot does not have becomes a sub bot on the project bot's engine, and says so", async () => {
    const r = await run({ statuses: ["completed"], head: "claude", engine: "codex", mode: "ask", heads: ["claude"], over: { result: "done" } });
    try {
      expect(r.subs).toHaveLength(1);
      expect(r.subs[0]!.engine).toBe("claude");
      expect(r.notices.join("\n")).toMatch(/Codex is not one of this project bot's engines/);
    } finally { vi.restoreAllMocks(); await r.core.shutdown(); }
  });

  it("refuses an unknown subagent, one that ended without any record, and a sub bot or the main bot as the asker, saying why", async () => {
    for (const [what, opts, why] of [
      ["unknown", { statuses: ["running"], subagent: null }, /no subagent/],
      ["codex ended, no record", { statuses: ["completed"], head: "codex", engine: "codex", mode: "steer" }, /no record/],
      ["agy ended, no record", { statuses: ["failed"], head: "agy", engine: "agy", mode: "stop" }, /no record/],
      ["main", { statuses: ["running"], parentId: MAIN_BOT_ID }, /only a project/],
    ] as const) {
      const r = await run(opts as any);
      try {
        expect(r.subs, what).toHaveLength(0);
        expect(r.notices.join("\n"), what).toMatch(/No sub bot was made/);
        expect(r.notices.join("\n"), what).toMatch(why);
        expect(r.stop, what).not.toHaveBeenCalled();
        expect(r.asks, what).toEqual([]);
        expect(existsSync(r.file), what).toBe(false);
      } finally { vi.restoreAllMocks(); await r.core.shutdown(); }
    }
  });

  it("will not move the same subagent twice", async () => {
    const h = fixture({ sub: false }), core = h.open({ subBotWaitMs: 50 });
    const parent = bots(core).get(PROJECT)!;
    vi.spyOn(parent, "findSubagent").mockImplementation((() => found({ status: "completed", result: "done" })) as any);
    const notices: string[] = [];
    vi.spyOn(parent, "appNotice").mockImplementation(((text: string) => { notices.push(text); return "n"; }) as any);
    vi.spyOn(Bot.prototype, "relay").mockImplementation((() => ({ messageId: "m", turnId: "t" })) as any);
    try {
      await (core as any).subBotRequested(parent, { name: "A", subagent: "agent-1", note: "" });
      await (core as any).subBotRequested(parent, { name: "B", subagent: "agent-1", note: "" });
      expect([...bots(core).values()].filter((bot) => bot.profile.parent)).toHaveLength(1);
      expect(notices.at(-1)).toMatch(/already moved/);
    } finally { vi.restoreAllMocks(); await core.shutdown(); }
  });
});

describe("prompts", () => {
  const manager = { name: "botling", role: "manager" as "main" | "manager" | "bot", folder: "/p", memoryPath: ".bot/memory.md", job: null, id: PROJECT };
  const desktop = (profile: typeof manager, engine: "claude" | "codex" | "agy" = "claude") => desktopPrompts(botPrompts({ profile, engine }), profile, null, engine).system;
  it("leaves the Swift prompts alone: only the desktop layer adds the sub-bot text", () => {
    expect(botPrompts({ profile: manager }).system).not.toContain("<sub-bot");
    expect(botPrompts({ profile: manager }).system).toContain("In .bot/ only .bot/memory.md, .bot/routines.cron, inbox.md and artifacts/ are yours");
  });
  it("a Claude project bot is told how to move a subagent out, and may write handoff.md and progress.md", () => {
    const system = desktop(manager);
    expect(system).toContain("<sub-bot name=");
    expect(system).toContain("SendMessage");
    expect(system).toContain("handoff.md and progress.md files under .bot/subagents/<id>/ are yours");
    expect(system).toContain("inbox.md, artifacts/");
  });
  it("Codex and Antigravity project bots are offered the tag for their app-managed workers, and may write handoff.md and progress.md", () => {
    for (const engine of ["codex", "agy"] as const) {
      const system = desktop(manager, engine);
      expect(system, engine).toContain("<sub-bot name=");
      expect(system, engine).toContain("task_id");
      expect(system, engine).toContain("Do not message or cancel the worker yourself");
      expect(system, engine).toContain("handoff.md and progress.md files under .bot/subagents/<id>/");
      expect(system, engine).not.toContain("SendMessage");
    }
  });
  it("a Codex or Antigravity sub bot reads the handoff and keeps progress.md too", () => {
    const profile = { ...manager, name: "Settings page", role: "bot" as "main" | "manager" | "bot", job: "Continue it", id: SUB, parent: PROJECT, memoryPath: `.bot/sub-bots/${SUB}/memory.md` };
    for (const engine of ["codex", "agy"] as const) {
      const system = desktopPrompts(botPrompts({ profile, parentName: "botling", engine }), profile, null, engine).system;
      expect(system, engine).toContain("sub bot");
      expect(system, engine).toContain("progress.md");
      expect(system, engine).toContain(SUB_BOT_RELAY_PREFIX);
      expect(system, engine).not.toContain("<sub-bot name=");
    }
  });
  it("the main bot and Maintainer are not offered it", () => {
    expect(desktop({ ...manager, role: "main", id: MAIN_BOT_ID })).not.toContain("<sub-bot");
    expect(desktop({ ...manager, id: "DEC0DE00-0000-4000-8000-00000000DEC0" })).not.toContain("<sub-bot");
  });
  it("a sub bot reads the handoff, keeps progress.md, reports to its project bot, and is not told it works for the main bot", () => {
    const profile = { ...manager, name: "Settings page", role: "bot" as "main" | "manager" | "bot", job: "Continue it", id: SUB, parent: PROJECT, memoryPath: `.bot/sub-bots/${SUB}/memory.md` };
    const system = desktopPrompts(botPrompts({ profile, parentName: "botling" }), profile).system;
    expect(system).toContain("a sub bot");
    expect(system).toContain('"botling"');
    expect(system).toContain("progress.md");
    expect(system).toContain(SUB_BOT_RELAY_PREFIX);
    expect(system).not.toContain(RELAY_PREFIX);
    expect(system).not.toContain("<sub-bot name=");
    expect(system).toContain(`.bot/sub-bots/${SUB}/routines.cron`);
  });
});
