// Claude's app-managed workers (spec X, now the default): every Claude subagent is a worker of its own, a
// separate `claude -p` process with its own session, started and steered by the app through the same app tools
// Codex and Antigravity coordinators use (app_handoff, app_send_message, app_cancel_task). The coordinator's
// native Agent/Task tool is removed (head.ts `agentGuard`). Because a worker is its own process, the coordinator's
// Stop, sleep, model switch or restart never touch it; only `app_cancel_task`, the row's Stop or the app quitting do.
//
// The state machine mirrors agy-workers.ts (runs, report pending/delivered, process identities), the process
// handling mirrors Codex's component editor (one ClaudeHead per worker, kept alive a while after a result, then
// `--resume` for the next run). The journal is <bot store>/claude-workers.json. Events are the shared worker
// items (workers.ts), so the bot's book, the registry, the Rail and moves treat these like any other worker.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { groupAlive, processStartTime } from "../process/kill-tree";
import type { TerminateResult } from "../process/tree";
import type { CodexItem } from "./codex";
import type { AppToolSpec, HeadConfig, HeadHandlers } from "./head";
import type { StreamItem } from "./stream";
import { workerReportText, workerRunStarted, type ProcessIdentity, type WorkerHost, type WorkerInfo, type WorkerSendResult, type WorkerState } from "./workers";

/** What the manager needs of a worker's process (ClaudeHead; a fake in tests). */
export interface ClaudeWorkerHead {
  readonly pid: number;
  readonly running: boolean;
  start(): void;
  send(text: string, uuid: string): void;
  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string): void;
  finish(): void;
  terminate(graceMs?: number): Promise<TerminateResult>;
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

interface Record_ {
  id: string; name: string; type: string | null; instructions: string; sessionId: string; sessionStarted: boolean;
  run: number; status: string; active: boolean; reportPending: boolean; reportDelivered: boolean; report?: string;
  model: string | null; processes: ProcessIdentity[]; interrupted: boolean; createdAt: number;
}
interface Live {
  head?: ClaudeWorkerHead; queued: Set<string>; extraTurns: number; outputTokens: number; cost: number;
  approvals: Map<string, Record<string, unknown>>; settle?: ReturnType<typeof setTimeout>; pendingResult?: Extract<StreamItem, { kind: "result" }>;
  keepAlive?: ReturnType<typeof setTimeout>; stopping?: boolean;
}

export interface ClaudeWorkersOptions {
  /** claude-workers.json. */
  file: string;
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
  home?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WORKERS = 200;

export class ClaudeWorkers implements WorkerHost {
  readonly workerHostKind = "claude-process" as const;
  readonly steersRunning = true;
  private workers = new Map<string, Record_>();
  private live = new Map<string, Live>();
  private closed = false;

  constructor(
    private options: ClaudeWorkersOptions,
    private emit: (item: CodexItem) => void,
    /** Hands a run's report to the coordinator; false: it could not take it now (it stays pending for `redeliver`). */
    private report: (id: string, text: string, run: number) => boolean,
    private factory: (config: HeadConfig, handlers: HeadHandlers) => ClaudeWorkerHead,
  ) {
    this.restore();
  }

  // ------------------------------------------------------------------------------------------
  // Journal

  private restore() {
    let saved: any;
    try { saved = JSON.parse(readFileSync(this.options.file, "utf8")); } catch { return; }
    if (saved?.version !== 1 || !Array.isArray(saved.workers)) return;
    let changed = false;
    for (const r of saved.workers.slice(-MAX_WORKERS)) {
      if (!r || typeof r.id !== "string" || !UUID.test(r.id) || typeof r.sessionId !== "string" || !UUID.test(r.sessionId) || !Number.isSafeInteger(r.run) || r.run < 0 || typeof r.instructions !== "string") continue;
      const w: Record_ = {
        id: r.id, name: typeof r.name === "string" ? r.name : r.instructions.slice(0, 80), type: typeof r.type === "string" ? r.type : null, instructions: r.instructions,
        sessionId: r.sessionId, sessionStarted: r.sessionStarted === true, run: r.run, status: typeof r.status === "string" ? r.status : "completed",
        active: false, reportPending: r.reportPending === true, reportDelivered: r.reportDelivered === true, report: typeof r.report === "string" ? r.report : undefined,
        model: typeof r.model === "string" ? r.model : null, interrupted: r.interrupted === true, createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
        processes: Array.isArray(r.processes) ? r.processes.filter((p: any) => Number.isSafeInteger(p?.pid) && p.pid > 0 && typeof p.started === "string" && p.started) : [],
      };
      // It was at work when the app went away without closing it (a crash): interrupted, never replayed.
      if (r.active === true) {
        w.interrupted = true; w.status = "interrupted"; w.reportPending = false;
        w.report = "Interrupted: the app stopped while this worker was at work. Nothing was replayed; continue it with app_send_message (it resumes its session).";
        changed = true;
      }
      this.workers.set(w.id, w);
    }
    if (changed) this.save();
  }

