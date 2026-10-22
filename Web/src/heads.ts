/** Bot look Cute in a bot with two heads: the seen marks under lines show each head's tiny character. */

const styleID = "seen-heads-style";

/** The style rules that put each head's image (a data URL, by its mark) on its seen marks. */
export function seenHeadsCSS(heads: Record<string, string>): string {
  return Object.entries(heads)
    .filter(([mark]) => /^[A-Za-z]+$/.test(mark))
    .map(([mark, url]) => `body.seen-heads .seen-mark[data-mark="${mark}"] { background-image: url("${url.replace(/["\\\n]/g, "")}"); }`)
    .join("\n");
}

let shown = "";

/** Shows the heads' characters on every seen mark (drawn already or later), or letters again when `heads` is absent. */
export function setSeenHeads(heads: Record<string, string> | null | undefined): void {
  const css = heads && Object.keys(heads).length ? seenHeadsCSS(heads) : "";
  if (css === shown) return;
  shown = css;
  document.body.classList.toggle("seen-heads", css !== "");
  let style = document.getElementById(styleID);
  if (!css) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = styleID;
    document.head.append(style);
  }
  style.textContent = css;
}

/** One short greeting for a new recipient or read check; unchanged marks never replay it. */
export function animateSeenArrivals(row: HTMLElement, previous?: HTMLElement): void {
  if (!document.body.classList.contains("seen-heads") || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  for (const mark of row.querySelectorAll<HTMLElement>(".seen-mark")) {
    const before = [...previous?.querySelectorAll<HTMLElement>(".seen-mark") ?? []].find((head) => head.dataset.mark === mark.dataset.mark);
    if (!before && (mark.classList.contains("recipient") || (!mark.classList.contains("recipient-mark") && mark.classList.contains("on")))) {
      arrive(mark, "head-arrive");
    }
    if (mark.classList.contains("on") && !before?.classList.contains("on")) {
      const check = mark.parentElement?.querySelector<HTMLElement>(".seen-check");
      if (check) arrive(check, "receipt-arrive");
    }
  }
}

function arrive(element: HTMLElement, name: string): void {
  element.classList.add(name);
  element.addEventListener("animationend", () => element.classList.remove(name), { once: true });
}
