// The bot's floating chat (design B): over the Note, the browser's full screen and the report preview the bot's real
// chat no longer has to sit beside the page. Closed, it is a thin strip in a corner (the bot's face, its newest line,
// the unread count); open, the chat floats in a panel you drag by its header, resize from its bottom right corner and
// that snaps into a corner dropped near one; Esc folds it back to the strip. A button in the header docks it beside
// the page as before (and back). Each place keeps its own panel, strip corner and dock choice (per device, like the
// columns' widths). This file is the state; FloatingChat.tsx draws the strip and moves the chat's placeholder, and the
// chat page draws the header and the corner grip itself (chat-frame/float-chrome.ts), since the chat is a native view
// and nothing of this page can sit over it.

export type FloatPlace = "note" | "browser" | "preview";
export const FLOAT_PLACES: readonly FloatPlace[] = ["note", "browser", "preview"];
export type Corner = "tl" | "tr" | "bl" | "br";
const CORNERS: readonly Corner[] = ["tl", "tr", "bl", "br"];
/** A box inside the place's area (the Note, the page, the preview), in its CSS px from its top left. */
export interface Rect { x: number; y: number; w: number; h: number }
export interface Area { width: number; height: number }
export interface PlaceMemory {
  /** Where the panel was left (null: never moved, the default at the bottom right). */
  panel: Rect | null;
  /** The corner the strip sits in. */
  corner: Corner;
  /** Docked beside the page instead of floating. */
  docked: boolean;
}
export type FloatMemory = Record<FloatPlace, PlaceMemory>;
export type ChatMode = "collapsed" | "floating" | "docked";

/** The gap between the panel or strip and the area's edges once snapped. */
export const MARGIN = 16;
/** How near a corner (both edges, px) a drop snaps into it. */
export const SNAP = 28;
export const DEFAULT_W = 380;
export const DEFAULT_H = 520;
export const MIN_W = 300;
export const MIN_H = 280;
/** localStorage key: a per-device convenience, as the columns' widths are (column-resize.ts). */
export const FLOAT_KEY = "botling.floatingChat";

export function defaultMemory(): FloatMemory {
  return { note: { panel: null, corner: "br", docked: false }, browser: { panel: null, corner: "br", docked: false }, preview: { panel: null, corner: "br", docked: false } };
}

/** What shows: the strip while closed; open, the floating panel or the chat docked beside. */
export function chatMode(open: boolean, memory: PlaceMemory): ChatMode {
  return !open ? "collapsed" : memory.docked ? "docked" : "floating";
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/** The rect moved (and shrunk only if it must) so it fits the area. */
export function clampRect(rect: Rect, area: Area): Rect {
  const w = Math.round(clamp(rect.w, Math.min(MIN_W, area.width), area.width));
  const h = Math.round(clamp(rect.h, Math.min(MIN_H, area.height), area.height));
  return { x: Math.round(clamp(rect.x, 0, area.width - w)), y: Math.round(clamp(rect.y, 0, area.height - h)), w, h };
}

/** Where the panel opens: where it was left, else the bottom right corner at the default size; always inside. */
export function panelIn(memory: PlaceMemory, area: Area): Rect {
  if (memory.panel) return clampRect(memory.panel, area);
  const w = Math.min(DEFAULT_W, Math.max(0, area.width - 2 * MARGIN)), h = Math.min(DEFAULT_H, Math.max(0, area.height - 2 * MARGIN));
  return clampRect({ x: area.width - MARGIN - w, y: area.height - MARGIN - h, w, h }, area);
}

/** The header dragged by (dx, dy) from where the drag started. */
export function dragPanel(start: Rect, dx: number, dy: number, area: Area): Rect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, area);
}

/** The bottom right grip dragged by (dx, dy): the top left corner stays. */
export function resizePanel(start: Rect, dx: number, dy: number, area: Area): Rect {
  const w = Math.round(clamp(start.w + dx, MIN_W, area.width - start.x));
  const h = Math.round(clamp(start.h + dy, MIN_H, area.height - start.y));
  return { x: start.x, y: start.y, w, h };
}

