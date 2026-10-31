// Read-only recovery of the pre-2.1 subagents.json: a whole-file checkpoint (an array, or
// {format:"botling-history-v1", sequence, rows}) plus a `subagents.json.journal/` directory of
// numbered patch receipts. It exists only for the one-time migration into the index + per-agent
// step files (subagent-store.ts); nothing here ever writes.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type LegacyRow = { id: string; [key: string]: unknown };
type Patch = { path: (string | number)[]; value?: unknown; remove?: true; length?: number };
interface Transaction { order: string[]; changes: { id: string; patches: Patch[] }[] }

export function decodeHistoryCheckpoint(value: any): { rows: LegacyRow[]; sequence: number } {
  if (Array.isArray(value)) return { rows: value, sequence: 0 };
  if (value?.format === "botling-history-v1" && Number.isSafeInteger(value.sequence) && value.sequence >= 0 && Array.isArray(value.rows)) {
    return { rows: value.rows, sequence: value.sequence };
  }
  throw new Error("Invalid history checkpoint");
}

function apply(rows: Map<string, any>, transaction: Transaction): any[] {
  for (const change of transaction.changes) {
    let row = rows.get(change.id);
    for (const patch of change.patches) {
      if (!patch.path.length && patch.length === undefined) { row = patch.remove ? undefined : patch.value; continue; }
      if (!row || typeof row !== "object") row = typeof patch.path[0] === "number" ? [] : {};
      let parent = row;
      const end = patch.length === undefined ? patch.path.length - 1 : patch.path.length;
      for (let i = 0; i < end; i++) {
        const key = patch.path[i]!;
        if (!Object.hasOwn(parent, key) || !parent[key] || typeof parent[key] !== "object") {
          Object.defineProperty(parent, key, { value: typeof patch.path[i + 1] === "number" || (i + 1 === end && patch.length !== undefined) ? [] : {}, enumerable: true, writable: true, configurable: true });
        }
        parent = parent[key];
      }
      if (patch.length !== undefined) parent.length = patch.length;
      else if (patch.remove) delete parent[patch.path.at(-1)!];
      else Object.defineProperty(parent, patch.path.at(-1)!, { value: patch.value, enumerable: true, writable: true, configurable: true });
    }
    if (row !== undefined) rows.set(change.id, row); else rows.delete(change.id);
  }
  const keep = new Set(transaction.order);
  for (const id of rows.keys()) if (!keep.has(id)) rows.delete(id);
  return transaction.order.map(id => {
    if (!rows.has(id)) throw new Error(`History transaction refers to missing row ${id}`);
    return rows.get(id);
  });
}

/** The old checkpoint with every journal receipt newer than its watermark applied. */
export function readLegacyRows(file: string, parsed: unknown): LegacyRow[] {
  const base = decodeHistoryCheckpoint(parsed);
  let list = base.rows, sequence = base.sequence;
  const rows = new Map<string, LegacyRow>(list.filter((row: any) => row && typeof row.id === "string").map((row: LegacyRow) => [row.id, row]));
  const directory = file + ".journal";
  const names = existsSync(directory) ? readdirSync(directory).filter(name => /^\d{16}\.json$/.test(name)).sort() : [];
  for (const name of names) {
    const next = Number(name.slice(0, 16));
    if (next <= base.sequence) continue;
    if (next !== sequence + 1) throw new Error("History transaction sequence gap");
    list = apply(rows, JSON.parse(readFileSync(join(directory, name), "utf8")));
    sequence = next;
  }
  return list;
}
