// Claude's app-managed workers (spec X, now the default): every Claude subagent is a worker of its own, a
// separate `claude -p` process with its own session, started and steered by the app through the same app tools
// Codex and Antigravity coordinators use (app_handoff, app_send_message, app_cancel_task). The coordinator's
// native Agent/Task tool is removed (head.ts `agentGuard`). Because a worker is its own process, the coordinator's
// Stop, sleep, model switch or restart never touch it; only `app_cancel_task`, the row's Stop or the app quitting do.
//
// `ClaudeWorkers` is a facade over the shared worker core (worker-core/, shared-core spec S1): the core holds the
// workers' state machine, text, end, report and approvals; this file keeps only what is Claude's (spec 4.2): the
// process (one ClaudeHead per worker, kept alive a while after a result, then `--resume` of its own session), agent
// definitions and model names, the settle wait for words steered into a run (command_lifecycle), and the process's
// running cost turned into spend. The bot injects its member's core (`core`: the member's worker ledger, importing
// claude-workers.json once, and its projections); the core's items go to the bot's `emit` (its one worker entry).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { processStartTime } from "../process/kill-tree";
import { endTree, type TerminateResult } from "../process/tree";
import {
  ClaudeLegacyStore, WorkerCore,
  type HandoffRequest, type WorkerCoreFactory, type WorkerCoreOptions, type RecoverResult, type RunHandle, type WorkerAdapter, type WorkerLedgerRecord,
} from "../worker-core";
import { ClaudeStreamEvents } from "./claude-worker-events";
import type { CodexItem } from "./codex";
import type { AppToolSpec, HeadConfig, HeadHandlers } from "./head";
import type { StreamItem } from "./stream";
import type { WorkerHost, WorkerInfo, WorkerOwner, WorkerOwnerResult, WorkerSendResult } from "./workers";

/** What the adapter needs of a worker's process (ClaudeHead; a fake in tests). */
export interface ClaudeWorkerHead {
  readonly pid: number;
  readonly running: boolean;
  start(): void;
  send(text: string, uuid: string): void;
  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string): void;
  finish(): void;
  terminate(graceMs?: number): Promise<TerminateResult>;
  /** Whether its process tree is gone, checked now (absent or undefined: only terminate's answer tells). */
  gone?(): boolean | undefined;
}

/** The in-process MCP server Claude coordinators get (head.ts `appMcp`). */
export const CLAUDE_APP_SERVER = "botling";
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string" };
export const CLAUDE_APP_TOOLS: AppToolSpec[] = [
  { name: "app_handoff", description: "Start an app-managed worker: a Claude subagent that runs as its own session in this bot's folder and reports back to you. Use it wherever you would use the Agent tool (which is off here): give a short name and complete, self-contained instructions; subagent_type picks a .claude/agents definition, model overrides the worker's model (haiku, sonnet, opus). Returns task_id and run at once; the worker's report arrives later as an app message (<app_task_result>). Finish your turn instead of waiting or polling.",
    inputSchema: schema({ name: text, instructions: text, subagent_type: text, model: text }, ["instructions"]) },
  { name: "app_send_message", description: "Send words to one of your workers by task_id: joined into its run while it works, or the start of its next run (same session, same task) once it has reported. Its next report comes as an app message.",
    inputSchema: schema({ task_id: text, message: text, run: { type: "integer", minimum: 1 } }, ["task_id", "message"]) },
  { name: "app_cancel_task", description: "Stop one of your workers by task_id. Its work so far stays; no report is made.",
    inputSchema: schema({ task_id: text, run: { type: "integer", minimum: 1 } }, ["task_id"]) },
];

