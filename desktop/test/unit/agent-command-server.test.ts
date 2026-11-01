// The owner's follow-up and stop (agent.message / agent.stop, <agent-message> / <agent-stop>) for a worker hosted by a Codex, an
// Antigravity and a Claude bot: only the owner may command; Antigravity cannot steer a worker at work, so its words wait for the run's end.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Core } from "../../src/core/server";
import { MAIN_BOT_ID } from "../../src/core/store/records";
import { fixture, messages, notices, OTHER, PROJECT, relays, rows, stubTurns, turns, W1, W2 } from "../agent-owner-fake";

const opened: Core[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const core of opened.splice(0)) await core.shutdown(); });

describe.each(["codex", "agy", "claude"] as const)("a worker hosted by a %s bot, moved to another bot", (engine) => {
  const open = () => { stubTurns(); const f = fixture(engine); opened.push(f.core); return f; };

  it("only its owner may follow it up or stop it; a busy host that cannot steer gets the words after the run", async () => {
    const f = open();
    const moved = await f.core.moveAgent(PROJECT, W1, { kind: "bot", botId: OTHER });
    await expect((f.core as any).agentMessageCommand(PROJECT, W1, "hi")).rejects.toThrow(/belongs to Helper; only its owner/);
    const sent = await (f.core as any).agentMessageCommand(OTHER, W1, "Also check v2.");
    if (engine === "agy") {
      expect(sent).toMatchObject({ how: "queued", run: null });
      expect(f.host.sent).toEqual([]);
      f.host.states.set(W1, "idle");
      (f.bots.get(PROJECT) as any).workerReported({ kind: "workerReport", id: W1, run: 1, engine, status: "completed", report: "v1 done." });
      await new Promise((done) => setTimeout(done, 5));
      expect(f.host.sent).toEqual([{ id: W1, text: "Also check v2." }]);
      expect(notices(f.bots, OTHER, /Sent the words you left for "Research the API"; it started run 2/)).toHaveLength(1);
    } else {
      expect(sent).toMatchObject({ how: "steered", run: 1 });
      expect(f.host.sent).toEqual([{ id: W1, text: "Also check v2." }]);
    }
    // The tag form, from the owner and from another bot.
    await (f.core as any).agentTag(f.bots.get(PROJECT), { kind: "agentStop", to: moved.agentId });
    expect(f.host.stopped).toEqual([]);
    expect(notices(f.bots, PROJECT, /Did not stop "Research the API"/)).toHaveLength(1);
    f.host.states.set(W1, "running");
    await (f.core as any).agentTag(f.bots.get(OTHER), { kind: "agentStop", to: moved.agentId });
    expect(f.host.stopped).toEqual([W1]);
    await expect((f.core as any).agentStopCommand(OTHER, W1)).rejects.toThrow(/not at work/);
  });

});
