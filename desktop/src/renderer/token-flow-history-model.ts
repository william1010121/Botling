import type { BotView, TaskView, TokenFlowHistoryView } from "../contract";
import { flowWorkers, flowPurpose, purposeTotals, type FlowPurpose, type FlowWorker } from "./token-flow-model";
import type { FlowEdge } from "./token-flow-layout";
export type FlowPeriod = "all" | "today" | "7d";
export interface WorkGroup { id: string; name: string; workers: FlowWorker[]; known: number; unknown: number }
export interface AllocationEdge extends FlowEdge { value: number | null; purpose: FlowPurpose }
export const PURPOSE_NAMES = { communication: "Communication", execution: "Execution", mixed: "Mixed", unknown: "Unknown" };

export function historyWorkers(bot: BotView, history: TokenFlowHistoryView | null, fallback: TaskView[]) {
  if (!history) return flowWorkers(bot, fallback);
  const tasks: TaskView[] = history.tasks.map(task => ({ id: task.id, name: task.name, state: "done", owner: null, now: null, next: null, blocked: null,
    messageIds: [], updatedAt: "", atWork: false, relatedAgents: task.workers.map(worker => ({ id: worker.id, title: "Unreported worker", engine: worker.head, status: null, available: false, run: null })) }));
  return flowWorkers({ ...bot, delegationRows: history.rows }, tasks);
}
export function periodWorkers(workers: FlowWorker[], period: FlowPeriod, now: number) {
  if (period === "all") return workers;
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (period === "7d") start.setDate(start.getDate() - 6);
  return workers.flatMap(worker => {
    if (worker.endedAt !== null && worker.endedAt < start.getTime() && worker.startedAt > 0) return [];
    if (worker.startedAt > now) return [];
    if (worker.startedAt >= start.getTime()) return [worker];
    // Lifetime counters spanning the boundary cannot be prorated or assigned to this period.
    return [{ ...worker, output: null, attributableOutput: null }];
  });
}
const known = (workers: FlowWorker[]) => workers.reduce((sum, worker) => sum + (worker.attributableOutput ?? 0), 0);
const unknown = (workers: FlowWorker[]) => workers.filter(worker => worker.attributableOutput === null).length;

export function historicalAllocation(workers: FlowWorker[], period: FlowPeriod, now: number) {
  // Preserve the role from all retained delegation evidence even if a child predates this period.
  const scoped = periodWorkers(workers, period, now).map(worker => ({ ...worker,
    purpose: worker.attributableOutput === null ? "unknown" as const : flowPurpose(workers.find(item => item.key === worker.key)!, workers) }));
  const totals = purposeTotals(scoped);
  const grouped = new Map<string, WorkGroup>();
  for (const worker of scoped) {
    const single = worker.tasks.length === 1 ? worker.tasks[0] : null;
    const id = single ? `task:${single.id}` : worker.tasks.length > 1 ? "shared-tasks" : "unlinked-work";
    const group = grouped.get(id) ?? { id, name: single?.name ?? (worker.tasks.length > 1 ? "Shared tasks" : "Unlinked work"), workers: [], known: 0, unknown: 0 };
    group.workers.push(worker); grouped.set(id, group);
  }
  let groups = [...grouped.values()].map(group => ({ ...group, known: known(group.workers), unknown: unknown(group.workers) })).sort((a, b) => b.known - a.known || a.id.localeCompare(b.id));
  if (groups.length > 5) {
    const others = groups.slice(4).flatMap(group => group.workers);
    groups = [...groups.slice(0, 4), { id: "other-work", name: "Other work", workers: others, known: known(others), unknown: unknown(others) }];
  }
  const makeNode = (key: string, title: string, value: number | null, purpose: FlowPurpose, count: number, incomplete = false): FlowWorker => ({
    key, id: key, title, output: value, attributableOutput: value, purpose, aggregate: true, count, incomplete,
    status: "unknown", engine: null, startedAt: 0, endedAt: null, direct: false, parentId: undefined, parentKey: "coordinator", tasks: [],
  });
  const nodes = groups.map(group => makeNode(`group:${group.id}`, group.name, group.workers.some(worker => worker.attributableOutput !== null) ? group.known : null,
    group.workers.every(worker => worker.purpose === "execution") ? "execution" : group.workers.every(worker => worker.purpose === "unknown") ? "unknown" : "mixed", group.workers.length, group.unknown > 0));
  const edges: AllocationEdge[] = [];
  for (const group of groups) {
    const key = `group:${group.id}`;
    edges.push({ source: "coordinator", target: key, value: group.known || (group.unknown ? null : 0), purpose: "mixed" });
    const portions = purposeTotals(group.workers);
    for (const purpose of ["communication", "execution", "mixed", "unknown"] as const) {
      const bucket = portions[purpose];
      if (bucket.measured || bucket.unknown) edges.push({ source: key, target: `purpose:${purpose}`, value: bucket.measured ? bucket.known : null, purpose });
    }
  }
  for (const purpose of ["communication", "execution", "mixed", "unknown"] as const) {
    const bucket = totals[purpose];
    nodes.push(makeNode(`purpose:${purpose}`, PURPOSE_NAMES[purpose], bucket.measured ? bucket.known : null, purpose, bucket.measured + bucket.unknown, bucket.unknown > 0));
  }

  return { workers: scoped, groups, totals, nodes, edges, known: known(scoped), unknown: unknown(scoped) };
}

export function measuredWorkers(bot: BotView, history: TokenFlowHistoryView | null, period: FlowPeriod): FlowWorker[] {
  return (history?.metered?.periods[period] ?? []).map(group => {
    const row = history?.rows.find(row => row.head === group.head && row.id === group.workerId);
    const task = history?.tasks.find(task => task.id === group.taskId);
    const amount = group.tokens.input + group.tokens.output + group.tokens.cacheRead + group.tokens.cacheWrite;
    return { key: group.id, id: group.id, title: row?.title ?? (group.id.startsWith("other-") ? "Other work" : group.workerId ? "Worker" : "Chat"),
      status: "completed", engine: group.head === "codex" || group.head === "claude" ? group.head : null,
      output: amount, attributableOutput: amount, startedAt: 0, endedAt: null, direct: !group.workerId,
      parentId: undefined, parentKey: "coordinator", purpose: group.purpose, basis: "tokens", count: group.turns,
      tasks: [{id: task?.id ?? (group.workerId ? `worker:${group.head}:${group.workerId}` : `chat:${group.workId ?? group.id}`), name: task?.name ?? row?.title ?? (group.workerId ? "Worker" : "Chat")}],
    };
  });
}
