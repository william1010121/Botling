// The in-app browser pane beside the chat (design v4: split view, floating toolbar, full screen with the bot's
// bubble). This page draws the tab strip, the toolbar and the site-tools sheet; the web page itself is a native
// view main lays where `.bp-page` is (browser-host.ts), so nothing of this page may sit over that box: the toolbar
// pushes the page down while it shows, the sheet narrows it, and the ⋯ menu is a native menu.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { hostOf, type BrowserBotState, type BrowserTabInfo } from "../browser-wire";
import type { BotView } from "../contract";
import { faceURL } from "./avatars";
import { browserStore, postBrowser, useBrowser } from "./browser-state";
import { askForToolText } from "../browser-site-tools";
import { SiteToolsSheet, countedTools } from "./SiteToolsSheet";
import { ToolbarVisibility } from "./browser-toolbar";
import { ShellOverlay, shellOverlayActive, subscribeShellOverlays } from "./ShellOverlay";

const WIDTH_KEY = "botling.browserPaneWidth";
const MIN_PANE = 320;
const MIN_CHAT = 360;

function savedWidth(): number | null {
  try { const value = Number(localStorage.getItem(WIDTH_KEY)); return Number.isFinite(value) && value >= MIN_PANE ? value : null; } catch { return null; }
}
function saveWidth(width: number) { try { localStorage.setItem(WIDTH_KEY, String(Math.round(width))); } catch { /* per-viewer convenience only */ } }

