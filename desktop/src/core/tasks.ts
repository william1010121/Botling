// A chat's task cards, ported from the Swift `TaskBook` / `TaskCard` (TaskCards.swift), kept in
// tasks.json in 1.20's format: one card per piece of work, opened when the user sends a message,
// named and kept current by the head's hidden `<task …/>` lines, settled when its turn ends.
// Pure bookkeeping: the bot says what happened, the book updates its cards. 2.0 has one head
// (claude), so `owner` is always "claude" here; a card 1.x wrote for "codex" is kept as it is.
//
// Dates are Swift dates (seconds since 2001), ids upper-case UUIDs; keys 2.0 does not know are
// kept on each card.
import { characterCount, characterPrefix } from "./briefing";
import { newId } from "./store/records";
import { TASK_STAGES, type TaskStage, type TaskState, type TaskTag } from "./reply";

export type Head = "claude" | "codex" | "agy";

export interface TaskHelp { handoffID: string; head: Head; text: string }

/** One update on a card's timeline (2.x): what the panel's hover card lists from start to now. */
export type TaskEventKind = "start" | "now" | "waiting" | "you" | "subagent" | "done" | "stopped" | "complete";
export interface TaskEvent { kind: TaskEventKind; at: number; text?: string }
const EVENT_KINDS = new Set<TaskEventKind>(["start", "now", "waiting", "you", "subagent", "done", "stopped", "complete"]);
/** Events a card keeps: its start and the latest ones. */
export const HISTORY_LIMIT = 40;

export interface TaskCard {
  id: string;
  name: string;
  owner?: Head;
  state: TaskState;
  now?: string;
  next?: string;
  blocked?: string;
  /** How far finished work has got, from its `<task stage=…>` (2.x). */
  stage?: TaskStage;
  createdAt: number;
  updatedAt: number;
  messageIDs: string[];
  startedByMessageID?: string;
  kept: boolean;
  helps?: TaskHelp[];
  subagentIDs?: string[];
  stateFromTag?: TaskState;
  /** The user's card closure, independent of the owner's execution outcome (Swift date). */
  manuallyCompletedAt?: number;
  /** A head named it with a `<task>` line: real work, shown in the panel (2.x; 1.x cards infer it). */
  declared?: boolean;
  /** Its timeline (2.x; cards saved before have none). */
  history?: TaskEvent[];
  [key: string]: unknown;
}

const STATES = new Set<TaskState>(["pending", "running", "waiting", "done", "stopped"]);
export const isActive = (state: TaskState) => state === "pending" || state === "running" || state === "waiting";

/** `TaskBook.quickAnswer`: seconds within which a turn with no tools and no tag was a quick answer. */
export const QUICK_ANSWER = 20;
/** `TaskBook.staleAfter`: a running card with no news this long, nothing of it at work, may be stuck. */
export const STALE_AFTER = 10 * 60;
const LIMIT = 100;
const NAME_LENGTH = 40;

/** A card as 1.20 decodes it (`TaskCard.init(from:)`): a state it does not know reads as running. */
export function readTaskCard(value: unknown): TaskCard | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.createdAt !== "number") return null;
  const card: TaskCard = {
    ...raw,
    id: raw.id,
    name: raw.name,
    state: STATES.has(raw.state as TaskState) ? (raw.state as TaskState) : "running",
    createdAt: raw.createdAt,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : raw.createdAt,
    messageIDs: Array.isArray(raw.messageIDs) ? raw.messageIDs.filter((id): id is string => typeof id === "string") : [],
    kept: raw.kept === true,
  };
  if (raw.owner !== "agy" && raw.owner !== "claude" && raw.owner !== "codex") delete card.owner;
  if (Array.isArray(raw.subagentIDs)) {
    const valid = raw.subagentIDs.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(id));
    card.subagentIDs = [...new Set(valid)];
    if (valid.length !== raw.subagentIDs.length) card.agentLinkHistoryIncomplete = true;
  }
  else delete card.subagentIDs;
  if (raw.stateFromTag !== undefined && !STATES.has(raw.stateFromTag as TaskState)) delete card.stateFromTag;
  if (typeof raw.declared !== "boolean") delete card.declared;
  if (!TASK_STAGES.includes(raw.stage as TaskStage)) delete card.stage;
  if (Array.isArray(raw.history)) card.history = raw.history.filter(isTaskEvent);
  else delete card.history;
  if (typeof raw.manuallyCompletedAt !== "number" || !Number.isFinite(raw.manuallyCompletedAt)) delete card.manuallyCompletedAt;
  else { card.state = "done"; card.kept = true; }
  return card;
}

