// A bot's Codex head: one long-lived `codex app-server` over stdio, and which Codex thread each bot session is
// (split out of codex.ts, M7-S11; the protocol `CodexSession` stays there).
import { claudeConfigFolder } from "../claude-files";
import { inspectClaudeRestart } from "../claude-restart";
import { MANAGED_TOOL_SIGNATURE, type CodexItem, type CodexOutput, type WorkerDependency, type WorkerRecord } from "./codex-types";
import { CodexSession } from "./codex";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../durable/atomic";
import { processTreeAdapter, type ManagedProcess, type ProcessTreeAdapter, type TerminateResult } from "../process/tree";
import { childEnvironment } from "./runner";
import { codexLogsFile, codexRetryAt } from "./codex-retry-log";
import { cliStartError, resolveExecutable } from "../process/executable";
import type { HeadHandlers } from "./head";
import type { WorkerHost, WorkerInfo, WorkerOwner, WorkerOwnerResult, WorkerSendResult } from "./workers";
import { EditorTransport, type ComponentEditorAction, type ComponentEditorRoute } from "./component-editor";
import type { BotToolRunner } from "../bot-tools";
import type { HotSettings } from "./hot-settings";
import { loadMonitors, saveMonitors, type CommandMonitor } from "./monitors";
import type { WorkerCoreFactory } from "../worker-core";

/** The reply: the last message that is not commentary (the final answer); else the last one. */
export function reply(said: { text: string; phase: string | null }[]): string {
  return (said.findLast((s) => s.phase !== "commentary") ?? said.at(-1))?.text ?? "";
}

// ---------------------------------------------------------------------------------------------
// Which Codex thread each bot session is (`CodexThreads`): codex names its threads itself, while a
// bot names its session (a UUID) before it starts. Under <core>/codex-threads/, as 1.x.

export class CodexThreads {
  constructor(readonly folder: string) {}

  private file(session: string, suffix = "") {
    return join(this.folder, session.toLowerCase() + suffix);
  }

  thread(session: string): string | null {
    try {
      const text = readFileSync(this.file(session), "utf8").trim();
      return text || null;
    } catch {
      return null;
    }
  }

  save(thread: string, session: string) {
    mkdirSync(this.folder, { recursive: true });
    const old = this.thread(session);
    if (old && old !== thread) {
      // The old transcript stays findable when a tool change needed a new coordinator.
      const lineage = this.file(session, ".previous-threads");
      const known = existsSync(lineage) ? readFileSync(lineage, "utf8") : "";
      if (!known.split("\n").includes(old)) writeFileAtomic(lineage, `${known}${old}\n`);
    }
    writeFileAtomic(this.file(session), thread);
  }

  isManaged(session: string, thread: string): boolean {
    try {
      const stamp = JSON.parse(readFileSync(this.file(session, ".managed"), "utf8"));
      return stamp?.thread === thread && stamp?.tools === MANAGED_TOOL_SIGNATURE;
    } catch {
      return false;
    }
  }

  markManaged(thread: string, session: string) {
    mkdirSync(this.folder, { recursive: true });
    writeFileAtomic(this.file(session, ".managed"), JSON.stringify({ thread, tools: MANAGED_TOOL_SIGNATURE }));
  }

  workers(session: string): WorkerRecord[] {
    try {
      const value = JSON.parse(readFileSync(this.file(session, ".workers.json"), "utf8"));
      return Array.isArray(value) ? value.filter((row) => row && typeof row.id === "string" && typeof row.name === "string" && typeof row.instructions === "string" && typeof row.run === "number") : [];
    } catch {
      return [];
    }
  }

  saveWorkers(records: WorkerRecord[], session: string) {
    mkdirSync(this.folder, { recursive: true });
    writeFileAtomic(this.file(session, ".workers.json"), JSON.stringify(records));
  }
}

// ---------------------------------------------------------------------------------------------
// The process

