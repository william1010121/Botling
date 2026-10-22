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
