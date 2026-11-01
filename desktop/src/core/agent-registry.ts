// The app-wide agent registry (agents.json): one record per agent any bot head hosts (a Claude subagent, a Codex
// or Antigravity app-managed worker), with who OWNS it (sees its row, gets its reports) apart from who HOSTS it
// (the head whose process holds it). Changing the owner never touches the agent: only the app's routing changes.
//
// The host's own files stay its execution journal (subagents.json, codex-threads/*.workers.json, agy workers.json);
// this registry is authoritative for owner, host, handle, summary and state, and is reconciled against the host
// books at every start (`reconcile`). Every move writes its intent first (`beginMove`), and the owner change and
// the "committed" phase are one write (`commitMove`), so a crash in between leaves the owner as it was.
import { createHash, randomBytes } from "node:crypto";
import type { Engine } from "./heads";
import type { SubagentRecord } from "./subagents";
import { isWorkerType, workerHostKindFor } from "./agent/workers";
import { agentState, subagentStatus } from "./worker-core/status";
import type { WorkerLedgerRecord } from "./worker-core/ledger";
import type { AgentStore } from "./store/agent-store";

export type AgentEngine = Engine; // "claude" | "codex" | "agy"

export type AgentState =
  | "running"        // the host says it is at work
  | "idle"           // ended a run; a native follow-up is possible (codex/agy idle worker)
  | "reportPending"  // ended; its report has not reached its owner yet (A2)
  | "completed" | "failed" | "stopped"
  | "interrupted"    // was running when its host process went away
  | "lost";          // host bot removed or native record gone

export interface BotRef { botId: string; engine: AgentEngine }

export interface AgentOwner extends BotRef {
  since: number;
  /** Newest last, at most 10. */
  history: { botId: string; engine: AgentEngine; until: number; moveId: string }[];
}

export type AgentHostKind = "claude-sidechain" | "claude-process" | "codex-thread" | "agy-acp";
export interface AgentHost extends BotRef {
  kind: AgentHostKind;
  sessionId: string | null;
  folder: string;
}

export type AgentHandle =
  | { kind: "claude-sidechain"; parentSessionId: string; toolUseId: string; agentId: string | null; configDir: string | null; checkpoint: string | null }
  | { kind: "claude-session"; sessionId: string; configDir: string | null }
  | { kind: "codex-thread"; threadId: string | null; coordinatorSessionId: string; run: number }
  | { kind: "agy-session"; sessionId: string | null; acpHome: string; run: number };

export interface AgentSummary {
  description: string;
  prompt: string;
  lastReport: string | null;
  stepCount: number; toolCount: number; lastStepAt: number | null;
  statusFile: string | null;
  handoffFile: string | null;
}

export interface AgentRecord {
  v: 1;
  id: string;
  nativeId: string;
  engine: AgentEngine;
  background: boolean;
  owner: AgentOwner;
  host: AgentHost;
  handle: AgentHandle;
  promptHash: string | null;
  model: string | null; effort: string | null;
  state: AgentState;
  summary: AgentSummary;
  relay: {
    muted: boolean;
    pendingMessages: { id: string; text: string; at: number; from: string }[];
    report: { run: number; delivered: boolean } | null;
  };
  ownerView: { settledAt: number | null; unsettledAt: number | null };
  succeededBy?: { kind: "subBot" | "owner"; botId: string };
  createdAt: number; updatedAt: number; endedAt: number | null;
  rev: number;
}

export interface MoveIntent {
  id: string; agentId: string;
  kind: "owner" | "host";
  from: { owner: BotRef; host?: AgentHost };
  to: { owner: BotRef; host?: AgentHost };
  phase: "intent" | "prepared" | "committed" | "notified";
  at: number;
}

export interface AgentsFile { format: "botling-agents-v1"; agents: AgentRecord[]; moves: MoveIntent[] }
export const AGENTS_FORMAT = "botling-agents-v1";

/** Where a host book lives: taken from the host `Bot` (`Bot.hostFacts`). */
export interface HostFacts { botId: string; engine: AgentEngine; sessionId: string | null; folder: string; kind: AgentHostKind }

