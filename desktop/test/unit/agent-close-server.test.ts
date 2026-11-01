// "Close sub bot": its workers go back to their host (or are listed as stopped when that is gone), for workers hosted by a Codex,
// an Antigravity and a Claude bot.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Core } from "../../src/core/server";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { fixture, messages, notices, OTHER, PROJECT, relays, rows, stubTurns, turns, W1, W2 } from "../agent-owner-fake";

const opened: Core[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const core of opened.splice(0)) await core.shutdown(); });

describe.each(["codex", "agy", "claude"] as const)("a worker hosted by a %s bot, moved to another bot", (engine) => {
  const open = () => { stubTurns(); const f = fixture(engine); opened.push(f.core); return f; };

  it("closing the sub bot gives its workers back to their host and the project bot's chat says so", async () => {
    const f = open();
    const group = await f.core.groupAgents(PROJECT, [W1, W2], { kind: "newSubBot", name: "Client" });
    const subId = group.ownerBotId;
    await expect(f.core.closeSubBot(PROJECT)).rejects.toThrow(/Only a sub bot/);
    const closed = await f.core.closeSubBot(subId);
    expect(closed).toEqual({ closed: true, parentBotId: PROJECT, returned: 2, stopped: 0 });
    expect(f.bots.has(subId)).toBe(false);
    expect(f.host.owners.get(W1) ?? null).toBeNull();
    expect(f.host.owners.get(W2) ?? null).toBeNull();
    expect(f.registry.byNative(PROJECT, engine, W1)!.owner.botId).toBe(PROJECT);
    expect(rows(f.core, PROJECT).filter((row) => !row.subBot).map((row) => row.id).sort()).toEqual([W1, W2]);
    expect(notices(f.bots, PROJECT, /^Closed the sub bot "Client"\. Back with their host: "Research the API" \(botling\), "Write the client" \(botling\)\.$/)).toHaveLength(1);
    // The main bot is not told of a removal.
    expect(notices(f.bots, MAIN_BOT_ID, /Removed the bot "Client"/)).toHaveLength(0);
  });
});

describe("closing a sub bot whose agents' host is gone", () => {
  it("lists them as stopped, saying why", async () => {
    stubTurns();
    const f = fixture("codex"); opened.push(f.core);
    const moved = await f.core.moveAgent(PROJECT, W1, { kind: "bot", botId: OTHER });
    // A sub bot of Helper owns it now; then the bot that runs it (botling) goes away.
    const group = await f.core.groupAgents(OTHER, [W1], { kind: "newSubBot", name: "Owner" });
    expect(f.registry.get(moved.agentId)!.owner.botId).toBe(group.ownerBotId);
    f.registry.botRemoved(PROJECT, (id) => id !== PROJECT);
    const closed = await f.core.closeSubBot(group.ownerBotId);
    expect(closed).toMatchObject({ returned: 0, stopped: 1 });
    expect(notices(f.bots, OTHER, /Stopped: "Research the API" \(the bot that ran it is gone\)/)).toHaveLength(1);
  });
});
