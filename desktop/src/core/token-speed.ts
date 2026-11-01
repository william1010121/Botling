/**
 * ONE definition of "token speed", used by every path (Claude, Codex, Antigravity; subagents and
 * the main head). It is the token-speed CLI's definition:
 *
 *   tok/s = sum(output tokens) / sum(model generation seconds)
 *
 * - tokens and seconds are summed SEPARATELY, then divided (never an average of speeds);
 * - one request is one model call: its tokens, and its own start -> last token seconds;
 * - a request taking more than MAX_REQUEST_SECONDS is excluded from both sums (the CLI's
 *   `--max-gap 300`: a stall is not generation, and a clamp would invent a duration);
 * - incomplete requests (no final usage, interrupted) are excluded from both sums;
 * - only OUTPUT tokens (reasoning included, as the engines report them). Input and cache tokens are
 *   never summed into speed.
 *
 * Per-engine data (what each engine really gives us):
 * - Claude: stream_event message_start .. message_stop of each request, final usage from
 *   message_delta. Start is the boundary that fed the model (our message / the tool result).
 * - Codex: `thread/tokenUsage/updated` `last.outputTokens` is one request; its start is the
 *   boundary that fed the model (turn start, or the last tool item that completed).
 * - Antigravity (ACP): only `session/prompt` -> result with ONE usage block for the whole prompt
 *   turn. ACP gives no per-request timing, so the sample is the whole prompt turn (tool time
 *   included) and is marked `estimated`; nothing finer is invented.
 */

/**
 * Output tokens of one assistant content array, estimated from its size (about 4 characters per
 * token). The `usage.output_tokens` on a subagent's complete `assistant` line is the count from when
 * its block began (40 against 463 measured), so a long message is far under-counted by it alone.
 */
export function estimateContentTokens(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") chars += block.text.length;
    else if (typeof block.thinking === "string") chars += block.thinking.length;
    else if (block.type === "tool_use") chars += String(block.name ?? "").length + JSON.stringify(block.input ?? {}).length;
  }
  return Math.ceil(chars / 4);
}

/** The CLI's `--max-gap` default. */
export const MAX_REQUEST_SECONDS = 300;

/** One model request. Times are epoch milliseconds. */
export interface SpeedSample {
  outputTokens: number;
  startMs: number;
  endMs: number;
  /** False: no final usage / interrupted. Never timed. */
  complete: boolean;
}

/** A request as a stream reports it. `scope` null is the head turn; a string is a subagent id. */
export interface RequestEvent {
  scope: string | null;
  id: string;
  sample: SpeedSample;
  /** Best-defined value, not per-request timing (Antigravity). */
  estimated?: boolean;
}

/** Persistable running sums (a child's record keeps these, so a restart does not lose them). */
export interface SpeedTotals {
  /** Output tokens of the timed requests. */
  tokens: number;
  /** Generation seconds of the timed requests. */
  seconds: number;
  /** How many requests were timed. */
  timed: number;
  /** True when any contributing request was a whole-turn estimate. */
  estimated?: boolean;
}

export interface TokenSpeed extends SpeedTotals {
  tokPerSec: number | null;
  requests: number;
  excluded: number;
}

export const emptyTotals = (): SpeedTotals => ({ tokens: 0, seconds: 0, timed: 0 });

/** The seconds a sample contributes, or null when it is not timed (the rule shared by every path). */
export function generationSeconds(sample: SpeedSample): number | null {
  if (!sample.complete) return null;
  if (!Number.isFinite(sample.outputTokens) || sample.outputTokens <= 0) return null;
  if (!Number.isFinite(sample.startMs) || !Number.isFinite(sample.endMs)) return null;
  const seconds = (sample.endMs - sample.startMs) / 1000;
  return seconds > 0 && seconds <= MAX_REQUEST_SECONDS ? seconds : null;
}

export function addSample(totals: SpeedTotals | undefined, sample: SpeedSample, estimated = false): SpeedTotals {
  const base = totals ?? emptyTotals();
  const seconds = generationSeconds(sample);
  if (seconds === null) return base;
  return { tokens: base.tokens + sample.outputTokens, seconds: base.seconds + seconds, timed: base.timed + 1, ...(estimated || base.estimated ? { estimated: true } : {}) };
}

