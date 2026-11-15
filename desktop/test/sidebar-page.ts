// A helper for the sidebar tests (M7-05a): the app page drawn in jsdom with a fixed set of bots, so the left column's markup
// (aside.rail, or aside.rail-strip when folded) can be read and compared with a golden recorded from the code before the
// rail moved into the sidebar plugin. Not a test file (vitest only runs *.test.ts).
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { vi } from "vitest";
import { settingsView } from "../src/core/settings";
import { App } from "../src/renderer/App";
import type { Client } from "../src/renderer/client";
import { WorkspaceStore, type WorkspaceView } from "../src/renderer/store";
import type { WebChrome } from "../src/renderer/app-shared";
import type { BotView, SubagentRowView } from "../src/contract";

/** A fixed clock: the worker lines under a row say "ran 12m", so the time must not move. */
export const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const MIN = 60_000;

export const ID = {
  main: "A0000000-0000-4000-8000-000000000001",
  alpha: "A0000000-0000-4000-8000-000000000002",
  beta: "A0000000-0000-4000-8000-000000000003",
  gamma: "A0000000-0000-4000-8000-000000000004",
  delta: "A0000000-0000-4000-8000-000000000005",
  sub: "A0000000-0000-4000-8000-000000000006",
} as const;

const row = (over: Partial<SubagentRowView> & { id: string }): SubagentRowView => ({
  title: over.id, status: "running", head: "claude", startedAt: NOW - 4 * MIN, endedAt: null, unsettledAt: null, settled: false, prompt: "do it", ...over,
});
const bot = (over: Partial<BotView> & { id: string; name: string }): BotView => ({
  role: "manager", avatar: "square", folder: "/w", phase: "awake", working: false, approvals: 0, unread: 0, subagents: 0,
  problem: null, heads: ["claude"], job: null, subagentRows: [], ...over,
} as BotView);

/** The main bot, four project bots (alpha has a sub bot and workers; gamma has unread lines; delta is quiet) and the sub bot. */
export function fixtureBots(): BotView[] {
  return [
    bot({ id: ID.main, name: "Main", role: "main", lastActivity: "2026-11-16T11:00:00Z" } as never),
    bot({ id: ID.alpha, name: "Alpha", lastActivity: "2026-11-16T11:50:00Z", working: true, subagents: 2, subagentRows: [
      row({ id: "Draw the list" }), row({ id: "Fix scrolling", status: "completed", startedAt: NOW - 17 * MIN, endedAt: NOW - 5 * MIN }),
      row({ id: "Pack the app", subBot: ID.sub as never, startedAt: NOW - 2 * MIN }),
    ] } as never),
    bot({ id: ID.beta, name: "Beta", lastActivity: "2026-11-16T10:00:00Z" } as never),
    bot({ id: ID.gamma, name: "Gamma", lastActivity: "2026-11-16T11:30:00Z", unread: 3 } as never),
    bot({ id: ID.delta, name: "Delta", lastActivity: "2026-11-16T09:00:00Z" } as never),
    bot({ id: ID.sub, name: "Packer", parent: ID.alpha as never, lastActivity: "2026-11-16T11:55:00Z", subagentRows: [row({ id: "notes" })] } as never),
  ];
}

export interface PageOptions {
  bots?: BotView[];
  /** What settings.json holds (the page reads it through `settingsView`). */
  settings?: Record<string, unknown>;
  web?: WebChrome;
  /** Which bot's chat is on screen (default: none). */
  shown?: string | null;
  /** The answer to each command, by its `type` (default: `{ result: null }`). */
  answer?: (command: { type: string; [key: string]: unknown }) => unknown;
}

export interface MountedPage {
  host: HTMLElement;
  /** Every command the page sent. */
  sent: { type: string; [key: string]: unknown }[];
  /** The left column's markup (the open column, or the folded strip). */
  rail(): string;
  /** The page's markup as a whole (React ids written `:rN:`). */
  html(): string;
  /** Draws the page again with other settings (what a `settings.set` answer, or a server change, would do). */
  settings(next: Record<string, unknown>): Promise<void>;
  unmount(): Promise<void>;
}

export const RAIL_SELECTOR = "aside.rail, aside.rail-strip";

/** The app page as app-dom-golden.test.ts draws it, with `fixtureBots()` and `settings`. Call after `vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW)`. */
export async function mountPage(options: PageOptions = {}): Promise<MountedPage> {
  localStorage.setItem("botling.mainWhiteboard", "0");
  const bots = options.bots ?? fixtureBots();
  const defaults = new WorkspaceStore(async () => { throw new Error("Unexpected snapshot"); }).getView();
  const build = (settings: Record<string, unknown>): WorkspaceView => ({
    ...defaults, ready: true, bots, settings: settingsView(settings), plugins: null,
    chat: options.shown ? { botId: options.shown, messages: [], running: null, live: [] } : defaults.chat,
  });
  let view = build(options.settings ?? {});
  const listeners = new Set<() => void>();
  const store = {
    getView: () => view, getChatView: () => view,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeChat: () => () => {}, showBoard: () => {}, select: async () => {},
  } as unknown as WorkspaceStore;
  const sent: MountedPage["sent"] = [];
  const client = {
    request: vi.fn(async (command: { type: string; [key: string]: unknown }) => {
      sent.push(command);
      const custom = options.answer?.(command);
      if (custom !== undefined) return custom;
      if (command.type === "plugins.panel") return { title: command.name, source: "", settings: {} };
      if (command.type === "card.page") return { url: "botling-card://page/1" };
      if (command.type === "plugins.web") return { specs: [] };
      return { result: null };
    }),
    onEvent: () => () => {},
  } as unknown as Client;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(createElement(App, { client, store, ...(options.web ? { web: options.web } : {}) })));
  const html = () => host.innerHTML.replace(/:r[0-9a-z]+:/g, ":rN:");
  return {
    host, sent,
    html,
    rail: () => (host.querySelector(RAIL_SELECTOR)?.outerHTML ?? "").replace(/:r[0-9a-z]+:/g, ":rN:"),
    settings: async (next) => { view = build(next); await act(async () => { for (const listener of [...listeners]) listener(); }); },
    unmount: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}
