// Several workers pulled into one new sub bot together (the Rail's "New sub bot with these…" and <sub-bot subagents="…">), all
// or none, for workers hosted by a Codex, an Antigravity and a Claude bot.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Core } from "../../src/core/server";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { fixture, messages, notices, OTHER, PROJECT, relays, rows, stubTurns, turns, W1, W2 } from "../agent-owner-fake";

const opened: Core[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const core of opened.splice(0)) await core.shutdown(); });

describe.each(["codex", "agy", "claude"] as const)("a worker hosted by a %s bot, moved to another bot", (engine) => {
  const open = () => { stubTurns(); const f = fixture(engine); opened.push(f.core); return f; };

  it("several workers go to one new sub bot together (the Rail's group and the tag), or none of them do", async () => {
    const f = open();
    f.host.refuseOwner.add(W2);
    await expect(f.core.groupAgents(PROJECT, [W1, W2], { kind: "newSubBot", name: "Client" })).rejects.toThrow(/Write the client/);
    expect(f.host.owners.get(W1) ?? null).toBeNull();
    expect([...f.bots.values()].filter((bot) => bot.profile.parent)).toHaveLength(0);
    f.host.refuseOwner.clear();
    await (f.core as any).subBotRequested(f.bots.get(PROJECT), { name: "Client", subagent: "", subagents: [W1, W2], note: "Finish the client and its tests." });
    const sub = [...f.bots.values()].find((bot) => bot.profile.parent === PROJECT)!;
    expect(sub).toBeDefined();
    expect(f.host.owners.get(W1)!.botId).toBe(sub.id);
    expect(f.host.owners.get(W2)!.botId).toBe(sub.id);
    expect(rows(f.core, PROJECT).filter((row) => !row.subBot).map((row) => row.id)).toEqual([]);
    expect(rows(f.core, sub.id).map((row) => row.id).sort()).toEqual([W1, W2]);
    const first = relays.filter((r) => r.id === sub.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toContain("these 2 agents");
    expect(first[0]!.text).toContain('"Research the API"');
    expect(first[0]!.text).toContain('"Write the client"');
    expect(first[0]!.text).toMatch(/Status file: .*status\.md/);
    expect(first[0]!.text).toContain("Finish the client and its tests.");
  });

});
