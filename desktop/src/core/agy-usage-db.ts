import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentRecord } from "./agent-registry";

/**
 * Antigravity's own record of what each model call used: `<GEMINI_HOME>/antigravity-acp/conversations/<sessionId>.db`,
 * one SQLite file per conversation, rows holding protobuf blobs (`gen_metadata` per generation, `steps` per trajectory
 * step). The field numbers are not documented; they follow T3 Code's antigravityUsageReader (ported, not run). The file
 * is opened read only and never locked for long, so agy's own writes are never held up.
 */

/** One model call (an attempt: a retry is a call of its own), its tokens as Botling counts them. */
export interface AgyCall {
  /** ms since 1970; null when the row carries no time. */
  at: number | null;
  model: string;
  /** Input tokens not read from the cache. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Thinking tokens, part of `output`. */
  reasoning: number;
  /** A retry of the call before it (the same generation tried again). */
  retry: boolean;
  /** Stable for the call across reads (agy's own id when it has one). */
  key: string;
}
export interface AgyUsage {
  sessionId: string;
  calls: AgyCall[];
  total: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  retries: number;
  /** The models the calls used, in the order first seen. */
  models: string[];
}

type FieldValue = number | bigint | Uint8Array;
type Fields = Map<number, FieldValue[]>;

/** A protobuf message's fields by number (varints as numbers, length-delimited as bytes; fixed ones skipped). */
export function protoFields(bytes: Uint8Array): Fields {
  let offset = 0;
  const result: Fields = new Map();
  const varint = (): number | bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) throw new Error("Invalid protobuf varint");
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
    }
    throw new Error("Invalid protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8), wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value: FieldValue;
    if (wire === 0) value = varint();
    else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number" || length > bytes.length - offset) throw new Error("Truncated protobuf field");
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else throw new Error("Unsupported protobuf wire type");
    const entries = result.get(number) ?? [];
    entries.push(value);
    result.set(number, entries);
  }
  return result;
}

const numberAt = (value: Fields, key: number) => { const entry = value.get(key)?.[0]; return typeof entry === "number" ? entry : 0; };
const bytesAt = (value: Fields, key: number) => { const entry = value.get(key)?.[0]; return entry instanceof Uint8Array ? entry : undefined; };
const nested = (value: Fields, key: number): Fields => { const bytes = bytesAt(value, key); return bytes === undefined ? new Map() : protoFields(bytes); };
const textAt = (value: Fields, key: number) => {
  const bytes = bytesAt(value, key);
  return bytes === undefined ? "" : new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
};
const timestamp = (value: Fields) => { const seconds = numberAt(value, 1); return seconds > 0 ? seconds * 1000 + Math.floor(numberAt(value, 2) / 1_000_000) : null; };

