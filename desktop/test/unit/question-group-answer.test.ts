// A question group (<choices question="…"> blocks) answered together: one decision, one message to the bot.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseInbound } from "../../src/contract";
import { Core } from "../../src/core/server";
import { saveProjectRow } from "../../src/core/projects";
import { messageView } from "../../src/core/bot";
import { isOpenQuestion } from "../../src/core/store/records";
import { tempDir } from "../helpers";

const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD1";
const QUESTION = "DD43524E-1FC7-4DD6-9A50-4A129ADD64B0";
const questions = [
  { question: "Which database?", multiple: false, options: [{ label: "Postgres", recommended: true }, { label: "SQLite", recommended: false }] },
  { question: "Which features?", multiple: true, options: [{ label: "Login", recommended: false }, { label: "Export", recommended: false }, { label: "Search", recommended: false }] },
];

function fixture() {
  const dir = tempDir("question-group");
  const folder = tempDir("question-group-project");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: PROJECT, name: "botling", folder, avatar: "triangle" });
  const store = join(dir, "projects", PROJECT);
  mkdirSync(store, { recursive: true });
  const file = join(store, "chat.json");
  const question = { id: QUESTION, role: "bot", text: "Two things first.", date: 814897456.479, engine: "claude", choices: questions[0]!.options, questions };
  writeFileSync(file, JSON.stringify([question]));
  const core = new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit() {}, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  (core as any).activated = true;
  const bot: any = (core as any).bot(PROJECT);
  const send = vi.spyOn(bot, "send").mockImplementation(() => undefined as never);
  const handle = (cmd: object) => (core as any).handle({ botId: PROJECT, messageId: QUESTION, ...cmd }, new AbortController().signal);
  return { file, core, bot, send, handle };
}

describe("question group answers", () => {
  it("accepts picks in chat.answer, at most 5", () => {
    const cmd = { type: "chat.answer", botId: PROJECT, messageId: QUESTION, text: "" };
    expect(parseInbound({ v: 10, id: "a", cmd: { ...cmd, picks: [{ options: [0] }, { options: [], skipped: true }] } }).ok).toBe(true);
    expect(parseInbound({ v: 10, id: "a", cmd: { ...cmd, picks: Array(6).fill({ options: [0] }) } }).ok).toBe(false);
    expect(parseInbound({ v: 10, id: "a", cmd: { ...cmd, picks: [{ options: [6] }] } }).ok).toBe(false);
  });

  it("sends the bot one message with each question and its answer, keeps the picks and closes the decision", async () => {
    const h = fixture();
    try {
      expect(h.core.waiting().items.find((item) => item.messageId === QUESTION)?.text).toBe("1. Which database? / 2. Which features?");
      expect(await h.handle({ type: "chat.answer", text: "", picks: [{ options: [1] }, { options: [2, 0], other: "SSO" }] })).toEqual({ accepted: true });
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.send.mock.calls[0]![0]).toBe("1. Which database?\n→ SQLite\n2. Which features? (several allowed)\n→ Login; Search; Other: SSO");
      expect(h.send.mock.calls[0]![1]).toMatchObject({ replyTo: QUESTION });
      const line = h.bot.line(QUESTION);
      expect(isOpenQuestion(line)).toBe(false);
      expect(line.picks).toEqual([{ options: [1] }, { options: [0, 2], other: "SSO" }]);
      const view = messageView(line);
      expect(view.questions?.map((q) => q.question)).toEqual(["Which database?", "Which features?"]);
      expect(view.picks).toEqual([{ options: [1], other: null, skipped: false }, { options: [0, 2], other: "SSO", skipped: false }]);
      expect(h.core.waiting().items.some((item) => item.messageId === QUESTION)).toBe(false);
      // Answered once: a second submit changes nothing.
      expect(await h.handle({ type: "chat.answer", text: "", picks: [{ options: [0] }, { options: [0] }] })).toEqual({ accepted: false });
      expect(h.send).toHaveBeenCalledTimes(1);
      await h.core.shutdown();
      expect(JSON.parse(readFileSync(h.file, "utf8"))[0].picks).toEqual([{ options: [1] }, { options: [0, 2], other: "SSO" }]);
    } finally { await h.core.shutdown(); }
  });

  it("refuses picks that do not fit, leaving the question open", async () => {
    const h = fixture();
    try {
      await expect(h.handle({ type: "chat.answer", text: "", picks: [{ options: [0, 1] }, { options: [0] }] })).rejects.toThrow(/do not fit/);
      await expect(h.handle({ type: "chat.answer", text: "", picks: [{ options: [0] }] })).rejects.toThrow(/do not fit/);
      expect(isOpenQuestion(h.bot.line(QUESTION))).toBe(true);
      expect(h.bot.line(QUESTION).picks).toBeUndefined();
      expect(h.send).not.toHaveBeenCalled();
    } finally { await h.core.shutdown(); }
  });

  it("a pick by index (a phone, an older page) answers the first question and skips the rest", async () => {
    const h = fixture();
    try {
      expect(await h.handle({ type: "chat.choose", index: 0 })).toEqual({ accepted: true });
      expect(h.send.mock.calls[0]![0]).toBe("1. Which database?\n→ Postgres\n2. Which features? (several allowed)\n→ (Skipped)");
      expect(h.bot.line(QUESTION).picks).toEqual([{ options: [0] }, { options: [], skipped: true }]);
    } finally { await h.core.shutdown(); }
  });

  it("words typed instead still answer the whole group", async () => {
    const h = fixture();
    try {
      expect(await h.handle({ type: "chat.answer", text: "Let's talk first" })).toEqual({ accepted: true });
      expect(h.send.mock.calls[0]![0]).toBe("Let's talk first");
      expect(isOpenQuestion(h.bot.line(QUESTION))).toBe(false);
      expect(h.bot.line(QUESTION).picks).toBeUndefined();
    } finally { await h.core.shutdown(); }
  });
});