  private save() {
    const workers = [...this.workers.values()].slice(-MAX_WORKERS);
    mkdirSync(dirname(this.options.file), { recursive: true });
    writeFileAtomic(this.options.file, JSON.stringify({ version: 1, workers }));
  }

  private liveOf(w: Record_): Live {
    let live = this.live.get(w.id);
    if (!live) { live = { queued: new Set(), extraTurns: 0, outputTokens: 0, cost: 0, approvals: new Map() }; this.live.set(w.id, live); }
    return live;
  }

  // ------------------------------------------------------------------------------------------
  // WorkerHost

  listWorkers(): WorkerInfo[] {
    return [...this.workers.values()].map((w) => ({ id: w.id, engine: "claude" as const, name: w.name, run: w.run, state: this.stateOf(w), conversationId: w.sessionStarted ? w.sessionId : null, processes: [...w.processes] }));
  }

  private stateOf(w: Record_): WorkerState {
    if (w.active) return "running";
    if (w.interrupted) return "interrupted";
    if (w.reportPending) return "reportPending";
    if (w.status === "stopped") return "stopped";
    if (w.status === "failed") return "failed";
    return "idle";
  }

  sendToWorker(id: string, words: string): WorkerSendResult {
    const w = this.workers.get(id);
    if (!w || this.closed) return { ok: false, reason: "No such worker." };
    if (!words.trim() || words.length > 64_000) return { ok: false, reason: "Message required (maximum 64000 characters)." };
    const live = this.liveOf(w);
    if (w.active) {
      if (!live.head?.running) return { ok: false, reason: "This worker is starting or stopping; try again in a moment." };
      const uuid = randomUUID();
      live.queued.add(uuid);
      live.head.send(words, uuid);
      return { ok: true, how: "steered", run: w.run };
    }
    const blocker = this.recoveryBlocker(w);
    if (blocker) return { ok: false, reason: blocker };
    const started = this.launch(w, words);
    return started ? { ok: false, reason: started } : { ok: true, how: "newRun", run: w.run };
  }

  async stopWorker(id: string): Promise<boolean> {
    const w = this.workers.get(id);
    if (!w || !w.active) return false;
    await this.stop(w);
    return true;
  }

  // ------------------------------------------------------------------------------------------
  // App tools (the coordinator's in-process MCP server)

  async tool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error("Workers are closed: the app is stopping.");
    if (name === "app_handoff") {
      // The Agent tool's own names (prompt, description) and "task" are taken too: models carry them over (live check).
      const given = [args.instructions, args.prompt, args.task].find((value) => typeof value === "string" && value.trim());
      const instructions = typeof given === "string" ? given : "";
      if (!instructions.trim() || instructions.length > 64_000) throw new Error("instructions required (maximum 64000 characters).");
      const type = typeof args.subagent_type === "string" && args.subagent_type.trim() ? args.subagent_type.trim() : null;
      const definition = loadAgentDefinition(type, this.options.cwd(), { home: this.options.home, pluginDirs: this.options.pluginDirs?.() ?? [] });
      if (definition && "error" in definition) throw new Error(definition.error);
      const model = typeof args.model === "string" && args.model.trim() ? args.model.trim() : null;
      if (model && !MODEL_ALIASES.has(model) && !/^claude-[a-z0-9.-]+$/.test(model)) throw new Error(`Unknown model "${model}": use haiku, sonnet or opus.`);
      const named = [args.name, args.description].find((value) => typeof value === "string" && value.trim());
      const name = typeof named === "string" ? named.trim().slice(0, 200) : instructions.split("\n")[0]!.slice(0, 80);
      const w: Record_ = {
        id: randomUUID(), name, type, instructions, sessionId: randomUUID(), sessionStarted: false, run: 0, status: "new", active: false,
        reportPending: false, reportDelivered: false, model: model ?? definition?.model ?? null, processes: [], interrupted: false, createdAt: Date.now(),
      };
      this.workers.set(w.id, w);
      this.trim();
      const failed = this.launch(w, instructions, definition);
      if (failed) { this.workers.delete(w.id); this.live.delete(w.id); throw new Error(failed); }
      return { accepted: true, task_id: w.id, run: w.run, message: "The worker runs on its own in this folder. Its report arrives later as an app message (<app_task_result>). Start any other independent workers you need, say in one sentence what you handed off, then finish your turn: do not wait or poll." };
    }
    const id = typeof args.task_id === "string" ? args.task_id : "";
    const w = this.workers.get(id);
    if (!w) throw new Error("Unknown task_id. Use the task_id app_handoff returned.");
    if (args.run !== undefined && args.run !== w.run) throw new Error(`Stale run: this worker is on run ${w.run}.`);
    if (name === "app_send_message") {
      const sent = this.sendToWorker(id, typeof args.message === "string" ? args.message : "");
      if (!sent.ok) throw new Error(sent.reason);
      return { task_id: w.id, run: sent.run, status: sent.how === "steered" ? "steered" : "accepted", message: sent.how === "steered" ? "Joined into its run under way." : "Its next run started; its report comes as an app message." };
    }
    if (name === "app_cancel_task") {
      if (w.active) await this.stop(w);
      else await this.release(w);
      return { task_id: w.id, run: w.run, status: w.status };
    }
    throw new Error(`Unknown app tool ${name}.`);
  }

