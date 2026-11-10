// A sub bot's card relayed into its parent's chat (`callInFollowUp`) and answered there: the answer is received where
// it was given. The case is 設計 (a sub bot of botling) on 2026-11-10: botling @-called 設計, 設計 asked three grouped
// questions, the card showed in botling's chat, the user answered it there, and only 設計 heard it; botling, the bot
// of the chat where the user answered and the one doing the work, was never woken.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Core } from "../../src/core/server";
import type { Bot } from "../../src/core/bot";
import { saveProjectRow } from "../../src/core/projects";
import { isOpenQuestion } from "../../src/core/store/records";
import { tempDir } from "../helpers";

const BOTLING = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const DESIGN = "6AC64E3A-C7D7-4000-8000-000000000002";

function fixture() {
  const dir = tempDir("relayed-answer");
  const folder = tempDir("relayed-answer-botling");
  const designFolder = tempDir("relayed-answer-design");
  for (const f of [folder, designFolder]) mkdirSync(join(f, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: BOTLING, name: "botling", folder, avatar: "triangle" });
  saveProjectRow(dir, { id: DESIGN, name: "設計", folder: designFolder, avatar: "cloud" });
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  (core as any).activated = true;
  const bots: Map<string, Bot> = (core as any).bots;
  const conversations = (core as any).conversations;
  const caller = bots.get(BOTLING)!, design = bots.get(DESIGN)!;
  vi.spyOn(caller, "appMessage").mockImplementation((() => "m") as any);
  vi.spyOn(caller, "appNotice").mockImplementation((() => "n") as any);
  const delivered: string[] = [];
  vi.spyOn(caller as any, "deliver").mockImplementation(async (...args: any[]) => { delivered.push(JSON.stringify(args)); });
  vi.spyOn(design as any, "deliver").mockImplementation(async () => {});
  return { core, conversations, caller, design, delivered };
}

async function answer(bot: Bot, text: string, origin?: string) {
  await vi.waitFor(() => expect((bot as any).turn?.open && (!origin || (bot as any).turn.origin === origin)).toBe(true));
  const turn = (bot as any).turn;
  turn.reply.text = text;
  (bot as any).finishTurn(turn, "done");
}

async function relayedCard(h: ReturnType<typeof fixture>, card: string) {
  h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@設計 設計設定頁給使用者挑", date: 0 }, h.caller);
  await vi.waitFor(() => expect((h.design as any).turn?.callIn).toBe(BOTLING));
  (h.design as any).onWorkerOutput({ kind: "subagentStarted", id: "W1", description: "design", type: "claude-worker", prompt: "Draw.", background: true });
  await answer(h.design, "開始畫了。");
  (h.design as any).workerReport("<app_task_result task_id=\"W1\">done</app_task_result>", "W1");
  await answer(h.design, card, "app");
  const copy = await vi.waitFor(() => { const line = h.caller.lines().find((l) => l.sourceID === DESIGN && l.choices?.length); expect(line).toBeTruthy(); return line!; });
  const original = h.design.lines().find((l) => l.role === "bot" && l.choices?.length)!;
  expect(original).toBeTruthy();
  return { copy, original };
}

/** The user's answer is a user line in botling's chat and a turn of botling's with it. */
async function parentGot(h: ReturnType<typeof fixture>, words: string) {
  const line = h.caller.lines().find((l) => l.role === "user" && l.text.includes(words));
  expect(line).toBeTruthy();
  await vi.waitFor(() => expect(h.delivered.some((args) => args.includes(words))).toBe(true));
}

