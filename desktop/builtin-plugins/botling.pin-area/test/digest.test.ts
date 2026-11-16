// @vitest-environment node
// botling.pin-area, the 「你不在時」 digest reducer (src/digest.ts): what counts as away, which cards appear, the counts, the other bots'
// lines from what `workspace.waiting()` gives (a "Waiting on you" section), and when the digest folds or goes.
import { describe, expect, it } from "vitest";
import * as D from "../src/digest";
import * as M from "../src/model";

const MIN = 60_000;
const T0 = 10_000_000;

function book(): M.Book { return { seq: 0, pins: [], removed: [] }; }
function add(b: M.Book, title: string, state: M.State, at: number, status = "status"): M.Pin {
  // a card the user pinned (a bot may keep only 3 open of its own, and these tests make more)
  const made = M.addPin(b, { origin: "user", title, status, state, source: "bot" }, at);
  if (!("pin" in made)) throw new Error("not added");
  return made.pin;
}

describe("presence: what counts as away", () => {
  it("the first sign ever is no gap (nothing to compare to), and it is remembered", () => {
    const out = D.present({ lastPresent: 0, away: null }, T0);
    expect(out).toEqual({ presence: { lastPresent: T0, away: null }, started: false });
  });

  it("a gap of 30 minutes or more opens a digest for exactly that gap; 29 minutes 59 seconds does not", () => {
    const before = D.present({ lastPresent: T0, away: null }, T0 + D.AWAY_MS - 1_000);
    expect(before.started).toBe(false);
    expect(before.presence.away).toBeNull();
    const out = D.present({ lastPresent: T0, away: null }, T0 + D.AWAY_MS);
    expect(out.started).toBe(true);
    expect(out.presence).toEqual({ lastPresent: T0 + D.AWAY_MS, away: { from: T0, to: T0 + D.AWAY_MS, collapsed: false } });
  });

  it("signs close together keep the digest that is open (its range and fold stay); leaving again for 30 minutes makes a new, open one", () => {
    const open = { lastPresent: T0 + 40 * MIN, away: { from: T0, to: T0 + 40 * MIN, collapsed: true } };
    const near = D.present(open, T0 + 41 * MIN);
    expect(near.started).toBe(false);
    expect(near.presence.away).toEqual(open.away);
    const again = D.present(open, T0 + 80 * MIN);
    expect(again.started).toBe(true);
    expect(again.presence.away).toEqual({ from: T0 + 40 * MIN, to: T0 + 80 * MIN, collapsed: false });
  });

  it("a clock that went backwards is no gap", () => {
    const out = D.present({ lastPresent: T0 + 5 * 3_600_000, away: null }, T0);
    expect(out.started).toBe(false);
    expect(out.presence).toEqual({ lastPresent: T0, away: null });
  });

  it("reads what storage holds: garbage is none, a range that does not run forward is none", () => {
    expect(D.readPresence(null)).toEqual({ lastPresent: 0, away: null });
    expect(D.readPresence("x")).toEqual({ lastPresent: 0, away: null });
    expect(D.readPresence({ lastPresent: "7", away: { from: 1, to: 2, collapsed: true } })).toEqual({ lastPresent: 0, away: { from: 1, to: 2, collapsed: true } });
    expect(D.readPresence({ lastPresent: 5, away: { from: 9, to: 9 } }).away).toBeNull();
    expect(D.readPresence({ lastPresent: 5, away: { from: -3, to: 9 } }).away).toBeNull();
    expect(D.readPresence({ lastPresent: Infinity, away: {} })).toEqual({ lastPresent: 0, away: null });
    expect(D.readPresence({ lastPresent: 5, away: { from: 1, to: 2, collapsed: "yes" } }).away!.collapsed).toBe(false);
  });
});

