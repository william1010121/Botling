// Usage, speed and token-flow measurements of a worker's run, one copy (shared-core spec 2.4). One output counter
// for every engine, `thread:<conversation>:run<n>` = this run's output so far, so exclusiveOutputTokens and the
// token-flow provenance (both read `thread:` keys) can attribute every engine's worker tokens.
import type { CodexItem } from "../agent/codex";
import type { WorkerEvent } from "./events";

/**
 * Claude-style running totals (dollars for a process so far) as this turn's spend. One helper for head and workers.
 * The total never goes back within a process; a new process needs a new state ({ last: 0 }).
 */
export function costDelta(state: { last: number }, total: number): number {
  if (!Number.isFinite(total)) return 0;
  const spent = Math.max(0, total - state.last);
  state.last = Math.max(state.last, total);
  return spent;
}

/**
 * The output counter of a worker's run. A run resumed after a restart counts its next segment on a counter of its own
 * (`segment` 1, 2, …): the counters add up, so what it said before the restart is never counted under again.
 */
export const runCounter = (conversationId: string | null, workerId: string, run: number, segment = 0) =>
  `thread:${conversationId ?? workerId}:run${run}${segment ? `:part${segment + 1}` : ""}`;

export class RunAccounting {
  private output = 0;

  constructor(private ids: { workerId: string; run: number; segment?: number; conversationId(): string | null; parentThreadId(): string | null }) {}

  /** usage → [usage item (cost = delta), subagentOutput item (this run's output so far)] */
  usage(e: Extract<WorkerEvent, { type: "usage" }>): CodexItem[] {
    const items: CodexItem[] = [{ kind: "usage", totalCost: Number.isFinite(e.cost) && e.cost > 0 ? e.cost : 0, tokens: e.tokens }];
    if (Number.isSafeInteger(e.tokens.output) && e.tokens.output > 0) {
      this.output += e.tokens.output;
      items.push({ kind: "subagentOutput", id: this.ids.workerId, counter: runCounter(this.ids.conversationId(), this.ids.workerId, this.ids.run, this.ids.segment), tokens: this.output });
    }
    return items;
  }

  /** request → request item with scope = workerId */
  request(e: Extract<WorkerEvent, { type: "request" }>): CodexItem {
    return { kind: "request", request: { ...e.request, scope: this.ids.workerId } };
  }

  /** measurement → measurement item with workerId (prefixed for nested ids), run, parentThreadId */
  measurement(e: Extract<WorkerEvent, { type: "measurement" }>): CodexItem {
    const { workerId, parentThreadId, ...rest } = e.measurement;
    return { kind: "measurement", provider: e.provider, measurement: {
      ...rest, workerId: workerId ? `${this.ids.workerId}:${workerId}` : this.ids.workerId, run: this.ids.run,
      parentThreadId: parentThreadId ?? this.ids.parentThreadId(),
    } };
  }

  get outputTokens(): number { return this.output; }
}
