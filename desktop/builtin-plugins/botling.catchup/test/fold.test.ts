// What `CatchUps` folds (src/catchup.ts): everything unread except the top three; a reply still waiting for your
// pick (a <choices> card, a question group, a multi-select) is one of those and never folds.
import { describe, expect, it } from "vitest";
import { CatchUps, isOpenQuestion, type CatchUpChat, type CatchUpSettings, type ChatRecord } from "../src/catchup";

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
  const changed: string[] = [];
  const catchUps = new CatchUps({ settings: () => ({ catchUpEnabled: true, catchUpThreshold: 3, ...settings }), changed: (chatId) => changed.push(chatId) });
  return { catchUps, changed };
}
const chat = (records: ChatRecord[], unread = records.length): CatchUpChat => ({ id: "main", name: "Garden", records, unread });
const folded = (catchUps: CatchUps, c: CatchUpChat) => catchUps.decorations(c).map((d) => ({ fold: d.fold, important: d.data.important, key: d.data.key }));

describe("the fold", () => {
  it("six unread replies: the newest three stay, the other three fold behind one header", () => {
    const { catchUps, changed } = setup();
    const c = chat([user(0), ...[1, 2, 3, 4, 5, 6].map((n) => bot(n))], 6);
    catchUps.arrive(c);
    expect(changed).toEqual(["main"]);
    expect(folded(catchUps, c)).toEqual([{ fold: [id(1), id(2), id(3)], important: 3, key: `${id(1)}-${id(3)}` }]);
    expect(catchUps.decorations(c)[0]).toMatchObject({ key: `unread:${id(1)}-${id(3)}`, data: { kind: "unread" } });
  });

  it("the picked ones are the important ones: an error and a card stay in view, not just the newest", () => {
    const { catchUps } = setup();
    const records = [user(0), bot(1, { displays: [{ name: "chart", data: "{}" }] }), bot(2), { ...bot(3), role: "error" }, bot(4), bot(5), bot(6)];
    const c = chat(records, 6);
    catchUps.arrive(c);
    // The error (3), the card (1) and the newest reply (6) stay; 2, 4 and 5 fold. Folded lines never include picked ones.
    expect(folded(catchUps, c)[0]).toMatchObject({ fold: [id(2), id(4), id(5)], important: 3 });
  });

  it("not more than the threshold of unread replies: nothing folds; off: nothing folds", () => {
    const small = setup();
    const c = chat([user(0), bot(1), bot(2), bot(3)], 3);
    small.catchUps.arrive(c);
    expect(folded(small.catchUps, c)).toEqual([]);
    const off = setup({ catchUpEnabled: false });
    const many = chat([user(0), ...[1, 2, 3, 4, 5, 6].map((n) => bot(n))], 6);
    off.catchUps.arrive(many);
    expect(folded(off.catchUps, many)).toEqual([]);
    expect(off.changed).toEqual([]);
  });

  it("a threshold of 5 folds from the sixth reply on", () => {
    const { catchUps } = setup({ catchUpThreshold: 5 });
    const five = chat([1, 2, 3, 4, 5].map((n) => bot(n)));
    catchUps.arrive(five);
    expect(folded(catchUps, five)).toEqual([]);
    const six = chat([1, 2, 3, 4, 5, 6].map((n) => bot(n)));
    catchUps.arrive(six);
    expect(folded(catchUps, six)[0]?.fold).toEqual([id(1), id(2), id(3)]);
  });

  it("the same chat again changes nothing, so nothing is drawn twice", () => {
    const { catchUps, changed } = setup();
    const c = chat([1, 2, 3, 4, 5, 6].map((n) => bot(n)));
    catchUps.arrive(c);
    catchUps.arrive(c);
    expect(changed).toHaveLength(1);
    catchUps.arrive(chat([1, 2, 3, 4, 5, 6, 7].map((n) => bot(n)), 7));
    expect(changed).toHaveLength(2);
  });

  it("lines that are gone from the chat are dropped from the fold", () => {
    const { catchUps } = setup();
    catchUps.arrive(chat([1, 2, 3, 4, 5, 6].map((n) => bot(n))));
    const later = chat([2, 3, 4, 5, 6, 7].map((n) => bot(n)), 0);
    expect(folded(catchUps, later)[0]?.fold).toEqual([id(2), id(3)]);
    expect(folded(catchUps, chat([bot(6)], 0))).toEqual([]);
  });
});

describe("unanswered questions stay in view", () => {
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
    const [fold] = folded(catchUps, c);
    // Questions 2 and 4 take two slots; the newest bot reply (7, answered) takes the third.
    expect(fold?.fold).toEqual([id(1), id(3), id(5), id(6)]);
    expect(fold?.important).toBe(3);
  });

  it("no header when what is left to fold holds no replies", () => {
    const { catchUps, changed } = setup();
    const c = chat([user(0), ask(1), ask(2), group(3), ask(4)], 4);
    catchUps.arrive(c);
    expect(folded(catchUps, c)).toEqual([]);
    expect(changed).toEqual([]);
  });

  it("a question answered after the header was made stays where it is, and its line is not folded", () => {
    const { catchUps } = setup();
    catchUps.arrive(chat([user(0), bot(1), ask(2), bot(3), bot(4), bot(5)], 5));
    const later = chat([user(0), bot(1), ask(2, { chosen: 0 }), bot(3), bot(4), bot(5), user(6)], 0);
    expect(folded(catchUps, later)[0]?.fold).toEqual([id(1), id(3)]);
  });
});
