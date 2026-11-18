// @vitest-environment jsdom
// The chat header's main-area tabs on the real App (plan W2): a plugin declaring a `mainTab` view gets a
// tab button beside Chat (and before Storage) for the bots its forRole names; pressing it keeps the choice for that bot
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
/** botling.board (pins only now: the Board it drew is gone). */
const boardPlugin = (enabled = true): PluginsView["plugins"][number] => ({ name: "botling.board", title: "Pins", version: "1.0.0", description: null, enabled, failure: null, installedFrom: null, builtIn: true, permissions: [], parts: ["web"], settings: [], commands: [], panels: [] });
const plugins: PluginsView = {
  plugins: [boardPlugin()], broken: [], host: { running: true, problem: null }, secretsProblem: null,
  mainTabs: [{ plugin: "board", id: "board.wall", title: "Wall", forRole: "main" }, { plugin: "git", id: "git.log", title: "Git", forRole: "project" }],
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); localStorage.clear(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false; });

async function render(botId: string, extra: Partial<WorkspaceView> = {}, whiteboard = false) {
  // The whiteboard off unless asked, as after picking Chat: this test is about the plugin tabs.
  localStorage.setItem("botling.mainWhiteboard", whiteboard ? "1" : "0");
  const defaults = new WorkspaceStore(async () => { throw Error("Unexpected snapshot"); }).getView();
  let view: WorkspaceView = { ...defaults, ready: true, bots: [bot(MAIN, "main", "Main bot"), bot(PROJECT, "manager", "Site")], settings: settingsView({}), plugins, chat: { botId, messages: [], running: null, live: [] }, ...extra };
  const listeners = new Set<() => void>();
  const subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
  const store = { getView: () => view, getChatView: () => view, subscribe, subscribeChat: subscribe } as unknown as WorkspaceStore;
  const requests: any[] = [];
  const client = { request: vi.fn(async (command: any) => { requests.push(command); return command.type === "plugins.panel" ? { title: "Wall", source: "", settings: {} } : command.type === "card.page" ? { url: "botling-card://page/t" } : command.type === "storage.list" ? { items: [], artifacts: null } : { specs: [] }; }), onEvent: () => () => {} } as unknown as Client;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(App, { client, store })));
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const update = async (next: Partial<WorkspaceView>) => { await act(async () => { view = { ...view, ...next }; listeners.forEach((fn) => fn()); }); };
  const buttons = () => [...host.querySelectorAll(".board-switch button")].map((button) => button.textContent || button.getAttribute("aria-label"));
  return { host, requests, update, buttons };
}

it("the main bot's menu offers the main tab, a project bot's the project tab; the header shows neither until it is in use", async () => {
  const main = await render(MAIN);
  // A plugin's tab stays out of the header until it is in use (opened, pinned or marked); the "More tabs" button lists it.
  expect(main.buttons()).toEqual(["Chat", "Storage", "More tabs"]);
  const project = await render(PROJECT);
  expect(project.buttons()).toEqual(["Chat", "Storage", "More tabs"]);
  const none = await render(PROJECT, { plugins: { ...plugins, mainTabs: [] } });
  expect(none.buttons()).toEqual(["Chat", "Storage"]);
});