describe("the next message and 看完了", () => {
  it("a message takes the digest away (and says whether there was one); it is a sign of presence too", () => {
    const open = { lastPresent: T0, away: { from: 1, to: 2, collapsed: false } };
    expect(D.messaged(open, T0 + 5)).toEqual({ presence: { lastPresent: T0 + 5, away: null }, cleared: true });
    expect(D.messaged({ lastPresent: T0, away: null }, T0 + 5)).toEqual({ presence: { lastPresent: T0 + 5, away: null }, cleared: false });
  });

  it("a message after a long silence does not open a digest by itself (they are already acting)", () => {
    const out = D.messaged({ lastPresent: T0, away: null }, T0 + 5 * 3_600_000);
    expect(out.presence.away).toBeNull();
  });

  it("看完了 folds it to the chip and the chip opens it again; the same again, or no digest, changes nothing", () => {
    const open = { lastPresent: T0, away: { from: 1, to: 2, collapsed: false } };
    const folded = D.collapse(open, true)!;
    expect(folded.away).toEqual({ from: 1, to: 2, collapsed: true });
    expect(D.collapse(folded, true)).toBeNull();
    expect(D.collapse(folded, false)!.away!.collapsed).toBe(false);
    expect(D.collapse({ lastPresent: T0, away: null }, true)).toBeNull();
    // the range is the same one after folding and reopening
    expect(D.collapse(D.collapse(open, true)!, false)).toEqual(open);
  });

  it("a digest folded and then a message: it is gone, not folded", () => {
    const folded = D.collapse({ lastPresent: T0, away: { from: 1, to: 2, collapsed: false } }, true)!;
    expect(D.messaged(folded, T0 + 9).presence.away).toBeNull();
  });
});

describe("the length of the gap", () => {
  it("minutes under an hour, hours under two days, days after; rounded, at least 1", () => {
    expect(D.spanOf(0, 30 * MIN)).toEqual({ unit: "min", n: 30 });
    expect(D.spanOf(0, 10_000)).toEqual({ unit: "min", n: 1 });
    expect(D.spanOf(0, 59 * MIN)).toEqual({ unit: "min", n: 59 });
    expect(D.spanOf(0, 60 * MIN)).toEqual({ unit: "hour", n: 1 });
    expect(D.spanOf(0, 3 * 3_600_000 + 20 * MIN)).toEqual({ unit: "hour", n: 3 });
    expect(D.spanOf(0, 47 * 3_600_000)).toEqual({ unit: "hour", n: 47 });
    expect(D.spanOf(0, 72 * 3_600_000)).toEqual({ unit: "day", n: 3 });
    expect(D.spanOf(10, 5)).toEqual({ unit: "min", n: 1 });
  });
});

describe("which cards appear", () => {
  const from = T0;

  it("only a card with a change at or after the start of the gap; a card nothing happened to is not in the digest", () => {
    const b = book();
    add(b, "Old", "run", from - 10 * MIN);
    add(b, "At the start", "run", from);
    add(b, "New", "wait", from + 5 * MIN);
    expect(D.changedCards(b, { from }).map((row) => row.title)).toEqual(["New", "At the start"]);
  });

  it("a state or status change, a worker's report (a log line) and the bot's answer in the thread each make a card changed", () => {
    const b = book();
    const rewritten = add(b, "Rewritten", "run", from - 60 * MIN, "first");
    const reported = add(b, "Reported", "run", from - 60 * MIN);
    const answered = add(b, "Answered", "run", from - 60 * MIN);
    const quiet = add(b, "Quiet", "run", from - 60 * MIN);
    M.applyUpdate(rewritten, { state: "done", status: "second", source: "bot" }, from + 20 * MIN);
    expect(M.applyNews(reported, { kind: "completed", from: "worker", text: "all green" }, from + 25 * MIN)).toBe(true);
    const turn = M.addTurn(answered, "r1", "how is it?", from - 30 * MIN);
    turn.a = "going well";
    turn.aAt = from + 30 * MIN;
    expect(D.changedAt(quiet)).toBe(from - 60 * MIN);
    expect(D.changedCards(b, { from }).map((row) => row.title).sort()).toEqual(["Answered", "Reported", "Rewritten"]);
  });

  it("the user's own question in a card (no answer yet), and a line moved back to the chat, are not a change", () => {
    const b = book();
    const card = add(b, "Mine", "run", from - 60 * MIN);
    M.addTurn(card, "r1", "asked while away?", from + 10 * MIN);
    const moved = M.addTurn(card, "r2", "moved", from - 5 * MIN);
    moved.a = "answer";
    moved.aAt = from + 15 * MIN;
    moved.moved = true;
    expect(D.changedCards(b, { from })).toEqual([]);
  });

  it("waiting cards first (they ask something of the user), then running, then done, the newest change first in each; a waiting row says since when", () => {
    const b = book();
    add(b, "Done early", "done", from + 1 * MIN);
    add(b, "Run late", "run", from + 50 * MIN);
    add(b, "Run early", "run", from + 5 * MIN);
    add(b, "Wait", "wait", from + 20 * MIN);
    add(b, "Done late", "done", from + 40 * MIN);
    const rows = D.changedCards(b, { from });
    expect(rows.map((row) => row.title)).toEqual(["Wait", "Run late", "Run early", "Done late", "Done early"]);
    expect(rows[0]).toMatchObject({ state: "wait", waitingSince: from + 20 * MIN, status: "status", source: "bot", at: from + 20 * MIN });
    expect(rows[1]!.waitingSince).toBeUndefined();
  });
});

