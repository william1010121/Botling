import { subagentSpeedElement } from "./subagent-speed";
import { post } from "./bridge";
import { t, type Key } from "./i18n";
import { queuedBadge } from "./util";
import { renderMarkdown } from "./markdown";
import { foldedRun, liveElement, statusWord } from "./steps";
import type { MessageView, StepView, SubagentHeaderView, SubagentWaitingOn } from "./types";

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
    who.textContent = message.speaker ?? t("subagent.you");
    // "From {bot}" in the page's language, with the name set apart.
    const [before, after = ""] = t("subagent.from", { bot: "\u0000" }).split("\u0000");
    label.append(before, who, after, message.time ? ` · ${message.time}` : "");
    if (message.queued) label.append(queuedBadge(message.queuedOn ? { label: t("subagent.notDelivered"), hint: t("subagent.notDeliveredOn", { what: waitingWhat(message.queuedOn) }) } : undefined));
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

/** What its undelivered words wait for: "background command: Write deploy record…". */
export function waitingWhat(on: SubagentWaitingOn): string {
  return on.kind === "process" ? t("subagent.wait.process") : t(`subagent.wait.${on.kind}` as Key, { title: on.title });
}

/** How long it has waited: "25 min", "1 h 5 min". */
export function waitedFor(on: SubagentWaitingOn, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - on.since) / 60_000);
  if (minutes < 1) return t("subagent.underMinute");
  return minutes < 60 ? t("subagent.minutes", { n: String(minutes) }) : t("subagent.hours", { h: String(Math.floor(minutes / 60)), m: String(minutes % 60) });
}

/** The header's line: "Waiting for background command: Write deploy record… · 25 min". */
export function waitingLine(on: SubagentWaitingOn, now = Date.now()): string {
  return `${t("subagent.waitingOn", { what: waitingWhat(on) })} · ${waitedFor(on, now)}`;
}

// The header's waiting time moves with the clock alone: refreshed every 30 s.
let waitingTimer: ReturnType<typeof setInterval> | null = null;
function tickWaiting(element: HTMLElement, on: SubagentWaitingOn) {
  (element as HTMLElement & { waitingOn?: SubagentWaitingOn }).waitingOn = on;
  waitingTimer ??= setInterval(() => {
    const shown = [...document.querySelectorAll<HTMLElement & { waitingOn?: SubagentWaitingOn }>(".waiting-on")];
    if (!shown.length && waitingTimer) { clearInterval(waitingTimer); waitingTimer = null; return; }
    for (const each of shown) if (each.waitingOn) each.textContent = waitingLine(each.waitingOn);
  }, 30_000);
}

/** What it is doing right now, the way the main chat shows a turn under way: its latest steps, the one under way spinning. Its words not delivered yet: what they wait for, instead of the typing dots. */
export function subagentLiveElement(steps: StepView[], waiting?: SubagentWaitingOn | null): HTMLElement {
  const row = document.createElement("div");
  row.className = "row sub-work live";
  if (steps.length) row.append(liveElement(steps));
  if (waiting) {
    const note = document.createElement("div");
    note.className = "sub-waiting";
    note.setAttribute("role", "status");
    note.textContent = t("subagent.notDeliveredOn", { what: waitingWhat(waiting) });
    row.append(note);
  } else if (!steps.some((step) => !step.done)) {
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
  const engine = header.engine === "codex" || header.engine === "agy" ? header.engine : "claude";
  const worker = type?.endsWith("-worker") === true;
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
  badge.textContent = t((worker ? `subagent.engine.${engine}Worker` : `subagent.engine.${engine}`) as Key);
  const meta = document.createElement("span");
  meta.className = "meta";
  const reported = header.runtime?.reasoningEffort?.trim();
  const inherited = !reported ? header.inheritedEffort?.trim() : "";
  const effort = reported || (inherited ? t("subagent.effortInherited", { effort: inherited }) : t("subagent.unknown"));
  const tier = header.runtime?.serviceTier?.trim();
  // Only explicit standard/flex tiers establish Off; null/auto/unrecognized tiers are unknown.
  const fast = tier === "fast" || tier === "priority" ? t("subagent.fastOn")
    : tier === "default" || tier === "flex" ? t("subagent.fastOff")
    : tier === "ultrafast" ? "Ultrafast" : t("subagent.fastUnknown");
  const waiting = status === "running" ? header.waitingOn ?? null : null;
  meta.textContent = [header.host ? `Host: ${header.host}` : null, header.model, worker ? null : type, t("subagent.effort", { effort }), engine === "codex" ? fast : null,
    waiting ? null : statusWord(status), t("subagent.watchOnly")].filter(Boolean).join(" · ");
  meta.title = t("subagent.runtimeHelp") + (engine === "codex" && tier ? ` (${tier})` : "");
  bar.append(back, separator, name, badge, meta);
  if (waiting) {
    // Not "Running": its words have not reached it yet; say what they wait for and for how long.
    const line = document.createElement("span");
    line.className = "waiting-on";
    line.setAttribute("role", "status");
    line.textContent = waitingLine(waiting);
    line.title = t("subagent.notDeliveredOn", { what: waitingWhat(waiting) });
    tickWaiting(line, waiting);
    bar.append(line);
  }
  bar.append(subagentSpeedElement(header));
}