/** The deny reason the coordinator reads if a native Agent/Task call still gets through (head.ts `agentGuard`). */
export const CLAUDE_AGENT_GUARD = "Native subagents are off in Botling: the app runs every subagent as a worker of its own. Call the app_handoff tool instead (botling MCP server; load it with ToolSearch if it is deferred), with this call's prompt as instructions, its description as name, and its subagent_type. Do not retry Agent or Task.";
/** The same guard inside a worker: workers do their task themselves. */
export const CLAUDE_WORKER_GUARD = "You are an app-managed worker: you cannot start subagents or workers. Do this part yourself, or say in your report what should be handed to someone else.";

/** What a worker is told about itself, before any agent definition's own prompt. */
export const CLAUDE_WORKER_POLICY = [
  "You are an app-managed worker in Botling, started by a coordinator bot. Do the task in your instructions yourself: read, research, edit, build and run meaningful tests as needed, within the user's existing permissions.",
  "You cannot start subagents or workers, and you do not talk to the user: the app hands your final message of each run to the coordinator as your report.",
  "End every run with a concise report: what you did, the evidence (commands and their results, files changed), and anything left, blocked or needing a decision.",
  "Messages that arrive later come from the coordinator and continue the same task.",
].join("\n");

/** A `.claude/agents/<type>.md` definition, as far as a worker can reproduce it. */
export interface AgentDefinition { name: string; prompt: string; model: string | null; tools: string[] | null }

/** Types Claude Code has built in (no file): a plain worker. */
const BUILT_IN_TYPES = new Set(["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide"]);
const MODEL_ALIASES = new Set(["haiku", "sonnet", "opus"]);

/**
 * The definition for `subagent_type`: the project's .claude/agents, then the user's, then the plugins' agents/ folders
 * (`plugin:name` or `name`). Null: none needed (no type, or a built-in one). An error: refused, never substituted.
 */
export function loadAgentDefinition(type: string | null | undefined, cwd: string, { home = homedir(), pluginDirs = [] as string[] } = {}): AgentDefinition | { error: string } | null {
  const wanted = type?.trim();
  if (!wanted || BUILT_IN_TYPES.has(wanted)) return null;
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(wanted)) return { error: `Invalid subagent_type "${wanted}". Nothing was started.` };
  const short = wanted.includes(":") ? wanted.slice(wanted.lastIndexOf(":") + 1) : wanted;
  const files = [join(cwd, ".claude", "agents", `${short}.md`), join(home, ".claude", "agents", `${short}.md`), ...pluginDirs.map((dir) => join(dir, "agents", `${short}.md`))];
  for (const file of files) {
    let raw: string;
    try { raw = readFileSync(file, "utf8"); } catch { continue; }
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
    const fields: Record<string, string> = {};
    for (const line of match?.[1]!.split(/\r?\n/) ?? []) {
      const at = line.indexOf(":");
      if (at > 0 && !/^\s/.test(line)) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const prompt = (match ? match[2]! : raw).trim();
    if (!prompt) return { error: `The agent definition ${file} has no instructions. Nothing was started.` };
    for (const key of ["hooks", "mcpServers", "mcp_servers"]) {
      if (key in fields) return { error: `The agent definition ${file} sets ${key}, which an app-managed worker cannot reproduce. Nothing was started; no other worker was substituted.` };
    }
    const model = fields.model && fields.model !== "inherit" ? fields.model : null;
    if (model && !MODEL_ALIASES.has(model) && !/^claude-[a-z0-9.-]+$/.test(model)) return { error: `The agent definition ${file} names an unknown model "${model}". Nothing was started.` };
    const tools = fields.tools ? fields.tools.split(",").map((tool) => tool.trim()).filter(Boolean) : null;
    return { name: fields.name || short, prompt, model, tools: tools?.length ? tools : null };
  }
  return { error: `No agent definition named "${wanted}" in ${join(cwd, ".claude", "agents")}, ~/.claude/agents or the plugins. Nothing was started; use a type that exists or leave subagent_type out.` };
}

