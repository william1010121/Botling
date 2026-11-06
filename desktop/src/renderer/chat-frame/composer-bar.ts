// A plugin's `composerBar` view at the right end of the row above the input box (the pins' row). The shell
// picks the view for the chat on screen and makes its two pages (`ComposerBarSpec`, panel-page.ts with
// `ccb.context.surface` "compact" or "expanded"); this page draws them: a one-line frame in the row, and on a
// click a card above it with the expanded frame (Esc or a click outside closes it). The frames are this page's
// children, so what they post comes here; it is checked (their window, an opaque origin) and passed to the shell,
// which answers it as it answers any plugin frame (frame-broker.ts), and its replies come back to that frame.
import type { ComposerBarFrame, ComposerBarSpec, ShellMessage } from "./protocol";
import { fromShell, toShell } from "./transport";

/** The card's widest and tallest (px). */
const CARD_WIDTH = 380;
const CARD_HEIGHT = 480;

let shown: ComposerBarSpec | null = null;
let slot: HTMLElement | null = null;
let opener: HTMLButtonElement | null = null;
let compact: HTMLIFrameElement | null = null;
let card: HTMLElement | null = null;
let expanded: HTMLIFrameElement | null = null;

function frame(url: string, title: string, className: string): HTMLIFrameElement {
  const element = document.createElement("iframe");
  element.className = className;
  element.setAttribute("sandbox", "allow-scripts");
  element.referrerPolicy = "no-referrer";
  element.title = title;
  element.src = url;
  return element;
}

/** Draws `bar` (null: none) in the row; the same bar again changes nothing. */
export function showComposerBar(bar: ComposerBarSpec | null): void {
  if (JSON.stringify(bar) === JSON.stringify(shown)) return;
  closeCard();
  shown = bar;
  slot?.remove();
  slot = opener = compact = null;
  const area = document.getElementById("pin-area");
  if (!area) return;
  area.classList.toggle("has-composer-bar", !!bar);
  if (!bar) { area.style.removeProperty("--composer-bar-width"); return; }
  area.style.setProperty("--composer-bar-width", `${bar.width}px`);
  slot = document.createElement("div");
  slot.className = "composer-bar";
  slot.dataset.plugin = bar.plugin;
  slot.dataset.view = bar.view;
  compact = frame(bar.compact, bar.title, "composer-bar-frame");
  // The one-line frame only shows; the button over it takes the click (a frame would keep it).
  opener = document.createElement("button");
  opener.type = "button";
  opener.className = "composer-bar-open";
  opener.title = bar.title;
  opener.setAttribute("aria-label", bar.title);
  opener.setAttribute("aria-haspopup", "dialog");
  opener.setAttribute("aria-expanded", "false");
  opener.addEventListener("click", () => (card ? closeCard() : openCard()));
  slot.append(compact, opener);
  area.append(slot);
}

function openCard(): void {
  if (!shown || !slot || card) return;
  card = document.createElement("div");
  card.className = "composer-bar-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", shown.title);
  expanded = frame(shown.expanded, shown.title, "composer-bar-card-frame");
  expanded.style.height = "64px";
  card.append(expanded);
  document.body.append(card);
  opener?.setAttribute("aria-expanded", "true");
  slot.classList.add("open");
  placeCard();
}

function closeCard(): void {
  card?.remove();
  card = expanded = null;
  opener?.setAttribute("aria-expanded", "false");
  slot?.classList.remove("open");
}

/** Above the row's frame, its right edges lined up, inside the window. */
function placeCard(): void {
  if (!card || !slot) return;
  const at = slot.getBoundingClientRect();
  const width = Math.min(CARD_WIDTH, window.innerWidth - 16);
  card.style.width = `${width}px`;
  card.style.right = `${Math.max(8, Math.min(window.innerWidth - at.right, window.innerWidth - width - 8))}px`;
  card.style.bottom = `${Math.round(window.innerHeight - at.top + 6)}px`;
  card.style.maxHeight = `${Math.max(120, Math.min(CARD_HEIGHT, at.top - 14))}px`;
}

const which = (source: MessageEventSource | null): ComposerBarFrame | null =>
  !source ? null : compact?.contentWindow === source ? "compact" : expanded?.contentWindow === source ? "expanded" : null;

window.addEventListener("message", (event: MessageEvent) => {
  const from = which(event.source);
  if (!from || event.origin !== "null") return;
  const data = event.data as { ccb?: unknown; height?: unknown } | null;
  // The card is as tall as its content (to its most); the row's frame keeps the row's height.
  if (from === "expanded" && data?.ccb === "resize" && typeof data.height === "number" && expanded) {
    expanded.style.height = `${Math.max(24, Math.min(20_000, Math.ceil(data.height)))}px`;
    return;
  }
  toShell({ botling: "composerBarFrame", frame: from, data });
});

fromShell((message: ShellMessage) => {
  if (message?.botling === "composerBar") showComposerBar(message.bar);
  else if (message?.botling === "composerBarReply") (message.frame === "compact" ? compact : expanded)?.contentWindow?.postMessage(message.data, "*");
});

document.addEventListener("keydown", (event) => {
  if (card && event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); closeCard(); }
}, true);
document.addEventListener("pointerdown", (event) => {
  if (card && !card.contains(event.target as Node) && !slot?.contains(event.target as Node)) closeCard();
}, true);
window.addEventListener("resize", placeCard);

// After a reload the shell says again what the row shows.
toShell({ botling: "composerBarAsk" });
