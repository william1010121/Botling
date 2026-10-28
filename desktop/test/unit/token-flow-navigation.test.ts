// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { settingsView } from "../../src/core/settings";
import type { BotView } from "../../src/contract";
import type { Client } from "../../src/renderer/client";
import { WorkspaceStore, type WorkspaceView } from "../../src/renderer/store";

it("gates the production navigation, keeps Chat mounted, and tears down when developer mode turns off", async () => {
  const bot: BotView = { id: "B", name: "Project", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["codex"], job: null, subagentRows: [] };
  const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
  let view: WorkspaceView = { ...defaults, ready: true, bots: [bot], settings: settingsView({ developerMode: false }), chat: { botId: bot.id, messages: [], running: null, live: [], tasks: [] } };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
  const update = async (value: Partial<WorkspaceView>) => act(async () => { view = { ...view, ...value }; listeners.forEach(fn => fn()); });
  const store = { getView: () => view, getChatView: () => view, subscribe, subscribeChat: subscribe, showBoard(value: boolean) { view = { ...view, board: value }; listeners.forEach(fn => fn()); } } as unknown as WorkspaceStore;
  const request = vi.fn(async () => ({ specs: [], spendingStatus: "missing", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, byBot: [] }));
  const off = vi.fn(); const client = { request, onEvent: () => off } as unknown as Client;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".board-switch button")].find(node => node.textContent === label);
  try {
    await act(async () => root.render(createElement(App, { client, store })));
    expect(button("Token Flow")).toBeUndefined();
    await update({ settings: settingsView({ developerMode: true }) });
    await act(async () => button("Token Flow")!.click());
    expect(host.querySelector(".token-flow-on .token-flow")).not.toBeNull();
    expect(host.querySelector("#chat-frame")).not.toBeNull();
    expect(button("Chat")?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => button("Board")!.click());
    expect(host.querySelector(".token-flow")).toBeNull();
    expect(button("Board")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button("Token Flow")!.click());
    await update({ settings: settingsView({ developerMode: false }) });
    expect(button("Token Flow")).toBeUndefined();
    expect(host.querySelector(".token-flow-on")).toBeNull();
    expect(off).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); host.remove(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; }
});
