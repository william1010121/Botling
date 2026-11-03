// The rules the core's Bot kept for pins (add, change, arrange, refresh, keeping a run's output, notes, whose a pin is), over a fake Botling.
import { describe, expect, it } from "vitest";
import { basePin, BOT, FakeBotling } from "./pinbook";

const GIT = "git log --oneline -20";

function setUp() {
  const f = new FakeBotling();
  f.entries.todo = { command: null, detail: null, every: null, sizes: ["2x1", "2x2"] };
  f.entries.gitlog = { command: GIT, detail: null, every: 5, sizes: ["4x2"] };
  f.entries.status = { command: null, detail: null, every: null, sizes: [] };
  return { f, book: f.book() };
}
const shown = (name: string, extra: Record<string, unknown> = {}, at = 0, message = "m1") => ({ messageId: message, index: at, name, command: null, shownCommand: null, data: `{"a":1}`, author: null, ...extra });

describe("pinning", () => {
  it("a shown component keeps its data, takes the first size it hints (2x2 if it names it), and is its bot's author's", async () => {
    const { f, book } = setUp();
    f.shownCards = [shown("todo", { author: "GUEST-ID" })];
    expect(await book.add("main", "aa-1", { messageId: "m1", index: 0 }, "shown", 15)).toEqual({ pinned: true });
    expect(f.stored.get(BOT)).toEqual([expect.objectContaining({ id: "AA-1", name: "todo", data: `{"a":1}`, refresh: "manual", size: "2x2", linkAuthor: "GUEST-ID", makingLive: false })]);
    f.shownCards = [shown("status")];
    expect(await book.add(BOT, "aa-2", { messageId: "m1", index: 0 }, "shown", 15)).toEqual({ pinned: true });
    expect((f.stored.get(BOT)![1] as { size: string; linkAuthor: string }).size).toBe("2x2");
    expect((f.stored.get(BOT)![1] as { linkAuthor: string }).linkAuthor).toBe(BOT);
    // Twice is not pinned twice; a component with no data and no command cannot be pinned; nor can one the library lacks.
    expect(await book.add(BOT, "aa-3", { messageId: "m1", index: 0 }, "shown", 15)).toEqual({ pinned: false });
    f.shownCards = [shown("todo", { data: "null" }), shown("ghost", {}, 1)];
    expect(await book.add(BOT, "aa-4", { messageId: "m1", index: 0 }, "shown", 15)).toEqual({ pinned: false });
    expect(await book.add(BOT, "aa-5", { messageId: "m1", index: 1 }, "shown", 15)).toEqual({ pinned: false });
  });

  it("from the picker: the newest line that shows it, or its component's Command", async () => {
    const { f, book } = setUp();
    f.shownCards = [shown("todo", { data: `{"newest":1}` }, 1, "m2"), shown("todo", { data: `{"old":1}` }, 0, "m1")];
    expect(await book.add(BOT, "bb-1", { name: "todo" }, "shown", 15)).toEqual({ pinned: true });
    expect((f.stored.get(BOT)![0] as { data: string }).data).toBe(`{"newest":1}`);
    expect(await book.add(BOT, "bb-2", { name: "gitlog" }, "interval", 5, 30)).toEqual({ pinned: true });
    expect(f.stored.get(BOT)![1]).toMatchObject({ name: "gitlog", command: GIT, followsComponent: true, refresh: "interval", minutes: 5, seconds: 30, data: "null", linkAuthor: BOT });
    // A component with no Command cannot be pinned from the picker unless it was drawn.
    expect(await book.add(BOT, "bb-3", { name: "status" }, "shown", 15)).toEqual({ pinned: false });
  });

  it("a card that ran keeps what it printed and when; a read-only bot pins nothing", async () => {
    const { f, book } = setUp();
    f.shownCards = [shown("gitlog", { command: null, shownCommand: GIT })];
    f.approved.add(GIT);
    f.lastRuns.set("m1/0", { command: GIT, status: "done", data: `{"n":9}`, ranAt: f.clock });
    expect(await book.add(BOT, "cc-1", { messageId: "m1", index: 0 }, "shown", 15)).toEqual({ pinned: true });
    expect(f.stored.get(BOT)![0]).toMatchObject({ command: GIT, data: `{"n":9}`, followsComponent: true, ranAt: (f.clock - Date.UTC(2001, 0, 1)) / 1000 });
    f.readOnly = true;
    f.shownCards = [shown("todo")];
    expect(await book.add(BOT, "cc-2", { messageId: "m1", index: 0 }, "shown", 15)).toEqual({ pinned: false });
  });
});

