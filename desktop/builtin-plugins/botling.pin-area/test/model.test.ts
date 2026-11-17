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
    const ids = ["a", "b", "c", "d", "e", "f", "g", "h"].map((title) => make(b, { title }).id);
    for (const id of ids) M.remove(b, id, T0, "user");
    expect(b.removed).toHaveLength(M.MAX_REMOVED);
    M.remove(b, make(b, { title: "i" }).id, T0, "user");
    expect(b.removed.map((entry) => entry.pin.title)).toEqual(["b", "c", "d", "e", "f", "g", "h", "i"]);
    const other = make(b, { title: "h" });
    expect(M.restore(b, ids[7]!, T0)!.handle).toBe("h-2");
    expect(other.handle).toBe("h");
    expect(M.restore(b, ids[7]!, T0)).toBeNull();
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

// ---- Phase 2 ----

describe("worker and sub-bot news into a card", () => {
  it("reads worker ids from a tag: spaces or commas, each checked, at most MAX_FROM, no duplicates", () => {
    expect(M.parseFrom("w-1 w_2,w.3")).toEqual(["w-1", "w_2", "w.3"]);
    expect(M.parseFrom("a a a")).toEqual(["a"]);
    expect(M.parseFrom("a b c d e f")).toHaveLength(M.MAX_FROM);
    expect(M.parseFrom("ok ../x <b> a/b \u0000 " + "x".repeat(101))).toEqual(["ok"]);
    expect(M.parseFrom("")).toEqual([]);
  });

  it("<pin-card worker=…> links ids to a new card and to an existing one, the oldest go over MAX_FROM, and a link alone is an update", () => {
    const b = book();
    expect(M.applyCardTag(b, { id: "k", title: "Job", state: "run", min: "20", worker: "t-1" }, "going", T0)).toBe("created");
    expect(b.pins[0]!.from).toEqual(["t-1"]);
    expect(M.applyCardTag(b, { id: "k", worker: "t-1" }, "", T0 + 1)).toBe("unchanged");
    expect(M.applyCardTag(b, { id: "k", worker: "t-2 t-3 t-4 t-5" }, "", T0 + 2)).toBe("updated");
    expect(b.pins[0]!.from).toEqual(["t-2", "t-3", "t-4", "t-5"]);
    expect(M.linksOf(b)).toEqual(["t-2", "t-3", "t-4", "t-5"]);
    expect(M.readBook(JSON.parse(JSON.stringify(b))).pins[0]!.from).toEqual(["t-2", "t-3", "t-4", "t-5"]);
    expect(M.readPin({ ...JSON.parse(JSON.stringify(b.pins[0])), from: ["ok", "../bad", 7, "a b"] })!.from).toEqual(["ok"]);
  });

  it("a tag that only names a worker does not turn an app's line into the bot's own, and logs nothing", () => {
    const b = book();
    M.applyCardTag(b, { id: "k", title: "Job", state: "run", min: "20" }, "going", T0);
    M.applyNews(b.pins[0]!, { kind: "completed", from: "worker", text: "done" }, T0 + 1);
    expect(M.applyCardTag(b, { id: "k", worker: "t-1" }, "", T0 + 2)).toBe("updated");
    expect(b.pins[0]!.source).toBe("app");
    expect(b.pins[0]!.updates).toHaveLength(2);
    // the bot saying something about the card (here its state) is the bot's word again
    expect(M.applyCardTag(b, { id: "k", state: "run" }, "", T0 + 3)).toBe("updated");
    expect(b.pins[0]!.source).toBe("bot");
  });

  it("rewrites the status line in place with 原本, source app, and logs it; same news again changes nothing", () => {
    const b = book();
    const pin = make(b, { status: "審核中", source: "bot" });
    expect(M.applyNews(pin, { kind: "completed", from: "worker", text: "## 結果\n修好了，測試全過\n其他細節" }, T0 + 5)).toBe(true);
    expect([pin.state, pin.status, pin.prev, pin.source]).toEqual(["run", "worker 回報：結果", "審核中", "app"]);
    expect(pin.updates.at(-1)).toMatchObject({ at: T0 + 5, status: "worker 回報：結果", source: "app" });
    expect(M.applyNews(pin, { kind: "completed", from: "worker", text: "結果" }, T0 + 6)).toBe(false);
    expect(pin.updates).toHaveLength(2);
  });

  it("a failed or stopped worker turns a running card into a waiting one; a completed report never makes it done", () => {
    const b = book();
    const pin = make(b);
    M.applyNews(pin, { kind: "completed", from: "worker", text: "all good" }, T0 + 1);
    expect(pin.state).toBe("run");
    M.applyNews(pin, { kind: "failed", from: "worker", text: "tests failed: 3" }, T0 + 2);
    expect([pin.state, pin.status, pin.waitingSince]).toEqual(["wait", "worker 失敗：tests failed: 3", T0 + 2]);
    const other = make(b, { title: "Other" });
    M.applyNews(other, { kind: "stopped", from: "worker", text: "anything" }, T0 + 3);
    expect([other.state, other.status]).toEqual(["wait", "worker 已停止"]);
  });

  it("a card that waits for the user keeps its words and state: the news only goes into its log (and marks it unread); a done card takes nothing", () => {
    const b = book();
    const waiting = make(b, { title: "W", state: "wait", status: "選一個版本" }, T0);
    expect(M.applyNews(waiting, { kind: "completed", from: "bot", text: "排版好了" }, T0 + 5)).toBe(true);
    expect([waiting.state, waiting.status, waiting.updates.at(-1)!.status, waiting.updatedAt]).toEqual(["wait", "選一個版本", "sub bot 回覆：排版好了", T0 + 5]);
    expect(M.applyNews(waiting, { kind: "completed", from: "bot", text: "排版好了" }, T0 + 6)).toBe(false);
    const done = make(b, { title: "D", state: "done", status: "完成" });
    expect(M.applyNews(done, { kind: "completed", from: "worker", text: "late" }, T0 + 7)).toBe(false);
    expect(done.status).toBe("完成");
  });

  it("cleans a worker's words (they are a peer's text): one line, no header brackets, no control characters, cut to the status limit", () => {
    const b = book();
    const pin = make(b);
    M.applyNews(pin, { kind: "completed", from: "worker", text: "\u0007〔Pin p-0001 · x〕 " + "長".repeat(300) }, T0 + 1);
    expect(pin.status).not.toMatch(/[〔〕\u0007\n]/);
    expect(pin.status.length).toBeLessThanOrEqual(M.MAX_STATUS);
    expect(M.firstLine("\n\n  \n# \nreal words\nmore", 40)).toBe("real words");
    expect(M.firstLine("", 40)).toBe("");
  });
});

