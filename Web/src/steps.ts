import { post } from "./bridge";
import type { StepImage, StepView } from "./types";
import { openLightbox } from "./lightbox";
import { renderMarkdown } from "./markdown";
import { t, type Key } from "./i18n";
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

/**
 * The steps above a reply. With nothing said between tool calls: one folded "Worked · 5 steps"
 * line that opens to every step. When the bot said something between calls, the whole process
 * folds to one "Worked · 2 notes · 5 steps" line, so only the final reply is in sight; opened,
 * its words show in order as its own words, and each run of tool calls between them folds to a chip.
 */
export function stepsElement(listID: string, steps: StepView[], earlier = false): HTMLElement {
  return replyWork(steps, (work) => workedElement(listID, work, earlier));
}

/** Cards belong to the reply, outside every fold and the live tool tail. Render each once. */
function replyWork(steps: StepView[], render: (work: StepView[]) => HTMLElement): HTMLElement {
  if (!steps.some((step) => step.kind === "subagent")) return render(steps);
  const wrap = document.createElement("div");
  wrap.className = "reply-work";
  const work = steps.filter((step) => step.kind !== "subagent");
  if (work.length) wrap.append(render(work));
  const cards = document.createElement("div");
  cards.className = "step-list reply-subagents";
  for (const step of steps.filter((step) => step.kind === "subagent")) cards.append(subagentCard(step));
  wrap.append(cards);
  return wrap;
}

function workedElement(listID: string, steps: StepView[], earlier: boolean): HTMLElement {
  const parts = segments(steps);
  if (!parts.some((part) => part.text)) {
    const wrap = foldedRun(listID, steps, true, earlier);
    wrap.classList.replace("steps-run", "steps");
    return wrap;
  }
  const wrap = document.createElement("div");
  wrap.className = "steps with-text";
  const notes = parts.filter((part) => part.text).length;
  const tools = steps.filter((step) => step.kind !== "text").length;
  const toggle = document.createElement("button");
  toggle.className = "steps-toggle";
  toggle.innerHTML = `${chevron}<span></span>`;
  toggle.querySelector("span")!.textContent = [
    t("steps.worked"),
    t("steps.notes", { n: notes }),
    ...(tools ? [t("steps.steps", { n: tools })] : []),
  ].join(" · ");
  const body = document.createElement("div");
  body.className = "steps-body";
  parts.forEach((part, index) => body.append(part.text ? prose(part.text) : foldedRun(`${listID}#${index}`, part.steps, false, earlier)));
  const setOpen = (open: boolean) => {
    wrap.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
    if (open) openLists.add(listID);
    else openLists.delete(listID);
  };
  toggle.addEventListener("click", () => setOpen(body.hidden));
  wrap.append(toggle, body);
  setOpen(openLists.has(listID));
  return wrap;
}

/** The steps of the turn under way, shown live above the typing dots. Older ones fold away. */
export function liveElement(steps: StepView[]): HTMLElement {
  return replyWork(steps, liveWork);
}

function liveWork(steps: StepView[]): HTMLElement {
  const parts = segments(steps);
  const wrap = document.createElement("div");
  wrap.className = "steps live";
  if (!parts.some((part) => part.text)) {
    wrap.append(...liveRun(steps));
    return wrap;
  }
  // What it said stays in sight; calls it has moved on from fold to a chip, the ones under way show.
  wrap.classList.add("with-text");
  parts.forEach((part, index) => {
    if (part.text) wrap.append(prose(part.text));
    else if (index === parts.length - 1) wrap.append(...liveRun(part.steps));
    else wrap.append(foldedRun(`live#${index}`, part.steps, false));
  });
  return wrap;
}

/** The steps in order, as the bot's words and the runs of tool calls between them. */
function segments(steps: StepView[]): { text?: string; steps: StepView[] }[] {
  const parts: { text?: string; steps: StepView[] }[] = [];
  for (const step of steps) {
    const last = parts[parts.length - 1];
    if (step.kind === "text") parts.push({ text: step.title, steps: [] });
    else if (last && !last.text) last.steps.push(step);
    else parts.push({ steps: [step] });
  }
  return parts;
}

/** The bot's own words between tool calls, as markdown. */
function prose(text: string): HTMLElement {
  const words = document.createElement("div");
  words.className = "step-prose markdown";
  words.innerHTML = renderMarkdown(text);
  return words;
}