describe("changing pins", () => {
  async function two() {
    const s = setUp();
    s.f.stored.set(BOT, [basePin({ id: "P1", name: "todo" }), basePin({ id: "P2", name: "gitlog", command: GIT, refresh: "interval", minutes: 5 })]);
    return s;
  }

  it("moves, resizes (spelled), sets its panel height and chip status, lays out", async () => {
    const { f, book } = await two();
    expect(await book.change(BOT, "p1", { kind: "move", to: 5 })).toEqual({ changed: true });
    expect((f.stored.get(BOT) as { id: string }[]).map((pin) => pin.id)).toEqual(["P2", "P1"]);
    expect(await book.change(BOT, "P1", { kind: "resize", size: "3×2" })).toEqual({ changed: true });
    expect(await book.change(BOT, "P1", { kind: "resize", size: "9x9" })).toEqual({ changed: false });
    expect(await book.change(BOT, "P1", { kind: "height", height: 90 })).toEqual({ changed: true });
    expect(await book.change(BOT, "P1", { kind: "status", text: "3 open and more", tone: "ok" })).toEqual({ changed: true });
    expect(f.stored.get(BOT)![1]).toMatchObject({ size: "3x2", panelHeight: 120, status: { text: "3 open and mo…", tone: "good" } });
    expect(await book.arrange(BOT, [{ id: "P2", col: 2, row: 1, size: "1x1" }, { id: "nope", col: 0, row: 0 }])).toEqual({ changed: true });
    expect(f.stored.get(BOT)![0]).toMatchObject({ place: { col: 2, row: 1 }, size: "1x1" });
    expect(await book.change(BOT, "nope", { kind: "remove" })).toEqual({ changed: false });
  });

  it("saved data only on a pin with no command (the command's output is its data), and then it is told to the bot", async () => {
    const { f, book } = await two();
    expect(await book.change(BOT, "P2", { kind: "save", data: `{"x":1}` })).toEqual({ changed: false });
    expect(await book.change(BOT, "P1", { kind: "save", data: "null" })).toEqual({ changed: false });
    expect(await book.change(BOT, "P1", { kind: "save", data: `{"items":["milk"]}` })).toEqual({ changed: true });
    const notes = f.notes.at(-1)!;
    expect(notes.botId).toBe(BOT);
    expect(notes.notes).toEqual([{ date: expect.any(Number), line: `- "todo" pinned to you (pin P1): {"items":["milk"]}` }]);
  });

  it("refresh needs a command; at most two float; a floating card is clamped", async () => {
    const { f, book } = await two();
    expect(await book.change(BOT, "P1", { kind: "refresh", refresh: "shown" })).toEqual({ changed: false });
    expect(await book.change(BOT, "P2", { kind: "refresh", refresh: "interval", seconds: 1 })).toEqual({ changed: true });
    expect(f.stored.get(BOT)![1]).toMatchObject({ refresh: "interval", seconds: 2 });
    f.stored.set(BOT, [basePin({ id: "A" }), basePin({ id: "B" }), basePin({ id: "C" })]);
    const fresh = f.book();
    expect(await fresh.change(BOT, "A", { kind: "float", floating: true })).toEqual({ changed: true });
    expect(await fresh.change(BOT, "B", { kind: "float", floating: true })).toEqual({ changed: true });
    expect(await fresh.change(BOT, "C", { kind: "float", floating: true })).toEqual({ changed: false });
    expect(await fresh.change(BOT, "A", { kind: "floatAt", corner: "bottomLeft", width: 9999, height: 1 })).toEqual({ changed: true });
    expect(f.stored.get(BOT)![0]).toMatchObject({ float: { corner: "bottomLeft", width: 640, height: 100, collapsed: false } });
    expect(await fresh.change(BOT, "C", { kind: "floatAt", collapsed: true })).toEqual({ changed: false });
  });

  it("the view says how many float, the picker lists what was drawn then its own others, and nothing changes in a read-only bot", async () => {
    const { f, book } = await two();
    f.shownCards = [shown("todo"), shown("gitlog", { shownCommand: GIT }, 1), shown("choices", {}, 2)];
    const view = await book.view(BOT);
    expect(view.pins.map((pin) => pin.floatMenu)).toEqual(["float", "float"]);
    expect(view.pinChoices).toEqual([{ name: "todo", command: null, uses: 1, pinned: true }, { name: "gitlog", command: GIT, uses: 1, pinned: true }]);
    f.readOnly = true;
    book.forgetLibraries();
    expect(await book.change(BOT, "P1", { kind: "remove" })).toEqual({ changed: false });
  });
});

