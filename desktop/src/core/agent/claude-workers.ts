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
import { appTools, workerAppTools } from "../app-tools/registry";
import { isBotTool, type BotToolRunner } from "../bot-tools";
import { ClaudeStreamEvents } from "./claude-worker-events";
import type { CodexItem } from "./codex";
import type { AppToolSpec, HeadConfig, HeadHandlers } from "./head";
import { commandEnded, type StreamItem } from "./stream";
import type { WaitingOn } from "../worker-core/events";
import { DEFAULT_SPEC_WRITERS } from "../spec-guard";
import { WORKER_NOTIFY_RULE } from "../prompts/delegation";
import { EFFORTS_BY_ENGINE, type EffortLevel } from "../../contract/efforts";
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

/** Workers on other machines (src/remote/service.ts): app_handoff's `machine` names one; its worker's process runs there. */
export interface RemoteWorkerHost {
  /** The trusted machine a name means, or why not (nothing is started). */
  resolve(name: string): { id: string; name: string } | { error: string };
  /** The worker's process on that machine, as a head (its connection, approvals and branch are the host's). */
  head(machineId: string, worker: { id: string; name: string }, cwd: string, config: HeadConfig, handlers: HeadHandlers): ClaudeWorkerHead;
  /** What its worker row shows (null: not a remote worker). */
  status?(workerId: string): { machine: string; conn: string } | null;
}

/** The in-process MCP server Claude coordinators get (head.ts `appMcp`). */
export const CLAUDE_APP_SERVER = "botling";
export const CLAUDE_APP_TOOLS: AppToolSpec[] = appTools("claude");
/** The same server for the hidden native-subagent fallback (no app workers): only app_routines and app_component_usage. */
export const CLAUDE_ROUTINE_TOOLS: AppToolSpec[] = CLAUDE_APP_TOOLS.filter((tool) => tool.name === "app_routines" || tool.name === "app_component_usage");
/** The same server inside a worker: only app_notify_owner (a note to the bot that started it). */
export const CLAUDE_WORKER_TOOLS: AppToolSpec[] = workerAppTools("claude");

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
  WORKER_NOTIFY_RULE,
].join("\n");

/** A `.claude/agents/<type>.md` definition, as far as a worker can reproduce it. */
export interface AgentDefinition {
  name: string; prompt: string; model: string | null; tools: string[] | null;
  /** Its `effort:` (Claude's `--effort`); null: none, or one Claude does not take (`effortIgnored`). */
  effort?: EffortLevel | null;
  /** An `effort:` Claude does not take: not used, and the handoff says so. */
  effortIgnored?: string;
}

/** Types Claude Code has built in (no file): a plain worker. */
const BUILT_IN_TYPES = new Set(["general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide"]);
const MODEL_ALIASES = new Set(["haiku", "sonnet", "opus"]);
/** The levels Claude's `--effort` takes (the composer's and Settings' own list). */
const CLAUDE_EFFORTS = EFFORTS_BY_ENGINE.claude;
/** `value` as a Claude effort level; null: none, or one Claude does not take. */
export const claudeEffort = (value: unknown): EffortLevel | null => (CLAUDE_EFFORTS as readonly unknown[]).includes(value) ? value as EffortLevel : null;

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
    const wantedEffort = fields.effort && fields.effort !== "inherit" ? fields.effort : null;
    const effort = claudeEffort(wantedEffort);
    return { name: fields.name || short, prompt, model, tools: tools?.length ? tools : null, effort, ...(wantedEffort && !effort ? { effortIgnored: wantedEffort } : {}) };
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
  /** The bot's subagent effort (null: the coordinator's effort). */
  subagentEffort?(): string | null;
  /** The machine its workers run on when app_handoff names none (the bot's `workerMachine`); null: here. */
  defaultMachine?(): string | null;
  /** Plugin folders whose agents/ count as definitions. */
  pluginDirs?(): string[];
  processStarted?(pid: number): void;
  /** How long a worker's process stays after a result for a quick follow-up (default 10 minutes). */
  keepAliveMs?: number;
  /** How long a result waits for a queued follow-up's own turn to start (default 1.5 s). */
  settleMs?: number;
  /** How many workers may be at work in their own processes at once (settings.json `claudeWorkerLimit`); more wait for a slot. */
  maxRunning?(): number;
  /** Model families whose workers may write spec/ (settings.json `specWriters`; default ["opus"]). */
  specWriters?(): readonly string[];
  /** The site tools folder these workers may not write (site-tools-guard.ts); none for Maintainer's. */
  siteToolsFolder?(): string | null | undefined;
  /** The bot tools (core/bot-tools.ts: the browser pane, the Note), answered by this bot; absent: they answer that they are not available. */
  browser?: BotToolRunner;
  home?: string;
  /** Workers on other machines; absent or null: app_handoff's `machine` is refused. */
  remote?(): RemoteWorkerHost | null;
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
  /** The effort its process was started with (`--effort`; a run into the kept-alive process goes on at it). */
  effort?: string | null;
  /** The model its process was started with (`--model`; a run into the kept-alive process goes on with it). */
  model?: string | null;
  /** The config a run started with, for its opening items (null: it went into the kept-alive process). */
  opening?: { run: number; base: HeadConfig | null };
  /** What its process left running in the background (a command, a Monitor, an agent), by tool call. */
  background: Map<string, { kind: "command" | "monitor" | "agent"; title: string; since: number }>;
  /** Its head once the app closed its input (`finish`): nothing more can be written to it; it ends after its background work. */
  finishing?: ClaudeWorkerHead;
  finishingSince?: number;
  /** A run whose words wait for the finishing process to end: then a new process (`--resume`) takes them all. */
  held?: { run: RunHandle; record: Readonly<WorkerLedgerRecord>; words: string[]; since: number };
}

