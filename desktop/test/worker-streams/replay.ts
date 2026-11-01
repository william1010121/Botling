// Replays recorded worker streams (test/fixtures/worker-streams/<engine>/<scenario>.jsonl) through an engine's
// WorkerAdapter and the shared WorkerCore, for the contract suite (test/unit/worker-core-contract.test.ts; shared-core
// spec §5.2). The fixtures come from the real CLIs (test/record/record-worker-streams.test.ts, scrubbed by
// scripts/scrub-worker-streams.mjs).
//
// A fixture file is a header line, then one line per stream line of one process:
//   {"t": <ms since the scenario started>, "d": "in" | "out" | "err" | "exit", "l": "<raw line>"}
// "in": app → CLI, "out": CLI → app, "err": stderr (none for Antigravity: it can hold OAuth URLs), "exit": the process
// closed ({"code","signal"} as JSON). A scenario with several processes (multiple-workers) has one file per process,
// <scenario>-1.jsonl, <scenario>-2.jsonl, …, on one clock. <scenario>.expect.json beside it was checked by hand.
//
// ── Writing an engine's registration (test/worker-streams/adapter-<engine>.ts, owned by its slice) ──────────────────
// The suite imports every adapter-*.ts and runs the same contract on each `ReplayRegistration` it exports
// (`export const registration` or `export const registrations = [...]`). A registration builds the engine's REAL
// WorkerAdapter with only its process layer replaced: where the adapter would spawn its CLI it calls
// `source.spawn()`, and from then on reads that process's recorded output through `onLine` / `onExit`, writes with
// `write`, and ends it with `kill`. Everything else (protocol parsing, translation into WorkerEvents) is the
// adapter's own code. `referenceRegistration` at the end of this file is the smallest complete example (claude
// stream-json, ~60 lines): the shape every registration follows.
//
//   export const registration: ReplayRegistration = {
//     engine: "claude",                  // the fixtures folder
//     kind: "claude-process",            // WorkerAdapterKind; the core hands off to it
//     ack: "none",                       // the coordinator's AckPolicy (Claude: none; Codex, Antigravity: checkpoint)
//     create: (source) => new ClaudeWorkerAdapter({ ..., head: (config, handlers) => fakeHead(source.spawn(), handlers) }),
//     skip: { C8: "recovery reads the Codex thread, not processes (TODO)" },   // optional, with the reason
//   };
//
// Time is collapsed: lines are fed in recorded order with their recorded `t` (for speed trackers), a macrotask apart.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodexItem } from "../../src/core/agent/codex";
import { parseLine, type StreamItem } from "../../src/core/agent/stream";
import { processStartTime } from "../../src/core/process/kill-tree";
import { ClaudeRequestTracker } from "../../src/core/token-speed";
import { ClaudeTokenFlowMeter } from "../../src/core/token-flow-claude";
import {
  costDelta, WorkerCore,
  type AckPolicy, type CoordinatorPort, type RecoverResult, type RunHandle, type WorkerAdapter, type WorkerAdapterKind, type WorkerEvent,
  type WorkerLedgerRecord, type WorkerReport, type WorkerStore,
} from "../../src/core/worker-core";

export const FIXTURES = join(__dirname, "..", "fixtures", "worker-streams");

// ------------------------------------------------------------------------------------------------
// Fixtures

export type Direction = "in" | "out" | "err" | "exit";
export interface StreamLine { t: number; d: Direction; l: string }
export interface FixtureHeader { engine: string; cli: string; recordedAt: string; scenario: string; process: number; command: string; args: string[] }

/**
 * What a scenario's recording is known to show (hand-checked). Every field is optional; a string field that starts with
 * "^" is a regular expression, ">=N" / "<=N" a bound, anything else must be equal. Per-worker values (multiple-workers)
 * are arrays in handoff order.
 */
