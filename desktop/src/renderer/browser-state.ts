// The app page's side of the in-app browser (browser-wire.ts): each bot's tabs as main reports them, which bots
// show the pane, and whether it is full screen. Main owns the pages; this only mirrors them for drawing.
import { useSyncExternalStore } from "react";
import type { BrowserBotState, BrowserDown, BrowserToolCatalog, BrowserToolRun, BrowserUp } from "../browser-wire";

interface Bridge { post(message: unknown): void; subscribe(listener: (message: unknown) => void): () => void }
export const browserBridge = (): Bridge | undefined => typeof window === "undefined" ? undefined : (window as unknown as { botling?: { browser?: Bridge } }).botling?.browser;

export interface BrowserView {
  states: Readonly<Record<string, BrowserBotState>>;
  /** Bots whose pane is open (a link was opened for them, or the Browser button / ⌘⇧B opened it). */
  open: Readonly<Record<string, true>>;
  full: boolean;
  /** The site tools main has (null until it says). */
  tools: BrowserToolCatalog | null;
  /** The last run of each tool on each tab, by `tabId/toolId`. */
  runs: Readonly<Record<string, BrowserToolRun>>;
}
type Signal = Extract<BrowserDown, { type: "edge" | "key" | "closePane" }>;

let view: BrowserView = { states: {}, open: {}, full: false, tools: null, runs: {} };
export const runKey = (tabId: string, toolId: string) => `${tabId}/${toolId}`;
const listeners = new Set<() => void>();
const signals = new Set<(signal: Signal) => void>();
let started = false;

function set(next: Partial<BrowserView>) {
  view = { ...view, ...next };
  for (const listener of listeners) listener();
}

function receive(raw: unknown) {
  const message = raw as BrowserDown | null;
  if (!message || typeof message !== "object") return;
  if (message.type === "state") {
    const { type: _type, reveal, ...state } = message;
    const open = { ...view.open };
    if (!state.tabs.length) delete open[state.botId];
    else if (reveal) open[state.botId] = true;
    set({ states: { ...view.states, [state.botId]: state }, open, full: view.full && Object.keys(open).length > 0 });
    return;
  }
  if (message.type === "tools") {
    const { type: _type, ...tools } = message;
    set({ tools });
    return;
  }
  if (message.type === "toolRun") {
    const { type: _type, ...run } = message;
    set({ runs: { ...view.runs, [runKey(run.tabId, run.toolId)]: run } });
    return;
  }
  if (message.type === "key" && message.key === "toggle") { browserStore.closePane(message.botId); return; }
  if (message.type === "closePane") {
    const open = { ...view.open };
    delete open[message.botId];
    set({ open });
  }
  for (const listener of signals) listener(message as Signal);
}

function start() {
  if (started) return;
  const bridge = browserBridge();
  if (!bridge) return;
  started = true;
  bridge.subscribe(receive);
  bridge.post({ type: "hello" } satisfies BrowserUp);
}

export function postBrowser(message: BrowserUp): void { browserBridge()?.post(message); }

export const browserStore = {
  subscribe(listener: () => void) { start(); listeners.add(listener); return () => { listeners.delete(listener); }; },
  get: () => view,
  setFull(full: boolean) { if (view.full === full) return; set({ full }); postBrowser({ type: "mode", fullscreen: full }); },
  /** The Browser button and ⌘⇧B: show the pane for the bot (with no tabs yet it opens on an empty new tab), or hide it. */
  toggle(botId: string) { if (view.open[botId]) browserStore.closePane(botId); else set({ open: { ...view.open, [botId]: true } }); },
  closePane(botId: string) { const open = { ...view.open }; delete open[botId]; set({ open, full: false }); postBrowser({ type: "mode", fullscreen: false }); },
  onSignal(listener: (signal: Signal) => void) { signals.add(listener); return () => { signals.delete(listener); }; },
};

/** The browser as the app page draws it (always empty without the bridge: Botling Web, tests). */
export function useBrowser(): BrowserView {
  return useSyncExternalStore(browserStore.subscribe, browserStore.get);
}