/** agy's numeric model ids, for rows that carry no model name. */
const MODEL_IDS: Record<number, string> = {
  246: "gemini-2.5-pro", 312: "gemini-2.5-flash", 313: "gemini-2.5-flash-thinking", 329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite", 281: "claude-sonnet-4", 282: "claude-sonnet-4", 290: "claude-opus-4", 291: "claude-opus-4",
  333: "claude-sonnet-4-5", 334: "claude-sonnet-4-5", 340: "claude-haiku-4-5", 341: "claude-haiku-4-5",
  1026: "claude-opus-4-6", 1035: "claude-sonnet-4-6", 1016: "gemini-3.1-pro", 1036: "gemini-3.1-pro", 1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview", 1084: "gemini-3-flash-preview", 1047: "gemini-3-flash-preview",
};
function modelName(name: string, id: number): string {
  if (name) {
    const normalized = name.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").replaceAll(" ", "-");
    if (normalized.startsWith("claude-")) return normalized.replace(/^claude-(4(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1").replaceAll(".", "-");
    return normalized;
  }
  return MODEL_IDS[id] ?? (id > 0 ? `antigravity-model-${id}` : "");
}

interface Metadata { model: string; at: number | null; attempts: Fields[] }
/**
 * A `gen_metadata.data` (step false) or `steps.metadata` (step true) blob. The retry list (17, steps 28) holds every
 * attempt of the call, the one that answered last, its usage then repeated in the main field (4, steps 9): so the
 * attempts are that list when there is one, else the main usage alone.
 */
function metadata(bytes: Uint8Array, step: boolean): Metadata {
  const root = protoFields(bytes);
  if (!step && bytesAt(root, 1) === undefined) throw new Error("Missing generation metadata");
  const data = step ? root : nested(root, 1);
  const model = step ? nested(data, 24) : data;
  const attempts: Fields[] = [];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error("Invalid retry metadata");
    const usage = bytesAt(protoFields(retry), 2);
    if (usage !== undefined) attempts.push(protoFields(usage.slice()));
  }
  const usage = bytesAt(data, step ? 9 : 4);
  if (!attempts.length && usage !== undefined) attempts.push(protoFields(usage.slice()));
  return {
    model: modelName(textAt(model, step ? 12 : 21) || textAt(model, step ? 8 : 19), numberAt(model, step ? 1 : 3)),
    at: step ? (timestamp(nested(data, 8)) ?? timestamp(nested(data, 1))) : timestamp(nested(nested(data, 9), 4)),
    attempts,
  };
}

/**
 * The calls in a conversation's decoded rows. Generations are the record; a step of a model reply repeats its
 * generation's usage with no shared id, so steps count only in a file without generations.
 */
export function agyCalls(generations: readonly { idx: number; entry: Metadata }[], steps: readonly { idx: number; entry: Metadata }[], fallbackAt: number | null): AgyCall[] {
  const source = generations.length ? "gen" : "step";
  const calls: AgyCall[] = [];
  for (const { idx, entry } of generations.length ? generations : steps) {
    for (const [attempt, usage] of entry.attempts.entries()) {
      const output = Math.max(numberAt(usage, 3), numberAt(usage, 9) + numberAt(usage, 10));
      const call: AgyCall = {
        at: entry.at ?? fallbackAt,
        model: MODEL_IDS[numberAt(usage, 1)] || entry.model || modelName("", numberAt(usage, 1)) || "antigravity-unknown",
        input: numberAt(usage, 2), cacheRead: numberAt(usage, 5), cacheWrite: numberAt(usage, 4), output,
        reasoning: Math.min(output, numberAt(usage, 9)),
        retry: attempt < entry.attempts.length - 1,
        key: `${source}:${idx}:${attempt}`,
      };
      if (call.input + call.cacheRead + call.cacheWrite + output > 0) calls.push(call);
    }
  }
  return calls;
}

export function summarize(sessionId: string, calls: AgyCall[]): AgyUsage {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const models: string[] = [];
  for (const call of calls) {
    for (const field of Object.keys(total) as (keyof typeof total)[]) total[field] += call[field];
    if (!models.includes(call.model)) models.push(call.model);
  }
  return { sessionId, calls, total, retries: calls.filter(call => call.retry).length, models };
}

interface Rows { generations: { idx: number; entry: Metadata }[]; steps: { idx: number; entry: Metadata }[]; at: number | null; last: { gen: number; step: number }; hasGenerations: boolean }
/** The rows after the given rowids (-1: all), in one read transaction; null: no such file, or one this reader cannot read. */
function readRows(file: string, after: { gen: number; step: number }): Rows | null {
  if (!existsSync(file)) return null;
  let db: DatabaseSync | undefined;
  try {
    // Read only, with a short busy wait: a reader in WAL mode never blocks agy's writes.
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 100");
    db.exec("BEGIN");
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name));
    if (!tables.has("gen_metadata") && !tables.has("steps")) return null;
    const last = { ...after };
    // Generation rows can hold megabytes of context: iterate, one row in memory at a time.
    const rows = (table: "gen_metadata" | "steps") => {
      const step = table === "steps", entries: { idx: number; entry: Metadata }[] = [];
      const query = `SELECT rowid AS row_id, idx, ${step ? "metadata" : "data"} AS data FROM ${table} WHERE rowid > ? ORDER BY rowid`;
      for (const row of db!.prepare(query).iterate(step ? after.step : after.gen) as Iterable<{ row_id: number; idx: unknown; data: unknown }>) {
        last[step ? "step" : "gen"] = row.row_id;
        if (step && row.data === null) continue;
        if (typeof row.idx !== "number" || !(row.data instanceof Uint8Array)) throw new Error("Invalid row");
        entries.push({ idx: row.idx, entry: metadata(row.data, step) });
      }
      return entries.sort((a, b) => a.idx - b.idx);
    };
    const generations = tables.has("gen_metadata") ? rows("gen_metadata") : [];
    const steps = tables.has("steps") ? rows("steps") : [];
    let at: number | null = null;
    if (tables.has("trajectory_metadata_blob")) {
      for (const row of db.prepare("SELECT data FROM trajectory_metadata_blob").all() as { data: unknown }[]) {
        if (row.data instanceof Uint8Array) at ??= timestamp(nested(protoFields(row.data), 2));
      }
    }
    return { generations, steps, at: at ?? statSync(file).mtimeMs, last, hasGenerations: tables.has("gen_metadata") };
  } catch {
    return null;
  } finally {
    try { db?.exec("COMMIT"); } catch { /* no transaction open */ }
    try { db?.close(); } catch { /* closed */ }
  }
}

