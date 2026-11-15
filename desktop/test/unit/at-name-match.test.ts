// A bot's @ written with a short form of a bot's name (the sub bot 特殊函數概論 wrote "@gkey" for the project
// bot "gkey-release-candidate"): a bot cannot see the @ menu, so a name no bot has exactly is matched against the
// bots this chat can call in. One close name: sent to it, and the chat and the caller see the real name.
// Several: nothing is sent and they are listed. None: the names it can call in are listed (when few).
import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot, GuestAnswer } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { tempDir } from "../helpers";

const MATH = "6AC64E3A-C7D7-4000-8000-0000000000A1";
const GKEY_RC = "6AC64E3A-C7D7-4000-8000-0000000000A2";
const FLUX = "6AC64E3A-C7D7-4000-8000-0000000000A3";
const SPECIAL = "6AC64E3A-C7D7-4000-8000-0000000000A4";
const OTHER_SUB = "6AC64E3A-C7D7-4000-8000-0000000000A5";

type Extra = { id: string; name: string; parent?: string };

function fixture(extra: Extra[] = []) {
  const dir = tempDir("at-name-match");
  const folder = (name: string) => { const f = tempDir(`at-name-match-${name.length}`); mkdirSync(join(f, ".bot"), { recursive: true }); return f; };
  const mathFolder = folder("math"), gkeyFolder = folder("gkey"), fluxFolder = folder("flux");
  saveProjectRow(dir, { id: MATH, name: "Math", folder: mathFolder, avatar: "triangle" });
  saveProjectRow(dir, { id: GKEY_RC, name: "gkey-release-candidate", folder: gkeyFolder, avatar: "cloud" });
  saveProjectRow(dir, { id: FLUX, name: "flux-k8s", folder: fluxFolder, avatar: "cloud" });
  // Math's own sub bot: the caller in the report.
  saveProjectRow(dir, { id: SPECIAL, name: "特殊函數概論", folder: mathFolder, avatar: "triangle", job: "Special functions", parent: MATH, createdAt: 1_700_000_000_000, handoff: "s1" });
  for (const bot of extra) {
    if (bot.parent) saveProjectRow(dir, { id: bot.id, name: bot.name, folder: mathFolder, avatar: "cloud", job: "Help", parent: bot.parent, createdAt: 1_700_000_000_000, handoff: "x1" });
    else saveProjectRow(dir, { id: bot.id, name: bot.name, folder: folder(bot.name), avatar: "cloud" });
  }
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  const bots: Map<string, Bot> = (core as any).bots;
  const conversations = (core as any).conversations;
  const notices = new Map<string, string[]>();
  const watch = (id: string) => {
    const bot = bots.get(id)!;
    notices.set(id, []);
    vi.spyOn(bot, "appNotice").mockImplementation(((text: string) => { notices.get(id)!.push(text); return "n"; }) as any);
    vi.spyOn(bot, "appMessage").mockImplementation((() => {}) as any);
    return bot;
  };
  return { dir, core, bots, conversations, notices, watch };
}

/** A groupTurn that records what it was asked and never answers (the call only has to start). */
function held(bot: Bot) {
  const asked: string[] = [];
  vi.spyOn(bot, "groupTurn").mockImplementation((text: string) => { asked.push(text); return new Promise<GuestAnswer>(() => {}); });
  return asked;
}

const QUESTION = "請問 release candidate 的 Bessel 函數測試過了嗎？";
type H = ReturnType<typeof fixture>;
const told = (h: H, chatId: string) => h.conversations.callInStatus(chatId) as string | null;
const records = (h: H) => h.conversations.mentionLog.records as { message: string; sender: string; recipient: string; body: string }[];