/** One host book as it is at start, for `reconcile`. */
export interface StartupHost extends HostFacts {
  /** Its head process is running now. */
  running: boolean;
  list: readonly SubagentRecord[];
}
export interface StartupFacts {
  hosts: StartupHost[];
  /** Every bot that exists now (not removed). */
  bots: ReadonlySet<string>;
  now?: number;
}
export interface ReconcileReport {
  added: string[];
  dropped: string[];
  interrupted: string[];
  /** Moves that were committed but whose notices may not all have gone out: send them again (idempotent per move id). */
  resend: MoveIntent[];
  /** Agents whose host bot is gone while their owner is alive: the owner gets a notice. */
  hostLost: AgentRecord[];
  /** Agents whose owner bot is gone: the owner is the host again, and the host gets a notice. */
  ownerReverted: { record: AgentRecord; from: BotRef }[];
}

export const TERMINAL_STATES: ReadonlySet<AgentState> = new Set(["completed", "failed", "stopped"]);
const DESCRIPTION_LIMIT = 400;
const TEXT_LIMIT = 4_000;
const HISTORY_LIMIT = 10;
export const AGENTS_CAP = 2_000;
export const SETTLED_KEEP_MS = 7 * 24 * 3_600_000;
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

const clip = (text: string | null | undefined, limit: number) => typeof text === "string" ? (text.length > limit ? text.slice(0, limit) : text) : "";

/** The registry id: derived once from where it was first seen, then stored and never recomputed. */
export function agentId(hostBotId: string, engine: AgentEngine, nativeId: string): string {
  return `ag-${createHash("sha1").update(`${hostBotId}|${engine}|${nativeId}`).digest("hex").slice(0, 24)}`;
}

export function newMoveId(): string {
  return `mv-${randomBytes(12).toString("hex")}`;
}

/** Owner and host are different bots: its reports go to the owner, and its row is the owner's. */
export function isDetached(record: Pick<AgentRecord, "owner" | "host">): boolean {
  return record.owner.botId !== record.host.botId;
}

/** What the agent itself runs on (`bot.ts` `subagentView`'s rule). */
export function agentEngine(record: SubagentRecord, hostEngine: AgentEngine): AgentEngine {
  const runtime = (record as { runtime?: { engine?: unknown } }).runtime?.engine;
  if (runtime === "claude" || runtime === "codex" || runtime === "agy") return runtime;
  if (record.type === "codex-worker" || record.type === "codex") return "codex";
  if (record.type === "agy-worker") return "agy";
  return hostEngine;
}

export function hostKind(engine: AgentEngine): AgentHostKind {
  return engine === "codex" ? "codex-thread" : engine === "agy" ? "agy-acp" : "claude-sidechain";
}

/** Where this record runs: an app-managed worker in its own process (a Claude worker) whatever head lists it, else the head's kind. */
export function recordHostKind(host: Pick<HostFacts, "kind">, record: Pick<SubagentRecord, "type">): AgentHostKind {
  return workerHostKindFor(record.type, "claude") === "claude-process" ? "claude-process" : host.kind;
}

type LedgerView = Pick<WorkerLedgerRecord, "status" | "report" | "adapter">;
/** A ledger state to project (the adapter matters only for the component editor). */
const ledgerView = (status: WorkerLedgerRecord["status"], report: WorkerLedgerRecord["report"]["state"], adapter: WorkerLedgerRecord["adapter"] = "codex-thread"): LedgerView =>
  ({ status, report: { state: report, text: null, status: null, attempts: 0 }, adapter });

/** The worker ledger state a host book's status stands for (its report taken: the book does not know). */
const BOOK_LEDGER: Record<SubagentRecord["status"], WorkerLedgerRecord["status"]> = { running: "running", completed: "done", failed: "failed", stopped: "stopped" };

/**
 * The registry state for a host book's status. An app-managed worker's is status.ts's `agentState` (one that ended a
 * run is idle: it can take a follow-up); Claude's own sidechains and other subagents keep the book's word.
 */
