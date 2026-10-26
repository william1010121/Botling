// Look Cute in a bot with two heads: the seen marks under each line show the heads' tiny
// characters (1.x `ChatPayload.seenHeads`), not the "C" / "X" letters of the Original look.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BotView, ResultOf } from "../../src/contract";
type ChatView = NonNullable<ResultOf<"chat.snapshot">["chat"]>;
import { chatState } from "../../src/renderer/payload";
import { characterURL } from "../../src/renderer/avatars";
import { seenHeadsCSS } from "../../../Web/src/heads";

const bot: BotView = { id: "B", name: "Main", role: "main", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude", "codex"], job: null, subagentRows: [] };
const now = new Date();
const chat = {
  botId: bot.id, running: null, live: [], tasks: [], runs: [], catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [],
  heads: { engines: ["claude", "codex"], answerWith: "both", rounds: null, handoffs: [] },
  messages: [
    { id: "u", role: "user", text: "hello both", time: now.toISOString(), seenBy: ["claude", "codex"] },
    { id: "r", role: "bot", text: "hi", time: now.toISOString(), engine: "codex", seenBy: ["codex"] },
  ],
} as unknown as ChatView;

beforeAll(() => {
  const art = join(__dirname, "../../..", "Sources/ClaudeCodeBotCore/Resources/CharacterArt/avatars-static");
  vi.stubGlobal("__CHARACTERS__", Object.fromEntries(["claude", "gpt"].map((engine) => [engine, Object.fromEntries(["idle", "working", "thinking", "sleepy"].map((mood) => [mood, readFileSync(join(art, engine, `${mood}.png`)).toString("base64")]))])));
});

describe("seen marks of a two-head bot", () => {
  it("Cute: carries each head's character by its mark, and the page draws them instead of letters", () => {
    const { state } = chatState(bot, chat, now, null, { look: "cute" });
    expect(state.seenHeads).toEqual({ C: characterURL("claude"), X: characterURL("codex") });
    expect(state.seenHeads!.C).not.toBe(state.seenHeads!.X);
    // The chat page (Web/src/main.ts → setSeenHeads) turns these into its style rule.
    const css = seenHeadsCSS(state.seenHeads!);
    expect(css).toContain(`.seen-mark[data-mark="C"] { background-image: url("${characterURL("claude")}")`);
    expect(css).toContain(`.seen-mark[data-mark="X"] { background-image: url("${characterURL("codex")}")`);
    // The marks it styles are the ones the page draws under the lines.
    expect(state.messages.flatMap((message) => message.seen ?? []).map((head) => head.mark)).toEqual(["C", "X", "C", "X"]);
  });

  it("Original: no characters, the letters stay", () => {
    const { state } = chatState(bot, chat, now, null, { look: "original" });
    expect(state.seenHeads ?? null).toBeNull();
  });

  it("one head: no seen marks and no characters for them", () => {
    const one = { ...bot, heads: ["claude"] } as BotView;
    const { state } = chatState(one, { ...chat, heads: null } as ChatView, now, null, { look: "cute" });
    expect(state.seenHeads ?? null).toBeNull();
  });
});
