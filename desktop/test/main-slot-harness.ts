// The whole app page drawn in jsdom for the main area's cards (M7-07a): App with a fixture plugin list, one or two bots, the tab each bot
// last showed (`settings.mainTabs`), and a stub client that records what the page asks main (`settings.set` for the tab memory,
// `chat.shown`). Shared by the DOM goldens (no plugin host, and the chat plugin loaded) and the chat-main-slot test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { settingsView } from "../src/core/settings";
import type { BotView, PluginsView } from "../src/contract";
import { App } from "../src/renderer/App";
import type { WebChrome } from "../src/renderer/app-shared";
import type { Client } from "../src/renderer/client";
import { WorkspaceStore, type WorkspaceView } from "../src/renderer/store";
import { desktop } from "./helpers";

export const SITE = "B0000000-0000-4000-8000-0000000000C1";
export const OTHER = "B0000000-0000-4000-8000-0000000000C2";
export const MAIN = "B0000000-0000-4000-8000-0000000000C3";
const make = (id: string, name: string, role: BotView["role"]): BotView => ({ id, name, role, avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0, problem: null, heads: ["claude"], job: null, subagentRows: [] });
export const siteBot = make(SITE, "Site", "manager");
export const otherBot = make(OTHER, "Blog", "manager");
export const mainBot = make(MAIN, "Main", "main");

/** The kernel-goldens plugin list: plugins by name and the step-1 view surfaces (main tabs: Note for any bot, Whiteboard for the main bot, Zed for marked bots). */
export const fixtureView = (): PluginsView => JSON.parse(readFileSync(join(desktop, "test", "fixtures", "kernel-goldens", "plugins-list.json"), "utf8")) as PluginsView;
export const NOTE_TAB = "botling.note/botling.note.tab";

export interface PageOptions {
  bots?: BotView[];
  /** The bot whose chat is shown. */
  shown?: string;
  plugins?: PluginsView | null;
  /** The tab each bot last showed (settings.json `mainTabs`). */
  mainTabs?: Record<string, string>;
  /** Left unset (the main bot opens on the whiteboard) unless "0". */
  whiteboard?: "0" | null;
  /** Command types the stub client answers with a failure (the page's error bar). */
  failing?: string[];
  /** The browser page's chrome (the bots drawer button, "This device"); none draws the desktop's page. */
  web?: WebChrome;
}
export interface Page {
  host: HTMLElement;
  /** The page's markup, React's `:rN:` ids normalised. */
  markup(): string;
  /** What the page asked main, in order (`settings.set` …). */
  requests: { type: string; [key: string]: unknown }[];
  /** Draws the page again with a changed list, remembered tabs or shown bot. */
  update(next: Partial<PageOptions>): Promise<void>;
  close(): Promise<void>;
}

export async function drawPage(options: PageOptions = {}): Promise<Page> {
  if (options.whiteboard === null) localStorage.removeItem("botling.mainWhiteboard"); else localStorage.setItem("botling.mainWhiteboard", "0");
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
  let held: Required<PageOptions> = { bots: [siteBot], shown: SITE, plugins: fixtureView(), mainTabs: {}, whiteboard: "0", failing: [], web: undefined, ...options } as Required<PageOptions>;
  const viewOf = (): WorkspaceView => ({ ...defaults, ready: true, bots: held.bots, settings: settingsView({ mainTabs: held.mainTabs }), plugins: held.plugins,
    chat: { botId: held.shown, messages: [], running: null, live: [] } });
  let current = viewOf();
  const listeners = new Set<() => void>();
  const store = { getView: () => current, getChatView: () => current, subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; }, subscribeChat: () => () => {}, showBoard: () => {}, select: vi.fn(async () => {}) } as unknown as WorkspaceStore;
  const requests: Page["requests"] = [];
  const client = {
    request: vi.fn(async (command: any) => {
      requests.push(command);
      if (held.failing.includes(command.type)) throw new Error(`${command.type} failed`);
      if (command.type === "plugins.panel") return { title: command.name, source: "", settings: {} };
      if (command.type === "card.page") return { url: "botling-card://page/1" };
      if (command.type === "plugins.web") return { specs: [] };
      if (command.type === "storage.list") return { items: [] };
      return { result: null };
    }),
    onEvent: () => () => {},
  } as unknown as Client;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(App, { client, store, ...(held.web ? { web: held.web } : {}) })));
  return {
    host,
    markup: () => host.innerHTML.replace(/:r[0-9a-z]+:/g, ":rN:"),
    requests,
    update: async (next) => { held = { ...held, ...next } as Required<PageOptions>; current = viewOf(); await act(async () => { for (const l of listeners) l(); }); },
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = false;
    },
  };
}
