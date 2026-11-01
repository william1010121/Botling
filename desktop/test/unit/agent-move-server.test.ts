// "Move to…" in the core (A1): a Codex worker's row moves to a new sub bot (it keeps running on its host), the host no
// longer lists it, the owner does (with its host), its view reads from the host, the notices land once in each chat,
// and a move cut short by a crash rolls back before its commit and is not told twice after it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import { Bot } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { Layout } from "../../src/core/store/workspace";
import { INDEX_FORMAT, subagentFileName } from "../../src/core/store/subagent-store";
import { newMoveId, type AgentRegistry, type MoveIntent } from "../../src/core/agent-registry";
import { BotView } from "../../src/contract";
import { tempDir } from "../helpers";

const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const OTHER = "C0FFEE00-0000-4000-8000-000000000009";
const WORKER = "task-worker-1";

function fixture(settings: Record<string, unknown> = { agentMoves: true }) {
  const dir = tempDir("agent-move");
  const folder = tempDir("agent-move-project");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  writeFileSync(Layout.settings(dir), JSON.stringify(settings));
  saveProjectRow(dir, { id: PROJECT, name: "botling", folder, avatar: "triangle" });
  saveProjectRow(dir, { id: OTHER, name: "Helper", folder, avatar: "square", job: "helps" });
  const store = Layout.bot(dir, PROJECT);
  mkdirSync(join(store, "subagents"), { recursive: true });
  writeFileSync(join(store, "bot.json"), JSON.stringify({ engine: "codex", heads: { engines: ["codex"] } }));
  writeFileSync(join(store, "subagents.json"), JSON.stringify({ format: INDEX_FORMAT, subagents: [
    { id: WORKER, description: "Research the API", prompt: "Find the endpoints", status: "completed", background: true, startedAt: 800_000_000, endedAt: 800_000_100, type: "codex-worker",
      result: "Found 3 endpoints.\nDetails follow.", execution: { run: 1, ownerSessionId: "coord", threadId: "th-1", turnId: null }, stepCount: 1, toolCount: 1 },
  ] }));
  writeFileSync(join(store, "subagents", subagentFileName(WORKER)), JSON.stringify({ k: "step", step: { id: "s1", kind: "tool", tool: "Bash", title: "curl /api", done: true } }) + "\n");
  const open = () => new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  return { dir, folder, open };
}
const bots = (core: Core): Map<string, Bot> => (core as any).bots;
const registry = (core: Core): AgentRegistry => (core as any).agents;
const rows = (core: Core, id: string) => core.snapshot().bots.find((bot) => bot.id === id)!.subagentRows;
const notices = (core: Core, id: string, pattern: RegExp) => ((bots(core).get(id) as any).records as { role: string; text: string }[]).filter((r) => r.role === "notice" && pattern.test(r.text));

const relays: { id: string; text: string }[] = [];
function stubRelay() {
  relays.length = 0;
  vi.spyOn(Bot.prototype, "relay").mockImplementation(function (this: Bot, text: string) { relays.push({ id: this.id, text }); return { messageId: "m", turnId: "t" } as any; });
}
afterEach(() => { vi.restoreAllMocks(); });

describe("moving a Codex worker to a new sub bot", () => {
  it("leaves the host's rows, lists it under the sub bot with its host, views it from the host, and tells each chat once", async () => {
    stubRelay();
    const h = fixture(), core = h.open();
    try {
      const before = rows(core, PROJECT).find((row) => row.id === WORKER)!;
      expect(before.movable).toEqual({ ok: true, reason: null });
      expect(before.agentId).toMatch(/^ag-/);
      const targets = core.agentTargets(PROJECT, WORKER);
      expect(targets.engine).toBe("codex");
      expect(targets.targets.map((t) => t.kind)).toEqual(["newSubBot", "bot"]);
      expect(targets.targets.find((t) => t.botId === OTHER)).toMatchObject({ disabled: null, mode: "owner", sameFolder: true });

      const moved = await core.moveAgent(PROJECT, WORKER, { kind: "newSubBot", name: "API owner" });
      expect(moved.mode).toBe("owner");
      const sub = [...bots(core).values()].find((bot) => bot.profile.parent === PROJECT)!;
      expect(moved.ownerBotId).toBe(sub.id);
      // Codex runs it still: the sub bot runs on the worker's engine.
      expect(sub.engine).toBe("codex");

      expect(rows(core, PROJECT).map((row) => row.id)).not.toContain(WORKER);
      const subView = core.snapshot().bots.find((bot) => bot.id === sub.id)!;
      expect(BotView.safeParse(subView).success).toBe(true);
      expect(subView.subagentRows.find((row) => row.id === WORKER)).toMatchObject({ host: { botId: PROJECT, name: "botling" }, status: "completed", agentId: moved.agentId, title: "Research the API" });

      const view = (core as any).agentView(sub.id, WORKER).subagent;
      expect(view).toMatchObject({ owner: "API owner", host: "botling", title: "Research the API" });
      expect(view.steps.map((step: { title: string }) => step.title)).toContain("curl /api");

      expect(notices(core, PROJECT, /^Moved "Research the API" to API owner\. It keeps running on botling; its reports now go to API owner\.$/)).toHaveLength(1);
      expect(notices(core, sub.id, /^botling handed you "Research the API" \(Codex, idle\)\. It runs on botling in .*\. Status: .*status\.md$/)).toHaveLength(1);
      expect(relays.filter((r) => r.id === sub.id)).toHaveLength(1);
      expect(relays[0]!.text).toContain('You are the sub bot "API owner"');
      const status = join(h.folder, ".bot", "agents", moved.agentId, "status.md");
      expect(existsSync(status)).toBe(true);
      expect(readFileSync(status, "utf8")).toContain("curl /api");
      // The owner's wake note lists it.
      expect((core as any).ownedAgentsNote(sub.profile)).toContain(`"Research the API" (${WORKER}, Codex, on botling, idle): status file ${status}`);

      // Settled on the owner's side, then back to its host.
      expect(bots(core).get(sub.id)!.settleSubagent(WORKER, true)).toEqual({ changed: true });
      expect(rows(core, sub.id).find((row) => row.id === WORKER)!.settled).toBe(true);
      await core.moveAgent(sub.id, WORKER, { kind: "back" });
      expect(rows(core, sub.id).map((row) => row.id)).not.toContain(WORKER);
      expect(rows(core, PROJECT).map((row) => row.id)).toContain(WORKER);
      expect(notices(core, PROJECT, /gave "Research the API" back/)).toHaveLength(1);
    } finally { await core.shutdown(); }
  });

  it("is refused while agentMoves is turned off (it is on by default), and its rows say nothing of moving", async () => {
    const on = fixture({}), core0 = on.open();
    try { expect(rows(core0, PROJECT).find((row) => row.id === WORKER)!.movable).toEqual({ ok: true, reason: null }); } finally { await core0.shutdown(); }
    const h = fixture({ agentMoves: false }), core = h.open();
    try {
      expect(rows(core, PROJECT).find((row) => row.id === WORKER)!.movable).toBeUndefined();
      expect(() => core.agentTargets(PROJECT, WORKER)).toThrow(/agentMoves/);
      await expect(core.moveAgent(PROJECT, WORKER, { kind: "bot", botId: OTHER })).rejects.toThrow(/agentMoves/);
    } finally { await core.shutdown(); }
  });
});

