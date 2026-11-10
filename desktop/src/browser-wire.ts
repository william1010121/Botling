// The in-app browser pane's wire (2026-11-10, phase 1): what the app page and main say about it on one IPC
// channel, apart from the contract's core commands. Main owns the pages (one WebContentsView per tab,
// browser-host.ts); the app page draws the tab strip and toolbar and says where the page goes (its bounds).
// Main checks every message (parseBrowserUp) and only takes them from the app page's own main frame.

export const BROWSER_CHANNEL = "botling:browser";
/** At most this many tabs per bot. */
export const BROWSER_MAX_TABS = 8;

export interface BrowserRect { x: number; y: number; width: number; height: number }
export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  /** A data: URL of the site's icon (main fetches it; the app page's CSP takes no remote pictures). */
  favicon: string | null;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Its page crashed; selecting it loads it again. */
  crashed?: boolean;
}
export interface BrowserBotState { botId: string; tabs: BrowserTabInfo[]; active: string | null }

/** What the More (⋯) menu offers; main shows it as a native menu (an HTML menu would sit under the page). */
export type BrowserMenuPick = "forward" | "reload" | "copy" | "external" | "window" | "close";

/** App page → main. */
export type BrowserUp =
  /** Where the shown bot's active page goes, in the app page's CSS px; null hides every page. */
  | { type: "layout"; botId: string | null; bounds: BrowserRect | null }
  | { type: "open"; botId: string; url: string; newTab?: boolean }
  | { type: "select"; botId: string; tabId: string }
  | { type: "close"; botId: string; tabId: string }
  /** The URL bar's text (a URL, a host, or words to search for); no tabId opens a new tab. */
  | { type: "navigate"; botId: string; tabId?: string; input: string }
  | { type: "back" | "forward" | "reload" | "stop" | "copy" | "external" | "window" | "focus"; botId: string }
  /** The ⋯ button was pressed: its bottom-left corner, in CSS px. */
  | { type: "menu"; botId: string; x: number; y: number }
  /** Whether the pane is full screen (Esc in the page then leaves it). */
  | { type: "mode"; fullscreen: boolean }
  /** Every bot's tabs again (a reloaded app page). */
  | { type: "hello" };

/** Main → app page. */
export type BrowserDown =
  /** A bot's tabs changed; `reveal`: a link was opened for it, show the pane. */
  | ({ type: "state"; reveal?: boolean } & BrowserBotState)
  /** The pointer reached the top edge of the page (the floating toolbar shows). */
  | { type: "edge"; botId: string }
  /** A key pressed in the page that the app handles: ⌘L (the URL bar), Esc (leave full screen). */
  | { type: "key"; botId: string; key: "focusUrl" | "escape" }
  /** The More menu's "Close browser". */
  | { type: "closePane"; botId: string };

const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const TAB = /^t[0-9]{1,12}$/;
const str = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max;
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 100_000;

function rect(value: unknown): BrowserRect | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 4 || !["x", "y", "width", "height"].every((key) => num(r[key]))) return undefined;
  return { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
}

/** A message from the app page, checked; null: refused. */
export function parseBrowserUp(raw: unknown): BrowserUp | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const bot = () => typeof m.botId === "string" && ID.test(m.botId);
  switch (m.type) {
    case "hello": return { type: "hello" };
    case "mode": return typeof m.fullscreen === "boolean" ? { type: "mode", fullscreen: m.fullscreen } : null;
    case "layout": {
      const bounds = rect(m.bounds);
      if (bounds === undefined || !(m.botId === null || bot())) return null;
      return { type: "layout", botId: m.botId as string | null, bounds };
    }
    case "open":
      if (!bot() || !str(m.url, 8_000) || (m.newTab !== undefined && typeof m.newTab !== "boolean")) return null;
      return { type: "open", botId: m.botId as string, url: m.url as string, ...(m.newTab ? { newTab: true } : {}) };
    case "select": case "close":
      if (!bot() || typeof m.tabId !== "string" || !TAB.test(m.tabId)) return null;
      return { type: m.type, botId: m.botId as string, tabId: m.tabId };
    case "navigate":
      if (!bot() || !str(m.input, 8_000) || (m.tabId !== undefined && (typeof m.tabId !== "string" || !TAB.test(m.tabId)))) return null;
      return { type: "navigate", botId: m.botId as string, input: m.input as string, ...(m.tabId ? { tabId: m.tabId as string } : {}) };
    case "back": case "forward": case "reload": case "stop": case "copy": case "external": case "window": case "focus":
      return bot() ? { type: m.type, botId: m.botId as string } : null;
    case "menu":
      return bot() && num(m.x) && num(m.y) ? { type: "menu", botId: m.botId as string, x: m.x as number, y: m.y as number } : null;
    default: return null;
  }
}

/** Only web pages open in the pane. */
export function isWebUrl(url: string): boolean {
  try { const u = new URL(url); return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname; } catch { return false; }
}

/**
 * What the URL bar's text opens: a web URL as it is, a host (example.com, localhost:3000) over https (http for
 * localhost), anything else as a web search. Another scheme (file:, javascript:, …) opens nothing (null).
 */
export function urlFromInput(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return isWebUrl(text) ? new URL(text).href : null;
  const hostLike = /^(localhost|\d{1,3}(\.\d{1,3}){3}|[\w-]+(\.[\w-]+)+)(:\d{1,5})?([/?#]\S*)?$/i;
  if (!/\s/.test(text) && hostLike.test(text)) {
    const local = /^(localhost|127\.|\d{1,3}(\.\d{1,3}){3})/i.test(text);
    const url = `${local ? "http" : "https"}://${text}`;
    return isWebUrl(url) ? new URL(url).href : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/\s/.test(text)) return null;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/**
 * A chat link clicked with ⌘ (Ctrl off the Mac) opens in the default browser; a plain click opens it in the pane.
 * Read in the chat page's bridge (chat-frame/shim.ts) from the click that sent the link.
 */
export function clickOpensOutside(event: { metaKey?: boolean; ctrlKey?: boolean } | null | undefined, platform: string): boolean {
  if (!event) return false;
  return platform === "darwin" ? event.metaKey === true : event.ctrlKey === true;
}

/** The host a tab shows (no www.). */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
