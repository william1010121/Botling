// A sub bot in the app page: not a row of the left column, listed under its project bot as a row of
// its own kind, opening as a bot's chat (with the input box) titled "project bot › sub bot".
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { railOrder, rowTarget, SubBotTitle } from "../../src/renderer/App";
import { SubagentRows } from "../../src/renderer/Rail";
import type { BotView, SubagentRowView } from "../../src/contract";

const base: BotView = { id: "p1", name: "botling", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const subRow: SubagentRowView = { id: "s1", title: "Settings page", status: "running", head: "claude", startedAt: 1, endedAt: null, unsettledAt: null, settled: false, prompt: "Continue", subBot: "s1" };
const plainRow: SubagentRowView = { id: "toolu_1", title: "Fix API", status: "running", head: "claude", startedAt: 2, endedAt: null, unsettledAt: null, settled: false, prompt: "Fix" };
const parent: BotView = { ...base, subagentRows: [subRow, plainRow] };
const sub: BotView = { ...base, id: "s1", name: "Settings page", role: "bot", job: "Continue", parent: "p1" };
const main: BotView = { ...base, id: "m", name: "Main bot", role: "main" };

describe("left column", () => {
  it("lists no row for a sub bot, in the column or in a search", () => {
    const ids = railOrder([main, parent, sub], []).map((entry) => entry.bot.id);
    expect(ids).toEqual(["m", "p1"]);
    expect(railOrder([main, parent, sub], ["s1"]).map((entry) => entry.bot.id)).toEqual(["m", "p1"]);
  });
  it("lists it under its project bot as a sub bot row, with no settle button", () => {
    const markup = renderToStaticMarkup(createElement(SubagentRows, { bot: parent, now: Date.now(), watching: null, onOpen() {}, onSettle() {} }));
    expect(markup).toContain('data-sub-bot="s1"');
    expect(markup).toContain("Sub bot of botling: Settings page");
    expect(markup).toContain(">sub bot<");
    expect(markup).not.toContain("Settle subagent Settings page");
    // A plain subagent keeps its settle button and has no kind tag.
    expect(markup).toContain("Settle subagent Fix API");
    expect(markup.match(/subagent-kind/g)).toHaveLength(1);
  });
  it("lists a sub bot's own subagents nested under its row (project bot > sub bot > subagent), and not under the project bot's own list", () => {
    const child: SubagentRowView = { ...plainRow, id: "toolu_child", title: "Check layout" };
    const sub2: BotView = { ...sub, subagentRows: [child] };
    const markup = renderToStaticMarkup(createElement(SubagentRows, { bot: parent, bots: [parent, sub2], now: Date.now(), watching: null, onOpen() {}, onSettle() {} }));
    expect(markup).toContain('data-subagent="toolu_child"');
    expect(markup).toContain("Subagent of Settings page");
    expect(markup).toContain("Settle subagent Check layout");
    expect(markup).toContain('subagent-rows nested" data-bot="s1"');
    // Order: the sub bot's row, then its child directly under it.
    const at = (text: string) => markup.indexOf(text);
    expect(at('data-subagent="s1"')).toBeLessThan(at('data-subagent="toolu_child"'));
    // Without the bots list nothing is nested.
    expect(renderToStaticMarkup(createElement(SubagentRows, { bot: parent, now: Date.now(), watching: null, onOpen() {}, onSettle() {} }))).not.toContain("toolu_child");
  });
  it("marks the row selected while the sub bot's chat is on screen", () => {
    const shown = renderToStaticMarkup(createElement(SubagentRows, { bot: parent, now: Date.now(), watching: null, shownBot: "s1", onOpen() {}, onSettle() {} }));
    expect(shown).toMatch(/subagent-row selected[^"]*" data-subagent="s1"/);
    const other = renderToStaticMarkup(createElement(SubagentRows, { bot: parent, now: Date.now(), watching: null, shownBot: "p1", onOpen() {}, onSettle() {} }));
    expect(other).not.toMatch(/subagent-row selected[^"]*" data-subagent="s1"/);
  });
});

describe("opening a row", () => {
  it("a sub bot row opens the bot's own chat (it has the input box); a subagent row its read-only view", () => {
    expect(rowTarget(subRow)).toEqual({ kind: "bot", botId: "s1" });
    expect(rowTarget(plainRow)).toEqual({ kind: "subagent", id: "toolu_1" });
  });
  it("its title says which project bot it belongs to, with a way back", () => {
    const markup = renderToStaticMarkup(createElement(SubBotTitle, { bot: sub, parent: base, onOpenParent() {} }));
    expect(markup).toContain(">botling</button>");
    expect(markup).toContain(">Settings page</span>");
    expect(markup.indexOf("botling")).toBeLessThan(markup.indexOf("Settings page"));
  });
});
