// A bot's heads (Claude, Codex, or both in one chat) and the hand-offs between them, ported from
// the Swift app's Heads.swift and Conductor.swift. Pure bookkeeping: bot.ts says what happened,
// the conductor says what to do (work for a head, a line or a card in the chat, the rounds line).
//
// Kept in bot.json's `heads` key in 1.x's format ({engines, answerWith, limits, handoffs,
// codexModel}), so a bot set up in 1.x keeps its heads here.
import { randomUUID } from "node:crypto";
import { characterCount, characterPrefix } from "./briefing";

export type Engine = "claude" | "codex" | "agy";
export type AnswerTarget = Engine | "both";
export const ENGINES: Engine[] = ["claude", "codex", "agy"];
export const displayName = (engine: Engine) => (engine === "agy" ? "Antigravity" : engine === "claude" ? "Claude" : "Codex");
export const isEngine = (value: unknown): value is Engine => value === "claude" || value === "codex" || value === "agy";
export const otherHead = (engine: Engine, heads?: Heads): Engine => heads?.engines.find(candidate => candidate !== engine) ?? (engine === "claude" ? "codex" : "claude");

export interface RoundLimits {
  discussion: number;
  review: number;
  handoffs: number;
  /** ask: a card with both sides; useDoers: the latest version stands. */
  atLimit: "ask" | "useDoers";
}
export const DEFAULT_LIMITS: RoundLimits = { discussion: 3, review: 2, handoffs: 6, atLimit: "ask" };

export interface Heads {
  /** Claude first; never empty. */
  engines: Engine[];
  answerWith: AnswerTarget;
  limits: RoundLimits;
  handoffs: boolean;
  /** The Codex model (`model/list`'s id); null: Codex's own default. */
  codexModel: string | null;
}

const clamp = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(10, Math.max(1, Math.trunc(value))) : fallback;

export function makeHeads(engines: Engine[], answerWith: AnswerTarget = "both", rest: Partial<Omit<Heads, "engines" | "answerWith">> = {}): Heads {
  // Restore old mixed configurations as single agy; never start an unvalidated partner.
  const kept = engines.includes("agy") ? ["agy" as Engine] : ENGINES.filter((engine) => engines.includes(engine)).slice(0, 2);
  const heads: Heads = { engines: kept.length ? kept : ["claude"], answerWith, limits: rest.limits ?? { ...DEFAULT_LIMITS }, handoffs: rest.handoffs ?? true, codexModel: rest.codexModel ?? null };
  heads.answerWith = fitted(heads, answerWith);
  return heads;
}

export const singleHead = (engine: Engine): Heads => makeHeads([engine], engine);
export const hasTwo = (heads: Heads) => heads.engines.length > 1;

/** What can be picked: both (with two heads), or one by name. */
export function targets(heads: Heads): AnswerTarget[] {
  return [...(hasTwo(heads) ? (["both"] as AnswerTarget[]) : []), ...heads.engines];
}

/** `target`, or the nearest one this bot has. */
export function fitted(heads: Heads, target: AnswerTarget): AnswerTarget {
  const all = targets(heads);
  return all.includes(target) ? target : all[0]!;
}

/** The heads a message to `target` goes to, in the order they answer. */
export function headsFor(heads: Heads, target: AnswerTarget): Engine[] {
  const t = fitted(heads, target);
  return t === "both" ? heads.engines : [t];
}

