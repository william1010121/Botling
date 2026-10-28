import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { writeFileAtomic } from "./durable/atomic";
import { reportedOutputTokens, type SubagentRecord } from "./subagents";
const hash = (value: string[]) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Monotonic ownership tombstones. Retention can remove rows, never evidence of shared ownership. */
export function legacyOwnership(file: string, rows: {engine: string; record: SubagentRecord}[]) {
  let owners: Record<string, string | null> = {}, blocked = false, changed = false;
  try {
    if (statSync(file).size > 16 * 1024 * 1024) blocked = true;
    else { const saved = JSON.parse(readFileSync(file, "utf8")); owners = saved.owners; blocked = saved.blocked === true; if (!owners || typeof owners !== "object") blocked = true; }
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") blocked = true; }
  const result = new Map<SubagentRecord, number | null>();
  let size = Object.keys(owners ?? {}).length;
  if (!blocked) for (const {engine, record} of rows) for (const key of Object.keys(record.outputTokenCounters ?? {})) {
    const counter = hash([engine,key]), owner = hash([engine,record.id]);
    if (!(counter in owners)) { if (++size > 100000) { blocked = changed = true; break; } owners[counter] = owner; changed = true; }
    else if (owners[counter] !== owner && owners[counter] !== null) { owners[counter] = null; changed = true; }
  }
  if (changed) try { writeFileAtomic(file, JSON.stringify({owners, blocked})); } catch { blocked = true; }
  for (const {engine,record} of rows) {
    const keys = Object.keys(record.outputTokenCounters ?? {});
    result.set(record, !blocked && keys.length > 0 && keys.every(key => /^(thread|message):.+/.test(key) && owners[hash([engine,key])] === hash([engine,record.id])) ? reportedOutputTokens(record) : null);
  }
  return result;
}
