// The bot's floating chat over a page (design B; the state is floating-chat.ts): the Note tab, the browser's full
// screen and the report preview each draw one. Closed, it is the strip (BotBubble with `line`) in the corner the place
// remembers (dragged by its six dots to another corner), or, in the browser, in the tab row. Open, the bot's real chat
// floats over the page: this component moves the chat's placeholder (#chat-frame) to the panel's box, and the native
// chat view follows it (editor-surface.ts); the chat page draws the panel's header and corner grip (float-chrome.ts)
// and says what they do (floatAct, floatDrag). Docked, the place lays the chat out beside the page as it did before.
// Only one panel shows the chat at a time: the one opened last (the preview over a Note, say) until it closes.
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { BotView } from "../contract";
import { statusText } from "../contract/bot-status";
import { faceURL } from "./avatars";
import { BotBubble } from "./BotBubble";
import type { FloatChromeSpec, FrameMessage } from "./chat-frame/protocol";
import { CHAT_MOVED, postToChat } from "./editor-surface";
import {
  FLOAT_KEY, chatMode, dragPanel, nearestCorner, panelIn, readMemory, resizePanel, snapRect, toggleDocked, withCorner, withPanel,
  type Area, type FloatMemory, type FloatPlace, type Rect,
} from "./floating-chat";

// ---------------------------------------------------------------------------------------------
// What each place remembers, shared by every FloatingChat and the App (which lays out the docked chat).