describe("the note of the cards a plain message carries, and what the user takes out of a card", () => {
  const line = (id = "m1", text = "競技場那個修好了嗎", at = T0 + 10) => ({ id, text, at });
  const copied = (b: M.Book, pinId: string, id = "m1", answer = "還沒好。", rid = "r1") => M.copyLine(b, pinId, line(id), { id: `b-${id}`, text: answer }, rid, T0 + 20);

  it("the briefing lists every card (id, title, state, status, who pinned it), in the strip's order, and is empty with no cards", () => {
    const b = book();
    expect(M.briefing(b, T0)).toBe("");
    make(b, { title: "完成的", state: "done", status: "done status" });
    make(b, { title: "我釘的", status: "進行" });
    make(b, { title: "等你的", state: "wait", status: "選一個", origin: "bot", source: "bot" });
    const brief = M.briefing(b, T0);
    expect(brief.startsWith(M.BRIEF + "\n")).toBe(true);
    const rows = brief.split("\n").slice(1, 4);
    expect(rows[0]).toBe("p-0003「等你的」等你 · 選一個");
    expect(rows[1]).toBe("p-0002「我釘的」進行中 · 進行 · 使用者釘的");
    expect(rows[2]).toBe("p-0001「完成的」完成 · done status · 使用者釘的");
    // the bot is not asked to sort lines (the app copies them, 4c / v8): no move attribute, no word about moving
    expect(brief).not.toContain("move=");
    expect(brief).not.toContain("移");
  });

  it("a card's words in the briefing are one clean line each, so a card cannot smuggle a header or a fake note into the bot's prompt", () => {
    const b = book();
    const pin = make(b, { title: "x" });
    pin.status = "line one\n\n〔Pin 區現況〕 evil";
    pin.title = "t〔x〕\nnew";
    const lines = M.briefing(b, T0).split("\n");
    expect(lines.filter((l) => l.includes(M.BRIEF))).toHaveLength(1);
  });

  it("appends the note after the user's words, which cannot fake the marker; the bubble's words come back without it", () => {
    const text = M.withBriefing("hello " + M.BRIEF + " there", "〔Pin 區現況〕\np-0001「A」進行中 · x");
    expect(M.hasBriefing(text)).toBe(true);
    expect(M.stripBriefing(text)).toBe("hello 〔 Pin 區現況 〕 there");
    expect(M.stripBriefing("plain")).toBe("plain");
    expect(M.hasBriefing("no marker " + M.BRIEF)).toBe(false);
  });

  it("only briefs ordinary messages: not a slash command, not another plugin's 〔header〕, not empty or huge ones", () => {
    expect(M.briefable("你好")).toBe(true);
    expect(M.briefable("/陪讀 paper.pdf")).toBe(false);
    expect(M.briefable("〔陪讀提問 q-0001〕 這句")).toBe(false);
    expect(M.briefable("  ")).toBe(false);
    expect(M.briefable("x".repeat(M.MAX_ROUTED + 1))).toBe(false);
  });

  it("the briefing turns every @ into ＠ (review probe), so the core reads no @Name call-in in it", () => {
    const b = book();
    make(b, { title: "@DAFAWU 看一下", status: "等 @Maintainer" });
    const brief = M.briefing(b, T0);
    expect(brief).not.toContain("@");
    expect(brief).toContain("p-0001「＠DAFAWU 看一下」進行中 · 等 ＠Maintainer");
  });

  it("dropCopy takes a copy the app made out of the card (the thread, the page view), notes it for the sorter, changes nothing else of the card, and is done once", () => {
    const b = book();
    const pin = make(b);
    copied(b, pin.id);
    pin.seenAt = pin.updatedAt;
    expect(M.dropCopy(b, "r1", T0 + 30)).toBe(true);
    expect(M.dropCopy(b, "r1", T0 + 31)).toBe(false);
    expect(pin.thread).toEqual([]);
    expect(M.viewOf(b).pins[0]!.thread).toEqual([]);
    expect(M.viewOf(b).pins[0]!.unread).toBe(false); // the user's own tap does not make the card "just updated"
    expect(b.fixes).toEqual([{ text: "競技場那個修好了嗎", from: pin.id, to: "chat", at: T0 + 30 }]);
    expect(M.dropCopy(b, "nope", T0)).toBe(false);
  });

  it("dropCopy never takes a turn the user wrote into the card (only copies), and a card that is down has no copy to drop", () => {
    const b = book();
    const pin = make(b);
    const turn = M.addTurn(pin, "r9", "typed", T0);
    turn.a = "answer";
    expect(M.dropCopy(b, "r9", T0)).toBe(false);
    expect(pin.thread).toHaveLength(1);
    copied(b, pin.id);
    M.remove(b, pin.id, T0 + 40, "user");
    expect(M.dropCopy(b, "r1", T0 + 41)).toBe(false);
    expect(M.restore(b, pin.id, T0 + 42)!.thread.map((t) => t.rid)).toEqual(["r9", "r1"]);
  });

  it("keeps only the last MAX_FIXES corrections, and tells the bot about recent ones (a day) in its next briefing", () => {
    const b = book();
    const a = make(b, { title: "A" });
    for (let n = 1; n <= 5; n++) { copied(b, a.id, `m${n}`, "ok", `r${n}`); M.dropCopy(b, `r${n}`, T0 + 100 + n); }
    expect(b.fixes).toHaveLength(M.MAX_FIXES);
    expect(M.briefing(b, T0 + 200)).toContain(`「競技場那個修好了嗎」不屬於 ${a.id}「A」`);
    expect(M.briefing(b, T0 + 90_000_000)).not.toContain("最近被使用者更正");
  });

  it("reads fixes back from storage and drops bad ones, and the old \"moved to another card\" kind (nothing moves any more)", () => {
    const b = M.readBook({ seq: 1, pins: [], removed: [], fixes: [{ text: "ok", from: "p-0001", to: "chat", at: 1 }, { text: "old", from: "p-0001", to: "p-0002", at: 1 }, { text: "x", from: "chat", to: "chat", at: 1 }, { text: "", from: "p-0001", to: "chat", at: 1 }, { text: "x", from: "../", to: "chat", at: 1 }, 7] });
    expect(b.fixes).toEqual([{ text: "ok", from: "p-0001", to: "chat", at: 1 }]);
  });

  it("a book an older version saved reads cleanly: a turn that had been taken back to the chat is gone, and a fold's fields (`say`, `redirected`, `late`, `moved`) are not read", () => {
    const stored = (turn: Record<string, unknown>) => M.readBook({ pins: [{ id: "p-0001", origin: "user", title: "T", handle: "T", state: "run", status: "s", source: "user", thread: [{ rid: "r1", q: "q", a: "a", qAt: 1, ...turn }], updates: [], createdAt: 1, updatedAt: 1 }] }).pins[0]!.thread;
    expect(stored({ via: "auto", moved: true })).toEqual([]);
    expect(stored({ via: "auto", late: true, redirected: true, replyId: "b1", msgId: "u1" })[0]).toEqual({ rid: "r1", q: "q", a: "a", qAt: 1, postedAt: null, seenAt: null, aAt: 0, via: "auto", msgId: "u1", replyId: "b1" });
    expect(stored({ via: "worker", worker: "t-1", wkind: "final", msgId: "m1", say: "one line" })[0]).toEqual({ rid: "r1", q: "q", a: "a", qAt: 1, postedAt: null, seenAt: null, aAt: 0, via: "worker", worker: "t-1", wkind: "final" });
  });

  it("keeps a copy's chat ids through storage, only on an automatic turn and only when they are short texts", () => {
    const b = book();
    const pin = make(b);
    copied(b, pin.id);
    const back = M.readBook(JSON.parse(JSON.stringify(b)));
    expect(back.pins[0]!.thread[0]).toMatchObject({ msgId: "m1", replyId: "b-m1", via: "auto" });
    const raw = JSON.parse(JSON.stringify(b));
    raw.pins[0].thread[0].msgId = "x".repeat(300);
    raw.pins[0].thread[0].replyId = "x".repeat(201);
    expect(M.readBook(raw).pins[0]!.thread[0]).toMatchObject({ via: "auto" });
    expect(M.readBook(raw).pins[0]!.thread[0]!.msgId).toBeUndefined();
    expect(M.readBook(raw).pins[0]!.thread[0]!.replyId).toBeUndefined();
    const typed = JSON.parse(JSON.stringify(b));
    typed.pins[0].thread[0].via = "at";
    expect(M.readBook(typed).pins[0]!.thread[0]!.msgId).toBeUndefined();
  });
});

