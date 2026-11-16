// @vitest-environment node
// The pin rules with no Botling around them: what storage may hold, what a bot's tag may do, which message goes into which card, which
// reply answers which question, and the size limits. Each guard here fails a test when it is taken out.
import { describe, expect, it } from "vitest";
import * as M from "../src/model";

const book = (): M.Book => ({ seq: 0, pins: [], removed: [] });
const T0 = 1_000_000;
const make = (b: M.Book, input: Partial<M.NewPin> = {}, now = T0): M.Pin => {
  const made = M.addPin(b, { origin: "user", title: "Deploy", status: "starting", state: "run", source: "user", ...input }, now);
  if (!("pin" in made)) throw new Error(`refused: ${made.refused}`);
  return made.pin;
};

describe("reading storage", () => {
  it("drops what is not a pin, keeps ids unique, and never lets a key like __proto__ or constructor act as a field", () => {
    const good = { id: "p-0004", origin: "bot", title: "A", handle: "A", state: "run", status: "s", source: "bot", thread: [], updates: [], createdAt: 1, updatedAt: 1 };
    const read = M.readBook(JSON.parse(`{"seq": 1, "pins": [${JSON.stringify(good)}, ${JSON.stringify(good)}, {"id":"constructor"}, {"id":"p-0005","origin":"x"}, 7, null,
      {"id":"p-0006","origin":"user","title":"T","handle":"T","state":"run","status":"","source":"user","botKey":"__proto__","thread":[{"rid":"__proto__","q":"x","a":null}],"__proto__":{"state":"done"}}]}`));
    expect(read.pins.map((pin) => pin.id)).toEqual(["p-0004", "p-0006"]);
    expect(read.seq).toBe(6);
    expect(read.pins[1]!.thread).toHaveLength(1);
    expect(({} as Record<string, unknown>).state).toBeUndefined();
    for (const junk of [null, 5, "x", [], { pins: "x" }, { pins: { length: 3 } }]) expect(M.readBook(junk)).toEqual({ seq: 0, pins: [], removed: [] });
  });

  it("cleans a title and a status on the way in: one line, no control characters, no header brackets", () => {
    const read = M.readBook({ pins: [{ id: "p-0001", origin: "bot", title: "a\n〔b〕\u0000c", handle: "h", state: "wait", status: "x\r\ny\u001b[31m", source: "bot", thread: [], updates: [], createdAt: 1, updatedAt: 1 }] });
    expect(read.pins[0]!.title).toBe("a b c");
    expect(read.pins[0]!.status).toBe("x y[31m");
  });

  it("holds at most MAX_PINS cards, MAX_TURNS turns and MAX_UPDATES lines of each", () => {
    const turn = (n: number) => ({ rid: `r${n}`, q: "q", a: null, qAt: n });
    const update = (n: number) => ({ at: n, state: "run", status: "s", source: "bot" });
    const many = Array.from({ length: 20 }, (_, n) => ({ id: `p-${String(n + 1).padStart(4, "0")}`, origin: "bot", title: "T", handle: `h${n}`, state: "run", status: "s", source: "bot",
      thread: Array.from({ length: 80 }, (_, i) => turn(i)), updates: Array.from({ length: 80 }, (_, i) => update(i)), createdAt: 1, updatedAt: 1 }));
    const read = M.readBook({ pins: many });
    expect(read.pins).toHaveLength(M.MAX_PINS);
    expect(read.pins[0]!.thread).toHaveLength(M.MAX_TURNS);
    expect(read.pins[0]!.updates).toHaveLength(M.MAX_UPDATES);
  });
});

describe("names", () => {
  it("makes a handle without spaces or @, and gives a second card of the same title one of its own", () => {
    const b = book();
    const one = make(b, { title: "Fix the @build bug" });
    const two = make(b, { title: "Fix the @build bug" });
    expect(one.handle).toBe("Fix-the-build-bug");
    expect(two.handle).toBe("Fix-the-build-bug-2");
    expect(M.uniqueHandle(b, "fix the build bug")).toBe("fix-the-build-bug-3");
  });

  it("never reuses an id after a card is gone", () => {
    const b = book();
    const one = make(b);
    M.remove(b, one.id, T0, "user");
    expect(make(b, { title: "Next" }).id).toBe("p-0002");
  });
});

