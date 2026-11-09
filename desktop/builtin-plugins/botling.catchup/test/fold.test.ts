// Which lines a summary folds (src/catchup.ts `CatchUps`): a reply still waiting for your pick (a <choices>
// card, a question group, a multi-select) never folds behind a card, and "Show original messages" dissolves a
// card for good (kept in the plugin's storage, so it stays dissolved after a reload or a chat switch).
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../../../test/helpers";
import { CatchUpCache, CatchUps, ExpandedRanges, isOpenQuestion, type CatchUpChat, type CatchUpSettings, type ChatRecord } from "../src/catchup";

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

function setup(storage: Record<string, unknown> = {}, settings: Partial<CatchUpSettings> = {}) {
  const store = { get: (key: string) => storage[key], set: (key: string, value: unknown) => { storage[key] = value; } };
  const catchUps = new CatchUps({
    cache: new CatchUpCache(join(tempDir("catchup-fold"), "summaries.json")),
    summarizer: async () => ["done"],
    settings: () => ({ catchUpEnabled: true, catchUpThreshold: 3, intervalSummaryEnabled: true, intervalSummaryThreshold: 3, model: "m", engine: "codex", writingPrompt: null, ...settings }),
    language: () => "en",
    changed: () => {},
    expanded: new ExpandedRanges(store),
  });
  return { catchUps, storage };
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

describe("Show original messages", () => {
  it("dissolves the catch-up card, and it stays dissolved for a new run on the same storage", () => {
    const storage: Record<string, unknown> = {};
    const records = [user(0), bot(1), bot(2), bot(3), bot(4)];
    const first = setup(storage).catchUps;
    first.arrive(chat(records, 4));
    const [summary] = folded(first, chat(records, 4));
    expect(summary).toBeDefined();
    expect(first.expand(chat(records, 4), summary!.key)).toBe(true);
    expect(folded(first, chat(records, 4))).toEqual([]);
    // Reload: a fresh program part, the same plugin storage.
    const again = setup(storage).catchUps;
    again.arrive(chat(records, 4));
    expect(folded(again, chat(records, 4))).toEqual([]);
    // A different stretch of unread replies still gets its card.
    const more = [...records, user(5), bot(6), bot(7), bot(8), bot(9)];
    again.arrive(chat(more, 4));
    expect(folded(again, chat(more, 4))[0]?.fold).toEqual([id(6), id(7), id(8), id(9)]);
  });

  it("dissolves an interval summary; it is not summarized again by itself, but asking for it brings it back", () => {
    const storage: Record<string, unknown> = {};
    const records = [user(0), bot(1), bot(2), bot(3), user(4)];
    const { catchUps } = setup(storage);
    catchUps.closedInterval(chat(records, 0), id(4));
    const [summary] = folded(catchUps, chat(records, 0));
    expect(catchUps.expand(chat(records, 0), summary!.key)).toBe(true);
    expect(folded(catchUps, chat(records, 0))).toEqual([]);
    const again = setup(storage).catchUps;
    again.closedInterval(chat(records, 0), id(4));
    expect(folded(again, chat(records, 0))).toEqual([]);
    expect(again.interval(chat(records, 0), id(0))).toBe(true);
    expect(folded(again, chat(records, 0))).toMatchObject([{ kind: "interval", fold: [id(1), id(2), id(3)] }]);
  });

  it("an unknown key changes nothing", () => {
    const { catchUps, storage } = setup();
    expect(catchUps.expand(chat([user(0), bot(1)], 0), "nope")).toBe(false);
    expect(storage).toEqual({});
  });
});