export interface ClaudeWorkersOptions {
  /** claude-workers.json: imported once into the member's ledger; the journal itself when no core is injected. */
  file: string;
  /** The member's core (Bot: its worker ledger and projections). Absent: a core of its own over `file`. */
  core?: WorkerCoreFactory;
  /** The coordinator's session now (a run's `execution.ownerSessionId`). */
  ownerSessionId(): string;
  /** The coordinator head's config now: command, environment, permissions. Null: it cannot start one. */
  base(): HeadConfig | null;
  /** The folder workers run in (the host's working folder). */
  cwd(): string;
  /** The bot's subagent model (null: the coordinator's model). */
  subagentModel(): string | null;
  /** Plugin folders whose agents/ count as definitions. */
  pluginDirs?(): string[];
  processStarted?(pid: number): void;
  /** How long a worker's process stays after a result for a quick follow-up (default 10 minutes). */
  keepAliveMs?: number;
  /** How long a result waits for a queued follow-up's own turn to start (default 1.5 s). */
  settleMs?: number;
  /** How many workers may be at work in their own processes at once (settings.json `claudeWorkerLimit`); more wait for a slot. */
  maxRunning?(): number;
  home?: string;
  /** The core's log lines (a run's verdict, a failed delivery). */
  log?(line: string): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Workers at work at once in their own `claude` processes, unless settings.json says otherwise (each process is a few hundred MB). */
export const DEFAULT_CLAUDE_WORKER_LIMIT = 4;
export const CLAUDE_WORKER_LIMIT_MAX = 16;

const workerLimit = (wanted = DEFAULT_CLAUDE_WORKER_LIMIT) =>
  (Number.isSafeInteger(wanted) && wanted >= 1 ? Math.min(wanted, CLAUDE_WORKER_LIMIT_MAX) : DEFAULT_CLAUDE_WORKER_LIMIT);
const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** A worker's process and the run under way in it; everything else about the worker is the core's. */
interface Proc {
  head?: ClaudeWorkerHead;
  /**
   * The process tree it must see gone before another process takes its session: the head's, kept after its leader
   * exits until the whole tree is confirmed gone (`endTree`).
   */
  tree?: ClaudeWorkerHead;
  /** The run under way (undefined: between runs, or stopped). */
  run?: RunHandle;
  /** The worker's record as the core keeps it (read only here). */
  record?: Readonly<WorkerLedgerRecord>;
  /** Words steered into the run whose turn has not started yet (command_lifecycle). */
  queued: Set<string>;
  /** Its stream as WorkerEvents (text blocks, spend), the same as the component editor's. */
  stream: ClaudeStreamEvents;
  settle?: ReturnType<typeof setTimeout>;
  pendingResult?: Extract<StreamItem, { kind: "result" }>;
  keepAlive?: ReturnType<typeof setTimeout>;
  /** The config a run started with, for its opening items (null: it went into the kept-alive process). */
  opening?: { run: number; base: HeadConfig | null };
}

/** What the Claude adapter needs of the bot (ClaudeWorkersOptions without the journal and the coordinator). */
export type ClaudeAdapterOptions = Pick<ClaudeWorkersOptions, "base" | "cwd" | "subagentModel" | "pluginDirs" | "processStarted" | "keepAliveMs" | "settleMs" | "home">;

/**
 * The Claude engine adapter (shared-core spec 4.1, the Claude row of 4.2): one `claude` process per worker, its
 * stream items translated into WorkerEvents on the run's handle.
 */
export class ClaudeWorkerAdapter implements WorkerAdapter {
  readonly kind = "claude-process" as const;
  readonly engine = "claude" as const;
  readonly steersRunning = true;
  private procs = new Map<string, Proc>();
  private closed = false;

  constructor(private options: ClaudeAdapterOptions, private factory: (config: HeadConfig, handlers: HeadHandlers) => ClaudeWorkerHead) {}

  private procOf(id: string): Proc {
    let proc = this.procs.get(id);
    if (!proc) { proc = { queued: new Set(), stream: new ClaudeStreamEvents() }; this.procs.set(id, proc); }
    return proc;
  }