/** Background work started longer ago than this no longer keeps a worker's process past its keep-alive (the bots' rule). */
const BACKGROUND_HOLDS_MS = 6 * 3600_000;

/** What the Claude adapter needs of the bot (ClaudeWorkersOptions without the journal and the coordinator). */
export type ClaudeAdapterOptions = Pick<ClaudeWorkersOptions, "base" | "cwd" | "subagentModel" | "subagentEffort" | "pluginDirs" | "processStarted" | "keepAliveMs" | "settleMs" | "home" | "specWriters" | "siteToolsFolder" | "browser" | "remote" | "defaultMachine">;

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
  /** app_notify_owner from a worker's process (its core's `notifyOwner`, set by the facade once the core exists). */
  notify?: (id: string, args: Record<string, unknown>) => unknown;

  constructor(private options: ClaudeAdapterOptions, private factory: (config: HeadConfig, handlers: HeadHandlers) => ClaudeWorkerHead) {}

  private procOf(id: string): Proc {
    let proc = this.procs.get(id);
    if (!proc) { proc = { queued: new Set(), stream: new ClaudeStreamEvents(), background: new Map() }; this.procs.set(id, proc); }
    return proc;
  }

  private definition(type: string | null) {
    return loadAgentDefinition(type, this.options.cwd(), { home: this.options.home, pluginDirs: this.options.pluginDirs?.() ?? [] });
  }

  private model(r: Readonly<WorkerLedgerRecord>, base: HeadConfig | null) {
    return nonEmpty(r.engineData.model) ?? this.options.subagentModel() ?? base?.model ?? null;
  }

  /** Its `--effort`: the handoff's or its definition's, else the bot's subagent effort, else the coordinator's. */
  private effort(r: Readonly<WorkerLedgerRecord>, base: HeadConfig | null) {
    return claudeEffort(r.engineData.effort) ?? claudeEffort(this.options.subagentEffort?.()) ?? base?.effort ?? null;
  }

  /** Its definition and model are checked before anything is recorded; its session id is chosen now (`--session-id`). */
  prepare(request: HandoffRequest) {
    const definition = this.definition(request.type);
    if (definition && "error" in definition) throw new Error(definition.error);
    if (request.model && !MODEL_ALIASES.has(request.model) && !/^claude-[a-z0-9.-]+$/.test(request.model)) throw new Error(`Unknown model "${request.model}": use haiku, sonnet or opus.`);
    // An effort Claude does not take is not used (the worker runs at the one it would have had); the handoff says so.
    const wanted = typeof request.args.effort === "string" && request.args.effort.trim() ? request.args.effort.trim() : null;
    const effort = claudeEffort(wanted) ?? (wanted ? null : definition?.effort ?? null);
    const ignored = [...(wanted && !claudeEffort(wanted) ? [wanted] : []), ...(!wanted && definition?.effortIgnored ? [definition.effortIgnored] : [])];
    const machine = this.machine(request.args.machine) ?? this.defaultMachine(request.args.machine);
    return { engineData: { sessionId: randomUUID(), sessionStarted: false, model: request.model ?? definition?.model ?? null, effort, ...(ignored.length ? { effortIgnored: ignored } : {}), ...(machine ? { machine: machine.id, machineName: machine.name } : {}) } };
  }

  /** app_handoff's `machine`: a trusted machine, or the refusal (nothing started). */
  private machine(value: unknown): { id: string; name: string } | null {
    const name = typeof value === "string" ? value.trim() : "";
    if (!name || name === "local" || name === "this") return null;
    const remote = this.options.remote?.();
    if (!remote) throw new Error("Workers on other machines are not available here. Nothing was started.");
    const found = remote.resolve(name);
    if ("error" in found) throw new Error(found.error);
    return found;
  }

  /** No `machine` given: the bot's default machine (its settings), if it has one; a default that cannot be used is refused. */
  private defaultMachine(given: unknown): { id: string; name: string } | null {
    if (typeof given === "string" && given.trim()) return null;
    const name = this.options.defaultMachine?.()?.trim();
    if (!name) return null;
    try { return this.machine(name); }
    catch (error) { throw new Error(`This bot's workers run on ${name} by default (its settings), but: ${(error as Error).message} Pass machine "local" to run it here.`); }
  }

  /** A run into its kept-alive process takes no slot. */
  needsSlot(r: Readonly<WorkerLedgerRecord>) { return !nonEmpty(r.engineData.machine) && !this.procs.get(r.id)?.head?.running; }

  runtime(r: Readonly<WorkerLedgerRecord>) {
    const proc = this.procs.get(r.id);
    const base = proc?.opening?.run === r.run ? proc.opening.base : proc?.head?.running ? null : this.options.base();
    // A run into the kept-alive process goes on with the model and effort that process started with.
    if (!base && proc?.head?.running) return { reasoningEffort: proc.effort ?? null, model: proc.model ?? this.model(r, null) };
    return { reasoningEffort: this.effort(r, base), model: this.model(r, base) };
  }

  /** Sends a run's first words: into its kept-alive process, or a new one (`--resume` once its session exists). */
  start(r: Readonly<WorkerLedgerRecord>, words: string, run: RunHandle) {
    const proc = this.procOf(r.id);
    if (proc.keepAlive) { clearTimeout(proc.keepAlive); proc.keepAlive = undefined; }
    const sessionId = nonEmpty(r.engineData.sessionId) ?? r.conversationId ?? r.id;
    if (proc.head?.running && proc.finishing === proc.head) {
      // Its input is closed (it went to sleep) but it lives on until its background work ends: words written now are
      // lost. They wait, shown as waiting, and go into a new process on its session once this one has ended.
      Object.assign(proc, { run: undefined, record: r, opening: { run: run.run, base: null }, pendingResult: undefined });
      proc.held = { run, record: r, words: [words], since: Date.now() };
      run.emit({ type: "session", conversationId: sessionId });
      run.emit({ type: "waitingOn", on: this.waitingOn(proc) });
      return;
    }
    if (proc.head?.running) {
      Object.assign(proc, { run, record: r, opening: { run: run.run, base: null }, pendingResult: undefined });
      proc.stream.newRun();
      proc.queued.clear();
      run.emit({ type: "session", conversationId: sessionId });
      proc.head.send(words, randomUUID());
      return;
    }
    this.spawn(proc, r, words, run, sessionId);
  }

  /** A new process for the run (`--resume` once its session exists), sent the run's first words. */
  private spawn(proc: Proc, r: Readonly<WorkerLedgerRecord>, words: string, run: RunHandle, sessionId: string) {
    // Never two processes on one session: an earlier tree must be gone first (a leader that exited may leave children).
    if (proc.tree && proc.tree.gone?.() === false) throw new Error("This worker's earlier process is still ending; try again in a moment.");
    const base = this.options.base();
    if (!base) throw new Error("Workers cannot start now: this bot's Claude head is unavailable.");
    const def = r.type ? this.definition(r.type) : null;
    if (def && "error" in def) throw new Error(def.error);
    const siteToolsFolder = this.options.siteToolsFolder?.();
    const config: HeadConfig = {
      ...base, cwd: this.options.cwd(), sessionId, resume: r.engineData.sessionStarted === true, forkSession: false, persistSession: true,
      model: this.model(r, base), effort: this.effort(r, base), monitorWorker: true, appMcp: { server: CLAUDE_APP_SERVER, tools: CLAUDE_WORKER_TOOLS }, agentGuard: CLAUDE_WORKER_GUARD,
      specGuard: { writers: this.options.specWriters?.() ?? DEFAULT_SPEC_WRITERS },
      ...(siteToolsFolder ? { siteToolsGuard: { folder: siteToolsFolder } } : {}),
      systemPrompt: [CLAUDE_WORKER_POLICY, def?.prompt ?? ""].filter(Boolean).join("\n\n"),
      disallowedTools: [...new Set([...(base.disallowedTools ?? []), "SendMessage", "TaskStop"])],
      ...(def?.tools ? { tools: def.tools } : {}),
    };
    // A kept-alive process carries later runs too: its items belong to whichever run is under way.
    const machine = nonEmpty(r.engineData.machine);
    const remote = machine ? this.options.remote?.() : null;
    if (machine && !remote) throw new Error("This worker runs on another machine, and workers on other machines are not available here.");
    const handlers: HeadHandlers = {
      onItem: (item) => this.onItem(r.id, head, item), onExit: (exit) => this.onExit(r.id, head, exit),
      // Its app tools: a note to its owner, from the run under way in this process, and the browser tools.
      onAppTool: async (name, args) => {
        if (isBotTool(name)) {
          if (!this.options.browser) throw new Error("That tool is not available here.");
          return this.options.browser(name, args, "worker");
        }
        if (name !== "app_notify_owner" || !this.notify) throw new Error(`Unknown app tool ${name}.`);
        if (this.procs.get(r.id)?.head !== head) throw new Error("This worker's run is not under way: say it in your final report instead.");
        return this.notify(r.id, args);
      },
    };
    const head: ClaudeWorkerHead = machine ? remote!.head(machine, { id: r.id, name: r.name }, config.cwd, config, handlers) : this.factory(config, handlers);
    head.start();
    Object.assign(proc, { head, tree: head, run, record: r, effort: config.effort ?? null, model: config.model ?? null, opening: { run: run.run, base }, pendingResult: undefined, finishing: undefined, finishingSince: undefined });
    proc.background.clear();
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
    if (proc?.held) {
      proc.held.words.push(words);
      proc.held.run.emit({ type: "waitingOn", on: this.waitingOn(proc) });
      return true;
    }
    if (!proc?.run || !proc.head?.running || proc.finishing === proc.head) return false;
    const uuid = randomUUID();
    proc.queued.add(uuid);
    proc.head.send(words, uuid);
    return true;
  }

  /** What a held run waits for: the background work its finishing process still runs (the oldest first), else its end. */
  private waitingOn(proc: Proc): WaitingOn {
    const queued = proc.held?.words.length ?? 0;
    const task = [...proc.background.values()].sort((a, b) => a.since - b.since)[0];
    return task ? { ...task, queued } : { kind: "process", title: "", since: proc.finishingSince ?? proc.held?.since ?? Date.now(), queued };
  }

  /** After a run: the process stays a while for a quick follow-up, then its input is closed (it sleeps). Not while it has background work running. */
  private keepAlive(proc: Proc, head: ClaudeWorkerHead) {
    proc.keepAlive = setTimeout(() => {
      proc.keepAlive = undefined;
      if (proc.head !== head || proc.run || proc.held) return;
      const now = Date.now();
      if ([...proc.background.values()].some((task) => now - task.since < BACKGROUND_HOLDS_MS)) { this.keepAlive(proc, head); return; }
      proc.finishing = head;
      proc.finishingSince = now;
      head.finish();
    }, this.options.keepAliveMs ?? 10 * 60_000);
    proc.keepAlive.unref?.();
  }

  private onItem(id: string, head: ClaudeWorkerHead, item: StreamItem) {
    const proc = this.procs.get(id);
    if (!proc || proc.head !== head || this.closed) return;
    // What it leaves running in the background, between runs too (it keeps the process awake; a held run names it).
    if (item.kind === "backgroundStarted") proc.background.set(item.id, { kind: item.monitor ? "monitor" : "command", title: item.description, since: Date.now() });
    else if (item.kind === "subagentStarted" && item.background) proc.background.set(item.id, { kind: "agent", title: item.description, since: Date.now() });
    else if (item.kind === "subagentEnded" && proc.background.delete(item.id) && proc.held) proc.held.run.emit({ type: "waitingOn", on: this.waitingOn(proc) });
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
        // Its end with no "started": read into the turn under way, before that turn's result (nothing more to wait for).
        if (commandEnded(item.state)) { proc.queued.delete(item.id); return; }
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
    if (head?.running) this.keepAlive(proc, head);
    run.emit({ type: "end", end: {
      how: result.how ?? (result.ok ? "normal" : "error"), finalText: result.ok ? result.text : null,
      error: result.ok ? null : result.error || result.text || null, detail: result.subtype,
    } });
  }

  private onExit(id: string, head: ClaudeWorkerHead, exit: Parameters<HeadHandlers["onExit"]>[0]) {
    const proc = this.procs.get(id);
    if (!proc || proc.head !== head) return;
    proc.head = undefined;
    proc.finishing = undefined;
    proc.background.clear();
    // Its leader exited; the tree it led is kept until it is confirmed gone (children may outlive it). A held run then
    // goes into a new process on the same session, with every word that waited.
    void endTree(head, 1_500).then((gone) => {
      // Only the check of the process the session is on acts: an earlier process's check answering late (a new
      // process took the session since, and may be closing now) leaves the run held for that one alone.
      const latest = proc.tree === head;
      if (gone && latest) proc.tree = undefined;
      const held = proc.held;
      if (!held || this.closed || !latest) return;
      proc.held = undefined;
      held.run.emit({ type: "waitingOn", on: null });
      const sessionId = nonEmpty(held.record.engineData.sessionId) ?? held.record.conversationId ?? held.record.id;
      try { this.spawn(proc, held.record, held.words.join("\n\n"), held.run, sessionId); } catch (error) {
        held.run.emit({ type: "end", end: { how: "error", finalText: null, error: (error as Error).message, detail: "spawn" } });
      }
    });
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
    proc.held = undefined;
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
      Object.assign(proc, { settle: undefined, keepAlive: undefined, pendingResult: undefined, run: undefined, held: undefined });
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
  private readonly adapter: ClaudeWorkerAdapter;

  constructor(
    options: ClaudeWorkersOptions,
    emit: (item: CodexItem) => void,
    /** Hands a run's report to the coordinator; false: it could not take it now (it stays pending for `redeliver`). */
    report: (id: string, text: string, run: number) => boolean,
    factory: (config: HeadConfig, handlers: HeadHandlers) => ClaudeWorkerHead,
  ) {
    this.adapter = new ClaudeWorkerAdapter(options, factory);
    const core: WorkerCoreOptions = {
      store: new ClaudeJournal(options.file),
      // A Claude coordinator is done with a report once it has it (decision D4: no checkpoint).
      port: { ack: "none", deliver: (r, text) => (report(r.id, text, r.run) ? "taken" : "busy") },
      sink: { item: emit },
      adapters: [this.adapter],
      ownerSessionId: () => options.ownerSessionId(),
      maxRunning: () => workerLimit(options.maxRunning?.()),
      log: (line) => options.log?.(line),
    };
    this.core = options.core?.(core, { claudeFile: options.file }) ?? new WorkerCore(core);
    this.adapter.notify = (id, args) => ({ ...this.core.notifyOwner(id, args), message: "Sent to your owner. Keep working; an answer, if any, joins this run as a message." });
  }

  listWorkers(): WorkerInfo[] { return this.core.listWorkers(); }
  sendToWorker(id: string, words: string): WorkerSendResult | Promise<WorkerSendResult> { return this.core.sendToWorker(id, words); }
  stopWorker(id: string): Promise<boolean> { return this.core.stopWorker(id); }
  /** settings.json's `claudeWorkerLimit` changed: a raised limit lets waiting workers start now. */
  slotsChanged(): void { this.core.slotsChanged(); }
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
      const record = this.core.get(started.task_id);
      const ignored = Array.isArray(record?.engineData.effortIgnored) ? record.engineData.effortIgnored as string[] : [];
      const effort = record ? this.adapter.runtime(record).reasoningEffort : null;
      const notice = ignored.length ? `Effort "${ignored.join('", "')}" ignored: Claude takes ${CLAUDE_EFFORTS.join(", ")}. The worker runs at ${effort ?? "the model's default"} effort.` : undefined;
      return { ...started, effort, ...(notice ? { notice } : {}), message: "The worker runs on its own in this folder. Its report arrives later as an app message (<app_task_result>). Start any other independent workers you need, say in one sentence what you handed off, then finish your turn: do not wait or poll." };
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
