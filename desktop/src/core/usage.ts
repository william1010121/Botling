// What the bots use (1.x's RateLimits.swift, the Spending part of AppSettings.swift, Workspace+Spending):
// the subscriptions' 5-hour and weekly limits as each CLI last reported them (Claude's `rate_limit_event`
// lines, Codex's `account/rateLimits/updated`), and the cost and tokens each day, by bot. Kept in 1.x's
// files and format: <core>/rate-limits.json, codex-rate-limits.json, spending.json (dates as seconds
// since 2001, JSONEncoder's default). It never holds work back.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./durable/atomic";
import { QuotaError, type QuotaRetriever, type QuotaStatus } from "./quota";
import { toSwiftDate } from "./store/records";

export interface TokenUsage { input: number; output: number; cacheWrite: number; cacheRead: number }
export const noTokens = (): TokenUsage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
export const totalTokens = (tokens: TokenUsage) => tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead;
export const plusTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead });
export const minusTokens = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input - b.input, output: a.output - b.output, cacheWrite: a.cacheWrite - b.cacheWrite, cacheRead: a.cacheRead - b.cacheRead });

/** How much of one limit is used: 0…1, when it starts over and when the reading came (Swift dates). */
export interface RateLimitWindow { used: number; resetsAt?: number; seen: number }
export interface RateLimits { fiveHour?: RateLimitWindow; week?: RateLimitWindow }

const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);
const unixToSwift = (seconds: number) => seconds - 978_307_200;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export const isEmptyLimits = (limits: RateLimits) => !limits.fiveHour && !limits.week;

/** Takes the windows a new reading reports; the others keep their last value (`merge`). */
export function mergeLimits(old: RateLimits, next: RateLimits): RateLimits {
  return { ...(next.fiveHour ?? old.fiveHour ? { fiveHour: next.fiveHour ?? old.fiveHour } : {}), ...(next.week ?? old.week ? { week: next.week ?? old.week } : {}) };
}

/**
 * Claude's `{"type":"rate_limit_event","rate_limit_info":{…,"unifiedWindows":{"five_hour":{…},"seven_day":{…}}}}`
 * (`RateLimits.parse`): `unifiedWindows` carries both; older lines name one (`rateLimitType`), sometimes
 * without `utilization` (then only a "rejected" status says anything: it is used up).
 */
export function claudeRateLimits(object: any, seen: number = toSwiftDate()): RateLimits | null {
  if (object?.type !== "rate_limit_event" || !object.rate_limit_info || typeof object.rate_limit_info !== "object") return null;
  const info = object.rate_limit_info;
  const window = (entry: any): RateLimitWindow | undefined => {
    const used = num(entry?.utilization);
    if (!entry || typeof entry !== "object" || used === null) return undefined;
    const resets = num(entry.resetsAt);
    return { used: clamp01(used), ...(resets === null ? {} : { resetsAt: unixToSwift(resets) }), seen };
  };
  const limits: RateLimits = {};
  if (info.unifiedWindows && typeof info.unifiedWindows === "object") {
    const five = window(info.unifiedWindows.five_hour);
    const week = window(info.unifiedWindows.seven_day);
    if (five) limits.fiveHour = five;
    if (week) limits.week = week;
  }
  const named = info.utilization === undefined && info.status === "rejected" ? { ...info, utilization: 1 } : info;
  if (info.rateLimitType === "five_hour" && !limits.fiveHour) { const five = window(named); if (five) limits.fiveHour = five; }
  if (info.rateLimitType === "seven_day" && !limits.week) { const week = window(named); if (week) limits.week = week; }
  return isEmptyLimits(limits) ? null : limits;
}

/** Codex's `rateLimits` snapshot (`CodexSession.rateLimits`): primary and secondary, a window over a day is the week. */
export function codexRateLimits(snapshot: any, seen: number = toSwiftDate()): RateLimits {
  const limits: RateLimits = {};
  for (const key of ["primary", "secondary"]) {
    const window = snapshot?.[key];
    const used = num(window?.usedPercent);
    if (!window || typeof window !== "object" || used === null) continue;
    const resets = num(window.resetsAt);
    const reading: RateLimitWindow = { used: clamp01(used / 100), ...(resets === null ? {} : { resetsAt: unixToSwift(resets) }), seen };
    const minutes = Math.trunc(num(window.windowDurationMins) ?? 0);
    if (minutes > 24 * 60) limits.week = reading; else limits.fiveHour = reading;
  }
  return limits;
}

/** Codex's token breakdown (`CodexSession.tokens`): cached input counts as read from the cache, not as input. */
export function codexTokens(breakdown: any): TokenUsage {
  const count = (key: string) => Math.trunc(num(breakdown?.[key]) ?? 0);
  const cached = count("cachedInputTokens");
  return { input: Math.max(0, count("inputTokens") - cached), output: count("outputTokens"), cacheWrite: count("cacheWriteInputTokens"), cacheRead: cached };
}

