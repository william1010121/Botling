// Navigation v5, sub bots: what SubBotNav draws left of Chat | Board | Review (static markup, no window, no focus).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotView, WaitingView } from "../../src/contract";
import { SubBotPicker, SubBotNav } from "../../src/renderer/SubBotNav";
import { headerNav, subBotRow } from "../../src/renderer/sub-bot-nav";

const base: BotView = { id: "p1", name: "botling", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };
const sub = (id: string, name: string, over: Partial<BotView> = {}): BotView => ({ ...base, id, name, role: "bot", parent: "p1", job: `${name} job`, ...over });
const none: WaitingView = { items: [], doing: {} };
const keys = { menu: "⌘⇧S", back: "⌘[", forward: "⌘]" };
const draw = (bot: BotView, bots: BotView[], over: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(SubBotNav, { nav: headerNav(bot, bots, none, 0), open: false, onOpenChange() {}, onOpen() {}, keys, ...over }));

describe("the Sub bots button", () => {
  it("draws nothing for a bot with no sub bots (the header as today)", () => {
    expect(draw(base, [base])).toBe("");
  });
  it("one sub bot: its name opens it, ▾ opens the menu", () => {
    const markup = draw(base, [base, sub("r", "Release")]);
    expect(markup).toContain('aria-label="Open sub bot Release"');
    expect(markup).toContain('aria-label="Sub bots menu"');
    expect(markup).not.toContain("Sub bots · ");
  });
  it("several: \"Sub bots · N\" with three faces and the hint beside it", () => {
    const bots = [base, sub("r", "Release", { unread: 2 }), sub("n", "Nightly"), sub("d", "Docs"), sub("w", "Weekly")];
    const markup = draw(base, bots);
    expect(markup).toContain('<span class="sbn-label"><span class="sbn-word">Sub bots · </span>4</span>');
    expect(markup.match(/class="sbn-face"/g)).toHaveLength(3);
    expect(markup).toContain('class="sbn-pill" data-kind="new">1 new<');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-expanded="false"');
  });
  it("after coming back from a sub bot: a blue ring and the ⌘] hint", () => {
    const markup = draw(base, [base, sub("r", "Release"), sub("d", "Docs")], { flash: true, forward: { name: "Release" } });
    expect(markup).toContain("sbn-button flash");
    expect(markup).toContain("⌘] Release");
  });
});

describe("the open menu", () => {
  it("draws below the button with the menu's rows, and the button says it is open", () => {
    const markup = draw(base, [base, sub("r", "Release"), sub("d", "Docs")], { open: true });
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('class="sbn-menu" role="menu"');
    expect(markup).toContain('data-sub-bot="r"');
    expect(markup).not.toContain("sbn-forward");
  });
});

describe("inside a sub bot: the breadcrumb", () => {
  it("‹ botling goes back; the sub bot's name opens the menu", () => {
    const bots = [base, sub("r", "Release"), sub("d", "Docs")];
    const markup = draw(bots[1]!, bots);
    expect(markup).toContain('aria-label="Back to botling"');
    expect(markup).toContain('title="Back to botling (⌘[)"');
    expect(markup).toContain('aria-label="Release, sub bot of botling"');
    expect(markup.indexOf("Back to botling")).toBeLessThan(markup.indexOf("Release, sub bot"));
  });
  it("marks unread lines in the project bot with a dot", () => {
    const bots = [{ ...base, unread: 2 }, sub("r", "Release")];
    expect(draw(bots[1]!, bots)).toContain('aria-label="2 unread"');
  });
});

describe("the menu", () => {
  it("lists sections, purpose and status per row", () => {
    const rows = [subBotRow(sub("r", "Release", { working: true, job: "Ship 2.4.1" }), { items: [], doing: { r: "Notarizing" } }, 0), subBotRow(sub("s", "Spec", { approvals: 1 }), none, 0)];
    const markup = renderToStaticMarkup(createElement(SubBotPicker, { rows, onOpen() {}, onClose() {} }));
    expect(markup).toContain('role="menu"');
    expect(markup.indexOf(">Needs you<")).toBeLessThan(markup.indexOf(">Active<"));
    expect(markup).toContain(">Ship 2.4.1<");
    expect(markup).toContain("Notarizing");
    expect(markup).toContain('data-kind="asks">asks<');
    expect(markup).not.toContain("sbn-search");
  });
  it("the breadcrumb's menu puts the project bot first and ticks the one shown", () => {
    const rows = [subBotRow(sub("r", "Release"), none, 0), subBotRow(sub("d", "Docs"), none, 0)];
    const markup = renderToStaticMarkup(createElement(SubBotPicker, { rows, currentId: "r", parent: base, backKey: "⌘[", onOpen() {}, onClose() {} }));
    expect(markup.indexOf('data-bot="p1"')).toBeLessThan(markup.indexOf('data-sub-bot="r"'));
    expect(markup).toMatch(/data-sub-bot="r" aria-current="page"/);
    expect(markup).toContain("sbn-check");
  });
  it("from 12 sub bots on, opens with a search box", () => {
    const rows = Array.from({ length: 12 }, (_, index) => subBotRow(sub(`s${index}`, `Bot ${index}`), none, 0));
    const markup = renderToStaticMarkup(createElement(SubBotPicker, { rows, onOpen() {}, onClose() {} }));
    expect(markup).toContain('aria-label="Search sub bots"');
  });
});