const svg = (size: number, children: ReactNode, fill = false) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={fill ? "currentColor" : "none"} stroke={fill ? "none" : "currentColor"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const ICONS = {
  back: () => svg(16, <path d="M10 3L5 8l5 5" />),
  lock: () => svg(12, <><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" /></>),
  puzzle: () => svg(16, <path d="M3 5h2.3a1.7 1.7 0 1 1 3.4 0H11v2.3a1.7 1.7 0 1 1 0 3.4V13H8.7a1.7 1.7 0 1 0-3.4 0H3v-2.3a1.7 1.7 0 1 0 0-3.4z" />),
  expand: () => svg(15, <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />),
  shrink: () => svg(15, <path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" />),
  more: () => svg(16, <><circle cx="3.5" cy="8" r="1.3" /><circle cx="8" cy="8" r="1.3" /><circle cx="12.5" cy="8" r="1.3" /></>, true),
  plus: () => svg(13, <path d="M8 3v10M3 8h10" />),
  close: () => svg(9, <path d="M4 4l8 8M12 4l-8 8" />),
};

function TabIcon({ tab }: { tab: BrowserTabInfo }) {
  if (tab.loading) return <span className="bp-tab-spinner" aria-hidden="true" />;
  if (tab.favicon) return <img className="bp-tab-icon" src={tab.favicon} alt="" />;
  const host = hostOf(tab.url);
  return <span className="bp-tab-icon bp-tab-letter" aria-hidden="true">{(host[0] ?? "?").toUpperCase()}</span>;
}

/** "Title · host" as the design's tabs read, or just the host while there is no title. */
export function tabLabel(tab: Pick<BrowserTabInfo, "title" | "url">): string {
  const host = hostOf(tab.url);
  const title = tab.title.trim();
  return title && title !== host && title !== tab.url ? `${title} · ${host}` : host;
}

/** The address as the toolbar shows it at rest: host strong, the rest faint, no scheme. */
function addressParts(url: string): { host: string; rest: string } {
  try { const u = new URL(url); return { host: u.host.replace(/^www\./, ""), rest: `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}` }; } catch { return { host: url, rest: "" }; }
}

export interface BrowserPaneProps {
  bot: BotView;
  state: BrowserBotState;
  full: boolean;
  look: "original" | "cute";
  /** Full screen: the mini chat beside the page is open. */
  miniChat: boolean;
  onMiniChat(open: boolean): void;
  /** Changes when something around the pane moves it (its bounds are measured again). */
  layoutKey: string;
  /** Sends a message to this bot's chat ("Ask Botling to make a tool for this site"). */
  onAskTool(text: string): Promise<void>;
}

export function BrowserPane({ bot, state, full, look, miniChat, onMiniChat, layoutKey, onAskTool }: BrowserPaneProps) {
  const botId = bot.id;
  const active = state.tabs.find((tab) => tab.id === state.active) ?? state.tabs[0] ?? null;
  const [toolbar, setToolbar] = useState(false);
  const visibility = useMemo(() => new ToolbarVisibility(setToolbar), []);
  useEffect(() => () => visibility.dispose(), [visibility]);
  const [sheet, setSheet] = useState(false);
  const { tools: catalog, runs } = useBrowser();
  const toolCount = countedTools(catalog, active?.url);
  const [draft, setDraft] = useState<string | null>(null);
  /** The URL bar opens a new tab (the + button) rather than going somewhere in this one. */
  const [newTab, setNewTab] = useState(false);
  const url = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLElement>(null);
  const [width, setWidth] = useState<number | null>(savedWidth);
  const [dragging, setDragging] = useState(false);

  useEffect(() => { visibility.sheet(sheet); }, [sheet, visibility]);
  useEffect(() => { setSheet(false); setDraft(null); setNewTab(false); }, [botId]);

  const focusUrl = (forNewTab = false) => {
    setNewTab(forNewTab);
    setDraft(forNewTab ? "" : active?.url ?? "");
    visibility.focusUrl(true);
    requestAnimationFrame(() => { url.current?.focus(); url.current?.select(); });
  };

  // Main's signals: the page's top edge, ⌘L and Esc pressed in the page, "Close browser" from the ⋯ menu.
  useEffect(() => browserStore.onSignal((signal) => {
    if (signal.botId !== botId) return;
    if (signal.type === "edge") visibility.edge();
    else if (signal.type === "key" && signal.key === "focusUrl") focusUrl();
    else if (signal.type === "key" && signal.key === "escape" && full) browserStore.setFull(false);
  }), [botId, visibility, full, active?.url]);

  // The same keys while this page has the focus.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mac = /Mac/i.test(navigator.platform);
      if ((mac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "l") { event.preventDefault(); focusUrl(); }
      else if (event.key === "Escape" && full && !shellOverlayActive() && document.activeElement !== url.current) { event.preventDefault(); browserStore.setFull(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full, active?.url]);

  // Where the page goes: `.bp-page`'s box, in this page's CSS px (main scales it by the zoom). Hidden while a sheet
  // or menu of the app covers the window, and while the divider is dragged (the pointer must stay on this page).
  useEffect(() => {
    const element = page.current;
    if (!element) return;
    let previous = "";
    const update = () => {
      const rect = element.getBoundingClientRect();
      const bounds = rect.width >= 2 && rect.height >= 2 && !shellOverlayActive()
        ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.floor(rect.width), height: Math.floor(rect.height) } : null;
      const key = JSON.stringify(bounds);
      if (key === previous) return;
      previous = key;
      postBrowser({ type: "layout", botId, bounds });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    // The pane can move without changing size (the right panel opening, the left column folding).
    for (const sibling of Array.from(element.closest(".shell")?.children ?? [])) observer.observe(sibling);
    const stop = subscribeShellOverlays(update);
    window.addEventListener("resize", update);
    update();
    const settle = setTimeout(update, 250);
    return () => { observer.disconnect(); stop(); window.removeEventListener("resize", update); clearTimeout(settle); postBrowser({ type: "layout", botId: null, bounds: null }); };
  }, [botId, layoutKey, full, miniChat]);

  // The divider between the chat and the pane.
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (full || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    const right = pane.current?.getBoundingClientRect().right ?? window.innerWidth;
    const left = (pane.current?.parentElement?.querySelector(".chat-pane") as HTMLElement | null)?.getBoundingClientRect().left ?? 0;
    const move = (next: PointerEvent) => {
      const wanted = right - next.clientX;
      setWidth(Math.max(MIN_PANE, Math.min(wanted, right - left - MIN_CHAT)));
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      setDragging(false);
      setWidth((current) => { if (current) saveWidth(current); return current; });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const submit = () => {
    const text = (draft ?? "").trim();
    if (!text) return;
    postBrowser(newTab || !active ? { type: "navigate", botId, input: text } : { type: "navigate", botId, tabId: active.id, input: text });
    setDraft(null);
    setNewTab(false);
    url.current?.blur();
  };

  const host = active ? hostOf(active.url) : "";
  const shown = addressParts(active?.url ?? "");
  const style: CSSProperties | undefined = !full && width ? { flexBasis: `${width}px` } : undefined;
  const statusKey = bot.working ? "working" : bot.approvals > 0 ? "waiting" : "idle";
  const unread = bot.unread;

  return (
    <section ref={pane} className={`browser-pane${full ? " full" : ""}`} aria-label="Browser" style={style}>
      {!full && <div className={`bp-divider${dragging ? " dragging" : ""}`} role="separator" aria-orientation="vertical" aria-label="Resize the browser" onPointerDown={startDrag} />}
      <ShellOverlay active={dragging} revealImmediately><></></ShellOverlay>
      <div className="bp-tabs drag" role="tablist" aria-label="Pages">
        {state.tabs.map((tab) => (
          <div key={tab.id} role="tab" aria-selected={tab.id === active?.id} className={`bp-tab${tab.id === active?.id ? " on" : ""}`} title={tab.url}
            tabIndex={0}
            onClick={() => postBrowser({ type: "select", botId, tabId: tab.id })}
            onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); postBrowser({ type: "select", botId, tabId: tab.id }); } }}
            onAuxClick={(event) => { if (event.button === 1) postBrowser({ type: "close", botId, tabId: tab.id }); }}>
            <TabIcon tab={tab} />
            <span className="bp-tab-label">{tab.crashed ? `${hostOf(tab.url)} (stopped)` : tabLabel(tab)}</span>
            {tab.reading && <span className="bp-tab-reading" title={`${bot.name} is reading this page`}><img src={faceURL(bot, look, { working: true })} alt="" />reading</span>}
            <button type="button" className="bp-tab-close" aria-label={`Close ${hostOf(tab.url)}`} onClick={(event) => { event.stopPropagation(); postBrowser({ type: "close", botId, tabId: tab.id }); }}>{ICONS.close()}</button>
          </div>
        ))}
        {state.tabs.length < 8 && <button type="button" className="bp-new" aria-label="New tab" title="New tab" onClick={() => focusUrl(true)}>{ICONS.plus()}</button>}
        {full && (
          <>
            <span className="bp-gap" />
            <button type="button" className="bp-exit" onClick={() => browserStore.setFull(false)} title="Exit full screen (Esc)">Exit full screen</button>
            <button type="button" className={`bp-bubble${miniChat ? " on" : ""}`} onClick={() => onMiniChat(!miniChat)}
              aria-label={`${bot.name}, ${statusKey}${unread ? `, ${unread} new message${unread === 1 ? "" : "s"}` : ""}. ${miniChat ? "Hide" : "Show"} the chat`} aria-pressed={miniChat}>
              <img src={faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 })} alt="" />
              <span className="bp-bubble-dot" data-status={statusKey} aria-hidden="true" />
              {unread > 0 && !miniChat && <span className="bp-bubble-badge" aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
            </button>
          </>
        )}
      </div>
      <div className="bp-top" onPointerEnter={() => visibility.enter()} onPointerLeave={() => visibility.leave()}>
        {toolbar ? (
          <div className="bp-toolbar-row" style={sheet ? { paddingRight: 0, marginRight: 272 } : undefined}>
            <div className="bp-toolbar" role="toolbar" aria-label="Browser toolbar">
              <button type="button" className="bp-round" aria-label="Back" title="Back (⌘[)" disabled={!active?.canGoBack} onClick={() => postBrowser({ type: "back", botId })}>{ICONS.back()}</button>
              <label className="bp-url">
                <span className="bp-url-lock">{ICONS.lock()}</span>
                <input ref={url} type="text" spellCheck={false} aria-label="Address"
                  placeholder={newTab ? "Type a web address or search" : ""}
                  value={draft ?? ""}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={() => { if (draft === null) setDraft(active?.url ?? ""); visibility.focusUrl(true); requestAnimationFrame(() => url.current?.select()); }}
                  onBlur={() => { setDraft(null); setNewTab(false); visibility.focusUrl(false); }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); submit(); }
                    if (event.key === "Escape") { event.preventDefault(); setDraft(null); url.current?.blur(); postBrowser({ type: "focus", botId }); }
                  }} />
                {draft === null && <span className="bp-url-shown" aria-hidden="true"><b>{shown.host}</b>{shown.rest}</span>}
              </label>
              <button type="button" className={`bp-round${sheet ? " on" : ""}`} aria-label={toolCount ? `Site tools, ${toolCount} for this site` : "Site tools"} title="Site tools" aria-pressed={sheet} onClick={() => setSheet(!sheet)}>
                {ICONS.puzzle()}
                {toolCount > 0 && <span className="bp-round-badge" aria-hidden="true">{toolCount > 9 ? "9+" : toolCount}</span>}
              </button>
              <button type="button" className={`bp-round${full ? " on" : ""}`} aria-label={full ? "Exit full screen (Esc)" : "Full screen"} title={full ? "Exit full screen (Esc)" : "Full screen"} aria-pressed={full}
                onClick={() => browserStore.setFull(!full)}>{full ? ICONS.shrink() : ICONS.expand()}</button>
              <button type="button" className="bp-round" aria-label="More" aria-haspopup="menu" title="More"
                onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); postBrowser({ type: "menu", botId, x: box.right - 240, y: box.bottom + 6 }); }}>{ICONS.more()}</button>
            </div>
          </div>
        ) : (
          <div className="bp-edge" title="Move the pointer here for the toolbar"><span className="bp-grip" aria-hidden="true" /></div>
        )}
      </div>
      <div className="bp-body">
        <div ref={page} className="bp-page">
          {/* Shown only while the page itself is hidden (a sheet of the app over the window, the divider dragged). */}
          <span className="bp-page-hint">{host}</span>
        </div>
        {sheet && (
          <SiteToolsSheet botId={botId} botName={bot.name} tab={active} catalog={catalog} runs={runs} onClose={() => setSheet(false)}
            onAsk={onAskTool} askText={(page) => askForToolText(page, catalog?.folder ?? "the app's browser-tools folder", catalog?.guide ?? "its README.md")} closeIcon={ICONS.close()} />
        )}
      </div>
    </section>
  );
}
