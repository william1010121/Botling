import type { ChipHandle } from "../../../../Web/src/composer";
import type { CcbWeb } from "../../../../Web/src/plugins";
import { escapeHTML } from "../../../../Web/src/util";
import { t } from "./words";

/** A paste over either limit becomes a chip instead of text in the box; 0 turns that limit off. */
export const PASTE_CHARS = 1000;
export const PASTE_LINES = 15;

export interface PasteLimits { chars: number; lines: number }

/** The limits from the plugin's settings, the defaults where absent or not a whole number from 0. */
export function pasteLimits(chars: unknown, lines: unknown): PasteLimits {
  const pick = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback);
  return { chars: pick(chars, PASTE_CHARS), lines: pick(lines, PASTE_LINES) };
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

/**
 * A paste over the limits stays out of the editor: a chip above the box, one per chat (another paste
 * joins it), that opens a preview; sending puts it after your words in the tag `splitPasted` reads.
 */
export function collapsePastes(ccb: CcbWeb): void {
  const pastes = new Map<ChipHandle, { text: string; open: boolean }>();
  ccb.composer.onPaste((text) => {
    const limits = pasteLimits(ccb.settings.get("botling.chat-extras.pasteCollapseChars"), ccb.settings.get("botling.chat-extras.pasteCollapseLines"));
    if (!shouldCollapse(text, limits)) return false;
    const here = ccb.composer.chips.list().find((handle) => pastes.has(handle));
    if (here) {
      pastes.get(here)!.text += `\n${text}`;
      here.update();
      return true;
    }
    const paste = { text, open: false };
    const handle: ChipHandle = ccb.composer.chips.add({
      render: () => {
        const chip = pasteChip(paste.text, () => { paste.open = !paste.open; handle.update(); });
        chip.setAttribute("aria-expanded", String(paste.open));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "paste-remove";
        remove.setAttribute("aria-label", t("paste.remove"));
        remove.innerHTML = CROSS;
        remove.addEventListener("click", () => { handle.remove(); ccb.composer.view.focus(); });
        const both = document.createDocumentFragment();
        both.append(chip, remove);
        return both;
      },
      preview: () => {
        if (!paste.open) return null;
        // Expand: back into the editor at the caret; the chip goes.
        const expand = () => { handle.remove(); ccb.composer.insert(paste.text); };
        return pastePanel(paste.text, [copyAction(paste.text), { label: t("paste.expand"), run: expand }], () => { paste.open = false; handle.update(); });
      },
      serialize: () => withPasted("", paste.text),
      onRemove: () => { pastes.delete(handle); },
    });
    pastes.set(handle, paste);
    return true;
  });
}