it("pressing a tab keeps it for that bot, and its frame takes the chat's place; Chat goes back", async () => {
  const { host, requests, update } = await render(MAIN);
  await act(async () => host.querySelector<HTMLButtonElement>(".main-tab-more")!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('.tab-more-row[data-tab="board/board.wall"]')!.click());
  expect(requests).toContainEqual({ type: "settings.set", change: { key: "mainTab", value: { botId: MAIN, tab: "board/board.wall" } } });
  // The core keeps it (settings.json); the next view says so.
  await update({ settings: { ...settingsView({}), mainTabs: { [MAIN]: "board/board.wall" } } });
  const wall = host.querySelector<HTMLButtonElement>('.main-tab-switch[data-tab="board/board.wall"]')!;
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
  expect(buttons()).toEqual(["Chat", "Whiteboard", "Storage"]);
  const tab = host.querySelector<HTMLButtonElement>('.main-tab-switch[data-tab="botling.whiteboard/botling.whiteboard"]')!;
  expect(tab.className).toContain("whiteboard-switch");
  expect(tab.querySelector("svg")).not.toBeNull();
  // The main bot opens on it unless Chat or Storage was picked last (the choice the page kept for its own whiteboard goes on).
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

it("with the plugin off there is no Whiteboard button (the core has no whiteboard of its own); a project bot has none either", async () => {
  const off = await render(MAIN, { plugins: { ...plugins, mainTabs: [] } }, true);
  expect(off.buttons()).toEqual(["Chat", "Storage"]);
  expect(off.host.querySelector(".chat-column")?.className).not.toContain("whiteboard-on");
  const project = await render(PROJECT, { plugins: board }, true);
  expect(project.buttons()).toEqual(["Chat", "Storage"]);
});

it("there is no Board button, with botling.board on, off or not known yet; the Storage tab is always there", async () => {
  const off = await render(MAIN, { plugins: { ...plugins, plugins: [boardPlugin(false)] } });
  expect(off.buttons()).toEqual(["Chat", "Storage", "More tabs"]);
  const unknown = await render(MAIN, { plugins: null });
  expect(unknown.buttons()).toEqual(["Chat", "Storage"]);
});

it("the Storage tab is kept for the bot like a plugin tab, and its list takes the chat's place", async () => {
  const { host, requests, update } = await render(MAIN);
  const storage = host.querySelector<HTMLButtonElement>(".main-tab-switch.storage-switch")!;
  await act(async () => storage.click());
  expect(requests).toContainEqual({ type: "settings.set", change: { key: "mainTab", value: { botId: MAIN, tab: "botling/storage" } } });
  await update({ settings: { ...settingsView({}), mainTabs: { [MAIN]: "botling/storage" } } });
  expect(storage.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector(".chat-column")?.classList.contains("main-tab-on")).toBe(true);
  expect(host.querySelector(".storage-main .storage-tab")).not.toBeNull();
  expect(host.querySelector(".main-tab[data-plugin]")).toBeNull();
  expect(requests).toContainEqual({ type: "storage.list", botId: MAIN });
});

// Dynamic tabs: a tab is in the header while it is in use (on screen), pinned for the bot, or marked for it by its plugin.
const coachTab = { plugin: "coach", id: "coach.page", title: "Reading", forRole: "marked" as const, bots: [PROJECT] };
const noteTab = { plugin: "botling.note", id: "botling.note.tab", title: "Note", forRole: "any" as const };
const dynamic: PluginsView = { ...plugins, mainTabs: [noteTab, plugins.mainTabs![1]!, coachTab] };
const GIT = "git/git.log";
const pinned = (botId: string, tabs: string[]) => ({ settings: { ...settingsView({}), pinnedTabs: { [botId]: tabs } } });

it("Note and a marked tab are in the header from the start, a project tab is only in the \"More tabs\" menu", async () => {
  const { host, buttons } = await render(PROJECT, { plugins: dynamic });
  expect(buttons()).toEqual(["Chat", "Note", "Reading", "Storage", "More tabs"]);
  expect(host.querySelector('.main-tab-switch[data-tab="git/git.log"]')).toBeNull();
  const more = host.querySelector<HTMLButtonElement>(".main-tab-more")!;
  expect(more.getAttribute("aria-expanded")).toBe("false");
  await act(async () => more.click());
  expect(more.getAttribute("aria-expanded")).toBe("true");
  // The menu lists every plugin tab beyond Note and Storage in the plugins' order (the marked one is in the header already, but can be pinned too).
  expect([...host.querySelectorAll(".tab-more-row")].map((row) => row.getAttribute("data-tab"))).toEqual([GIT, "coach/coach.page"]);
});

it("with only Note (and the Whiteboard) offered there is no \"More tabs\" button", async () => {
  const { buttons } = await render(PROJECT, { plugins: { ...plugins, mainTabs: [noteTab] } });
  expect(buttons()).toEqual(["Chat", "Note", "Storage"]);
});

it("a tab opened from the menu is in the header while it is shown, and goes again when the bot leaves it", async () => {
  const { host, requests, update, buttons } = await render(PROJECT, { plugins: dynamic });
  await act(async () => host.querySelector<HTMLButtonElement>(".main-tab-more")!.click());
  await act(async () => host.querySelector<HTMLButtonElement>(`.tab-more-row[data-tab="${GIT}"]`)!.click());
  expect(requests).toContainEqual({ type: "settings.set", change: { key: "mainTab", value: { botId: PROJECT, tab: GIT } } });
  expect(host.querySelector(".tab-more-menu")).toBeNull();
  await update({ settings: { ...settingsView({}), mainTabs: { [PROJECT]: GIT } } });
  expect(buttons()).toEqual(["Chat", "Note", "Git", "Reading", "Storage", "More tabs"]);
  expect(host.querySelector(`.main-tab-switch[data-tab="${GIT}"]`)?.getAttribute("aria-pressed")).toBe("true");
  // Back to Chat: the tab leaves the header (it was not pinned).
  await update({ settings: settingsView({}) });
  expect(buttons()).toEqual(["Chat", "Note", "Reading", "Storage", "More tabs"]);
});

it("a plugin that opens its tab (botling.openTab) brings it into the header, as the menu does", async () => {
  const { host, update, buttons } = await render(PROJECT, { plugins: dynamic });
  // main answers openTab by remembering the tab for the bot.
  await update({ settings: { ...settingsView({}), mainTabs: { [PROJECT]: GIT } } });
  expect(buttons()).toContain("Git");
  expect(host.querySelector(".main-tab")?.getAttribute("data-plugin")).toBe("git");
});

it("the pin in the menu keeps a tab in the header for that bot; pinning is asked of main, per bot", async () => {
  const { host, requests, update, buttons } = await render(PROJECT, { plugins: dynamic });
  await act(async () => host.querySelector<HTMLButtonElement>(".main-tab-more")!.click());
  const pin = host.querySelector<HTMLButtonElement>(`.tab-more-pin[data-tab="${GIT}"]`)!;
  expect(pin.getAttribute("aria-pressed")).toBe("false");
  expect(pin.getAttribute("aria-label")).toBe("Pin Git");
  await act(async () => pin.click());
  expect(requests).toContainEqual({ type: "settings.set", change: { key: "pinTab", value: { botId: PROJECT, tab: GIT, pinned: true } } });
  // A pin does not open the tab.
  expect(requests.filter((request) => request.change?.key === "mainTab")).toEqual([]);
  await update(pinned(PROJECT, [GIT]));
  expect(buttons()).toEqual(["Chat", "Note", "Git", "Reading", "Storage", "More tabs"]);
  // Chat is the view and the tab stays: it is pinned.
  expect(host.querySelector(`.main-tab-switch[data-tab="${GIT}"]`)?.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector(`.main-tab-switch[data-tab="${GIT}"] svg`)).not.toBeNull();
  // The menu stays open after a pin, to pin another; the row now shows the pin on.
  expect(host.querySelector(".tab-more-menu")).not.toBeNull();
  const pinOn = host.querySelector<HTMLButtonElement>(`.tab-more-pin[data-tab="${GIT}"]`)!;
  expect(pinOn.getAttribute("aria-pressed")).toBe("true");
  expect(pinOn.getAttribute("aria-label")).toBe("Unpin Git");
  await act(async () => pinOn.click());
  expect(requests).toContainEqual({ type: "settings.set", change: { key: "pinTab", value: { botId: PROJECT, tab: GIT, pinned: false } } });
});

it("a right-click on a plugin's tab pins or unpins it; Note and Storage have nothing to pin", async () => {
  const { host, requests, update } = await render(PROJECT, { plugins: dynamic, ...pinned(PROJECT, [GIT]) });
  const git = host.querySelector<HTMLButtonElement>(`.main-tab-switch[data-tab="${GIT}"]`)!;
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  await act(async () => { git.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  expect(requests).toContainEqual({ type: "settings.set", change: { key: "pinTab", value: { botId: PROJECT, tab: GIT, pinned: false } } });
  await update({ settings: settingsView({}) });
  expect(host.querySelector(`.main-tab-switch[data-tab="${GIT}"]`)).toBeNull();
  const before = requests.length;
  for (const selector of ['.main-tab-switch[data-tab="botling.note/botling.note.tab"]', ".storage-switch"]) {
    await act(async () => { host.querySelector(selector)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); });
  }
  expect(requests.length).toBe(before);
  await act(async () => host.querySelector<HTMLButtonElement>(".main-tab-more")!.click());
  expect(host.querySelector('.tab-more-pin[data-tab="botling.note/botling.note.tab"]')).toBeNull();
});

it("a pin belongs to one bot: another bot's pin does not show here", async () => {
  const { buttons } = await render(PROJECT, { plugins: dynamic, ...pinned(MAIN, [GIT]) });
  expect(buttons()).toEqual(["Chat", "Note", "Reading", "Storage", "More tabs"]);
});