/** A panel dropped within SNAP of a corner (both edges) goes into it, MARGIN from the edges; elsewhere it stays. */
export function snapRect(rect: Rect, area: Area): Rect {
  const left = rect.x, top = rect.y, right = area.width - (rect.x + rect.w), bottom = area.height - (rect.y + rect.h);
  const nearX = left <= SNAP ? "l" : right <= SNAP ? "r" : null, nearY = top <= SNAP ? "t" : bottom <= SNAP ? "b" : null;
  if (!nearX || !nearY) return rect;
  return clampRect({ ...rect, x: nearX === "l" ? MARGIN : area.width - MARGIN - rect.w, y: nearY === "t" ? MARGIN : area.height - MARGIN - rect.h }, area);
}

/** The corner a strip dropped at `point` (its centre) goes to. */
export function nearestCorner(point: { x: number; y: number }, area: Area): Corner {
  return `${point.y < area.height / 2 ? "t" : "b"}${point.x < area.width / 2 ? "l" : "r"}` as Corner;
}

/** The strip's top left in its corner. */
export function stripBox(corner: Corner, size: { w: number; h: number }, area: Area): { x: number; y: number } {
  return { x: corner.endsWith("l") ? MARGIN : Math.max(0, area.width - MARGIN - size.w), y: corner.startsWith("t") ? MARGIN : Math.max(0, area.height - MARGIN - size.h) };
}

export function withPanel(memory: FloatMemory, place: FloatPlace, panel: Rect | null): FloatMemory {
  return { ...memory, [place]: { ...memory[place], panel } };
}
export function withCorner(memory: FloatMemory, place: FloatPlace, corner: Corner): FloatMemory {
  return { ...memory, [place]: { ...memory[place], corner } };
}
/** The header's dock button: beside the page, or floating again. */
export function toggleDocked(memory: FloatMemory, place: FloatPlace): FloatMemory {
  return { ...memory, [place]: { ...memory[place], docked: !memory[place].docked } };
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function readRect(value: unknown): Rect | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return finite(v.x) && finite(v.y) && finite(v.w) && finite(v.h) && v.w > 0 && v.h > 0 ? { x: v.x, y: v.y, w: v.w, h: v.h } : null;
}
function readPlace(value: unknown): PlaceMemory | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.panel !== null && !readRect(v.panel)) return null;
  if (!CORNERS.includes(v.corner as Corner) || typeof v.docked !== "boolean") return null;
  return { panel: v.panel === null ? null : readRect(v.panel), corner: v.corner as Corner, docked: v.docked };
}

/** What was saved (FLOAT_KEY); a place that cannot be read gets its defaults. */
export function readMemory(raw: string | null): FloatMemory {
  const memory = defaultMemory();
  if (!raw) return memory;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return memory; }
  if (!parsed || typeof parsed !== "object") return memory;
  for (const place of FLOAT_PLACES) {
    const read = readPlace((parsed as Record<string, unknown>)[place]);
    if (read) memory[place] = read;
  }
  return memory;
}

/** Whether an Escape in the chat folds the panel (or the docked chat) back to the strip: not while a reply is written
 *  (Esc twice stops it, escape-stop.ts), nor when something open on the page used it, nor with a modifier. */
export function escCollapses(event: { key: string; defaultPrevented?: boolean; isComposing?: boolean; repeat?: boolean; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
  page: { shown: boolean; running: boolean; overlay: boolean }): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat) return false;
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;
  return page.shown && !page.running && !page.overlay;
}

const LINE_MAX = 120;
/** The strip's line: the bot's newest message, flattened to one line, Markdown's marks left out. */
export function lastLine(messages: readonly { role: string; text: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== "bot") continue;
    const text = message.text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`#>~]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    return text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text;
  }
  return "";
}
