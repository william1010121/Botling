// Catch-up's picking (src/catchup.ts): which lines are unread (as the Swift app's CatchUp.swift decided them,
// test/fixtures/prompts-golden.json `catchUp`), and which at most three stay in view. Pure rules: no model.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { catchUpSettings, MAX_CARDS, topCards, unreadMessages, type ChatRecord } from "../src/catchup";
import { desktop } from "../../../test/helpers";

const golden = JSON.parse(readFileSync(join(desktop, "test", "fixtures", "prompts-golden.json"), "utf8")).catchUp;
const records: ChatRecord[] = golden.messages;

const id = (n: number) => `33333333-0000-4000-8000-${String(n).padStart(12, "0")}`;
const line = (n: number, role: string, extra: Partial<ChatRecord> = {}): ChatRecord => ({ id: id(n), role, text: `${role} ${n}`, date: 800_000_000 + n, ...extra });
const ask = (n: number, extra: Partial<ChatRecord> = {}) => line(n, "bot", { choices: [{ label: "Yes" }, { label: "No" }], ...extra });
const card = (n: number, role = "bot") => line(n, role, { displays: [{ name: "chart", data: "{}" }] });
const ids = (list: ChatRecord[]) => list.map((record) => record.id);

describe("which lines are unread", () => {
  it("is what Swift decided", () => {
    expect(unreadMessages(records, 3).map((m) => m.id)).toEqual(golden.unread3);
    expect(unreadMessages(records, 50).map((m) => m.id)).toEqual(golden.unread50);
    expect(unreadMessages(records, 0)).toEqual([]);
  });
});

describe("the messages that stay in view", () => {
  it("at most three, in chat order; the newest bot replies when nothing is special", () => {
    const list = [1, 2, 3, 4, 5, 6].map((n) => line(n, "bot"));
    expect(MAX_CARDS).toBe(3);
    expect(ids(topCards(list))).toEqual([id(4), id(5), id(6)]);
    expect(ids(topCards(list.slice(0, 2)))).toEqual([id(1), id(2)]);
    expect(topCards([])).toEqual([]);
  });

  it("order of importance: open questions, then errors, then replies with cards, then the newest replies", () => {
    const list = [line(1, "bot"), card(2), line(3, "error"), line(4, "bot"), ask(5), line(6, "bot"), card(7), line(8, "bot")];
    // The question (5), the error (3) and the newest card (7) fill the slots; plain replies stay out.
    expect(ids(topCards(list))).toEqual([id(3), id(5), id(7)]);
    // Without the question, the newest cards follow the error: 7 then 2.
    expect(ids(topCards(list.filter((m) => m.id !== id(5))))).toEqual([id(2), id(3), id(7)]);
    // Only the first rule's leftovers go to the next: with no error and no card, the newest replies.
    expect(ids(topCards([line(1, "bot"), line(2, "bot"), ask(3), line(4, "bot")]))).toEqual([id(2), id(3), id(4)]);
  });

  it("errors are picked newest first", () => {
    const list = [line(1, "error"), line(2, "error"), line(3, "error"), line(4, "error"), card(5)];
    expect(ids(topCards(list))).toEqual([id(2), id(3), id(4)]);
  });

  it("a notice or a relay is never picked as a plain reply, a notice with a card can be", () => {
    const list = [line(1, "bot"), line(2, "notice"), line(3, "relay"), line(4, "bot"), line(5, "bot"), line(6, "bot")];
    expect(ids(topCards(list))).toEqual([id(4), id(5), id(6)]);
    expect(ids(topCards([line(1, "bot"), line(2, "bot"), line(3, "bot"), card(4, "notice")]))).toEqual([id(2), id(3), id(4)]);
  });

  it("open questions are never folded, even when there are more than three", () => {
    const list = [ask(1), ask(2), ask(3), ask(4), line(5, "bot"), line(6, "error")];
    expect(ids(topCards(list))).toEqual([id(1), id(2), id(3), id(4)]);
  });

  it("an answered, picked or ignored question is an ordinary reply", () => {
    const list = [ask(1, { chosen: 0 }), ask(2, { answer: "Yes" }), ask(3, { ignoredAt: "2026-11-10T00:00:00Z" }), line(4, "bot"), line(5, "bot"), line(6, "bot")];
    expect(ids(topCards(list))).toEqual([id(4), id(5), id(6)]);
  });

  it("a different limit", () => {
    expect(ids(topCards([1, 2, 3, 4].map((n) => line(n, "bot")), 1))).toEqual([id(4)]);
    expect(topCards([line(1, "bot")], 0)).toEqual([]);
  });
});

describe("the settings", () => {
  it("only the switch and the threshold are read; what an older version kept is ignored", () => {
    const get = (values: Record<string, unknown>) => (key: string) => values[key];
    expect(catchUpSettings(get({}))).toEqual({ catchUpEnabled: true, catchUpThreshold: 3 });
    expect(catchUpSettings(get({ "botling.catchup.unread": false, "botling.catchup.unreadThreshold": 99 }))).toEqual({ catchUpEnabled: false, catchUpThreshold: 50 });
    expect(catchUpSettings(get({
      "botling.catchup.model": "opus", "botling.catchup.engine": "claude", "botling.catchup.prompt": "Be terse.", "botling.catchup.interval": true,
      "botling.catchup.customThresholds": true, "botling.catchup.intervalThreshold": 9,
    }))).toEqual({ catchUpEnabled: true, catchUpThreshold: 3 });
  });
});
