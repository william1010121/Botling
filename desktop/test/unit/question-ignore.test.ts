import { describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseInbound } from "../../src/contract";
import { Core } from "../../src/core/server";
import { saveProjectRow } from "../../src/core/projects";
import { MAIN_BOT_ID, isOpenQuestion } from "../../src/core/store/records";
import { tempDir } from "../helpers";

const PROJECT = "98BDBF26-850C-4521-AEB4-CCF9073E8BD0";
const QUESTION = "DD43524E-1FC7-4DD6-9A50-4A129ADD64AA";
const COPY = "DD43524E-1FC7-4DD6-9A50-4A129ADD64AB";
function fixture(extra = {}) {
  const dir = tempDir("question-ignore");
  const folder = tempDir("question-ignore-project");
  mkdirSync(join(folder, ".bot"), { recursive: true });
  saveProjectRow(dir, { id: PROJECT, name: "botling", folder, avatar: "triangle" });
  const store = join(dir, "projects", PROJECT);
  mkdirSync(store, { recursive: true });
  const file = join(store, "chat.json");
  const question = { id: QUESTION, role: "bot", text: "Publish now?", date: 814897456.479, choices: [{ label: "Yes" }, { label: "No" }], ...extra };
  writeFileSync(file, JSON.stringify([question]));
  const events: any[] = [];
  const open = () => new Core({ dataDir: dir, headConfig() { throw new Error("No agent allowed"); }, emit(event) { events.push(event); }, deferStartup: true,
    routineTickMs: 0, componentScanMs: 0, waitingScanMs: 0, watchMs: 0, quitTidyMs: 0 });
  return { file, question, events, open };
}
const botOf = (core: Core): any => (core as any).bot(PROJECT);
const ignore = (core: Core, id = QUESTION) => (core as any).ignoreQuestion(PROJECT, id);

