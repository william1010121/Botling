// The Rail's owner actions: a worker row's menu has "Send a message…", "Stop" (while it runs), "Move to…" and "Select
// several…"; picking shows a tick box per worker row and "New sub bot with these (N)"; a sub bot row has a "⋯" for
// "Close sub bot…", which asks first.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMenu, CloseSubBotDialog, SubagentRows, SubBotMenu } from "../../src/renderer/Rail";
import type { BotView, SubagentRowView } from "../../src/contract";

const worker = (id: string, title: string, status: SubagentRowView["status"] = "running"): SubagentRowView => ({ id, title, status, head: "codex", startedAt: 2, endedAt: null, unsettledAt: null, settled: false, prompt: "x", agentId: `ag-${id}`, movable: { ok: true, reason: null } });
const subRow: SubagentRowView = { id: "s1", title: "Client", status: "running", head: "claude", startedAt: 1, endedAt: null, unsettledAt: null, settled: false, prompt: "Continue", subBot: "s1" };
const bot: BotView = { id: "p1", name: "botling", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["codex"], job: null,
  subagentRows: [worker("t1", "Research the API"), worker("t2", "Write the client"), subRow] };
const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const noop = () => {};

describe("a worker row's menu", () => {
  it("offers a message, a stop while it runs, the move and picking several", () => {
    const markup = html(createElement(AgentMenu, { row: worker("t1", "Research the API"), at: { x: 0, y: 0 }, load: async () => ({ engine: "codex" as const, targets: [] }), onMove: noop, onClose: noop, onMessage: noop, onStop: noop, onSelectSeveral: noop }));
    expect(markup).toContain("Send a message…");
    expect(markup).toContain(">Stop<");
    expect(markup).toContain("Move to…");
    expect(markup).toContain("Select several…");
    const ended = html(createElement(AgentMenu, { row: worker("t1", "Research the API", "completed"), at: { x: 0, y: 0 }, load: async () => ({ engine: "codex" as const, targets: [] }), onMove: noop, onClose: noop, onMessage: noop, onStop: noop }));
    expect(ended).not.toContain(">Stop<");
    expect(ended).toContain("Send a message…");
  });
});

describe("picking several worker rows", () => {
  it("shows a tick box for each of that bot's worker rows and the group form with the count", () => {
    const markup = html(createElement(SubagentRows, { bot, now: Date.now(), watching: null, onOpen: noop, onSettle: noop, selection: { botId: "p1", ids: ["t2"] }, onToggleSelect: noop, onGroup: noop, onCancelSelect: noop }));
    expect(markup.match(/class="subagent-pick"/g)).toHaveLength(2);
    expect(markup).toContain('aria-label="Pick Write the client" checked=""');
    expect(markup).toContain("New sub bot with these (1)");
    expect(markup).not.toContain("Settle subagent Research the API");
  });

  it("shows nothing of it when not picking", () => {
    const markup = html(createElement(SubagentRows, { bot, now: Date.now(), watching: null, onOpen: noop, onSettle: noop }));
    expect(markup).not.toContain("subagent-pick");
    expect(markup).not.toContain("New sub bot with these");
  });
});

describe("closing a sub bot", () => {
  it("has a ⋯ on the sub bot row, a menu item, and a confirmation saying where its agents go", () => {
    const rows = html(createElement(SubagentRows, { bot, now: Date.now(), watching: null, onOpen: noop, onSettle: noop, onSubBotMenu: noop }));
    expect(rows).toContain("More for the sub bot Client");
    expect(html(createElement(SubBotMenu, { name: "Client", at: { x: 0, y: 0 }, onCloseSubBot: noop, onClose: noop }))).toContain("Close sub bot…");
    const dialog = html(createElement(CloseSubBotDialog, { name: "Client", onConfirm: noop, onCancel: noop }));
    expect(dialog).toContain("Close the sub bot &quot;Client&quot;?");
    expect(dialog).toContain("go back to the bot that runs them");
  });
});
