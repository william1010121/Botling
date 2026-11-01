// Owner routing in the core (A2, through WorkerHost and the registry only), the same scenarios for a worker hosted by a Codex,
// an Antigravity and a Claude bot (a fake WorkerHost): the host learns the new owner before the commit, reports and approvals go to
// the owner, the host's turns do not hear of it, an undelivered report is handed over again after a restart.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Core } from "../../src/core/server";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { fixture, messages, notices, OTHER, PROJECT, relays, rows, stubTurns, turns, W1, W2 } from "../agent-owner-fake";

const opened: Core[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const core of opened.splice(0)) await core.shutdown(); });

describe.each(["codex", "agy", "claude"] as const)("a worker hosted by a %s bot, moved to another bot", (engine) => {
  const open = () => { stubTurns(); const f = fixture(engine); opened.push(f.core); return f; };

  it("its host learns the owner before the commit; its report reaches the owner (not the host) and is delivered once its turn starts", async () => {
    const f = open();
    const moved = await f.core.moveAgent(PROJECT, W1, { kind: "bot", botId: OTHER });
    expect(f.host.owners.get(W1)).toEqual({ botId: OTHER, name: "Helper", agentId: moved.agentId });
    const hostBot = f.bots.get(PROJECT)!;
    (hostBot as any).workerReported({ kind: "workerReport", id: W1, run: 1, engine, status: "completed", report: "Found 3 endpoints." });
    expect(messages.filter((m) => m.id === PROJECT)).toEqual([]);
    const [note] = messages.filter((m) => m.id === OTHER);
    expect(note!.text).toContain("Found 3 endpoints.");
    expect(note!.text).toContain(`<agent-message to="${moved.agentId}">`);
    expect(note!.text).toContain(`<agent-stop to="${moved.agentId}"/>`);
    // A duplicate of the same run is not told twice.
    (hostBot as any).workerReported({ kind: "workerReport", id: W1, run: 1, engine, status: "completed", report: "Found 3 endpoints." });
    expect(messages.filter((m) => m.id === OTHER)).toHaveLength(1);
    expect(f.registry.get(moved.agentId)!.relay.report).toEqual({ run: 1, delivered: false });
    (f.core as any).event({ type: "turn.started", botId: OTHER, turnId: `turn-${turns}`, messageId: "m", head: "claude" });
    expect(f.registry.get(moved.agentId)!.relay.report).toEqual({ run: 1, delivered: true });
  });

  it("an undelivered report is handed to the owner again after a restart, once", async () => {
    const f = open();
    const moved = await f.core.moveAgent(PROJECT, W1, { kind: "bot", botId: OTHER });
    (f.bots.get(PROJECT) as any).workerReported({ kind: "workerReport", id: W1, run: 1, engine, status: "failed", report: "Broke." });
    await f.core.shutdown(); opened.pop();
    messages.length = 0;
    const again = new Core({ dataDir: f.dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true, routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
    opened.push(again);
    (again as any).reconcileAgents(true);
    (again as any).reconcileAgents(true);
    expect(messages.filter((m) => m.id === OTHER)).toHaveLength(1);
    expect(messages[0]!.text).toContain("Broke.");
    expect(messages[0]!.text).toContain(moved.agentId);
  });

  it("the host's turns do not hear of it ending, and its approvals are asked in the owner's chat", async () => {
    const f = open();
    await f.core.moveAgent(PROJECT, W1, { kind: "bot", botId: OTHER });
    const hostBot = f.bots.get(PROJECT)! as any;
    const answers: unknown[][] = [];
    const head = { running: true, answer: (...args: unknown[]) => answers.push(args) };
    expect(hostBot.routeWorkerApproval(head, { kind: "permission", requestId: `worker:${W1}:1:r1`, tool: "Bash", summary: "rm -rf build", input: { command: "rm -rf build" }, workerId: W1 })).toBe(true);
    expect(hostBot.approvals.size).toBe(0);
    const owner = f.bots.get(OTHER)! as any;
    const card = (owner.records as any[]).findLast((r) => r.permissionTool === "Bash");
    expect(card.text).toContain("rm -rf build");
    expect(owner.choose(card.id, 0).accepted).toBe(true);
    expect(answers).toEqual([[`worker:${W1}:1:r1`, true, { command: "rm -rf build" }, undefined]]);
    // Its own worker (not moved) still asks in the host's chat.
    expect(hostBot.routeWorkerApproval(head, { kind: "permission", requestId: `worker:${W2}:1:r2`, tool: "Bash", summary: "ls", input: { command: "ls" }, workerId: W2 })).toBe(false);
    // Ending: nothing for the host's next turn to report.
    hostBot.subagents.get(W1).status = "completed";
    hostBot.subagentEnded(W1);
    expect(hostBot.pendingEnded).not.toContain(W1);
  });

  it("a host that refuses the owner change leaves the move undone", async () => {
    const f = open();
    f.host.refuseOwner.add(W1);
    await expect(f.core.moveAgent(PROJECT, W1, { kind: "newSubBot", name: "API" })).rejects.toThrow(/being handed over/);
    expect(f.registry.byNative(PROJECT, engine, W1)!.owner.botId).toBe(PROJECT);
    expect([...f.bots.values()].filter((bot) => bot.profile.parent)).toHaveLength(0);
    expect(f.registry.pendingMoves).toEqual([]);
  });

});
