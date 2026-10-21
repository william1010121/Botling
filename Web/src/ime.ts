/**
 * Return while an input method (Zhuyin, Pinyin, Japanese…) is choosing a candidate belongs to the
 * input method: it commits the candidate and must never send, submit or blur.
 *
 * Checking `event.isComposing` alone is not enough in WKWebView: on macOS WebKit fires
 * `compositionend` first and then the Return `keydown`, with `isComposing` already false (its
 * `keyCode` is 229, and sometimes not even that). So an Enter counts as the input method's when
 * the event says it is composing, its keyCode is 229, a composition is open, or one ended moments
 * ago.
 *
 * Two layers, so no input box (now or written later) can get this wrong:
 * - `installImeGuard(window)` runs in the chat page and, as `imeGuardScript`, at the top of every
 *   component frame: a capture-phase listener on the window that stops such Enter `keydown` and
 *   `keypress` events before any page handler (or a form's implicit submit) sees them.
 * - `isComposingEnter(event)` / `isComposingKey(event)`: what every Enter handler in Web/src
 *   checks too (Web/test/ime.test.ts fails the build if one does not).
 */

/** How long after `compositionend` an Enter still counts as the one that ended it (ms). */
export const compositionGrace = 100;

interface ImeState {
  composing: boolean;
  endedAt: number;
}

type ImeWindow = Window & { __ccbIme?: ImeState };

/**
 * Installs the guard on `win` (once), counting an Enter within `grace` ms of `compositionend` as
 * the input method's. Self-contained on purpose: its source is copied as is into every component
 * frame (`imeGuardScript`, which passes `compositionGrace` in), so it may not use anything
 * outside its own body.
 */
export function installImeGuard(win: Window, grace: number = compositionGrace): void {
  const w = win as Window & { __ccbIme?: { composing: boolean; endedAt: number } };
  if (w.__ccbIme) return;
  const state = { composing: false, endedAt: -Infinity };
  w.__ccbIme = state;
  w.addEventListener("compositionstart", () => { state.composing = true; }, true);
  w.addEventListener("compositionend", () => { state.composing = false; state.endedAt = Date.now(); }, true);
  // A blur ends any composition; a missed compositionend must not swallow Enter for good.
  w.addEventListener("blur", () => { state.composing = false; }, true);
  const stop = (event: KeyboardEvent) => {
    const enter = event.key === "Enter" || event.keyCode === 13 || event.code === "Enter" || event.code === "NumpadEnter";
    if (!enter) return;
    const during = event.isComposing || event.keyCode === 229 || state.composing;
    const justAfter = Date.now() - state.endedAt < grace;
    if (!during && !justAfter) return;
    // Page handlers never see it. Its default (a newline, a form's submit) is cancelled only when
    // the input method is already done with it: during composition the default is the commit.
    event.stopImmediatePropagation();
    if (!during || event.type === "keypress") event.preventDefault();
  };
  w.addEventListener("keydown", stop, true);
  w.addEventListener("keypress", stop, true);
}

/** The guard as a script for a component frame's `<script>`. */
export const imeGuardScript = `(${installImeGuard.toString()})(window, ${compositionGrace});`;

function stateOf(event: Event): ImeState | undefined {
  const target = event.target as Node | null;
  const view = (target && "ownerDocument" in target ? target.ownerDocument?.defaultView : null) ?? (typeof window === "undefined" ? null : window);
  return (view as ImeWindow | null)?.__ccbIme;
}

/** Whether an input method is choosing right now (any key, not only Enter): leave the key to it. */
export function isComposingKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 || !!stateOf(event)?.composing;
}

/**
 * Whether this is Return pressed to commit an input method's candidate (during composition, or
 * the Return WebKit sends right after `compositionend`): never send, submit or blur on it.
 */
export function isComposingEnter(event: KeyboardEvent): boolean {
  const enter = event.key === "Enter" || event.keyCode === 13 || event.code === "Enter" || event.code === "NumpadEnter";
  if (!enter) return false;
  const state = stateOf(event);
  return isComposingKey(event) || (!!state && Date.now() - state.endedAt < compositionGrace);
}

/** Plain Return (no Shift, not an input method's): what sends in a one-line or chat box. */
export function isSendEnter(event: KeyboardEvent): boolean {
  return event.key === "Enter" && !event.shiftKey && !isComposingEnter(event);
}