  // ------------------------------------------------------------------------------------------
  // Runs

  /** Starts its next run (a new process with `--resume`, or the kept-alive one). An error text: nothing started. */
  private launch(w: Record_, words: string, definition?: AgentDefinition | null): string | null {
    const live = this.liveOf(w);
    if (live.keepAlive) { clearTimeout(live.keepAlive); live.keepAlive = undefined; }
    const base = live.head?.running ? null : this.options.base();
    if (!live.head?.running && !base) return "Workers cannot start now: this bot's Claude head is unavailable.";
    const def = definition === undefined ? (w.type ? loadAgentDefinition(w.type, this.options.cwd(), { home: this.options.home, pluginDirs: this.options.pluginDirs?.() ?? [] }) : null) : definition;
    if (def && "error" in def) return def.error;
    w.run += 1;
    const run = w.run;
    w.active = true; w.status = "running"; w.reportPending = false; w.reportDelivered = false; w.interrupted = false; delete w.report;
    live.queued.clear(); live.extraTurns = 0; live.outputTokens = 0; live.stopping = false; live.pendingResult = undefined;
    this.save();
    const model = w.model ?? this.options.subagentModel() ?? base?.model ?? null;
    for (const item of workerRunStarted({ id: w.id, engine: "claude", name: w.name, run, conversationId: w.sessionId, ownerSessionId: this.options.ownerSessionId() }, words, { reasoningEffort: base?.effort ?? null, model }))
      this.emit(item);
    const uuid = randomUUID();
    if (live.head?.running) { live.head.send(words, uuid); return null; }
    const config: HeadConfig = {
      ...base!, cwd: this.options.cwd(), sessionId: w.sessionId, resume: w.sessionStarted, forkSession: false, persistSession: true,
      model, monitorWorker: true, appMcp: null, agentGuard: CLAUDE_WORKER_GUARD,
      systemPrompt: [CLAUDE_WORKER_POLICY, def?.prompt ?? ""].filter(Boolean).join("\n\n"),
      disallowedTools: [...new Set([...(base!.disallowedTools ?? []), "SendMessage", "TaskStop"])],
      ...(def?.tools ? { tools: def.tools } : {}),
    };
    let head: ClaudeWorkerHead;
    try {
      head = this.factory(config, {
        // A kept-alive process carries later runs too: its items belong to whichever run is under way.
        onItem: (item) => this.onItem(w, head, w.run, item),
        onExit: (exit) => this.onExit(w, head, w.run, exit),
      });
      live.head = head;
      head.start();
    } catch (error) {
      live.head = undefined;
      this.finish(w, run, "failed", `The worker could not start: ${(error as Error).message}`);
      return null;
    }
    if (head.pid > 0) {
      try { this.options.processStarted?.(head.pid); } catch { /* the ledger is best effort here; identity below */ }
      const started = processStartTime(head.pid);
      if (started) { w.processes = [...w.processes, { pid: head.pid, started }].slice(-8); this.save(); }
    }
    head.send(words, uuid);
    return null;
  }