describe("a move cut short", () => {
  it("rolls back when the core stops between its intent and its commit", async () => {
    stubRelay();
    const h = fixture();
    let core = h.open();
    const agent = registry(core).byNative(PROJECT, "codex", WORKER)!;
    const intent: MoveIntent = { id: newMoveId(), agentId: agent.id, kind: "owner", from: { owner: { botId: PROJECT, engine: "codex" } }, to: { owner: { botId: OTHER, engine: "claude" } }, phase: "intent", at: Date.now() };
    registry(core).beginMove(intent);
    await core.shutdown();
    core = h.open();
    try {
      (core as any).reconcileAgents(true);
      expect(registry(core).pendingMoves).toEqual([]);
      expect(registry(core).get(agent.id)!.owner.botId).toBe(PROJECT);
      expect(rows(core, PROJECT).map((row) => row.id)).toContain(WORKER);
      expect(rows(core, OTHER).map((row) => row.id)).not.toContain(WORKER);
      expect(notices(core, OTHER, /handed you/)).toHaveLength(0);
    } finally { await core.shutdown(); }
  });

  it("a failure before the commit leaves the owner as it was and says why", async () => {
    stubRelay();
    const h = fixture(), core = h.open();
    try {
      vi.spyOn(core, "makeSubBot").mockImplementation(() => { throw new Error("disk full"); });
      await expect(core.moveAgent(PROJECT, WORKER, { kind: "newSubBot", name: "X" })).rejects.toThrow(/It was not moved: disk full/);
      expect(registry(core).pendingMoves).toEqual([]);
      expect(rows(core, PROJECT).map((row) => row.id)).toContain(WORKER);
    } finally { await core.shutdown(); }
  });

  it("after its commit, the next start finishes it without telling anyone twice", async () => {
    stubRelay();
    const h = fixture();
    let core = h.open();
    const real = registry(core).setPhase.bind(registry(core));
    // The notices go out, then the core stops before the move is marked notified.
    vi.spyOn(registry(core), "setPhase").mockImplementation((id, phase) => { if (phase === "notified") throw new Error("crash"); real(id, phase); });
    await core.moveAgent(PROJECT, WORKER, { kind: "bot", botId: OTHER });
    expect(registry(core).pendingMoves.map((move) => move.phase)).toEqual(["committed"]);
    expect(notices(core, PROJECT, /^Moved "Research the API" to Helper/)).toHaveLength(1);
    expect(notices(core, OTHER, /^botling handed you/)).toHaveLength(1);
    await core.shutdown();
    vi.restoreAllMocks();
    stubRelay();
    core = h.open();
    try {
      (core as any).reconcileAgents(true);
      expect(registry(core).pendingMoves).toEqual([]);
      expect(notices(core, PROJECT, /^Moved "Research the API" to Helper/)).toHaveLength(1);
      expect(notices(core, OTHER, /^botling handed you/)).toHaveLength(1);
      expect(relays).toEqual([]);
      expect(rows(core, OTHER).find((row) => row.id === WORKER)).toMatchObject({ host: { botId: PROJECT } });
      expect(rows(core, PROJECT).map((row) => row.id)).not.toContain(WORKER);
    } finally { await core.shutdown(); }
  });
});

describe("removing a bot", () => {
  it("an agent it owned goes back to its host; one it ran for another owner is lost and that owner is told", async () => {
    stubRelay();
    const h = fixture(), core = h.open();
    try {
      await core.moveAgent(PROJECT, WORKER, { kind: "bot", botId: OTHER });
      await core.removeBot(OTHER);
      expect(registry(core).byNative(PROJECT, "codex", WORKER)!.owner.botId).toBe(PROJECT);
      expect(rows(core, PROJECT).map((row) => row.id)).toContain(WORKER);
      expect(notices(core, PROJECT, /is yours again: Helper, which owned it, was removed/)).toHaveLength(1);
    } finally { await core.shutdown(); }
  });
});
