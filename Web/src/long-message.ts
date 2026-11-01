import { t } from "./i18n";
import { escapeHTML } from "./util";

/** A long message of yours is folded to this many lines (the CSS max-height says the same). */
export const FOLD_AFTER = 10;
/** Folded only when that hides a few lines, not one. */
const LONG_AFTER = FOLD_AFTER + 2;
/** Half-width characters on one line of a full-width bubble (about 428px of 15px text). */
const LINE_WIDTH = 56;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** About how many lines the bubble takes: line breaks, and each long line as the lines it wraps to. */
export function visualLines(text: string): number {
  let total = 0;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    let width = 0;
    for (const ch of line) width += WIDE.test(ch) ? 2 : 1;
    total += Math.max(1, Math.ceil(width / LINE_WIDTH));
  }
  return total;
}

export const isLongUserText = (text: string) => visualLines(text) > LONG_AFTER;

/** Messages you opened, by id: kept for the session, so a redraw leaves them open. */
const opened = new Set<string>();
export function resetUserFolds(): void { opened.clear(); }

const chevron = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

/** The bubble folded to its first lines with a fade, and the control under it that opens and folds it. */
export function userFold(id: string, bubble: HTMLElement): HTMLElement {
  const fold = document.createElement("div");
  fold.className = "user-fold";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "fold user-fold-toggle";
  const draw = () => {
    const open = opened.has(id);
    bubble.classList.toggle("collapsed", !open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.innerHTML = `<span>${escapeHTML(t(open ? "messages.showLess" : "messages.showMore"))}</span>${chevron}`;
  };
  toggle.addEventListener("click", () => {
    if (opened.has(id)) opened.delete(id);
    else opened.add(id);
    draw();
  });
  draw();
  fold.append(bubble, toggle);
  return fold;
}

/** Once laid out: a fold that hides nothing (a wide window, narrow letters) goes for good. */
export function settleUserFold(fold: HTMLElement): void {
  const bubble = fold.querySelector<HTMLElement>(".user-bubble.collapsed");
  if (!bubble || bubble.scrollHeight === 0 || bubble.scrollHeight > bubble.clientHeight + 1) return;
  bubble.classList.remove("collapsed");
  fold.querySelector(".user-fold-toggle")?.remove();
}
