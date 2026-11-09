// Which lines a summary folds (src/catchup.ts `CatchUps`): a reply still waiting for your pick (a <choices>
// card, a question group, a multi-select) never folds behind a card.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../test/helpers";
import { CatchUpCache, CatchUps, isOpenQuestion, type CatchUpChat, type CatchUpSettings, type ChatRecord } from "../src/catchup";

const id = (n: number) => `22222222-0000-4000-8000-${String(n).padStart(12, "0")}`;
const bot = (n: number, extra: Partial<ChatRecord> = {}): ChatRecord => ({ id: id(n), role: "bot", text: `bot ${n}`, date: 800_000_000 + n, engine: "claude", ...extra });
const user = (n: number): ChatRecord => ({ id: id(n), role: "user", text: `user ${n}`, date: 800_000_000 + n });
const options = [{ label: "Yes" }, { label: "No" }];
const ask = (n: number, extra: Partial<ChatRecord> = {}) => bot(n, { choices: options, ...extra });
const group = (n: number, extra: Partial<ChatRecord> = {}) => bot(n, {
  choices: options,
  questions: [{ question: "A?", multiple: false, options }, { question: "B?", multiple: true, options }],
  ...extra,
} as Partial<ChatRecord>);

function setup(settings: Partial<CatchUpSettings> = {}) {
  const catchUps = new CatchUps({
    cache: new CatchUpCache(join(tempDir("catchup-fold"), "summaries.json")),
    summarizer: async () => ["done"],
    settings: () => ({ catchUpEnabled: true, catchUpThreshold: 3, intervalSummaryEnabled: true, intervalSummaryThreshold: 3, model: "m", engine: "codex", writingPrompt: null, ...settings }),
    language: () => "en",
    changed: () => {},
  });
  return { catchUps };
}
const chat = (records: ChatRecord[], unread = records.length): CatchUpChat => ({ id: "main", name: "Garden", records, unread });
const folded = (catchUps: CatchUps, c: CatchUpChat) => catchUps.decorations(c).map((d) => ({ kind: d.data.kind, fold: d.fold, key: d.data.key }));

describe("unanswered questions stay out of a summary", () => {
  it("an open question: choices with no pick, no answer, not ignored", () => {
    expect(isOpenQuestion(ask(1))).toBe(true);
    expect(isOpenQuestion(group(1))).toBe(true);
    expect(isOpenQuestion(ask(1, { chosen: 0 }))).toBe(false);
    expect(isOpenQuestion(ask(1, { answer: "Yes" }))).toBe(false);
    expect(isOpenQuestion(group(1, { answer: "A: Yes", picks: [{ options: [0] }, { options: [1] }] } as Partial<ChatRecord>))).toBe(false);
    expect(isOpenQuestion(ask(1, { ignoredAt: "2026-11-10T00:00:00Z" } as Partial<ChatRecord>))).toBe(false);
    expect(isOpenQuestion(bot(1))).toBe(false);
  });

  it("folds the other unread replies and leaves each open question in the chat", () => {
    const { catchUps } = setup();
    const records = [user(0), bot(1), ask(2), bot(3), group(4), bot(5), bot(6), ask(7, { chosen: 1 })];
    const c = chat(records, 7);
    catchUps.arrive(c);
    const [summary] = folded(catchUps, c);
    expect(summary?.kind).toBe("unread");
    expect(summary?.fold).toEqual([id(1), id(3), id(5), id(6), id(7)]);
  });

  it("no catch-up when too few replies are left once the open questions stay out", () => {
    const { catchUps } = setup();
    const c = chat([user(0), ask(1), ask(2), ask(3), group(4), bot(5), bot(6)], 6);
    catchUps.arrive(c);
    expect(folded(catchUps, c)).toEqual([]);
  });

  it("a question answered after the card was made stays where it is", () => {
    const { catchUps } = setup();
    const records = [user(0), bot(1), ask(2), bot(3), bot(4), bot(5)];
    catchUps.arrive(chat(records, 5));
    const later = chat([user(0), bot(1), ask(2, { chosen: 0 }), bot(3), bot(4), bot(5), user(6)], 0);
    expect(folded(catchUps, later)[0]?.fold).toEqual([id(1), id(3), id(4), id(5)]);
  });

  it("interval summaries leave open questions out too; an interval of only open questions is not summarized", () => {
    const { catchUps } = setup();
    const records = [user(0), bot(1), group(2), bot(3), bot(4), user(5)];
    catchUps.closedInterval(chat(records, 0), id(5));
    expect(folded(catchUps, chat(records, 0))).toMatchObject([{ kind: "interval", fold: [id(1), id(3), id(4)] }]);
    const questions = [user(10), ask(11), group(12), user(13)];
    expect(catchUps.interval(chat(questions, 0), id(10))).toBe(false);
  });
});