/** Every call recorded in one conversation file; null: no such file, or one this reader cannot read. */
export function readAgyDatabase(file: string, sessionId: string): AgyUsage | null {
  const rows = readRows(file, { gen: -1, step: -1 });
  return rows && summarize(sessionId, agyCalls(rows.generations, rows.hasGenerations ? [] : rows.steps, rows.at));
}

/**
 * One conversation's calls turn by turn: `mark()` before a turn, `take()` after it gives the calls written since,
 * reading only the new rows. Empty when agy wrote none (or the file cannot be read): the caller keeps what ACP said.
 */
export class AgyTurnUsage {
  private last = { gen: -1, step: -1 };
  private marked = false;
  constructor(private readonly home: string, private readonly sessionId: () => string) {}
  private file() { return agyConversationFile(this.home, this.sessionId()); }
  mark() {
    const file = this.file();
    this.marked = false;
    if (!file || !existsSync(file)) { this.last = { gen: -1, step: -1 }; this.marked = true; return; }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 100");
      const max = (table: string) => { try { return Number((db!.prepare(`SELECT max(rowid) AS n FROM ${table}`).get() as { n: unknown }).n ?? -1); } catch { return -1; } };
      this.last = { gen: max("gen_metadata"), step: max("steps") };
      this.marked = true;
    } catch { /* unread: take() gives nothing */ } finally { try { db?.close(); } catch { /* closed */ } }
  }
  take(): AgyCall[] {
    const file = this.file();
    if (!this.marked || !file) return [];
    const rows = readRows(file, this.last);
    if (!rows) return [];
    this.last = rows.last;
    return agyCalls(rows.generations, rows.hasGenerations ? [] : rows.steps, rows.at);
  }
}

/** A turn's tokens as Botling's usage event counts them; null: no calls. */
export function callTokens(calls: readonly AgyCall[]): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  if (!calls.length) return null;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const call of calls) for (const field of Object.keys(tokens) as (keyof typeof tokens)[]) tokens[field] += call[field];
  return tokens;
}

/** A conversation's file in a profile (GEMINI_HOME); null for a session id that could name another path. */
export function agyConversationFile(home: string, sessionId: string): string | null {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.startsWith(".")) return null;
  return join(home, "antigravity-acp", "conversations", `${sessionId}.db`);
}