export interface CodexHeadConfig {
  /** The bot tools (core/bot-tools.ts: the browser pane, the Note): the coordinator's and its workers'. */
  browser?: BotToolRunner;
  restartWorkers?: WorkerRecord[];
  /** After an explicit restart (its time): the workers the ledger says it interrupted are checked and resumed. */
  restartRecovery?: number;
  /** The member's core (Bot: its worker ledger and projections); absent: codex-threads/<session>.workers.json. */
  workerCore?: WorkerCoreFactory;
  /** Where its workers' items go (Bot: its one worker entry); absent: `onItem` with the coordinator's. */
  workerSink?: (item: CodexItem) => void;
  strictResume?: boolean;
  restartTurn?: string;
  /** `codex`, or the fake app-server's interpreter for tests. */
  command: string;
  /** Plugins' skill folders (`CodexConfig.skillRoots`). */
  skillRoots?: string[];
  prefixArgs?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** The bot's session (a UUID): the thread it names is kept in `threads`. */
  sessionId: string;
  resume: boolean;
  threads: CodexThreads;
  instructions: string;
  workerInstructions: string | null;
  model?: string | null;
  workerModel?: string | null;
  effort?: string | null;
  workerEffort?: string | null;
  workerFast?: boolean | null;
  /** The bot's scheduled-routines.json, for `app_routines` (null: none). */
  routinesFile?: string | null;
  /** Codex's own reviewer answers escalations (default on). */
  autoMode?: boolean;
  /** Explicit opt-in: no approval prompts and no Codex sandbox. */
  bypassPermissions?: boolean;
  /** More folders it may write (its `--add-dir` folders; 1.x's `writableRoots`). */
  writableRoots?: string[];
  /** Model families whose workers may write spec/ (settings.json `specWriters`). */
  specWriters?: readonly string[];
  componentEditor?: ComponentEditorRoute | null;
  /** Register the separate Claude process with the app's existing process ledger. */
  editorStarted?: (pid: number) => void;
  /** Codex's log, read for when a retry goes (undefined: CODEX_HOME's logs_2.sqlite; null: never read). */
  retryLog?: string | null;
}

/** One long-lived `codex app-server` for one bot session: `CodexSession` over its stdio. */
export class CodexHead {
  readonly engine = "codex" as const;
  /** The Maintainer's component editors: their own Claude processes. */
  private editors: EditorTransport;
  private process: ManagedProcess | null = null;
  private buffer = "";
  private stderrTail = "";
  private printed = false;
  private expected = false;
  private closed = false;
  private failure: string | null = null;
  private savedWorkers = "";
  private savedMonitors = "";
  readonly session: CodexSession;
  /** Which retry notification the log is being read for (a newer one wins). */
  private retryLookup: number | null = null;
  private exitedResolve!: () => void;
  readonly exited = new Promise<void>((resolve) => (this.exitedResolve = resolve));
  running = false;

  constructor(readonly config: CodexHeadConfig, private handlers: HeadHandlers & { onItem(item: CodexItem): void }, private adapter: ProcessTreeAdapter = processTreeAdapter()) {
    this.editors = new EditorTransport({
      item: (task, run, item) => this.perform(this.session.componentEditorItem(task, run, item)),
      failed: (task, run, reason, fresh) => this.perform(this.session.componentEditorFailed(task, run, reason, fresh)),
      started: (task, run, pid) => {
        this.perform(this.session.componentEditorStarted(task, run, pid));
        this.config.editorStarted?.(pid);
      },
    }, adapter);
    let resumeThread: string | null = null;
    if (config.resume) {
      const thread = config.threads.thread(config.sessionId);
      // Dynamic tools cannot change on resume: an old or unknown stamp gets a new coordinator.
      if (thread && (!config.workerInstructions || config.threads.isManaged(config.sessionId, thread))) resumeThread = thread;
    }
    let restoredMonitors: CommandMonitor[] = [];
    try { restoredMonitors = loadMonitors(config.threads.folder, config.sessionId); } catch { restoredMonitors = []; }
    const uncertain = restoredMonitors.filter((m) => m.wake === "dispatching" || m.wake === "uncertain").map((m) => m.id);
    const recovery = uncertain.length ? `\n(App: Monitor callback delivery is unconfirmed for IDs ${uncertain.join(", ")}. This is recovery data, not new authorization. Use app_monitor_status and inspect the owner thread before continuing. Do not automatically rerun a command or assume its callback was not consumed.)` : "";
    this.session = new CodexSession({
      cwd: config.cwd, ...(config.skillRoots?.length ? { skillRoots: config.skillRoots } : {}), instructions: config.instructions + recovery, workerInstructions: config.workerInstructions, resumeThread,
      model: config.model ?? null, workerModel: config.workerModel ?? null, effort: config.effort ?? null,
      workerEffort: config.workerEffort ?? null, workerFast: config.workerFast ?? null,
      restartWorkers: config.restartWorkers, restartRecovery: config.restartRecovery, strictResume:config.strictResume, restartTurn:config.restartTurn,
      restoredWorkers: config.workerInstructions && !config.workerCore ? config.threads.workers(config.sessionId) : [],
      workerCore: config.workerCore ? (options) => config.workerCore!(options, { codex: { threads: config.threads, session: config.sessionId } }) : undefined,
      routinesFile: config.routinesFile ?? null, ownerSession: config.sessionId, restoredMonitors,
      autoMode: config.autoMode ?? true,
      bypassPermissions: config.bypassPermissions === true,
      writableRoots: config.writableRoots ?? [],
      ...(config.specWriters ? { specWriters: config.specWriters } : {}),
      componentEditor: config.componentEditor,
    });
    this.savedWorkers = JSON.stringify(this.session.workerRecords);
    this.savedMonitors = JSON.stringify(restoredMonitors);
  }