export function stateFor(record: Pick<SubagentRecord, "status" | "type">, kind: AgentHostKind): AgentState {
  if (kind !== "claude-sidechain" && isWorkerType(record.type)) {
    const adapter = record.type === "ccb-core:component-editor" ? "component-editor" : kind;
    return agentState(ledgerView(BOOK_LEDGER[record.status], record.status === "running" ? "none" : "acknowledged", adapter));
  }
  return record.status;
}

/** The worker ledger state each registry state stands for ("lost" has none: its row is stopped). */
const STATE_LEDGER: Record<Exclude<AgentState, "lost">, LedgerView> = {
  running: ledgerView("running", "none"),
  idle: ledgerView("done", "acknowledged"),
  reportPending: ledgerView("done", "pending"),
  completed: ledgerView("done", "acknowledged", "component-editor"),
  failed: ledgerView("failed", "none"),
  stopped: ledgerView("stopped", "none"),
  interrupted: ledgerView("interrupted", "none"),
};

/** The row status (the contract's four) for a registry state: status.ts's `subagentStatus`. */
export function rowStatus(state: AgentState): "running" | "completed" | "failed" | "stopped" {
  return state === "lost" ? "stopped" : subagentStatus(STATE_LEDGER[state]);
}

function handleFor(host: HostFacts, record: SubagentRecord): AgentHandle {
  const execution = record.execution;
  if (host.kind === "codex-thread") return { kind: "codex-thread", threadId: execution?.threadId ?? null, coordinatorSessionId: execution?.ownerSessionId ?? host.sessionId ?? "", run: execution?.run ?? 1 };
  // acpHome is the head's (C1 fills it in when it binds resume to the record).
  if (host.kind === "agy-acp") return { kind: "agy-session", sessionId: execution?.threadId ?? null, acpHome: "", run: execution?.run ?? 1 };
  if (host.kind === "claude-process") return { kind: "claude-session", sessionId: execution?.threadId ?? "", configDir: null };
  return { kind: "claude-sidechain", parentSessionId: execution?.ownerSessionId ?? host.sessionId ?? "", toolUseId: record.id, agentId: typeof record.agentID === "string" ? record.agentID : null, configDir: null, checkpoint: null };
}

function summaryFor(record: SubagentRecord, previous: AgentSummary | null, now: number): AgentSummary {
  const stepCount = typeof record.stepCount === "number" ? record.stepCount : record.steps.length;
  const toolCount = typeof record.toolCount === "number" ? record.toolCount : record.steps.filter((step) => step.kind === "tool" || step.kind === "subagent").length;
  return {
    description: clip(record.description, DESCRIPTION_LIMIT),
    prompt: clip(record.prompt, TEXT_LIMIT),
    lastReport: typeof record.result === "string" && record.result ? clip(record.result, TEXT_LIMIT) : previous?.lastReport ?? null,
    stepCount, toolCount,
    lastStepAt: previous && previous.stepCount === stepCount ? previous.lastStepAt : now,
    statusFile: previous?.statusFile ?? null,
    handoffFile: previous?.handoffFile ?? null,
  };
}

const keyOf = (botId: string, engine: AgentEngine, nativeId: string) => `${botId}|${engine}|${nativeId}`;

export class AgentRegistry {
  private records = new Map<string, AgentRecord>();
  /** (host bot, host engine, native id) → id; rebuilt on load. */
  private index = new Map<string, string>();
  private moves: MoveIntent[] = [];
  private listeners: ((record: AgentRecord, previous: AgentRecord | null) => void)[] = [];
  /** It had no agents.json when it was loaded (the first start with the registry). */
  readonly fresh: boolean;

  constructor(private readonly store: AgentStore | null, private readonly clock: () => number = Date.now) {
    const file = store?.load() ?? null;
    this.fresh = file === null;
    for (const record of file?.agents ?? []) this.put(record);
    this.moves = [...(file?.moves ?? [])];
  }

  private put(record: AgentRecord) {
    this.records.set(record.id, record);
    this.index.set(keyOf(record.host.botId, record.host.engine, record.nativeId), record.id);
  }

  private remove(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    const key = keyOf(record.host.botId, record.host.engine, record.nativeId);
    if (this.index.get(key) === id) this.index.delete(key);
  }