const cache = new Map<string, { fingerprint: string; usage: AgyUsage | null }>();
const fingerprint = (file: string) => {
  const part = (path: string) => { try { const s = statSync(path); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch { return "-"; } };
  return `${part(file)}/${part(`${file}-wal`)}`;
};
/** A conversation's usage, read again only when its file (or WAL) changed. */
export function agyUsage(home: string, sessionId: string): AgyUsage | null {
  const file = agyConversationFile(home, sessionId);
  if (!file) return null;
  const print = fingerprint(file);
  const hit = cache.get(file);
  if (hit?.fingerprint === print) return hit.usage;
  const usage = readAgyDatabase(file, sessionId);
  cache.set(file, { fingerprint: print, usage });
  if (cache.size > 64) cache.delete(cache.keys().next().value!);
  return usage;
}

const safeId = (id: string) => /^[A-Za-z0-9._-]+$/.test(id) && !id.startsWith(".");
const list = (dir: string): string[] => { try { return readdirSync(dir); } catch { return []; } };

/**
 * The agy homes (GEMINI_HOME) Botling keeps: each head profile `<dataDir>/agy-acp/<profile>` and each of its workers'
 * own `<profile>/workers/<workerId>`.
 */
function agyHomes(dataDir: string): string[] {
  const root = join(dataDir, "agy-acp"), homes: string[] = [];
  for (const profile of list(root)) {
    homes.push(join(root, profile));
    for (const worker of list(join(root, profile, "workers"))) homes.push(join(root, profile, "workers", worker));
  }
  return homes;
}

/** The session's usage from whichever Botling agy home holds its conversation: a head's profile or a worker's folder. */
export function agyUsageInProfiles(dataDir: string, sessionId: string): AgyUsage | null {
  if (!safeId(sessionId)) return null;
  for (const home of agyHomes(dataDir)) {
    const file = agyConversationFile(home, sessionId);
    if (file && existsSync(file)) return agyUsage(home, sessionId);
  }
  return null;
}

/**
 * An agy worker's folder (`<dataDir>/agy-acp/<profile>/workers/<workerId>`, `workerId` its registry `nativeId`) and the
 * conversation it holds (the newest, should a run have started another); null: no such worker or no conversation yet.
 */
export function agyWorkerConversation(dataDir: string, workerId: string): { home: string; sessionId: string } | null {
  if (!safeId(workerId)) return null;
  const root = join(dataDir, "agy-acp");
  for (const profile of list(root)) {
    const home = join(root, profile, "workers", workerId);
    const dir = join(home, "antigravity-acp", "conversations");
    let newest: { sessionId: string; at: number } | null = null;
    for (const name of list(dir)) {
      if (!name.endsWith(".db")) continue;
      const sessionId = name.slice(0, -3);
      if (!safeId(sessionId)) continue;
      let at = 0;
      try { at = statSync(join(dir, name)).mtimeMs; } catch { continue; }
      if (!newest || at > newest.at) newest = { sessionId, at };
    }
    if (newest) return { home, sessionId: newest.sessionId };
  }
  return null;
}

/** An agy worker's usage by its registry `nativeId` (its folder's name), whether or not the registry knows its session id. */
export function agyWorkerUsage(dataDir: string, workerId: string): AgyUsage | null {
  const found = agyWorkerConversation(dataDir, workerId);
  return found ? agyUsage(found.home, found.sessionId) : null;
}

/** An agy worker an agy head started (`workspace.agyWorkers`). */
export interface AgyWorker {
  /** Its registry id (`ag-…`). */
  id: string;
  /** Its worker id: the folder its agy home is (`workers/<nativeId>`), what `agyWorkerUsage` takes. */
  nativeId: string;
  /** Its agy conversation (the registry's, else the one its folder holds); null: none started yet. */
  sessionId: string | null;
  name: string;
  state: AgentRecord["state"];
  model: string | null;
  createdAt: number;
  endedAt: number | null;
}

/** The agy workers the registry lists under the agy head session `sessionId`, oldest first. */
export function agyWorkerList(records: readonly AgentRecord[], sessionId: string, dataDir: string): AgyWorker[] {
  return records
    .filter((record) => record.engine === "agy" && record.host.kind === "agy-acp" && record.host.sessionId === sessionId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((record) => ({
      id: record.id, nativeId: record.nativeId,
      sessionId: (record.handle.kind === "agy-session" ? record.handle.sessionId : null) ?? agyWorkerConversation(dataDir, record.nativeId)?.sessionId ?? null,
      name: record.summary.description, state: record.state, model: record.model, createdAt: record.createdAt, endedAt: record.endedAt,
    }));
}