  private definition(type: string | null) {
    return loadAgentDefinition(type, this.options.cwd(), { home: this.options.home, pluginDirs: this.options.pluginDirs?.() ?? [] });
  }

  private model(r: Readonly<WorkerLedgerRecord>, base: HeadConfig | null) {
    return nonEmpty(r.engineData.model) ?? this.options.subagentModel() ?? base?.model ?? null;
  }

  /** Its definition and model are checked before anything is recorded; its session id is chosen now (`--session-id`). */
  prepare(request: HandoffRequest) {
    const definition = this.definition(request.type);
    if (definition && "error" in definition) throw new Error(definition.error);
    if (request.model && !MODEL_ALIASES.has(request.model) && !/^claude-[a-z0-9.-]+$/.test(request.model)) throw new Error(`Unknown model "${request.model}": use haiku, sonnet or opus.`);
    return { engineData: { sessionId: randomUUID(), sessionStarted: false, model: request.model ?? definition?.model ?? null } };
  }

  /** A run into its kept-alive process takes no slot. */
  needsSlot(r: Readonly<WorkerLedgerRecord>) { return !this.procs.get(r.id)?.head?.running; }

  runtime(r: Readonly<WorkerLedgerRecord>) {
    const proc = this.procs.get(r.id);
    const base = proc?.opening?.run === r.run ? proc.opening.base : proc?.head?.running ? null : this.options.base();
    return { reasoningEffort: base?.effort ?? null, model: this.model(r, base) };
  }

  /** Sends a run's first words: into its kept-alive process, or a new one (`--resume` once its session exists). */
  start(r: Readonly<WorkerLedgerRecord>, words: string, run: RunHandle) {
    const proc = this.procOf(r.id);
    if (proc.keepAlive) { clearTimeout(proc.keepAlive); proc.keepAlive = undefined; }
    const sessionId = nonEmpty(r.engineData.sessionId) ?? r.conversationId ?? r.id;
    if (proc.head?.running) {
      Object.assign(proc, { run, record: r, opening: { run: run.run, base: null }, pendingResult: undefined });
      proc.stream.newRun();
      proc.queued.clear();
      run.emit({ type: "session", conversationId: sessionId });
      proc.head.send(words, randomUUID());
      return;
    }
    // Never two processes on one session: an earlier tree must be gone first (a leader that exited may leave children).
    if (proc.tree && proc.tree.gone?.() === false) throw new Error("This worker's earlier process is still ending; try again in a moment.");
    const base = this.options.base();
    if (!base) throw new Error("Workers cannot start now: this bot's Claude head is unavailable.");
    const def = r.type ? this.definition(r.type) : null;
    if (def && "error" in def) throw new Error(def.error);
    const config: HeadConfig = {
      ...base, cwd: this.options.cwd(), sessionId, resume: r.engineData.sessionStarted === true, forkSession: false, persistSession: true,
      model: this.model(r, base), monitorWorker: true, appMcp: null, agentGuard: CLAUDE_WORKER_GUARD,
      systemPrompt: [CLAUDE_WORKER_POLICY, def?.prompt ?? ""].filter(Boolean).join("\n\n"),
      disallowedTools: [...new Set([...(base.disallowedTools ?? []), "SendMessage", "TaskStop"])],
      ...(def?.tools ? { tools: def.tools } : {}),
    };
    // A kept-alive process carries later runs too: its items belong to whichever run is under way.
    const head: ClaudeWorkerHead = this.factory(config, { onItem: (item) => this.onItem(r.id, head, item), onExit: (exit) => this.onExit(r.id, head, exit) });
    head.start();
    Object.assign(proc, { head, tree: head, run, record: r, opening: { run: run.run, base }, pendingResult: undefined });
    proc.stream.newProcess();
    proc.queued.clear();
    run.emit({ type: "session", conversationId: sessionId });
    if (head.pid > 0) {
      try { this.options.processStarted?.(head.pid); } catch { /* the ledger is best effort here; the core records its identity */ }
      run.emit({ type: "process", pid: head.pid });
    }
    head.send(words, randomUUID());
  }

