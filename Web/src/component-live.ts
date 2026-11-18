import { post } from "./bridge";
import { t } from "./i18n";
import { acceptPictures } from "./pictures";
import { LiveSchedule, liveTick, type LiveCard } from "./refresh";
import { onScreen, whenShownAgain, windowVisible } from "./visible";
import { escapeHTML } from "./util";
import type { ChoiceView, ComponentInfo, DisplayView } from "./types";
import { resizeFrame, type ComponentFrame } from "./component-page";
import { whenNear, builtFrames, keepReading, settleHeight, rememberedHeight } from "./component-frames";

/**
 * How long a frame drawing a new page behind the shown one may take before it is given up, in ms: the shown one stays then,
 * and the next redraw tries again. Never "shown anyway": a page that is not ready (still loading, not painted, pictures not
 * decoded, no size) would show blank or short for a moment.
 */
export const redrawWait = 10_000;

/** Runs `work` after the next frame is painted (at once where there are no frames, as in a test). */
function afterPaint(work: () => void): void {
  if (typeof requestAnimationFrame !== "function") return work();
  requestAnimationFrame(() => requestAnimationFrame(work));
}

/**
 * New data or a new page for `shown`, a frame that reads its data only as it loads (no ccb.onData), or whose template,
 * version or pictures changed: `next`, a frame with the new page, loads hidden right over it. It takes `shown`'s place in
 * one step, and only when its page says (`{ccb: "ready", height}`, component-page.ts `readyScript`) that it is loaded, painted,
 * its pictures decoded and it has a size: the empty page a frame starts with, a `load` event, or the clock are not that. Until
 * then the old drawing stays as it is, and its shell keeps its height; `next`'s size writes no height. A page that does not get
 * ready within `redrawWait`, or that fails, is dropped and the old drawing stays. Newer data while `next` loads replaces `next`.
 */
export function drawBehind(shown: ComponentFrame, next: ComponentFrame): void {
  shown.ccbIncoming?.remove();
  const page = next.ccbPending;
  next.ccbPending = null;
  next.classList.remove("pending");
  next.classList.add("incoming");
  next.setAttribute("aria-hidden", "true");
  // Over the shown frame, as big as it is; hidden and out of the way until it is ready.
  next.style.position = "absolute";
  next.style.left = `${shown.offsetLeft}px`;
  next.style.top = `${shown.offsetTop}px`;
  next.style.width = `${shown.offsetWidth}px`;
  next.style.setProperty("height", shown.style.height || `${shown.offsetHeight}px`, "important");
  shown.ccbIncoming = next;
  // What the shown frame was drawn from before this, so a drawing given up asks for it again at the next redraw.
  shown.ccbShownDrawn ??= { drawn: shown.ccbDrawn, data: shown.ccbData };
  // It shows that data from now on: a redraw with it again changes nothing.
  shown.ccbDrawn = next.ccbDrawn;
  shown.ccbData = next.ccbData;
  let done = false;
  const finish = () => {
    done = true;
    clearTimeout(timer);
    next.ccbReady = null;
  };
  const swap = (height: number) => {
    if (done) return;
    finish();
    if (shown.ccbIncoming !== next) return;
    shown.ccbIncoming = null;
    shown.ccbShownDrawn = undefined;
    if (!next.isConnected) return;
    if (!shown.isConnected) return next.remove();
    next.ccbAnswer = shown.ccbAnswer;
    next.ccbSave = shown.ccbSave;
    next.ccbDetail = shown.ccbDetail;
    next.ccbStatus = shown.ccbStatus ?? next.ccbStatus;
    if (shown.ccbSize && next.ccbSize !== shown.ccbSize) resizeFrame(next, shown.ccbSize);
    for (const name of ["position", "left", "top", "width"]) next.style.removeProperty(name);
    // As tall as it measured (the last size it said, else the one it said it was ready at): the one height that counts.
    const measured = next.ccbSized ?? height;
    next.style.removeProperty("height");
    settleHeight(next, measured);
    // Not moved in the page (it would load again): the old one goes and the new one shows.
    const box = shown.getBoundingClientRect();
    shown.remove();
    next.classList.remove("incoming");
    next.removeAttribute("aria-hidden");
    keepReading(next, box, measured);
  };
  // Given up: the old drawing stays, and what it was drawn from comes back, so the next redraw draws the page again.
  const giveUp = () => {
    if (done) return;
    finish();
    if (shown.ccbIncoming !== next) return;
    shown.ccbIncoming = null;
    if (shown.ccbShownDrawn) {
      shown.ccbDrawn = shown.ccbShownDrawn.drawn;
      shown.ccbData = shown.ccbShownDrawn.data;
      shown.ccbShownDrawn = undefined;
    }
    next.remove();
  };
  const timer = setTimeout(giveUp, redrawWait);
  next.ccbReady = (height) => afterPaint(() => swap(height));
  shown.after(next);
  if (page != null) next.srcdoc = page;
}

