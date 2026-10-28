import type { BotView, TaskView, UsageView } from "../contract";

export const workerKey = (head: string | null, id: string) => JSON.stringify([head, id]);
export function flowWorkers(bot: BotView, tasks: TaskView[]) {
  const records = bot.delegationRows ?? bot.subagentRows.map(row => ({ ...row, parentId: null }));
  const workers = new Map(records.map(row => {
    const key = workerKey(row.head, row.id);
    return [key, {
      key, id: row.id, title: row.title,
      status: bot.subagentRows.some(item => item.id === row.id && item.head === row.head && item.waitingForNetwork) ? "waiting" : row.status,
      engine: row.head, output: row.outputTokens ?? null,
      attributableOutput: "attributableOutputTokens" in row ? row.attributableOutputTokens ?? null : null, startedAt: row.startedAt,
      endedAt: row.endedAt, direct: row.parentId === null,
      parentId: row.parentId as string | null | undefined,
      parentKey: row.parentId === null ? "coordinator" : workerKey(row.head, row.parentId),
      tasks: [] as { id: string; name: string }[],
    }];
  }));
  for (const task of tasks) for (const agent of task.relatedAgents ?? []) {
    const candidates = [...workers.values()].filter(node => node.id === agent.id);
    const matches = agent.engine === null ? [] : candidates.filter(node => node.engine === agent.engine);
    let node = matches.length === 1 ? matches[0] : undefined;
    if (!node) {
      const key = workerKey(agent.engine, agent.id);
      node = workers.get(key);
      if (!node) {
        if (workers.size >= 500) continue;
        node = { key, id: agent.id, title: agent.title, status: agent.status ?? "unknown", engine: agent.engine,
          output: null, attributableOutput: null, startedAt: 0, endedAt: null, direct: false, parentId: undefined, parentKey: "", tasks: [] };
        workers.set(key, node);
      }
    }
    if (!node.tasks.some(link => link.id === task.id)) node.tasks.push({ id: task.id, name: task.name });
  }
  return [...workers.values()].sort((a, b) => (b.output ?? -1) - (a.output ?? -1));
}
export type FlowWorker = ReturnType<typeof flowWorkers>[number] & { purpose?: FlowPurpose; basis?: "tokens" | "output"; incomplete?: boolean; aggregate?: boolean; count?: number };

/** The legacy ledger is keyed by name, not bot id. Ambiguous names cannot be attributed. */
export function flowLedger(bot: BotView, bots: BotView[], usage: UsageView | null) {
  // Display-name uniqueness today cannot prove historical bot ownership.
  return null;
}

/** Core-normalized buckets are disjoint: Codex cache reads have already been removed from input. */
export function flowTotal(tokens: UsageView["tokens"]): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}
export const flowCount = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);

export type FlowPurpose = "communication" | "execution" | "mixed" | "unknown";
export function flowPurpose(worker: FlowWorker, _workers: FlowWorker[]): FlowPurpose {
  return worker.purpose ?? "unknown";
}
export function purposeTotals(workers: FlowWorker[]) {
  const totals = { communication: { known: 0, measured: 0, unknown: 0 }, execution: { known: 0, measured: 0, unknown: 0 }, mixed: { known: 0, measured: 0, unknown: 0 }, unknown: { known: 0, measured: 0, unknown: 0 } };
  for (const worker of workers) {
    const group = totals[flowPurpose(worker, workers)];
    if (worker.attributableOutput === null || !Number.isSafeInteger(group.known + worker.attributableOutput)) group.unknown++;
    else { group.known += worker.attributableOutput; group.measured++; }
  }
  return totals;
}
export const PURPOSE_BASIS = "Whole metered turns grouped by observed structured activity. Coordination + execution stays mixed; absent or unclassified evidence stays unknown. No role inference or per-tool token split. Input/cache buckets are normalized and counted once. Legacy output is separate and has unknown purpose.";