describe("what a bot's <pin-card> may do", () => {
  const tag = (b: M.Book, attributes: Record<string, string>, body = "working", now = T0) => M.applyCardTag(b, attributes, body, now);

  it("makes a card only for a wait, or a run of 10 minutes or more; anything else is dropped", () => {
    const b = book();
    expect(tag(b, { id: "a", title: "Short", state: "run", min: "9" })).toBe("dropped");
    expect(tag(b, { id: "a", title: "No minutes", state: "run" })).toBe("dropped");
    expect(tag(b, { id: "a", title: "Done at once", state: "done", min: "30" })).toBe("dropped");
    expect(tag(b, { id: "a", title: "Long", state: "run", min: "10" })).toBe("created");
    expect(tag(b, { id: "b", title: "Waits", state: "wait" })).toBe("created");
    expect(b.pins.map((pin) => [pin.botKey, pin.origin, pin.source, pin.state])).toEqual([["a", "bot", "bot", "run"], ["b", "bot", "bot", "wait"]]);
    expect(b.pins[1]!.waitingSince).toBe(T0);
  });

  it("refuses a missing state, a state it does not know, a missing status, and a key that is not a plain id", () => {
    const b = book();
    expect(tag(b, { id: "a", title: "T" })).toBe("dropped");
    expect(tag(b, { id: "a", title: "T", state: "paused", min: "30" })).toBe("dropped");
    expect(tag(b, { id: "a", title: "T", state: "wait" }, "   ")).toBe("dropped");
    for (const bad of ["", "a b", "../x", "x".repeat(65), "p-1\n2"]) expect(tag(b, { id: bad, title: "T", state: "wait" })).toBe("dropped");
    expect(tag(b, { title: "T", state: "wait" })).toBe("dropped");
    expect(b.pins).toEqual([]);
  });

  it("keeps a bot to 3 open cards of its own; a done card makes room", () => {
    const b = book();
    for (const key of ["a", "b", "c"]) expect(tag(b, { id: key, title: key, state: "wait" })).toBe("created");
    expect(tag(b, { id: "d", title: "d", state: "wait" })).toBe("dropped");
    expect(tag(b, { id: "a", state: "done" }, "finished")).toBe("updated");
    expect(tag(b, { id: "d", title: "d", state: "wait" })).toBe("created");
  });

  it("does not count the user's own pins against a bot, and the user's pins do not stop it", () => {
    const b = book();
    for (let n = 0; n < 4; n++) make(b, { title: `mine ${n}` });
    for (const key of ["a", "b", "c"]) expect(tag(b, { id: key, title: key, state: "wait" })).toBe("created");
  });

  it("rewrites its own card in place: the old words become `prev`, same words again is no update, the log keeps each change", () => {
    const b = book();
    tag(b, { id: "k", title: "Train", state: "run", min: "30", step: "1/4" }, "epoch 1", T0);
    expect(tag(b, { id: "k" }, "epoch 2", T0 + 1000)).toBe("updated");
    const pin = b.pins[0]!;
    expect([pin.status, pin.prev, pin.updatedAt]).toEqual(["epoch 2", "epoch 1", T0 + 1000]);
    expect(pin.step).toEqual({ done: 1, total: 4 });
    expect(tag(b, { id: "k" }, "epoch 2", T0 + 2000)).toBe("unchanged");
    expect(pin.updates.map((line) => line.status)).toEqual(["epoch 1", "epoch 2"]);
    expect(tag(b, { id: "k", step: "2/4" }, "epoch 2", T0 + 3000)).toBe("updated");
    expect(pin.step).toEqual({ done: 2, total: 4 });
  });

  it("stamps waitingSince when a card starts waiting and clears it when it stops", () => {
    const b = book();
    tag(b, { id: "k", title: "Install", state: "run", min: "15" }, "downloading", T0);
    expect(b.pins[0]!.waitingSince).toBeUndefined();
    tag(b, { id: "k", state: "wait" }, "needs you", T0 + 5);
    expect(b.pins[0]!.waitingSince).toBe(T0 + 5);
    tag(b, { id: "k", state: "wait" }, "still needs you", T0 + 9);
    expect(b.pins[0]!.waitingSince).toBe(T0 + 5);
    tag(b, { id: "k", state: "run" }, "went on", T0 + 10);
    expect(b.pins[0]!.waitingSince).toBeUndefined();
  });

  it("reaches a card the user pinned only by its p-0001 id, may rewrite its status, and can never take it down", () => {
    const b = book();
    const mine = make(b, { title: "Mine", status: "x" });
    expect(tag(b, { id: "mine" }, "new words")).toBe("dropped");
    expect(tag(b, { id: mine.id }, "new words", T0 + 1)).toBe("updated");
    expect(mine.status).toBe("new words");
    expect(mine.source).toBe("bot");
    expect(tag(b, { id: mine.id, unpin: "yes" }, "")).toBe("dropped");
    expect(b.pins).toHaveLength(1);
  });

  it("takes down its own card, not another bot's key or the user's card, and keeps it for 釘回", () => {
    const b = book();
    tag(b, { id: "k", title: "Own", state: "wait" });
    expect(tag(b, { id: "other", unpin: "yes" }, "")).toBe("dropped");
    expect(tag(b, { id: "k", unpin: "1" }, "")).toBe("unpinned");
    expect(b.pins).toEqual([]);
    expect(b.removed.map((entry) => [entry.pin.title, entry.by])).toEqual([["Own", "bot"]]);
  });

  it("treats attribute names from the bot as data: a `constructor` or `__proto__` attribute is nothing", () => {
    const b = book();
    const hostile = JSON.parse('{"__proto__":"x","constructor":"y","id":"k","title":"T","state":"wait"}') as Record<string, string>;
    expect(tag(b, hostile)).toBe("created");
    expect(tag(b, Object.create(null) as Record<string, string>)).toBe("dropped");
    expect(tag(b, { id: "constructor", title: "T2", state: "wait" })).toBe("created");
  });

  it("cleans what it keeps: one line, no control characters, no header brackets, and the length limits", () => {
    const b = book();
    tag(b, { id: "k", title: `T\n〔x〕${"t".repeat(100)}`, state: "wait" }, `line1\nline2\u0000\u001b${"s".repeat(500)}`);
    const pin = b.pins[0]!;
    expect(pin.title.length).toBeLessThanOrEqual(M.MAX_TITLE);
    expect(pin.title).not.toMatch(/[\n〔〕]/);
    expect(pin.status.length).toBeLessThanOrEqual(M.MAX_STATUS);
    expect(pin.status).toMatch(/^line1 line2/);
    expect(pin.status).not.toMatch(/[\u0000-\u001f]/);
  });

  it("takes only whole 'n/m' steps: 5/4, 0/0, 'abc' and 100 steps are no step", () => {
    for (const bad of ["5/4", "0/0", "abc", "1/100", "-1/3", "1.5/3", ""]) expect(M.parseStep(bad)).toBeNull();
    expect(M.parseStep("2 / 4")).toEqual({ done: 2, total: 4 });
    expect(M.parseMinutes("25")).toBe(25);
    for (const bad of ["abc", "-5", "1e3", "2.5", ""]) expect(M.parseMinutes(bad)).toBe(0);
  });
});