/**
 * Where a card's command requests go instead of a chat card's (a pinned card's). A request only asks to run: one not
 * allowed yet is asked about on the app page's own sheet, which this page cannot press (plugin-platform.md §5.4, G2).
 */
export type CommandSend = (request: { command: string; folder: string; detail?: string; force?: boolean; live?: boolean }) => void;

/** Cards whose command was asked to run once allowed, so a redraw does not ask again. */
const requestedRuns = new Set<string>();

const refreshIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;

/**
 * A component whose data comes from a CLI command. Above it a bar names the command, when it
 * last ran, and a button to run it again. Until the user allows that command for the project
 * the card only asks (Swift remembers the answer); a failed run shows why instead of the
 * component. `draw` draws the component itself with the data the command gave.
 */
/** Whether `element` holds a component frame (one `keepFrames` may keep). */
export function hasFrame(element: Element | null): boolean {
  return !!element?.querySelector("iframe.component-frame");
}

/**
 * Cards that refresh by themselves (`Refresh: every 2s`): what runs each one again, by its card,
 * the newest drawing's (a redraw may keep the old element, so the element holds only the key),
 * and when each is due. A card is due `every` seconds after it was first seen done (or failed);
 * it then runs once the user can see it (`onScreen`, visible.ts), and counts again once it is drawn
 * done again, so a run is never asked for while one is going.
 */
