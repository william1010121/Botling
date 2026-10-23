import { post } from "./bridge";
import { t } from "./i18n";
import type { ChatState, HandoffView, RoundsView } from "./types";

/** The most segments the chip's meter draws (a limit above it still counts in the words). */
const meterMost = 10;

/**
 * The hand-offs between a bot's two heads, on the right of the pinned strip over the input box.
 * One under way: a chip with a meter, "Hand-off 1/6" and Stop. Several (each of your messages has
 * its own budget): "3 hand-offs in progress" and a chevron. The chip opens a panel above the
 * strip listing each one (who to whom, its task, how it stands, its count); a row opens to show
 * the message it came from and what the heads said about it. Closed until opened; open or not,
 * and which rows are open, is remembered for this page only, by chat.
 */
export class HandoffDock {
  readonly chip: HTMLElement;
  readonly panel: HTMLElement;
  private botID = "";
  private handoffs: HandoffView[] = [];
  private rounds: RoundsView | null = null;
  private drawn = "";
  /** By chat: the panel is open, and which rows are. */
  private readonly opened = new Map<string, { panel: boolean; rows: Set<string> }>();

  /** `row`: the strip's row (the chip goes at its end); the panel goes right above it. */
  constructor(row: HTMLElement) {
    this.chip = document.createElement("div");
    this.chip.className = "handoff-chip";
    this.chip.hidden = true;
    this.panel = document.createElement("section");
    this.panel.className = "handoff-panel";
    this.panel.hidden = true;
    row.append(this.chip);
    row.before(this.panel);
  }

  update(state: ChatState): void {
    this.botID = state.botID;
    this.handoffs = state.subagent ? [] : state.handoffs ?? [];
    this.rounds = state.subagent ? null : state.rounds ?? null;
    this.draw();
  }

  private get open(): { panel: boolean; rows: Set<string> } {
    let open = this.opened.get(this.botID);
    if (!open) {
      open = { panel: false, rows: new Set() };
      this.opened.set(this.botID, open);
    }
    return open;
  }

  private draw(force = false): void {
    const active = this.handoffs.filter((handoff) => handoff.state === "running" || handoff.state === "waiting");
    const shown = active.length > 0 || !!this.rounds;
    const open = this.open;
    // Rows only while something is under way: done ones of the same message stay listed with them.
    const listed = shown ? this.handoffs : [];
    const panelOpen = open.panel && listed.length > 0;
    const key = JSON.stringify([this.botID, this.handoffs, this.rounds, panelOpen, [...open.rows], t("handoffs.panel")]);
    if (!force && key === this.drawn) return;
    this.drawn = key;
    this.chip.hidden = !shown;
    this.chip.innerHTML = "";
    this.panel.hidden = !panelOpen;
    this.panel.innerHTML = "";
    if (!shown) return;
    this.chip.dataset.count = String(active.length);

    const toggle = document.createElement("button");
    toggle.className = "handoff-toggle";
    toggle.disabled = listed.length === 0;
    toggle.setAttribute("aria-expanded", String(panelOpen));
    toggle.setAttribute("aria-label", panelOpen ? t("handoffs.hide") : t("handoffs.show"));
    if (active.length > 1) {
      const dots = document.createElement("span");
      dots.className = "handoff-dots";
      for (const head of headsOf(active)) dots.append(dot(head));
      const label = document.createElement("span");
      label.className = "handoff-label";
      label.textContent = t("handoffs.many", { n: active.length });
      toggle.append(dots, label, chevron());
      this.chip.append(toggle);
    } else {
      const one = active[0];
      const kind = one ? (one.kind === "task" ? "handoff" : one.kind === "review" ? "review" : "discussion") : this.rounds?.kind ?? "handoff";
      const round = one?.round ?? this.rounds?.round;
      const limit = one?.limit ?? this.rounds?.limit;
      if (round !== undefined && limit !== undefined && limit > 0) toggle.append(meter(round, limit));
      const label = document.createElement("span");
      label.className = "handoff-label";
      label.textContent = round !== undefined && limit !== undefined
        ? t(kind === "review" ? "handoffs.review" : kind === "discussion" ? "handoffs.discussion" : "handoffs.one", { n: round, limit })
        : this.rounds?.text ?? "";
      if (this.rounds?.text) toggle.title = this.rounds.text;
      toggle.append(label);
      if (listed.length > 0) toggle.append(chevron());
      const stop = document.createElement("button");
      stop.className = "handoff-stop";
      stop.textContent = t("handoffs.stop");
      stop.title = this.rounds?.stop ?? t("handoffs.stop");
      stop.addEventListener("click", () => post({ type: "stopRounds" }));
      this.chip.append(toggle, stop);
    }
    toggle.addEventListener("click", () => {
      open.panel = !open.panel;
      this.draw(true);
    });

    if (!panelOpen) return;
    this.panel.setAttribute("aria-label", t("handoffs.panel"));
    const head = document.createElement("div");
    head.className = "handoff-panel-head";
    const title = document.createElement("span");
    title.className = "handoff-panel-title";
    title.textContent = t("handoffs.panel");
    head.append(title);
    // Finished ones of the same message stay listed: the header says how many are still going.
    const ended = listed.length - active.length;
    if (ended > 0) {
      const counts = document.createElement("span");
      counts.className = "handoff-panel-counts";
      counts.textContent = t("handoffs.ended", { active: active.length, ended });
      head.append(counts);
    }
    if (active.length > 0) {
      const stopAll = document.createElement("button");
      stopAll.className = "handoff-stop-all";
      stopAll.textContent = t("handoffs.stopAll");
      stopAll.addEventListener("click", () => post({ type: "stopRounds" }));
      head.append(stopAll);
    }
    const list = document.createElement("ul");
    list.className = "handoff-list";
    for (const handoff of listed) list.append(this.row(handoff, open.rows.has(handoff.id), active.length));
    this.panel.append(head, list);
  }