describe("a sub bot's card answered in the parent's chat reaches the parent bot", () => {
  it("a pick", async () => {
    const h = fixture();
    try {
      const { copy, original } = await relayedCard(h, "要哪一種？\n<choices>\n- 形狀臉\n- 色塊\n</choices>");
      expect(await (h.core as any).handle({ type: "chat.choose", botId: BOTLING, messageId: copy.id, index: 1 }, new AbortController().signal))
        .toEqual({ accepted: true });
      await parentGot(h, "色塊");
      expect(h.caller.line(copy.id)!.chosen).toBe(1);
      expect(h.design.line(original.id)!.chosen).toBe(1);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("grouped questions", async () => {
    const h = fixture();
    try {
      const card = "三個問題：\n<choices question=\"版面？\">\n- 單欄\n- 雙欄\n</choices>\n<choices question=\"顏色？\">\n- 深色\n- 淺色\n</choices>\n<choices question=\"字體？\">\n- 大\n- 小\n</choices>";
      const { copy, original } = await relayedCard(h, card);
      expect(copy.questions?.length).toBe(3);
      const picks = [{ options: [1] }, { options: [0] }, { options: [1] }];
      expect(await (h.core as any).handle({ type: "chat.answer", botId: BOTLING, messageId: copy.id, text: "", picks }, new AbortController().signal))
        .toEqual({ accepted: true });
      await parentGot(h, "雙欄");
      expect(isOpenQuestion(h.caller.line(copy.id)!)).toBe(false);
      expect(isOpenQuestion(h.design.line(original.id)!)).toBe(false);
      expect(h.design.line(original.id)!.picks).toEqual(picks);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("own words", async () => {
    const h = fixture();
    try {
      const { copy, original } = await relayedCard(h, "要哪一種？\n<choices>\n- 形狀臉\n- 色塊\n</choices>");
      expect(await (h.core as any).handle({ type: "chat.answer", botId: BOTLING, messageId: copy.id, text: "都不要，用照片" }, new AbortController().signal))
        .toEqual({ accepted: true });
      await parentGot(h, "都不要，用照片");
      expect(h.design.line(original.id)!.answer).toBe("都不要，用照片");
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});

describe("a relayed card whose bot was removed (spec/models/callin/RelayedCard.tla)", () => {
  it("is no longer needed in the parent's chat once the bot is removed", async () => {
    const h = fixture();
    try {
      const { copy } = await relayedCard(h, "要哪一種？\n<choices>\n- 形狀臉\n- 色塊\n</choices>");
      await h.core.removeBot(DESIGN, { quiet: true });
      expect(isOpenQuestion(h.caller.line(copy.id)!)).toBe(false);
      expect(h.caller.line(copy.id)!.answer).toBe("No longer needed");
      expect(h.delivered).toEqual([]);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("a copy whose original line is gone can still be ignored where it is", async () => {
    const h = fixture();
    try {
      const { copy, original } = await relayedCard(h, "要哪一種？\n<choices>\n- 形狀臉\n- 色塊\n</choices>");
      vi.spyOn(h.design, "line").mockImplementation(((id: string) => (id === original.id ? null : undefined)) as any);
      expect(await (h.core as any).handle({ type: "chat.ignoreQuestion", botId: BOTLING, messageId: copy.id }, new AbortController().signal))
        .toEqual({ accepted: true });
      expect(h.caller.line(copy.id)!.ignoredAt).toBeTruthy();
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});

/** 設計's card posted in botling's chat while botling's @ called it in (a guest line), botling idle again. */
async function guestCard(h: ReturnType<typeof fixture>, card: string, mention = "R2") {
  h.conversations.receiveBotMention({ id: mention, role: "bot", text: "@設計 給使用者挑一個", date: 0 }, h.caller);
  await vi.waitFor(() => expect((h.design as any).turn?.callIn).toBe(BOTLING));
  await answer(h.design, card);
  return await vi.waitFor(() => { const line = h.caller.lines().find((l) => l.sourceID === DESIGN && l.choices?.length && !l.sourceMessageID); expect(line).toBeTruthy(); return line!; });
}
const view = (bot: Bot, id: string) => (bot as any).messageView(bot.line(id)!);
const choose = (h: ReturnType<typeof fixture>, id: string, index: number) =>
  (h.core as any).handle({ type: "chat.choose", botId: BOTLING, messageId: id, index }, new AbortController().signal);

describe("an answer on a called-in bot's card counts once it reaches the bot (spec/models/callin/RelayedCard.tla)", () => {
  const CARD = "要哪一種？\n<choices>\n- 形狀臉\n- 色塊\n</choices>";

  it("free: it is called in with the answer, and the card shows it answered as its turn begins", async () => {
    const h = fixture();
    try {
      const card = await guestCard(h, CARD);
      expect(await choose(h, card.id, 1)).toEqual({ accepted: true });
      await vi.waitFor(() => expect((h.design as any).turn?.callIn).toBe(BOTLING));
      expect(h.caller.line(card.id)!.chosen).toBe(1);
      expect(h.caller.line(card.id)!.pendingAnswer).toBeUndefined();
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("at work: the answer goes into its own chat, the card shows it Queued, and answered once its turn begins", async () => {
    const h = fixture();
    try {
      const card = await guestCard(h, CARD);
      h.design.send("Work on the next page.");
      await vi.waitFor(() => expect((h.design as any).turn?.open).toBe(true));
      expect(await choose(h, card.id, 1)).toEqual({ accepted: true });
      expect(isOpenQuestion(h.caller.line(card.id)!)).toBe(false);
      expect(h.caller.line(card.id)!.chosen).toBeUndefined();
      expect(view(h.caller, card.id)).toMatchObject({ chosen: 1, queued: true });
      expect(await choose(h, card.id, 0)).toEqual({ accepted: false });
      const line = h.design.lines().find((l) => l.role === "user" && l.text === "色塊");
      expect(line).toBeTruthy();
      expect((h.design as any).queue).toHaveLength(1);
      await answer(h.design, "Page done.");
      await vi.waitFor(() => expect(h.caller.line(card.id)!.chosen).toBe(1));
      expect(view(h.caller, card.id).queued).toBeFalsy();
      expect(h.caller.lines().some((l) => l.role === "notice" && l.text.startsWith("Did not answer"))).toBe(false);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("taken back while it waited: the card is open again and says the answer did not reach it", async () => {
    const h = fixture();
    try {
      const card = await guestCard(h, CARD);
      h.design.send("Work on the next page.");
      await vi.waitFor(() => expect((h.design as any).turn?.open).toBe(true));
      expect(await choose(h, card.id, 1)).toEqual({ accepted: true });
      await h.design.stop((h.design as any).queue[0].id);
      await vi.waitFor(() => expect(isOpenQuestion(h.caller.line(card.id)!)).toBe(true));
      expect(h.caller.line(card.id)!.notDelivered).toBe("設計");
      expect(view(h.caller, card.id)).toMatchObject({ notDelivered: "設計", chosen: null });
      // Answered again (it is free now): the note goes.
      await answer(h.design, "Page done.");
      expect(await choose(h, card.id, 0)).toEqual({ accepted: true });
      await vi.waitFor(() => expect(h.caller.line(card.id)!.chosen).toBe(0));
      expect(h.caller.line(card.id)!.notDelivered).toBeUndefined();
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("the bot removed while the answer waited: the card is open again, saying so", async () => {
    const h = fixture();
    try {
      const card = await guestCard(h, CARD);
      h.design.send("Work on the next page.");
      await vi.waitFor(() => expect((h.design as any).turn?.open).toBe(true));
      expect(await choose(h, card.id, 1)).toEqual({ accepted: true });
      await h.core.removeBot(DESIGN, { quiet: true });
      await vi.waitFor(() => expect(h.caller.line(card.id)!.notDelivered).toBe("設計"));
      expect(isOpenQuestion(h.caller.line(card.id)!)).toBe(true);
      expect(await choose(h, card.id, 1)).toEqual({ accepted: false });
      expect(h.caller.line(card.id)!.answer).toBe("No longer needed");
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});