describe("refreshing", () => {
  async function ticking() {
    const s = setUp();
    s.f.entries.gitlog!.command = GIT;
    s.f.approved.add(GIT);
    s.f.stored.set(BOT, [
      basePin({ id: "S", name: "gitlog", command: GIT, refresh: "shown", followsComponent: true }),
      basePin({ id: "I", name: "gitlog", command: GIT, refresh: "interval", minutes: 1, followsComponent: true }),
      basePin({ id: "F", name: "gitlog", command: GIT, refresh: "interval", minutes: 1, seconds: 5, float: { corner: "topRight", collapsed: false }, followsComponent: true }),
      basePin({ id: "M", name: "gitlog", command: GIT, refresh: "manual", followsComponent: true }),
    ]);
    return s;
  }

  it("shown: pins refreshed when shown run unless they ran in the last 30 s", async () => {
    const { f, book } = await ticking();
    expect(await book.shown(BOT, null)).toBe(1);
    expect(f.runs).toEqual([{ card: "pin/S", command: GIT, force: true }]);
    f.lastRan.set("pin/S", f.clock - 10_000);
    expect(await book.shown(BOT, ["S"])).toBe(0);
    f.lastRan.set("pin/S", f.clock - 31_000);
    expect(await book.shown(BOT, ["s"])).toBe(1);
    expect(await book.shown(BOT, ["other"])).toBe(0);
  });

  it("every so often: only the pins the user can see whose time has come, never a floating one with its own seconds", async () => {
    const { f, book } = await ticking();
    expect(await book.refreshDue(BOT, ["I", "F", "M"])).toBe(1);
    expect(f.runs.map((run) => run.card)).toEqual(["pin/I"]);
    f.lastRan.set("pin/I", f.clock - 30_000);
    expect(await book.refreshDue(BOT, ["I"])).toBe(0);
    f.lastRan.set("pin/I", f.clock - 61_000);
    expect(await book.refreshDue(BOT, ["I"])).toBe(1);
    expect(await book.refreshDue(BOT, [])).toBe(0);
  });

  it("not allowed yet: nothing runs", async () => {
    const { f, book } = await ticking();
    f.approved.clear();
    expect(await book.shown(BOT, null)).toBe(0);
    expect(f.runs).toEqual([]);
  });

  it("a finished run's output is kept on the pin, so it shows after a restart too", async () => {
    const { f, book } = await ticking();
    await book.view(BOT);
    f.lastRuns.set("pin/M", { command: GIT, status: "done", data: `{"n":3}`, ranAt: f.clock });
    await book.cardChanged("pin/M");
    expect(f.stored.get(BOT)!.find((pin: any) => pin.id === "M")).toMatchObject({ data: `{"n":3}`, ranAt: (f.clock - Date.UTC(2001, 0, 1)) / 1000 });
    expect(f.published.at(-1)!.botId).toBe(BOT);
    // A running one keeps nothing yet.
    f.lastRuns.set("pin/I", { command: GIT, status: "running", data: `{"n":4}`, ranAt: f.clock });
    await book.cardChanged("pin/I");
    expect(f.stored.get(BOT)!.find((pin: any) => pin.id === "I")).toMatchObject({ data: "null" });
  });
});

describe("storage and ownership", () => {
  it("imports what the core's pins.json held once, and then keeps its own", async () => {
    const { f, book } = setUp();
    f.legacy = [{ id: "L1", name: "todo", data: `{"a":1}`, refresh: "manual", minutes: 15, size: "S", makingLive: false }, { not: "a pin" }];
    expect((await book.view("main")).pins.map((pin) => [pin.id, pin.size])).toEqual([["L1", "1x1"]]);
    expect(f.stored.get(BOT)).toHaveLength(1);
    // What was stored wins over the file after that.
    f.legacy = [];
    const again = f.book();
    expect((await again.view(BOT)).pins).toHaveLength(1);
  });

  it("whose a pin is: by its id in a bot's own (strict), or any bot's, else by its component's name; an old pin belongs to its bot", async () => {
    const { f, book } = setUp();
    f.stored.set(BOT, [basePin({ id: "P1", name: "todo", ranAt: 700_000_000, command: GIT, refresh: "shown" })]);
    await book.view(BOT);
    expect(await book.owner(BOT, "P1", null, true, [])).toEqual({ botId: BOT, linkAuthor: BOT, words: "refreshes when shown", when: 700_000_000 });
    expect(await book.owner(BOT, "nope", null, true, [])).toBeNull();
    expect(await book.owner(BOT, "nope", "todo", false, [BOT])).toMatchObject({ botId: BOT });
    expect(await book.owner(BOT, undefined, "gone", false, [])).toBeNull();
    expect(f.stored.get(BOT)![0]).toMatchObject({ linkAuthor: BOT });
  });

  it("tells the page again only when what it draws changed", async () => {
    const { f, book } = setUp();
    f.stored.set(BOT, [basePin({ id: "P1", name: "todo" })]);
    await book.publish(BOT);
    await book.publish(BOT);
    expect(f.published).toHaveLength(1);
    await book.change(BOT, "P1", { kind: "resize", size: "1x1" });
    expect(f.published).toHaveLength(2);
    expect(book.published()).toEqual([BOT]);
  });
});
