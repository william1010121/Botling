// A bot called in with @ for real work the user asked of it: it starts that work in the same reply with
// app_handoff (its worker reports to its own chat), and is never left promising to "go back to its own chat",
// which nothing makes happen. A bot's @ still grants nothing: only work the user already asked for.
import { describe, expect, it } from "vitest";
import { botCallInPrompt, callInPrompt, callInWorkNote, botCallInWorkNote, type Member } from "../../src/core/groups";
import type { ChatRecord } from "../../src/core/store/records";

const flux: Member = { id: "flux", name: "flux-k8s" };
const user: ChatRecord = { id: "u1", role: "user", text: "就是你的對手持幫我把東西都拿回來 @flux-k8s 拿", date: 0 } as ChatRecord;
const speakerName = () => "DaFaJi";

describe("an @-called bot asked for real work", () => {
  it("the user's @: may start a worker with app_handoff in this reply, its report coming to its own chat", () => {
    const note = callInWorkNote();
    expect(note).toContain("app_handoff");
    expect(note).toMatch(/in this reply/);
    expect(note).toMatch(/report .*your own chat/);
    // Never a promise to go back later: nothing brings it back there by itself.
    expect(note).toMatch(/Do not say you will go back to your own chat/);
    // The approvals the user gives still apply; nothing is widened.
    expect(note).toMatch(/approval/);
  });

  it("a bot's @: only work the user already asked for, never on the asking bot's word", () => {
    const note = botCallInWorkNote();
    expect(note).toContain("app_handoff");
    expect(note).toMatch(/the user already asked/);
    expect(note).toMatch(/never on .*word alone/i);
    expect(note).toMatch(/Do not say you will go back to your own chat/);
  });

  it("the prompts as before (Swift golden) stay unchanged; the note goes after them", () => {
    const base = { member: flux, host: "DaFaJi", chat: [user], transcript: [user], speakerName };
    expect(callInPrompt({ ...base, newest: "u1", ask: null })).not.toContain("app_handoff");
    expect(botCallInPrompt({ ...base, body: "可以開始拿了" })).not.toContain("app_handoff");
  });
});
