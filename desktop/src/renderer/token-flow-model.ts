import type { BotView, TaskView, UsageView } from "../contract";

export function flowWorkers(bot: BotView, tasks: TaskView[]) {
  const workers = new Map(bot.subagentRows.map(row => [row.id, {
    id: row.id, title: row.title, status: row.waitingForNetwork ? "waiting" : row.status,
    engine: row.head, output: row.outputTokens ?? null, startedAt: row.startedAt,
    endedAt: row.endedAt, direct: true, tasks: [] as { id: string; name: string }[],
  }]));
  for (const task of tasks) for (const agent of task.relatedAgents ?? []) {
    let node = workers.get(agent.id);
    if (!node) {
      node = { id: agent.id, title: agent.title, status: agent.status ?? "unknown", engine: agent.engine,
        output: null, startedAt: 0, endedAt: null, direct: false, tasks: [] };
      workers.set(agent.id, node);
    }
    if (!node.tasks.some(link => link.id === task.id)) node.tasks.push({ id: task.id, name: task.name });
  }
  return [...workers.values()].sort((a, b) => (b.output ?? -1) - (a.output ?? -1));
}

/** The legacy ledger is keyed by name, not bot id. Ambiguous names cannot be attributed. */
export function flowLedger(bot: BotView, bots: BotView[], usage: UsageView | null) {
  if (!usage || usage.spendingStatus !== "available") return null;
  if (bots.filter(candidate => candidate.name === bot.name).length !== 1) return null;
  return usage.byBot.find(row => row.name === bot.name)?.breakdown ?? null;
}

/** Core-normalized buckets are disjoint: Codex cache reads have already been removed from input. */
export function flowTotal(tokens: UsageView["tokens"]): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}
export const flowCount = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
