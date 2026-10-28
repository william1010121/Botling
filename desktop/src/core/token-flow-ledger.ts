// Identified, normalized metered turns. No prompts, tool arguments or report content.
import { TokenFlowJournal, TOKEN_SEGMENT_BYTES } from "./token-flow-journal";
import { tokenFlowContexts } from "./token-flow-context";
import { dirname, join } from "node:path";
import { z } from "zod";
import { noTokens, plusTokens, type TokenUsage } from "./usage";

const identity = z.string().min(1).max(200);
const count = z.number().int().nonnegative().safe();
export const MeteredTurn = z.strictObject({
  botId: identity, head: z.enum(["codex", "claude"]), threadId: identity, turnId: identity,
  workerId: identity.nullable(), run: count.nullable(), parentThreadId: identity.nullable(), taskId: identity.nullable(),
  startedAt: z.number().nonnegative(), endedAt: z.number().nonnegative(),
  source: z.enum(["provider-turn", "provider-message"]),
  appTurnId: identity.optional(),
  accountingVersion: z.literal(2).optional(),
  attribution: z.enum(["task", "chat", "unresolved"]).optional(),
  missingUsage: z.boolean().optional(),
  conflicted: z.boolean().optional(),
  scope: z.literal("exclusive"),
  tokens: z.strictObject({ input: count, output: count, cacheRead: count, cacheWrite: count }),
  activities: z.array(z.enum(["coordination", "execution", "unclassified"])).max(3),
  complete: z.boolean(),
});
export type MeteredTurn = z.infer<typeof MeteredTurn>;
export type MeteredPurpose = "communication" | "execution" | "mixed" | "unknown";
export function meteredPurpose(record: Pick<MeteredTurn, "activities" | "complete">): MeteredPurpose {
  if (!record.complete || record.activities.includes("unclassified") || !record.activities.length) return "unknown";
  if (record.activities.includes("coordination") && record.activities.includes("execution")) return "mixed";
  return record.activities.includes("coordination") ? "communication" : "execution";
}
export const meteredKey = (r: MeteredTurn) => JSON.stringify([r.botId, r.head, r.threadId, r.turnId]);

/** Identified snapshots with generation compaction. Every identity survives compaction;
 * torn/corrupt/failed storage stops collection visibly rather than discarding evidence. */
export class TokenFlowLedger {
  readonly records = new Map<string, MeteredTurn>();
  limited = false;
  unreadable = false;
  error: string | null = null;
  private journal: TokenFlowJournal;
  private contexts() { return tokenFlowContexts(join(dirname(this.file),"token-flow-contexts.json")); }
  private projection?: {book: ReturnType<typeof tokenFlowContexts>; revision: number};
  reconcileTasks() {
    const contexts=this.contexts();
    if(contexts.unreadable){this.unreadable=true;this.error="Token attribution storage could not be read or written.";return;}
    if(this.projection?.book===contexts&&this.projection.revision===contexts.aliasRevision)return;
    for(const [key,r] of this.records)if(r.accountingVersion===2&&r.taskId){
      const taskId=contexts.canonical(r.taskId);if(taskId!==r.taskId)this.records.set(key,{...r,taskId});
    }
    this.projection={book:contexts,revision:contexts.aliasRevision};
  }
  constructor(readonly file: string, segmentBytes=TOKEN_SEGMENT_BYTES) {
    this.journal=new TokenFlowJournal(file,segmentBytes);
    try{this.journal.load(line=>{const r=MeteredTurn.parse(JSON.parse(line));this.records.set(meteredKey(r),r);});}
    catch(e){this.stop(e);}
    this.reconcileTasks();
  }
  private stop(error:unknown) {
    this.unreadable=true;
    const code=(error as NodeJS.ErrnoException)?.code;
    this.error=code?`Token storage I/O failed (${code}).`:`Token storage integrity failed. Preserve the ledger and restore a verified backup.`;
  }
  record(value: MeteredTurn): boolean {
    this.reconcileTasks();
    if (this.unreadable || this.limited) return false;
    const parsed = MeteredTurn.safeParse(value);
    if (!parsed.success) return false;
    const r = parsed.data;
    if(r.accountingVersion===2)r.taskId=this.contexts().canonical(r.taskId);
    const key = meteredKey(r), previous = this.records.get(key);
    if (previous) {
      // Attribution is sticky across replay and restart. A later observer cannot steal a record.
      r.taskId = previous.taskId;
      r.attribution = previous.attribution;
      r.accountingVersion = previous.accountingVersion;
      r.appTurnId = previous.appTurnId ?? r.appTurnId;
      r.parentThreadId = previous.parentThreadId ?? r.parentThreadId;
      const evidence = (record: MeteredTurn) => JSON.stringify({ ...record, startedAt: 0, endedAt: 0 });
      if (evidence(previous) === evidence(r)) return true;
      if (!previous.conflicted && previous.source === r.source
        && r.workerId === previous.workerId && r.parentThreadId === previous.parentThreadId) {
        const keys = ["input", "output", "cacheRead", "cacheWrite"] as const;
        // Both adapters emit snapshots of the same identified unit, never disjoint deltas.
        if (keys.every(k => r.tokens[k] <= previous.tokens[k]) && (!r.complete || previous.complete) && r.activities.every(a => previous.activities.includes(a)) && !previous.missingUsage) return true;
        if (keys.every(k => r.tokens[k] >= previous.tokens[k]) && !previous.complete) {
          r.startedAt = previous.startedAt;
          r.activities = [...new Set([...previous.activities, ...r.activities])].sort();
          return this.append(r);
        }
      }
      // Conflicting replays cannot replace previously attributed evidence with a confident split.
      r.complete = false; r.conflicted = true; r.activities = ["unclassified"];
      r.workerId = previous.workerId; r.run = previous.run; r.parentThreadId = previous.parentThreadId;
      // Keep one actually observed measurement, never manufacture a component-wise maximum.
      r.missingUsage = previous.missingUsage;
      r.tokens = previous.tokens; r.startedAt = previous.startedAt; r.endedAt = previous.endedAt;
    }
    return this.append(r);
  }
  /** Only an explicit app turn/task relationship can fill a previously unassigned new record. */
  linkTurn(botId: string, head: MeteredTurn["head"], appTurnId: string, taskId: string) {
    if (this.unreadable || this.limited || !identity.safeParse(taskId).success) return;
    for (const r of this.records.values()) if (r.botId === botId && r.head === head && r.appTurnId === appTurnId && !r.taskId) {
      this.append({ ...r, taskId, attribution: "task" });
    }
  }
  private append(r: MeteredTurn): boolean {
    if(this.unreadable||this.limited)return false;
    const line=JSON.stringify(r)+"\n";
    try{
      const records=this.records;
      this.journal.append(line,function*(){for(const value of records.values())yield JSON.stringify(value)+"\n";});
      this.records.set(meteredKey(r),r);return true;
    }catch(e){this.stop(e);return false;}
  }
  totals(botId: string) {
    const days = new Map<string, TokenUsage>();
    for (const r of this.records.values()) if (r.botId === botId && !r.missingUsage) {
      const day = new Date(r.endedAt).toISOString().slice(0, 10);
      days.set(day, plusTokens(days.get(day) ?? noTokens(), r.tokens));
    }
    return days;
  }
}
const ledgers = new Map<string, TokenFlowLedger>();
export function tokenLedger(file: string) {
  let ledger = ledgers.get(file);
  if (!ledger) { ledger = new TokenFlowLedger(file); if (ledgers.size >= 8) ledgers.delete(ledgers.keys().next().value!); ledgers.set(file, ledger); }
  return ledger;
}
