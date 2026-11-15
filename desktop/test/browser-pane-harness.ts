// The app page with a bot's browser pane open (M7-06c): App drawn in jsdom with a fixture plugin list, main's `state` message
// delivered through the browser bridge (browser-state.ts), the floating toolbar brought out by the pointer, and the toolbar's
// markup read back. Shared by the browser-tab golden (no plugin host) and the browser-pane plugin test (the plugin loaded).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { settingsView } from "../src/core/settings";
import type { BotView, PluginsView } from "../src/contract";
import { App } from "../src/renderer/App";
import type { Client } from "../src/renderer/client";
import { WorkspaceStore, type WorkspaceView } from "../src/renderer/store";

export const PANE_BOT = "B0000000-0000-4000-8000-0000000000b1";
const bot: BotView = { id: PANE_BOT, name: "Site", role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] };

type Row = NonNullable<PluginsView["menus"]>[number];
/** The browser/tab rows of the fixtures: a PDF-only button (an icon the app knows), a host-only one, and one for every tab (a letter). */
export const TAB_ROWS: Row[] = [
  { menu: "browser/tab", command: "coach.start", plugin: "coach", title: "Read with me", icon: "doc", when: { scheme: "file", ext: ["pdf"] } },
  { menu: "browser/tab", command: "zed.tools.run", plugin: "zed.tools", title: "Zed", icon: "download", when: { scheme: "https", host: "*.example.org" } },
  { menu: "browser/tab", command: "clip.save", plugin: "clip", title: "Clip", locales: { "zh-Hant": { title: "剪藏" } } },
];
/** The other menus ride along (the pane must not read them). */
export const OTHER_ROWS: Row[] = [
  { menu: "chat/link", command: "coach.link", plugin: "coach", title: "Link", when: { ext: ["pdf"] } },
  { menu: "message/context", command: "clip.msg", plugin: "clip", title: "Msg" },
];
export const paneView = (menus: Row[] = [...TAB_ROWS, ...OTHER_ROWS]): PluginsView => ({ plugins: [], broken: [], host: { running: true, problem: null }, secretsProblem: null, keybindings: [], menus });

// Main's side of the bridge: the page subscribes once (browser-state.ts starts once per module), so the listener is kept here.
let deliver: (message: unknown) => void = () => undefined;
const bridge = { post: () => undefined, subscribe: (listener: (message: unknown) => void) => { deliver = listener; return () => undefined; } };

export interface Pane {
  host: HTMLElement;
  /** The toolbar's markup (the floating toolbar, pointer on it), with React's `:rN:` ids normalised. */
  toolbar(): string;
  /** Draws the page again with another plugin list. */
  rerender(plugins: PluginsView | null): Promise<void>;
  close(): Promise<void>;
}

/** Opens `tab` (a url, and the file: address of a PDF tab when it shows another) in the bot's pane and draws the page with `plugins`. */
export async function openPane(plugins: PluginsView | null, tab: { url: string; fileUrl?: string }, language?: string): Promise<Pane> {
  localStorage.setItem("botling.mainWhiteboard", "0");
  (window as unknown as { botling?: unknown }).botling = { browser: bridge };
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
  const viewOf = (list: PluginsView | null): WorkspaceView => ({ ...defaults, ready: true, bots: [bot], settings: settingsView(language ? { languageChoice: language } : {}), plugins: list, chat: { botId: bot.id, messages: [], running: null, live: [] } });
  let current = viewOf(plugins);
  const listeners = new Set<() => void>();
  const store = { getView: () => current, getChatView: () => current, subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; }, subscribeChat: () => () => {}, showBoard: () => {} } as unknown as WorkspaceStore;
  const client = { request: vi.fn(async () => ({ result: null })), onEvent: () => () => {} } as unknown as Client;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(App, { client, store })));
  await act(async () => { deliver({ type: "state", botId: PANE_BOT, reveal: true, active: "t1", tabs: [{ id: "t1", url: tab.url, title: "Page", favicon: null, loading: false, canGoBack: false, canGoForward: false, ...(tab.fileUrl ? { fileUrl: tab.fileUrl } : {}) }] }); });
  // The pointer comes onto the page's top strip: the toolbar shows (browser-toolbar.ts).
  await act(async () => { host.querySelector(".bp-top")?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })); });
  return {
    host,
    toolbar: () => (host.querySelector(".bp-toolbar")?.outerHTML ?? "").replace(/:r[0-9a-z]+:/g, ":rN:"),
    rerender: async (next) => { current = viewOf(next); await act(async () => { for (const l of listeners) l(); }); },
    close: async () => {
      await act(async () => { deliver({ type: "state", botId: PANE_BOT, active: null, tabs: [] }); });
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    },
  };
}