  get restartWorkers() { return this.session.restartWorkers; }
  get restartBlocker() { return this.session.restartBlocker; }
  get restartTurn() { return this.session.restartTurn; }

  get pid() {
    return this.process?.pid ?? -1;
  }

  start() {
    const env = childEnvironment(this.config.env);
    const managed = this.adapter.spawn(resolveExecutable(this.config.command, env), [...(this.config.prefixArgs ?? []), "app-server"], { cwd: this.config.cwd, env });
    this.process = managed;
    this.running = true;
    const child = managed.child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.read(chunk));
    child.stderr.on("data", (chunk: string) => { this.stderrTail = (this.stderrTail + chunk).slice(-8_000); });
    child.stdin.on("error", () => { /* EPIPE once it exited */ });
    let reported = false;
    const report = (code: number | null, signal: NodeJS.Signals | null, extra = "") => {
      if (reported) return;
      reported = true;
      this.running = false;
      this.closed = true;
      if (this.buffer.trim()) this.line(this.buffer.trim());
      this.buffer = "";
      this.stopEditors();
      this.exitedResolve();
      const why = [this.failure, this.stderrTail.trim(), extra].filter(Boolean).join("\n");
      // Its workers' turns went with it: their runs end (failed), and their reports wait in the journal for the next head.
      this.perform(this.session.exited(why));
      this.handlers.onExit({ code: this.failure ? 1 : code, signal, stderr: why, expected: this.expected, silent: !this.printed });
    };
    child.once("error", (error) => report(null, null, cliStartError("codex", this.config.command, error)));
    child.once("close", (code, signal) => report(code, signal));
    this.perform(this.session.start());
  }

  /**
   * When the retry goes, from Codex's log (read-only, codex-retry-log.ts): a few tries over about
   * 25 s, as codex 0.163.0 writes its log rows in batches (seen about 10 s late). Found: the same
   * item again with `retryAt` (the bot takes it only while that attempt is still the one it shows).
   */
  private findRetryTime(item: Extract<CodexItem, { kind: "apiRetry" }>) {
    const file = this.config.retryLog === undefined ? codexLogsFile(childEnvironment(this.config.env)) : this.config.retryLog;
    if (!file) return;
    const since = Date.now() - 2_000;
    const lookup = this.retryLookup = (this.retryLookup ?? 0) + 1;
    const look = (waits: number[]) => {
      const [wait, ...later] = waits;
      if (wait === undefined) return;
      setTimeout(() => {
        if (this.closed || this.retryLookup !== lookup) return;
        void codexRetryAt({ file, thread: item.thread, attempt: item.attempt, since }).then((at) => {
          if (this.closed || this.retryLookup !== lookup) return;
          if (at === null) return look(later);
          this.handlers.onItem({ ...item, retryAt: at });
        });
      }, wait).unref?.();
    };
    look([500, 3_000, 4_000, 4_000, 4_000, 8_000]);
  }

  private read(chunk: string) {
    this.printed = true;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.line(line);
    }
  }

  private line(line: string) {
    this.perform(this.session.receive(line));
  }

  /** Does what the session says, in order (writes keep their order). Worker records are saved first. */
  private perform(outputs: CodexOutput[]) {
    const records = this.session.workerRecords;
    const text = JSON.stringify(records);
    // With the member's core, its worker ledger is the record: the old journal is no longer written.
    if (text !== this.savedWorkers && this.config.workerInstructions && !this.config.workerCore) {
      this.config.threads.saveWorkers(records, this.config.sessionId);
      this.savedWorkers = text;
    }
    // A monitor's state is written before what it leads to is done (its command, its wake).
    const monitors = this.session.monitorRecords;
    const monitorText = JSON.stringify(monitors);
    const monitorsChanged = monitorText !== this.savedMonitors;
    if (monitorsChanged) {
      saveMonitors(this.config.threads.folder, this.config.sessionId, monitors);
      this.savedMonitors = monitorText;
    }
    for (const output of outputs) {
      switch (output.kind) {
        case "write":
          if (!this.closed && this.process) this.process.child.stdin.write(`${JSON.stringify(output.value)}\n`);
          break;
        case "item":
          if (output.worker && this.config.workerSink) { this.config.workerSink(output.item); break; }
          this.handlers.onItem(output.item);
          if (output.item.kind === "apiRetry") this.findRetryTime(output.item);
          break;
        case "thread":
          this.config.threads.save(output.id, this.config.sessionId);
          if (this.config.workerInstructions) this.config.threads.markManaged(output.id, this.config.sessionId);
          this.handlers.onItem({ kind: "init", sessionId: this.config.sessionId });
          break;
        case "recoverEditor": {
          const launch=this.config.componentEditor?.launch;
          const outcome=launch?inspectClaudeRestart({cwd:launch.cwd,configDir:claudeConfigFolder({...process.env,...launch.env}),sessionId:output.session,checkpoint:output.checkpoint}):{state:'blocked' as const,reason:'Original component-editor definition is unavailable; no replacement was created.'};
          this.perform(this.session.recoverEditor(output.task,output.run,outcome));
          break;
        }
        case "componentEditor":
          this.performEditor(output.action);
          break;
        case "browser": {
          const reply = (payload: unknown, success: boolean) => {
            if (!this.closed && this.process) this.process.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: output.rpcId, result: { success, contentItems: [{ type: "inputText", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] } })}\n`);
          };
          const run = this.config.browser;
          if (!run) { reply({ error: "That tool is not available here." }, false); break; }
          void run(output.tool, output.args, output.worker ? "worker" : "coordinator").then((result) => reply(result, true), (error) => reply({ error: (error as Error).message }, false));
          break;
        }
        case "close":
          this.stopEditors();
          this.closeInput();
          break;
        case "failed":
          this.failure = output.message;
          this.stopEditors();
          this.closeInput();
          void this.process?.terminate({ graceMs: 1_000 });
          break;
      }
    }
    if (monitorsChanged) for (const record of monitors) this.handlers.onItem({ kind: "monitorState", record });
  }

  private stopEditors() {
    this.editors.stopAll();
  }

  private performEditor(action: ComponentEditorAction) {
    this.editors.perform(action);
  }

  private closeInput() {
    if (this.closed || !this.process) return;
    this.closed = true;
    this.process.child.stdin.end();
  }

  send(text: string, _uuid?: string, images: string[] = []) {
    this.perform(this.session.send(text, images));
  }

  canApplySettings(target: HotSettings): boolean {
    return !this.closed && this.running && this.session.canApplySettings(target);
  }

  /** Its model and effort from its next turn on, in this same thread (`CodexSession.applySettings`). */
  async applySettings(target: HotSettings): Promise<boolean> {
    if (this.closed || !this.running || !this.session.applySettings(target)) return false;
    if ("model" in target) this.config.model = this.session.config.model;
    if ("effort" in target) this.config.effort = this.session.config.effort;
    return true;
  }

  /** Words for the turn under way (`turn/steer`); false when it has none. */
  steer(text: string): boolean {
    const { joined, out } = this.session.steer(text);
    this.perform(out);
    return joined;
  }

  answer(requestId: string, allow: boolean, _input: Record<string, unknown>, message?: string) {
    this.perform(this.session.answer(requestId, allow, allow ? undefined : message));
  }

  /** Forward only the rules the app has already approved to its existing Claude children. */
  allow(rules: string[]) {
    const launch = this.config.componentEditor?.launch;
    if (!launch) return;
    launch.allowRules = [...rules];
    this.editors.allow(rules);
  }

  interrupt(): string {
    this.perform(this.session.interrupt());
    return "";
  }

  /** Workers at work now. */
  get workers(): string[] {
    return this.session.runningWorkers;
  }

  /** The live worker and monitor snapshot the completion judge reads. */
  get completionDependencies(): WorkerDependency[] {
    return this.session.completionDependencies;
  }

  cancelWorkers(ids?: Set<string>) {
    this.perform(this.session.cancelWorkers(ids));
  }

  // WorkerHost (workers.ts): a worker is a thread of this app-server; the coordinator's Stop leaves it be.
  private workerHostImpl?: WorkerHost;
  get workerHost(): WorkerHost { return this.workerHostImpl ??= codexWorkerHost(this.session, (out) => this.perform(out), () => !this.closed && this.running); }
  readonly workerHostKind = "codex-thread" as const;
  readonly steersRunning = true;
  listWorkers(): WorkerInfo[] { return this.workerHost.listWorkers(); }
  sendToWorker(id: string, text: string): WorkerSendResult { return this.workerHost.sendToWorker(id, text) as WorkerSendResult; }
  stopWorker(id: string): Promise<boolean> { return this.workerHost.stopWorker(id); }
  setWorkerOwner(id: string, owner: WorkerOwner | null): WorkerOwnerResult { return this.workerHost.setWorkerOwner(id, owner); }

  /** The sub-bot hand-off's wrap-up request to one worker at work (false: it is not at work, nothing was sent). */
  messageRunningWorker(id: string, text: string): boolean {
    if (!this.session.runningWorkers.includes(id)) return false;
    this.perform(this.session.wrapUpWorker(id, text));
    return true;
  }

  /** Stdin closes once the turn under way and its workers' reports are done (going to sleep). */
  finish() {
    this.expected = true;
    this.perform(this.session.finish());
  }

  async terminate(graceMs = 1_500): Promise<TerminateResult> {
    this.expected = true;
    this.perform(this.session.stop());
    this.stopEditors();
    this.closeInput();
    const results = await Promise.all([...this.editors.ending, ...(this.process ? [this.process.terminate({ graceMs })] : [])]);
    return { killed: [...new Set(results.flatMap(result => result.killed))], forced: results.some(result => result.forced) };
  }
}

/** Codex's workers as a WorkerHost (workers.ts): `perform` carries the session's outputs to the app-server. */
export function codexWorkerHost(session: CodexSession, perform: (out: CodexOutput[]) => void, alive: () => boolean = () => true): WorkerHost {
  return {
    workerHostKind: "codex-thread",
    steersRunning: true,
    listWorkers: () => session.workerInfos,
    sendToWorker(id, text) {
      if (!alive()) return { ok: false, reason: "Its Codex head is not running; the worker went with its process." };
      const { result, out } = session.sendToWorker(id, text);
      perform(out);
      return result;
    },
    async stopWorker(id) {
      if (!session.runningWorkers.includes(id)) return false;
      perform(session.cancelWorkers(new Set([id])));
      return true;
    },
    setWorkerOwner(id, owner) {
      const set = session.setWorkerOwner(id, owner);
      if (!set.ok) return set;
      perform(set.out);
      return { ok: true };
    },
    answer(requestId, allow, _input, message) {
      const { answered, out } = session.answerWorker(requestId, allow, allow ? undefined : message);
      perform(out);
      return answered;
    },
    async close() { perform(session.closeWorkers()); },
  };
}
