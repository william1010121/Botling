import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// A tiny protobuf writer: fixtures are made here, never copied from a real conversation.
type Field = [number, number | string | Uint8Array];
const varint = (n: number) => { const out: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return out; };
export function pb(fields: Field[]): Uint8Array {
  const out: number[] = [];
  for (const [no, value] of fields) {
    if (typeof value === "number") out.push(...varint(no * 8), ...varint(value));
    else { const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value; out.push(...varint(no * 8 + 2), ...varint(bytes.length), ...bytes); }
  }
  return Uint8Array.from(out);
}
/** agy's usage message: 2 uncached input, 3 output, 4 cache write, 5 cache read, 9 thinking. */
export const usage = (u: { input: number; output: number; cacheRead?: number; cacheWrite?: number; thinking?: number }) =>
  pb([[2, u.input], [3, u.output], ...(u.cacheWrite ? [[4, u.cacheWrite] as Field] : []), ...(u.cacheRead ? [[5, u.cacheRead] as Field] : []), ...(u.thinking ? [[9, u.thinking] as Field] : [])]);
/** A gen_metadata row: field 1 holds the generation, its usage in 4, attempts in 17, model in 19/21, time in 9.4. */
export function generation(opts: { usage: Uint8Array; attempts?: Uint8Array[]; model?: string; slug?: string; seconds?: number }): Uint8Array {
  const data: Field[] = [[4, opts.usage]];
  for (const attempt of opts.attempts ?? []) data.push([17, pb([[2, attempt]])]);
  if (opts.model) data.push([19, opts.model]);
  if (opts.slug) data.push([21, opts.slug]);
  if (opts.seconds) data.push([9, pb([[4, pb([[1, opts.seconds]])]])]);
  return pb([[1, pb(data)]]);
}
export function conversation(home: string, sessionId: string) {
  const dir = join(home, "antigravity-acp", "conversations");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, `${sessionId}.db`));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))");
  db.exec("CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, metadata blob, PRIMARY KEY (idx))");
  let next = 0;
  return {
    db,
    add: (row: Uint8Array) => { db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(next++, row); },
    step: (row: Uint8Array | null) => { db.prepare("INSERT INTO steps (idx, metadata) VALUES ((SELECT count(*) FROM steps), ?)").run(row); },
  };
}

