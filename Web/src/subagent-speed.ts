import { t } from "./i18n";
import type { SubagentHeaderView } from "./types";

/** Lifetime wall-clock average of reported output, never input+output or instantaneous decoding. */
export function subagentTokenSpeed(header: SubagentHeaderView, now = Date.now()): number | null {
  const { outputTokens: output, startedAt: start } = header;
  const end = header.status === "running" ? now : header.endedAt;
  if (typeof output !== "number" || !Number.isFinite(output) || output <= 0 ||
      typeof start !== "number" || !Number.isFinite(start) ||
      typeof end !== "number" || !Number.isFinite(end) || end <= start) return null;
  const speed = output / ((end - start) / 1000);
  return Number.isFinite(speed) && speed > 0 ? speed : null;
}

let ticker: ReturnType<typeof setInterval> | undefined;

/** Only one subagent header is displayed. Ended headers never keep ticking. */
export function subagentSpeedElement(header: SubagentHeaderView): HTMLElement {
  if (ticker !== undefined) clearInterval(ticker);
  ticker = undefined;
  const label = document.createElement("span");
  label.className = "subagent-speed";
  label.style.cssText = "flex-shrink:0;font-size:12px;font-variant-numeric:tabular-nums;color:var(--faint)";
  label.title = t("subagent.speedHint");
  const update = () => {
    const speed = subagentTokenSpeed(header);
    const value = speed === null ? "—" : speed < 0.1 ? "<0.1" : speed.toFixed(1);
    label.textContent = t("subagent.speed", { value });
    label.setAttribute("aria-label", `${label.textContent}. ${label.title}`);
  };
  update();
  if (header.status === "running") {
    ticker = setInterval(() => {
      if (!label.isConnected) { clearInterval(ticker); ticker = undefined; return; }
      update();
    }, 1000);
  }
  return label;
}
