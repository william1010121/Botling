import { t } from "./i18n";
import { escapeHTML } from "./util";

/** A paste over either limit becomes a chip instead of text in the box; 0 turns that limit off. */
export const PASTE_CHARS = 1000;
export const PASTE_LINES = 15;

export interface PasteLimits { chars: number; lines: number }

/** The limits the app sent (Settings), the defaults where absent or not a number. */
export function pasteLimits(state: { pasteCollapseChars?: number | null; pasteCollapseLines?: number | null }): PasteLimits {
  const pick = (value: number | null | undefined, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback);
  return { chars: pick(state.pasteCollapseChars, PASTE_CHARS), lines: pick(state.pasteCollapseLines, PASTE_LINES) };
}

/** Lines as an editor counts them: a final line break does not start another. */
export function countLines(text: string): number {
  if (text === "") return 0;
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").length;
}

export function shouldCollapse(text: string, limits: PasteLimits): boolean {
  return (limits.chars > 0 && text.length > limits.chars) || (limits.lines > 0 && countLines(text) > limits.lines);
}

const OPEN = "<pasted-text>\n";
const CLOSE = "\n</pasted-text>";

/** What the bot gets: your words, then the pasted text in a tag the chat page folds back into a chip. */
export function withPasted(typed: string, pasted: string | null): string {
  if (!pasted) return typed;
  return `${typed.trim() === "" ? "" : `${typed}\n\n`}${OPEN}${pasted}${CLOSE}`;
}

/** The reverse, for a sent message: the words to show and the pasted text (null: none). */
export function splitPasted(text: string): { text: string; pasted: string | null } {
  if (!text.endsWith(CLOSE)) return { text, pasted: null };
  const joined = text.lastIndexOf(`\n\n${OPEN}`);
  const start = text.startsWith(OPEN) ? 0 : joined < 0 ? -1 : joined + 2;
  if (start < 0) return { text, pasted: null };
  return { text: start === 0 ? "" : text.slice(0, start - 2), pasted: text.slice(start + OPEN.length, text.length - CLOSE.length) };
}

const ICON = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 1.8h5.2L11 4.6v7.6H3z"/><path d="M5 7h4M5 9.4h4"/></svg>`;
const CROSS = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6"/></svg>`;

export const pasteStats = (pasted: string) => t("paste.stats", { lines: countLines(pasted), chars: pasted.length.toLocaleString("en-US") });

/** The chip: icon, title and line count; clicking it calls `open`. */
export function pasteChip(pasted: string, open: () => void): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "paste-chip";
  chip.innerHTML = `${ICON}<span>${escapeHTML(t("paste.title"))}</span><span class="paste-chip-count">${escapeHTML(t("paste.lines", { lines: countLines(pasted) }))}</span>`;
  chip.addEventListener("click", open);
  return chip;
}

/** Title, stats, the actions given, then the text in a monospace box. */
export function pastePanel(pasted: string, actions: { label: string; run: () => void }[], close: () => void): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "paste-panel";
  const head = document.createElement("div");
  head.className = "paste-head";
  head.innerHTML = `<span class="paste-title">${escapeHTML(t("paste.title"))}</span><span class="paste-stats">${escapeHTML(pasteStats(pasted))}</span><span class="paste-gap"></span>`;
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "paste-action";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    head.append(button);
  }
  const x = document.createElement("button");
  x.type = "button";
  x.className = "paste-x";
  x.setAttribute("aria-label", t("paste.close"));
  x.innerHTML = CROSS;
  x.addEventListener("click", close);
  head.append(x);
  const body = document.createElement("pre");
  body.className = "paste-body";
  body.textContent = pasted;
  panel.append(head, body);
  return panel;
}

/** Copies, and says so on the button for a moment. */
export function copyAction(pasted: string): { label: string; run: () => void } {
  return { label: t("paste.copy"), run: () => { void navigator.clipboard?.writeText(pasted); } };
}

/** The centered dialog for a sent message's chip: Copy and Close. */
export function openPasteDialog(pasted: string): void {
  const veil = document.createElement("div");
  veil.className = "paste-veil";
  const close = () => { veil.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
  const panel = pastePanel(pasted, [copyAction(pasted), { label: t("paste.close"), run: close }], close);
  panel.classList.add("paste-dialog");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("paste.title"));
  veil.append(panel);
  veil.addEventListener("mousedown", (event) => { if (event.target === veil) close(); });
  document.addEventListener("keydown", onKey, true);
  document.body.append(veil);
}
