// A bot's subagents on disk (2.1+):
//   subagents.json            the INDEX: {format, subagents:[...]}, one small entry per subagent (everything
//                             the rows and chips read, but no steps); rewritten atomically, it stays small.
//   subagents/<name>.jsonl    one subagent's steps, append-only: one JSON line per step ("step"), per later
//                             change to a step ("patch": its output/done/failed) and per run boundary
//                             ("run": what the run that just ended was, so the steps before it are its).
// Only the subagent that is expanded in the UI has its file read (`readSteps`, tail-bounded). Nothing
// ever rewrites a steps file. The pre-2.1 format (steps and previous runs inside subagents.json, with the
// old journal next to it) is split once on load, and the original is kept as subagents.json.bak.
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { readLegacyRows, type LegacyRow } from "./legacy-history";
import type { StepRecord } from "./records";

export const INDEX_FORMAT = "botling-subagents-v2";
/** A prompt or report kept in the index (the UI shows at most 20 000 characters of either). */
const INDEX_TEXT_LIMIT = 50_000;
/** One field of one step (an output) kept in a steps file. */
const STEP_FIELD_LIMIT = 200_000;
/** The most the reader takes from the end of a steps file. */
export const READ_TAIL_BYTES = 16 * 1024 * 1024;

export interface RunMeta {
  execution?: unknown;
  prompt?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  result?: string;
}

export type SubagentLine =
  | { k: "step"; step: StepRecord }
  | { k: "patch"; id: string; set: Partial<StepRecord> }
  | { k: "run"; run: RunMeta };

export interface SubagentHistory {
  /** Earlier runs, oldest first, each with its own steps. */
  runs: { run: RunMeta; steps: StepRecord[] }[];
  /** The current run's steps. */
  steps: StepRecord[];
}

/**
 * The file name for a subagent id. Ids are tool-use ids or UUIDs, but a transcript could name
 * anything: every byte outside [A-Za-z0-9_-] (so also `/`, `\`, `:`, `.` and NUL) becomes %XX, which keeps
 * the name inside the folder, valid on every OS, and different for different ids. Very long ids
 * are cut and given a digest.
 */
export function subagentFileName(id: string): string {
  if (typeof id !== "string" || !id) throw new Error("A subagent id must be a non-empty string");
  let name = "";
  for (const byte of Buffer.from(id, "utf8")) {
    const char = String.fromCharCode(byte);
    name += /[A-Za-z0-9_-]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (name.length > 120) name = `${name.slice(0, 80)}~${createHash("sha1").update(id).digest("hex").slice(0, 24)}`;
  return `${name}.jsonl`;
}

const clipText = (value: unknown, limit: number) => typeof value === "string" && value.length > limit ? value.slice(0, limit) : value;

/** What the index keeps of a record: no steps, no run history, bounded texts. */
export function indexEntry(record: Record<string, unknown>): Record<string, unknown> {
  const { steps: _steps, previousRuns: _runs, ...rest } = record;
  if ("prompt" in rest) rest.prompt = clipText(rest.prompt, INDEX_TEXT_LIMIT);
  if ("result" in rest) rest.result = clipText(rest.result, INDEX_TEXT_LIMIT);
  return rest;
}

function boundedStep(step: StepRecord): StepRecord {
  let copy: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(step)) {
    if (typeof value === "string" && value.length > STEP_FIELD_LIMIT) (copy ??= { ...step })[key] = value.slice(0, STEP_FIELD_LIMIT);
  }
  return (copy ?? step) as unknown as StepRecord;
}

export function encodeLine(line: SubagentLine): string {
  if (line.k === "step") return JSON.stringify({ k: "step", step: boundedStep(line.step) });
  if (line.k === "patch") return JSON.stringify({ k: "patch", id: line.id, set: boundedStep(line.set as StepRecord) });
  return JSON.stringify({ k: "run", run: { ...line.run, prompt: clipText(line.run.prompt, INDEX_TEXT_LIMIT), result: clipText(line.run.result, INDEX_TEXT_LIMIT) } });
}

function validStep(value: unknown): value is StepRecord {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as StepRecord).id === "string";
}