  private onItem(w: Record_, head: ClaudeWorkerHead, run: number, item: StreamItem) {
    const live = this.liveOf(w);
    if (live.head !== head || this.closed) return;
    if (item.kind === "init") {
      let save = !w.sessionStarted;
      w.sessionStarted = true;
      if (item.sessionId && item.sessionId !== w.sessionId && UUID.test(item.sessionId)) { w.sessionId = item.sessionId; save = true; }
      if (save) this.save();
      return;
    }
    if (!w.active || w.run !== run) {
      // A kept-alive process between runs: an approval it asks has nobody to answer it.
      if (item.kind === "permission") head.answer(item.requestId, false, item.input, "Not now: this worker's run has ended.");
      return;
    }
    switch (item.kind) {
      case "delta": this.emit({ kind: "subagentText", parent: w.id, text: item.text }); return;
      case "toolUse": case "toolResult": this.emit({ ...item, parent: w.id, id: `${w.id}:${run}:${item.id}` }); return;
      case "permission":
        live.approvals.set(item.requestId, item.input);
        this.emit({ ...item, requestId: `worker:${w.id}:${run}:${item.requestId}`, workerId: w.id, input: { ...item.input } });
        return;
      case "permissionCancelled":
        if (live.approvals.delete(item.requestId)) this.emit({ kind: "permissionCancelled", requestId: `worker:${w.id}:${run}:${item.requestId}` });
        return;
      case "usage": {
        const spent = Math.max(0, item.totalCost - live.cost);
        live.cost = Math.max(live.cost, item.totalCost);
        if (Number.isSafeInteger(item.tokens.output) && item.tokens.output > 0) {
          live.outputTokens += item.tokens.output;
          this.emit({ kind: "subagentOutput", id: w.id, counter: `claude:${w.sessionId}:run${run}`, tokens: live.outputTokens });
        }
        this.emit({ kind: "usage", totalCost: spent, tokens: item.tokens });
        return;
      }
      case "command":
        if (item.state !== "started" || !live.queued.delete(item.id)) return;
        // A follow-up that got a turn of its own: the run goes on until that turn's result.
        if (live.pendingResult) { clearTimeout(live.settle); live.settle = undefined; live.pendingResult = undefined; }
        else live.extraTurns += 1;
        return;
      case "result": {
        if (live.extraTurns > 0) { live.extraTurns -= 1; return; }
        if (live.queued.size) {
          // A follow-up sent during this turn was either read into it or gets a turn of its own right after.
          live.pendingResult = item;
          live.settle = setTimeout(() => {
            live.settle = undefined;
            const result = live.pendingResult;
            live.pendingResult = undefined;
            live.queued.clear();
            if (result) this.finishResult(w, run, result);
          }, this.options.settleMs ?? 1_500);
          live.settle.unref?.();
          return;
        }
        this.finishResult(w, run, item);
        return;
      }
      default: return;
    }
  }

  private finishResult(w: Record_, run: number, item: Extract<StreamItem, { kind: "result" }>) {
    const words = item.text.trim();
    this.finish(w, run, item.ok && words ? "completed" : "failed", item.ok ? (words || "The worker ended without a report.") : (item.error || item.text || "The worker's run failed."));
  }

  private onExit(w: Record_, head: ClaudeWorkerHead, run: number, exit: { expected: boolean; stderr: string; code: number | null }) {
    const live = this.liveOf(w);
    if (live.head !== head) return;
    live.head = undefined;
    if (live.keepAlive) { clearTimeout(live.keepAlive); live.keepAlive = undefined; }
    if (live.settle) { clearTimeout(live.settle); live.settle = undefined; const result = live.pendingResult; live.pendingResult = undefined; if (result) { this.finishResult(w, run, result); return; } }
    if (!w.active || w.run !== run || live.stopping || this.closed) return;
    this.finish(w, run, "failed", `The worker's process ended before its report${exit.code !== null ? ` (exit ${exit.code})` : ""}.${exit.stderr ? `\n${exit.stderr.slice(-2_000)}` : ""}`);
  }

  private finish(w: Record_, run: number, status: "completed" | "failed", report: string) {
    if (!w.active || w.run !== run) return;
    const live = this.liveOf(w);
    this.cancelApprovals(w, live);
    w.active = false; w.status = status; w.report = report.slice(0, 200_000); w.reportPending = true; w.reportDelivered = false;
    this.save();
    this.emit({ kind: "subagentEnded", id: w.id, status, summary: w.report });
    // Kept a while for a quick follow-up (no new process, no resume); then it goes to sleep.
    if (live.head?.running) {
      const head = live.head;
      live.keepAlive = setTimeout(() => { live.keepAlive = undefined; if (live.head === head && !w.active) head.finish(); }, this.options.keepAliveMs ?? 10 * 60_000);
      live.keepAlive.unref?.();
    }
    this.deliver(w);
  }

