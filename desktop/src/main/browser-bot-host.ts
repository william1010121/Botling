// Main's side of the bot tools on the in-app browser (phase 2, browser-bot.ts): the core asks (the `browser` app op,
// core-client.ts) and this answers from the window's tabs (browser-tabs.ts), each tab's captured traffic and an
// extraction run in the page. Kept free of Electron for the tests; browser-host.ts gives it real pages.
//
// A bot reads only its own pane's tabs and may open a page there; nothing here clicks, types or submits. While a bot
// reads a tab, the tab shows it (`reading`, a small bot face in the tab strip) for a moment.
import { BODY_KEEP, filterRequests, forBot, type BrowserBotRequest, type ExtractWhat, type NetCapture } from "../browser-bot";
import type { BrowserTabs } from "./browser-tabs";

/** One app window's browser, as the bot tools use it. */
export interface BotBrowserWindow {
  tabs: BrowserTabs;
  /** Opens `url` for the bot (a tab; the pane shows); returns the tab's id. */
  open(botId: string, url: string): string;
  capture(tabId: string): NetCapture | null;
  /** A body the page still holds (Network.getResponseBody); null when it is gone. */
  fetchBody(tabId: string, requestId: string): Promise<{ body: string; base64: boolean } | null>;
  /** Runs extraction code in the tab's isolated world (no navigation meanwhile); its JSON-able result. */
  run(tabId: string, code: string): Promise<unknown>;
}

export interface BrowserBotAnswer { ok: boolean; data?: unknown; error?: string }

/** How long the tab's "reading" mark stays after a read (so a quick read is still seen). */
export const READING_LINGER_MS = 1_500;
/** Bodies fetched late (not kept when they arrived) per call, at most. */
const LATE_BODIES = 25;
/** About this much answer goes back to the core (bodies beyond it are left out). */
const ANSWER_MAX = 4_000_000;

const NO_TABS = "This bot's browser pane has no tabs open. Open a page with app_browser_open, or ask the user to open one.";

export class BrowserBotHost {
  private readonly lingering = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly windows: () => BotBrowserWindow[], private readonly linger = READING_LINGER_MS) {}

  async answer(request: BrowserBotRequest): Promise<BrowserBotAnswer> {
    try { return { ok: true, data: await this.handle(request) }; }
    catch (error) { return { ok: false, error: String((error as Error)?.message ?? error).slice(0, 500) }; }
  }

  private async handle(request: BrowserBotRequest): Promise<unknown> {
    const { botId } = request;
    const windows = this.windows();
    if (!windows.length) throw new Error("No app window is open.");
    const owning = windows.find((each) => each.tabs.state(botId).tabs.length > 0) ?? null;
    switch (request.op) {
      case "tabs": {
        if (!owning) return { tabs: [], note: NO_TABS };
        const state = owning.tabs.state(botId);
        return {
          tabs: state.tabs.map((tab) => ({
            tab_id: tab.id, url: tab.url, title: tab.title, loading: tab.loading, active: tab.id === state.active,
            captured_requests: owning.capture(tab.id)?.size ?? 0, ...(tab.crashed ? { crashed: true } : {}),
          })),
        };
      }
      case "open": {
        const window = owning ?? windows[0]!;
        const tabId = window.open(botId, request.url);
        return { tab_id: tabId, url: request.url, note: "Opened in the user's browser pane; it loads in the background. Its traffic is captured from now on." };
      }
      case "requests": {
        const { window, tabId } = this.target(owning, botId, request.tabId);
        return this.reading(window, botId, tabId, async () => {
          const capture = window.capture(tabId);
          const all = capture?.all() ?? [];
          const picked = filterRequests(all, request.filter);
          if (request.bodies && capture) {
            let late = 0;
            for (const entry of picked) {
              if (entry.body !== undefined || !entry.finished || entry.failed || late >= LATE_BODIES) continue;
              late++;
              const got = await window.fetchBody(tabId, entry.id).catch(() => null);
              if (got) capture.setBody(entry.id, got.body, got.base64);
            }
          }
          let budget = ANSWER_MAX;
          const requests = picked.map((entry) => {
            const out = forBot(capture?.get(entry.id) ?? entry, { bodies: request.bodies, unmasked: request.unmasked, bodyMax: Math.min(BODY_KEEP, Math.max(0, budget)) });
            budget -= JSON.stringify(out).length;
            return out;
          });
          const tab = window.tabs.tab(botId, tabId)!;
          return {
            tab_id: tabId, url: tab.url, captured: all.length, matched: requests.length, requests,
            ...(request.unmasked ? {} : { masked: "Cookie, Set-Cookie and Authorization headers are masked." }),
          };
        });
      }
      case "extract": {
        const { window, tabId } = this.target(owning, botId, request.tabId);
        return this.reading(window, botId, tabId, async () => {
          const tab = window.tabs.tab(botId, tabId)!;
          const result = await window.run(tabId, extractionCode(request.what, request.selector, request.script));
          return { tab_id: tabId, url: tab.url, title: tab.title, what: request.what, data: result };
        });
      }
    }
  }

  private target(window: BotBrowserWindow | null, botId: string, tabId?: string): { window: BotBrowserWindow; tabId: string } {
    if (!window) throw new Error(NO_TABS);
    const id = tabId ?? window.tabs.state(botId).active;
    if (!id || !window.tabs.tab(botId, id)) throw new Error(`No tab ${tabId ?? ""} in this bot's browser pane (see app_browser_tabs).`.replace("  ", " "));
    return { window, tabId: id };
  }

  /** Marks the tab as read by its bot while `work` runs, and a moment after. */
  private async reading<T>(window: BotBrowserWindow, botId: string, tabId: string, work: () => Promise<T>): Promise<T> {
    const key = `${botId}\n${tabId}`;
    const pending = this.lingering.get(key);
    if (pending) clearTimeout(pending);
    window.tabs.update(botId, tabId, { reading: true });
    try { return await work(); }
    finally {
      const timer = setTimeout(() => { this.lingering.delete(key); window.tabs.update(botId, tabId, { reading: false }); }, this.linger);
      (timer as { unref?: () => void }).unref?.();
      this.lingering.set(key, timer);
    }
  }
}