function isTaskEvent(value: unknown): value is TaskEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return EVENT_KINDS.has(event.kind as TaskEventKind) && typeof event.at === "number" && Number.isFinite(event.at)
    && (event.text === undefined || typeof event.text === "string");
}

/** Adds an update to the card's timeline; the same update said again is not a new one. */
export function note(card: TaskCard, kind: TaskEventKind, at: number, text?: string) {
  const history = card.history ?? (card.history = []);
  const last = history.at(-1);
  if (last && last.kind === kind && last.text === text) return;
  history.push(text === undefined ? { kind, at } : { kind, at, text });
  if (history.length > HISTORY_LIMIT) history.splice(history[0]!.kind === "start" ? 1 : 0, history.length - HISTORY_LIMIT);
}

/** A state the card reached, on its timeline. */
function noteState(card: TaskCard, at: number) {
  if (card.state === "done" || card.state === "stopped") note(card, card.state, at);
  else if (card.state === "waiting") note(card, "waiting", at, card.blocked);
}

/**
 * A head declared the card's work with a `<task>` line. A card 1.x (or 2.x before `declared`)
 * saved counts when it carries what only a tag gives: a tag's state, or Now/Next/Blocked.
 */
export function isDeclared(card: TaskCard): boolean {
  if (card.declared !== undefined) return card.declared;
  return card.stateFromTag !== undefined || !!card.now || !!card.next || !!card.blocked;
}

/** Visible evidence of work besides a tag: subagents or hand-offs started for it. */
const hasWork = (card: TaskCard) => !!card.subagentIDs?.length || !!card.helps?.length;

/**
 * The cards the panel shows: work a head declared (or that has subagents or hand-offs of its own)
 * and has a name. A plain message's provisional card is bookkeeping only.
 */
export function shownTasks(cards: TaskCard[]): TaskCard[] {
  return cards.filter((card) => card.name.trim().length > 0 && (isDeclared(card) || hasWork(card)));
}

/** `TaskBook.Turn`: what a finished turn was about. */
export interface TaskTurn {
  head: Head;
  /** The user's message the turn answered; null for background reports. */
  userMessage?: string | null;
  userText?: string | null;
  /** When the head got the message (Swift date). */
  started?: number | null;
  usedTools?: boolean;
  handoffID?: string | null;
  reporting?: string[];
  /** The reply asks the user something (a choices block). */
  asks?: boolean;
  handsOff?: boolean;
  runningSubagents?: Set<string>;
  runningHandoffs?: Set<string>;
}

const key = (name: string) => name.trim().toLowerCase();