describe("the strip's limits", () => {
  it("holds MAX_PINS; at the limit the oldest done card makes room, else the new one is refused", () => {
    const b = book();
    for (let n = 0; n < M.MAX_PINS; n++) make(b, { title: `p${n}` }, T0 + n);
    expect(M.addPin(b, { origin: "user", title: "extra", status: "x", state: "run", source: "user" }, T0)).toEqual({ refused: "full" });
    M.applyUpdate(b.pins[3]!, { state: "done", source: "bot" }, T0 + 100);
    M.applyUpdate(b.pins[5]!, { state: "done", source: "bot" }, T0 + 50);
    const made = M.addPin(b, { origin: "user", title: "extra", status: "x", state: "run", source: "user" }, T0 + 200);
    expect("pin" in made).toBe(true);
    expect(b.pins).toHaveLength(M.MAX_PINS);
    expect(b.pins.some((pin) => pin.title === "p5")).toBe(false);
    expect(b.removed[0]!.by).toBe("seen");
  });

  it("refuses an empty title", () => {
    expect(M.addPin(book(), { origin: "user", title: " \n ", status: "x", state: "run", source: "user" }, T0)).toEqual({ refused: "empty" });
  });

  it("keeps the last MAX_REMOVED removed cards for 釘回, puts one back with a handle that is free, and refuses when the strip is full", () => {
    const b = book();
    const ids = ["a", "b", "c", "d"].map((title) => make(b, { title }).id);
    for (const id of ids) M.remove(b, id, T0, "user");
    expect(b.removed.map((entry) => entry.pin.title)).toEqual(["b", "c", "d"]);
    const other = make(b, { title: "d" });
    expect(M.restore(b, ids[3]!, T0)!.handle).toBe("d-2");
    expect(other.handle).toBe("d");
    expect(M.restore(b, ids[3]!, T0)).toBeNull();
    for (let n = 0; n < M.MAX_PINS; n++) if (b.pins.length < M.MAX_PINS) make(b, { title: `x${n}` });
    expect(M.restore(b, ids[2]!, T0)).toBeNull();
  });

  it("fits the book under MAX_BOOK_BYTES by dropping the oldest answered turns first, never an open one, counting CJK and escapes as JSON bytes", () => {
    const b = book();
    const pin = make(b);
    const long = "字\n\"".repeat(1_300);
    for (let n = 0; n < M.MAX_TURNS; n++) {
      const turn = M.addTurn(pin, `r${n}`, long, T0 + n);
      turn.a = long.repeat(3).slice(0, M.MAX_A);
      turn.aAt = T0 + n;
    }
    make(b, { title: "other" }).thread.push(...pin.thread.map((turn) => ({ ...turn })));
    pin.thread.push({ rid: "open", q: "still waiting", a: null, qAt: T0, postedAt: null, seenAt: null, aAt: null, via: "at" });
    expect(M.bytesOf(b)).toBeGreaterThan(M.MAX_BOOK_BYTES);
    M.fit(b);
    expect(M.bytesOf(b)).toBeLessThanOrEqual(M.MAX_BOOK_BYTES);
    expect(pin.thread.some((turn) => turn.rid === "open")).toBe(true);
    // bytes, not characters: the same text counts three times as much in CJK as in ASCII
    expect(M.bytesOf({ t: "字".repeat(100) })).toBe(M.bytesOf({ t: "a".repeat(100) }) + 200);
  });
});

