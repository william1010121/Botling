import { post } from "./bridge";
import type { StepImage, StepView } from "./types";
import { escapeHTML } from "./util";

/**
 * What a bot did on the way to a reply, the way Claude Code shows it: one line per tool call
 * (click it for what went in and came out), its words between calls, and a card for each
 * subagent that opens the subagent's own conversation.
 */

/** Replies whose steps you unfolded, and step lines you opened, so a redraw keeps them open. */
const openLists = new Set<string>();
const openSteps = new Set<string>();

const chevron = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;

/** The folded "Worked · 5 steps" line above a reply; it opens to every step. */
export function stepsElement(listID: string, steps: StepView[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "steps";
  const tools = steps.filter((step) => step.kind !== "text").length;
  const subagents = steps.filter((step) => step.kind === "subagent");
  const running = subagents.filter((step) => step.status === "running").length;
  const toggle = document.createElement("button");
  toggle.className = "steps-toggle";
  const label = [`Worked · ${tools} step${tools === 1 ? "" : "s"}`];
  if (subagents.length) label.push(`${subagents.length} subagent${subagents.length === 1 ? "" : "s"}${running ? ` (${running} running)` : ""}`);
  toggle.innerHTML = `${chevron}<span></span>`;
  toggle.querySelector("span")!.textContent = label.join(" · ");
  const list = stepList(steps);
  // Subagents stay in sight while folded, so you can open one without unfolding everything.
  const cards = document.createElement("div");
  cards.className = "step-list";
  for (const step of subagents) cards.append(subagentCard(step));
  const setOpen = (open: boolean) => {
    wrap.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    list.hidden = !open;
    cards.hidden = open || subagents.length === 0;
    if (open) openLists.add(listID);
    else openLists.delete(listID);
  };
  toggle.addEventListener("click", () => setOpen(list.hidden));
  wrap.append(toggle, list, cards);
  setOpen(openLists.has(listID));
  return wrap;
}

/** The steps of the turn under way, shown live above the typing dots. Older ones fold away. */
export function liveElement(steps: StepView[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "steps live";
  const shown = 6;
  const tools = steps.filter((step) => step.kind !== "text");
  const hidden = steps.length > shown ? steps.length - shown : 0;
  if (hidden) {
    const earlier = document.createElement("div");
    earlier.className = "steps-earlier";
    earlier.textContent = `${tools.length} steps so far · ${hidden} earlier hidden`;
    wrap.append(earlier);
  }
  wrap.append(stepList(steps.slice(hidden)));
  return wrap;
}

function stepList(steps: StepView[]): HTMLElement {
  const list = document.createElement("div");
  list.className = "step-list";
  for (const step of steps) {
    list.append(step.kind === "subagent" ? subagentCard(step) : step.kind === "text" ? textLine(step) : toolLine(step));
  }
  return list;
}

function toolLine(step: StepView): HTMLElement {
  const line = document.createElement("div");
  line.className = `step tool${step.failed ? " failed" : ""}${step.done ? "" : " running"}`;
  const head = document.createElement("button");
  head.className = "step-head";
  head.innerHTML = `${statusIcon(step)}<span class="step-title"></span>`;
  head.querySelector(".step-title")!.textContent = step.title;
  head.title = step.title;
  line.append(head);
  const images = step.images ?? [];
  if (!step.detail && !step.output && !images.length) return line;
  const body = document.createElement("div");
  body.className = "step-body";
  if (step.detail) body.append(block("In", step.detail));
  if (step.output || images.length) body.append(block(step.failed ? "Error" : "Out", outputText(step.output ?? "", images), images));
  const setOpen = (open: boolean) => {
    body.hidden = !open;
    head.setAttribute("aria-expanded", String(open));
    line.classList.toggle("open", open);
    if (open) openSteps.add(step.id);
    else openSteps.delete(step.id);
  };
  head.addEventListener("click", () => setOpen(body.hidden));
  line.append(body);
  setOpen(openSteps.has(step.id));
  return line;
}

function block(label: string, text: string, images: StepImage[] = []): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "step-block";
  wrap.innerHTML = `<div class="step-label">${escapeHTML(label)}</div>`;
  if (text) {
    const pre = document.createElement("pre");
    pre.textContent = text;
    wrap.append(pre);
  }
  for (const picture of images) wrap.append(stepImage(picture));
  return wrap;
}

/** The output's words without the "(image)" lines that stood for the pictures now shown. */
function outputText(output: string, images: StepImage[]): string {
  if (!images.length) return output;
  return output.split("\n").filter((line) => line.trim() !== "(image)").join("\n").trim();
}

/** A picture fit to the box (at most so tall); click it to open it full size in a window. */
function stepImage(picture: StepImage): HTMLElement {
  const image = document.createElement("img");
  image.className = "step-image";
  image.src = picture.url;
  image.alt = picture.name;
  image.title = picture.name;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("click", (event) => {
    event.stopPropagation();
    post({ type: "openURL", url: picture.url, label: picture.name });
  });
  return image;
}

function textLine(step: StepView): HTMLElement {
  const line = document.createElement("div");
  line.className = "step text";
  line.textContent = step.title;
  return line;
}

/** A subagent: what it was sent to do, how it is doing; click to watch its conversation. */
function subagentCard(step: StepView): HTMLElement {
  const card = document.createElement("button");
  const status = step.status ?? (step.done ? "completed" : "running");
  card.className = `subagent-card ${status}`;
  const count = step.count ?? 0;
  card.innerHTML = `<span class="subagent-dot" aria-hidden="true"></span><span class="subagent-text"><span class="subagent-title"></span><span class="subagent-meta"></span></span><span class="subagent-open">Open ›</span>`;
  card.querySelector(".subagent-title")!.textContent = step.title;
  card.querySelector(".subagent-meta")!.textContent = `Subagent · ${statusWord(status)} · ${count} tool${count === 1 ? "" : "s"}`;
  card.setAttribute("aria-label", `Subagent ${step.title}, ${statusWord(status)}. Open its conversation`);
  card.addEventListener("click", () => post({ type: "openSubagent", id: step.id }));
  return card;
}

export function statusWord(status: string): string {
  return { running: "Running", completed: "Done", failed: "Failed", stopped: "Stopped" }[status] ?? status;
}

function statusIcon(step: StepView): string {
  if (!step.done) return `<span class="step-icon spinner" aria-label="Running"></span>`;
  if (step.failed) return `<span class="step-icon failed" aria-label="Failed">✕</span>`;
  return `<span class="step-icon done" aria-hidden="true">•</span>`;
}