  private deliver(w: Record_) {
    if (!w.reportPending || w.reportDelivered || this.closed) return;
    const tail = "This is the worker's own account, not proof the user's goal is met: check what matters, then tell the user in a sentence or two what came of it. To continue this worker, use app_send_message with its task_id; to stop it, app_cancel_task.";
    let taken = false;
    try { taken = this.report(w.id, workerReportText({ id: w.id, run: w.run, engine: "claude", status: w.status, report: w.report ?? "" }, tail), w.run); } catch { taken = false; }
    if (!taken) return;
    w.reportDelivered = true; w.reportPending = false;
    this.save();
  }

  /** Reports that did not reach the coordinator (it could not take them, or the app stopped first): handed over again, once each. */
  redeliver() { for (const w of this.workers.values()) if (!w.active && w.reportPending && !w.reportDelivered) this.deliver(w); }

  private cancelApprovals(w: Record_, live: Live) {
    for (const id of live.approvals.keys()) this.emit({ kind: "permissionCancelled", requestId: `worker:${w.id}:${w.run}:${id}` });
    live.approvals.clear();
  }

  /** Stops its run: the process ends (its work so far stays in its session), no report is made. */
  private async stop(w: Record_) {
    const live = this.liveOf(w);
    this.cancelApprovals(w, live);
    live.stopping = true;
    if (live.settle) { clearTimeout(live.settle); live.settle = undefined; live.pendingResult = undefined; }
    w.active = false; w.status = "stopped"; w.reportPending = false; w.report = "Stopped by the app; its work was not finished.";
    this.save();
    this.emit({ kind: "subagentEnded", id: w.id, status: "stopped", summary: w.report });
    await this.release(w);
  }

  /** Ends its kept-alive process, if any. */
  private async release(w: Record_) {
    const live = this.liveOf(w);
    if (live.keepAlive) { clearTimeout(live.keepAlive); live.keepAlive = undefined; }
    const head = live.head;
    live.head = undefined;
    if (head) await head.terminate(1_500).catch(() => undefined);
  }

  /** An interrupted worker may continue only once its old processes are gone (never two processes on one session). */
  private recoveryBlocker(w: Record_): string | null {
    if (!w.interrupted || this.liveOf(w).head) return null;
    const alive = w.processes.some(({ pid, started }) => processStartTime(pid) === started && groupAlive(pid));
    return alive ? "This worker's earlier process is still running; it cannot be resumed until it has ended." : null;
  }

  private trim() {
    if (this.workers.size <= MAX_WORKERS) return;
    for (const w of this.workers.values()) {
      if (this.workers.size <= MAX_WORKERS) break;
      if (!w.active && !w.reportPending && !this.live.get(w.id)?.head) { this.workers.delete(w.id); this.live.delete(w.id); }
    }
  }

  /** An approval card's answer (`worker:<task>:<run>:<claude's request id>`). */
  answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string): boolean {
    const match = /^worker:([0-9a-f-]{36}):(\d+):(.+)$/i.exec(requestId);
    if (!match || this.closed) return false;
    const w = this.workers.get(match[1]!);
    const live = w ? this.live.get(w.id) : undefined;
    if (!w?.active || w.run !== Number(match[2]) || !live?.head || !live.approvals.delete(match[3]!)) return false;
    live.head.answer(match[3]!, allow, input, message);
    return true;
  }

  get running(): string[] { return [...this.workers.values()].filter((w) => w.active).map((w) => w.id); }

  /**
   * The app is quitting (or the bot is removed): every worker's process ends. One at work is `interrupted`; it is not
   * replayed, and a later app_send_message resumes its session (`--resume`).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.workers.values()) {
      const live = this.live.get(w.id);
      if (live?.settle) { clearTimeout(live.settle); live.settle = undefined; live.pendingResult = undefined; }
      if (live?.keepAlive) { clearTimeout(live.keepAlive); live.keepAlive = undefined; }
      if (!w.active) continue;
      if (live) this.cancelApprovals(w, live);
      w.active = false; w.interrupted = true; w.status = "interrupted"; w.reportPending = false;
      w.report = "Interrupted when the app quit. Nothing was replayed; continue it with app_send_message (it resumes its session).";
      this.emit({ kind: "subagentEnded", id: w.id, status: "stopped", summary: w.report });
    }
    this.save();
    await Promise.allSettled([...this.live.values()].map((live) => { const head = live.head; live.head = undefined; return head?.terminate(1_500); }));
  }
}

/** claude-workers.json in a bot's store. */
export const claudeWorkersFile = (storeDir: string) => join(storeDir, "claude-workers.json");
