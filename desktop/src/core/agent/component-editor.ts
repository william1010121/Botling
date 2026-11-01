// The existing Claude editor, bound by Core to its own plugin-library Maintainer.
// Mirrors ComponentEditorRouting.swift: definition/model/tools stay authoritative;
// no generic worker fallback and no additional folders, plugins or approval grants.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionStart } from "../bot";
import { processStartTime } from "../process/kill-tree";
import type { ProcessTreeAdapter, TerminateResult } from "../process/tree";
import { MAINTAINER_ID } from "../store/records";
import { Layout, type BotProfile } from "../store/workspace";
import { costDelta, type RecoverResult, type RunHandle, type WorkerAdapter, type WorkerEvent, type WorkerLedgerRecord } from "../worker-core";
import type { CodexItem } from "./codex";
import { ClaudeHead, type HeadConfig } from "./head";
import type { StreamItem } from "./stream";

export type ComponentEditorRoute = { launch: HeadConfig; error?: never } | { error: string; launch?: never };
export type ComponentEditorAction =
  | { kind: "start"; task: string; run: number; config: HeadConfig; text: string }
  | { kind: "send"; task: string; run: number; text: string }
  | { kind: "stop"; task: string }
  | { kind: "answer"; task: string; run: number; requestId: string; allow: boolean; input: Record<string, unknown>; message?: string };