/** What a provisional card is called: the start of the user's message. */
export function provisionalName(text: string): string {
  // Swift's `split(whereSeparator: \.isNewline).first`: the first line that is not empty.
  const line = (text.split(/[\n\r\u000B\u000C\u0085\u2028\u2029]+/).find((part) => part.length > 0) ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
  if (!line) return "New message";
  return characterCount(line) > NAME_LENGTH ? `${characterPrefix(line, NAME_LENGTH)}…` : line;
}

export class TaskBook {
  constructor(public tasks: TaskCard[] = []) {}

  task(id: string) { return this.tasks.find((card) => card.id === id); }
  /** The task a chat line belongs to (the newest, when it belongs to two). */
  containing(message: string) { return this.tasks.findLast((card) => card.messageIDs.includes(message)); }
  named(name: string) { const wanted = key(name); return this.tasks.findLast((card) => key(card.name) === wanted); }
  private index(id: string) { const at = this.tasks.findIndex((card) => card.id === id); return at >= 0 ? at : null; }

  /** You sent `message`: a provisional card, or a reply to a task's line carries that task on. */
  begin(message: string, text: string, owner: Head | null, at: number, replyingTo?: string | null): string {
    if (replyingTo) {
      const existing = this.containing(replyingTo);
      if (existing && existing.manuallyCompletedAt === undefined) {
        existing.messageIDs.push(message);
        if (existing.state !== "done" && existing.state !== "stopped") existing.state = existing.owner ? "running" : "pending";
        existing.updatedAt = at;
        note(existing, "you", at, provisionalName(text));
        return existing.id;
      }
    }
    const card: TaskCard = { id: newId(), name: provisionalName(text), state: "pending", createdAt: at, updatedAt: at, messageIDs: [message], startedByMessageID: message, kept: false, subagentIDs: [], history: [{ kind: "start", at }] };
    if (owner) card.owner = owner;
    this.tasks.push(card);
    this.trim();
    return card.id;
  }

  /** `head` started on the user's message: it owns the card unless another head does, and the card runs. */
  claim(message: string, head: Head, at: number): boolean {
    const card = this.containing(message);
    if (!card || card.manuallyCompletedAt !== undefined) return false;
    let changed = false;
    if (!card.owner) { card.owner = head; changed = true; }
    if (card.state === "pending" && card.owner === head) { card.state = "running"; card.updatedAt = at; changed = true; }
    return changed;
  }

  /** A head used a tool for the user's message: the card is real work and stays. */
  working(message: string, text: string, head: Head, at: number): string {
    const card = this.containing(message);
    if (card) { card.kept = true; return card.id; }
    const id = this.begin(message, text, head, at);
    const made = this.task(id);
    if (made) { made.kept = true; made.state = "running"; }
    return id;
  }

  /** You sent `later` before a head answered `earlier`, and both go as one message. */
  join(earlier: string, later: string) {
    const first = this.containing(earlier);
    const second = this.containing(later);
    if (!first || !second || first.id === second.id || second.startedByMessageID !== later) return;
    if (first.manuallyCompletedAt !== undefined || second.manuallyCompletedAt !== undefined) return;
    const from = this.index(second.id);
    if (from !== null) this.merge(from, first.id);
  }

  /** The other head took on part of `taskId` (a hand-off): a line on its card (`help(_:on:)`). */
  help(help: TaskHelp, taskId: string) {
    const card = this.task(taskId);
    if (!card || card.helps?.some((other) => other.handoffID === help.handoffID)) return;
    card.helps = [...(card.helps ?? []), help];
  }

  /** A subagent started for the task; `at`, when given, puts it on the card's timeline. */
  link(subagent: string, taskId: string, at?: number) {
    const card = this.task(taskId);
    if (!card || card.subagentIDs?.includes(subagent)) return;
    if (!Array.isArray(card.subagentIDs)) card.agentLinkHistoryIncomplete = true;
    card.subagentIDs = [...(card.subagentIDs ?? []), subagent];
    card.kept = true;
    if (at !== undefined) note(card, "subagent", at, subagent);
  }

  /** The card a turn works on: the user's message's, its hand-off's, or the reported subagents'. */
  base(turn: TaskTurn): TaskCard | undefined {
    if (turn.userMessage) return this.containing(turn.userMessage);
    if (turn.handoffID) {
      const card = this.tasks.findLast((candidate) => candidate.helps?.some((help) => help.handoffID === turn.handoffID));
      if (card) return card;
    }
    const reporting = new Set(turn.reporting ?? []);
    if (!reporting.size) return undefined;
    return this.tasks.findLast((card) => (card.subagentIDs ?? []).some((id) => reporting.has(id)));
  }

  /** A head's reply `message` ended its turn, with its `<task>` lines. Returns the cards it belongs to. */
  replied(message: string, turn: TaskTurn, tags: TaskTag[], at: number): string[] {
    const quick = !!turn.userMessage && !turn.usedTools && (turn.started != null ? at - turn.started < QUICK_ANSWER : true);
    let base = this.base(turn);
    if (!tags.length) {
      if (!base && turn.userMessage && !quick) {
        const id = this.working(turn.userMessage, turn.userText ?? "", turn.head, at);
        base = this.task(id);
      }
      if (!base) return [];
      // As 1.x keeps it; without a <task> line it is bookkeeping only and `shownTasks` leaves it out.
      const at_ = this.index(base.id)!;
      if (quick && !base.kept && (base.state === "pending" || base.state === "running") && !base.subagentIDs?.length) {
        this.tasks.splice(at_, 1);
        return [];
      }
      this.touch(base, message, turn.head, !!turn.asks, at);
      if (!quick) base.kept = true;
      this.settle(base.id, turn, at);
      return [base.id];
    }
    const touched: string[] = [];
    tags.forEach((tag, number) => {
      let target: TaskCard | undefined;
      const continued = tag.continues ? this.named(tag.continues) : undefined;
      // A new user request gets its own card after manual closure; delayed reports still find
      // the closed card by name and cannot resurrect it (or create a duplicate).
      const earlier = continued?.manuallyCompletedAt !== undefined && base && base.manuallyCompletedAt === undefined ? undefined : continued;
      if (tag.continues && earlier && earlier.id !== base?.id) {
        // It carries on an earlier task: this message, and what its own card had, join it.
        if (number === 0 && turn.userMessage && base && base.manuallyCompletedAt === undefined && base.startedByMessageID === turn.userMessage) {
          const from = this.index(base.id);
          if (from !== null) this.merge(from, earlier.id);
          base = undefined;
        }
        target = this.task(earlier.id);
      } else if (number === 0 && base) {
        // The same task named again from a new message: that message joins the card it has.
        const same = tag.name ? this.named(tag.name) : undefined;
        if (same && same.id !== base.id && isDeclared(same) && isActive(same.state) && same.manuallyCompletedAt === undefined
          && !isDeclared(base) && base.manuallyCompletedAt === undefined && (!same.owner || same.owner === turn.head)) {
          const from = this.index(base.id);
          if (from !== null) this.merge(from, same.id);
          base = undefined;
          target = this.task(same.id);
        } else target = base;
      } else {
        const name = tag.name ?? tag.continues;
        if (name) target = this.named(name);
      }
      if (!target) {
        const name = tag.name ?? tag.continues ?? (turn.userText != null ? provisionalName(turn.userText) : "New task");
        const card: TaskCard = { id: newId(), name, owner: turn.head, state: "running", createdAt: at, updatedAt: at, messageIDs: [], kept: false, subagentIDs: [], history: [{ kind: "start", at }] };
        if (turn.userMessage) card.startedByMessageID = turn.userMessage;
        if (number === 0 && turn.userMessage) card.messageIDs = [turn.userMessage];
        this.tasks.push(card);
        target = card;
      }
      this.apply(tag, target, turn.head, message, !!turn.asks, at);
      touched.push(target.id);
    });
    for (const id of touched) this.settle(id, turn, at);
    this.trim();
    return touched;
  }

  private touch(card: TaskCard, message: string, head: Head, asks: boolean, at: number) {
    if (!card.messageIDs.includes(message)) card.messageIDs.push(message);
    if (card.manuallyCompletedAt !== undefined) return;
    if (!card.owner) card.owner = head;
    if (card.owner !== head) return;
    if (asks && isActive(card.state)) { card.state = "waiting"; noteState(card, at); }
    else if (card.state === "pending" || card.state === "waiting") card.state = "running";
    card.updatedAt = at;
  }

  private apply(tag: TaskTag, card: TaskCard, head: Head, message: string, asks: boolean, at: number) {
    if (!card.messageIDs.includes(message)) card.messageIDs.push(message);
    card.declared = true;
    if (card.manuallyCompletedAt !== undefined) return;
    card.kept = true;
    if (!card.owner) card.owner = head;
    if (card.owner !== head) return;
    if (tag.name) card.name = tag.name;
    const before = { now: card.now, state: card.state, blocked: card.blocked };
    for (const field of ["now", "next", "blocked"] as const) {
      const value = tag[field];
      if (value === undefined) continue;
      if (value) card[field] = value;
      else delete card[field];
    }
    if (tag.stage) card.stage = tag.stage;
    else if (tag.stage === "") delete card.stage;
    card.state = tag.state ?? (asks ? "waiting" : "running");
    if (tag.state) card.stateFromTag = tag.state;
    card.updatedAt = at;
    if (card.now && card.now !== before.now) note(card, "now", at, card.now);
    if (card.state !== before.state || (card.state === "waiting" && card.blocked !== before.blocked)) noteState(card, at);
  }

  /** The owner's turn is over: a card it left running without saying so, with nothing of it at work, is done. */
  private settle(id: string, turn: TaskTurn, at: number) {
    const card = this.task(id);
    if (!card || card.owner !== turn.head || card.state !== "running" || card.stateFromTag === "running" || turn.handsOff) return;
    if (card.subagentIDs?.some((sub) => turn.runningSubagents?.has(sub))) return;
    if (card.helps?.some((help) => turn.runningHandoffs?.has(help.handoffID))) return;
    card.state = "done";
    card.updatedAt = at;
    note(card, "done", at);
  }

  /** Removes a provisional card `head` may settle (not declared, nothing at work, not closed by you). */
  private drop(card: TaskCard, head: Head): boolean {
    if (isDeclared(card) || hasWork(card) || card.manuallyCompletedAt !== undefined) return false;
    if (card.owner && card.owner !== head) return false;
    const at = this.index(card.id);
    if (at === null) return false;
    this.tasks.splice(at, 1);
    return true;
  }

  /**
   * `head`'s turn on the user's `message` ended. When no reply settled its card (it failed, was
   * stopped or taken back, or said nothing), a provisional card goes and a declared one still
   * waiting for a head is stopped: nothing stays "Claiming…". True when a card changed.
   */
  unanswered(message: string, head: Head, status: "done" | "failed" | "stopped", at: number): boolean {
    const card = this.containing(message);
    if (!card || card.manuallyCompletedAt !== undefined) return false;
    if (card.owner && card.owner !== head) return false;
    // `replied` already settled a card it answered (it is no longer pending).
    if (status === "done" && card.state !== "pending") return false;
    if (this.drop(card, head)) return true;
    if (card.state !== "pending") return false;
    card.state = "stopped";
    card.updatedAt = at;
    note(card, "stopped", at);
    return true;
  }

  private merge(from: number, into: string) {
    const [card] = this.tasks.splice(from, 1);
    const target = this.task(into);
    if (!card || !target) return;
    // A legacy card merged into a new one still has incomplete historical coverage.
    if (!Array.isArray(card.subagentIDs) || !Array.isArray(target.subagentIDs) || card.agentLinkHistoryIncomplete) target.agentLinkHistoryIncomplete = true;
    for (const message of card.messageIDs) if (!target.messageIDs.includes(message)) target.messageIDs.push(message);
    for (const help of card.helps ?? []) {
      if (!target.helps?.some((h) => h.handoffID === help.handoffID)) target.helps = [...(target.helps ?? []), help];
    }
    for (const subagent of card.subagentIDs ?? []) this.link(subagent, into);
  }

  set(id: string, state: TaskState, at: number) {
    const card = this.task(id);
    if (!card || card.manuallyCompletedAt !== undefined) return;
    const was = card.state;
    card.state = state;
    card.updatedAt = at;
    if (state !== was) noteState(card, at);
  }

  /**
   * Close the card, without changing its head, hand-offs or subagents. Repeated clicks are safe.
   * Besides work under way, it closes work said done but not verified (a stage before verified).
   */
  complete(id: string, at: number): boolean {
    const card = this.task(id);
    if (!card || card.manuallyCompletedAt !== undefined) return false;
    const unverified = card.state === "done" && card.stage !== undefined && card.stage !== "verified";
    if (!isActive(card.state) && !unverified) return false;
    card.state = "done";
    card.manuallyCompletedAt = at;
    card.updatedAt = at;
    card.kept = true;
    note(card, "complete", at);
    return true;
  }

  /** Lines gone from the chat leave their cards; cards with none of their lines left go. */
  keepOnly(present: Set<string>): boolean {
    const before = JSON.stringify(this.tasks);
    for (const card of this.tasks) card.messageIDs = card.messageIDs.filter((id) => present.has(id));
    this.tasks = this.tasks.filter((card) => card.messageIDs.length > 0);
    return JSON.stringify(this.tasks) !== before;
  }

  private trim() {
    while (this.tasks.length > LIMIT) {
      const at = this.tasks.findIndex((card) => !isActive(card.state));
      this.tasks.splice(at >= 0 ? at : 0, 1);
    }
  }
}

/** `TaskCard.latestMessage`: its latest line that is not the user's (else its latest at all). */
export function latestMessage(card: TaskCard, order: { id: string; role: string }[]): string | null {
  const mine = new Set(card.messageIDs);
  return order.findLast((message) => mine.has(message.id) && message.role !== "user")?.id ?? order.findLast((message) => mine.has(message.id))?.id ?? null;
}
