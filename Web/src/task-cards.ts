// Task cards in the chat: a chip under each reply that belongs to a task (its state's color,
// its name, and on the latest one how it stands), the same chip beside a summary's bullet, and
// "Jump to chat" from the task's card in the right panel. Pressing a chip opens its task there
// (`selectTask`).
import { post } from "./bridge";
import { t, type Key } from "./i18n";
import type { TaskCardView } from "./types";
import { escapeHTML } from "./util";

/** Each state's mark and its words for the chip's label. */
const marks: Record<TaskCardView["state"], string> = {
  pending: "○", running: "●", waiting: "◐", done: "✓", stopped: "■", stale: "!",
};
const stateWords: Record<TaskCardView["state"], Key> = {
  pending: "taskCard.pending", running: "taskCard.running", waiting: "taskCard.waiting",
  done: "taskCard.done", stopped: "taskCard.stopped", stale: "taskCard.stale",
};

/** One chip, as HTML (summaries draw theirs as text): `action` for a card that handles its own clicks. */
export function taskCardChipHTML(card: TaskCardView, action?: string): string {
  const label = t("taskCard.label", { name: card.name, state: t(stateWords[card.state] ?? "taskCard.running") });
  const detail = card.detail ? ` · ${escapeHTML(card.detail)}` : "";
  return `<button type="button" class="task-card-chip ${escapeHTML(card.state)}${card.selected ? " selected" : ""}" data-task-id="${escapeHTML(card.id)}"`
    + `${action ? ` data-action="${escapeHTML(action)}"` : ""} aria-pressed="${card.selected ? "true" : "false"}" aria-label="${escapeHTML(label)}" title="${escapeHTML(label)}">`
    + `<span class="task-card-mark" aria-hidden="true">${marks[card.state] ?? "●"}</span><span class="task-card-name">${escapeHTML(card.name)}${detail}</span></button>`;
}

/** The chips under a reply, for its footer. */
export function taskCardChips(cards: TaskCardView[]): HTMLElement {
  const holder = document.createElement("span");
  holder.className = "task-card-chips";
  holder.innerHTML = cards.map((card) => taskCardChipHTML(card)).join("");
  holder.addEventListener("click", (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-task-id]");
    if (chip?.dataset.taskId) post({ type: "selectTask", id: chip.dataset.taskId });
  });
  return holder;
}

/**
 * Scrolls to a task's latest reply and flashes it. A reply folded into a summary card is not
 * unfolded: the card scrolls into view and the bullet with the task's chip flashes (else the
 * whole card); "Show N messages" still opens the originals.
 */
export function jumpToTask(messageID: string, taskID: string): void {
  const row = document.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(messageID)}"]`);
  if (!row) return;
  document.dispatchEvent(new CustomEvent("ccb-read-back"));
  const folded = row.closest(".catchup-folded");
  let target: HTMLElement = row;
  if (folded) {
    // The card just before the folded reply holds it; its bullet about the task, if one is.
    let head: Element | null = folded.previousElementSibling;
    while (head && !head.classList.contains("catchup-head")) head = head.previousElementSibling;
    const selector = `.catchup-bullets [data-task-id="${CSS.escape(taskID)}"]`;
    const chip = head?.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(`.catchup-head ${selector}`);
    target = chip?.closest<HTMLElement>("li") ?? (head as HTMLElement | null)?.querySelector<HTMLElement>(".catchup-card") ?? row;
  }
  target.scrollIntoView?.({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1200);
}