/** The session's cost so far and this turn's tokens, from claude's result line (`StreamEvent.usage`). */
export function claudeUsage(object: any): { totalCost: number; tokens: TokenUsage } | null {
  if (object?.type !== "result") return null;
  const cost = num(object.total_cost_usd);
  if (cost === null) return null;
  const usage = object.usage && typeof object.usage === "object" ? object.usage : {};
  const count = (key: string) => Math.trunc(num(usage[key]) ?? 0);
  return { totalCost: cost, tokens: { input: count("input_tokens"), output: count("output_tokens"), cacheWrite: count("cache_creation_input_tokens"), cacheRead: count("cache_read_input_tokens") } };
}

// ---------------------------------------------------------------------------------------------
// Spending (spending.json)

export interface DayTotal { day: string; spent: number; tokens: TokenUsage }
export interface Spending {
  /** "2026-10-20", in the local time zone. */
  day: string;
  spent: number;
  byBot: Record<string, number>;
  tokens: TokenUsage;
  tokensByBot: Record<string, TokenUsage>;
  /** Earlier days, oldest first (the last 30). */
  history: DayTotal[];
}

const HISTORY_DAYS = 30;

/** "2026-10-20" in the local time zone (`Spending.today`). */
export function today(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export const freshSpending = (day: string): Spending => ({ day, spent: 0, byBot: {}, tokens: noTokens(), tokensByBot: {}, history: [] });

/** A fresh `day`, with this one's totals moved into the history (`rolled(to:)`). */
export function rolled(spending: Spending, day: string): Spending {
  const next = freshSpending(day);
  next.history = [...spending.history];
  if (spending.spent > 0 || totalTokens(spending.tokens) > 0) next.history.push({ day: spending.day, spent: spending.spent, tokens: spending.tokens });
  next.history = next.history.slice(-HISTORY_DAYS);
  return next;
}

/** Adds what a bot spent, starting a new day first if the date moved on (`add`). */
export function addSpending(spending: Spending, amount: number, used: TokenUsage, bot: string, date = new Date()): Spending {
  const day = today(date);
  let next = day === spending.day ? structuredClone(spending) : rolled(spending, day);
  if (totalTokens(used) > 0) {
    next.tokens = plusTokens(next.tokens, used);
    next.tokensByBot[bot] = plusTokens(next.tokensByBot[bot] ?? noTokens(), used);
  }
  if (amount > 0) {
    next.spent += amount;
    next.byBot[bot] = (next.byBot[bot] ?? 0) + amount;
  }
  return next;
}

function readTokens(value: any): TokenUsage {
  const count = (key: string) => Math.trunc(num(value?.[key]) ?? 0);
  return { input: count("input"), output: count("output"), cacheWrite: count("cacheWrite"), cacheRead: count("cacheRead") };
}

/** A file from 1.x (or from before tokens were counted) as this reads it; null when it is not one. */
export function readSpending(value: any): Spending | null {
  if (!value || typeof value !== "object" || typeof value.day !== "string" || num(value.spent) === null || !value.byBot || typeof value.byBot !== "object") return null;
  const byBot: Record<string, number> = {};
  for (const [name, amount] of Object.entries(value.byBot)) if (num(amount) !== null) byBot[name] = amount as number;
  const tokensByBot: Record<string, TokenUsage> = {};
  if (value.tokensByBot && typeof value.tokensByBot === "object") for (const [name, tokens] of Object.entries(value.tokensByBot)) tokensByBot[name] = readTokens(tokens);
  const history = Array.isArray(value.history)
    ? value.history.filter((day: any) => day && typeof day.day === "string" && num(day.spent) !== null).map((day: any) => ({ day: day.day, spent: day.spent, tokens: readTokens(day.tokens) }))
    : [];
  return { day: value.day, spent: value.spent, byBot, tokens: readTokens(value.tokens), tokensByBot, history };
}

function readWindow(value: any): RateLimitWindow | undefined {
  const used = num(value?.used);
  const seen = num(value?.seen);
  if (used === null || seen === null) return undefined;
  const resets = num(value.resetsAt);
  return { used, ...(resets === null ? {} : { resetsAt: resets }), seen };
}

export function readLimits(value: any): RateLimits {
  const limits: RateLimits = {};
  const five = readWindow(value?.fiveHour);
  const week = readWindow(value?.week);
  if (five) limits.fiveHour = five;
  if (week) limits.week = week;
  return limits;
}

/** The usage files, the latest readings kept as 1.x keeps them. */
export class UsageBook {
  private refreshPending?: Promise<void>;
  private lastRefresh = -Infinity;
  quotaStatus: Record<"claude" | "codex", QuotaStatus> = { claude: "missing", codex: "missing" };
  spending: Spending;
  claude: RateLimits;
  codex: RateLimits;
  spendingStatus: import("../contract").UsageView["spendingStatus"];

  constructor(private readonly dir: string, private readonly changed: () => void = () => {}, now = new Date(), private readonly retrieve?: QuotaRetriever) {
    const read = (name: string) => { try { return existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), "utf8")) : null; } catch { return null; } };
    const saved = readSpending(read("spending.json"));
    this.spendingStatus = saved ? "available" : existsSync(join(dir, "spending.json")) ? "unreadable" : "missing";
    const day = today(now);
    this.spending = !saved ? freshSpending(day) : saved.day === day ? saved : rolled(saved, day);
    this.claude = readLimits(read("rate-limits.json"));
    this.codex = readLimits(read("codex-rate-limits.json"));
    for (const engine of ["claude", "codex"] as const) if (!isEmptyLimits(this[engine])) this.quotaStatus[engine] = "available";
  }

  /** Deduplicate concurrent opens and bound provider traffic, including failed requests. */
  refresh(): Promise<void> {
    if (this.refreshPending) return this.refreshPending;
    if (!this.retrieve || Date.now() - this.lastRefresh < 60_000) return Promise.resolve();
    this.lastRefresh = Date.now();
    this.refreshPending = Promise.all((["claude", "codex"] as const).map(async engine => {
      try {
        const limits = await this.retrieve!(engine);
        if (isEmptyLimits(limits)) throw new QuotaError("missing");
        // A read is a complete snapshot; stream events remain incremental in note().
        this[engine] = limits;
        this.quotaStatus[engine] = "available";
        this.save(engine === "claude" ? "rate-limits.json" : "codex-rate-limits.json", limits);
        this.changed();
      } catch (error) {
        this.quotaStatus[engine] = error instanceof QuotaError ? error.status : "network_error";
        this.changed();
      }
    })).then(() => {}).finally(() => { this.refreshPending = undefined; });
    return this.refreshPending;
  }

  /** What a bot (or team) spent: dollars (Claude's) and tokens. */
  record(amount: number, tokens: TokenUsage, by: string, date = new Date()) {
    if (amount <= 0 && totalTokens(tokens) <= 0) return;
    this.spending = addSpending(this.spending, amount, tokens, by, date);
    this.spendingStatus = "available";
    this.save("spending.json", this.spending);
    this.changed();
  }

  /** The latest reading of each limit, Claude's or Codex's (`note(_:)`, `note(codex:)`). */
  note(engine: "claude" | "codex", limits: RateLimits) {
    if (!isEmptyLimits(limits)) this.quotaStatus[engine] = "available";
    const old = engine === "claude" ? this.claude : this.codex;
    const next = mergeLimits(old, limits);
    if (JSON.stringify(next) === JSON.stringify(old)) return;
    if (engine === "claude") this.claude = next; else this.codex = next;
    this.save(engine === "claude" ? "rate-limits.json" : "codex-rate-limits.json", next);
    this.changed();
  }

  /** Today's record, rolled over if the day changed since. */
  view(now = new Date()): { spending: Spending; claude: RateLimits; codex: RateLimits; spendingStatus: import("../contract").UsageView["spendingStatus"]; quotaStatus: Record<"claude" | "codex", QuotaStatus> } {
    const day = today(now);
    if (this.spending.day !== day) this.spending = rolled(this.spending, day);
    return { spending: this.spending, claude: this.claude, codex: this.codex, spendingStatus: this.spendingStatus, quotaStatus: this.quotaStatus };
  }

  private save(name: string, value: unknown) {
    try { writeFileAtomic(join(this.dir, name), JSON.stringify(value)); } catch { /* best effort, as 1.x */ }
  }
}

