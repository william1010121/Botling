import { post } from "./bridge";
import { t, type Key } from "./i18n";
import { renderMarkdown } from "./markdown";
import { foldedRun, liveElement, statusWord } from "./steps";
import type { MessageView, StepView, SubagentHeaderView } from "./types";

/**
 * A subagent's view, read only (there is nothing to type to it): a header with its bot › its
 * title and what runs it; what its bot sent it (its task, later SendMessage messages) as compact
 * boxes "From Main · 15:58", in order; its work one line per step, dense and monospace, each run
 * of steps between what it said folded to one "N steps" line as in the main chat (the run under
 * way stays in sight), a command's output folded until its line is clicked; what it said, and
 * its report at the end, as prose.
 */

/** One line of the subagent's conversation. */
export function subagentMessageElement(message: MessageView): HTMLElement {
  const row = document.createElement("div");
  row.dataset.id = message.id;
  if (message.role === "user") {
    row.className = "row sub-from";
    const label = document.createElement("div");
    label.className = "sub-from-label";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = message.speaker ?? "";
    // "From {bot}" in the page's language, with the name set apart.
    const [before, after = ""] = t("subagent.from", { bot: "\u0000" }).split("\u0000");
    label.append(before, who, after, message.time ? ` · ${message.time}` : "");
    const body = document.createElement("div");
    body.className = "sub-from-body markdown";
    body.innerHTML = renderMarkdown(message.text);
    row.append(label, body);
    return row;
  }
  row.className = `row sub-work${message.role === "error" ? " error" : ""}`;
  if (message.steps?.length) row.append(foldedRun(`subagent:${message.id}`, message.steps, false));
  if (message.text.trim()) row.append(prose(message.text, message.role === "error"));
  return row;
}

/** What it is doing right now, the way the main chat shows a turn under way: its latest steps, the one under way spinning. */
export function subagentLiveElement(steps: StepView[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "row sub-work live";
  if (steps.length) row.append(liveElement(steps));
  if (!steps.some((step) => !step.done)) {
    const dots = document.createElement("div");
    dots.className = "dots sub-dots";
    dots.setAttribute("aria-label", t("messages.working"));
    dots.innerHTML = "<span></span><span></span><span></span>";
    row.append(dots);
  }
  return row;
}

function prose(text: string, failed: boolean): HTMLElement {
  const words = document.createElement("div");
  words.className = `sub-text markdown${failed ? " error" : ""}`;
  words.innerHTML = renderMarkdown(text);
  return words;
}

/** The header: "Main › Review PR #7  [Claude subagent]   Sonnet · general-purpose · running". */
export function fillSubagentBar(bar: HTMLElement, header: SubagentHeaderView): void {
  const { title, owner, status, type } = header;
  const engine = header.engine === "codex" ? "codex" : "claude";
  bar.className = status;
  bar.replaceChildren();
  const back = document.createElement("button");
  back.className = "crumb-owner back";
  back.textContent = owner;
  back.title = t("subagent.back", { bot: owner });
  back.setAttribute("aria-label", t("subagent.back", { bot: owner }));
  back.addEventListener("click", () => post({ type: "closeSubagent" }));
  const separator = document.createElement("span");
  separator.className = "crumb-sep";
  separator.setAttribute("aria-hidden", "true");
  separator.textContent = "›";
  const name = document.createElement("span");
  name.className = "title";
  name.textContent = title;
  const badge = document.createElement("span");
  badge.className = `engine-badge ${engine}`;
  badge.textContent = t(type === "codex-worker" && engine === "codex" ? "subagent.engine.codexWorker" : `subagent.engine.${engine}` as Key);
  const meta = document.createElement("span");
  meta.className = "meta";
  const effort = header.runtime?.reasoningEffort?.trim() || t("subagent.unknown");
  const tier = header.runtime?.serviceTier?.trim();
  // Only explicit standard/flex tiers establish Off; null/auto/unrecognized tiers are unknown.
  const fast = tier === "fast" || tier === "priority" ? t("subagent.fastOn")
    : tier === "default" || tier === "flex" ? t("subagent.fastOff")
    : tier === "ultrafast" ? "Ultrafast" : t("subagent.fastUnknown");
  meta.textContent = [header.model, type === "codex-worker" ? null : type, t("subagent.effort", { effort }), engine === "codex" ? fast : null,
    statusWord(status), t("subagent.watchOnly")].filter(Boolean).join(" · ");
  meta.title = t("subagent.runtimeHelp") + (engine === "codex" && tier ? ` (${tier})` : "");
  bar.append(back, separator, name, badge, meta);
}