const local = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
let memory: FloatMemory = (() => { try { return readMemory(local()?.getItem(FLOAT_KEY) ?? null); } catch { return readMemory(null); } })();
const listeners = new Set<() => void>();
export function updateFloatMemory(change: (now: FloatMemory) => FloatMemory): void {
  memory = change(memory);
  try { local()?.setItem(FLOAT_KEY, JSON.stringify(memory)); } catch { /* a per-device convenience */ }
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useFloatMemory(): FloatMemory {
  return useSyncExternalStore(subscribe, () => memory);
}

// ---------------------------------------------------------------------------------------------
// The open panels, last opened on top: the top one places the chat, has its header drawn and hears it.

/** A box in the shell page's viewport (CSS px). */
type ViewRect = { left: number; top: number; width: number; height: number };
interface Holder { place: FloatPlace; rect: ViewRect | null; chrome: FloatChromeSpec; handle(message: FrameMessage): void }
const holders: Holder[] = [];
let postedChrome = "";

function placeChat(rect: ViewRect | null, place?: FloatPlace): void {
  const element = document.getElementById("chat-frame");
  if (!element) return;
  if (rect) {
    element.classList.add("chat-floating");
    if (place) element.dataset.floatPlace = place;
    element.style.setProperty("--float-left", `${Math.round(rect.left)}px`);
    element.style.setProperty("--float-top", `${Math.round(rect.top)}px`);
    element.style.setProperty("--float-width", `${Math.round(rect.width)}px`);
    element.style.setProperty("--float-height", `${Math.round(rect.height)}px`);
  } else {
    element.classList.remove("chat-floating");
    delete element.dataset.floatPlace;
    for (const name of ["--float-left", "--float-top", "--float-width", "--float-height"]) element.style.removeProperty(name);
  }
  window.dispatchEvent(new Event(CHAT_MOVED));
}

function refresh(): void {
  const top = holders[holders.length - 1] ?? null;
  placeChat(top?.rect ?? null, top?.place);
  const chrome = JSON.stringify(top?.chrome ?? null);
  if (chrome !== postedChrome) { postedChrome = chrome; postToChat({ botling: "floatChrome", chrome: top?.chrome ?? null }); }
}

/** The chat page's floatAct / floatDrag (App.tsx passes them here): the top panel's. True when it was one. */
export function floatChatMessage(message: FrameMessage): boolean {
  if (message.botling !== "floatAct" && message.botling !== "floatDrag") return false;
  holders[holders.length - 1]?.handle(message);
  return true;
}

/** The chat page came up again (a reload): it is told its header again. */
export function resendFloatChrome(): void {
  postedChrome = "";
  refresh();
}

// ---------------------------------------------------------------------------------------------

const toView = (rect: Rect, box: DOMRect): ViewRect => ({ left: box.left + rect.x, top: box.top + rect.y, width: rect.w, height: rect.h });

export interface FloatingChatProps {
  place: FloatPlace;
  bot: BotView;
  look: "original" | "cute";
  /** The chat is open (floating or docked beside); closed, the strip shows. */
  open: boolean;
  onOpen(open: boolean): void;
  /** The bot's newest line, for the strip. */
  line: string;
  /** The page the panel floats over: its box is the panel's room. */
  area(): HTMLElement | null;
  /** The strip sits in a row of controls (the browser's tab row) rather than in a corner of the page, and stays as
   *  the switch while the chat is open. */
  inline?: boolean;
  className?: string;
}

export function FloatingChat({ place, bot, look, open, onOpen, line, area, inline, className }: FloatingChatProps) {
  const mine = useFloatMemory()[place];
  const mode = chatMode(open, mine);

  // The area's box, followed while the panel is open (the window or the columns around the page change).
  const [box, setBox] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (mode === "collapsed") return;
    const element = area();
    if (!element) return;
    const measure = () => {
      const next = element.getBoundingClientRect();
      setBox((now) => now && now.x === next.x && now.y === next.y && now.width === next.width && now.height === next.height ? now : next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    // The page can move without changing size (a column beside it folding).
    for (const child of Array.from(element.closest(".shell")?.children ?? [])) observer?.observe(child);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [mode, area]);
  const room: Area | null = box && box.width > 0 && box.height > 0 ? { width: box.width, height: box.height } : null;
  const rect = mode === "floating" && room ? panelIn(mine, room) : null;

  // A drag under way: where it started, and where the panel is now (drawn without going through React).
  const drag = useRef<{ kind: "move" | "resize"; start: Rect; now: Rect } | null>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const holder = useRef<Holder | null>(null);

  const status = statusText(bot);
  const chrome: FloatChromeSpec = {
    name: bot.name, status, tone: bot.approvals > 0 ? "waiting" : bot.working ? "working" : "idle",
    face: faceURL(bot, look, { asleep: bot.phase === "asleep" && !bot.working, working: bot.working, waiting: bot.approvals > 0 }),
    docked: mode === "docked",
  };

  const handle = useCallback((message: FrameMessage) => {
    if (message.botling === "floatAct") {
      if (message.act === "collapse") onOpen(false);
      else if (message.act === "dock" || message.act === "float") updateFloatMemory((now) => (now[place].docked === (message.act === "dock") ? now : toggleDocked(now, place)));
      else if (message.act === "reset") updateFloatMemory((now) => withPanel(now, place, null));
      return;
    }
    if (message.botling !== "floatDrag" || !room) return;
    const current = holder.current;
    if (message.phase === "start") {
      const start = panelIn(memory[place], room);
      drag.current = { kind: message.kind, start, now: start };
      return;
    }
    const going = drag.current;
    if (!going || going.kind !== message.kind || !box) return;
    const dx = Number.isFinite(message.dx) ? message.dx : 0, dy = Number.isFinite(message.dy) ? message.dy : 0;
    going.now = going.kind === "move" ? dragPanel(going.start, dx, dy, room) : resizePanel(going.start, dx, dy, room);
    if (message.phase === "end") {
      drag.current = null;
      going.now = going.kind === "move" ? snapRect(going.now, room) : going.now;
      const final = going.now;
      updateFloatMemory((now) => withPanel(now, place, final));
    }
    // Drawn here, not by React: the props may already hold the same box (dropped where it started).
    const view = toView(going.now, box);
    if (current) { current.rect = view; placeChat(view, place); }
    const element = backdrop.current;
    if (element) Object.assign(element.style, { left: `${view.left}px`, top: `${view.top}px`, width: `${view.width}px`, height: `${view.height}px` });
  }, [onOpen, place, room?.width, room?.height, box]);

  // Open: this panel goes on top of the others (and comes off when it closes or goes away). A layout effect, before
  // the one below that gives it its box and header in the same commit.
  useLayoutEffect(() => {
    if (mode === "collapsed") return;
    const mineHolder: Holder = { place, rect: null, chrome, handle };
    holder.current = mineHolder;
    holders.push(mineHolder);
    return () => {
      const index = holders.indexOf(mineHolder);
      if (index >= 0) holders.splice(index, 1);
      if (holder.current === mineHolder) holder.current = null;
      drag.current = null;
      refresh();
    };
    // Registered once per opening; what it shows is kept up to date below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode === "collapsed"]);
  const viewRect = rect && box ? toView(rect, box) : null;
  const chromeKey = JSON.stringify(chrome);
  useLayoutEffect(() => {
    const current = holder.current;
    if (!current) return;
    current.chrome = chrome;
    current.handle = handle;
    if (!drag.current) current.rect = viewRect;
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chromeKey, handle, viewRect?.left, viewRect?.top, viewRect?.width, viewRect?.height, mode]);

  // The strip dragged to another corner (its six dots).
  const strip = useRef<HTMLDivElement>(null);
  const grab = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const element = strip.current, page = area();
    if (event.button !== 0 || !element || !page) return;
    event.preventDefault();
    const startX = event.clientX, startY = event.clientY;
    element.classList.add("dragging");
    const move = (moved: PointerEvent) => { element.style.transform = `translate(${moved.clientX - startX}px, ${moved.clientY - startY}px)`; };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      const at = element.getBoundingClientRect(), pageBox = page.getBoundingClientRect();
      element.style.transform = "";
      element.classList.remove("dragging");
      const corner = nearestCorner({ x: at.left + at.width / 2 - pageBox.left, y: at.top + at.height / 2 - pageBox.top }, { width: pageBox.width, height: pageBox.height });
      updateFloatMemory((now) => withCorner(now, place, corner));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [area, place]);

  const toggle = () => onOpen(!open);
  return (
    <>
      {inline ? <BotBubble bot={bot} look={look} on={open} onToggle={toggle} line={line} className={`inline${className ? ` ${className}` : ""}`} />
        : mode === "collapsed" && (
          <div ref={strip} className={`float-strip-holder${className ? ` ${className}` : ""}`} data-corner={mine.corner} data-place={place}>
            <BotBubble bot={bot} look={look} on={false} onToggle={toggle} line={line} grab={grab} />
          </div>
        )}
      {viewRect && createPortal(<div ref={backdrop} className="float-backdrop" data-place={place} aria-hidden="true"
        style={{ left: viewRect.left, top: viewRect.top, width: viewRect.width, height: viewRect.height }} />, document.body)}
    </>
  );
}