/** What Settings → Usage shows (dates as ms since 1970): today's bots, most first, and the days before. */
export function usageView(book: { spending: Spending; claude: RateLimits; codex: RateLimits; spendingStatus?: import("../contract").UsageView["spendingStatus"]; quotaStatus?: Record<"claude" | "codex", QuotaStatus> }): import("../contract").UsageView {
  const { spending } = book;
  const names = [...new Set([...Object.keys(spending.byBot), ...Object.keys(spending.tokensByBot)])];
  const byBot = names.map((name) => ({ name: name.slice(0, 200), spent: Math.max(0, spending.byBot[name] ?? 0), tokens: totalTokens(spending.tokensByBot[name] ?? noTokens()) }))
    .sort((a, b) => b.spent - a.spent || b.tokens - a.tokens).slice(0, 500);
  const ms = (swift: number) => Math.round((swift + 978_307_200) * 1000);
  const window = (value: RateLimitWindow | undefined) => (value ? { used: clamp01(value.used), resetsAt: value.resetsAt === undefined ? null : ms(value.resetsAt), seen: ms(value.seen) } : null);
  const limits = (value: RateLimits) => ({ fiveHour: window(value.fiveHour), week: window(value.week) });
  const nonNegative = (tokens: TokenUsage): TokenUsage => ({ input: Math.max(0, tokens.input), output: Math.max(0, tokens.output), cacheWrite: Math.max(0, tokens.cacheWrite), cacheRead: Math.max(0, tokens.cacheRead) });
  return {
    ...(book.quotaStatus ? { quotaStatus: book.quotaStatus } : {}),
    spendingStatus: book.spendingStatus ?? "available",
    day: spending.day.slice(0, 20), spent: Math.max(0, spending.spent), tokens: nonNegative(spending.tokens), byBot,
    history: spending.history.slice(-31).map((day) => ({ day: day.day.slice(0, 20), spent: Math.max(0, day.spent), tokens: Math.max(0, totalTokens(day.tokens)) })),
    claude: limits(book.claude), codex: limits(book.codex),
  };
}