describe("an open turn that is the oldest (review: M11, M12)", () => {
  const answered = (pin: M.Pin, n: number, text: string) => {
    const turn = M.addTurn(pin, `r${n}`, text, T0 + n);
    turn.a = text.slice(0, M.MAX_A);
    turn.aAt = T0 + n;
    return turn;
  };

  it("fit drops answered turns after it and keeps the oldest turn that still waits", () => {
    const b = book();
    const pin = make(b);
    const open = M.addTurn(pin, "open", "the first question, never answered", T0);
    open.postedAt = T0;
    const long = "字".repeat(M.MAX_A);
    for (let n = 1; n < M.MAX_TURNS; n++) answered(pin, n, long);
    expect(M.bytesOf(b)).toBeGreaterThan(M.MAX_BOOK_BYTES);
    M.fit(b);
    expect(M.bytesOf(b)).toBeLessThanOrEqual(M.MAX_BOOK_BYTES);
    expect(pin.thread[0]!.rid).toBe("open");
    expect(pin.thread.length).toBeLessThan(M.MAX_TURNS);
    expect(pin.thread.slice(1).every((turn) => turn.a !== null)).toBe(true);
    expect(M.openTurn(pin)?.rid).toBe("open");
  });

  it("addTurn on a full thread drops the oldest answered turn, not the older one that still waits", () => {
    const b = book();
    const pin = make(b);
    const open = M.addTurn(pin, "open", "the first question, never answered", T0);
    open.postedAt = T0;
    for (let n = 1; n < M.MAX_TURNS; n++) answered(pin, n, `a${n}`);
    expect(pin.thread).toHaveLength(M.MAX_TURNS);
    M.addTurn(pin, "new", "one more", T0 + 100);
    expect(pin.thread).toHaveLength(M.MAX_TURNS);
    expect(pin.thread.map((turn) => turn.rid).slice(0, 3)).toEqual(["open", "r2", "r3"]);
    expect(pin.thread[pin.thread.length - 1]!.rid).toBe("new");
    expect(M.openTurn(pin)?.rid).toBe("open");
  });
});