/** The last few steps, with a line for how many came before. */
function liveRun(steps: StepView[]): HTMLElement[] {
  const shown = 6;
  const tools = steps.filter((step) => step.kind !== "text");
  const hidden = steps.length > shown ? steps.length - shown : 0;
  const parts: HTMLElement[] = [];
  if (hidden) {
    const earlier = document.createElement("div");
    earlier.className = "steps-earlier";
    earlier.textContent = t("steps.soFar", { n: tools.length, hidden });
    parts.push(earlier);
  }
  parts.push(stepList(steps.slice(hidden)));
  return parts;
}

/**
 * A run of tool calls folded to one line ("Worked · 5 steps", or "5 steps" between words). In a
 * reply before your latest line (`earlier`), finished subagents leave the folded view: only
 * running ones stay in sight, and unfolding still lists them all. A subagent's view folds each
 * run between its words with it too.
 */
export function foldedRun(listID: string, steps: StepView[], worked: boolean, earlier = false): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "steps-run";
  const tools = steps.filter((step) => step.kind !== "text").length;
  const subagents = steps.filter((step) => step.kind === "subagent");
  const running = subagents.filter((step) => step.status === "running").length;
  const toggle = document.createElement("button");
  toggle.className = "steps-toggle";
  const count = t("steps.steps", { n: tools });
  const label = [worked ? `${t("steps.worked")} · ${count}` : count];
  if (subagents.length) label.push(t("steps.subagents", { n: subagents.length }) + (running ? t("steps.subagentsRunning", { running }) : ""));
  toggle.innerHTML = `${chevron}<span></span>`;
  toggle.querySelector("span")!.textContent = label.join(" · ");
  const list = stepList(steps);
  // Subagents stay in sight while folded, so you can open one without unfolding everything.
  const inSight = earlier ? subagents.filter((step) => step.status === "running") : subagents;
  const cards = document.createElement("div");
  cards.className = "step-list";
  for (const step of inSight) cards.append(subagentCard(step));
  const setOpen = (open: boolean) => {
    wrap.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
    list.hidden = !open;
    cards.hidden = open || inSight.length === 0;
    if (open) openLists.add(listID);
    else openLists.delete(listID);
  };
  toggle.addEventListener("click", () => setOpen(list.hidden));
  wrap.append(toggle, list, cards);
  setOpen(openLists.has(listID));
  return wrap;
}

/** The steps one line each: a tool call folded to its line (click for what went in and came out), a subagent as its card. */
export function stepList(steps: StepView[]): HTMLElement {
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
  if (step.detail) body.append(block(t("steps.in"), step.detail));
  if (step.output || images.length) body.append(block(step.failed ? t("steps.error") : t("steps.out"), (step.output ?? "").trim(), images));
  const setOpen = (open: boolean) => {
    // Pictures load once their step is first opened (a long chat has dozens of screenshots).
    if (open) for (const image of body.querySelectorAll<HTMLImageElement>("img[data-src]")) {
      image.src = image.dataset.src!;
      delete image.dataset.src;
    }
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

/**
 * A picture fit to the box (at most so tall); click it to see it large in the lightbox. The box
 * shows its small copy when it has one (the lightbox the full picture); it loads when its step is
 * opened (`data-src` till then).
 */
function stepImage(picture: StepImage): HTMLElement {
  const image = document.createElement("img");
  image.className = "step-image";
  image.dataset.src = picture.thumb ?? picture.url;
  image.dataset.full = picture.url;
  image.alt = picture.name;
  image.title = picture.name;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("click", (event) => {
    event.stopPropagation();
    openLightbox(picture.url, picture.name);
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
  card.innerHTML = `<span class="subagent-dot" aria-hidden="true"></span><span class="subagent-text"><span class="subagent-title"></span><span class="subagent-meta"></span></span><span class="subagent-open"></span>`;
  card.querySelector(".subagent-open")!.textContent = t("steps.openSubagent");
  card.querySelector(".subagent-title")!.textContent = step.title;
  card.querySelector(".subagent-meta")!.textContent = `${t("steps.subagent")} · ${statusWord(status)} · ${t("steps.tools", { n: count })}`;
  card.setAttribute("aria-label", t("steps.subagentLabel", { title: step.title, status: statusWord(status) }));
  card.addEventListener("click", () => post({ type: "openSubagent", id: step.id }));
  return card;
}

export function statusWord(status: string): string {
  const words: Record<string, Key> = { running: "status.running", completed: "status.done", failed: "status.failed", stopped: "status.stopped" };
  return words[status] ? t(words[status]) : status;
}

function statusIcon(step: StepView): string {
  if (!step.done) return `<span class="step-icon spinner" aria-label="${escapeHTML(t("status.running"))}"></span>`;
  if (step.failed) return `<span class="step-icon failed" aria-label="${escapeHTML(t("status.failed"))}">✕</span>`;
  return `<span class="step-icon done" aria-hidden="true">•</span>`;
}
