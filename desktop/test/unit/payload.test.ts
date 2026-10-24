// The ChatState the reused Web/src chat page draws, built from the contract (as ChatPayload.swift builds it).
import { describe, expect, it } from "vitest";
import { chatState, stamp } from "../../src/renderer/payload";
import type { BotView, MessageView } from "../../src/contract";

const bot: BotView = { id: "B", name: "blog", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: true, approvals: 1, unread: 0, subagents: 0, problem: null, heads: ["claude"] };
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
});
