import { t } from "./i18n";

export function escapeHTML(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The small "Queued" mark on a line that waits to be sent; the line is drawn again without it once it is sent. */
export function queuedBadge(note?: { label: string; hint: string }): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "queued-badge";
  badge.textContent = note?.label ?? t("messages.queued");
  badge.title = note?.hint ?? t("messages.queuedHint");
  return badge;
}