describe("ignore question as notification", () => {
  it("routes only a question identity, with no answer or authorization fields", async () => {
    const cmd = { type: "chat.ignoreQuestion", botId: PROJECT, messageId: QUESTION };
    expect(parseInbound({ v: 10, id: "ignore", cmd }).ok).toBe(true);
    expect(parseInbound({ v: 10, id: "ignore", cmd: { ...cmd, index: 0 } }).ok).toBe(false);
    const h = fixture(), core = h.open();
    try {
      // Exercise dispatch without activating startup agents or background routines.
      (core as any).activated = true;
      expect(await (core as any).handle(cmd, new AbortController().signal)).toEqual({ accepted: true });
      expect(botOf(core).line(QUESTION).ignoredAt).toBeDefined();
    } finally { await core.shutdown(); }
  });
  it("persists a separate ignored disposition, removes waiting, emits an audit update and never sends or closes work", async () => {
    const h = fixture(); let core = h.open();
    try {
      const bot = botOf(core), send = vi.spyOn(bot, "send");
      const beforeTasks = JSON.stringify(bot.snapshot().tasks);
      expect(core.waiting().items.some(x => x.messageId === QUESTION)).toBe(true);
      expect(ignore(core)).toEqual({ accepted: true });
      expect(ignore(core)).toEqual({ accepted: false });
      const saved = JSON.parse(readFileSync(h.file, "utf8"))[0];
      expect(saved).toMatchObject(h.question);
      expect(saved.ignoredAt).toEqual(expect.any(String));
      expect(saved.chosen).toBeUndefined(); expect(saved.answer).toBeUndefined();
      expect(isOpenQuestion(saved)).toBe(false);
      expect(bot.choose(QUESTION, 0)).toEqual({ accepted: false });
      expect(bot.answer(QUESTION, "Yes")).toEqual({ accepted: false });
      expect(send).not.toHaveBeenCalled();
      expect(JSON.stringify(bot.snapshot().tasks)).toBe(beforeTasks);
      expect(core.waiting().items.some(x => x.messageId === QUESTION)).toBe(false);
      expect(h.events.some(x => x.event?.type === "message.updated" && x.event.message.ignoredAt === saved.ignoredAt)).toBe(true);
      await core.shutdown(); core = h.open();
      expect(botOf(core).line(QUESTION).ignoredAt).toBe(saved.ignoredAt);
      expect(core.waiting().items.some(x => x.messageId === QUESTION)).toBe(false);
      expect(ignore(core)).toEqual({ accepted: false });
    } finally { await core.shutdown(); }
  });
  it("does not override answered questions or consume a pending authorization", async () => {
    for (const extra of [{ chosen: 0 }, { answer: "No" }, { permissionTool: "Bash" }]) {
      const h = fixture(extra), core = h.open();
      try {
        const before = readFileSync(h.file, "utf8");
        expect(ignore(core)).toEqual({ accepted: false });
        expect(readFileSync(h.file, "utf8")).toBe(before);
      } finally { await core.shutdown(); }
    }
  });
  it("synchronizes a persisted copy with its original without invoking answer callbacks", async () => {
    const h = fixture(); let core = h.open();
    try {
      (core as any).showOpenQuestion("botling");
      const copy = (core as any).bot(MAIN_BOT_ID).openCopies(PROJECT)[0];
      expect(copy).toBeDefined();
      expect((core as any).ignoreQuestion(MAIN_BOT_ID, copy.id)).toEqual({ accepted: true });
      await core.shutdown(); core = h.open();
      const restored = (core as any).bot(MAIN_BOT_ID).line(copy.id);
      expect(restored.ignoredAt).toBe(botOf(core).line(QUESTION).ignoredAt);
      expect(restored.answer).toBeUndefined(); expect(restored.chosen).toBeUndefined();
    } finally { await core.shutdown(); }
  });
  it("restart before Ignore synchronizes an invalidated copy and persists notification semantics", async () => {
    const h = fixture(); let core = h.open();
    try {
      (core as any).showOpenQuestion("botling");
      const copyId = (core as any).bot(MAIN_BOT_ID).openCopies(PROJECT)[0].id;
      await core.shutdown(); core = h.open();
      const main = (core as any).bot(MAIN_BOT_ID), send = vi.spyOn(main, "send");
      expect(isOpenQuestion(main.line(copyId))).toBe(false);
      expect(ignore(core)).toEqual({ accepted: true });
      const original = botOf(core).line(QUESTION), copy = main.line(copyId);
      expect(copy.ignoredAt).toBe(original.ignoredAt);
      expect(copy.answer).toBeUndefined(); expect(copy.chosen).toBeUndefined();
      expect(copy.questionInvalidatedAt).toEqual(expect.any(String));
      expect(main.snapshot().messages.find((m: any) => m.id === copyId)).toMatchObject({ ignoredAt: original.ignoredAt, answer: null, chosen: null });
      expect(main.choose(copyId, 0)).toEqual({ accepted: false });
      expect(main.answer(copyId, "Yes")).toEqual({ accepted: false });
      expect(send).not.toHaveBeenCalled();
      expect(ignore(core)).toEqual({ accepted: false });
      expect(core.waiting().items.some(item => item.messageId === QUESTION)).toBe(false);
      await core.shutdown(); core = h.open();
      expect((core as any).bot(MAIN_BOT_ID).line(copyId)).toMatchObject({ ignoredAt: original.ignoredAt, questionInvalidatedAt: copy.questionInvalidatedAt });
    } finally { await core.shutdown(); }
  });
  it("does not overwrite answered copies, even answers identical to old system status words", async () => {
    const h = fixture(); let core = h.open();
    try {
      const main = (core as any).bot(MAIN_BOT_ID);
      const protectedCopies: any[] = [];
      for (const outcome of [{ answer: "No longer needed" }, { answer: "stop" }, { answer: "finish" }, { chosen: 0 }]) {
        (core as any).showOpenQuestion("botling");
        const copy = main.openCopies(PROJECT)[0];
        main.settleAppQuestion(copy.id, outcome);
        protectedCopies.push({ ...copy });
      }
      await core.shutdown(); core = h.open();
      expect(ignore(core)).toEqual({ accepted: true });
      for (const copy of protectedCopies) expect((core as any).bot(MAIN_BOT_ID).line(copy.id)).toEqual(copy);
    } finally { await core.shutdown(); }
  });
  it("does not invoke app question callbacks", async () => {
    const h = fixture(), core = h.open();
    try {
      const bot = botOf(core), pick = vi.fn(), answer = vi.fn();
      const id = bot.appNotice("Proceed?", [{ label: "Yes", recommended: true }], pick, { onAnswer: answer });
      expect(ignore(core, id)).toEqual({ accepted: true });
      expect(bot.choose(id, 0)).toEqual({ accepted: false });
      expect(bot.answer(id, "Yes")).toEqual({ accepted: false });
      expect(pick).not.toHaveBeenCalled(); expect(answer).not.toHaveBeenCalled();
    } finally { await core.shutdown(); }
  });
  it("keeps normal Answer dispatch and rejects stale Ignore", async () => {
    const h = fixture(), core = h.open();
    try {
      const bot = botOf(core), send = vi.spyOn(bot, "send").mockReturnValue({});
      expect(bot.answer(QUESTION, "Not yet")).toEqual({ accepted: true });
      expect(send).toHaveBeenCalledWith("Not yet", expect.objectContaining({ replyTo: QUESTION }));
      expect(ignore(core)).toEqual({ accepted: false });
      expect(bot.line(QUESTION).answer).toBe("Not yet");
    } finally { await core.shutdown(); }
  });
  it("ignores linked decision views without choosing an option", async () => {
    const h = fixture({ decisionID: QUESTION, engine: "claude" });
    writeFileSync(h.file, JSON.stringify([h.question, { ...h.question, id: COPY }]));
    const core = h.open();
    try {
      expect(ignore(core, COPY)).toEqual({ accepted: true });
      const bot = botOf(core);
      expect(bot.line(COPY).ignoredAt).toBe(bot.line(QUESTION).ignoredAt);
      expect(bot.choose(QUESTION, 0)).toEqual({ accepted: false });
      expect(bot.answer(COPY, "Yes")).toEqual({ accepted: false });
    } finally { await core.shutdown(); }
  });
});