  get all(): AgentRecord[] { return [...this.records.values()]; }
  get pendingMoves(): readonly MoveIntent[] { return this.moves; }

  /** Upserts from the host book; returns the record. A state change is saved at once, progress within 250 ms. */
  observe(host: HostFacts, rec: SubagentRecord): AgentRecord {
    const now = this.clock();
    const id = this.index.get(keyOf(host.botId, host.engine, rec.id));
    const previous = id ? this.records.get(id) ?? null : null;
    if (!previous) {
      const made = this.make(host, rec, now);
      this.put(made);
      this.save(true);
      this.changed(made, null);
      return made;
    }
    const before = structuredClone(previous);
    this.fixHostKind(previous, rec);
    const state = stateFor(rec, previous.host.kind);
    const stateChanged = state !== previous.state;
    previous.state = state;
    previous.summary = summaryFor(rec, previous.summary, now);
    previous.model = typeof rec.model === "string" ? rec.model : previous.model;
    const effort = (rec as { runtime?: { reasoningEffort?: unknown } }).runtime?.reasoningEffort;
    if (typeof effort === "string") previous.effort = effort;
    previous.background = rec.background;
    const handle = handleFor(previous.host, rec);
    if (previous.handle.kind === handle.kind) {
      // What the host learns later (a thread id, the next run, claude's agent id) fills in; what it knew stays.
      if (handle.kind === "codex-thread" && previous.handle.kind === "codex-thread") previous.handle = { ...previous.handle, threadId: handle.threadId ?? previous.handle.threadId, run: Math.max(previous.handle.run, handle.run) };
      else if (handle.kind === "agy-session" && previous.handle.kind === "agy-session") previous.handle = { ...previous.handle, sessionId: handle.sessionId ?? previous.handle.sessionId, run: Math.max(previous.handle.run, handle.run) };
      else if (handle.kind === "claude-sidechain" && previous.handle.kind === "claude-sidechain") previous.handle = { ...previous.handle, agentId: handle.agentId ?? previous.handle.agentId };
      else if (handle.kind === "claude-session" && previous.handle.kind === "claude-session") previous.handle = { ...previous.handle, sessionId: handle.sessionId || previous.handle.sessionId };
    }
    previous.endedAt = rec.status === "running" ? null : previous.endedAt ?? now;
    if (JSON.stringify(before) === JSON.stringify(previous)) return previous;
    previous.updatedAt = now;
    previous.rev++;
    this.save(stateChanged);
    this.changed(previous, before);
    return previous;
  }

  /** A Claude worker first recorded as a sidechain (agents.json from before its host kind was told apart): its own process. */
  private fixHostKind(record: AgentRecord, rec: SubagentRecord): boolean {
    const kind = recordHostKind(record.host, rec);
    if (kind === record.host.kind || kind !== "claude-process") return false;
    record.host = { ...record.host, kind };
    record.handle = handleFor(record.host, rec);
    return true;
  }

  private make(host: HostFacts, rec: SubagentRecord, now: number): AgentRecord {
    host = { ...host, kind: recordHostKind(host, rec) };
    const id = agentId(host.botId, host.engine, rec.id);
    if (!ID_PATTERN.test(id)) throw new Error(`agent id ${id} does not fit the contract`);
    const effort = (rec as { runtime?: { reasoningEffort?: unknown } }).runtime?.reasoningEffort;
    return {
      v: 1, id, nativeId: rec.id, engine: agentEngine(rec, host.engine), background: rec.background,
      owner: { botId: host.botId, engine: host.engine, since: now, history: [] },
      host: { botId: host.botId, engine: host.engine, kind: host.kind, sessionId: host.sessionId, folder: host.folder },
      handle: handleFor(host, rec),
      promptHash: null,
      model: typeof rec.model === "string" ? rec.model : null, effort: typeof effort === "string" ? effort : null,
      state: stateFor(rec, host.kind),
      summary: summaryFor(rec, null, now),
      relay: { muted: false, pendingMessages: [], report: null },
      ownerView: { settledAt: null, unsettledAt: null },
      createdAt: now, updatedAt: now, endedAt: rec.status === "running" ? null : now,
      rev: 1,
    };
  }