  steer(r: Readonly<WorkerLedgerRecord>, words: string): boolean {
    const proc = this.procs.get(r.id);
    if (!proc?.run || !proc.head?.running) return false;
    const uuid = randomUUID();
    proc.queued.add(uuid);
    proc.head.send(words, uuid);
    return true;
  }

  private onItem(id: string, head: ClaudeWorkerHead, item: StreamItem) {
    const proc = this.procs.get(id);
    if (!proc || proc.head !== head || this.closed) return;
    const run = proc.run;
    if (item.kind === "init") {
      // Its session exists now (later runs resume it); claude may name it differently.
      const data = proc.record?.engineData;
      if (!run || !item.sessionId || !UUID.test(item.sessionId)) return;
      if (data?.sessionStarted !== true || data.sessionId !== item.sessionId) run.setEngineData({ sessionStarted: true, sessionId: item.sessionId });
      run.emit({ type: "session", conversationId: item.sessionId });
      return;
    }
    if (!run) {
      // A kept-alive process between runs: an approval it asks has nobody to answer it.
      if (item.kind === "permission") head.answer(item.requestId, false, item.input, "Not now: this worker's run has ended.");
      return;
    }
    const event = proc.stream.event(item);
    if (event) { run.emit(event); return; }
    switch (item.kind) {
      case "command":
        if (item.state !== "started" || !proc.queued.delete(item.id)) return;
        // "started" after the turn's result: a turn of its own (init follows), the run goes on until its result.
        // Before the result it was read into the turn under way (no init, no result of its own): nothing more to wait for.
        if (proc.pendingResult) { clearTimeout(proc.settle); proc.settle = undefined; proc.pendingResult = undefined; }
        return;
      case "result":
        if (proc.queued.size) {
          // A follow-up sent during this turn was either read into it or gets a turn of its own right after.
          proc.pendingResult = item;
          proc.settle = setTimeout(() => {
            proc.settle = undefined;
            const result = proc.pendingResult;
            proc.pendingResult = undefined;
            proc.queued.clear();
            if (result) this.end(proc, run, result);
          }, this.options.settleMs ?? 1_500);
          proc.settle.unref?.();
          return;
        }
        this.end(proc, run, item);
        return;
      default: return;
    }
  }

  /** The run's turn is over: the core classifies it. The process stays a while for a quick follow-up, then sleeps. */
  private end(proc: Proc, run: RunHandle, result: Extract<StreamItem, { kind: "result" }>) {
    if (proc.run !== run) return;
    proc.run = undefined;
    proc.queued.clear();
    const head = proc.head;
    if (head?.running) {
      proc.keepAlive = setTimeout(() => { proc.keepAlive = undefined; if (proc.head === head && !proc.run) head.finish(); }, this.options.keepAliveMs ?? 10 * 60_000);
      proc.keepAlive.unref?.();
    }
    run.emit({ type: "end", end: {
      how: result.how ?? (result.ok ? "normal" : "error"), finalText: result.ok ? result.text : null,
      error: result.ok ? null : result.error || result.text || null, detail: result.subtype,
    } });
  }

  private onExit(id: string, head: ClaudeWorkerHead, exit: Parameters<HeadHandlers["onExit"]>[0]) {
    const proc = this.procs.get(id);
    if (!proc || proc.head !== head) return;
    proc.head = undefined;
    // Its leader exited; the tree it led is kept until it is confirmed gone (children may outlive it).
    void endTree(head, 1_500).then((gone) => { if (gone && proc.tree === head) proc.tree = undefined; });
    if (proc.keepAlive) { clearTimeout(proc.keepAlive); proc.keepAlive = undefined; }
    const run = proc.run;
    if (proc.settle) {
      clearTimeout(proc.settle);
      proc.settle = undefined;
      const result = proc.pendingResult;
      proc.pendingResult = undefined;
      if (result && run) { this.end(proc, run, result); return; }
    }
    if (!run || this.closed) return;
    proc.run = undefined;
    run.emit({ type: "end", end: {
      how: "exited", finalText: null, detail: exit.signal ?? `exit ${exit.code}`,
      error: `The worker's process ended before its report${exit.code !== null ? ` (exit ${exit.code})` : ""}.${exit.stderr ? `\n${exit.stderr.slice(-2_000)}` : ""}`,
    } });
  }

