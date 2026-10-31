import { t } from "./i18n";
import type { ChatState, SubagentHeaderView } from "./types";

type Speed = NonNullable<SubagentHeaderView["tokenSpeed"]>;

/**
 * The speed is computed in the core (desktop/src/core/token-speed.ts, one definition for every
 * engine and for the head as well as subagents): tokens summed / generation seconds summed. The page
 * only formats it; it never recomputes from wall-clock time.
 */
export function speedText(speed: Speed | null | undefined): string {
  if (!speed) return t("subagent.speed", { value: "—" });
  const value = speed.tokPerSec < 0.1 ? "<0.1" : speed.tokPerSec.toFixed(1);
  return t(speed.estimated ? "subagent.speedEstimated" : "subagent.speed", { value });
}

function fill(label: HTMLElement, speed: Speed | null | undefined): HTMLElement {
  label.style.cssText = "flex-shrink:0;font-size:12px;font-variant-numeric:tabular-nums;color:var(--faint)";
  label.title = t(speed?.estimated ? "subagent.speedHintEstimated" : "subagent.speedHint");
  label.textContent = speedText(speed);
  label.setAttribute("aria-label", `${label.textContent}. ${label.title}`);
  return label;
}

/** The subagent header's speed. */
export function subagentSpeedElement(header: SubagentHeaderView): HTMLElement {
  const label = document.createElement("span");
  label.className = "subagent-speed";
  return fill(label, header.tokenSpeed);
}

/** What showMainSpeed added last time, so the next call removes exactly that. */
const placed: HTMLElement[] = [];

/**
 * The head's own speed, on the header line (`.speaker`, "botling · Claude") of the latest bot
 * message: only the current value exists, so only that message carries it. A chat whose messages
 * have no header line gets one holding just the speed. Removed when nothing is timed yet.
 */
export function showMainSpeed(state: ChatState, root: ParentNode = document): void {
  for (const node of placed) node.remove();
  placed.length = 0;
  const speed = state.subagent ? null : state.tokenSpeed;
  if (!speed) return;
  // The latest bot row, found from the end (the list can hold thousands of rows).
  let row: HTMLElement | null = null;
  for (let node = root.lastElementChild; node && !row; node = node.previousElementSibling) {
    row = node.matches(".row.bot") ? (node as HTMLElement) : node.querySelector<HTMLElement>(":scope > .row.bot");
  }
  if (!row) return;
  let line = row.querySelector<HTMLElement>(".speaker");
  let created = false;
  if (!line) {
    const column = row.querySelector<HTMLElement>(".speaker-column, .bot-column, .reaction-message-column");
    if (!column) return;
    line = document.createElement("div");
    line.className = "speaker speed-only";
    column.prepend(line);
    created = true;
    placed.push(line);
  }
  const label = document.createElement("span");
  label.className = "speaker-speed";
  fill(label, speed);
  label.style.cssText = "font-variant-numeric:tabular-nums";
  // The separator lives inside the label so removing the label removes it too.
  if (!created && line.textContent) label.prepend(" · ");
  line.append(label);
  placed.push(label);
}
