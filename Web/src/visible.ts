import { post } from "./bridge";

/**
 * The one rule for cards that refresh by themselves (a chat card's `Refresh: every 2s` or
 * `<show refresh="2s">`, a pin's interval, a floating pin): they run again only while the user
 * can see them. That is: the app's window is shown (Swift tells the page with
 * `ccb.setWindowVisible`, from the window's occlusion: not minimized, not hidden, not fully
 * covered; the page's own `document.visibilityState` counts too), and the card is laid out
 * (its tab, chat or Board, is the one showing) and inside the window and every scrolling area
 * around it (scrolled into view). Pins the page shows are told to Swift (`pinsVisible`), whose
 * timer runs a pin only then.
 */

let windowShown = true;
const shownAgain: (() => void)[] = [];

/** Whether the app's window is shown, as Swift says and as the page knows. */
export function windowVisible(): boolean {
  return windowShown && (typeof document === "undefined" || document.visibilityState !== "hidden");
}

/**
 * Swift's word on the window. Shown again, what waits on it runs at once (a card hidden longer
 * than its interval refreshes right away); the pins seen are told again either way.
 */
export function setWindowVisible(visible: boolean): void {
  const was = windowShown;
  windowShown = visible;
  if (visible && !was) for (const fn of shownAgain) fn();
  reportVisiblePins();
}

/** Runs `fn` each time the window is shown again. */
export function whenShownAgain(fn: () => void): void {
  shownAgain.push(fn);
}

/** Whether a box clips what is outside it: an element that scrolls or hides its overflow. */
function clips(element: Element): boolean {
  const style = getComputedStyle(element);
  return [style.overflow, style.overflowX, style.overflowY].some((value) => value === "auto" || value === "scroll" || value === "hidden" || value === "clip");
}

/** Whether the user can see some of `element`: the window shown, it laid out, and in view. */
export function onScreen(element: Element): boolean {
  if (!windowVisible() || !element.isConnected) return false;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  let top = 0;
  let left = 0;
  let bottom = window.innerHeight || document.documentElement.clientHeight;
  let right = window.innerWidth || document.documentElement.clientWidth;
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (!clips(parent)) continue;
    const around = parent.getBoundingClientRect();
    top = Math.max(top, around.top);
    left = Math.max(left, around.left);
    bottom = Math.min(bottom, around.bottom);
    right = Math.min(right, around.right);
  }
  return box.bottom > top && box.top < bottom && box.right > left && box.left < right;
}

/**
 * The pins the user can see now, in page order: a chip above the input box, the opened pin, a
 * Board tile in view, a floating card (folded too: its header shows how it stands).
 */
export function visiblePinIDs(): string[] {
  if (!windowVisible()) return [];
  const ids: string[] = [];
  const add = (id: string | undefined) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const element of document.querySelectorAll<HTMLElement>(".pin-chip[data-id], .board-card[data-id], .float-card[data-id]")) {
    if (onScreen(element)) add(element.dataset.id);
  }
  const sheet = document.querySelector<HTMLElement>(".pin-sheet:not([hidden])");
  if (sheet && onScreen(sheet)) add(document.querySelector<HTMLElement>(".pin-chip.on[data-id]")?.dataset.id);
  return ids;
}

let told: string[] = [];

/** Tells Swift which pins are seen, when that changed since it was last told. */
export function reportVisiblePins(): void {
  const ids = visiblePinIDs();
  if (ids.length === told.length && ids.every((id, index) => id === told[index])) return;
  told = ids;
  post({ type: "pinsVisible", ids });
}

let reportSoon: ReturnType<typeof setTimeout> | null = null;

/** `reportVisiblePins` once things settle (after a scroll, a resize, an update). */
export function reportVisiblePinsSoon(): void {
  reportSoon ??= setTimeout(() => {
    reportSoon = null;
    reportVisiblePins();
  }, 150);
}
