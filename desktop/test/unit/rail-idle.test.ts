// The left column's Idle group, its two numbers and the status card's rows (rail-idle.ts): pure logic.
import { describe, expect, it } from "vitest";
import { MAINTAINER_BOT_ID, type BotView, type SubagentRowView, type WaitingView } from "../../src/contract";
import { botCounts, canIdle, idleCounts, idleList, peekCard, railSplit } from "../../src/renderer/rail-idle";

const base: BotView = { id: "p1", name: "botling", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const row = (over: Partial<SubagentRowView>): SubagentRowView => ({ id: "r", title: "Row", status: "running", head: "claude", startedAt: 1_000, endedAt: null, unsettledAt: null, settled: false, prompt: "p", ...over });
const main: BotView = { ...base, id: "m", name: "Main bot", role: "main" };
const keeper: BotView = { ...base, id: MAINTAINER_BOT_ID, name: "Maintainer", role: "bot" };
const a: BotView = { ...base, id: "a", name: "A" };
const b: BotView = { ...base, id: "b", name: "B" };
const c: BotView = { ...base, id: "c", name: "C" };
const sub: BotView = { ...base, id: "s1", name: "Settings page", role: "bot", parent: "a" };
const noWaiting: WaitingView = { items: [], doing: {} };

describe("Idle: only bots the user sends", () => {
  it("the main bot, Maintainer and sub bots cannot go to Idle", () => {
    expect(canIdle(main)).toBe(false);
    expect(canIdle(keeper)).toBe(false);
    expect(canIdle(sub)).toBe(false);
    expect(canIdle(a)).toBe(true);
  });
  it("splits the column: idle bots leave the main list and are listed in Idle in the order sent", () => {
    const bots = [main, keeper, a, b, c, sub];
    const split = railSplit(bots, ["b"], ["c", "b", "m", MAINTAINER_BOT_ID, "s1", "gone"]);
    expect(split.rows.map((entry) => entry.bot.id)).toEqual(["m", MAINTAINER_BOT_ID, "a"]);
    expect(split.idle.map((bot) => bot.id)).toEqual(["c", "b"]);
    // Nothing idle: the column as before, the pinned section kept.
    const plain = railSplit(bots, ["b"], []);
    expect(plain.rows.map((entry) => [entry.bot.id, entry.section])).toEqual([["m", null], [MAINTAINER_BOT_ID, null], ["b", "pinned"], ["a", "rest"], ["c", null]]);
    expect(plain.idle).toEqual([]);
  });
  it("the section heads follow what is left (an idle pinned bot takes its Pinned head with it)", () => {
    const split = railSplit([main, a, b], ["b"], ["b"]);
    expect(split.rows.map((entry) => [entry.bot.id, entry.section])).toEqual([["m", null], ["a", "rest"]]);
  });
  it("the clock sends a bot to Idle and the back arrow restores it (the undo)", () => {
    const sent = idleList(["c"], "a", true);
    expect(sent).toEqual(["c", "a"]);
    expect(idleList(sent, "a", true)).toEqual(["c", "a"]);
    expect(idleList(sent, "a", false)).toEqual(["c"]);
    expect(idleList(["c"], "zz", false)).toEqual(["c"]);
  });
});

describe("the two numbers", () => {
  it("blue is unread (hidden while its chat is on screen), orange the approvals and questions waiting on you", () => {
    const waiting: WaitingView = { items: [{ botId: "a", text: "Which port?", messageId: "x" }, { botId: "a", text: "Check the plan", messageId: null }], doing: {} };
    expect(botCounts({ ...a, unread: 3, approvals: 1 }, [a], waiting, false)).toEqual({ unread: 3, needsYou: 3 });
    expect(botCounts({ ...a, unread: 3 }, [a], noWaiting, true)).toEqual({ unread: 0, needsYou: 0 });
  });
  it("a sub bot's waiting items and approvals count toward its owning bot (sub bots of sub bots too)", () => {
    const deep: BotView = { ...base, id: "s2", name: "Deep", role: "bot", parent: "s1", approvals: 2 };
    const waiting: WaitingView = { items: [{ botId: "s1", text: "OK to push?", messageId: "q" }], doing: {} };
    const bots = [a, { ...sub, approvals: 1 }, deep, b];
    expect(botCounts(a, bots, waiting, false).needsYou).toBe(4);
    expect(botCounts(b, bots, waiting, false).needsYou).toBe(0);
  });
  it("the Idle row shows an orange number when a bot inside needs you, and how many bots it holds", () => {
    const waiting: WaitingView = { items: [{ botId: "c", text: "?", messageId: "q" }], doing: {} };
    expect(idleCounts([b, c], [b, c], waiting)).toEqual({ bots: 2, needsYou: 1 });
    expect(idleCounts([b], [b, c], waiting)).toEqual({ bots: 1, needsYou: 0 });
  });
});

describe("the status card", () => {
  const now = 1_000 + 38 * 60_000;
  it("one row per sub bot: its state, what it is doing and how long it has run, with its own subagents", () => {
    const run = { ...sub, working: true, subagentRows: [row({ id: "t1", title: "run-4090-1" }), row({ id: "t2", title: "old", status: "completed", endedAt: 1, settled: true })] };
    const waits: BotView = { ...base, id: "s3", name: "Spec", role: "bot", parent: "a", approvals: 1 };
    const done: BotView = { ...base, id: "s4", name: "Docs", role: "bot", parent: "a", phase: "asleep" };
    const owner: BotView = { ...a, subagentRows: [row({ id: "s1", subBot: "s1", title: "Settings page" }), row({ id: "s3", subBot: "s3", title: "Spec", startedAt: 500 }), row({ id: "s4", subBot: "s4", status: "completed", endedAt: 2_000 }), row({ id: "w1", title: "Fix API" })] };
    const waiting: WaitingView = { items: [], doing: { s1: "Running validation" } };
    const card = peekCard(owner, [owner, run, waits, done], waiting, now);
    expect(card.subBots.map((entry) => [entry.bot.id, entry.state])).toEqual([["s1", "running"], ["s3", "waiting"], ["s4", "done"]]);
    expect(card.subBots[0]!.doing).toBe("Running validation");
    expect(card.subBots[0]!.elapsedMs).toBe(38 * 60_000);
    expect(card.subBots[2]!.elapsedMs).toBe(1_000);
    // A sub bot's own subagents: the listed ones (a settled one is not).
    expect(card.subBots[0]!.agents.map((agent) => agent.id)).toEqual(["t1"]);
    // The bot's direct subagents: workers only, never its sub bot rows.
    expect(card.agents.map((agent) => agent.id)).toEqual(["w1"]);
  });
  it("a waiting sub bot says what it waits for", () => {
    const waits: BotView = { ...sub, approvals: 0 };
    const waiting: WaitingView = { items: [{ botId: "s1", text: "OK to push to main?", messageId: "q" }], doing: { s1: "Pushing" } };
    const card = peekCard(a, [a, waits], waiting, now);
    expect(card.subBots[0]!.state).toBe("waiting");
    expect(card.subBots[0]!.doing).toBe("OK to push to main?");
    // No book row for it: no elapsed time.
    expect(card.subBots[0]!.elapsedMs).toBeNull();
  });
  it("a bot with nothing under it has an empty card", () => {
    const card = peekCard(b, [a, b, sub], noWaiting, now);
    expect(card.subBots).toEqual([]);
    expect(card.agents).toEqual([]);
  });
});

describe("the idleBots setting", () => {
  it("is kept beside pinnedBots: upper-cased, without repeats, read back in the order sent", async () => {
    const { applySetting, settingsView } = await import("../../src/core/settings");
    const one = "0a1b2c3d-0000-4000-8000-000000000001", two = "0A1B2C3D-0000-4000-8000-000000000002";
    const raw = applySetting({}, { key: "idleBots", value: [one, two, one.toUpperCase()] });
    expect(raw.idleBots).toEqual([one.toUpperCase(), two]);
    expect(settingsView(raw).idleBots).toEqual([one.toUpperCase(), two]);
    expect(settingsView({ idleBots: ["not-an-id", 3] }).idleBots).toEqual([]);
    expect(settingsView({}).idleBots).toEqual([]);
  });
});
