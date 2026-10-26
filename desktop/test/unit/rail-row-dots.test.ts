// The left column's bot row draws no orange "waiting on you" dot (1.x's RailLayout.unreadBadge,
// commit 9c10da8): a memory's "Waiting on you" list fills almost every project, so the dot showed on
// nearly every row. Waiting stays in the row's accessibility label and the right panel.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotRow } from "../../src/renderer/App";
import type { BotView } from "../../src/contract";

const bot: BotView = { id: "p1", name: "botling", role: "bot", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };

describe("left column bot row", () => {
  it("draws no orange dot for a bot that waits on you, but says so in its label", () => {
    const markup = renderToStaticMarkup(createElement(BotRow, { bot, selected: false, onSelect() {}, look: "original", waiting: true }));
    expect(markup).not.toContain("bot-dot waiting");
    expect(markup).toContain("waiting on you");
  });

  it("keeps the unread count, as 1.x does", () => {
    const markup = renderToStaticMarkup(createElement(BotRow, { bot: { ...bot, unread: 3 }, selected: false, onSelect() {}, look: "original", waiting: true }));
    expect(markup).toContain('<span class="badge" aria-hidden="true">3</span>');
  });
});
