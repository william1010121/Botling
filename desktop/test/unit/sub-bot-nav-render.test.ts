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

describe("navigation v5, part 3: pins, Scheduled, New sub bot, Archive", () => {
  const bots = [base, sub("r", "Release", { working: true }), sub("n", "Nightly audit"), sub("i", "i18n")];
  const rows = bots.slice(1).map((bot) => subBotRow(bot, none, 0, bot.id === "n" ? [{ id: "c", kind: "legacy", task: "t", title: "t", schedule: "Every day 09:00", cron: "0 9 * * *", timezone: "system_local", status: "enabled", next: new Date(86_400_000).toISOString() }] : []));
  const picker = (over: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(SubBotPicker, { rows, onOpen() {}, onClose() {}, ...over }));
  it("a pinned row sits under Pinned with its ⌘⇧N key and a ⋮⋮ handle to drag; others offer ☆ Pin", () => {
    const markup = picker({ pinned: ["i"], pinKeys: ["⌘⇧1", "⌘⇧2"], onPin() {}, onMovePin() {} });
    expect(markup.indexOf(">Pinned<")).toBeGreaterThan(-1);
    expect(markup.indexOf(">Pinned<")).toBeLessThan(markup.indexOf(">Active<"));
    expect(markup).toMatch(/data-pinned="true"[^>]*draggable="true"|draggable="true"[^>]*data-pinned="true"/);
    expect(markup).toContain('<span class="sbn-time sbn-key">⌘⇧1</span>');
    expect(markup).toContain('class="sbn-handle"');
    expect(markup).toContain('aria-label="Unpin i18n"');
    expect(markup).toContain('aria-label="Pin Release"');
    expect(markup.match(/class="sbn-handle"/g)).toHaveLength(1);
  });
  it("Scheduled lists the sub bot with a routine coming, its schedule in the corner", () => {
    const markup = picker();
    expect(markup).toContain(">Scheduled<");
    expect(markup).toContain("⟳ Every day 09:00");
  });
  it("the footer offers + New sub bot… where it can be made", () => {
    expect(picker({ onNew: async () => {} })).toContain('class="sbn-act"');
    expect(picker({ onNew: async () => {} })).toContain("+ New sub bot…");
    expect(picker()).not.toContain("New sub bot");
  });
  it("the breadcrumb's menu can archive the sub bot shown (the close-sub-bot dialog)", () => {
    const markup = picker({ parent: base, currentId: "r", onArchive() {} });
    expect(markup).toContain("Archive Release…");
  });
  it("a project bot with none yet gets a faint + Sub bot to make the first (shown on hover)", () => {
    const markup = draw(base, [base], { onNew: async () => {}, canAdd: true });
    expect(markup).toContain('class="sbn-anchor sbn-empty-slot"');
    expect(markup).toContain("+ Sub bot");
    // Only where a sub bot can be made (a project bot; App decides): otherwise the header stays as it was.
    expect(draw(base, [base], { onNew: async () => {}, canAdd: false })).toBe("");
  });
});