/** Tokens per second of the sums, or null without timed data. */
export function speedOf(totals: SpeedTotals | undefined | null): number | null {
  if (!totals || !(totals.seconds > 0) || !(totals.tokens > 0)) return null;
  const value = totals.tokens / totals.seconds;
  return Number.isFinite(value) ? value : null;
}

/** The pure function: tokens summed, seconds summed, then divided. */
export function computeTokenSpeed(samples: readonly SpeedSample[]): TokenSpeed {
  const totals = samples.reduce<SpeedTotals>((sum, sample) => addSample(sum, sample), emptyTotals());
  return { ...totals, tokPerSec: speedOf(totals), requests: samples.length, excluded: samples.length - totals.timed };
}

/** What a view carries: null when there is nothing timed yet. */
export function speedView(totals: SpeedTotals | undefined | null): { tokPerSec: number; estimated: boolean } | null {
  const value = speedOf(totals);
  return value === null ? null : { tokPerSec: value, estimated: totals?.estimated === true };
}

/** Reads persisted sums defensively (a record is JSON from disk). */
export function readTotals(value: unknown): SpeedTotals | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!ok(raw.tokens) || !ok(raw.seconds) || !ok(raw.timed)) return undefined;
  return { tokens: raw.tokens, seconds: raw.seconds, timed: raw.timed, ...(raw.estimated === true ? { estimated: true } : {}) };
}

/** Where a request began: the last moment something was handed to the model, per scope. */
export class RequestTimer {
  private marks = new Map<string, number>();
  private key = (scope: string | null) => scope ?? "";
  boundary(scope: string | null, atMs: number) { this.marks.set(this.key(scope), atMs); }
  peek(scope: string | null): number | undefined { return this.marks.get(this.key(scope)); }
  /** The boundary a request starts from, used once. */
  take(scope: string | null): number | undefined {
    const at = this.marks.get(this.key(scope));
    this.marks.delete(this.key(scope));
    return at;
  }
}

/**
 * Claude's stream-json (`--include-partial-messages`): feed every raw line's object with the time it
 * arrived. A request is message_start .. message_stop of one message id; its final output_tokens is
 * the last message_delta's (the `assistant` events carry a stale count: 40 against 463 measured).
 */
export class ClaudeRequestTracker {
  private timer = new RequestTimer();
  private open = new Map<string, { id: string; startMs: number; tokens: number; final: boolean }>();
  private key = (scope: string | null) => scope ?? "";
  /** Scopes that stream real message_start..stop events: they need no estimate from `assistant` lines. */
  private streamed = new Set<string>();
  /** A subagent's complete `assistant` lines of one message, awaiting the line that closes the message. */
  private lines = new Map<string, { id: string; startMs: number; endMs: number; reported: number; estimated: number }>();

  private flush(scope: string | null): RequestEvent[] {
    const k = this.key(scope);
    const line = this.lines.get(k);
    if (!line) return [];
    this.lines.delete(k);
    return [{ scope, id: line.id, estimated: true, sample: { outputTokens: Math.max(line.reported, line.estimated), startMs: line.startMs, endMs: line.endMs, complete: true } }];
  }

  /** Our message went to Claude (or a tool result came back): the next request starts here. */
  boundary(scope: string | null, atMs: number) { this.timer.boundary(scope, atMs); }