/** Only the exact profile Core created can acquire the route. Names, folders and copied IDs cannot. */
export function maintainerEditorBinding(owner: BotProfile, root: string, headConfig: (profile: BotProfile, session: SessionStart) => HeadConfig) {
  const library = resolve(root, "plugins");
  return (profile: BotProfile, session: SessionStart): ComponentEditorRoute | null => {
    if (profile !== owner || profile.id !== MAINTAINER_ID || profile.role !== "manager"
      || resolve(profile.folder) !== library || resolve(profile.storeDir) !== resolve(Layout.bot(root, MAINTAINER_ID))) return null;
    const parent = headConfig(profile, session);
    if (resolve(parent.cwd) !== library) return { error: "The Maintainer editor's working folder does not match the app's plugin library. No editor was launched." };
    const file = join(library, "ccb-core", "claude", "agents", "component-editor.md");
    let text: string;
    try { text = readFileSync(file, "utf8"); }
    catch { return { error: `Cannot load the existing component-editor definition at ${file}. No generic worker was substituted.` }; }
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
    const fields: Record<string, string> = {};
    for (const line of match?.[1].split(/\r?\n/) ?? []) {
      const at = line.indexOf(":");
      if (at >= 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const role = match?.[2].trim();
    if (fields.name !== "component-editor" || !role) return { error: `Invalid component-editor definition at ${file}. No generic worker was substituted.` };
    if (!["haiku", "sonnet", "opus"].includes(fields.model)) return { error: "The component-editor definition has no supported explicit Claude model. No model or settings were substituted." };
    const tools = (fields.tools ?? "").split(",").map(tool => tool.trim()).filter(Boolean);
    if (!tools.length || tools.some(tool => !["Read", "Write", "Edit", "Bash"].includes(tool))) return { error: "The component-editor definition requests tools outside its existing Read/Write/Edit/Bash boundary; no tools or settings were changed." };
    return { launch: {
      monitorWorker: true, command: parent.command, prefixArgs: parent.prefixArgs, cwd: library, env: parent.env,
      sessionId: session.sessionId, resume: false, model: fields.model, systemPrompt: role,
      allowedTools: tools, tools, disallowedTools: [...new Set([...(parent.disallowedTools ?? []), "Agent", "Task", "SendMessage"])],
      addDirs: parent.addDirs, effort: parent.effort, autoMode: parent.autoMode, bypassPermissions: parent.bypassPermissions, allowRules: parent.allowRules,
      askPermission: parent.askPermission, harmless: parent.harmless, harmlessTools: parent.harmlessTools?.filter(tool => tools.includes(tool)),
    } };
  };
}

// ---------------------------------------------------------------------------------------------
// The editor as a worker (shared-core spec 4.2): a Claude process the Codex Maintainer's WorkerCore holds next to its
// Codex threads. EditorTransport keeps the processes (Swift's transport: a finished editor stays alive for corrections
// in its same session, and a transcript is never opened twice); ComponentEditorAdapter only translates them into the
// core's WorkerEvents. Text, the end, the report, usage and the approvals table are the core's.

/** What an editor's Claude process tells its owner. */
export interface EditorEvents {
  item(task: string, run: number, item: StreamItem): void;
  /** It exited before its result (fresh: it never printed, so its session was never written). */
  failed(task: string, run: number, reason: string, fresh: boolean): void;
  /** Its process started (identity for recovery). */
  started(task: string, run: number, pid: number): void;
}

/** The editors' Claude processes, one per task (CodexHead's, or a replay's on recorded processes). */
export class EditorTransport {
  private editors = new Map<string, { head: ClaudeHead; run: number; messages: string[] }>();
  private cleanup = new Set<Promise<TerminateResult>>();
  private stops = new Map<string, Promise<TerminateResult>>();

  constructor(private events: EditorEvents, private adapter: ProcessTreeAdapter) {}

  /** Processes still ending. */
  get ending(): Promise<TerminateResult>[] { return [...this.cleanup]; }

  private retire(task: string, head: ClaudeHead) {
    if (head.pid < 0) { void head.terminate(); return; }
    const ending = head.terminate(1_000);
    this.cleanup.add(ending);
    this.stops.set(task, ending);
    const clean = () => {
      this.cleanup.delete(ending);
      if (this.stops.get(task) === ending) this.stops.delete(task);
    };
    void ending.then(clean, clean);
  }

  stopAll() {
    for (const [task, { head }] of this.editors) this.retire(task, head);
    this.editors.clear();
  }

  /** Forwards rules the app already approved to the running editors. */
  allow(rules: string[]) {
    for (const { head } of this.editors.values()) {
      head.config.allowRules = [...rules];
      if (head.running) head.allow(rules);
    }
  }

  perform(action: ComponentEditorAction) {
    const current = this.editors.get(action.task);
    if (action.kind === "stop") {
      if (current) { this.editors.delete(action.task); this.retire(action.task, current.head); }
      return;
    }
    if (action.kind === "send") {
      if (current?.run === action.run) {
        if (current.head.running) current.head.send(action.text, randomUUID());
        else current.messages.push(action.text);
      }
      return;
    }
    if (action.kind === "answer") {
      if (current?.run === action.run) current.head.answer(action.requestId, action.allow, action.input, action.message);
      return;
    }
    // As in Swift's transport, a finished editor stays alive for corrections in its same session.
    if (current?.head.running && current.head.config.sessionId === action.config.sessionId) {
      current.run = action.run;
      current.head.send(action.text, randomUUID());
      return;
    }
    if (current) { this.editors.delete(action.task); this.retire(action.task, current.head); }
    const head = new ClaudeHead({ ...action.config, monitorWorker: true }, {
      onItem: (item) => {
        const live = this.editors.get(action.task);
        if (live?.head === head) this.events.item(action.task, live.run, item);
      },
      onExit: (exit) => {
        const live = this.editors.get(action.task);
        if (live?.head !== head) return;
        this.editors.delete(action.task);
        this.retire(action.task, head);
        this.events.failed(action.task, live.run, exit.stderr || `exited (${exit.code})`, !action.config.resume && exit.silent);
      },
    }, this.adapter);
    this.editors.set(action.task, { head, run: action.run, messages: [] });
    const start = () => {
      // Cancellation or replacement while the prior process was ending revokes this launch.
      if (this.editors.get(action.task)?.head !== head) return;
      try {
        head.start();
        this.events.started(action.task, action.run, head.pid);
        head.send(action.text, randomUUID());
        const pending = this.editors.get(action.task)?.messages ?? [];
        for (const text of pending) head.send(text, randomUUID());
        pending.length = 0;
      } catch (error) {
        this.editors.delete(action.task);
        this.retire(action.task, head);
        this.events.failed(action.task, action.run, (error as Error).message, !action.config.resume);
      }
    };
    // Never open the same Claude transcript while its old process is still shutting down.
    const ending = this.stops.get(action.task);
    if (ending) void ending.then(start, (error) => {
      if (this.editors.get(action.task)?.head !== head) return;
      this.editors.delete(action.task);
      this.events.failed(action.task, action.run, `Could not stop the prior editor: ${String(error)}`, false);
    });
    else start();
  }
}

/** What the editor adapter needs from the Codex Maintainer that holds it. */
export interface ComponentEditorHost {
  /** The Maintainer's editor route now (absent or an error: no editor can start). */
  route(): ComponentEditorRoute | null | undefined;
  /** Carries out an action on the task's Claude process (an EditorTransport). */
  act(action: ComponentEditorAction): void;
  /** Items a run shows beside its events (its execution, the token-flow dispatch). */
  item(item: CodexItem): void;
  /** The coordinator's session (a run's execution record). */
  ownerSessionId(): string | null;
  /** Why a follow-up must wait (restart recovery still checks the task), else null. */
  recovering?(id: string): string | null;
}

interface EditorRun {
  run: RunHandle | null;
  /** The Claude session the run's process uses. */
  session: string | null;
  /** The process's running cost total (it lives on across runs while it is kept alive). */
  cost: { last: number };
  /** Open approvals: the child's own input, which its answer carries. */
  approvals: Map<string, Record<string, unknown>>;
  /** Tool calls without a result yet. */
  tools: Set<string>;
  /** Restart: the original run had completed with this report (adopted, nothing is sent). */
  adopt?: string;
  /** Restart: the run goes on in its session (scope and checkpoint kept). */
  continuing?: boolean;
}

/** The Maintainer's component editor as a worker: a Claude process, engine claude, kind "component-editor". */
export class ComponentEditorAdapter implements WorkerAdapter {
  readonly kind = "component-editor" as const;
  readonly engine = "claude" as const;
  readonly steersRunning = true;
  private runs = new Map<string, EditorRun>();

  constructor(private host: ComponentEditorHost) {}

  private state(id: string): EditorRun {
    let s = this.runs.get(id);
    if (!s) this.runs.set(id, s = { run: null, session: null, cost: { last: 0 }, approvals: new Map(), tools: new Set() });
    return s;
  }

  /** The task's run under way, when `run` is it. */
  private live(task: string, run: number): { s: EditorRun; run: RunHandle } | null {
    const s = this.runs.get(task);
    return s?.run && s.run.run === run ? { s, run: s.run } : null;
  }

  prepare() { return { engineData: { role: "component-editor" } }; }

  runtime() {
    const launch = this.host.route()?.launch;
    return { reasoningEffort: launch?.effort ?? null, model: launch?.model ?? null };
  }

  start(record: Readonly<WorkerLedgerRecord>, words: string, run: RunHandle) {
    const s = this.state(record.id);
    s.run = run;
    s.approvals.clear();
    s.tools.clear();
    this.host.item({ kind: "measurementDispatch", workerId: record.id, run: run.run });
    if (s.adopt !== undefined) {
      // Completed before the app restarted: its report is the run's, and nothing goes to Claude again.
      const report = s.adopt;
      delete s.adopt;
      run.emit({ type: "textWhole", text: report, phase: null });
      run.emit({ type: "end", end: { how: "normal", finalText: report, error: null, detail: "recovered" } });
      return;
    }
    const continuing = s.continuing === true;
    delete s.continuing;
    const thread = typeof record.engineData.thread === "string" ? record.engineData.thread : record.conversationId;
    const route = this.host.route();
    if (!route?.launch) {
      const error = thread || record.run > 1 ? "Cannot resume component-editor: its existing definition is unavailable. No generic worker was substituted."
        : route?.error ?? "The existing component-editor definition is unavailable; no generic worker was substituted.";
      run.emit({ type: "end", end: { how: "error", finalText: null, error, detail: "no definition" } });
      return;
    }
    const session = thread ?? randomUUID();
    s.session = session;
    run.setEngineData({ thread: session, ...(continuing ? {} : { editorCheckpoint: undefined, ownershipInstructions: run.run > 1 ? words : undefined }) });
    this.host.item({ kind: "subagentExecution", id: record.id, execution: { run: run.run, ownerSessionId: this.host.ownerSessionId(), threadId: session, turnId: null } });
    this.host.act({ kind: "start", task: record.id, run: run.run, config: { ...route.launch, monitorWorker: true, sessionId: session, resume: !!thread }, text: words });
  }

  steer(record: Readonly<WorkerLedgerRecord>, words: string): boolean {
    const s = this.runs.get(record.id);
    if (!s?.run) return false;
    const scope = typeof record.engineData.ownershipInstructions === "string" ? record.engineData.ownershipInstructions : record.instructions;
    s.run.setEngineData({ editorCheckpoint: undefined, ownershipInstructions: `${scope}\nFollow-up: ${words}` });
    this.host.act({ kind: "send", task: record.id, run: s.run.run, text: words });
    return true;
  }

  async stop(record: Readonly<WorkerLedgerRecord>) {
    const s = this.runs.get(record.id);
    if (s) { s.run = null; s.approvals.clear(); s.tools.clear(); }
    this.host.act({ kind: "stop", task: record.id });
    return { cleaned: true };
  }

  answer(record: Readonly<WorkerLedgerRecord>, nativeId: string, allow: boolean, input: Record<string, unknown>, message?: string) {
    const s = this.runs.get(record.id);
    if (!s?.run) return;
    // The child's own input goes back, never one supplied with the answer.
    const asked = s.approvals.get(nativeId) ?? input;
    s.approvals.delete(nativeId);
    this.host.act({ kind: "answer", task: record.id, run: s.run.run, requestId: nativeId, allow, input: asked, message });
  }

  /** Blocked while restart recovery checks it, or while a process it ran is still alive (same pid and start time). */
  recover(record: Readonly<WorkerLedgerRecord>): RecoverResult {
    const waiting = this.host.recovering?.(record.id);
    if (waiting) return { state: "blocked", reason: waiting };
    const alive = record.processes.find((p) => processStartTime(p.pid) === p.started);
    return alive ? { state: "blocked", reason: `Its earlier Claude process ${alive.pid} is still running; try again once it has ended.` } : { state: "clean" };
  }

  async close() {
    for (const [task, s] of this.runs) if (s.run) { s.run = null; this.host.act({ kind: "stop", task }); }
  }

  /** Restart: the next run adopts this report of the original run instead of starting Claude. */
  adopt(id: string, report: string) { this.state(id).adopt = report; }
  /** Restart: the next run continues the original one (its scope and checkpoint stay). */
  continueAfterRestart(id: string) { this.state(id).continuing = true; }

  /** Whether an app restart now could resume it from its transcript: a confirmed session, a checkpoint, nothing unanswered or unfinished. */
  restartSafe(record: Readonly<WorkerLedgerRecord>): boolean {
    const s = this.runs.get(record.id);
    return record.engineData.editorSessionConfirmed === true && typeof record.engineData.editorCheckpoint === "string" && !!record.engineData.editorCheckpoint
      && !s?.approvals.size && !s?.tools.size;
  }

  /** Open approvals of its run (a restart is not safe with one). */
  hasApprovals(id: string): boolean { return !!this.runs.get(id)?.approvals.size; }

  // From its process (EditorEvents through the Maintainer).

  started(task: string, run: number, pid: number) {
    const live = this.live(task, run);
    if (!live) return;
    live.s.cost = { last: 0 };
    if (pid > 0) live.run.emit({ type: "process", pid });
  }

  failed(task: string, run: number, reason: string, fresh: boolean) {
    const live = this.live(task, run);
    if (!live) return;
    live.s.run = null;
    // It never printed: its session was never written, so the next run starts a new one.
    if (fresh) live.run.setEngineData({ thread: undefined });
    live.run.emit({ type: "end", end: { how: "exited", finalText: null, error: `Claude component-editor failed: ${reason}`, detail: "exit" } });
  }

  item(task: string, run: number, item: StreamItem) {
    const live = this.live(task, run);
    if (!live) return;
    const { s, run: handle } = live;
    const emit = (event: WorkerEvent) => handle.emit(event);
    switch (item.kind) {
      case "init":
        handle.setEngineData({ editorSessionConfirmed: item.sessionId === s.session });
        if (item.sessionId) emit({ type: "session", conversationId: item.sessionId });
        return;
      case "delta": return emit({ type: "textDelta", text: item.text });
      case "textBlock": return emit({ type: "textBreak" });
      case "assistantText": return emit({ type: "textWhole", text: item.text, phase: null });
      case "toolUse":
        s.tools.add(item.id);
        return emit({ type: "toolUse", id: item.id, tool: item.tool, title: item.title, detail: item.detail, input: item.input });
      case "toolResult":
        s.tools.delete(item.id);
        handle.setEngineData({ editorCheckpoint: item.failed ? undefined : item.id });
        return emit({ type: "toolResult", id: item.id, output: item.output, failed: item.failed });
      case "usage": return emit({ type: "usage", tokens: item.tokens, cost: costDelta(s.cost, item.totalCost) });
      case "request": { const { scope: _scope, ...request } = item.request; return emit({ type: "request", request }); }
      case "measurement": return emit({ type: "measurement", provider: "claude", measurement: item.measurement });
      case "permission":
        s.approvals.set(item.requestId, item.input);
        return emit({ type: "permission", nativeId: item.requestId, tool: item.tool, summary: item.summary, input: item.input,
          ...(item.safetyCheck ? { safetyCheck: item.safetyCheck } : {}), ...(item.noAlways ? { noAlways: true } : {}) });
      case "permissionCancelled":
        s.approvals.delete(item.requestId);
        return emit({ type: "permissionCancelled", nativeId: item.requestId });
      case "permissionDenied": return emit({ type: "permissionDenied", toolUseId: item.toolUseId, tool: item.tool, reason: item.reason, confirmed: item.confirmed });
      case "connectionLost": return emit({ type: "connectionLost" });
      case "rateLimits": return emit({ type: "rateLimits", engine: item.engine, limits: item.limits });
      case "result":
        s.run = null;
        return emit({ type: "end", end: { how: item.how ?? (item.ok ? "normal" : "error"), finalText: item.ok && item.text ? item.text : null,
          error: item.ok ? null : item.error || item.text || null, detail: item.subtype } });
      default: return;
    }
  }
}
