/**
 * The one rule for cards that refresh by themselves (a chat card's `Refresh: every 2s` or
 * `<show refresh="2s">`, a pin's interval, a floating pin): they run again only while the user
 * can see them. That is: the app's window is shown (Swift tells the page with
 * `ccb.setWindowVisible`, from the window's occlusion: not minimized, not hidden, not fully
 * covered; the page's own `document.visibilityState` counts too), and the card is laid out
 * (its tab, chat or Board, is the one showing) and inside the window and every scrolling area
 * around it (scrolled into view). Pins the page shows are told to Swift (`pinsVisible`) by
 * botling.board, whose web part keeps that list (its `visible.ts`).
 */

let windowShown = true;
const shownAgain: (() => void)[] = [];
/** Told whenever Swift says the window is shown or hidden (the chat's plugin host: `page.onWindowVisible`). */
let windowListener: () => void = () => {};

export function setWindowListener(fn: () => void): void {
  windowListener = fn;
}

/** Whether the app's window is shown, as Swift says and as the page knows. */
export function windowVisible(): boolean {
  return windowShown && (typeof document === "undefined" || document.visibilityState !== "hidden");
}

/**
 * Swift's word on the window. Shown again, what waits on it runs at once (a card hidden longer
 * than its interval refreshes right away); plugins are told either way.
 */
export function setWindowVisible(visible: boolean): void {
  const was = windowShown;
  windowShown = visible;
  if (visible && !was) for (const fn of shownAgain) fn();
  windowListener();
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
