// @vitest-environment jsdom
// The chat header's main-area tabs on the real App (plan W2): a plugin declaring a `mainTab` view gets a
// tab button beside Chat / Board for the bots its forRole names; pressing it keeps the choice for that bot
// (settings.json mainTabs), and the tab's frame takes the chat's place. Without such a plugin nothing changes.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/App";
import { settingsView } from "../../src/core/settings";
import type { BotView, PluginsView } from "../../src/contract";
import type { Client } from "../../src/renderer/client";
import { WorkspaceStore, type WorkspaceView } from "../../src/renderer/store";

const MAIN = "6A0B0000-0000-4000-8000-000000000002";
const PROJECT = "B0000000-0000-4000-8000-000000000001";
const bot = (id: string, role: BotView["role"], name: string): BotView => ({ id, name, role, avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] });
const plugins: PluginsView = {
  plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null,
  mainTabs: [{ plugin: "board", id: "board.wall", title: "Wall", forRole: "main" }, { plugin: "git", id: "git.log", title: "Git", forRole: "project" }],
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); localStorage.clear(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

async function render(botId: string, extra: Partial<WorkspaceView> = {}, whiteboard = false) {
  // The whiteboard off unless asked, as after picking Chat: this test is about the plugin tabs.
  localStorage.setItem("botling.mainWhiteboard", whiteboard ? "1" : "0");
  const defaults = new WorkspaceStore(async () => { throw Error("Unexpected snapshot"); }).getView();
  let view: WorkspaceView = { ...defaults, ready: true, bots: [bot(MAIN, "main", "Main bot"), bot(PROJECT, "manager", "Site")], settings: settingsView({}), plugins, chat: { botId, messages: [], running: null, live: [], tasks: [] }, ...extra };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
  const store = { getView: () => view, getChatView: () => view, subscribe, subscribeChat: subscribe, showBoard: () => {} } as unknown as WorkspaceStore;
  const requests: any[] = [];
  const client = { request: vi.fn(async (command: any) => { requests.push(command); return command.type === "plugins.panel" ? { title: "Wall", source: "", settings: {} } : command.type === "card.page" ? { url: "botling-card://page/t" } : { specs: [] }; }), onEvent: () => () => {} } as unknown as Client;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(App, { client, store })));
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const update = async (next: Partial<WorkspaceView>) => { await act(async () => { view = { ...view, ...next }; listeners.forEach((fn) => fn()); }); };
  const buttons = () => [...host.querySelectorAll(".board-switch button")].map((button) => button.textContent);
  return { host, requests, update, buttons };
}

it("the main bot's header gets the main tab, a project bot's the project tab; nothing else changes", async () => {
  const main = await render(MAIN);
  expect(main.buttons()).toEqual(["Chat", "Board", "Whiteboard", "Wall"]);
  const project = await render(PROJECT);
  expect(project.buttons()).toEqual(["Chat", "Board", "Git"]);
  const none = await render(PROJECT, { plugins: { ...plugins, mainTabs: [] } });
  expect(none.buttons()).toEqual(["Chat", "Board"]);
});

it("pressing a tab keeps it for that bot, and its frame takes the chat's place; Chat goes back", async () => {
  const { host, requests, update } = await render(MAIN);
  const wall = host.querySelector<HTMLButtonElement>('.main-tab-switch[data-tab="board/board.wall"]')!;
  await act(async () => wall.click());
  expect(requests).toContainEqual({ type: "settings.set", change: { key: "mainTab", value: { botId: MAIN, tab: "board/board.wall" } } });
  // The core keeps it (settings.json); the next view says so.
  await update({ settings: { ...settingsView({}), mainTabs: { [MAIN]: "board/board.wall" } } });
  expect(host.querySelector(".chat-column")?.classList.contains("main-tab-on")).toBe(true);
  expect(wall.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".main-tab")?.getAttribute("data-plugin")).toBe("board");
  expect(requests).toContainEqual({ type: "plugins.panel", name: "board", panel: "board.wall" });
  const chat = [...host.querySelectorAll<HTMLButtonElement>(".board-switch button")].find((button) => button.textContent === "Chat")!;
  expect(chat.getAttribute("aria-pressed")).toBe("false");
  await act(async () => chat.click());
  expect(requests).toContainEqual({ type: "settings.set", change: { key: "mainTab", value: { botId: MAIN, tab: null } } });
});

it("a tab remembered for a bot shows when its chat opens, in the whiteboard's place too", async () => {
  const { host } = await render(MAIN, { settings: { ...settingsView({}), mainTabs: { [MAIN]: "board/board.wall" } } }, true);
  expect(host.querySelector(".main-tab")).not.toBeNull();
  expect(host.querySelector(".chat-column")?.classList.contains("whiteboard-on")).toBe(false);
});

// botling.whiteboard's tab (plan W5) takes the place of the app page's own Whiteboard button and page while that plugin is on.
const board: PluginsView = { ...plugins, mainTabs: [{ plugin: "botling.whiteboard", id: "botling.whiteboard", title: "Whiteboard", icon: "people", forRole: "main" }] };

it("with botling.whiteboard on, its tab is the Whiteboard button (same place, same icon) and the app page's own is gone", async () => {
  const { host, buttons } = await render(MAIN, { plugins: board }, true);
  expect(buttons()).toEqual(["Chat", "Board", "Whiteboard"]);
  const tab = host.querySelector<HTMLButtonElement>('.main-tab-switch[data-tab="botling.whiteboard/botling.whiteboard"]')!;
  expect(tab.className).toContain("whiteboard-switch");
  expect(tab.querySelector("svg")).not.toBeNull();
  // The main bot opens on it unless Chat or Board was picked last (the choice the page kept for its own whiteboard goes on).
  expect(host.querySelector(".main-tab")?.getAttribute("data-plugin")).toBe("botling.whiteboard");
  expect(host.querySelector(".whiteboard")).toBeNull();
  expect(tab.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".chat-column")?.className).toContain("main-tab-on");
});

it("picking Chat keeps Chat for the next start; picking the Whiteboard tab again keeps the tab", async () => {
  const { host, requests, update } = await render(MAIN, { plugins: board }, true);
  const chat = [...host.querySelectorAll<HTMLButtonElement>(".board-switch button")].find((button) => button.textContent === "Chat")!;
  await act(async () => chat.click());
  expect(localStorage.getItem("botling.mainWhiteboard")).toBe("0");
  await update({});
  expect(host.querySelector(".main-tab")).toBeNull();
  expect(chat.getAttribute("aria-pressed")).toBe("true");
  const tab = host.querySelector<HTMLButtonElement>(".main-tab-switch.whiteboard-switch")!;
  await act(async () => tab.click());
  expect(localStorage.getItem("botling.mainWhiteboard")).toBe("1");
  expect(requests).toContainEqual({ type: "settings.set", change: { key: "mainTab", value: { botId: MAIN, tab: "botling.whiteboard/botling.whiteboard" } } });
});

it("with the plugin off the app page's own Whiteboard button is there, as before; a project bot has no whiteboard", async () => {
  const off = await render(MAIN, { plugins: { ...plugins, mainTabs: [] } }, true);
  expect(off.buttons()).toEqual(["Chat", "Board", "Whiteboard"]);
  expect(off.host.querySelector(".board-switch .whiteboard-switch:not(.main-tab-switch)")).not.toBeNull();
  const project = await render(PROJECT, { plugins: board }, true);
  expect(project.buttons()).toEqual(["Chat", "Board"]);
});