const liveRuns = new Map<string, () => void>();
const liveSchedule = new LiveSchedule();
let liveTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The cards that refresh by themselves, as they are made: the tick walks only these, never the whole page. `seen`: it has been
 * on the page (a card made but not put there, as a redraw's copy of a kept card, is dropped once `liveGrace` has passed).
 */
const liveCards = new Map<HTMLElement, { born: number; seen: boolean; card: LiveCard }>();
/** How long a card that is not on the page yet is waited for, in ms. */
const liveGrace = 2000;
/** How long a card that is due but out of view is left alone before it is measured again, in ms (measuring it lays the page out). */
export const offscreenRecheck = 1000;
const offscreenUntil = new WeakMap<HTMLElement, number>();
/** How many cards the tick looks after (for tests: a card gone from the page must not stay here). */
export function liveCardCount(): number {
  return liveCards.size;
}

/** The time of the tick being made (what `ready` measures against). */
let tickNow = 0;

// Shown again (the window was minimized, hidden or covered): those overdue run at once.
whenShownAgain(() => refreshDueCards());

/** A card as the schedule sees it: its state is read from the element when asked, so one object serves every tick. */
function liveCard(card: HTMLElement): LiveCard {
  const key = card.dataset.liveKey ?? "";
  return {
    key,
    get every() { return Number(card.dataset.every); },
    get idle() { return card.dataset.status === "done" || card.dataset.status === "failed"; },
    // Not seen (visible.ts: the window shown, its tab showing, scrolled into view), or its
    // frame not built yet (it is built once near): it waits. A card out of view is measured
    // only now and then, not at every tick while it is overdue.
    ready: () => {
      if (!windowVisible()) return false;
      if (tickNow < (offscreenUntil.get(card) ?? 0)) return false;
      if (!onScreen(card)) {
        offscreenUntil.set(card, tickNow + offscreenRecheck);
        return false;
      }
      return builtFrames(card);
    },
    run: () => liveRuns.get(key)?.(),
  };
}

/** Runs the cards whose time has come and that are on screen; how many ran. */
export function refreshDueCards(now = Date.now()): number {
  const here: LiveCard[] = [];
  const gone = new Set<string>();
  const kept = new Set<string>();
  for (const [element, entry] of liveCards) {
    if (element.isConnected) {
      entry.seen = true;
      here.push(entry.card);
      kept.add(entry.card.key);
    } else if (entry.seen || now - entry.born > liveGrace) {
      liveCards.delete(element);
      gone.add(entry.card.key);
    } else {
      kept.add(entry.card.key);
    }
  }
  // A card nothing on the page stands for any more is forgotten (a redraw's kept card still holds its key).
  for (const key of gone) {
    if (kept.has(key)) continue;
    liveRuns.delete(key);
    liveSchedule.forget(key);
  }
  if (!here.length) {
    // A card made but not put on the page yet (inside its grace) is still waited for: the timer and its run stay.
    if (liveCards.size) return 0;
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = null;
    liveRuns.clear();
    liveSchedule.clear();
    return 0;
  }
  tickNow = now;
  return liveSchedule.tick(here, now);
}

function watchLiveCards(card: HTMLElement): void {
  liveCards.set(card, { born: Date.now(), seen: false, card: liveCard(card) });
  liveTimer ??= setInterval(() => refreshDueCards(), liveTick);
}

export function commandCard(
  display: DisplayView,
  messageID: string,
  index: number,
  draw: () => HTMLElement | null,
  options: { send?: CommandSend; bar?: boolean; lazy?: boolean; heightKey?: string } = {},
): HTMLElement {
  const card = document.createElement("div");
  card.className = "command-card";
  const status = display.status ?? "approve";
  card.dataset.status = status;
  // With the command and folder this card shows: Swift allows and runs only what you saw.
  const shown: { command: string; folder: string; detail?: string } = { command: display.command ?? "", folder: display.folder ?? "" };
  if (display.detail) shown.detail = display.detail;
  const run = (extra: { force?: boolean; live?: boolean }) =>
    options.send ? options.send({ ...shown, ...extra }) : post({ type: "componentCommand", messageID, index, ...shown, ...extra });
  const hasData = display.data !== "null" && display.data !== "";
  // The last run failed but its result is still there (the core keeps it): the card keeps showing it, as it was.
  const keptAfterFailure = status === "failed" && hasData;
  // Runs again by itself every so often while on screen (its about.md's Refresh line).
  if (display.command && typeof display.every === "number" && display.every > 0) {
    const key = `${messageID}/${index}`;
    card.dataset.every = String(Math.max(1, display.every));
    card.dataset.liveKey = key;
    liveRuns.set(key, () => run({ force: true, live: true }));
    watchLiveCards(card);
  }

  if (display.command && options.bar !== false) {
    const bar = document.createElement("div");
    bar.className = "command-bar";
    const text = document.createElement("code");
    text.className = "command-text";
    text.textContent = display.command;
    text.title = display.folder ? t("command.runsIn", { folder: display.folder }) : display.command;
    bar.append(text);
    const when = document.createElement("span");
    when.className = "command-when";
    const every = typeof display.every === "number" && display.every > 0
      ? display.every < 60 ? t("command.everySeconds", { n: display.every }) : t("command.everyMinutes", { n: Math.round(display.every / 60) })
      : "";
    // A card that refreshes by itself says how often, and does not flash "Running…" each time.
    when.textContent = every
      ? [display.ranAt ? t("command.ran", { when: display.ranAt }) : "", every].filter(Boolean).join(" · ")
      : status === "running" ? t("command.running") : display.ranAt ? t("command.ran", { when: display.ranAt }) : "";
    // A failed run that kept the last result: the bar's own spot says so (nothing around the picture moves), the reason on hover.
    if (keptAfterFailure) {
      when.textContent = [t("command.failedKept"), display.ranAt ? t("command.ran", { when: display.ranAt }) : ""].filter(Boolean).join(" · ");
      when.classList.add("failed");
      when.title = display.error ?? "";
    }
    bar.append(when);
    if (status !== "approve") {
      const refresh = document.createElement("button");
      refresh.className = "command-refresh" + (status === "running" ? " spinning" : "");
      refresh.setAttribute("aria-label", t("command.runAgainLabel"));
      refresh.title = t("command.runAgain");
      refresh.innerHTML = refreshIcon;
      refresh.disabled = status === "running" || status === "idle";
      refresh.addEventListener("click", () => run({ force: true }));
      bar.append(refresh);
    }
    card.append(bar);
  }

  if (status === "approve") {
    const ask = document.createElement("div");
    ask.className = "command-approve";
    const line = document.createElement("div");
    line.textContent = t("command.approveLine");
    const folder = document.createElement("code");
    folder.className = "command-folder";
    folder.textContent = display.folder ?? t("command.projectFolder");
    const command = document.createElement("pre");
    command.className = "command-full";
    command.textContent = display.command ?? "";
    const actions = document.createElement("div");
    actions.className = "command-actions";
    const allow = document.createElement("button");
    allow.className = "primary command-allow";
    allow.textContent = t("command.allow");
    // Asks the app to run it: the app's own sheet shows the command again and allows it.
    allow.addEventListener("click", () => run({}));
    const note = document.createElement("span");
    note.className = "command-note";
    note.textContent = t("command.remembered");
    actions.append(allow, note);
    ask.append(line, folder, command);
    if (display.detail) {
      // Allowed with it: the command the component runs for more data when you ask it to.
      const also = document.createElement("div");
      also.className = "command-detail-line";
      also.textContent = t("command.detailLine");
      const detail = document.createElement("pre");
      detail.className = "command-full command-detail";
      detail.textContent = display.detail;
      ask.append(also, detail);
    }
    ask.append(actions);
    card.append(ask);
  } else if (status === "failed" && !keptAfterFailure) {
    const problem = document.createElement("div");
    problem.className = "command-error";
    problem.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = display.command ? t("command.failed") : t("command.nothing");
    const detail = document.createElement("pre");
    detail.textContent = display.error ?? "";
    problem.append(title, detail);
    card.append(problem);
  } else if (status === "done" || ((status === "running" || status === "failed") && hasData)) {
    const component = draw();
    if (component) card.append(component);
    // Without a bar (a pinned card's) the notice sits over the picture's corner, taking no room.
    if (keptAfterFailure && !(display.command && options.bar !== false)) {
      const notice = document.createElement("div");
      notice.className = "command-stale";
      notice.setAttribute("role", "status");
      notice.textContent = t("command.failedKept");
      notice.title = display.error ?? "";
      card.append(notice);
    }
  } else {
    // Allowed and not run yet (ask once per command and folder), or running for the first time.
    // In the chat's history only once it comes near the visible chat: opening a long chat after
    // a restart ran every card's command at once.
    const key = JSON.stringify([messageID, index, shown.folder, shown.command]);
    const waiting = document.createElement("div");
    waiting.className = "command-waiting";
    waiting.innerHTML = `<span class="spinner" aria-hidden="true"></span><span>${escapeHTML(t("command.runningFirst"))}</span>`;
    // As tall as the component was when it was last drawn, so its first drawing takes the place without moving what is below.
    const remembered = options.heightKey ? rememberedHeight(options.heightKey) : 0;
    if (remembered > 0) waiting.style.minHeight = `${remembered}px`;
    const first = () => {
      if (requestedRuns.has(key)) return;
      requestedRuns.add(key);
      run({});
    };
    if (status === "idle" && !requestedRuns.has(key) && !(options.lazy && whenNear(waiting, first))) first();
    card.append(waiting);
  }
  return card;
}

/** Plain buttons, for when the 「choices」 template is missing. */
export function fallbackChoices(choices: ChoiceView[], chosen: number | null, answer: string | null, onPick: ((i: number) => void) | null): HTMLElement {
  const list = document.createElement("div");
  list.className = "choices";
  const answered = chosen !== null || answer !== null;
  choices.forEach((choice, index) => {
    const button = document.createElement("button");
    button.className = "choice" + (choice.recommended && !answered ? " recommended" : "") + (chosen === index ? " picked" : "") + (answered && chosen !== index ? " faded" : "");
    button.disabled = answered || !onPick;
    const side = chosen === index ? "✓" : choice.recommended ? (choice.detail ? `${t("choices.recommended")} · ${choice.detail}` : t("choices.recommended")) : (choice.detail ?? "");
    button.innerHTML = `<span>${escapeHTML(choice.label)}</span><span class="detail">${escapeHTML(side)}</span>`;
    button.addEventListener("click", () => onPick?.(index));
    list.append(button);
  });
  return list;
}

/** The flag beside a component: say what to change, or put back the previous version. */
export function reportControl(name: string, info: ComponentInfo): HTMLElement {
  const side = document.createElement("div");
  side.className = "component-side";
  if (info.working) {
    side.innerHTML = `<span class="spinner" role="img" aria-label="${escapeHTML(t("component.updating"))}"></span>`;
  } else {
    const flag = document.createElement("button");
    flag.className = "flag";
    flag.setAttribute("aria-label", t("component.report"));
    flag.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>`;
    flag.addEventListener("click", (event) => {
      event.stopPropagation();
      openReport(flag, name, info);
    });
    side.append(flag);
  }
  if (info.updated) {
    const label = document.createElement("span");
    label.className = "updated";
    label.textContent = t("component.updated");
    side.append(label);
  }
  return side;
}

/**
 * "Report a problem…", from a card's ⋯ menu (a reply's card, an opened pin, a Board tile, a
 * floating card): the report box shown by `anchor`, asking what's wrong, with a screenshot of the
 * card drawn in `drawn` (its component's frame, else all of it). Sent, it goes to Maintainer
 * with the card's pin (`pinID`), so Swift can say whose chat it is in, how it refreshes and when
 * its data is from; "Sent to Maintainer" says it went.
 */
export function reportComponent(anchor: HTMLElement, name: string, info: ComponentInfo, drawn: HTMLElement | null, pinID?: string): void {
  const frame = drawn ? drawn.querySelector<HTMLElement>(".component-frame") ?? drawn : null;
  openReport(anchor, name, info, frame, { pinID: pinID ?? null });
}

/** "Sent to Maintainer", for a moment, where a pin's Undo shows. */
function sentToast(): void {
  document.querySelector(".pin-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "pin-toast";
  toast.setAttribute("role", "status");
  toast.textContent = t("component.sentToMaintainer");
  document.body.append(toast);
  setTimeout(() => toast.remove(), 3000);
}

/**
 * Say what to change, in words, pictures or both: a screenshot of the component as it is now
 * goes along unless you untick it, and pictures pasted (⌘V) or dropped on the box go too. From
 * a menu (`problem`) it asks what's wrong, has Cancel, and says when it was sent.
 */
function openReport(anchor: HTMLElement, name: string, info: ComponentInfo, frame?: HTMLElement | null, problem?: { pinID: string | null }): void {
  document.querySelector(".report")?.remove();
  const component = frame ?? anchor.closest(".component")?.querySelector<HTMLElement>(".component-frame") ?? null;
  const box = document.createElement("div");
  box.className = "report";
  const title = problem ? t("component.problemQuestion") : t("component.changeQuestion");
  const placeholder = problem ? t("component.problemPlaceholder") : t("component.changePlaceholder");
  const shotWords = problem ? t("component.attachCardShot") : t("component.attachShot");
  const cancel = problem ? `<button class="plain cancel">${escapeHTML(t("common.cancel"))}</button>` : "";
  box.innerHTML = `<div class="report-title">${escapeHTML(title)}</div>
<textarea rows="3" placeholder="${escapeHTML(placeholder)}"></textarea>
<div class="report-images" hidden></div>
${component ? `<label class="report-shot"><input type="checkbox" checked> ${escapeHTML(shotWords)}</label>` : ""}
<div class="report-actions">${info.hasPrevious ? `<button class="plain revert">${escapeHTML(t("component.revert"))}</button>` : ""}<span></span>${cancel}<button class="primary send">${escapeHTML(t("composer.send"))}</button></div>`;
  const textarea = box.querySelector("textarea")!;
  const send = box.querySelector<HTMLButtonElement>(".send")!;
  const strip = box.querySelector<HTMLElement>(".report-images")!;
  const shot = box.querySelector<HTMLInputElement>(".report-shot input");
  // The screenshot alone is not a request: words or a picture of your own are.
  const refresh = () => {
    send.disabled = textarea.value.trim() === "" && images.length === 0;
    strip.hidden = images.length === 0;
  };
  const images = acceptPictures(box, textarea, strip, refresh);
  refresh();
  textarea.addEventListener("input", refresh);
  send.addEventListener("click", () => {
    let rect: { x: number; y: number; width: number; height: number } | null = null;
    if (component && shot?.checked) {
      const bounds = component.getBoundingClientRect();
      rect = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
    }
    // Out of the way first, so the screenshot shows the component and not this box.
    box.remove();
    const text = textarea.value.trim();
    requestAnimationFrame(() => post(problem
      ? { type: "componentReport", name, text, images, rect, problem: true, ...(problem.pinID ? { pinID: problem.pinID } : {}) }
      : { type: "componentReport", name, text, images, rect }));
    if (problem) sentToast();
  });
  box.querySelector(".cancel")?.addEventListener("click", () => box.remove());
  box.querySelector(".revert")?.addEventListener("click", () => {
    post({ type: "componentRevert", name });
    box.remove();
  });
  document.body.append(box);
  const rect = anchor.getBoundingClientRect();
  // Beside the flag, but inside the window, also once pictures make it taller.
  const place = () => {
    box.style.top = `${Math.max(12, Math.min(rect.top - 8, window.innerHeight - box.offsetHeight - 12))}px`;
  };
  place();
  new ResizeObserver(place).observe(box);
  box.style.left = `${Math.min(rect.right + 8, window.innerWidth - 316)}px`;
  textarea.focus();
  const close = (event: MouseEvent) => {
    if (!box.contains(event.target as Node)) {
      box.remove();
      document.removeEventListener("mousedown", close);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", close), 0);
}