  byNative(hostBotId: string, engine: AgentEngine, nativeId: string): AgentRecord | undefined {
    const id = this.index.get(keyOf(hostBotId, engine, nativeId));
    return id ? this.records.get(id) : undefined;
  }

  /** By the host bot and native id, whichever of its heads holds it. */
  byHostBot(hostBotId: string, nativeId: string): AgentRecord | undefined {
    for (const engine of ["claude", "codex", "agy"] as const) {
      const found = this.byNative(hostBotId, engine, nativeId);
      if (found) return found;
    }
    return undefined;
  }

  get(id: string): AgentRecord | undefined { return this.records.get(id); }

  /** Agents this bot owns that another bot hosts. */
  movedIn(ownerBotId: string): AgentRecord[] {
    return this.all.filter((record) => record.owner.botId === ownerBotId && record.host.botId !== ownerBotId);
  }

  /** Agents this head hosts that another bot owns: native id → record. */
  movedOut(hostBotId: string, engine: AgentEngine): Map<string, AgentRecord> {
    return new Map(this.all.filter((record) => record.host.botId === hostBotId && record.host.engine === engine && isDetached(record)).map((record) => [record.nativeId, record]));
  }

  /** Native ids the host book must not trim (their rows and steps are another bot's to show). */
  retained(hostBotId: string, engine: AgentEngine): ReadonlySet<string> {
    const pending = new Set(this.moves.map((move) => move.agentId));
    return new Set(this.all.filter((record) => record.host.botId === hostBotId && record.host.engine === engine && (isDetached(record) || pending.has(record.id))).map((record) => record.nativeId));
  }

  /** A move of this agent is under way. */
  moving(agentId: string): boolean {
    return this.moves.some((move) => move.agentId === agentId);
  }

  beginMove(intent: MoveIntent): void {
    if (this.moving(intent.agentId)) throw new Error("A move of this agent is still under way.");
    this.moves.push(structuredClone(intent));
    this.save(true);
  }

  /** The target named after the intent was written (a new sub bot made for it). */
  retarget(moveId: string, to: BotRef): void {
    const move = this.moves.find((candidate) => candidate.id === moveId);
    if (!move) return;
    move.to = { ...move.to, owner: { ...to } };
    this.save(true);
  }

  setPhase(id: string, phase: MoveIntent["phase"]): void {
    const move = this.moves.find((candidate) => candidate.id === id);
    if (!move || move.phase === phase) return;
    move.phase = phase;
    this.save(true);
  }

  /**
   * The owner change and the move's "committed" phase in one write. Its row as the new owner sees it starts unsettled.
   */
  commitMove(moveId: string): AgentRecord {
    const move = this.moves.find((candidate) => candidate.id === moveId);
    if (!move) throw new Error("No such move.");
    const record = this.records.get(move.agentId);
    if (!record) throw new Error("No such agent.");
    const before = structuredClone(record);
    const now = this.clock();
    this.setOwnerOf(record, move.to.owner, moveId, now);
    move.phase = "committed";
    this.save(true);
    this.changed(record, before);
    return record;
  }

  private setOwnerOf(record: AgentRecord, to: BotRef, moveId: string, now: number) {
    record.owner = {
      botId: to.botId, engine: to.engine, since: now,
      history: [...record.owner.history, { botId: record.owner.botId, engine: record.owner.engine, until: now, moveId }].slice(-HISTORY_LIMIT),
    };
    record.ownerView = { settledAt: null, unsettledAt: null };
    record.updatedAt = now;
    record.rev++;
  }

  endMove(id: string): void {
    const before = this.moves.length;
    this.moves = this.moves.filter((candidate) => candidate.id !== id);
    if (this.moves.length !== before) this.save(true);
  }

