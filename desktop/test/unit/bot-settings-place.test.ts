// @vitest-environment jsdom
// A bot's own settings live in the right panel, as in 1.x (SidePanels.swift DetailPanel): the
// slider button on the panel's name row opens them one level in (Back returns to the overview),
// and the folded strip's bottom button opens the panel on them. They are not a "This bot" section
// of the Settings sheet, which holds Botling's own settings only.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { RightPanel, type RightPanelProps } from "../../src/renderer/RightPanel";
import { SettingsSheet } from "../../src/renderer/Settings";
import type { Client } from "../../src/renderer/client";
import type { BotView } from "../../src/contract";

const bot = {
  id: "main", name: "Main bot", role: "main", heads: ["claude"], phase: "awake", working: false, approvals: 0, unread: 0,
  avatar: "robot", subagentRows: [],
} as unknown as BotView;

async function render(element: ReturnType<typeof createElement>) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(element));
  return { host, done: async () => { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; } };
}

function panel(extra: Partial<RightPanelProps>, calls: string[]) {
  return createElement(RightPanel, {
    bot, bots: [bot], waiting: { items: [], doing: {} }, look: "original", status: { key: "idle", text: "Idle" }, results: [], watching: null,
    tasks: [], messages: [], selectedTask: null, collapsed: false,
    onSelectTask() {}, onJumpToTask() {}, onAskForReport() {}, onCompleteTask() {}, onSelect() {}, onIgnore() {}, onOpenResult() {}, onOpenSubagent() {}, onUnsettle() {},
    onSettings() { calls.push("settings"); }, onCloseSettings() { calls.push("close"); }, onExpand() { calls.push("expand"); },
    ...extra,
  } satisfies RightPanelProps);
}

describe("a bot's settings are in the right panel", () => {
  it("the open panel's name row has the bot's settings button", async () => {
    const calls: string[] = [];
    const { host, done } = await render(panel({}, calls));
    try {
      const button = host.querySelector<HTMLButtonElement>(".detail-head button[aria-label='Bot settings']");
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(calls).toEqual(["settings"]);
    } finally { await done(); }
  });

  it("shown, the settings take the overview's place, with Back", async () => {
    const calls: string[] = [];
    const page = createElement("div", { className: "the-page" }, "engines");
    const { host, done } = await render(panel({ showingSettings: true, settingsPage: page }, calls));
    try {
      expect(host.querySelector(".detail-panel .the-page")).not.toBeNull();
      expect(host.querySelector(".tasks-section")).toBeNull();
      expect(host.querySelector(".detail-head")!.textContent).toContain("Settings");
      await act(async () => host.querySelector<HTMLButtonElement>(".detail-head button[aria-label='Back']")!.click());
      expect(calls).toEqual(["close"]);
    } finally { await done(); }
  });

  it("the folded strip's settings button asks for them (the app opens the panel on them)", async () => {
    const calls: string[] = [];
    const { host, done } = await render(panel({ collapsed: true }, calls));
    try {
      await act(async () => host.querySelector<HTMLButtonElement>(".strip-settings")!.click());
      expect(calls).toEqual(["settings"]);
    } finally { await done(); }
  });

  it("the Settings sheet has no \"This bot\" section", async () => {
    const client = { request: async () => new Promise(() => {}) } as unknown as Client;
    const { host, done } = await render(createElement(SettingsSheet, { client, settings: null, bot, plugins: null, onClose() {} }));
    try {
      const tabs = [...host.querySelectorAll(".settings-tab")].map((tab) => tab.textContent);
      expect(tabs).toContain("General");
      expect(tabs).not.toContain("This bot");
    } finally { await done(); }
  });
});