describe("a message into a card (@handle)", () => {
  it("routes '@handle words' and '@p-0001 words' to that card of this book, and nothing else", () => {
    const b = book();
    const pin = make(b, { title: "Build Fix" });
    expect(M.route(b, "@Build-Fix please retry")?.rest).toBe("please retry");
    expect(M.route(b, "@build-fix\nsecond line")?.pin).toBe(pin);
    expect(M.route(b, `@${pin.id} hi`)?.pin).toBe(pin);
    expect(M.route(b, "  @Build-Fix  spaced  ")?.rest).toBe("spaced");
    for (const text of ["@Build-Fix", "@Build-Fix   ", "hello @Build-Fix there", "@other words", "Build-Fix words", "@@Build-Fix words", "", "@", "@constructor words", "@__proto__ x"]) expect(M.route(b, text), text).toBeNull();
  });

  it("takes a name only whole: '@<handle>more' (a longer word) names no card, even when the handle is as long as a handle gets", () => {
    const b = book();
    const pin = make(b, { title: "a".repeat(M.MAX_TITLE) });
    expect(pin.handle).toHaveLength(M.MAX_TITLE);
    expect(M.route(b, `@${pin.handle} go`)?.pin).toBe(pin);
    expect(M.route(b, `@${pin.handle}XYZ go`)).toBeNull();
    expect(M.route(b, `@${pin.handle}XYZ`)).toBeNull();
  });

  it("writes the message for the bot with the card's header and a fixed footer, and reads the header back for the bubble", () => {
    const b = book();
    const pin = make(b, { title: "Deploy 〔v2〕" });
    const asked = M.askText(pin, "是否可以\n繼續？");
    expect(asked.startsWith("〔Pin p-0001 · Deploy v2〕\n是否可以\n繼續？\n\n（Pin 卡片：")).toBe(true);
    expect(asked).toContain(`<pin-say id="p-0001">`);
    expect(M.parseAsk(asked)).toEqual({ id: "p-0001", title: "Deploy v2", text: "是否可以\n繼續？" });
    expect(M.parseAsk("〔Pin p-0001 · T〕\nno footer")).toBeNull();
    expect(M.parseAsk("hello")).toBeNull();
    expect(M.parseAsk(asked.replace("p-0001 ·", "constructor ·"))).toBeNull();
  });

  it("keeps the user's words in the thread as one open turn, at most MAX_TURNS, and never drops an open one for room", () => {
    const b = book();
    const pin = make(b);
    for (let n = 0; n < M.MAX_TURNS + 5; n++) { const turn = M.addTurn(pin, `r${n}`, `q${n}`, T0 + n); if (n < M.MAX_TURNS + 4) { turn.a = "ok"; turn.aAt = T0 + n; } }
    expect(pin.thread).toHaveLength(M.MAX_TURNS);
    expect(pin.thread[pin.thread.length - 1]!.q).toBe(`q${M.MAX_TURNS + 4}`);
    expect(M.openTurn(pin)?.rid).toBe(`r${M.MAX_TURNS + 4}`);
    expect(M.addTurn(make(b, { title: "Z" }), "r", "x".repeat(M.MAX_Q + 500), T0).q).toHaveLength(M.MAX_Q);
  });

  it("calls the same words again within 3 seconds a duplicate, and not later or other words", () => {
    const b = book();
    const pin = make(b);
    M.addTurn(pin, "r1", "same", T0);
    expect(M.isDuplicate(pin, "same", T0 + 2_000)).toBe(true);
    expect(M.isDuplicate(pin, "same", T0 + M.DUPLICATE_MS)).toBe(false);
    expect(M.isDuplicate(pin, "other", T0 + 100)).toBe(false);
    expect(M.isDuplicate(make(b, { title: "N" }), "same", T0)).toBe(false);
  });

  it("forgets a routed message that never showed in the chat after UNPOSTED_MS, not one that did", () => {
    const b = book();
    const pin = make(b);
    M.addTurn(pin, "never", "lost", T0);
    const shown = M.addTurn(pin, "shown", "kept", T0);
    shown.postedAt = T0 + 1;
    expect(M.pruneUnposted(b, T0 + M.UNPOSTED_MS - 1)).toBe(false);
    expect(M.pruneUnposted(b, T0 + M.UNPOSTED_MS)).toBe(true);
    expect(pin.thread.map((turn) => turn.rid)).toEqual(["shown"]);
  });
});