describe("a worker bound to a card by its job name (cardForGroup, addWorkerTurn)", () => {
  it("finds the open card by its id, then its title, key or handle (ignoring case and punctuation) and nothing looser; ties and nothing give null", () => {
    const b = book();
    const a = make(b, { title: "Build 報告" });
    const c = make(b, { title: "Deploy staging", botKey: "deploy" });
    expect(M.cardForGroup(b, "p-0001")).toBe(a);
    expect(M.cardForGroup(b, "BUILD-報告")).toBe(a);
    expect(M.cardForGroup(b, "deploy")).toBe(c);
    expect(M.cardForGroup(b, "deploy staging env")).toBeNull(); // no containment match
    expect(M.cardForGroup(b, "報告")).toBeNull();
    expect(M.cardForGroup(b, "")).toBeNull();
    expect(M.cardForGroup(b, "something else")).toBeNull();
    const twin = make(b, { title: "Build 報告" });
    expect(M.cardForGroup(b, "build 報告")).toBeNull();
    expect(M.cardForGroup(b, twin.id)).toBe(twin);
    a.state = "done";
    twin.state = "done";
    expect(M.cardForGroup(b, "build 報告")).toBeNull();
    expect(M.cardForGroup(b, "p-0001")).toBeNull();
  });

  it("(review S3) a job name that only shares a word with a card's title binds to no card, in either direction", () => {
    const names = (title: string, group: string) => M.cardForGroup(M.readBook({ seq: 1, pins: [{ id: "p-0001", origin: "bot", title, handle: title, state: "run", status: "s", source: "bot", thread: [], updates: [], createdAt: 1, updatedAt: 1 }], removed: [] }), group);
    expect(names("Build", "rebuild cache")).toBeNull();
    expect(names("Review", "pin-area review")).toBeNull();
    expect(names("測試報告", "寫測試報告的模板")).toBeNull();
    expect(names("Deploy staging environment", "deploy")).toBeNull();
    expect(names("Build", "build")?.id).toBe("p-0001");
  });

  it("puts a worker's words into the thread as one turn each (same words once), cut at MAX_REPORT, and reads them back", () => {
    const b = book();
    const pin = make(b);
    const turn = M.addWorkerTurn(pin, "t-1", "final", "x".repeat(M.MAX_REPORT + 500), T0)!;
    expect(turn.a).toHaveLength(M.MAX_REPORT);
    expect(M.addWorkerTurn(pin, "t-1", "final", "x".repeat(M.MAX_REPORT + 500), T0 + 1)).toBeNull();
    expect(M.addWorkerTurn(pin, "t-1", "note", "x".repeat(M.MAX_REPORT), T0 + 2)).not.toBeNull();
    expect(M.addWorkerTurn(pin, "../bad", "final", "y", T0)).toBeNull();
    expect(M.addWorkerTurn(pin, "t-1", "final", "  \n ", T0)).toBeNull();
    const read = M.readBook(JSON.parse(JSON.stringify(b))).pins[0]!;
    expect(read.thread.map((t) => [t.via, t.worker, t.wkind, t.a!.length])).toEqual([["worker", "t-1", "final", M.MAX_REPORT], ["worker", "t-1", "note", M.MAX_REPORT]]);
    // a worker turn of a bad shape is not read (never kept with a worker id it does not have)
    const odd = M.readBook({ pins: [{ ...JSON.parse(JSON.stringify(pin)), thread: [{ rid: "r1", q: "", a: "z", via: "worker", worker: "../x", wkind: "final", qAt: 1 }, { rid: "r2", q: "", a: "z", via: "worker", worker: "t-1", wkind: "evil", qAt: 1 }] }] }).pins[0]!;
    expect(odd.thread).toEqual([]);
  });

  it("a worker's report is a COPY: the user may take it out of the card (dropCopy), and nothing about the chat changes; the same report heard again is not added behind the user's back", () => {
    const b = book();
    const pin = make(b);
    M.linkFrom(pin, ["t-1"], M.MAX_LINKED);
    const turn = M.addWorkerTurn(pin, "t-1", "final", "報告", T0)!;
    expect(turn).toMatchObject({ via: "worker", worker: "t-1", wkind: "final", a: "報告" });
    expect(turn.msgId).toBeUndefined(); // nothing in the chat is referenced, folded or hidden for it
    expect(M.dropCopy(b, turn.rid, T0 + 1)).toBe(true);
    expect(pin.thread).toEqual([]);
    expect(b.fixes).toBeUndefined(); // a worker's report teaches the sorter nothing
  });

  it("a note: a question makes a running card wait, a report only logs; the same note twice changes nothing", () => {
    const b = book();
    const pin = make(b);
    expect(M.applyWorkerNote(pin, "t-1", "report", "進度 50%", T0 + 1)).toBe(true);
    expect(M.applyWorkerNote(pin, "t-1", "report", "進度 50%", T0 + 2)).toBe(false);
    expect(pin.state).toBe("run");
    expect(M.applyWorkerNote(pin, "t-1", "question", "A 或 B？", T0 + 3)).toBe(true);
    expect([pin.state, pin.status, pin.source]).toEqual(["wait", "worker 問：A 或 B？", "app"]);
  });
});

