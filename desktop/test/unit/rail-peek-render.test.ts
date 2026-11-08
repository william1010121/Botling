// The left column's rows and the status card as drawn (static markup, no window): two numbers, the Idle corner
// button, and the card's rows (sub bots keep "⋯"; subagent rows never have a menu or a settle clock).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotView, SubagentRowView } from "../../src/contract";
import { BotRow } from "../../src/renderer/App";
import { PeekAgent, PeekCard } from "../../src/renderer/Rail";
import { peekCard } from "../../src/renderer/rail-idle";

const base: BotView = { id: "a", name: "EEG", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const row = (over: Partial<SubagentRowView>): SubagentRowView => ({ id: "r", title: "Row", status: "running", head: "claude", startedAt: 1_000, endedAt: null, unsettledAt: null, settled: false, prompt: "p", ...over });
const rowMarkup = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(BotRow, { bot: base, selected: false, look: "original", waiting: false, onSelect() {}, ...extra } as Parameters<typeof BotRow>[0]));

describe("a bot row", () => {
  it("shows only the blue unread number, hidden at zero; no needs-you number and no task count", () => {
    const both = rowMarkup({ counts: { unread: 3, needsYou: 1 }, bot: base });
    expect(both).toContain('<span class="badge" aria-hidden="true">3</span>');
    expect(both).not.toContain("badge waiting");
    expect(both).not.toContain("task-count");
    expect(both).toContain("1 waiting on you, 3 unread");
    expect(rowMarkup({ counts: { unread: 0, needsYou: 2 } })).not.toContain("bot-counts");
  });
  it("has the clock corner button to send it to Idle, and in Idle the back arrow", () => {
    const out = rowMarkup({ idle: { away: false, onToggle() {} } });
    expect(out).toContain('aria-label="Send EEG to Idle"');
    expect(out).toContain("bot-row-wrap idleable");
    const back = rowMarkup({ idle: { away: true, onToggle() {} } });
    expect(back).toContain('aria-label="Bring EEG back from Idle"');
    expect(back).toContain("in Idle");
    // A row that cannot go to Idle (the main bot, Maintainer) has no corner button.
    expect(rowMarkup({})).not.toContain("bot-idle");
  });
});

describe("a bot row and its card", () => {
  // BotRow uses no hooks: its element tree can be read and its handlers called with stand-in events.
  type Node = { type: unknown; props: Record<string, any> };
  const tree = (extra: Record<string, unknown>) => BotRow({ bot: base, selected: false, look: "original", waiting: false, onSelect() {}, ...extra } as Parameters<typeof BotRow>[0]) as unknown as Node;
  const button = (wrap: Node) => (wrap.props.children as Node[]).find((child) => child && child.type === "button")!;
  it("the pointer coming onto the row (not a touch) or leaving it goes to the card; a click only selects", () => {
    const calls: string[] = [];
    const rowEl = { querySelector: () => "row-el" };
    const wrap = tree({ onSelect: (from: { keyboard: boolean }) => calls.push(`select ${from.keyboard}`), peek: { enter: (el: unknown) => calls.push(`enter ${el}`), leave: () => calls.push("leave"), focus: () => calls.push("focus") } });
    wrap.props.onPointerEnter({ pointerType: "mouse", currentTarget: rowEl });
    wrap.props.onPointerLeave({ pointerType: "mouse" });
    wrap.props.onPointerEnter({ pointerType: "touch", currentTarget: rowEl });
    wrap.props.onPointerLeave({ pointerType: "touch" });
    button(wrap).props.onClick({ currentTarget: {}, detail: 1 });
    button(wrap).props.onClick({ currentTarget: {}, detail: 0 });
    expect(calls).toEqual(["enter row-el", "leave", "select false", "select true"]);
  });
  it("only keyboard focus opens it (not the focus a click leaves), and blurring into the card keeps it", () => {
    const calls: string[] = [];
    const wrap = tree({ peek: { enter() {}, leave: () => calls.push("leave"), focus: () => calls.push("focus") } });
    const el = (visible: boolean) => ({ matches: () => visible });
    button(wrap).props.onFocus({ currentTarget: el(true) });
    button(wrap).props.onFocus({ currentTarget: el(false) });
    // No DOM here: a stand-in Element class for the instanceof check.
    class FakeElement { closest() { return {}; } }
    const had = (globalThis as any).Element;
    (globalThis as any).Element = FakeElement;
    try {
      button(wrap).props.onBlur({ relatedTarget: new FakeElement() });
      button(wrap).props.onBlur({ relatedTarget: null });
    } finally { (globalThis as any).Element = had; }
    expect(calls).toEqual(["focus", "leave"]);
  });
  it("a row with nothing to peek at has no hover handlers", () => {
    const wrap = tree({});
    expect(wrap.props.onPointerEnter).toBeUndefined();
    expect(button(wrap).props.onFocus).toBeUndefined();
  });
});

describe("the status card", () => {
  const sub: BotView = { ...base, id: "s1", name: "sess-align", role: "bot", parent: "a", working: true, subagentRows: [row({ id: "t1", title: "run-4090-1" })] };
  const owner: BotView = { ...base, subagentRows: [row({ id: "s1", subBot: "s1", title: "sess-align" }), row({ id: "w1", title: "Fix API" })] };
  const render = () => renderToStaticMarkup(createElement(PeekCard, {
    bot: owner, card: peekCard(owner, [owner, sub], { items: [], doing: { s1: "Running validation" } }, 1_000 + 38 * 60_000),
    anchor: { top: 100, right: 248 }, now: 1_000 + 38 * 60_000, focusFirst: false, onOpenChat() {}, onOpenAgent() {}, onSubBotMenu() {}, onClose() {},
  }));
  it("heads with the bot's name and its sub bot count, one row per sub bot with state, doing and elapsed time", () => {
    const out = render();
    expect(out).toContain('role="dialog" aria-label="EEG status"');
    expect(out).toContain(">1 sub bot<");
    expect(out).toContain('peek-dot running');
    expect(out).toContain(">sub bot<");
    expect(out).toContain(">Running validation<");
    expect(out).toContain(">38m<");
    expect(out).toContain(">Open EEG chat<");
  });
  it("starts folded: no subagent rows until a sub bot or the Agents row is opened", () => {
    const out = render();
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('data-subagent="t1"');
    expect(out).not.toContain('data-subagent="w1"');
    expect(out).toMatch(/<span>Agents<\/span><span class="rail-peek-group-count">1<\/span>/);
  });
  it("a sub bot row keeps its \"⋯\"; there is no settle clock anywhere in the card", () => {
    const out = render();
    expect(out).toContain('aria-label="More for the sub bot sess-align"');
    expect(out.match(/subagent-more-menu/g)).toHaveLength(1);
    expect(out).not.toContain("subagent-settle");
  });
  it("a subagent row: state dot, title and running/done, with no menu and no settle clock", () => {
    const running = renderToStaticMarkup(createElement(PeekAgent, { row: row({ id: "t1", title: "run-4090-1" }), onOpen() {} }));
    expect(running).toContain('peek-dot running');
    expect(running).toContain(">run-4090-1<");
    expect(running).toContain('rail-peek-state running">running<');
    expect(running).not.toContain("subagent-more-menu");
    expect(running).not.toContain("settle");
    const done = renderToStaticMarkup(createElement(PeekAgent, { row: row({ status: "completed", endedAt: 2 }), onOpen() {} }));
    expect(done).toContain('peek-dot done');
    expect(done).toContain(">done<");
  });
});
