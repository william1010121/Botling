import { t } from "./i18n";

export function escapeHTML(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The small "Queued" mark on a line that waits to be sent; the line is drawn again without it once it is sent. */
export function queuedBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "queued-badge";
  badge.textContent = t("messages.queued");
  badge.title = t("messages.queuedHint");
  return badge;
}
