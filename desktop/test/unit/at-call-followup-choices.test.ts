// A called-in bot's question relayed into the caller's chat (`callInFollowUp`) is one question shown twice: its
// own line in its own chat and the copy in the caller's chat. The case is 設計 (a sub bot of botling) on
// 2026-11-10: its cards from worker news showed in botling's chat; the user answered there, and the same card in
// 設計's own chat stayed "not answered" (and one answered in 設計's chat stayed open in botling's).
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
  const dir = tempDir("at-call-choices");
  const folder = tempDir("at-call-choices-botling");
  const designFolder = tempDir("at-call-choices-design");
  for (const f of [folder, designFolder]) mkdirSync(join(f, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: BOTLING, name: "botling", folder, avatar: "triangle" });
  saveProjectRow(dir, { id: DESIGN, name: "設計", folder: designFolder, avatar: "cloud" });
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  const bots: Map<string, Bot> = (core as any).bots;
  const conversations = (core as any).conversations;
  const caller = bots.get(BOTLING)!, design = bots.get(DESIGN)!;
  const woken: string[] = [];
  vi.spyOn(caller, "appMessage").mockImplementation(((text: string) => { woken.push(text); return "m"; }) as any);
  vi.spyOn(caller, "appNotice").mockImplementation((() => "n") as any);
  vi.spyOn(caller as any, "deliver").mockImplementation(async () => {});
  vi.spyOn(design as any, "deliver").mockImplementation(async () => {});
  return { core, conversations, caller, design, woken };
}

async function answer(bot: Bot, text: string, origin?: string) {
  await vi.waitFor(() => expect((bot as any).turn?.open && (!origin || (bot as any).turn.origin === origin)).toBe(true));
  const turn = (bot as any).turn;
  turn.reply.text = text;
  (bot as any).finishTurn(turn, "done");
}

/** 設計 is called in by botling's @, starts a worker, and on its report asks the user with a card. */
async function relayedQuestion(h: ReturnType<typeof fixture>) {
  h.conversations.receiveBotMention({ id: "R1", role: "bot", text: "@設計 畫兩種頭像給使用者挑", date: 0 }, h.caller);
  await vi.waitFor(() => expect((h.design as any).turn?.callIn).toBe(BOTLING));
  (h.design as any).onWorkerOutput({ kind: "subagentStarted", id: "W1", description: "avatar", type: "claude-worker", prompt: "Draw.", background: true });
  await answer(h.design, "開始畫了。");
  (h.design as any).workerReport("<app_task_result task_id=\"W1\">done</app_task_result>", "W1");
  await answer(h.design, "畫好了，要哪一種？\n<choices>\n- 形狀臉\n- 色塊\n</choices>", "app");
  const copy = await vi.waitFor(() => { const line = h.caller.lines().find((l) => l.sourceID === DESIGN && l.choices?.length); expect(line).toBeTruthy(); return line!; });
  const original = h.design.lines().find((l) => l.role === "bot" && l.choices?.length)!;
  expect(original).toBeTruthy();
  return { copy, original };
}

describe("a called-in bot's relayed question is one card: answered on either side, both show it", () => {
  it("a pick on the copy in the caller's chat goes to the bot that asked and settles its own card", async () => {
    const h = fixture();
    try {
      const { copy, original } = await relayedQuestion(h);
      expect((h.core as any).calledInPick(BOTLING, copy.id, 0)).toEqual({ accepted: true });
      expect(h.caller.line(copy.id)!.chosen).toBe(0);
      // The bot that asked hears the pick (a call-in with it), and its own card shows it answered.
      await vi.waitFor(() => expect((h.design as any).turn?.callIn).toBe(BOTLING));
      expect(h.design.line(original.id)!.chosen).toBe(0);
      expect(isOpenQuestion(h.design.line(original.id)!)).toBe(false);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("a pick on its own card in its own chat settles the copy in the caller's chat", async () => {
    const h = fixture();
    try {
      const { copy, original } = await relayedQuestion(h);
      expect(h.design.choose(original.id, 1)).toMatchObject({ accepted: true });
      await vi.waitFor(() => expect(h.caller.line(copy.id)!.chosen).toBe(1));
      expect(isOpenQuestion(h.caller.line(copy.id)!)).toBe(false);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("Ignore on the copy ignores the question it copies, and the copy shows it", async () => {
    const h = fixture();
    try {
      const { copy, original } = await relayedQuestion(h);
      expect((h.core as any).ignoreQuestion(BOTLING, copy.id)).toEqual({ accepted: true });
      expect(h.design.line(original.id)!.ignoredAt).toBeTruthy();
      expect(h.caller.line(copy.id)!.ignoredAt).toBeTruthy();
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });

  it("the caller is told its card is already in the chat, not to ask the user again", async () => {
    const h = fixture();
    try {
      await relayedQuestion(h);
      const note = h.woken.find((text) => text.includes("sent news on that request"))!;
      expect(note).toContain("Its choices: 形狀臉 | 色塊");
      expect(note).toMatch(/already shows? (this|its) card/);
    } finally { vi.restoreAllMocks(); await h.core.shutdown(); }
  });
});
