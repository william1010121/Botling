// @vitest-environment jsdom
// When the shell's host refused the sidebar plugin, the bot menu (which the plugin owns, M7-05b) is not the page's own list of items
// and not a stale one: it is one "unavailable" line, with no item at all (fail closed, as the column, M7-05a, and Settings, M7-02c).
// A separate file: a refusal marks the renderer's singleton host for the rest of the file.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotView } from "../../src/contract";
import { BotMenu } from "../../src/renderer/Rail";
import { inPageHost } from "../../src/renderer/shell/inpage-host";
import { SIDEBAR_PLUGIN } from "../../src/renderer/sidebar-names";

const hosts: { unmount(): void; el: HTMLElement }[] = [];
afterEach(async () => {
  for (const one of hosts.splice(0)) { await act(async () => one.unmount()); one.el.remove(); }
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
  vi.restoreAllMocks();
});

const bot = { id: "p1", name: "botling", role: "bot", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] } as unknown as BotView;

describe("the bot menu when the sidebar was refused by the shell's host", () => {
  it("shows 'The bot menu is unavailable.' and no item: not Remove, not a plugin's command", async () => {
    const [result] = await inPageHost.start([{ name: SIDEBAR_PLUGIN, codeHash: "0".repeat(64) }]);
    expect(result?.status).toBe("refused");
    const el = document.createElement("div");
    document.body.append(el);
    const root = createRoot(el);
    hosts.push({ unmount: () => root.unmount(), el });
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const pressed: string[] = [];
    await act(async () => root.render(createElement(BotMenu, {
      bot, at: { x: 1, y: 2 }, pinned: false, onRemove: () => pressed.push("remove"), onClose() {}, onTogglePin: () => pressed.push("pin"), onRestart: () => pressed.push("restart"),
      commands: [{ command: "zed.tools.run", title: "Run zed" }], onCommand: (id: string) => pressed.push(id),
    })));
    expect(el.querySelector('p[role="status"]')?.textContent).toBe("The bot menu is unavailable.");
    expect(el.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
    expect(el.querySelector(".bot-menu")).not.toBeNull();
    expect(pressed).toEqual([]);
  });
});
