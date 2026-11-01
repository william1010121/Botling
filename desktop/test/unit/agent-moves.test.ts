// planMove (A1.6): engine × state × background × target. An owner move keeps the agent where it runs; a Claude
// subagent's work moves only by the sub-bot hand-off until claudeOwnerMoves (A3).
import { describe, expect, it } from "vitest";
import { planMove, unmovable, type BotFacts, type MoveFacts, type MoveTarget } from "../../src/core/agent-moves";
import type { AgentEngine, AgentRecord, AgentState } from "../../src/core/agent-registry";

const bot = (id: string, more: Partial<BotFacts> = {}): BotFacts => ({ id, name: id, role: "manager", parent: null, maintainer: false, problem: null, folder: `/w/${id}`, engine: "claude", heads: ["claude"], ...more });
const project = bot("project", { engine: "codex", heads: ["codex", "claude"] });
const other = bot("other", { role: "bot" });
const subBot = bot("sub", { role: "bot", parent: "project", folder: "/w/project" });
const main = bot("main", { role: "main" });
const maintainer = bot("maint", { maintainer: true });

function record(engine: AgentEngine, state: AgentState, background: boolean, owner = project, host = project): AgentRecord {
  return {
    v: 1, id: "ag-1", nativeId: "n1", engine, background,
    owner: { botId: owner.id, engine: owner.engine, since: 0, history: [] },
    host: { botId: host.id, engine: host.engine, kind: engine === "claude" ? "claude-sidechain" : engine === "codex" ? "codex-thread" : "agy-acp", sessionId: null, folder: host.folder },
    handle: { kind: "codex-thread", threadId: null, coordinatorSessionId: "", run: 1 },
    promptHash: null, model: null, effort: null, state,
    summary: { description: "d", prompt: "p", lastReport: null, stepCount: 0, toolCount: 0, lastStepAt: null, statusFile: null, handoffFile: null },
    relay: { muted: false, pendingMessages: [], report: null }, ownerView: { settledAt: null, unsettledAt: null },
    createdAt: 0, updatedAt: 0, endedAt: null, rev: 1,
  };
}

const bots = new Map([project, other, subBot, main, maintainer].map((b) => [b.id, b]));
function facts(rec: AgentRecord, to: MoveTarget, more: Partial<MoveFacts> = {}): MoveFacts {
  const owner = bots.get(rec.owner.botId)!;
  return { owner, host: bots.get(rec.host.botId) ?? null, ...(to.kind === "bot" ? { target: bots.get(to.botId) ?? null } : {}), project: owner.parent ? bots.get(owner.parent)! : owner, pending: false, claudeOwnerMoves: false, ...more };
}
const plan = (rec: AgentRecord, to: MoveTarget, more: Partial<MoveFacts> = {}) => planMove(rec, to, facts(rec, to, more));
const toBot = (botId: string): MoveTarget => ({ kind: "bot", botId });
const toNew: MoveTarget = { kind: "newSubBot", name: "Docs" };

describe("Codex and Antigravity: owner moves in any state but lost", () => {
  const states: AgentState[] = ["running", "idle", "completed", "failed", "stopped", "interrupted", "reportPending"];
  for (const engine of ["codex", "agy"] as const) {
    for (const state of states) {
      it(`${engine} ${state} → another bot / a sub bot / a new sub bot`, () => {
        const rec = record(engine, state, true);
        expect(plan(rec, toBot("other"))).toEqual({ mode: "owner", to: { botId: "other", engine: "claude" } });
        expect(plan(rec, toBot("sub"))).toEqual({ mode: "owner", to: { botId: "sub", engine: "claude" } });
        const made = plan(rec, toNew);
        expect(made).toMatchObject({ mode: "owner", makeSubBot: { parentId: "project", name: "Docs" } });
      });
    }
    it(`${engine} lost: refused everywhere`, () => {
      const rec = record(engine, "lost", true);
      for (const to of [toBot("other"), toNew, { kind: "back" } as MoveTarget]) expect(plan(rec, to)).toEqual({ refuse: expect.stringMatching(/host is gone/) });
    });
  }

  it("a new sub bot runs on the agent's engine when the project bot has it, else the project bot's", () => {
    expect(plan(record("codex", "running", true), toNew)).toMatchObject({ makeSubBot: { engine: "codex" }, to: { engine: "codex" } });
    expect(plan(record("agy", "running", true), toNew)).toMatchObject({ makeSubBot: { engine: "codex", note: expect.stringMatching(/Antigravity is not one/) } });
  });

  it("an agent a sub bot owns gets a sibling sub bot under the same project bot", () => {
    const rec = record("codex", "idle", true, subBot, project);
    expect(plan(rec, toNew)).toMatchObject({ mode: "owner", makeSubBot: { parentId: "project" } });
  });

  it("back to its host when owned elsewhere (by name or by the host's id); not when it is with its host already", () => {
    const rec = record("codex", "running", true, other, project);
    expect(plan(rec, { kind: "back" })).toEqual({ mode: "owner", to: { botId: "project", engine: "codex" } });
    expect(plan(rec, toBot("project"))).toEqual({ mode: "owner", to: { botId: "project", engine: "codex" } });
    expect(plan(record("codex", "running", true), { kind: "back" })).toEqual({ refuse: "It is already with project." });
  });
});

