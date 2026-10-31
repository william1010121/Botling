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

/** The head's own speed, above the input box; removed when nothing is timed yet. */
export function showMainSpeed(state: ChatState): void {
  const slot = document.getElementById("composer-slot");
  let label = document.getElementById("main-speed");
  const speed = state.subagent ? null : state.tokenSpeed;
  if (!speed || !slot) { label?.remove(); return; }
  if (!label) {
    label = document.createElement("div");
    label.id = "main-speed";
    label.className = "main-speed";
    slot.before(label);
  }
  fill(label, speed);
  label.style.cssText += ";text-align:right;padding:0 16px 2px";
}
