import { codexTokens, minusTokens, noTokens, type TokenUsage } from "./usage";
import type { MeteredTurn } from "./token-flow-ledger";
export type TurnMeasurement = Omit<MeteredTurn, "botId" | "head" | "workerId" | "run" | "parentThreadId" | "taskId">;
type Activity = MeteredTurn["activities"][number];
/** Classify observed structured activity, never role, text, tool count or token shares. */
export function activityKind(item: {type?: string; tool?: string}): Activity | null {
  if (["agentMessage", "reasoning", "userMessage", "plan"].includes(item.type ?? "")) return null;
  if (["commandExecution", "fileChange", "webSearch"].includes(item.type ?? "")) return "execution";
  if (item.type === "dynamicToolCall" && ["app_handoff", "app_send_message", "app_task_checkpoint"].includes(item.tool ?? "")) return "coordination";
  return "unclassified";
}
interface Capture { threadId: string; turnId: string; startedAt: number; before: TokenUsage | null; after: TokenUsage | null; activities: Set<Activity>; observedStart: boolean }
/** Retains only bounded metadata for active turns. Fresh threads start at zero; resumed threads
 * require a baseline notification. Missing baseline stays unmetered, never uses lifetime totals. */
export class TokenFlowMeter {
  private missing: TurnMeasurement | null = null;
  takeMissing() { const value = this.missing; this.missing = null; return value; }
  private baselines = new Map<string, TokenUsage>();
  private active = new Map<string, Capture>();
  fresh(thread: string) { if (this.baselines.size >= 1024) this.baselines.delete(this.baselines.keys().next().value!); this.baselines.set(thread, noTokens()); }
  begin(thread: string, turn: string, at = Date.now()) {
    const current = this.active.get(thread);
    if (current?.turnId === turn) return;
    // A boundary can seed only one interval. Replacing an unfinished capture (cancel/error)
    // cannot promote its intermediate snapshot into a trustworthy end boundary.
    const before = current ? null : this.baselines.get(thread) ?? null;
    this.baselines.delete(thread);
    if (this.active.size >= 256) this.active.delete(this.active.keys().next().value!);
    this.active.set(thread,{threadId:thread,turnId:turn,startedAt:at,before,after:null,activities:new Set(),observedStart:true});
  }
  observe(method: string, params: any) {
    const thread = params.threadId;
    if (typeof thread !== "string") return;
    if (method === "turn/started" && typeof params.turn?.id === "string") this.begin(thread, params.turn.id);
    const current = this.active.get(thread);
    if (current && typeof params.turnId === "string" && params.turnId !== current.turnId) return;
    if (method === "thread/tokenUsage/updated" && params.tokenUsage?.total) {
      const raw = params.tokenUsage.total;
      if (![raw.inputTokens,raw.outputTokens,raw.cachedInputTokens ?? 0,raw.cacheWriteInputTokens ?? 0].every(x=>Number.isSafeInteger(x) && x>=0) || (raw.cachedInputTokens ?? 0)>raw.inputTokens) return;
      const tokens = codexTokens(raw);
      if (current) current.after = tokens;
      else {
        const previous = this.baselines.get(thread);
        if (!previous || Object.keys(tokens).every(key => tokens[key as keyof TokenUsage] >= previous[key as keyof TokenUsage])) this.baselines.set(thread,tokens);
      }
    }
    if (current && (!params.turnId || params.turnId === current.turnId)) {
      const item = method === "item/tool/call" ? {type:"dynamicToolCall",tool:params.tool} : method === "item/started" || method === "item/completed" ? params.item : null;
      if (item) { const kind=activityKind(item); if(kind) current.activities.add(kind); }
    }
  }
  /** A crash must not erase already observed usage. Partial snapshots use the same final
   * identity; the durable ledger replaces them rather than adding them to the completion. */
  snapshot(thread: string, at = Date.now()): TurnMeasurement | null {
    const current=this.active.get(thread);
    if(!current) return null;
    const tokens=current.before&&current.after?minusTokens(current.after,current.before):null;
    const known=tokens&&Object.values(tokens).every(x=>Number.isSafeInteger(x)&&x>=0);
    return {threadId:thread,turnId:current.turnId,startedAt:current.startedAt,endedAt:at,
      source:"provider-turn",scope:"exclusive",tokens:known?tokens:noTokens(),
      ...(known?{}:{missingUsage:true}),activities:[...current.activities].sort(),complete:false};
  }
  coordination(thread: string) { this.active.get(thread)?.activities.add("coordination"); }
  finish(thread: string, turn: string, at = Date.now()): TurnMeasurement | null {
    this.missing = null;
    const current = this.active.get(thread);
    if (!current || current.turnId !== turn) return null;
    const gap = (): null => { this.missing = {threadId:thread,turnId:turn,startedAt:current.startedAt,endedAt:at,tokens:noTokens(),activities:[...current.activities].sort(),complete:false,missingUsage:true,source:"provider-turn",scope:"exclusive"}; return null; };
    this.active.delete(thread);
    if(current.after) this.baselines.set(thread,current.after);
    else this.baselines.delete(thread); // Missing end usage breaks the chain, including zero-based fresh threads.
    if(!current.before || !current.after) return gap();
    const tokens=minusTokens(current.after,current.before);
    if(!Object.values(tokens).every(x=>Number.isSafeInteger(x)&&x>=0)) return gap();
    if(this.baselines.size>1024) this.baselines.delete(this.baselines.keys().next().value!);
    return {threadId:thread,turnId:turn,startedAt:current.startedAt,endedAt:at,tokens,activities:[...current.activities].sort(),complete:current.observedStart,source:"provider-turn",scope:"exclusive"};
  }
}