/** Folds the lines into runs. A line that is not JSON or not a known shape is skipped. */
export function foldLines(lines: Iterable<string>): SubagentHistory {
  const history: SubagentHistory = { runs: [], steps: [] };
  for (const text of lines) {
    if (!text.trim()) continue;
    let line: any;
    try { line = JSON.parse(text); } catch { continue; }
    if (!line || typeof line !== "object") continue;
    if (line.k === "step" && validStep(line.step)) history.steps.push(line.step);
    else if (line.k === "patch" && typeof line.id === "string" && line.set && typeof line.set === "object") {
      const step = history.steps.findLast(candidate => candidate.id === line.id);
      if (step) Object.assign(step, line.set);
    } else if (line.k === "run" && line.run && typeof line.run === "object") {
      history.runs.push({ run: line.run as RunMeta, steps: history.steps });
      history.steps = [];
    }
  }
  return history;
}

function fsyncDirectory(directory: string) {
  if (process.platform === "win32") return;
  try { const fd = openSync(directory, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* best effort */ }
}

function parseFile(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

function freeName(path: string): string {
  return existsSync(path) ? `${path}.${Date.now()}` : path;
}

export class SubagentStore {
  readonly file: string;
  readonly directory: string;
  private readonly migrating: string;
  private loaded = false;
  private broken: Error | null = null;
  private known = new Set<string>();
  private staged = new Map<string, string[]>();
  /** An append that failed may have left half a line: the next one starts on a fresh line. */
  private torn = new Set<string>();
  private entries = new Map<string, string>();
  private lastIndex = "";

  constructor(botFolder: string) {
    this.file = join(botFolder, "subagents.json");
    this.directory = join(botFolder, "subagents");
    this.migrating = `${this.file}.migrating`;
  }

  pathFor(id: string) { return join(this.directory, subagentFileName(id)); }

  /** The index entries. Splits an old-format file first (once). Throws when the file cannot be read; it is then left alone. */
  load(): Record<string, unknown>[] {
    this.loaded = true;
    try {
      const rows = this.read();
      this.known = new Set(rows.map(row => String(row.id)));
      this.entries.clear();
      for (const row of rows) this.entries.set(String(row.id), JSON.stringify(row));
      this.lastIndex = this.encode();
      return rows;
    } catch (error) {
      this.broken = error as Error;
      throw error;
    }
  }

  private read(): Record<string, unknown>[] {
    // A split that was cut short after its index was complete.
    if (!existsSync(this.file) && existsSync(this.migrating)) renameSync(this.migrating, this.file);
    const journal = this.file + ".journal";
    if (!existsSync(this.file)) return existsSync(journal) ? this.migrate([]) : [];
    const value = parseFile(this.file) as any;
    if (value?.format === INDEX_FORMAT && Array.isArray(value.subagents)) {
      rmSync(this.migrating, { force: true });
      return value.subagents.filter((row: unknown): row is Record<string, unknown> => !!row && typeof row === "object" && typeof (row as any).id === "string");
    }
    return this.migrate(value);
  }

  /** The old file (plus journal) → the index and one steps file each. Crash-safe: new files first, then the old one is moved aside. */
  private migrate(parsed: unknown): Record<string, unknown>[] {
    let rows: (LegacyRow | null)[] = readLegacyRows(this.file, parsed);
    parsed = undefined;
    mkdirSync(this.directory, { recursive: true });
    const index: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i]!;
      rows[i] = null; // Each record's steps are released as soon as they are written.
      if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || typeof raw.startedAt !== "number" || seen.has(raw.id)) continue;
      seen.add(raw.id);
      const entry = indexEntry(raw);
      const earlier = Array.isArray(raw.previousRuns) ? (raw.previousRuns as Record<string, unknown>[]).filter(run => run && typeof run === "object") : [];
      const steps = Array.isArray(raw.steps) ? (raw.steps as unknown[]).filter(validStep) : [];
      const target = this.pathFor(raw.id);
      const temp = `${target}.migrating`;
      const fd = openSync(temp, "w", 0o600);
      let wrote = false;
      try {
        let chunk: string[] = [], size = 0;
        const put = (line: SubagentLine) => {
          const text = encodeLine(line);
          chunk.push(text); size += text.length + 1; wrote = true;
          if (size > 1_000_000) { writeSync(fd, chunk.join("\n") + "\n"); chunk = []; size = 0; }
        };
        for (const run of earlier) {
          for (const step of Array.isArray(run.steps) ? run.steps : []) if (validStep(step)) put({ k: "step", step });
          put({ k: "run", run: { execution: run.execution, prompt: run.prompt as string, status: run.status as string, startedAt: run.startedAt as number, endedAt: run.endedAt as number, result: run.result as string } });
        }
        for (const step of steps) put({ k: "step", step });
        if (chunk.length) writeSync(fd, chunk.join("\n") + "\n");
        fsyncSync(fd);
      } finally { closeSync(fd); }
      if (wrote) renameSync(temp, target); else rmSync(temp, { force: true });
      entry.toolCount = steps.filter(step => step.kind === "tool" || step.kind === "subagent").length;
      entry.stepCount = steps.length;
      if (earlier.length) entry.runs = earlier.length;
      index.push(entry);
    }
    rows = [];
    fsyncDirectory(this.directory);
    writeFileAtomic(this.migrating, JSON.stringify({ format: INDEX_FORMAT, subagents: index }));
    if (existsSync(this.file)) renameSync(this.file, freeName(this.file + ".bak"));
    renameSync(this.migrating, this.file);
    const journal = this.file + ".journal";
    if (existsSync(journal)) { try { renameSync(journal, freeName(journal + ".bak")); } catch { /* the index no longer reads it */ } }
    fsyncDirectory(dirname(this.file));
    return index;
  }

  /** A line to append to this subagent's file at the next `commit`/`flush`. */
  stage(id: string, line: SubagentLine) {
    const list = this.staged.get(id);
    const text = encodeLine(line);
    if (list) list.push(text); else this.staged.set(id, [text]);
  }

  get pending(): boolean { return this.staged.size > 0; }

  /** Appends what is staged. A failure keeps that subagent's lines staged and throws after trying the others. */
  flush(): void {
    let failure: unknown;
    for (const [id, lines] of [...this.staged]) {
      try {
        mkdirSync(this.directory, { recursive: true });
        appendFileSync(this.pathFor(id), (this.torn.has(id) ? "\n" : "") + lines.join("\n") + "\n", { mode: 0o600 });
        this.staged.delete(id);
        this.torn.delete(id);
      } catch (error) { this.torn.add(id); failure ??= error; }
    }
    if (failure) throw failure;
  }

  /** Appends the staged lines, then rewrites the index when an entry changed. Files of subagents that left the list are removed. */
  commit(list: readonly Record<string, unknown>[], changed?: ReadonlySet<string>): void {
    if (!this.loaded) { try { this.load(); } catch { /* reported below */ } }
    if (this.broken) throw this.broken;
    this.flush();
    const ids = new Set<string>();
    for (const record of list) {
      const id = String(record.id);
      ids.add(id);
      if (!changed || changed.has(id) || !this.entries.has(id)) this.entries.set(id, JSON.stringify(indexEntry(record)));
    }
    for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.entries.delete(id);
    const text = this.encode(list);
    if (text !== this.lastIndex) { writeFileAtomic(this.file, text); this.lastIndex = text; }
    for (const id of this.known) if (!ids.has(id)) { try { rmSync(this.pathFor(id), { force: true }); } catch { /* an orphan only */ } }
    this.known = ids;
  }

  private encode(list?: readonly Record<string, unknown>[]): string {
    const order = list ? list.map(record => String(record.id)) : [...this.entries.keys()];
    return `{"format":"${INDEX_FORMAT}","subagents":[${order.map(id => this.entries.get(id)!).join(",")}]}`;
  }

  /** One subagent's steps from disk (what is staged is appended first). Reads at most `maxBytes` from the end of the file. */
  readSteps(id: string, maxBytes = READ_TAIL_BYTES): SubagentHistory {
    try { this.flush(); } catch { /* read what is there */ }
    let fd: number;
    try { fd = openSync(this.pathFor(id), "r"); } catch { return { runs: [], steps: [] }; }
    try {
      const size = statSync(this.pathFor(id)).size;
      const start = Math.max(0, size - maxBytes);
      const buffer = Buffer.alloc(size - start);
      let offset = 0;
      while (offset < buffer.length) {
        const n = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
        if (!n) break;
        offset += n;
      }
      let text = buffer.subarray(0, offset).toString("utf8");
      // Cut in the middle of a line: start at the next one.
      if (start > 0) { const cut = text.indexOf("\n"); text = cut < 0 ? "" : text.slice(cut + 1); }
      return foldLines(text.split("\n"));
    } finally { closeSync(fd); }
  }
}
