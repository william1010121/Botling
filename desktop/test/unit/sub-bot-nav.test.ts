// Navigation v5, sub bots (sub-bot-nav.ts): the "Sub bots" button left of Chat | Board | Review, its menu,
// the breadcrumb "‹ botling / Release ▾" inside a sub bot, and ⌘[ / ⌘] between the two. Pure logic.
import { describe, expect, it } from "vitest";
import type { BotView, WaitingView } from "../../src/contract";
import {
  filterSubBotRows, headerNav, rememberRoom, roomStep, subBotRow, subBotSections, subBotsButton, subBotsOf, SUB_BOT_SEARCH_FROM,
} from "../../src/renderer/sub-bot-nav";

const base: BotView = { id: "p1", name: "botling", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const sub = (id: string, name: string, over: Partial<BotView> = {}): BotView => ({ ...base, id, name, role: "bot", parent: "p1", job: `${name} job`, ...over });
const none: WaitingView = { items: [], doing: {} };
const NOW = Date.parse("2026-11-08T12:00:00Z");

describe("which sub bots a bot has", () => {
  it("lists only its direct sub bots, in the bots list's order", () => {
    const other = { ...base, id: "p2", name: "other" };
    const bots = [base, other, sub("r", "Release"), sub("x", "Elsewhere", { parent: "p2" }), sub("d", "Docs"), sub("n", "Nested", { parent: "r" })];
    expect(subBotsOf("p1", bots).map((bot) => bot.id)).toEqual(["r", "d"]);
    expect(subBotsOf("p2", bots).map((bot) => bot.id)).toEqual(["x"]);
    expect(subBotsOf("d", bots)).toEqual([]);
  });
});

describe("a menu row", () => {
  it("answers what it is for, how it is now, and whether something is new", () => {
    const row = subBotRow(sub("r", "Release", { job: "Ship 2.4.1\nmore lines", working: true, subagents: 1 }), none, NOW);
    expect(row).toMatchObject({ id: "r", name: "Release", initial: "R", dot: "working", purpose: "Ship 2.4.1", badge: null });
    expect(row.status).toBe("Working · 1 worker");
  });
  it("uses the bot's progress line for its status when it has one", () => {
    const row = subBotRow(sub("r", "Release", { working: true }), { items: [], doing: { r: "Notarizing" } }, NOW);
    expect(row.status).toBe("Notarizing");
  });
  it("says asks (orange) when it waits on you, quoting what it asks", () => {
    const row = subBotRow(sub("s", "Spec keeper"), { items: [{ botId: "s", text: "Pin TLC 1.8.0 or keep 1.7.4?", messageId: null }], doing: {} }, NOW);
    expect(row.dot).toBe("asks");
    expect(row.badge).toEqual({ kind: "asks", text: "asks" });
    expect(row.status).toBe("“Pin TLC 1.8.0 or keep 1.7.4?”");
    expect(subBotRow(sub("s", "S", { approvals: 2 }), none, NOW).status).toBe("2 approvals waiting");
  });
  it("says new (green) for an unread report, and error (red) for a problem, which wins", () => {
    expect(subBotRow(sub("d", "Docs", { unread: 3 }), none, NOW)).toMatchObject({ dot: "new", badge: { kind: "new", text: "new" } });
    const broken = subBotRow(sub("d", "Docs", { unread: 3, problem: "Codex exited: rate limit" }), none, NOW);
    expect(broken).toMatchObject({ dot: "error", status: "Codex exited: rate limit", badge: { kind: "error", text: "error" } });
  });
  it("an idle one shows how long it has been idle", () => {
    const row = subBotRow(sub("i", "i18n", { lastActivity: "2026-11-06T11:00:00Z" }), none, NOW);
    expect(row).toMatchObject({ dot: "idle", badge: { kind: "time", text: "2d" }, initial: "I" });
    expect(subBotRow(sub("i", "i18n"), none, NOW).badge).toBeNull();
  });
  it("gives each sub bot a steady tint and an initial even for odd names", () => {
    const a = subBotRow(sub("r", "release"), none, NOW);
    expect(a.initial).toBe("R");
    expect(subBotRow(sub("r", "release"), none, NOW).tint).toBe(a.tint);
    expect(subBotRow(sub("q", "  "), none, NOW).initial).toBe("?");
    expect(a.tint).toBeGreaterThanOrEqual(0);
    expect(a.tint).toBeLessThan(6);
  });
});

describe("the menu's sections", () => {
  it("orders Needs you, Active, Idle and leaves out empty ones", () => {
    const rows = [
      subBotRow(sub("i", "Idle one"), none, NOW),
      subBotRow(sub("r", "Release", { working: true }), none, NOW),
      subBotRow(sub("s", "Spec", { approvals: 1 }), none, NOW),
      subBotRow(sub("e", "Broken", { problem: "x" }), none, NOW),
      subBotRow(sub("d", "Docs", { unread: 1 }), none, NOW),
    ];
    expect(subBotSections(rows).map((section) => [section.title, section.rows.map((row) => row.id)])).toEqual([
      ["Needs you", ["s", "e"]], ["Active", ["r", "d"]], ["Idle", ["i"]],
    ]);
    expect(subBotSections([subBotRow(sub("i", "Idle"), none, NOW)]).map((section) => section.title)).toEqual(["Idle"]);
  });
  it("searches names and purposes from 12 sub bots on", () => {
    expect(SUB_BOT_SEARCH_FROM).toBe(12);
    const rows = [subBotRow(sub("r", "Release"), none, NOW), subBotRow(sub("w", "Weekly report"), none, NOW), subBotRow(sub("d", "Docs", { job: "Rewrite README" }), none, NOW), subBotRow(sub("x", "Other"), none, NOW)];
    expect(filterSubBotRows(rows, " RE ").map((row) => row.id)).toEqual(["r", "w", "d"]);
    expect(filterSubBotRows(rows, "").length).toBe(4);
  });
});

describe("the Sub bots button", () => {
  it("is not there with no sub bots, names the one, counts many with up to three faces", () => {
    expect(subBotsButton([])).toEqual({ kind: "none" });
    const one = subBotsButton([subBotRow(sub("r", "Release"), none, NOW)]);
    expect(one).toMatchObject({ kind: "one", row: { id: "r" } });
    const rows = ["a", "b", "c", "d"].map((id) => subBotRow(sub(id, id.toUpperCase()), none, NOW));
    const many = subBotsButton(rows);
    expect(many).toMatchObject({ kind: "many", count: 4, hint: null });
    expect(many.kind === "many" && many.stack.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });
  it("hints, in order, a failure, then asks, then new reports", () => {
    const fresh = subBotRow(sub("d", "Docs", { unread: 1 }), none, NOW);
    const asks = subBotRow(sub("s", "Spec", { approvals: 1 }), none, NOW);
    const broken = subBotRow(sub("e", "Broken", { problem: "x" }), none, NOW);
    const idle = subBotRow(sub("i", "Idle"), none, NOW);
    expect(subBotsButton([fresh, idle])).toMatchObject({ hint: { kind: "new", text: "1 new" } });
    expect(subBotsButton([fresh, asks, idle])).toMatchObject({ hint: { kind: "asks", text: "1 asks" } });
    expect(subBotsButton([fresh, asks, broken])).toMatchObject({ hint: { kind: "error", text: "1 error" } });
    expect(subBotsButton([fresh])).toMatchObject({ kind: "one", hint: { kind: "new", text: "1 new" } });
  });
});

describe("the header's left side", () => {
  const release = sub("r", "Release");
  const docs = sub("d", "Docs");
  const bots = [base, release, docs];
  it("a project bot shows its Sub bots button; a sub bot shows the way back to its project bot", () => {
    const top = headerNav(base, bots, none, NOW);
    expect(top.kind).toBe("subBots");
    expect(top.kind === "subBots" && top.rows.map((row) => row.id)).toEqual(["r", "d"]);
    const inside = headerNav(release, bots, none, NOW);
    expect(inside).toMatchObject({ kind: "crumb", parent: { id: "p1" }, current: { id: "r", initial: "R" } });
    // Its menu lists its project bot's sub bots (the one shown ticked by the page).
    expect(inside.kind === "crumb" && inside.rows.map((row) => row.id)).toEqual(["r", "d"]);
  });
  it("shows nothing with no sub bots, or when the project bot is gone", () => {
    expect(headerNav({ ...base, id: "lonely" }, bots, none, NOW)).toEqual({ kind: "none" });
    expect(headerNav(sub("o", "Orphan", { parent: "gone" }), bots, none, NOW)).toEqual({ kind: "none" });
  });
});

describe("⌘[ and ⌘] between the project bot and its sub bot", () => {
  const release = sub("r", "Release");
  const bots = [base, release, sub("d", "Docs")];
  it("⌘[ goes back to the project bot; ⌘] goes again to the sub bot you came from", () => {
    expect(roomStep("back", release, bots, {})).toBe("p1");
    expect(roomStep("back", base, bots, {})).toBeNull();
    const last = rememberRoom({}, release);
    expect(last).toEqual({ p1: "r" });
    expect(roomStep("forward", base, bots, last)).toBe("r");
    expect(roomStep("forward", base, bots, {})).toBeNull();
    expect(roomStep("forward", release, bots, last)).toBeNull();
  });
  it("forgets a sub bot that is gone, and a top bot is not remembered", () => {
    expect(roomStep("forward", base, [base], { p1: "r" })).toBeNull();
    const last = { p1: "r" };
    expect(rememberRoom(last, base)).toBe(last);
  });
});

// ---- Navigation v5, part 3: Scheduled, Pinned, ⌘⇧1–9, drag order, "New while you were in X", reduced motion.
import type { RoutineView } from "../../src/contract";
import { flashMs, leaveMark, movePinned, newSinceMark, pinnedTarget, togglePinned, whenText } from "../../src/renderer/sub-bot-nav";

const routine = (over: Partial<RoutineView>): RoutineView => ({ id: "cron:1", kind: "legacy", task: "audit", title: "audit", schedule: "Every day 09:00", cron: "0 9 * * *", timezone: "system_local", status: "enabled", next: null, ...over });

describe("scheduled sub bots", () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
  it("writes when it next runs: today, tomorrow, a weekday within the week, else the date", () => {
    const now = at(8, 12);
    expect(whenText(at(8, 18), now)).toBe("today 18:00");
    expect(whenText(at(9, 9), now)).toBe("tomorrow 09:00");
    expect(whenText(at(12, 10, 30), now)).toBe("Thu 10:30");
    expect(whenText(at(20, 9), now)).toBe("Nov 20 09:00");
  });
  it("an idle sub bot with a routine that will run is Scheduled, soonest first, with ⟳ and its next run", () => {
    const now = at(8, 12);
    const a = subBotRow(sub("a", "Nightly audit"), none, now, [routine({ next: new Date(at(9, 9)).toISOString() })]);
    const b = subBotRow(sub("b", "Weekly report"), none, now, [routine({ schedule: "Mon 10:00", next: new Date(at(9, 8)).toISOString() }), routine({ id: "x", next: null, status: "paused" })]);
    const idle = subBotRow(sub("c", "Idle"), none, now, []);
    expect(a).toMatchObject({ dot: "idle", next: at(9, 9), schedule: "Every day 09:00", badge: { kind: "time", text: "⟳ Every day 09:00" }, status: "Next tomorrow 09:00" });
    expect(subBotSections([a, idle, b]).map((section) => [section.title, section.rows.map((row) => row.id)])).toEqual([["Scheduled", ["b", "a"]], ["Idle", ["c"]]]);
  });
  it("a working one stays Active even with a routine", () => {
    const row = subBotRow(sub("a", "A", { working: true }), none, 0, [routine({ next: new Date(5_000).toISOString() })]);
    expect(row.dot).toBe("working");
    expect(subBotSections([row])[0]!.title).toBe("Active");
  });
});

describe("pinned sub bots", () => {
  const rows = ["a", "b", "c", "d"].map((id) => subBotRow(sub(id, id.toUpperCase(), id === "d" ? { approvals: 1 } : {}), none, 0));
  it("Pinned comes after Needs you, in pin order; one that needs you stays in Needs you", () => {
    expect(subBotSections(rows, ["c", "d", "a", "gone"]).map((section) => [section.title, section.rows.map((row) => row.id)])).toEqual([
      ["Needs you", ["d"]], ["Pinned", ["c", "a"]], ["Idle", ["b"]],
    ]);
  });
  it("pins at the end, unpins, and drags within the pinned order", () => {
    expect(togglePinned(["a"], "b")).toEqual(["a", "b"]);
    expect(togglePinned(["a", "b"], "a")).toEqual(["b"]);
    expect(movePinned(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
    expect(movePinned(["a", "b", "c"], "a", 2)).toEqual(["b", "c", "a"]);
    expect(movePinned(["a", "b", "c"], "x", 0)).toEqual(["a", "b", "c"]);
    expect(movePinned(["a", "b", "c"], "b", 9)).toEqual(["a", "c", "b"]);
  });
  it("⌘⇧N opens the N-th pinned sub bot of the project bot on screen (or its sibling's project)", () => {
    const bots = [base, sub("a", "A"), sub("b", "B"), { ...base, id: "p2" }, sub("z", "Z", { parent: "p2" })];
    expect(pinnedTarget(1, base, bots, ["z", "b", "a"])).toBe("b");
    expect(pinnedTarget(2, bots[1]!, bots, ["z", "b", "a"])).toBe("a");
    expect(pinnedTarget(3, base, bots, ["z", "b", "a"])).toBeNull();
  });
});

describe("New while you were in X", () => {
  const P = { id: "p1", parent: null, lastId: "m2" };
  it("leaving a project bot for its sub bot marks its newest line; leaving it elsewhere forgets", () => {
    const marks = leaveMark({}, P, sub("r", "Release"));
    expect(marks).toEqual({ p1: { after: "m2", name: "Release" } });
    expect(leaveMark(marks, P, { ...base, id: "other", parent: null })).toEqual({});
    // Between sibling sub bots the mark stays.
    expect(leaveMark(marks, { id: "r", parent: "p1", lastId: "x" }, sub("d", "Docs"))).toBe(marks);
  });
  it("draws the divider over the first line that came after, never over your own", () => {
    const lines = [{ id: "m1", role: "user" }, { id: "m2", role: "bot" }, { id: "m3", role: "user" }, { id: "m4", role: "bot" }];
    expect(newSinceMark({ after: "m2", name: "Release" }, lines)).toEqual({ messageID: "m4", text: "New while you were in Release" });
    expect(newSinceMark({ after: "m4", name: "Release" }, lines)).toBeNull();
    expect(newSinceMark({ after: "gone", name: "Release" }, lines)).toBeNull();
    expect(newSinceMark(undefined, lines)).toBeNull();
  });
});

describe("reduced motion", () => {
  it("the coming-back ring is 600 ms, or a 1.2 s still ring with Reduce motion", () => {
    expect(flashMs(false)).toBe(600);
    expect(flashMs(true)).toBe(1200);
  });
});

describe("the pinnedSubBots setting", () => {
  it("keeps your pinned sub bots in the order you dragged them: upper-cased, no repeats", async () => {
    const { applySetting, settingsView } = await import("../../src/core/settings");
    const one = "0a1b2c3d-0000-4000-8000-000000000001", two = "0A1B2C3D-0000-4000-8000-000000000002";
    const raw = applySetting({}, { key: "pinnedSubBots", value: [two, one, two.toLowerCase()] });
    expect(raw.pinnedSubBots).toEqual([two, one.toUpperCase()]);
    expect(settingsView(raw).pinnedSubBots).toEqual([two, one.toUpperCase()]);
    expect(settingsView({ pinnedSubBots: ["nope", 1] }).pinnedSubBots).toEqual([]);
    expect(settingsView({}).pinnedSubBots).toEqual([]);
  });
});

describe("+ New sub bot…", () => {
  it("asks the project bot in its chat, as you would yourself (it opens sub bots)", async () => {
    const { newSubBotAsk } = await import("../../src/renderer/sub-bot-nav");
    expect(newSubBotAsk("Release", "Ship 2.4.1")).toBe('Please open a new sub bot named "Release" for this: Ship 2.4.1');
    expect(newSubBotAsk(' Re"lease ', "  line one\nline two ")).toBe('Please open a new sub bot named "Re\'lease" for this: line one\nline two');
  });
});
