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