  /** The owner settles a moved-in row into its "Settled", or brings it back. Null: it owns no such moved-in agent. */
  settle(ownerBotId: string, nativeId: string, settled: boolean): { changed: boolean } | null {
    const record = this.movedIn(ownerBotId).find((candidate) => candidate.nativeId === nativeId);
    if (!record) return null;
    const now = this.clock();
    const was = record.ownerView.settledAt !== null;
    if (was === settled) return { changed: false };
    const before = structuredClone(record);
    record.ownerView = settled ? { settledAt: now, unsettledAt: null } : { settledAt: null, unsettledAt: now };
    record.updatedAt = now;
    record.rev++;
    this.save(true);
    this.changed(record, before);
    return { changed: true };
  }

  /** Its status file (A1.4), or its legacy sub-bot hand-off. */
  setFiles(id: string, files: { statusFile?: string | null; handoffFile?: string | null }): void {
    const record = this.records.get(id);
    if (!record) return;
    const next = { ...record.summary, ...files };
    if (next.statusFile === record.summary.statusFile && next.handoffFile === record.summary.handoffFile) return;
    record.summary = next;
    record.rev++;
    this.save(false);
  }

  /**
   * A run's report reached the app for its owner (A2): its state, last report and an undelivered relay mark, written at once.
   * False: this run's report was already taken (a duplicate).
   */
  reported(id: string, r: { run: number; status: string; text: string }): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.relay.report && record.relay.report.run >= r.run && r.run > 0) return false;
    const before = structuredClone(record);
    const now = this.clock();
    record.summary = { ...record.summary, lastReport: clip(r.text, TEXT_LIMIT) || record.summary.lastReport };
    record.relay = { ...record.relay, report: { run: r.run, delivered: false } };
    if (record.state === "running" || record.state === "reportPending") record.state = r.status === "failed" ? "failed" : r.status === "stopped" || r.status === "killed" ? "stopped" : "idle";
    record.endedAt ??= now;
    record.updatedAt = now; record.rev++;
    this.save(true);
    this.changed(record, before);
    return true;
  }

  /** Its owner's turn with that run's report started: delivered. */
  reportDelivered(id: string, run: number): void {
    const record = this.records.get(id);
    if (!record?.relay.report || record.relay.report.run !== run || record.relay.report.delivered) return;
    record.relay = { ...record.relay, report: { run, delivered: true } };
    record.rev++;
    this.save(true);
  }

  /** Words for it that wait until its run ends (a host that cannot steer a running worker). */
  queueMessage(id: string, message: { text: string; from: string }): void {
    const record = this.records.get(id);
    if (!record) return;
    record.relay = { ...record.relay, pendingMessages: [...record.relay.pendingMessages, { id: newMoveId().replace(/^mv-/, "msg-"), text: clip(message.text, 64_000), at: this.clock(), from: message.from }].slice(-20) };
    record.rev++;
    this.save(true);
  }

  /** The words waiting for it, taken (they are sent now). */
  takeMessages(id: string): { id: string; text: string; at: number; from: string }[] {
    const record = this.records.get(id);
    if (!record?.relay.pendingMessages.length) return [];
    const taken = record.relay.pendingMessages;
    record.relay = { ...record.relay, pendingMessages: [] };
    record.rev++;
    this.save(true);
    return taken;
  }

  /** The sub-bot hand-off made a sub bot that continues this agent's work. */
  succeed(hostBotId: string, nativeId: string, by: { kind: "subBot" | "owner"; botId: string }, handoffFile?: string): void {
    const record = this.byHostBot(hostBotId, nativeId);
    if (!record) return;
    record.succeededBy = { ...by };
    if (handoffFile) record.summary = { ...record.summary, handoffFile };
    record.rev++;
    this.save(true);
  }

  /**
   * A bot was removed (reconcile rules 4 and 5, applied at once): the agents it hosted for a live owner are lost,
   * the ones it owned but did not host go back to their host. Agents it both hosted and owned are dropped.
   */
  botRemoved(botId: string, alive: (id: string) => boolean): { hostLost: AgentRecord[]; ownerReverted: { record: AgentRecord; from: BotRef }[] } {
    const hostLost: AgentRecord[] = [];
    const ownerReverted: { record: AgentRecord; from: BotRef }[] = [];
    const now = this.clock();
    for (const record of this.all) {
      if (record.host.botId === botId) {
        if (record.owner.botId !== botId && alive(record.owner.botId)) {
          if (record.state !== "lost") {
            const before = structuredClone(record);
            record.state = "lost"; record.updatedAt = now; record.rev++;
            hostLost.push(record);
            this.changed(record, before);
          }
        } else this.remove(record.id);
      } else if (record.owner.botId === botId) {
        const before = structuredClone(record);
        const from: BotRef = { botId: record.owner.botId, engine: record.owner.engine };
        this.setOwnerOf(record, { botId: record.host.botId, engine: record.host.engine }, "owner-removed", now);
        ownerReverted.push({ record, from });
        this.changed(record, before);
      }
    }
    if (hostLost.length || ownerReverted.length) this.save(true);
    return { hostLost, ownerReverted };
  }

  /** Every start (A1.3): the registry against the host books. Pure but for the save; the caller sends the notices. */
  reconcile(f: StartupFacts): ReconcileReport {
    const now = f.now ?? this.clock();
    const report: ReconcileReport = { added: [], dropped: [], interrupted: [], resend: [], hostLost: [], ownerReverted: [] };
    // 1. Moves cut short: one never committed is dropped (its owner never changed); a committed one has its notices sent again.
    for (const move of [...this.moves]) {
      if (move.phase === "committed") report.resend.push(structuredClone(move));
      else if (move.phase === "intent" || move.phase === "notified") this.moves = this.moves.filter((candidate) => candidate !== move);
      // "prepared" (A4) is left for its own recovery.
    }
    const hosts = new Map(f.hosts.map((host) => [`${host.botId}|${host.engine}`, host]));
    // 2. In a host book, not in the registry: added, owned by its host.
    for (const host of f.hosts) {
      for (const rec of host.list) {
        if (rec.parentID || this.byNative(host.botId, host.engine, rec.id)) continue;
        const made = this.make(host, rec, now);
        this.put(made);
        report.added.push(made.id);
      }
    }
    for (const record of this.all) {
      const before = structuredClone(record);
      const hostAlive = f.bots.has(record.host.botId);
      const ownerAlive = f.bots.has(record.owner.botId);
      // 4. Its host bot is gone.
      if (!hostAlive) {
        if (record.owner.botId === record.host.botId || !ownerAlive) { this.remove(record.id); report.dropped.push(record.id); continue; }
        if (record.state !== "lost") { record.state = "lost"; record.updatedAt = now; record.rev++; report.hostLost.push(record); }
        continue;
      }
      // 5. Its owner bot is gone: back to its host.
      if (!ownerAlive) {
        const from: BotRef = { botId: record.owner.botId, engine: record.owner.engine };
        this.setOwnerOf(record, { botId: record.host.botId, engine: record.host.engine }, "owner-removed", now);
        report.ownerReverted.push({ record, from });
      }
      const host = hosts.get(`${record.host.botId}|${record.host.engine}`);
      const native = host?.list.find((candidate) => candidate.id === record.nativeId);
      if (native) this.fixHostKind(record, native);
      // 3. The host book no longer has it.
      if (!native) {
        if (!isDetached(record)) { this.remove(record.id); report.dropped.push(record.id); continue; }
        if (!TERMINAL_STATES.has(record.state) && record.state !== "lost") { record.state = "lost"; record.updatedAt = now; record.rev++; }
      } else if (record.state === "running" && !host!.running && record.host.kind !== "agy-acp") {
        // 6. It was at work when its host process went away (Antigravity's workers restore themselves).
        record.state = "interrupted"; record.updatedAt = now; record.rev++;
        report.interrupted.push(record.id);
      } else if (record.state !== "interrupted" && record.state !== "lost" && !(record.state === "running" && record.host.kind === "agy-acp")) {
        // Its summary as the book has it now (the state too, unless it was set apart above).
        record.summary = summaryFor(native, record.summary, now);
        const state = stateFor(native, record.host.kind);
        if (state !== record.state) { record.state = state; record.updatedAt = now; record.rev++; }
      }
      if (JSON.stringify(before) !== JSON.stringify(record)) this.changed(record, before);
    }
    this.prune(now);
    this.save(true);
    return report;
  }

  /** Retention (A1.1): terminal records owned elsewhere go 7 days after they were settled; at most 2 000, oldest terminal first. */
  private prune(now: number) {
    for (const record of this.all) {
      if (!isDetached(record) || !TERMINAL_STATES.has(record.state)) continue;
      const settled = record.ownerView.settledAt ?? record.endedAt;
      if (settled !== null && now - settled > SETTLED_KEEP_MS) this.remove(record.id);
    }
    if (this.records.size <= AGENTS_CAP) return;
    const pending = new Set(this.moves.map((move) => move.agentId));
    const terminal = this.all.filter((record) => (TERMINAL_STATES.has(record.state) || record.state === "lost") && !pending.has(record.id))
      .sort((a, b) => (a.endedAt ?? a.updatedAt) - (b.endedAt ?? b.updatedAt));
    for (const record of terminal) {
      if (this.records.size <= AGENTS_CAP) break;
      this.remove(record.id);
    }
  }

  /** Adds records read from the native files at the first start (A1.2); returns how many were new. */
  adopt(records: AgentRecord[]): number {
    let added = 0;
    for (const record of records) {
      if (this.byNative(record.host.botId, record.host.engine, record.nativeId)) continue;
      this.put(record);
      added++;
    }
    if (added) this.save(true);
    return added;
  }

  onChange(fn: (record: AgentRecord, previous: AgentRecord | null) => void): void {
    this.listeners.push(fn);
  }

  private changed(record: AgentRecord, previous: AgentRecord | null) {
    for (const listener of this.listeners) { try { listener(record, previous); } catch { /* a listener never stops the registry */ } }
  }

  /** Writes now (`sync`) or within 250 ms. */
  save(sync: boolean): void {
    if (this.records.size > AGENTS_CAP) this.prune(this.clock());
    if (!this.store) return;
    const file = (): AgentsFile => ({ format: AGENTS_FORMAT, agents: this.all, moves: this.moves });
    if (sync) this.store.save(file());
    else this.store.saveSoon(file);
  }

  flush(): void { this.store?.flush(); }
}

