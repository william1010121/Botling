import type { TokenFlowHistoryView } from "../contract";
export type MeasurementGroup = NonNullable<TokenFlowHistoryView["metered"]>["periods"]["all"][number];
export const measuredAmount = (g: MeasurementGroup) => g.tokens.input + g.tokens.output + g.tokens.cacheRead + g.tokens.cacheWrite;
export const agentKey = (r:MeasurementGroup) => r.head ? `${r.head}:${r.workerId ? "workers" : "coordinator"}` : "retained";
export const agentLabel = (id:string) => id === "retained" ? "Other retained agents" : `${id.split(":")[0] === "codex" ? "Codex" : "Claude"} · ${id.endsWith("workers") ? "subagents" : "coordinator"}`;
/** Merge secondary activity buckets before displaying ownership; no purpose split in the graph. */
export function ownershipRows(rows:MeasurementGroup[]) {
  const map=new Map<string,MeasurementGroup>();
  for (const row of rows) {
    const key=JSON.stringify([row.workId??row.id,row.attribution]);
    const old=map.get(key);
    if (!old) { map.set(key,{...row,tokens:{...row.tokens}});continue; }
    for(const k of ["input","output","cacheRead","cacheWrite"] as const) old.tokens[k]+=row.tokens[k];
    old.turns+=row.turns;old.missing=(old.missing??0)+(row.missing??0);old.partial=(old.partial??0)+(row.partial??0);old.messages=(old.messages??0)+(row.messages??0);
  }
  return [...map.values()];
}
export function taskFlowGroups(input: MeasurementGroup[], tasks: TokenFlowHistoryView["tasks"]) {
  const rows=ownershipRows(input);
  const groups = new Map<string, { id: string; taskId: string | null; name: string; rows: MeasurementGroup[]; total: number; missing: number; partial: number; measured: number; coverage: boolean }>();
  for (const row of rows) {
    const context=row.attribution??"historical";
    const id = row.taskId ? `task:${row.taskId}` : context;
    const name=row.taskId ? tasks.find(t => t.id === row.taskId)?.name ?? "Recorded task" : context==="chat"?"Chat / no task":context==="unresolved"?"Missing dispatch context":context==="aggregated"?"Other recorded groups":"Earlier / retained attribution";
    const group = groups.get(id) ?? { id, taskId: row.taskId, name, rows: [], total: 0, missing: 0, partial: 0, measured: 0, coverage:!row.taskId&&context!=="chat" };
    group.rows.push(row); group.total += measuredAmount(row); group.missing += row.missing ?? 0; group.partial += row.partial ?? 0;
    group.measured += row.turns - (row.missing ?? 0); groups.set(id, group);
  }
  return [...groups.values()].sort((a,b) => Number(a.coverage)-Number(b.coverage)||a.id.localeCompare(b.id));
}