describe("cards that close or go stale by themselves (sweep, workerEnded, briefing)", () => {
  const MIN = 60_000;
  it("a done card takes itself down an hour after it became done (a card the user pinned too), 釘回 brings it back, and 20 more minutes is not enough yet", () => {
    const b = book();
    const mine = make(b, { title: "Mine", origin: "user" });
    const theirs = make(b, { title: "Theirs", origin: "bot", source: "bot" });
    M.applyUpdate(mine, { state: "done", source: "user" }, T0);
    M.applyUpdate(theirs, { state: "done", source: "bot" }, T0 + 30 * MIN);
    expect(mine.doneAt).toBe(T0);
    expect(M.sweep(b, T0 + 59 * MIN)).toEqual({ changed: false, closed: [] });
    expect(M.sweep(b, T0 + 60 * MIN)).toEqual({ changed: true, closed: [mine.id] });
    expect(b.pins.map((pin) => pin.title)).toEqual(["Theirs"]);
    expect(b.removed[0]).toMatchObject({ by: "auto", at: T0 + 60 * MIN });
    expect(M.closedOf(b, T0 + 61 * MIN)).toEqual([{ id: mine.id, title: "Mine", at: T0 + 60 * MIN }]);
    expect(M.closedOf(b, T0 + 60 * MIN + M.CLOSED_SHOW_MS)).toEqual([]);
    expect(M.viewOf(b, T0 + 61 * MIN).closed).toHaveLength(1);
    expect(M.viewOf(b).closed).toBeUndefined();
    expect(M.restore(b, mine.id, T0 + 62 * MIN)).toBe(mine);
    expect(mine.doneAt).toBe(T0 + 62 * MIN); // its hour starts again
    expect(M.sweep(b, T0 + 63 * MIN).closed).toEqual([]);
    // reopened and done again: the hour starts again
    M.applyUpdate(mine, { state: "run", source: "user" }, T0 + 63 * MIN);
    expect(mine.doneAt).toBeUndefined();
    expect(M.sweep(b, T0 + 90 * MIN).closed).toEqual([theirs.id]);
  });

  it("a done card from an older book (no doneAt) counts from its last change; a card that is not done is never taken down", () => {
    const b = book();
    const old = make(b, { title: "Old", state: "done", status: "ok" });
    delete old.doneAt;
    const live = make(b, { title: "Live" });
    expect(M.sweep(b, T0 + M.DONE_CLOSE_MS).closed).toEqual([old.id]);
    expect(M.sweep(b, T0 + 100 * M.DONE_CLOSE_MS).closed).toEqual([]);
    expect(b.pins).toEqual([live]);
  });

  it("a card whose bound workers all ended and that said nothing for 20 minutes is marked stale; any change clears it; one with a worker still at work, or none that ended, is not", () => {
    const b = book();
    const pin = make(b, { title: "Job" });
    const idle = make(b, { title: "Idle" });
    M.workerLive(pin, "t-1");
    M.workerLive(pin, "t-2");
    expect(M.sweep(b, T0 + 25 * MIN).changed).toBe(false);
    expect(M.workerEnded(pin, "t-1", "completed", T0 + 1)).toBe(true);
    expect(pin.nudge).toBeUndefined(); // t-2 is still at work
    expect(M.sweep(b, T0 + 25 * MIN).changed).toBe(false);
    expect(M.workerEnded(pin, "t-2", "completed", T0 + 2)).toBe(true);
    expect(pin.live).toBeUndefined();
    expect(M.workerEnded(pin, "t-2", "completed", T0 + 3)).toBe(false);
    expect(M.sweep(b, T0 + 19 * MIN).changed).toBe(false);
    expect(M.sweep(b, T0 + 20 * MIN)).toEqual({ changed: true, closed: [] });
    expect(M.isStale(pin)).toBe(true);
    expect(M.isStale(idle)).toBe(false);
    expect(M.sweep(b, T0 + 21 * MIN).changed).toBe(false); // marked once
    expect(M.viewOf(b).pins.find((p) => p.id === pin.id)!.stale).toBe(true);
    expect(M.briefing(b, T0 + 25 * MIN)).toContain("可能已過時（它的 worker 都結束了，25 分鐘沒更新）");
    // the card changes: no longer stale, and it can go stale again later
    M.applyUpdate(pin, { status: "新的狀況", source: "bot" }, T0 + 30 * MIN);
    expect(M.isStale(pin)).toBe(false);
    expect(M.sweep(b, T0 + 49 * MIN).changed).toBe(false);
    expect(M.sweep(b, T0 + 50 * MIN).changed).toBe(true);
    expect(M.isStale(pin)).toBe(true);
    // a done card is never stale
    M.applyUpdate(pin, { state: "done", source: "bot" }, T0 + 51 * MIN);
    expect(M.isStale(pin)).toBe(false);
    expect(M.viewOf(b).pins.find((p) => p.id === pin.id)!.stale).toBeUndefined();
  });

  it("the last worker's completed report nudges a running card (next briefing says so); a failed one, a waiting card or the bot's own word does not / clears it", () => {
    const b = book();
    const pin = make(b, { title: "Job" });
    M.workerLive(pin, "t-1");
    expect(M.workerEnded(pin, "t-1", "failed", T0 + 1)).toBe(true);
    expect(pin.nudge).toBeUndefined();
    M.workerLive(pin, "t-2");
    M.workerEnded(pin, "t-2", "completed", T0 + 2);
    expect(pin.nudge).toBe(true);
    expect(M.briefing(b, T0 + 3)).toContain("做完請標 state=\"done\"");
    expect(M.viewOf(b).pins[0]!.nudge).toBe(true);
    // news by the app does not answer it; the bot saying something does
    M.applyUpdate(pin, { status: "worker 回報：x", source: "app" }, T0 + 4);
    expect(pin.nudge).toBe(true);
    M.applyUpdate(pin, { status: "還差測試", source: "bot" }, T0 + 5);
    expect(pin.nudge).toBeUndefined();
    expect(M.briefing(b, T0 + 6)).not.toContain("做完請標");
    const waiting = make(b, { title: "W", state: "wait", status: "要你選" });
    M.workerLive(waiting, "t-3");
    M.workerEnded(waiting, "t-3", "completed", T0 + 7);
    expect(waiting.nudge).toBeUndefined();
  });

  it("reads the new fields back from storage and drops nonsense (a stale mark on a done card, a nudge on a waiting one, bad worker ids)", () => {
    const base = { id: "p-0001", origin: "bot", title: "T", handle: "T", status: "s", source: "bot", thread: [], updates: [], createdAt: 1, updatedAt: 5 };
    const run = M.readPin({ ...base, state: "run", live: ["t-1", "../x", 7], endedAt: 9, stale: 5, nudge: true, doneAt: 3 })!;
    expect(run).toMatchObject({ live: ["t-1"], endedAt: 9, stale: 5, nudge: true });
    expect(run.doneAt).toBeUndefined();
    const done = M.readPin({ ...base, state: "done", doneAt: 4, stale: 5, nudge: true })!;
    expect([done.doneAt, done.stale, done.nudge]).toEqual([4, undefined, undefined]);
    const wait = M.readPin({ ...base, state: "wait", nudge: true, doneAt: "x" })!;
    expect([wait.nudge, wait.doneAt]).toEqual([undefined, undefined]);
    expect(M.readBook({ pins: [], removed: [{ pin: { ...base, state: "done" }, at: 3, by: "auto" }] }).removed[0]!.by).toBe("auto");
  });
});