  /** Ends its process (its work so far stays in its session); also a worker not at work: its kept-alive process. */
  async stop(r: Readonly<WorkerLedgerRecord>) {
    const proc = this.procs.get(r.id);
    if (!proc) return { cleaned: true };
    proc.run = undefined;
    proc.queued.clear();
    if (proc.settle) { clearTimeout(proc.settle); proc.settle = undefined; proc.pendingResult = undefined; }
    if (proc.keepAlive) { clearTimeout(proc.keepAlive); proc.keepAlive = undefined; }
    const tree = proc.tree ?? proc.head;
    if (!tree) return { cleaned: true };
    // Clean only once its tree is confirmed gone; otherwise it is kept, for recovery to end it again.
    const ended = await this.ended(proc, r, tree);
    return { cleaned: ended };
  }

  /**
   * Ends `tree` and confirms it is gone (the process layer's `endTree`, checked live, and no recorded process of it
   * lives on); then it is let go.
   */
  private async ended(proc: Proc, r: Readonly<WorkerLedgerRecord>, tree: ClaudeWorkerHead): Promise<boolean> {
    const gone = await endTree(tree, 1_500) && !r.processes.some(({ pid, started }) => pid === tree.pid && processStartTime(pid) === started);
    if (gone) {
      if (proc.tree === tree) proc.tree = undefined;
      if (proc.head === tree) proc.head = undefined;
    }
    return gone;
  }

  answer(r: Readonly<WorkerLedgerRecord>, nativeId: string, allow: boolean, input: Record<string, unknown>, message?: string) {
    this.procs.get(r.id)?.head?.answer(nativeId, allow, input, message);
  }

  /**
   * An interrupted worker may continue only once its old processes are gone (never two processes on one session). A
   * pid with the recorded start time is that process, still alive.
   */
  recover(r: Readonly<WorkerLedgerRecord>): RecoverResult | Promise<RecoverResult> {
    const proc = this.procs.get(r.id);
    const tree = proc?.tree;
    // Its kept-alive process, at hand and fine: the next run goes into it.
    if (proc && tree && proc.head === tree && tree.running && r.cleanup !== "failed") return { state: "clean" };
    // A tree a stop could not end, or one whose leader exited: ended and confirmed gone first.
    if (proc && tree) {
      return this.ended(proc, r, tree).then((ended): RecoverResult => ended ? { state: "clean" }
        : { state: "blocked", reason: "This worker's earlier process could not be ended; it cannot be resumed until it has." });
    }
    const alive = r.processes.some(({ pid, started }) => processStartTime(pid) === started);
    return alive ? { state: "blocked", reason: "This worker's earlier process is still running; it cannot be resumed until it has ended." } : { state: "clean" };
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.procs.values()].map((proc) => {
      if (proc.settle) clearTimeout(proc.settle);
      if (proc.keepAlive) clearTimeout(proc.keepAlive);
      Object.assign(proc, { settle: undefined, keepAlive: undefined, pendingResult: undefined, run: undefined });
      const tree = proc.tree ?? proc.head;
      proc.head = undefined;
      return tree?.terminate(1_500);
    }));
  }
}

/**
 * claude-workers.json for a core of its own (no member ledger: tests, tools). A worker the journal still lists at work
 * was cut off by a crash: it goes to the core as running, so the core marks it interrupted and writes that down.
 */
class ClaudeJournal extends ClaudeLegacyStore {
  load(): WorkerLedgerRecord[] {
    return super.load().map((r) => (r.interruptedBy === "crash" ? { ...r, status: "running" as const } : r));
  }
}