export interface Expectation {
  /** The run's status under the core's rules (classifyRun): done | failed | stopped | interrupted. */
  status?: string;
  /** Where its report is afterwards (status.ts ReportState), with a coordinator that is busy. */
  reportState?: string;
  /** The report text (regex with "^"), its length, and per worker. */
  report?: string;
  reportChars?: number;
  reports?: string[];
  /** Text blocks the worker wrote (whole messages, never chunks). */
  textBlocks?: number | number[];
  /** Tool calls, and those whose result failed. */
  tools?: number | number[];
  failedTools?: number | number[];
  /** Finished model requests (tok/s samples). */
  requests?: number | number[];
  /** The output counter, with <conv> for the worker's conversation id. */
  counter?: string;
  /** Dollars the run cost (the CLI's final total); per worker for multiple-workers. */
  cost?: number | number[];
  /** Workers in the scenario. */
  workers?: number;
  /** Whether the recording's final reply really is empty (false: the suite strips the text for C3). */
  emptyReport?: boolean;
  /** cancel: when the recorder stopped the worker (ms on the recording's clock). */
  stopAt?: number;
  /** How the process ended, as recorded: "exit 0", "signal SIGKILL", "exit 143". */
  process?: string;
  /** What else is worth knowing about this recording (not checked). */
  notes?: string;
  [key: string]: unknown;
}

export interface Fixture { engine: string; scenario: string; header: FixtureHeader; lines: StreamLine[]; expect: Expectation }

function parse(file: string): { header: FixtureHeader; lines: StreamLine[] } {
  const [first, ...rest] = readFileSync(file, "utf8").split("\n").filter(Boolean);
  if (!first) throw new Error(`Empty fixture ${file}.`);
  return { header: JSON.parse(first) as FixtureHeader, lines: rest.map((line) => JSON.parse(line) as StreamLine) };
}