/** What a host or owner `Bot` asks of the registry (implemented by the Server, one per profile; a partner head shares its primary's). */
export interface AgentPort {
  observed(host: HostFacts, rec: SubagentRecord): void;
  ended(host: HostFacts, rec: SubagentRecord): void;
  retained(engine: AgentEngine): ReadonlySet<string>;
  movedOut(engine: AgentEngine): ReadonlyMap<string, { agentId: string; owner: BotRef; ownerName: string; muted: boolean }>;
  movedInRows(): import("../contract").SubagentRowView[];
  settle(ownerBotId: string, nativeId: string, settled: boolean): { changed: boolean } | null;
  /** The registry's part of one of this bot's own rows (its agent id and, with agentMoves on, whether it can move). */
  rowInfo?(engine: AgentEngine, nativeId: string): { agentId?: string; movable?: { ok: boolean; reason: string | null } };
  /** A run report of a worker another bot owns (its host's `workerReport`): the app routes it to the owner. */
  report?(host: HostFacts, r: { nativeId: string; run: number; status: string; text: string }): void;
  /**
   * A worker another bot owns asks for an approval: the card goes to the owner's chat, and the pick back to `head` (the host's).
   * False: nobody else owns it (the host asks itself).
   */
  approval?(host: HostFacts, nativeId: string, item: WorkerApproval, head: ApprovalAnswerer): boolean;
  /** That approval is no longer needed (the worker's run ended or it withdrew the request). */
  approvalCancelled?(host: HostFacts, requestId: string): void;
  hostSessionEnded?(host: HostFacts, oldSessionId: string): void;                                    // A3/C1
}

/** A worker's approval request as the host's head sent it (a `permission` stream item). */
export interface WorkerApproval { requestId: string; tool: string; summary: string; input: Record<string, unknown>; workerId?: string }
/** Who answers it: the host's head (or its Claude workers). */
export interface ApprovalAnswerer { readonly running: boolean; answer(requestId: string, allow: boolean, input: Record<string, unknown>, message?: string): void }