describe("which reply answers which question", () => {
  const asked = (b: M.Book, title: string, rid = "r1", posted = true): M.Pin => {
    const pin = make(b, { title });
    const turn = M.addTurn(pin, rid, "q", T0);
    if (posted) turn.postedAt = T0 + 1;
    return pin;
  };

  it("fills the open turn of the card the <pin-say> names, once", () => {
    const b = book();
    const one = asked(b, "One");
    const two = asked(b, "Two");
    expect(M.answerTurn(b, one.id, "  the answer  ", T0 + 9)).toBe(true);
    expect([one.thread[0]!.a, one.thread[0]!.aAt, two.thread[0]!.a]).toEqual(["the answer", T0 + 9, null]);
    // a second answer with nothing waiting is a turn of its own, never dropped (review: the core took it out of the chat already)
    expect(M.answerTurn(b, one.id, "again", T0 + 10)).toBe(true);
    expect(one.thread.map((turn) => [turn.q, turn.a])).toEqual([["q", "the answer"], ["", "again"]]);
  });

  it("answers two questions written into one card before any answer in the order they were asked (review)", () => {
    const b = book();
    const pin = make(b);
    M.addTurn(pin, "r1", "q1", T0);
    M.addTurn(pin, "r2", "q2", T0 + 1);
    expect([M.markPosted(b, pin.id, T0 + 2), M.markPosted(b, pin.id, T0 + 3), M.markPosted(b, pin.id, T0 + 4)]).toEqual([true, true, false]);
    expect(pin.thread.map((turn) => turn.postedAt)).toEqual([T0 + 2, T0 + 3]);
    expect(M.markSeen(b, T0 + 5)).toBe(true);
    expect(pin.thread.map((turn) => turn.seenAt)).toEqual([T0 + 5, T0 + 5]);
    expect(M.answerTurn(b, pin.id, "a1", T0 + 6)).toBe(true);
    expect(M.answerTurn(b, pin.id, "a2", T0 + 7)).toBe(true);
    expect(pin.thread.map((turn) => [turn.q, turn.a])).toEqual([["q1", "a1"], ["q2", "a2"]]);
  });

  it("gives an answer to a question whose line is in the chat before one that never showed (review)", () => {
    const b = book();
    const pin = make(b);
    M.addTurn(pin, "never", "stopped", T0);
    M.addTurn(pin, "shown", "asked", T0 + 1).postedAt = T0 + 2;
    expect(M.answerTurn(b, pin.id, "answer", T0 + 3)).toBe(true);
    expect(pin.thread.map((turn) => turn.a)).toEqual([null, "answer"]);
  });

  it("refuses a bad id, a card that is gone and an empty answer; a card with nothing waiting takes it as a turn of its own", () => {
    const b = book();
    const pin = asked(b, "One");
    for (const id of ["", "constructor", "p-9", "p-0099", "__proto__"]) expect(M.answerTurn(b, id, "x", T0), id).toBe(false);
    expect(M.answerTurn(b, pin.id, " \n ", T0)).toBe(false);
    const empty = make(b, { title: "Empty" });
    expect(M.answerTurn(b, empty.id, "x", T0)).toBe(true);
    expect(empty.thread.map((turn) => [turn.q, turn.a])).toEqual([["", "x"]]);
    expect(M.answerTurn(b, pin.id, "x".repeat(M.MAX_A + 100), T0)).toBe(true);
    expect(pin.thread[0]!.a).toHaveLength(M.MAX_A);
  });

  it("with no tag, takes the reply for the one waiting card when its line was in the chat before the turn began; two waiting: nothing is guessed", () => {
    const b = book();
    const one = asked(b, "One");
    expect(M.answerOnlyWaiting(b, "plain reply", T0 + 1, T0 + 5)).toBe(one.id);
    expect(one.thread[0]!.a).toBe("plain reply");
    const two = asked(b, "Two", "r2");
    const three = asked(b, "Three", "r3");
    expect(M.answerOnlyWaiting(b, "which one?", T0 + 10, T0 + 11)).toBeNull();
    expect([two.thread[0]!.a, three.thread[0]!.a]).toEqual([null, null]);
  });

  it("with no tag, does not take a reply of a turn that began before the line was in the chat", () => {
    const b = book();
    const pin = make(b);
    M.addTurn(pin, "r1", "q", T0).postedAt = T0 + 100;
    expect(M.answerOnlyWaiting(b, "an older turn's reply", T0 + 50, T0 + 120)).toBeNull();
    expect(pin.thread[0]!.a).toBeNull();
  });

  it("tracks the receipts: line shown, then bot has seen it; a turn that began before the line was shown has seen nothing", () => {
    const b = book();
    const pin = asked(b, "One", "r1", false);
    expect(M.markSeen(b, T0 + 5)).toBe(false);
    expect(M.markPosted(b, pin.id, T0 + 6)).toBe(true);
    expect(M.markPosted(b, pin.id, T0 + 7)).toBe(false);
    expect(M.markPosted(b, "constructor", T0 + 7)).toBe(false);
    expect(M.markSeen(b, T0 + 8)).toBe(true);
    expect(M.markSeen(b, T0 + 9)).toBe(false);
    expect([pin.thread[0]!.postedAt, pin.thread[0]!.seenAt]).toEqual([T0 + 6, T0 + 8]);
  });
});

describe("what the page draws", () => {
  it("orders waiting, then running, then done, each oldest first, with unread until the card was seen", () => {
    const b = book();
    const done = make(b, { title: "done", state: "done" }, T0);
    const run = make(b, { title: "run" }, T0 + 1);
    const wait = make(b, { title: "wait", state: "wait" }, T0 + 2);
    const later = make(b, { title: "later wait", state: "wait" }, T0 + 3);
    run.seenAt = run.updatedAt;
    const view = M.viewOf(b);
    expect(view.pins.map((pin) => pin.title)).toEqual(["wait", "later wait", "run", "done"]);
    expect(view.pins.map((pin) => pin.unread)).toEqual([true, true, false, true]);
    expect([done.id, wait.id, later.id].every((id) => view.pins.some((pin) => pin.id === id))).toBe(true);
    expect(JSON.stringify(view)).not.toContain("botKey");
  });

  it("titles a pinned message from its first line without Markdown marks", () => {
    expect(M.fromMessage("## Plan\nmore")).toEqual({ title: "Plan", status: "Plan" });
    expect(M.fromMessage("\n\n> - 做完這件事，然後再說\nx").title).toBe("做完這件事，然後再說");
    expect(M.fromMessage("  \n ").title).toBe("釘選");
  });
});