  private row(handoff: HandoffView, expanded: boolean, active: number): HTMLElement {
    const item = document.createElement("li");
    item.className = "handoff-row" + (expanded ? " expanded" : "");
    item.dataset.id = handoff.id;
    item.dataset.state = handoff.state;
    const head = document.createElement("button");
    head.className = "handoff-row-head";
    head.setAttribute("aria-expanded", String(expanded));
    const route = document.createElement("span");
    route.className = "handoff-route";
    route.title = `${handoff.fromName} → ${handoff.toName}`;
    const arrow = document.createElement("span");
    arrow.className = "handoff-arrow";
    arrow.textContent = "→";
    route.append(dot(handoff.from), arrow, dot(handoff.to));
    const task = document.createElement("span");
    task.className = "handoff-task";
    task.textContent = handoff.task;
    task.title = handoff.task;
    const status = document.createElement("span");
    status.className = "handoff-state";
    status.textContent = t(`handoffs.state.${handoff.state}`);
    const count = document.createElement("span");
    count.className = "handoff-count";
    count.textContent = `${handoff.round}/${handoff.limit}`;
    head.append(route, task, status, count);
    head.addEventListener("click", () => {
      const rows = this.open.rows;
      if (rows.has(handoff.id)) rows.delete(handoff.id);
      else rows.add(handoff.id);
      this.draw(true);
    });
    item.append(head);
    if (!expanded) return item;

    const detail = document.createElement("div");
    detail.className = "handoff-detail";
    if (handoff.origin) {
      const origin = document.createElement("p");
      origin.className = "handoff-origin";
      origin.textContent = t("handoffs.fromYou", { text: handoff.origin });
      detail.append(origin);
    }
    const lines = document.createElement("ol");
    lines.className = "handoff-lines";
    for (const line of handoff.lines) {
      const entry = document.createElement("li");
      entry.dataset.head = line.who;
      const who = document.createElement("span");
      who.className = "handoff-who";
      who.append(dot(line.who), document.createTextNode(line.name));
      const text = document.createElement("span");
      text.className = "handoff-text";
      text.textContent = line.text;
      entry.append(who, text);
      lines.append(entry);
    }
    detail.append(lines);
    if (handoff.state === "running" || handoff.state === "waiting") {
      // The app stops hand-offs together ("Stop now"): with others under way the button says so.
      const stop = document.createElement("button");
      stop.className = "handoff-stop-one";
      stop.textContent = active > 1 ? t("handoffs.stopAll") : t("handoffs.stopThis");
      if (active > 1) stop.title = t("handoffs.stopsAll");
      stop.addEventListener("click", () => post({ type: "stopRounds" }));
      detail.append(stop);
    }
    item.append(detail);
    return item;
  }
}

/** The heads taking part, Claude first, each once. */
function headsOf(handoffs: HandoffView[]): string[] {
  const heads = new Set(handoffs.flatMap((handoff) => [handoff.from, handoff.to]));
  return ["claude", "codex", ...heads].filter((head, index, all) => heads.has(head) && all.indexOf(head) === index);
}

function dot(head: string): HTMLElement {
  const element = document.createElement("span");
  element.className = "head-dot";
  element.dataset.head = head;
  element.setAttribute("aria-hidden", "true");
  return element;
}

function meter(round: number, limit: number): HTMLElement {
  const element = document.createElement("span");
  element.className = "handoff-meter";
  element.setAttribute("aria-hidden", "true");
  const segments = Math.min(limit, meterMost);
  const filled = Math.round((Math.min(round, limit) / limit) * segments);
  for (let index = 0; index < segments; index++) {
    const segment = document.createElement("i");
    if (index < filled) segment.className = "on";
    element.append(segment);
  }
  return element;
}

function chevron(): HTMLElement {
  const element = document.createElement("span");
  element.className = "handoff-chevron";
  element.setAttribute("aria-hidden", "true");
  element.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>`;
  return element;
}