describe("cards put away keep their 釘回 (review S4)", () => {
  const H = 3_600_000;
  const done = (n: number) => ({ id: `p-000${n}`, origin: n === 1 ? "user" : "bot", title: `Job ${n}`, handle: `Job-${n}`, state: "done", status: "s", source: "bot", thread: [], updates: [], createdAt: 1, updatedAt: 1, doneAt: 1 });
  it("one sweep that puts away four done cards (a user's among them) keeps all four for 釘回 and in the strip's closed list", () => {
    const b = M.readBook({ seq: 4, pins: [1, 2, 3, 4].map(done), removed: [] });
    const swept = M.sweep(b, 2 * H);
    expect(swept.closed).toHaveLength(4);
    expect(b.removed).toHaveLength(4);
    expect(M.closedOf(b, 2 * H).map((item) => item.id)).toEqual(["p-0001", "p-0002", "p-0003", "p-0004"]);
    expect(b.removed[0]).toMatchObject({ by: "auto", pin: { origin: "user" } });
    for (const id of ["p-0001", "p-0002", "p-0003", "p-0004"]) expect(M.restore(b, id, 2 * H)).toBeTruthy();
  });
  it("over the limit a card the user took down goes before one the app put away by itself", () => {
    const b = M.readBook({ seq: 0, pins: [], removed: [] });
    for (let n = 0; n < M.MAX_REMOVED; n++) b.removed.push({ pin: M.readPin({ ...done(n + 1), id: `p-00${n + 1}0`, title: `T${n}` })!, at: T0, by: n === 0 ? "user" : "auto" });
    b.pins.push(M.readPin({ ...done(9), state: "run" })!);
    M.remove(b, "p-0009", T0 + 1, "user");
    expect(b.removed).toHaveLength(M.MAX_REMOVED);
    expect(b.removed.some((entry) => entry.pin.title === "T0")).toBe(false);
    expect(b.removed.filter((entry) => entry.by === "auto")).toHaveLength(M.MAX_REMOVED - 1);
    expect(b.removed.at(-1)!.pin.id).toBe("p-0009");
  });
  it("(review M15) a done card the bot marks done again, with other words, keeps the hour it began with: the sweep still puts it away on time", () => {
    const b = book();
    const pin = make(b, { title: "Job" });
    M.applyUpdate(pin, { state: "done", status: "好了", source: "bot" }, T0);
    expect(pin.doneAt).toBe(T0);
    M.applyUpdate(pin, { state: "done", status: "好了，補充說明", source: "bot" }, T0 + 30 * 60_000);
    expect(pin.doneAt).toBe(T0);
    expect(M.sweep(b, T0 + 59 * 60_000).closed).toEqual([]);
    expect(M.sweep(b, T0 + 61 * 60_000).closed).toEqual([pin.id]);
  });
});