describe("a bot's @ with a name no bot has exactly", () => {
  it("the report: the sub bot 特殊函數概論 writes @gkey, and gkey-release-candidate is called in with the question", async () => {
    const h = fixture();
    try {
      const caller = h.watch(SPECIAL);
      const asked = held(h.bots.get(GKEY_RC)!);
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: `我去問問 release 那邊。\n@gkey ${QUESTION}`, date: 0 }, caller);
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      expect(asked[0]).toContain(QUESTION);
      expect(records(h)).toEqual([expect.objectContaining({ message: "R1", sender: SPECIAL, recipient: GKEY_RC, body: QUESTION })]);
      // The chat shows which bot it went to; nothing says it was refused.
      expect(h.notices.get(SPECIAL)).toEqual(["Sent to @gkey-release-candidate (written as @gkey)."]);
      // The caller learns the real name with its next turn.
      expect(told(h, SPECIAL)).toMatch(/@gkey.*gkey-release-candidate/);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("matches a part of the name, any case: @Release goes to gkey-release-candidate", async () => {
    const h = fixture();
    try {
      const caller = h.watch(SPECIAL);
      const asked = held(h.bots.get(GKEY_RC)!);
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: `@Release ${QUESTION}`, date: 0 }, caller);
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      expect(records(h)[0]).toMatchObject({ recipient: GKEY_RC, body: QUESTION });
      expect(h.notices.get(SPECIAL)).toEqual(["Sent to @gkey-release-candidate (written as @Release)."]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("two close names: nothing is sent and both are listed", () => {
    const h = fixture([{ id: "6AC64E3A-C7D7-4000-8000-0000000000B1", name: "gkey-stable" }]);
    try {
      const caller = h.watch(SPECIAL);
      const rc = held(h.bots.get(GKEY_RC)!);
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: `@gkey ${QUESTION}`, date: 0 }, caller);
      expect(rc).toEqual([]);
      expect(records(h)).toEqual([]);
      expect(h.notices.get(SPECIAL)).toEqual(["Not sent to @gkey: no bot with that exact name. Close names this chat can call in: @gkey-release-candidate, @gkey-stable. Write the full name."]);
      expect(told(h, SPECIAL)).toMatch(/@gkey-release-candidate, @gkey-stable/);
    } finally { vi.restoreAllMocks(); }
  });

  it("no close name: the bots this chat can call in are listed instead of the @ menu", () => {
    const h = fixture();
    try {
      const caller = h.watch(SPECIAL);
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: `@TLA ${QUESTION}`, date: 0 }, caller);
      expect(records(h)).toEqual([]);
      const names = (h.conversations.callable(SPECIAL) as { name: string }[]).map((member) => `@${member.name}`).join(", ");
      expect(names).toContain("@gkey-release-candidate");
      expect(h.notices.get(SPECIAL)).toEqual([`Not sent to @TLA: no bot with that name (a sub bot that was closed is gone). Bots this chat can call in: ${names}. Write one's full name.`]);
      expect(h.notices.get(SPECIAL)![0]).not.toMatch(/@ menu/);
    } finally { vi.restoreAllMocks(); }
  });

  it("no close name and many callable bots: says so without a list", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `6AC64E3A-C7D7-4000-8000-0000000001${String(i).padStart(2, "0")}`, name: `helper${i}` }));
    const h = fixture(many);
    try {
      const caller = h.watch(SPECIAL);
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: `@TLA ${QUESTION}`, date: 0 }, caller);
      const count = h.conversations.callable(SPECIAL).length;
      expect(count).toBeGreaterThan(8);
      expect(h.notices.get(SPECIAL)).toEqual([`Not sent to @TLA: no bot with that name (a sub bot that was closed is gone). This chat can call in ${count} bots; write one's full name.`]);
    } finally { vi.restoreAllMocks(); }
  });

  it("an exact name wins over a close one: with gkey and gkey-release-candidate, @gkey goes to gkey", async () => {
    const GKEY = "6AC64E3A-C7D7-4000-8000-0000000000B2";
    const h = fixture([{ id: GKEY, name: "gkey" }]);
    try {
      const caller = h.watch(SPECIAL);
      const exact = held(h.bots.get(GKEY)!);
      const rc = held(h.bots.get(GKEY_RC)!);
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: `@gkey ${QUESTION}`, date: 0 }, caller);
      await vi.waitFor(() => expect(exact).toHaveLength(1));
      expect(rc).toEqual([]);
      expect(records(h)[0]).toMatchObject({ recipient: GKEY, body: QUESTION });
      expect(h.notices.get(SPECIAL)).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("a 1-character word never close-matches", () => {
    const h = fixture();
    try {
      const caller = h.watch(SPECIAL);
      const rc = held(h.bots.get(GKEY_RC)!);
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: `@g ${QUESTION}`, date: 0 }, caller);
      expect(rc).toEqual([]);
      expect(records(h)).toEqual([]);
      expect(h.notices.get(SPECIAL)![0]).toMatch(/^Not sent to @g: no bot with that name/);
    } finally { vi.restoreAllMocks(); }
  });

  it("a close name this chat cannot call in (another bot's sub bot) is not sent to", () => {
    // flux-k8s's sub bot "deployer-eu": callable in flux-k8s's chat only, never from Math's chat.
    const h = fixture([{ id: OTHER_SUB, name: "deployer-eu", parent: FLUX }]);
    try {
      const caller = h.watch(MATH);
      const sub = held(h.bots.get(OTHER_SUB)!);
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: `@deployer ${QUESTION}`, date: 0 }, caller);
      expect(sub).toEqual([]);
      expect(records(h)).toEqual([]);
      expect(h.notices.get(MATH)![0]).toMatch(/^Not sent to @deployer: no bot with that name/);
      expect(h.notices.get(MATH)![0]).not.toMatch(/deployer-eu/);
    } finally { vi.restoreAllMocks(); }
  });

  it("the resolved call keeps the one-bot-per-reply rule", () => {
    const h = fixture();
    try {
      const caller = h.watch(SPECIAL);
      const rc = held(h.bots.get(GKEY_RC)!);
      const flux = held(h.bots.get(FLUX)!);
      h.conversations.receiveBotMention({ id: "R1", role: "bot", text: `@gkey ${QUESTION}\n@flux-k8s 部署好了嗎？`, date: 0 }, caller);
      expect(rc).toEqual([]);
      expect(flux).toEqual([]);
      expect(records(h)).toEqual([]);
      expect(h.notices.get(SPECIAL)).toEqual(["Not sent with @: this reply names more than one bot at the start of a line. Name one bot per reply."]);
    } finally { vi.restoreAllMocks(); }
  });

  it("the resolved call is delivered once, and there is no cap on how many one message of the user's may bring", async () => {
    const h = fixture();
    try {
      const caller = h.watch(SPECIAL);
      const asked = held(h.bots.get(GKEY_RC)!);
      const line = { id: "R1", role: "bot" as const, text: `@gkey ${QUESTION}`, date: 0 };
      h.conversations.receiveBotMention(line, caller);
      await vi.waitFor(() => expect(asked).toHaveLength(1));
      // The same reply heard again: no new call.
      h.conversations.receiveBotMention(line, caller);
      expect(records(h)).toHaveLength(1);
      // The 2nd, 3rd, 4th (written short, it used to be over the cap of 3), 5th and 6th @ since the user's last line are all delivered.
      h.conversations.receiveBotMention({ id: "R2", role: "bot", text: "@gkey-release-candidate 第二個問題", date: 0 }, caller);
      h.conversations.receiveBotMention({ id: "R3", role: "bot", text: "@gkey-release-candidate 第三個問題", date: 0 }, caller);
      h.conversations.receiveBotMention({ id: "R4", role: "bot", text: "@gkey 第四個問題", date: 0 }, caller);
      h.conversations.receiveBotMention({ id: "R5", role: "bot", text: "@gkey-release-candidate 第五個問題", date: 0 }, caller);
      h.conversations.receiveBotMention({ id: "R6", role: "bot", text: "@gkey-release-candidate 第六個問題", date: 0 }, caller);
      expect(records(h).map((entry) => entry.message)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
      expect(h.notices.get(SPECIAL)!.filter((text) => /^Not sent/.test(text))).toEqual([]);
      // The same words again since the user's last line are still a retry, not a new call.
      h.conversations.receiveBotMention({ id: "R7", role: "bot", text: "@gkey-release-candidate 第六個問題", date: 0 }, caller);
      expect(records(h)).toHaveLength(6);
      expect(h.notices.get(SPECIAL)!.at(-1)).toMatch(/already asked the same/);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("a bot and the bot it calls cannot ping-pong: the hand-back chain ends at MAX_FOLLOW_DEPTH, with no cap to do it", async () => {
    const h = fixture();
    try {
      const caller = h.watch(SPECIAL);
      const rc = h.bots.get(GKEY_RC)!;
      const answers: ((answer: GuestAnswer) => void)[] = [];
      vi.spyOn(rc, "groupTurn").mockImplementation(() => new Promise<GuestAnswer>((resolve) => answers.push(resolve)));
      const ok = (i: number) => answers[i]!({ kind: "reply", text: "好了。", steps: [], engine: "claude" });
      // The user's message brings the 1st @ (depth 1); the callee answers and the caller is woken with the answer.
      h.conversations.receiveBotMention({ id: "P1", role: "bot", text: "@gkey-release-candidate 第一輪", date: 0 }, caller);
      await vi.waitFor(() => expect(answers).toHaveLength(1));
      ok(0);
      await vi.waitFor(() => expect(h.conversations.followUps.get(SPECIAL)?.depth).toBe(1));
      // The reply to that wake @s again (depth 2); the callee answers, and this time nobody is woken.
      h.conversations.receiveBotMention({ id: "P2", role: "bot", text: "@gkey-release-candidate 第二輪", date: 0 }, caller);
      await vi.waitFor(() => expect(answers).toHaveLength(2));
      ok(1);
      await vi.waitFor(() => expect(h.conversations.pending.get(SPECIAL) ?? []).toEqual([]));
      expect(h.conversations.followUps.get(SPECIAL)).toBeUndefined();
      // A third in a row (the wake at depth 2) is refused whatever the words, and nothing more is delivered.
      h.conversations.followUps.set(SPECIAL, { depth: 2, until: Date.now() + 60_000 });
      h.conversations.receiveBotMention({ id: "P3", role: "bot", text: "@gkey-release-candidate 第三輪", date: 0 }, caller);
      expect(records(h).map((entry) => entry.message)).toEqual(["P1", "P2"]);
      expect(h.notices.get(SPECIAL)!.at(-1)).toMatch(/^Not sent to gkey-release-candidate with @: bots have already called each other in 2 times in a row/);
      expect(answers).toHaveLength(2);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});