/** `HeadsSettings(from:)`: bot.json's `heads`, read as text, so an unknown value leaves the rest readable. */
export function readHeads(value: unknown, engine: unknown): Heads {
  const single = singleHead(isEngine(engine) ? engine : "claude");
  if (!value || typeof value !== "object" || Array.isArray(value)) return single;
  const raw = value as Record<string, unknown>;
  const engines = Array.isArray(raw.engines) ? raw.engines.filter(isEngine) : [];
  const target = raw.answerWith === "both" || isEngine(raw.answerWith) ? raw.answerWith : "both";
  const limits = raw.limits && typeof raw.limits === "object" ? (raw.limits as Record<string, unknown>) : {};
  return makeHeads(engines, target, {
    limits: {
      discussion: clamp(limits.discussion, DEFAULT_LIMITS.discussion),
      review: clamp(limits.review, DEFAULT_LIMITS.review),
      handoffs: clamp(limits.handoffs, DEFAULT_LIMITS.handoffs),
      atLimit: limits.atLimit === "useDoers" ? "useDoers" : "ask",
    },
    handoffs: typeof raw.handoffs === "boolean" ? raw.handoffs : true,
    codexModel: typeof raw.codexModel === "string" ? raw.codexModel : null,
  });
}

/** As 1.x's encoder writes it. */
export function headsJSON(heads: Heads): Record<string, unknown> {
  return {
    engines: heads.engines, answerWith: heads.answerWith, limits: heads.limits, handoffs: heads.handoffs,
    ...(heads.codexModel ? { codexModel: heads.codexModel } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// HeadTags: <handoff to="codex" kind="review" decision="UUID">what to do</handoff>

export type HandoffKind = "task" | "review" | "discuss";
export interface Handoff { to: Engine; kind: HandoffKind; task: string; decisionId: string | null }

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/** Swift's `trimmingCharacters(in: .whitespacesAndNewlines)`. */
const trim = (text: string) => text.replace(/^[\s\u0085\u2028\u2029]+|[\s\u0085\u2028\u2029]+$/gu, "");

/** `HeadTags.parse`: the first hand-off tag in `text`, and the text without it. */
export function parseHeadTags(text: string): { body: string; handoff: Handoff | null } {
  const match = /<handoff\b([^>]*)>([\s\S]*?)<\/handoff>/.exec(text);
  if (!match) return { body: trim(text), handoff: null };
  const attributes = match[1]!;
  const attribute = (name: string) => new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attributes)?.[1] ?? null;
  const body = text.slice(0, match.index) + text.slice(match.index + match[0].length);
  const task = trim(match[2]!);
  const to = attribute("to")?.toLowerCase();
  let handoff: Handoff | null = null;
  if (isEngine(to) && task) {
    const kind = attribute("kind")?.toLowerCase();
    const decision = attribute("decision");
    handoff = {
      to, task,
      kind: kind === "review" || kind === "discuss" || kind === "task" ? kind : "task",
      decisionId: decision && UUID_RE.test(decision) ? decision.toUpperCase() : null,
    };
  }
  return { body: trim(body), handoff };
}

// ---------------------------------------------------------------------------------------------
// What one head is told about the other (Bot.swift)

export const wordsNote = (head: Engine, words: string) => `(App: ${displayName(head)}, working on this too, says: ${words})`;

export function saidNote(head: Engine, text: string, steps: { kind: string; title: string }[] = []): string {
  const did = steps.filter((step) => step.kind === "tool").slice(0, 8).map((step) => step.title);
  const extra = did.length ? `\n(${displayName(head)} did: ${did.join("; ")})` : "";
  return `(App: ${displayName(head)}, this bot's other head, replied in this chat:)\n${text}${extra}`;
}

export const forOtherNote = (named: Engine, said: string) => `(App: The user wrote this to ${displayName(named)} only; you need not answer it:)\n${said}`;

/** `Bot.asNote`: a rule of the system prompt ("- …") as a note from the app. */
export const asNote = (rule: string) => `(App: ${rule.replace(/^[- ]+|[- ]+$/g, "")})`;

// ---------------------------------------------------------------------------------------------
// The conductor

export interface RoundsProgress { kind: "discussion" | "review" | "handoff"; round: number; limit: number }
export function roundsText(progress: RoundsProgress): string {
  return progress.kind === "discussion" ? `Round ${progress.round} of ${progress.limit}`
    : progress.kind === "review" ? `Review round ${progress.round} of ${progress.limit}`
    : `Hand-off ${progress.round} of ${progress.limit}`;
}

export interface HandoffRecord {
  id: string;
  /** All hops descended from one assignment share it (Stop stops the chain). */
  chainId: string;
  from: Engine;
  to: Engine;
  kind: HandoffKind;
  task: string;
  origin: string | null;
  message: number;
  round: number;
  limit: number;
  state: "running" | "waiting" | "done" | "stopped";
  lines: { who: Engine; text: string }[];
}
export const isActive = (record: HandoffRecord) => record.state === "running" || record.state === "waiting";

export type CardPick = { goWith: Engine } | { oneMoreRound: true };
export type ConductorAction =
  | { type: "ask"; head: Engine; text: string; handoffId: string | null }
  | { type: "line"; text: string }
  | { type: "card"; text: string; choices: { label: string; pick: CardPick }[] }
  | { type: "progress"; progress: RoundsProgress | null };

const RECORD_LIMIT = 12;

/** `Conductor.excerpt`: one line, at most `limit` characters. */
export function excerpt(text: string, limit: number): string {
  const line = text.split(/[\n\r\u000B\u000C\u0085\u2028\u2029]+/).map((part) => part.replace(/^[ \t]+|[ \t]+$/g, "")).filter(Boolean).join(" ");
  return characterCount(line) > limit ? `${characterPrefix(line, limit)}…` : line;
}
function short(text: string): string {
  const line = text.split(/[\n\r\u000B\u000C\u0085\u2028\u2029]/).find((part) => part.length) ?? text;
  return characterCount(line) > 200 ? `${characterPrefix(line, 200)}…` : line;
}
const firstLine = (text: string) => text.split(/[\n\r\u000B\u000C\u0085\u2028\u2029]/).find((part) => part.length) ?? text;

export function handedNote(from: Engine, handoff: Pick<Handoff, "kind" | "task">, count: number, limit: number): string {
  const what = handoff.kind === "task" ? "hands you this" : handoff.kind === "review" ? "asks you to review this" : "wants your view on this";
  return `(App: ${displayName(from)}, this bot's other head, ${what} (hand-off ${count} of ${limit} for the user's latest message):\n${handoff.task}\n\nDo it, then reply with the result; the app gives your reply back to ${displayName(from)}.)`;
}
export function handBackNote(from: Engine, reply: string): string {
  if (!reply) return `(App: ${displayName(from)} finished what you handed over without a user-facing reply. Continue if work remains; otherwise reply only <no-reply/>.)`;
  return `(App: ${displayName(from)} finished what you handed over. Its reply:\n${reply}\n\nCarry on from there, and tell the user what came of it.)`;
}
export const limitReachedNote = (other: Engine) =>
  `(App: The hand-offs for the user's latest message are used up; ${displayName(other)} was not asked. Your latest version stands: tell the user in a sentence or two where things are and what is left.)`;
export const WENT_WITH = "(App: The user went with your version. If something in it is still to be done, do it now and say what came of it; if not, reply only <no-reply/>.)";

/**
 * `Conductor`: per user message at most `limits.handoffs` hand-offs, of them `limits.review`
 * reviews and `limits.discussion` discussion rounds; a reply to handed work goes back to the head
 * that handed it.
 */
export class Conductor {
  private counts: Partial<Record<HandoffKind, number>> = {};
  private total = 0;
  private extra: Partial<Record<HandoffKind, number>> = {};
  private extraTotal = 0;
  private handedBy: Partial<Record<Engine, Engine[]>> = {};
  private latest: Partial<Record<Engine, string>> = {};
  private blocked: { from: Engine; handoff: Handoff; chainId: string | null } | null = null;
  private stopped = false;
  records: HandoffRecord[] = [];
  private pendingRecords: Partial<Record<Engine, string[]>> = {};
  private origin: string | null = null;
  private messageCount = 0;

  constructor(public settings: Heads) {}

  get isRunning(): boolean {
    return Object.values(this.handedBy).some((list) => list && list.length > 0);
  }

  userMessage(text?: string): ConductorAction[] {
    this.messageCount += 1;
    const cut = text === undefined ? null : excerpt(text, 280);
    this.origin = cut ? cut : null;
    this.records = this.records.filter(isActive);
    this.counts = {};
    this.total = 0;
    this.extra = {};
    this.extraTotal = 0;
    this.blocked = null;
    this.stopped = false;
    return [];
  }

  /** "Stop now": no more hand-offs for this message. */
  stopAll(): ConductorAction[] {
    for (const record of this.records) if (isActive(record)) record.state = "stopped";
    this.pendingRecords = {};
    if (!this.isRunning && !this.blocked) return [];
    this.handedBy = {};
    this.blocked = null;
    this.stopped = true;
    return [{ type: "progress", progress: null }, { type: "line", text: "Stopped by you" }];
  }

  /** Stops the selected assignment's chain. */
  stop(id: string): ConductorAction[] {
    const record = this.records.find((candidate) => candidate.id === id && isActive(candidate));
    if (!record) return [];
    const chain = record.chainId;
    if (this.blocked?.chainId === chain) this.blocked = null;
    for (const other of this.records) {
      if (other.chainId === chain && isActive(other)) {
        other.state = "stopped";
        this.removeReturnRoute(other.id, other.to);
      }
    }
    return [{ type: "progress", progress: this.remainingProgress() }, { type: "line", text: "Stopped by you" }];
  }

  private remainingProgress(): RoundsProgress | null {
    const record = this.records.findLast(isActive);
    if (!record) return null;
    return { kind: record.kind === "task" ? "handoff" : record.kind === "review" ? "review" : "discussion", round: record.round, limit: record.limit };
  }

  private removeReturnRoute(id: string, head: Engine) {
    const position = this.pendingRecords[head]?.indexOf(id) ?? -1;
    if (position < 0) return;
    this.pendingRecords[head]!.splice(position, 1);
    this.handedBy[head]?.splice(position, 1);
  }

  /** A head's reply was shown. `handed`: its turn did work the other head handed it. */
  replied(head: Engine, text: string, handoff: Handoff | null, handed: boolean, handoffId: string | null = null): ConductorAction[] {
    if (handoffId && !this.records.some((record) => record.id === handoffId && isActive(record))) return [];
    if (text) this.latest[head] = text;
    const out: ConductorAction[] = [];
    for (const record of this.records) {
      if (handed && record.from === head && record.state === "waiting" && (!handoffId || record.id === handoffId)) {
        record.state = "done";
        if (text) record.lines.push({ who: head, text });
      }
    }
    if (handed) {
      const id = handoffId ?? this.pendingRecords[head]?.at(-1) ?? null;
      const record = id ? this.records.find((candidate) => candidate.id === id && candidate.to === head && candidate.state === "running") : undefined;
      if (record) {
        this.removeReturnRoute(record.id, head);
        record.state = "waiting";
        if (text) record.lines.push({ who: head, text });
        out.push({ type: "ask", head: record.from, text: handBackNote(head, text), handoffId: record.id });
      }
    }
    if (!this.stopped && handoff && handoff.to !== head && (this.settings.handoffs || !this.settings.engines.includes(handoff.to))) {
      const chain = handoffId ? this.records.find((record) => record.id === handoffId)?.chainId ?? null : null;
      out.push(...this.handOff(head, handoff, chain));
    } else if (!this.isRunning) {
      out.push({ type: "progress", progress: null });
    }
    return out;
  }

  picked(pick: CardPick): ConductorAction[] {
    if ("goWith" in pick) {
      this.blocked = null;
      return [{ type: "progress", progress: null }, { type: "line", text: `You went with ${displayName(pick.goWith)}'s` }, { type: "ask", head: pick.goWith, text: WENT_WITH, handoffId: null }];
    }
    const stopped = this.blocked;
    if (!stopped) return [];
    this.blocked = null;
    this.extra[stopped.handoff.kind] = (this.extra[stopped.handoff.kind] ?? 0) + 1;
    this.extraTotal += 1;
    return this.handOff(stopped.from, stopped.handoff, stopped.chainId);
  }

  private limit(kind: HandoffKind): number | null {
    const base = kind === "task" ? null : kind === "review" ? this.settings.limits.review : this.settings.limits.discussion;
    return base === null ? null : base + (this.extra[kind] ?? 0);
  }

  private handOff(from: Engine, handoff: Handoff, chainId: string | null): ConductorAction[] {
    const kindLimit = this.limit(handoff.kind);
    const totalLimit = this.settings.limits.handoffs + this.extraTotal;
    const done = this.counts[handoff.kind] ?? 0;
    if (this.total >= totalLimit || (kindLimit !== null && done >= kindLimit)) {
      return this.atLimit(from, handoff, kindLimit === null || this.total >= totalLimit ? this.total : done, chainId);
    }
    this.counts[handoff.kind] = done + 1;
    this.total += 1;
    (this.handedBy[handoff.to] ??= []).push(from);
    const progress: RoundsProgress = handoff.kind === "task" ? { kind: "handoff", round: this.total, limit: totalLimit }
      : handoff.kind === "review" ? { kind: "review", round: this.counts.review ?? 1, limit: kindLimit ?? 1 }
      : { kind: "discussion", round: this.counts.discuss ?? 1, limit: kindLimit ?? 1 };
    const id = randomUUID().toUpperCase();
    const record: HandoffRecord = {
      id, chainId: chainId ?? id, from, to: handoff.to, kind: handoff.kind, task: handoff.task, origin: this.origin, message: this.messageCount,
      round: progress.round, limit: progress.limit, state: "running", lines: [{ who: from, text: handoff.task }],
    };
    this.records.push(record);
    while (this.records.length > RECORD_LIMIT) {
      const ended = this.records.findIndex((candidate) => !isActive(candidate));
      if (ended < 0) break;
      this.records.splice(ended, 1);
    }
    (this.pendingRecords[handoff.to] ??= []).push(id);
    return [
      { type: "line", text: `${displayName(from)} → ${displayName(handoff.to)}: ${firstLine(handoff.task)}` },
      { type: "progress", progress },
      { type: "ask", head: handoff.to, text: handedNote(from, handoff, this.total, totalLimit), handoffId: id },
    ];
  }

  private atLimit(from: Engine, handoff: Handoff, done: number, chainId: string | null): ConductorAction[] {
    if (this.settings.limits.atLimit === "ask") {
      this.blocked = { from, handoff, chainId };
      const lead = handoff.kind === "task" ? `${done} hand-offs for this message: the limit.`
        : handoff.kind === "review" ? `${done} review rounds done.` : `${done} rounds done. They still disagree.`;
      const sides = this.settings.engines.flatMap((head) => (this.latest[head] !== undefined ? [`${displayName(head)}: ${short(this.latest[head]!)}`] : [])).join("\n");
      return [
        { type: "progress", progress: null },
        {
          type: "card", text: lead + (sides ? `\n\n${sides}` : ""),
          choices: [...this.settings.engines.map((head) => ({ label: `Go with ${displayName(head)}'s`, pick: { goWith: head } as CardPick })), { label: "One more round", pick: { oneMoreRound: true } }],
        },
      ];
    }
    return [
      { type: "progress", progress: null },
      { type: "line", text: `Hand-off limit reached (${done} for this message): not handed to ${displayName(handoff.to)}` },
      { type: "ask", head: from, text: limitReachedNote(handoff.to), handoffId: null },
    ];
  }
}