describe("refusals for every engine", () => {
  for (const engine of ["claude", "codex", "agy"] as const) {
    it(`${engine}: same owner, the main bot, Maintainer, a missing bot, a pending move`, () => {
      const rec = record(engine, "running", true);
      expect(plan(rec, toBot("project"))).toEqual({ refuse: "It already belongs to project." });
      expect(plan(rec, toBot("main"))).toEqual({ refuse: expect.stringMatching(/main bot cannot take/) });
      expect(plan(rec, toBot("maint"))).toEqual({ refuse: expect.stringMatching(/Maintainer cannot take/) });
      expect(plan(rec, toBot("nobody"))).toEqual({ refuse: "There is no such bot." });
      expect(plan(rec, toBot("other"), { pending: true })).toEqual({ refuse: expect.stringMatching(/still under way/) });
    });
  }
  it("a target that cannot run, and a new sub bot with no name", () => {
    const rec = record("codex", "running", true);
    expect(planMove(rec, toBot("other"), { ...facts(rec, toBot("other")), target: { ...other, problem: "Its folder is not there." } })).toEqual({ refuse: expect.stringMatching(/cannot run now/) });
    expect(plan(rec, { kind: "newSubBot", name: "  " })).toEqual({ refuse: expect.stringMatching(/needs a name/) });
  });
  it("the main bot's and Maintainer's agents get no new sub bot", () => {
    expect(plan(record("codex", "running", true, main, main), toNew)).toEqual({ refuse: expect.stringMatching(/no sub bots/) });
    expect(plan(record("codex", "running", true, main, main), toBot("other"))).toMatchObject({ mode: "owner" });
  });
});

describe("Claude", () => {
  it("foreground, running or ended: only into a new sub bot, by the hand-off", () => {
    for (const state of ["running", "completed", "stopped"] as AgentState[]) {
      const rec = record("claude", state, false);
      expect(plan(rec, toNew)).toEqual({ mode: "handoff", to: { botId: "", engine: "codex" } });
      expect(plan(rec, toBot("other"))).toEqual({ refuse: expect.stringMatching(/only move into a new sub bot/) });
      expect(plan(rec, toBot("sub"))).toEqual({ refuse: expect.stringMatching(/only move into a new sub bot/) });
    }
  });
  it("background: the hand-off too until claudeOwnerMoves, then an owner move", () => {
    const rec = record("claude", "running", true);
    expect(plan(rec, toNew)).toMatchObject({ mode: "handoff" });
    expect(plan(rec, toBot("other"))).toEqual({ refuse: expect.stringMatching(/only move into a new sub bot/) });
    expect(plan(rec, toBot("other"), { claudeOwnerMoves: true })).toEqual({ mode: "owner", to: { botId: "other", engine: "claude" } });
    expect(plan(rec, toNew, { claudeOwnerMoves: true })).toMatchObject({ mode: "owner", makeSubBot: { parentId: "project" } });
  });
  it("a sub bot's, the main bot's and Maintainer's Claude subagents cannot move (no sub bot can be made from them)", () => {
    expect(plan(record("claude", "running", false, subBot, subBot), toNew)).toEqual({ refuse: expect.stringMatching(/sub bot cannot make another/) });
    expect(plan(record("claude", "running", false, main, main), toNew)).toEqual({ refuse: expect.stringMatching(/main bot's and Maintainer's/) });
    expect(plan(record("claude", "running", false, maintainer, maintainer), toNew)).toEqual({ refuse: expect.stringMatching(/main bot's and Maintainer's/) });
  });
  it("unmovable says why a row's ⋯ cannot move it", () => {
    expect(unmovable(record("claude", "running", false), { owner: project, pending: false, claudeOwnerMoves: false })).toBeNull();
    expect(unmovable(record("claude", "running", false, subBot, subBot), { owner: subBot, pending: false, claudeOwnerMoves: false })).toMatch(/sub bot/);
    expect(unmovable(record("codex", "running", true, subBot, subBot), { owner: subBot, pending: false, claudeOwnerMoves: false })).toBeNull();
    expect(unmovable(record("codex", "lost", true), { owner: project, pending: false, claudeOwnerMoves: false })).toMatch(/host is gone/);
  });
});