/** The status words app_cancel_task answers with (the journal's). */
const statusWord = (status: WorkerLedgerRecord["status"]) => (status === "done" ? "completed" : status);

/** A bot's Claude workers: the shared worker core with the Claude adapter, behind the interface the bot has always used. */
export class ClaudeWorkers implements WorkerHost {
  readonly workerHostKind = "claude-process" as const;
  readonly steersRunning = true;
  /** The shared core that holds these workers (state, runs, reports, approvals). */
  readonly core: WorkerCore;

  constructor(
    options: ClaudeWorkersOptions,
    emit: (item: CodexItem) => void,
    /** Hands a run's report to the coordinator; false: it could not take it now (it stays pending for `redeliver`). */
    report: (id: string, text: string, run: number) => boolean,
    factory: (config: HeadConfig, handlers: HeadHandlers) => ClaudeWorkerHead,
  ) {
    const core: WorkerCoreOptions = {
      store: new ClaudeJournal(options.file),
      // A Claude coordinator is done with a report once it has it (decision D4: no checkpoint).
      port: { ack: "none", deliver: (r, text) => (report(r.id, text, r.run) ? "taken" : "busy") },
      sink: { item: emit },
      adapters: [new ClaudeWorkerAdapter(options, factory)],
      ownerSessionId: () => options.ownerSessionId(),
      maxRunning: () => workerLimit(options.maxRunning?.()),
      log: (line) => options.log?.(line),
    };
    this.core = options.core?.(core, { claudeFile: options.file }) ?? new WorkerCore(core);
  }

  listWorkers(): WorkerInfo[] { return this.core.listWorkers(); }
  sendToWorker(id: string, words: string): WorkerSendResult | Promise<WorkerSendResult> { return this.core.sendToWorker(id, words); }
  stopWorker(id: string): Promise<boolean> { return this.core.stopWorker(id); }
  /** workers.ts `setWorkerOwner`: a report still waiting for the coordinator goes to the owner instead. */
  setWorkerOwner(id: string, owner: WorkerOwner | null): WorkerOwnerResult { return this.core.setWorkerOwner(id, owner); }
  /** An approval card's answer (`worker:<task>:<run>:<claude's request id>`). */
  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string): boolean { return this.core.answer(requestId, allow, input, message); }
  /** Reports that did not reach the coordinator (it could not take them, or the app stopped first): handed over again, once each. */
  redeliver() { this.core.redeliver(); }
  get running(): string[] { return this.core.running; }
  /**
   * The app is quitting (or the bot is removed): every worker's process ends. One at work is `interrupted`; it is not
   * replayed, and a later app_send_message resumes its session (`--resume`).
   */
  close(): Promise<void> { return this.core.close(); }

  /** The app tools (the coordinator's in-process MCP server). */
  async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "app_handoff") {
      // The Agent tool's own names (prompt, description) and "task" are taken too: models carry them over (live check).
      const started = await this.core.handoff("claude-process", args);
      return { ...started, message: "The worker runs on its own in this folder. Its report arrives later as an app message (<app_task_result>). Start any other independent workers you need, say in one sentence what you handed off, then finish your turn: do not wait or poll." };
    }
    if (name === "app_send_message") {
      const sent = await this.core.message(args);
      return { ...sent, message: sent.status === "steered" ? "Joined into its run under way." : "Its next run started; its report comes as an app message." };
    }
    if (name === "app_cancel_task") {
      const id = typeof args.task_id === "string" ? args.task_id : "";
      const { status } = await this.core.cancel(id, args.run as number | undefined);
      return { task_id: id, run: this.core.get(id)?.run, status: statusWord(status) };
    }
    throw new Error(`Unknown app tool ${name}.`);
  }
}

/** claude-workers.json in a bot's store. */
export const claudeWorkersFile = (storeDir: string) => join(storeDir, "claude-workers.json");