/** The page-side guard: in the isolated world, what could change the page or send something is turned off. */
const GUARD = `
const refuse = () => { throw new Error("Extraction is read-only: clicking, submitting, typing and network calls are off."); };
const off = (proto, names) => { for (const name of names) { try { Object.defineProperty(proto, name, { value: refuse, configurable: true, writable: true }); } catch {} } };
off(HTMLElement.prototype, ["click", "focus", "blur"]);
off(HTMLFormElement.prototype, ["submit", "requestSubmit", "reset"]);
off(EventTarget.prototype, ["dispatchEvent"]);
off(HTMLInputElement.prototype, ["select", "setRangeText"]);
try { window.fetch = refuse; window.open = refuse; window.XMLHttpRequest = function () { refuse(); }; window.WebSocket = function () { refuse(); }; window.EventSource = function () { refuse(); }; navigator.sendBeacon = refuse; } catch {}
`;

const TEXT_MAX = 400_000;
const ROWS_MAX = 5_000;

/** The code an extraction runs in the page: one of the built-in readers, or the bot's own script as an async function body. */
export function extractionCode(what: ExtractWhat, selector?: string, script?: string): string {
  const reader = (() => {
    switch (what) {
      case "tables": return `
const clean = (cell) => (cell.innerText ?? cell.textContent ?? "").replace(/\\s+/g, " ").trim();
return [...document.querySelectorAll("table")].slice(0, 50).map((table, index) => {
  const rows = [...table.rows].map((row) => [...row.cells].map(clean));
  const head = table.tHead && table.tHead.rows.length ? rows.slice(0, table.tHead.rows.length) : (table.rows[0] && [...table.rows[0].cells].every((c) => c.tagName === "TH") ? rows.slice(0, 1) : []);
  const body = rows.slice(head.length);
  return { index, caption: table.caption ? clean(table.caption) : "", headers: head[head.length - 1] ?? [], rows: body.slice(0, ${ROWS_MAX}), ...(body.length > ${ROWS_MAX} ? { truncated: true } : {}) };
});`;
      case "text": return `return (document.body?.innerText ?? "").slice(0, ${TEXT_MAX});`;
      case "links": return `return [...document.querySelectorAll("a[href]")].slice(0, ${ROWS_MAX}).map((a) => ({ text: (a.innerText ?? "").replace(/\\s+/g, " ").trim().slice(0, 300), href: a.href }));`;
      case "selector": return `
return [...document.querySelectorAll(${JSON.stringify(selector ?? "")})].slice(0, ${ROWS_MAX}).map((el) => ({ text: (el.innerText ?? el.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 2000), ...(el.href ? { href: el.href } : {}), ...(el.src ? { src: el.src } : {}) }));`;
      case "script": return script ?? "return null;";
    }
  })();
  // JSON-safe on the page's side: what cannot be cloned (DOM nodes, functions) never reaches main.
  return `(async () => {${GUARD}
const result = await (async () => {${reader}
})();
const text = JSON.stringify(result === undefined ? null : result);
if (text && text.length > 2000000) throw new Error("The extraction result is over 2 MB; return less (fewer rows or fields).");
return text === undefined ? null : JSON.parse(text);
})()`;
}