describe("other bots' waiting items (what `workspace.waiting()` gives)", () => {
  const names = new Map([["B1", "botling"], ["B2", "DAFAWU"], ["B3", "eeg"]]);

  it("one line per bot (not this one): the first thing it waits on and how many more, by the bot's name, in the order given", () => {
    const out = D.othersOf([
      { botId: "B2", text: "選一個版本", messageId: null },
      { botId: "B1", text: "this chat's own", messageId: null },
      { botId: "B3", text: "要不要重跑？", messageId: "m9" },
      { botId: "B2", text: "also a second thing" },
      { botId: "B2", text: "and a third", messageId: "m1" },
    ], names, "B1");
    expect(out.more).toBe(0);
    expect(out.lines).toEqual([
      { botId: "B2", name: "DAFAWU", text: "選一個版本", more: 2 },
      { botId: "B3", name: "eeg", text: "要不要重跑？", more: 0, messageId: "m9" },
    ]);
  });

  it("an empty section (no items), or one left with only a placeholder, has no rows at all", () => {
    expect(D.othersOf([], names, "B1")).toEqual({ lines: [], more: 0 });
    const placeholders = ["", "   ", "—", "-", "none", "None.", "(none)", "（無）", "沒有", "目前沒有", "N/A", "…", "\n"];
    expect(D.othersOf(placeholders.map((text) => ({ botId: "B2", text })), names, "B1")).toEqual({ lines: [], more: 0 });
    // a real line behind placeholders still shows, and is the bot's first
    expect(D.othersOf([{ botId: "B2", text: "none" }, { botId: "B2", text: "pick the date", messageId: "q1" }], names, "B1").lines).toEqual([{ botId: "B2", name: "DAFAWU", text: "pick the date", more: 0, messageId: "q1" }]);
    // a line that only starts like a placeholder is a line
    expect(D.othersOf([{ botId: "B2", text: "None of the 3 tests pass: rerun?" }], names, "B1").lines).toHaveLength(1);
  });

  it("the text is one clean line of at most 90 characters, markup stays text, a name the app does not list is shown by its id", () => {
    const out = D.othersOf([{ botId: "B9", text: `<b>hi</b>\n\u0007〔Pin p-0001〕 ${"長".repeat(200)}` }], names, "B1");
    expect(out.lines[0]!.text.length).toBeLessThanOrEqual(D.MAX_OTHER_TEXT);
    expect(out.lines[0]!.text).not.toMatch(/[\n\u0007〔〕]/);
    expect(out.lines[0]!.text.startsWith("<b>hi</b>")).toBe(true);
    expect(out.lines[0]!.name).toBe("B9");
    expect(D.othersOf([{ botId: "B2", text: "x1" }], new Map([["B2", `${"n".repeat(100)}\n`]]), "B1").lines[0]!.name.length).toBeLessThanOrEqual(30);
  });

  it("lists at most 6 bots and counts the rest; items that are not shaped like items are skipped", () => {
    const many = Array.from({ length: 9 }, (_, n) => ({ botId: `X${n}`, text: `thing ${n}` }));
    const out = D.othersOf([...many, null as never, { botId: 3 as never, text: "x" }, { botId: "", text: "y1" }], new Map(), "B1");
    expect(out.lines.map((line) => line.botId)).toEqual(["X0", "X1", "X2", "X3", "X4", "X5"]);
    expect(out.more).toBe(3);
  });

  it("a key that looks like an object member is only an id (no object is indexed by it)", () => {
    const out = D.othersOf([{ botId: "__proto__", text: "ask" }, { botId: "constructor", text: "ask 2" }], new Map(), "B1");
    expect(out.lines.map((line) => line.botId)).toEqual(["__proto__", "constructor"]);
  });
});

