// The ChatState the reused Web/src chat page draws, built from the contract (as ChatPayload.swift builds it).
import { describe, expect, it } from "vitest";
import { chatState, stamp } from "../../src/renderer/payload";
import type { BotView, MessageView } from "../../src/contract";

const bot: BotView = { id: "B", name: "blog", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: true, approvals: 1, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const at = (minute: number) => new Date(Date.UTC(2026, 9, 25, 8, minute)).toISOString();

describe("chat state for the Web/src page", () => {
  it("maps approvals, stopped replies, steps and the running reply", () => {
    const messages: MessageView[] = [
      { id: "u1", role: "user", text: "Clean up", time: at(0) },
      { id: "r1", role: "bot", text: "Stopped here", time: at(1), state: "stopped", interrupted: true },
      {
        id: "q1", role: "bot", text: "Wants to use `Bash`:", time: at(2), approval: { tool: "Bash", expires: at(12) }, chosen: null, answer: null,
        choices: [{ label: "Allow once", detail: null, recommended: true, action: "allowOnce" }, { label: "Don't allow", detail: null, recommended: false, action: "deny" }],
      },
      { id: "r2", role: "bot", text: "", time: at(3), state: "streaming", turnId: "t2" },
    ];
    const live = [{ id: "s1", kind: "tool" as const, tool: "Bash", title: "Run rm -rf build", detail: "rm -rf build", output: null, failed: false, done: false }];
    const { state, extras } = chatState(bot, { botId: "B", messages, running: { turnId: "t2", messageId: "r2" }, live, tasks: [] }, new Date(Date.UTC(2026, 9, 25, 9)));
    expect(state).toMatchObject({ botID: "B", botName: "blog", working: true, placeholder: "Message blog…", components: {}, pendingFiles: [] });
    expect(state.messages.map((m) => m.id)).toEqual(["u1", "r1", "q1"]); // The running reply has no words yet.
    expect(state.live).toEqual([expect.objectContaining({ title: "Run rm -rf build", status: null, count: null })]);
    expect(state.messages[1]).toMatchObject({ interrupted: true, avatar: expect.stringMatching(/^data:image\/svg\+xml;base64,/) });
    expect(state.messages[2]).toMatchObject({ open: true, choices: [{ action: "allowOnce", recommended: true }, { action: "deny" }] });
    expect(state.messages[0]).toMatchObject({ avatar: null, choices: null, attachments: null, openable: false });
    expect(extras).toEqual({ botId: "B", running: true, cards: {}, states: { r1: "stopped" } });

    const answered = chatState(bot, { botId: "B", messages: [{ ...messages[2]!, chosen: 0 }, { ...messages[3]!, text: "Done" }], running: { turnId: "t2", messageId: "r2" }, live, tasks: [] }).state;
    expect(answered.messages[0]!.open).toBe(false);
    expect(answered.messages[1]).toMatchObject({ text: "Done", steps: [expect.objectContaining({ id: "s1" })] });
    expect(answered.live).toEqual([]);
  });

  it("stamps a message that comes 30 minutes or more after the one before", () => {
    const now = new Date(2026, 9, 25, 12, 0);
    const messages: MessageView[] = [
      { id: "a", role: "user", text: "", time: new Date(2026, 9, 25, 8, 15).toISOString() },
      { id: "b", role: "user", text: "", time: new Date(2026, 9, 25, 8, 20).toISOString() },
      { id: "c", role: "user", text: "", time: new Date(2026, 9, 25, 9, 0).toISOString() },
      { id: "d", role: "user", text: "", time: new Date(2026, 9, 24, 9, 0).toISOString() },
    ];
    expect(stamp(messages, 0, now)).toBe("Today 8:15 AM");
    expect(stamp(messages, 1, now)).toBeNull();
    expect(stamp(messages, 2, now)).toBe("Today 9:00 AM");
    expect(stamp([messages[3]!], 0, now)).toBe("Yesterday 9:00 AM");
  });

  it("two heads: who said each line, whom a line was for, seen marks, the switch, the rounds line and hand-offs (ChatPayload's)", () => {
    const two: BotView = { ...bot, heads: ["claude", "codex"] };
    const messages: MessageView[] = [
      { id: "u1", role: "user", text: "Just you", time: at(0), to: "codex", seenBy: ["codex"] },
      { id: "r1", role: "bot", text: "On it", time: at(1), engine: "codex", seenBy: ["codex"] },
      { id: "r2", role: "bot", text: "Seen", time: at(2), engine: "claude", seenBy: ["claude", "codex"], decisionId: "D1" },
      { id: "r3", role: "bot", text: "Running", time: at(3), engine: "codex", state: "streaming" },
    ];
    const heads = {
      engines: ["claude", "codex"] as ("claude" | "codex")[], answerWith: "both" as const, handoffsOn: true,
      rounds: { kind: "review" as const, round: 1, limit: 2, text: "Review round 1 of 2" },
      handoffs: [{ id: "H1", from: "claude" as const, to: "codex" as const, kind: "review" as const, task: "Check it", origin: null, round: 1, limit: 2, state: "running" as const, lines: [{ who: "claude" as const, text: "Check it" }] }],
    };
    const runs = [{ turnId: "t3", messageId: "r3", live: [] }, { turnId: "t4", messageId: "r4", live: [] }];
    const { state, extras } = chatState(two, { botId: "B", messages, running: { turnId: "t3", messageId: "r3" }, live: [], tasks: [], runs, heads });
    expect(state.answerWith).toEqual({ options: [{ id: "both", label: "Both" }, { id: "claude", label: "Claude" }, { id: "codex", label: "Codex" }], chosen: "both" });
    expect(state.rounds).toEqual({ text: "Review round 1 of 2", stop: "Stop now", kind: "review", round: 1, limit: 2 });
    expect(state.handoffs).toEqual([{ id: "H1", from: "claude", to: "codex", fromName: "Claude", toName: "Codex", kind: "review", task: "Check it", origin: null, round: 1, limit: 2, state: "running", lines: [{ who: "claude", name: "Claude", text: "Check it" }] }]);
    expect(state.messages.map((m) => [m.id, m.speaker, m.sourceEngine])).toEqual([["u1", "to Codex", null], ["r1", "blog · Codex", "codex"], ["r2", "blog · Claude", "claude"], ["r3", "blog · Codex", "codex"]]);
    expect(state.messages[0]!.seen).toEqual([{ mark: "C", name: "Claude", seen: false, recipient: false }, { mark: "X", name: "Codex", seen: true, recipient: true }]);
    expect(state.messages[2]!.seen).toEqual([{ mark: "C", name: "Claude", seen: true }, { mark: "X", name: "Codex", seen: true }]);
    expect(state.messages[2]!.decisionID).toBe("D1");
    expect(state.working).toBe(true);
    expect(extras.running).toBe(true);
    // One head: none of it.
    const one = chatState(bot, { botId: "B", messages, running: null, live: [], tasks: [] }).state;
    expect(one.answerWith).toBeUndefined();
    expect(one.messages[1]!.speaker).toBeNull();
    expect(one.messages[1]!.seen).toBeNull();
  });
});
