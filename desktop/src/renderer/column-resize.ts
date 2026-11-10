// The draggable dividers between the window's columns: the left column (bot list), the right panel and the in-app
// browser pane. Each column's width is a CSS variable on `.shell` (styles.css reads it), so a drag only touches that
// variable, never React state; the chat in the middle takes up the difference and keeps MIN_CHAT. The native views
// (the chat, the browser's page) follow their placeholders' boxes as usual (editor-surface.ts, BrowserPane.tsx).
// Handles never sit over those boxes (styles.css insets the page by HANDLE px), so the pointer always reaches them.

export type ColumnId = "rail" | "right" | "browser";

export interface ColumnSpec {
  id: ColumnId;
  /** localStorage key: a per-device convenience (the browser pane's key predates this file). */
  key: string;
  /** The CSS variable on `.shell` that styles.css sizes the column with. */
  cssVar: string;
  /** The column's element, inside `.shell`. */
  selector: string;
  min: number;
  max: number;
  /** The stylesheet's width with nothing saved (the variable's fallback in styles.css); null: the browser pane's 50%. */
  fallback: number | null;
  /** Which side of its divider the column lies on: a column on the left grows as the pointer moves right. */
  side: "left" | "right";
  label: string;
}

/** The chat between the columns never gets narrower than this while you drag. */
export const MIN_CHAT = 360;
/** The handle's grab width; the browser's page is inset by this much so the handle is never under it. */
export const HANDLE = 6;
/** Arrow keys on a focused divider. */
export const KEY_STEP = 16;

export const COLUMNS: Record<ColumnId, ColumnSpec> = {
  rail: { id: "rail", key: "botling.railWidth", cssVar: "--rail-w", selector: ".rail", min: 200, max: 420, fallback: 248, side: "left", label: "Resize the bot list" },
  right: { id: "right", key: "botling.rightPanelWidth", cssVar: "--right-w", selector: ".detail-panel", min: 240, max: 480, fallback: 272, side: "right", label: "Resize the right panel" },
  browser: { id: "browser", key: "botling.browserPaneWidth", cssVar: "--browser-w", selector: ".browser-pane", min: 320, max: 2000, fallback: null, side: "right", label: "Resize the browser" },
};

/** The width a column may take: its own limits, and at most `room` (what leaves the chat its minimum), never under min. */
export function clampWidth(spec: ColumnSpec, wanted: number, room = Infinity): number {
  const max = Math.min(spec.max, room);
  return Math.round(Math.max(spec.min, Math.min(wanted, max)));
}

/** The width for a pointer at `x`, for a drag that started at `startX` with the column `startWidth` wide. */
export function dragWidth(spec: ColumnSpec, startWidth: number, startX: number, x: number, room = Infinity): number {
  const delta = spec.side === "left" ? x - startX : startX - x;
  return clampWidth(spec, startWidth + delta, room);
}

/** How wide a column may grow from `width` while the chat, now `chat` wide, keeps MIN_CHAT. */
export function roomFor(width: number, chat: number): number {
  return width + Math.max(0, chat - MIN_CHAT);
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;
const local = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

/** The saved width, or null (nothing saved, unreadable, or out of range: the default then). */
export function loadWidth(spec: ColumnSpec, storage: Storage | null = local()): number | null {
  try {
    const text = storage?.getItem(spec.key);
    if (text == null || text === "") return null;
    const value = Number(text);
    return Number.isFinite(value) && value >= spec.min ? clampWidth(spec, value) : null;
  } catch { return null; }
}

/** Saves a width; null forgets it (the double click's reset). Storage refused: this session only. */
export function saveWidth(spec: ColumnSpec, width: number | null, storage: Storage | null = local()): void {
  try {
    if (width === null) storage?.removeItem(spec.key);
    else storage?.setItem(spec.key, String(clampWidth(spec, width)));
  } catch { /* per-device convenience only */ }
}

/** Sets (or, with null, clears back to the stylesheet's default) a column's width on the shell. */
export function applyWidth(shell: HTMLElement | null, spec: ColumnSpec, width: number | null): void {
  if (!shell) return;
  if (width === null) shell.style.removeProperty(spec.cssVar);
  else shell.style.setProperty(spec.cssVar, `${width}px`);
}

/** The column's and the chat's widths now, for a drag or a key press. */
export function measure(shell: HTMLElement | null, spec: ColumnSpec): { width: number; room: number } | null {
  const column = shell?.querySelector<HTMLElement>(`:scope > ${spec.selector}`);
  if (!shell || !column) return null;
  const width = column.getBoundingClientRect().width;
  const chat = shell.querySelector<HTMLElement>(":scope > .chat-pane")?.getBoundingClientRect().width ?? MIN_CHAT;
  return { width, room: roomFor(width, chat) };
}

export interface DragOptions {
  spec: ColumnSpec;
  shell: HTMLElement;
  /** Each new width while dragging (already applied to the shell). */
  onMove?(width: number): void;
  /** The drag ended: the last width, or null if the column never moved. */
  onEnd(width: number | null): void;
}

/**
 * Starts a drag from a pointerdown on a handle. The handle captures the pointer, so the moves keep coming while it
 * passes over the chat or the page (both native views; macOS keeps sending a drag to the view it started in). A move
 * with no button down (the release went elsewhere) ends it too.
 */
export function startColumnDrag(handle: HTMLElement, down: PointerEvent, options: DragOptions): () => void {
  const { spec, shell } = options;
  const start = measure(shell, spec);
  if (!start) return () => {};
  try { handle.setPointerCapture(down.pointerId); } catch { /* the pointer is gone already */ }
  const root = document.documentElement;
  root.classList.add("col-resizing");
  handle.classList.add("dragging");
  let last: number | null = null;
  let frame = 0;
  let pending: number | null = null;
  const flush = () => {
    frame = 0;
    if (pending === null) return;
    last = pending;
    pending = null;
    applyWidth(shell, spec, last);
    options.onMove?.(last);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== down.pointerId) return;
    if (event.buttons === 0 && event.pointerType === "mouse") { end(); return; }
    pending = dragWidth(spec, start.width, down.clientX, event.clientX, start.room);
    if (!frame) frame = requestAnimationFrame(flush);
  };
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    if (frame) cancelAnimationFrame(frame);
    flush();
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    handle.removeEventListener("lostpointercapture", end);
    window.removeEventListener("blur", end);
    try { if (handle.hasPointerCapture(down.pointerId)) handle.releasePointerCapture(down.pointerId); } catch { /* already released */ }
    root.classList.remove("col-resizing");
    handle.classList.remove("dragging");
    options.onEnd(last);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
  handle.addEventListener("lostpointercapture", end);
  window.addEventListener("blur", end);
  return end;
}