  observe(message: any, nowMs: number): RequestEvent[] {
    if (!message || typeof message !== "object") return [];
    const scope = typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id ? message.parent_tool_use_id : null;
    if (message.type === "system" && message.subtype === "task_started" && typeof message.tool_use_id === "string") {
      this.timer.boundary(message.tool_use_id, nowMs);
      return [];
    }
    if (message.type === "system" && message.subtype === "task_notification") {
      const id = typeof message.tool_use_id === "string" ? message.tool_use_id : typeof message.task_id === "string" ? message.task_id : null;
      return id ? this.flush(id) : [];
    }
    if (message.type === "user") {
      const flushed = this.flush(scope);
      this.timer.boundary(scope, nowMs);
      return flushed;
    }
    if (message.type === "assistant" && scope !== null && !this.streamed.has(this.key(scope))) {
      // No per-request events for this subagent: one estimated request per message id, from its lines.
      const id = message.message?.id;
      if (typeof id !== "string" || !id) return [];
      const reported = message.message?.usage?.output_tokens;
      const out = this.lines.get(this.key(scope))?.id === id ? [] : this.flush(scope);
      const line = this.lines.get(this.key(scope)) ?? { id, startMs: this.timer.take(scope) ?? nowMs, endMs: nowMs, reported: 0, estimated: 0 };
      line.endMs = nowMs;
      if (typeof reported === "number" && Number.isFinite(reported)) line.reported = Math.max(line.reported, reported);
      line.estimated += estimateContentTokens(message.message?.content);
      this.lines.set(this.key(scope), line);
      return out;
    }
    if (message.type !== "stream_event") return [];
    const event = message.event;
    const out: RequestEvent[] = [];
    const k = this.key(scope);
    if (event?.type === "message_start") {
      this.streamed.add(k);
      const stale = this.open.get(k);
      if (stale) out.push(this.finish(scope, stale, nowMs, false));
      const id = event.message?.id;
      const first = event.message?.usage?.output_tokens;
      this.open.set(k, { id: typeof id === "string" && id ? id : `${k}@${nowMs}`, startMs: this.timer.take(scope) ?? nowMs, tokens: typeof first === "number" ? first : 0, final: false });
    } else if (event?.type === "message_delta") {
      const request = this.open.get(k);
      const tokens = event.usage?.output_tokens;
      if (request && typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0) { request.tokens = tokens; request.final = true; }
    } else if (event?.type === "message_stop") {
      const request = this.open.get(k);
      if (request) out.push(this.finish(scope, request, nowMs, request.final));
    }
    return out;
  }

  private finish(scope: string | null, request: { id: string; startMs: number; tokens: number }, endMs: number, complete: boolean): RequestEvent {
    this.open.delete(this.key(scope));
    return { scope, id: request.id, sample: { outputTokens: request.tokens, startMs: request.startMs, endMs, complete } };
  }
}

/**
 * Codex app-server notifications. `thread/tokenUsage/updated` arrives once per finished request with
 * `last` = that request's usage. A repeat of the same running total is not a new request.
 */
export class CodexRequestTracker {
  private timer = new RequestTimer();
  private totals = new Map<string, number>();

  observe(scope: string | null, method: string, params: any, nowMs: number): RequestEvent[] {
    if (method === "turn/started") { this.timer.boundary(scope, nowMs); return []; }
    if (method === "item/completed") {
      // Words and thoughts are the model's own output; anything else came back from outside.
      const type = params?.item?.type;
      if (type !== "agentMessage" && type !== "reasoning") this.timer.boundary(scope, nowMs);
      return [];
    }
    if (method !== "thread/tokenUsage/updated") return [];
    const usage = params?.tokenUsage;
    const last = usage?.last?.outputTokens;
    const total = usage?.total?.outputTokens;
    if (typeof last !== "number" || !Number.isFinite(last) || last <= 0) return [];
    const thread = typeof params.threadId === "string" ? params.threadId : "";
    const key = `${scope ?? ""}|${thread}`;
    if (typeof total === "number") {
      if (this.totals.get(key) === total) return [];
      this.totals.set(key, total);
    }
    const startMs = this.timer.take(scope) ?? nowMs;
    // The request is over now: what follows starts at the next boundary, not at this update.
    return [{ scope, id: `${thread}:${typeof total === "number" ? total : nowMs}`, sample: { outputTokens: last, startMs, endMs: nowMs, complete: true } }];
  }
}

/**
 * Antigravity: ACP reports ONE usage block for a whole `session/prompt` and no per-request timing.
 * The sample is that prompt turn (tool and approval waits inside it count), so it is an estimate.
 */
export function agyPromptRequest(id: string, usage: unknown, startMs: number, endMs: number, completed: boolean): RequestEvent | null {
  if (!usage || typeof usage !== "object") return null;
  const raw = usage as Record<string, unknown>;
  const count = (key: string) => (typeof raw[key] === "number" && Number.isSafeInteger(raw[key]) && (raw[key] as number) >= 0 ? (raw[key] as number) : 0);
  const outputTokens = count("outputTokens") + count("thoughtTokens");
  return { scope: null, id, estimated: true, sample: { outputTokens, startMs, endMs, complete: completed } };
}