describe("a line copied into a card after its send (copyLine, attachReply)", () => {
  const line = (id = "u1", text = "部署那個好了嗎", at = T0 + 5) => ({ id, text, at });
  const reply = (id = "b1", text = "還沒好。") => ({ id, text });
  const rid = (n: number) => `r${n}`;

  it("copyLine puts a copy of the line (and of the reply when it is there) in as one turn: via auto, shown, seen, the chat ids kept; it never waits for a <pin-say>", () => {
    const b = book();
    const pin = make(b);
    const done = M.copyLine(b, pin.id, line(), reply(), rid(1), T0 + 20)!;
    expect(done).toMatchObject({ rid: "r1", q: "部署那個好了嗎", a: "還沒好。", via: "auto", msgId: "u1", replyId: "b1", qAt: T0 + 5, postedAt: T0 + 5, seenAt: T0 + 5, aAt: T0 + 20 });
    const open = M.copyLine(b, pin.id, line("u2", "再問一句"), null, rid(2), T0 + 30)!;
    expect(open).toMatchObject({ a: null, msgId: "u2" });
    expect(open.replyId).toBeUndefined();
    // a copy without its reply is not the card's open turn: a <pin-say> or a plain reply does not land in it, and the bot's turn does not "see" it
    expect(M.openTurn(pin)).toBeUndefined();
    expect(M.answerTurn(b, pin.id, "bot says", T0 + 40) && pin.thread.at(-1)!.q).toBe("");
    expect(open.a).toBeNull();
    expect(M.answerOnlyWaiting(b, "a plain reply", T0, T0 + 50)).toBeNull();
    expect(M.markSeen(b, T0 + 60)).toBe(false);
    expect(M.pruneUnposted(b, T0 + 10 * M.UNPOSTED_MS)).toBe(false);
  });

  it("copyLine refuses a card that is not there, a bad id, no words, no line id, a line or a reply already in a card (once, never twice)", () => {
    const b = book();
    const pin = make(b);
    expect(M.copyLine(b, "p-0099", line(), null, rid(1), T0)).toBeNull();
    expect(M.copyLine(b, "constructor", line(), null, rid(1), T0)).toBeNull();
    expect(M.copyLine(b, pin.id, line("u1", "  "), null, rid(1), T0)).toBeNull();
    expect(M.copyLine(b, pin.id, line(""), null, rid(1), T0)).toBeNull();
    expect(M.copyLine(b, pin.id, line("x".repeat(201)), null, rid(1), T0)).toBeNull();
    expect(M.copyLine(b, pin.id, line(), null, "../x", T0)).toBeNull();
    expect(pin.thread).toHaveLength(0);
    expect(M.copyLine(b, pin.id, line(), reply("b1"), rid(1), T0)).not.toBeNull();
    expect(M.copyLine(b, pin.id, line(), null, rid(2), T0)).toBeNull();
    // a reply whose message is already in a card is left out (the copy of the line is made without it)
    const second = M.copyLine(b, pin.id, line("u2", "x y z"), reply("b1"), rid(3), T0)!;
    expect(second.a).toBeNull();
    expect(second.replyId).toBeUndefined();
    expect(pin.thread).toHaveLength(2);
  });

  it("copyLine keeps the thread in the order the lines were written, whatever order they were copied in", () => {
    const b = book();
    const pin = make(b);
    M.copyLine(b, pin.id, line("u2", "later", T0 + 50), null, rid(2), T0 + 60);
    M.copyLine(b, pin.id, line("u1", "earlier", T0 + 10), null, rid(1), T0 + 70);
    expect(pin.thread.map((turn) => turn.q)).toEqual(["earlier", "later"]);
  });

  it("attachReply fills the copy that has no reply yet, once; not one that has its reply, a turn the user wrote, a card that is down, or a reply already used", () => {
    const b = book();
    const pin = make(b);
    const turn = M.copyLine(b, pin.id, line(), null, rid(1), T0)!;
    expect(M.attachReply(b, "r1", reply("b1", "  "), T0 + 1)).toBe(false);
    expect(M.attachReply(b, "r1", reply("b1"), T0 + 1)).toBe(true);
    expect(turn).toMatchObject({ a: "還沒好。", replyId: "b1", aAt: T0 + 1 });
    expect(pin.updatedAt).toBe(T0 + 1);
    expect(M.attachReply(b, "r1", reply("b2", "again"), T0 + 2)).toBe(false);
    const used = M.copyLine(b, pin.id, line("u3", "q r s"), null, rid(3), T0)!;
    expect(M.attachReply(b, "r3", reply("b1"), T0 + 5)).toBe(false);
    expect(used.a).toBeNull();
    const plain = M.addTurn(pin, "r4", "typed", T0, "at");
    expect(M.attachReply(b, "r4", reply("b9"), T0)).toBe(false);
    expect(plain.a).toBeNull();
    const down = M.copyLine(b, pin.id, line("u5", "t u v"), null, rid(5), T0)!;
    M.remove(b, pin.id, T0 + 6, "user");
    expect(M.attachReply(b, "r5", reply("b5"), T0 + 7)).toBe(false);
    expect(down.a).toBeNull();
    // a copy the user took out of the card gets no reply either
    const c = book();
    const other = make(c);
    M.copyLine(c, other.id, line(), null, rid(1), T0);
    M.dropCopy(c, "r1", T0 + 1);
    expect(M.attachReply(c, "r1", reply(), T0 + 2)).toBe(false);
  });

  it("a card taken down keeps its copies and 釘回 brings them back as they were: nothing about the chat depends on it (there is no trace to draw or fold)", () => {
    const b = book();
    const pin = make(b);
    M.copyLine(b, pin.id, line(), reply(), rid(1), T0 + 20);
    M.remove(b, pin.id, T0 + 50, "user");
    const back = M.restore(b, pin.id, T0 + 60)!;
    expect(back.thread).toHaveLength(1);
    expect(back.thread[0]).toMatchObject({ q: "部署那個好了嗎", a: "還沒好。", msgId: "u1", replyId: "b1" });
    expect("tracesOf" in M).toBe(false);
    expect("moveBack" in M).toBe(false);
    expect("moveTo" in M).toBe(false);
    expect("takeAuto" in M).toBe(false);
    expect("releaseLate" in M).toBe(false);
  });

  it("a copy keeps the whole reply up to MAX_COPY (the chat has all of it), a longer one is cut there, and storage cuts only the turns the user wrote at MAX_A", () => {
    const b = book();
    const pin = make(b);
    const whole = "答".repeat(M.MAX_A + 500);
    const turn = M.copyLine(b, pin.id, { id: "u1", text: "hello there", at: T0 }, { id: "b1", text: whole }, "r1", T0 + 1)!;
    expect(turn.a).toBe(whole);
    expect(M.readBook(JSON.parse(JSON.stringify(b))).pins[0]!.thread[0]!.a).toBe(whole);
    const huge = { id: "b2", text: "大".repeat(M.MAX_COPY + 1) };
    const second = M.copyLine(b, pin.id, { id: "u2", text: "second line", at: T0 + 2 }, huge, "r2", T0 + 3)!;
    expect(second.a).toHaveLength(M.MAX_COPY);
    expect(second.replyId).toBe("b2");
    const cut = M.readBook({ pins: [{ id: "p-0001", origin: "user", title: "T", handle: "T", state: "run", status: "s", source: "user", thread: [{ rid: "r1", q: "q", a: whole, qAt: 1, via: "at" }], updates: [], createdAt: 1, updatedAt: 1 }] });
    expect(cut.pins[0]!.thread[0]!.a).toHaveLength(M.MAX_A);
  });
});