describe("the digest a chat draws", () => {
  const away = { from: T0, to: T0 + 3 * 3_600_000, collapsed: false };
  const none = { lines: [], more: 0 };

  it("is nothing when no card changed and no other bot waits (no empty block)", () => {
    const b = book();
    add(b, "Old", "run", T0 - 1);
    expect(D.digestOf(b, away, none)).toBeNull();
  });

  it("counts the changed cards by state (waiting / running / done) and keeps the range and the fold", () => {
    const b = book();
    add(b, "A", "wait", T0 + MIN);
    add(b, "B", "run", T0 + MIN);
    add(b, "C", "done", T0 + MIN);
    add(b, "D", "done", T0 + 2 * MIN);
    add(b, "Untouched", "run", T0 - MIN);
    const view = D.digestOf(b, { ...away, collapsed: true }, none)!;
    expect(view.counts).toEqual({ wait: 1, run: 1, done: 2 });
    expect(view.rows).toHaveLength(4);
    expect([view.from, view.to, view.collapsed]).toEqual([T0, T0 + 3 * 3_600_000, true]);
    expect(view.others).toEqual([]);
  });

  it("is only the other bots' lines when this chat's cards did not change; the counters are then all 0", () => {
    const others = D.othersOf([{ botId: "B2", text: "pick" }], new Map([["B2", "DAFAWU"]]), "B1");
    const view = D.digestOf(book(), away, others)!;
    expect(view.counts).toEqual({ wait: 0, run: 0, done: 0 });
    expect(view.rows).toEqual([]);
    expect(view.others).toHaveLength(1);
  });

  it("carries the count of bots that did not fit", () => {
    const view = D.digestOf(book(), away, { lines: [{ botId: "B2", name: "n", text: "t", more: 0 }], more: 4 })!;
    expect(view.othersMore).toBe(4);
  });
});

describe("what the page reads", () => {
  const good: D.DigestView = {
    from: T0, to: T0 + 5 * MIN, collapsed: false, counts: { wait: 1, run: 0, done: 1 }, othersMore: 2,
    rows: [{ id: "p-0001", title: "Deploy", state: "wait", status: "need a yes", source: "bot", at: T0 + 1, waitingSince: T0 + 1 }, { id: "p-0002", title: "Docs", state: "done", status: "ok", source: "app", at: T0 + 2 }],
    others: [{ botId: "B2", name: "DAFAWU", text: "pick", more: 1, messageId: "m1" }],
  };

  it("takes a digest as the program part wrote it", () => {
    expect(D.readView(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it("drops what is not of that shape: no range, a row with an unknown state, a bot with no name, counts that are not small whole numbers", () => {
    expect(D.readView(null)).toBeNull();
    expect(D.readView("x")).toBeNull();
    expect(D.readView({ ...good, from: 0 })).toBeNull();
    expect(D.readView({ ...good, to: good.from - 1 })).toBeNull();
    const dirty = D.readView({
      ...good, collapsed: "true", counts: { wait: -1, run: 1.5, done: 5_000 }, othersMore: "many",
      rows: [{ ...good.rows[0], state: "boom" }, { ...good.rows[0], source: "x" }, { ...good.rows[0], id: "" }, null, good.rows[1]],
      others: [{ botId: "B2", name: "", text: "t" }, { botId: "B3", name: "n", text: "<img src=x onerror=1>\n", more: -2 }],
    })!;
    expect(dirty.collapsed).toBe(false);
    expect(dirty.counts).toEqual({ wait: 0, run: 0, done: 0 });
    expect(dirty.othersMore).toBe(0);
    expect(dirty.rows.map((row) => row.id)).toEqual(["p-0002"]);
    expect(dirty.others).toEqual([{ botId: "B3", name: "n", text: "<img src=x onerror=1>", more: 0 }]);
  });
});