function expectation(engine: string, scenario: string): Expectation {
  const file = join(FIXTURES, engine, `${scenario}.expect.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Expectation : {};
}

/** The scenarios recorded for an engine (several-process scenarios once). */
export function fixtureScenarios(engine: string): string[] {
  const folder = join(FIXTURES, engine);
  if (!existsSync(folder)) return [];
  return [...new Set(readdirSync(folder).filter((name) => name.endsWith(".jsonl")).map((name) => name.replace(/(-\d+)?\.jsonl$/, "")))].sort();
}

/** A scenario's processes, in order (one for most scenarios). */
export function loadFixtures(engine: string, scenario: string): Fixture[] {
  const folder = join(FIXTURES, engine);
  const single = join(folder, `${scenario}.jsonl`);
  const files = existsSync(single) ? [single]
    : readdirSync(folder).filter((name) => new RegExp(`^${scenario.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d+\\.jsonl$`).test(name))
      .sort((a, b) => Number(/-(\d+)\.jsonl$/.exec(a)![1]) - Number(/-(\d+)\.jsonl$/.exec(b)![1])).map((name) => join(folder, name));
  if (!files.length) throw new Error(`No fixture ${engine}/${scenario}.`);
  const expect = expectation(engine, scenario);
  return files.map((file) => ({ engine, scenario, ...parse(file), expect }));
}

/** A single-process scenario. */
export function loadFixture(engine: string, scenario: string): Fixture {
  const fixtures = loadFixtures(engine, scenario);
  if (fixtures.length !== 1) throw new Error(`${engine}/${scenario} has ${fixtures.length} processes: use loadFixtures.`);
  return fixtures[0]!;
}

/** The lines the CLI wrote, in order. */
export const outLines = (fixture: Fixture): string[] => fixture.lines.filter((line) => line.d === "out").map((line) => line.l);

/** How the process ended (null: the recording ends with it still running). */
export function exitOf(fixture: Fixture): { code: number | null; signal: string | null } | null {
  const exit = fixture.lines.find((line) => line.d === "exit");
  return exit ? JSON.parse(exit.l) : null;
}

/** The stderr the process wrote (what an adapter would hand on for "exited"). */
export const stderrOf = (fixture: Fixture): string => fixture.lines.filter((line) => line.d === "err").map((line) => line.l).join("\n");

/** Several processes' lines on their one clock (multiple-workers), each tagged with its process's index. */
export function interleave(fixtures: Fixture[]): (StreamLine & { process: number })[] {
  return fixtures.flatMap((fixture, process) => fixture.lines.map((line) => ({ ...line, process })))
    .sort((a, b) => a.t - b.t || a.process - b.process);
}

/** The CLI version a fixture was recorded with differs from the one installed: the suite only warns (spec §5.1). */
export function versionWarning(fixture: Fixture, installed: string | null): string | null {
  return installed && installed !== fixture.header.cli ? `${fixture.engine}/${fixture.scenario} was recorded with ${fixture.header.cli}; installed: ${installed}.` : null;
}

/** Whether one observed value meets one expectation value (see Expectation). */
export function meets(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "string" && typeof actual === "number") {
    const bound = /^(>=|<=)\s*(\d+)$/.exec(expected);
    if (bound) return bound[1] === ">=" ? actual >= Number(bound[2]) : actual <= Number(bound[2]);
  }
  if (typeof expected === "string" && expected.startsWith("^") && typeof actual === "string") return new RegExp(expected, "s").test(actual);
  return JSON.stringify(expected) === JSON.stringify(actual);
}

/** The expectation's fields that the observed values do not meet (fields not observed are skipped; `notes` never counts). */
export function unmet(expect: Expectation, observed: Record<string, unknown>): string[] {
  return Object.entries(expect).filter(([key, value]) => key !== "notes" && key in observed && !meets(value, observed[key]))
    .map(([key, value]) => `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(observed[key])}`);
}

/**
 * The same recording with the worker's words taken out (C3 where no CLI would give an empty reply): claude text
 * deltas, text blocks and result.result; Codex agentMessage deltas and texts; ACP agent_message_chunk updates.
 */
export function withoutText(fixtures: Fixture[]): Fixture[] {
  const strip = (line: StreamLine): StreamLine | null => {
    if (line.d !== "out") return line;
    let m: any;
    try { m = JSON.parse(line.l); } catch { return line; }
    if (m?.type === "stream_event") {
      const event = m.event ?? {};
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") return null;
      if ((event.type === "content_block_start" && event.content_block?.type === "text")) return null;
      return line;
    }
    if (m?.type === "assistant" && Array.isArray(m.message?.content)) {
      const content = m.message.content.filter((block: any) => block?.type !== "text");
      if (!content.length) return null;
      return { ...line, l: JSON.stringify({ ...m, message: { ...m.message, content } }) };
    }
    if (m?.type === "result" && typeof m.result === "string") return { ...line, l: JSON.stringify({ ...m, result: "" }) };
    if (m?.method === "item/agentMessage/delta") return null;
    if ((m?.method === "item/completed" || m?.method === "item/started") && m.params?.item?.type === "agentMessage")
      return { ...line, l: JSON.stringify({ ...m, params: { ...m.params, item: { ...m.params.item, text: "" } } }) };
    if (m?.params?.update?.sessionUpdate === "agent_message_chunk") return null;
    return line;
  };
  return fixtures.map((fixture) => ({ ...fixture, lines: fixture.lines.map(strip).filter((line): line is StreamLine => !!line) }));
}

// ------------------------------------------------------------------------------------------------
// The replayed processes

export interface ProcessExit { code: number | null; signal: string | null }

/** One CLI process as a registration's adapter sees it: the recording plays into it. */
export interface ReplayProcess {
  /** Spawn order (0: the first process the adapter started). */
  readonly index: number;
  readonly fixture: Fixture;
  /** A fake pid (no real process: the core records it as an identity only). */
  readonly pid: number;
  /** What the adapter wrote to the CLI's stdin, one entry per write. */
  readonly written: string[];
  /** The adapter ended it (stop / close). The recording still plays: the core must drop what comes after. */
  killed: boolean;
  onLine(listener: (line: string, t: number) => void): void;
  onStderr(listener: (line: string) => void): void;
  onExit(listener: (exit: ProcessExit, stderr: string) => void): void;
  write(line: string): void;
  kill(): void;
}

/** Where a registration's adapter gets its processes. */
export interface ReplaySource {
  /** The next recorded process (beyond the recording: its fixtures again, for follow-up runs). */
  spawn(): ReplayProcess;
  readonly processes: ReplayProcess[];
}

/** What test/worker-streams/adapter-<engine>.ts exports (see the top of this file). */
export interface ReplayRegistration {
  /** The fixtures folder (claude, codex, editor, agy). */
  engine: string;
  /** What the core hands off to. */
  kind: WorkerAdapterKind;
  /** The coordinator's acknowledgement policy for this engine (Claude: none; Codex, Antigravity: checkpoint). */
  ack: AckPolicy;
  /** The engine's real adapter, its process layer on `source`. */
  create(source: ReplaySource): WorkerAdapter;
  /** Contract cases (C1…C12) this engine cannot run yet, with the reason. */
  skip?: Partial<Record<string, string>>;
  /** Engine-native lines for synthesized cases. `permission`: the CLI asking approval `nativeId` (C10). */
  synth?: { permission?(nativeId: string, tool: string, input: Record<string, unknown>): string[] };
  /** A label for the suite (default: engine). */
  label?: string;
}

const FAKE_PID = 4_000_000;

class Source implements ReplaySource {
  readonly processes: Process[] = [];
  constructor(private fixtures: Fixture[]) {}
  spawn(): Process {
    const index = this.processes.length;
    const process = new Process(index, this.fixtures[index % this.fixtures.length]!);
    this.processes.push(process);
    return process;
  }
}

class Process implements ReplayProcess {
  readonly written: string[] = [];
  readonly pid: number;
  killed = false;
  /** Times its recording was played (0: not yet). */
  played = 0;
  lines: ((line: string, t: number) => void)[] = [];
  stderr: ((line: string) => void)[] = [];
  exits: ((exit: ProcessExit, stderr: string) => void)[] = [];
  constructor(readonly index: number, readonly fixture: Fixture) { this.pid = FAKE_PID + index; }
  onLine(listener: (line: string, t: number) => void) { this.lines.push(listener); }
  onStderr(listener: (line: string) => void) { this.stderr.push(listener); }
  onExit(listener: (exit: ProcessExit, stderr: string) => void) { this.exits.push(listener); }
  write(line: string) { this.written.push(line); }
  kill() { this.killed = true; }
}

/** An in-memory WorkerStore. */
export class MemoryStore implements WorkerStore {
  constructor(public records: WorkerLedgerRecord[] = []) {}
  load() { return structuredClone(this.records); }
  save(records: readonly WorkerLedgerRecord[]) { this.records = structuredClone([...records]); }
}

/** A coordinator end that records what it was handed. Default answer "busy": reports stay pending (spec C9). */
export class RecordingPort implements CoordinatorPort {
  delivered: { report: WorkerReport; text: string }[] = [];
  constructor(readonly ack: AckPolicy, public answer: "taken" | "queued" | "busy" = "busy") {}
  deliver(report: WorkerReport, text: string) { this.delivered.push({ report, text }); return this.answer; }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

export interface ReplayContext {
  core: WorkerCore;
  workers: string[];
  source: ReplaySource;
  items: CodexItem[];
  port: RecordingPort;
  store: MemoryStore;
  /** Feeds one extra line (engine-native, e.g. `synth.permission`'s) to a started process, as if the CLI wrote it. */
  inject(processIndex: number, line: string, t?: number): void;
}

export interface ReplayOptions {
  /** Workers handed off before the recording plays (default: the expectation's `workers`, else 1). */
  workers?: number;
  /** The coordinator's answer to deliveries (default "busy"). */
  answer?: "taken" | "queued" | "busy";
  /** stopWorker(first worker) before the first line at or after this time. */
  stopAt?: number;
  /** More actions on the recording's clock. */
  at?: { t: number; run(ctx: ReplayContext): unknown }[];
  /** After the handoffs, before anything plays (set an owner, inject an approval). */
  before?(ctx: ReplayContext): unknown;
  /** Records the core loads at start (restart cases). */
  store?: MemoryStore;
  /** Hand off nothing: the case drives the core itself (restart cases). */
  noHandoff?: boolean;
  maxRunning?: number;
  restarted?: ReadonlySet<string>;
  /** Changes the adapter's events on their way to the core (null drops one): the suite's bug switches. */
  events?(event: WorkerEvent): WorkerEvent | null;
}

/** What replaying a scenario through an adapter and the core gives (spec §5.2). */
export interface ReplayResult extends ReplayContext {
  /** The core's records now (copies). */
  ledger: WorkerLedgerRecord[];
  /** The reports handed to the coordinator, in order. */
  delivered: { id: string; text: string }[];
  /** Plays what is new since: processes spawned meanwhile, else the last process's recording again (a kept-alive process). */
  playMore(): Promise<void>;
  /** Lines that never played because their process was never started. */
  unplayed: number;
}

/** Wraps an adapter so its events pass `filter` before they reach the core. */
function filtered(adapter: WorkerAdapter, filter: (event: WorkerEvent) => WorkerEvent | null): WorkerAdapter {
  const wrap = (run: RunHandle): RunHandle => ({ workerId: run.workerId, run: run.run, setEngineData: (patch) => run.setEngineData(patch), emit: (event) => { const kept = filter(event); if (kept) run.emit(kept); } });
  return new Proxy(adapter, { get: (target, key, receiver) => key === "start" ? (record: WorkerLedgerRecord, words: string, run: RunHandle) => target.start(record, words, wrap(run)) : Reflect.get(target, key, receiver) });
}

/** Replays `fixtures` (one scenario) through the registration's adapter and a WorkerCore. */
export async function replay(registration: ReplayRegistration, fixtures: Fixture[], options: ReplayOptions = {}): Promise<ReplayResult> {
  const source = new Source(fixtures);
  const store = options.store ?? new MemoryStore();
  const port = new RecordingPort(registration.ack, options.answer ?? "busy");
  const items: CodexItem[] = [];
  let n = 0;
  const adapter = options.events ? filtered(registration.create(source), options.events) : registration.create(source);
  const core = new WorkerCore({
    store, port, sink: { item: (item) => items.push(item) }, adapters: [adapter], ownerSessionId: () => "00000000-0000-4000-8000-0000000000c0",
    log: () => undefined, newId: () => `00000000-0000-4000-8000-${String(0xa00 + ++n).padStart(12, "0")}`, now: () => 1_000,
    processStartTime: (pid) => (pid >= FAKE_PID ? "replayed" : processStartTime(pid)), parentThreadId: () => "coordinator-thread",
    ...(options.maxRunning ? { maxRunning: () => options.maxRunning! } : {}), ...(options.restarted ? { restarted: () => options.restarted! } : {}),
  });
  const workers: string[] = [];
  const inject = (index: number, line: string, t = 0) => {
    const process = source.processes[index];
    if (!process) throw new Error(`Process ${index} was not started.`);
    for (const listener of process.lines) listener(line, t);
  };
  const ctx: ReplayContext = { core, workers, source, items, port, store, inject };
  const count = options.workers ?? fixtures[0]?.expect.workers ?? 1;
  if (!options.noHandoff) for (let i = 0; i < count; i++) workers.push((await core.handoff(registration.kind, { instructions: `Replayed task ${i + 1}.`, name: `replay-${i + 1}` })).task_id);
  await options.before?.(ctx);
  await flush();

  const actions = [...(options.at ?? []), ...(options.stopAt !== undefined ? [{ t: options.stopAt, run: (c: ReplayContext) => c.core.stopWorker(c.workers[0]!) }] : [])].sort((a, b) => a.t - b.t);
  let offset = 0;
  /** Plays these processes' recordings on one clock; a process's lines wait until the adapter started it. */
  const play = async (processes: Process[]) => {
    const queue = processes.flatMap((p) => p.fixture.lines.map((line) => ({ line, p }))).sort((a, b) => a.line.t - b.line.t || a.p.index - b.p.index);
    for (const p of processes) p.played += 1;
    let idle = 0;
    while (queue.length) {
      const next = queue.findIndex(({ p }) => source.processes.includes(p));
      const entry = next >= 0 ? queue[next] : undefined;
      // Lines of a process not started yet (a worker waiting for a slot, or one the adapter has not spawned) wait.
      if (!entry) {
        const late = source.processes.filter((p) => !processes.includes(p) && !p.played);
        if (late.length) { processes.push(...late); for (const p of late) { p.played += 1; queue.push(...p.fixture.lines.map((line) => ({ line, p }))); } queue.sort((a, b) => a.line.t - b.line.t || a.p.index - b.p.index); continue; }
        if (++idle > 20) break;
        await flush();
        continue;
      }
      idle = 0;
      const t = entry.line.t + offset;
      while (actions.length && actions[0]!.t + offset <= t) { await actions.shift()!.run(ctx); await flush(); }
      queue.splice(next, 1);
      const { line, p } = entry;
      if (line.d === "out") for (const listener of p.lines) listener(line.l, t);
      else if (line.d === "err") for (const listener of p.stderr) listener(line.l);
      else if (line.d === "exit") for (const listener of p.exits) listener(JSON.parse(line.l), stderrOf(p.fixture));
      await flush();
      // Processes the adapter started meanwhile (a waiting worker's turn) join the clock.
      const late = source.processes.filter((q) => !processes.includes(q) && !q.played);
      if (late.length) { processes.push(...late); for (const q of late) { q.played += 1; queue.push(...q.fixture.lines.map((l) => ({ line: { ...l, t: Math.max(l.t, entry.line.t) }, p: q }))); } queue.sort((a, b) => a.line.t - b.line.t || a.p.index - b.p.index); }
    }
    while (actions.length) { await actions.shift()!.run(ctx); await flush(); }
    offset += Math.max(0, ...processes.flatMap((p) => p.fixture.lines.map((line) => line.t))) + 1_000;
    return queue.length;
  };
  const unplayed = await play(source.processes.filter((p) => !p.played));
  await flush();
  return {
    ...ctx,
    get ledger() { return core.all(); },
    get delivered() { return port.delivered.map(({ report, text }) => ({ id: report.id, text })); },
    unplayed,
    playMore: async () => {
      const fresh = source.processes.filter((p) => !p.played);
      await play(fresh.length ? fresh : source.processes.slice(-1));
      await flush();
    },
  };
}

// ------------------------------------------------------------------------------------------------
// The reference registration: claude stream-json → WorkerEvents. The smallest complete adapter on a ReplaySource; the
// suite runs it on the claude and editor recordings, so the harness and the contract are exercised before S1–S3's
// adapters exist. A real registration builds its engine's own adapter instead (see the top of this file).

class ReferenceClaudeAdapter implements WorkerAdapter {
  readonly engine = "claude" as const;
  readonly steersRunning = true;
  private processes = new Map<string, ReplayProcess>();
  constructor(private source: ReplaySource, readonly kind: WorkerAdapterKind) {}

  start(record: Readonly<WorkerLedgerRecord>, words: string, run: RunHandle) {
    const process = this.source.spawn();
    this.processes.set(record.id, process);
    const cost = { last: 0 };
    const speed = new ClaudeRequestTracker();
    const meter = new ClaudeTokenFlowMeter(record.conversationId ?? record.id);
    speed.boundary(null, 0);
    run.emit({ type: "process", pid: process.pid });
    process.onLine((line, t) => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { /* parseLine says what it is */ }
      for (const { scope: _scope, ...request } of speed.observe(message, t)) run.emit({ type: "request", request });
      for (const item of parseLine(line)) { const event = this.event(item, cost); if (event) run.emit(event); }
      for (const measurement of meter.observe(line, t)) run.emit({ type: "measurement", provider: "claude", measurement });
    });
    process.onExit((exit, stderr) => run.emit({ type: "end", end: { how: "exited", finalText: null, error: stderr.trim() || `The worker's process ended before its report (${exit.signal ?? `exit ${exit.code}`}).`, detail: "exit" } }));
    process.write(JSON.stringify({ type: "user", message: { role: "user", content: words } }));
  }

  private event(item: StreamItem, cost: { last: number }): WorkerEvent | null {
    switch (item.kind) {
      case "init": return { type: "session", conversationId: item.sessionId };
      case "delta": return { type: "textDelta", text: item.text };
      case "textBlock": return { type: "textBreak" };
      case "assistantText": return { type: "textWhole", text: item.text, phase: null };
      case "toolUse": return { type: "toolUse", id: item.id, tool: item.tool, title: item.title, detail: item.detail, input: item.input };
      case "toolResult": return { type: "toolResult", id: item.id, output: item.output, failed: item.failed };
      case "usage": return { type: "usage", tokens: item.tokens, cost: costDelta(cost, item.totalCost) };
      case "permission": return { type: "permission", nativeId: item.requestId, tool: item.tool, summary: item.summary, input: item.input, ...(item.safetyCheck ? { safetyCheck: item.safetyCheck } : {}), ...(item.noAlways ? { noAlways: true } : {}) };
      case "permissionCancelled": return { type: "permissionCancelled", nativeId: item.requestId };
      case "permissionDenied": return { type: "permissionDenied", toolUseId: item.toolUseId, tool: item.tool, reason: item.reason, confirmed: item.confirmed };
      case "connectionLost": return { type: "connectionLost" };
      case "rateLimits": return { type: "rateLimits", engine: item.engine, limits: item.limits };
      case "result": return { type: "end", end: { how: item.how ?? (item.ok ? "normal" : "error"), finalText: item.text || null, error: item.error || null, detail: item.subtype } };
      default: return null;
    }
  }

  steer(record: Readonly<WorkerLedgerRecord>, words: string) {
    const process = this.processes.get(record.id);
    if (!process || process.killed) return false;
    process.write(JSON.stringify({ type: "user", message: { role: "user", content: words } }));
    return true;
  }

  async stop(record: Readonly<WorkerLedgerRecord>) { this.processes.get(record.id)?.kill(); return { cleaned: true }; }

  answer(record: Readonly<WorkerLedgerRecord>, nativeId: string, allow: boolean, input: Record<string, unknown>, message?: string) {
    const decision = allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: message ?? "The user did not allow this." };
    this.processes.get(record.id)?.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: nativeId, response: decision } }));
  }

  /** Clean once none of its recorded processes is alive with the same start time (claude-workers.ts recoveryBlocker). */
  recover(record: Readonly<WorkerLedgerRecord>): RecoverResult {
    const alive = record.processes.filter((p) => p.pid < FAKE_PID && processStartTime(p.pid) === p.started);
    return alive.length ? { state: "blocked", reason: `Its earlier process ${alive[0]!.pid} is still running.` } : { state: "clean" };
  }

  async close() { for (const process of this.processes.values()) process.kill(); }
}

/** The reference registration for a claude stream-json engine's recordings (claude workers, the component editor). */
export function referenceRegistration(engine: "claude" | "editor"): ReplayRegistration {
  const kind: WorkerAdapterKind = engine === "editor" ? "component-editor" : "claude-process";
  return {
    engine, kind, ack: "none", label: `reference adapter on ${engine} recordings`,
    create: (source) => new ReferenceClaudeAdapter(source, kind),
    synth: {
      permission: (nativeId, tool, input) => [JSON.stringify({ type: "control_request", request_id: nativeId, request: { subtype: "can_use_tool", tool_name: tool, input } })],
    },
  };
}
