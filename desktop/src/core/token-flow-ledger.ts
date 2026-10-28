// Identified, normalized metered turns. No prompts, tool arguments or report content.
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
const LIMIT = 16 * 1024 * 1024;
/** Append-only snapshots, one atomic line per turn; replay replaces the same identity, never adds it.
 * A torn final line or a full journal fails closed; no eviction of dedupe identities. */
export class TokenFlowLedger {
  readonly records = new Map<string, MeteredTurn>();
  limited = false;
  unreadable = false;
  private bytes = 0;
  constructor(readonly file: string) {
    try {
      this.bytes = statSync(file).size;
      if (this.bytes > LIMIT) { this.limited = this.unreadable = true; return; }
      const content = readFileSync(file, "utf8");
      if (content && !content.endsWith("\n")) { this.unreadable = true; return; }
      for (const line of content.split("\n")) {
        if (!line) continue;
        const record = MeteredTurn.parse(JSON.parse(line));
        this.records.set(meteredKey(record), record);
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true; }
  }
  record(value: MeteredTurn): boolean {
    if (this.unreadable || this.limited) return false;
    const parsed = MeteredTurn.safeParse(value);
    if (!parsed.success) return false;
    const r = parsed.data, key = meteredKey(r), previous = this.records.get(key);
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
    const key = meteredKey(r);
    const line = JSON.stringify(r) + "\n";
    if (this.bytes + Buffer.byteLength(line) > LIMIT) { this.limited = true; return false; }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const fd = openSync(this.file, "a", 0o600);
      try { appendFileSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
      this.bytes += Buffer.byteLength(line); this.records.set(key, r); return true;
    } catch { this.unreadable = true; return false; }
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
