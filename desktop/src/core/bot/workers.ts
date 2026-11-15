// BotWorkers (M7-S49): app-managed workers, worker ledger projection, call-in work routes, and subagent item bookkeeping.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SubagentRowView, Event } from "../../contract";
import { ClaudeHead } from "../agent/head";
import type { CodexItem } from "../agent/codex";
import type { StreamItem } from "../agent/stream";
import { isWorkerHost, isWorkerType, type WorkerHost, type WorkerOwner, type WorkerOwnerResult, type WorkerSendResult } from "../agent/workers";
import { ClaudeWorkers, DEFAULT_CLAUDE_WORKER_LIMIT, claudeWorkersFile } from "../agent/claude-workers";
import { hostKind, type ApprovalAnswerer, type HostFacts, type StartupHost } from "../agent-registry";
import type { BackgroundKind } from "../background-tasks";
import type { Bot, Status } from "../bot";
import { COMPONENT_USAGE_TOOL, FETCH_TOOL, parseFetchRequest, type BotToolName, type ToolCaller } from "../bot-tools";
import { isBrowserTool } from "../../browser-bot";
import { runBrowserTool } from "../browser-tools";
import { CallInWorkBook, type CallInRelay } from "../call-in-work";
import { BUILT_INS } from "../components/library";
import type { ComponentsContext } from "../components/service";
import type { Engine } from "../heads";
import { connectionErrorLine, isConnectionError } from "../network-resume";
import { isNoteTool, runNoteTool } from "../note-tools";
import type { BotPrompts } from "../prompts";
import type { RestartEntry } from "../restart-continuation";
import { DEFAULT_SPEC_WRITERS } from "../spec-guard";
import type { BotStore } from "../store/bot-store";
import { newId, toSwiftDate, type ChatRecord, type StepRecord } from "../store/records";
import type { SubagentHistory } from "../store/subagent-store";
import type { SubagentBook, SubagentRecord } from "../subagents";
import type { RequestEvent } from "../token-speed";
import { totalTokens } from "../usage";
import { WorkerCore, WorkerLedger, workerNoteLine, type WorkerCoreFactory, type WorkerLedgerRecord, type WorkerNote } from "../worker-core";
import { projectWorker } from "../worker-projection";
import { BotContext } from "./context";
import { NO_LONGER_NEEDED, type AgentHead, type BotOptions, type SessionStart, type Turn } from "./types";
import { subagentView } from "./view-functions";

export class BotWorkers {
  constructor(private readonly host: Bot, private readonly ctx: BotContext = new BotContext(host)) {}

  // ---- Bridge: shared names forwarded to `BotContext` (one line each) ----
  private get options(): BotOptions { return this.ctx.options; }
  private get store(): BotStore { return this.ctx.store; }
  private get engine(): Engine { return this.ctx.engine; }
  private get subagents(): SubagentBook { return this.ctx.subagents; }
  private get owner(): Bot { return this.ctx.owner; }
  private get members(): Bot[] { return this.ctx.members; }
  private get id() { return this.ctx.id; }
  private get profile() { return this.ctx.profile; }
  private log(line: string) { this.ctx.log(line); }
  private emit(event: Event) { this.host.emit(event); }

  // ---- Bridge: Bot-owned fields and methods forwarded to `host` (one line each) ----
  private get records() { return this.host.records; }
  private get headsSettings() { return this.host.headsSettings; }
  private get problem() { return this.host.problem; }
  private get head() { return this.host.head; }
  private get outage() { return this.host.outage; }
  private get tidying() { return this.host.tidying; }
  private get turn() { return this.host.turn; }
  private get queue() { return this.host.queue; }
  private get approvals() { return this.host.approvals; }
  private get session() { return this.host.session; }
  private get shuttingDown() { return this.host.shuttingDown; }
  private get turns() { return this.host.turns; }
  private get swapHold() { return this.host.swapHold; }
  private get dirtySubagents() { return this.host.dirtySubagents; }
  private get speaker() { return this.host.speaker; }
  private get commandFolder() { return this.host.commandFolder; }
  private get context(): ComponentsContext | null { return this.host.context; }
  private get inHeadSubagents() { return this.host.inHeadSubagents; }
  private get backgroundWorkRunning() { return this.host.backgroundWorkRunning; }
  private persist(soon = false) { this.host.persist(soon); }
  private messageView(record: ChatRecord) { return this.host.messageView(record); }
  private changed(record: ChatRecord) { this.host.changed(record); }
  private updated() { this.host.updated(); }
  private rowsChanged(force = false) { this.host.rowsChanged(force); }
  private saveSubagents(progress = false, changed?: SubagentRecord) { this.host.saveSubagents(progress, changed); }
  private subagentHistory(subagent: SubagentRecord): SubagentHistory { return this.host.subagentHistory(subagent); }
  private routeWorkerApproval(head: ApprovalAnswerer, item: Extract<StreamItem, { kind: "permission" }>) { return this.host.routeWorkerApproval(head, item); }
  private prompts(): BotPrompts { return this.host.prompts(); }
  private sessionStart(resume: boolean, prompts: BotPrompts): SessionStart { return this.host.sessionStart(resume, prompts); }
  private emitSteps(turn: Turn) { this.host.emitSteps(turn); }
  private recordOutage(arg: { turnFailed?: boolean; subagents?: string[]; lostSession?: string | null }) { this.host.recordOutage(arg); }
  private addBackgroundTask(id: string, kind: BackgroundKind, title: string) { this.host.addBackgroundTask(id, kind, title); }
  private endSubagentTasks(ownerId: string) { this.host.endSubagentTasks(ownerId); }
  private endBackground(id: string, status: string, summary: string | null) { this.host.endBackground(id, status, summary); }
  private checkSettingsHold() { this.host.checkSettingsHold(); }
  private noteProgressOf(item: CodexItem) { this.host.noteProgressOf(item); }
  private noteRequest(event: RequestEvent) { this.host.noteRequest(event); }
  private scheduleIdle() { this.host.scheduleIdle(); }
  private ownComponents() { return this.host.ownComponents(); }
  private ask(head: AgentHead, item: Extract<StreamItem, { kind: "permission" }>, turn: Turn | null) { this.host.ask(head, item, turn); }
  private noteToolCall(item: Extract<StreamItem, { kind: "toolUse" }>) { this.host.noteToolCall(item); }
  private showDenial(denial: Extract<StreamItem, { kind: "permissionDenied" }>) { this.host.showDenial(denial); }
  private settle(id: string, answer: string, deny: boolean) { this.host.settle(id, answer, deny); }

  // ---- Moved from `Bot` ----
  /**
   * Worker return routes (1.x's `managedTaskHandoffs`, `managedHandbackIDs`): a Codex worker started for
   * handed-over work owns that hand-off; the coordinator's turn that only accepted it does not hand back,
   * the worker's report turn does.
   */
  managedTaskHandoffs = new Map<string, string>();
  managedHandbacks = new Set<string>();
  /** Codex: workers at work or their reports waiting (the bot stays awake). */
  managedPending = false;
  /** Subagents whose last line was claude's connection error (1.x's `cutOffByNetwork`). */
  cutOffByNetwork = new Set<string>();

  /** Each head's session, this one first (null: none started yet), for plugins' `workspace.current`. */
  headSessions(): { engine: Engine; sessionId: string | null }[] {
    return this.members.map((bot) => ({ engine: bot.engine, sessionId: bot.session.started ? bot.session.sessionId : null }));
  }

  /** Where this head's subagents live, for the agent registry. */
  hostFacts(): HostFacts {
    return { botId: this.owner.profile.id, engine: this.engine, sessionId: this.session.sessionId, folder: this.commandFolder, kind: hostKind(this.engine) };
  }

  /** What the registry (and C1) reads of one of its subagents, whichever head holds it. */
  agentFacts(nativeId: string): { status: SubagentRecord["status"]; steps: StepRecord[]; result: string; execution: SubagentRecord["execution"] | null; agentID: string | null; background: boolean } | null {
    for (const bot of this.members) {
      const found = bot.subagents.get(nativeId);
      if (!found) continue;
      const steps = found.steps.length ? found.steps : bot.subagentHistory(found).steps;
      return { status: found.status, steps: [...steps], result: found.result ?? "", execution: found.execution ?? null, agentID: typeof found.agentID === "string" ? found.agentID : null, background: found.background };
    }
    return null;
  }

  /** Its heads' subagent lists as they are now, for the registry's reconcile at start. */
  hostBooks(): StartupHost[] {
    return this.members.map((bot) => ({ ...bot.hostFacts(), running: bot.head?.running ?? false, list: bot.subagents.list, workers: bot.workerViews }));
  }

  /** One of its own rows by native id (for the owner's list when another bot owns it), with the head that holds it. */
  subagentRowFor(nativeId: string): SubagentRowView | null {
    for (const bot of this.members) {
      if (!bot.subagents.get(nativeId)) continue;
      return bot.subagents.rows(bot.engine).find((row) => row.id === nativeId) ?? null;
    }
    return null;
  }

  /**
   * A subagent by the id or name its engine reaches it by (Claude's `SendMessage` `to`, a Codex or Antigravity
   * worker's task id), or its call's id, for the sub-bot hand-off: where it is, which head holds it, which engine
   * it runs on, what it was asked and the steps it has taken (read from its file).
   */
  findSubagent(key: string): { id: string; status: SubagentRecord["status"]; head: Engine; engine: Engine; description: string; prompt: string; result: string; steps: StepRecord[]; threadId: string | null; run: number | null } | null {
    for (const bot of this.members) {
      const found = bot.subagents.find(key);
      if (!found) continue;
      const steps = found.steps.length ? found.steps : bot.subagentHistory(found).steps;
      const runtime = (found as { runtime?: { engine?: unknown } }).runtime?.engine;
      const engine: Engine = runtime === "codex" || runtime === "agy" || runtime === "claude" ? runtime : bot.engine;
      return {
        id: found.id, status: found.status, head: bot.engine, engine, description: found.description, prompt: found.prompt, result: found.result ?? "", steps: [...steps],
        threadId: found.execution?.threadId ?? null, run: found.execution?.run ?? null,
      };
    }
    return null;
  }

  /** The engines this bot may run a sub bot on (its heads). */
  get headEngines(): Engine[] { return [...this.headsSettings.engines]; }

  /**
   * How the hand-off reaches a subagent: `ask` (claude: the project bot's own SendMessage, so the app only waits),
   * `steer` (a Codex worker: the app joins a wrap-up request into its turn), or `stop` (an Antigravity worker
   * takes no message while it works: it is stopped at once).
   */
  handoffMode(subagentId: string): "ask" | "steer" | "stop" {
    const holder = this.members.find((bot) => bot.subagents.find(subagentId));
    const host = holder?.workerHostFor(subagentId);
    if (host) return host.steersRunning ? "steer" : "stop";
    return "ask";
  }

  /** Sends a worker at work the wrap-up request (false: not sent: it is not at work, not a worker, or its engine cannot be steered). */
  askForHandoff(subagentId: string, text: string): boolean {
    const holder = this.members.find((bot) => bot.subagents.find(subagentId));
    const found = holder?.subagents.find(subagentId);
    const host = found ? holder?.workerHostFor(found.id) : null;
    if (!host?.steersRunning || !found) return false;
    if (host.listWorkers().find((worker) => worker.id === found.id)?.state !== "running") return false;
    const sent = host.sendToWorker(found.id, text);
    return !(sent instanceof Promise) && sent.ok && sent.how === "steered";
  }

  /**
   * The hand-off's last resort. Claude: the turn running now is stopped whole (claude has no stop for one subagent).
   * An app-managed worker (any engine) is stopped alone (no report is made). Either way the
   * subagent, if it still shows as running, is marked stopped. It then goes on in a sub bot from its handoff file.
   */
  async stopForHandoff(subagentId: string): Promise<void> {
    const holder = this.members.find((bot) => bot.subagents.find(subagentId));
    const found = holder?.subagents.find(subagentId);
    const host = found ? holder?.workerHostFor(found.id) : null;
    if (holder && found && host) await host.stopWorker(found.id).catch((error) => this.log(`sub-bot hand-off: stopping worker ${found.id}: ${(error as Error).message}`));
    else {
      const owner = this.owner;
      const turn = owner.turn;
      if (turn && turn.origin !== "tidy") await owner.stop(turn.id);
    }
    for (const bot of this.members) {
      if (bot.subagents.stopOne(subagentId)) { bot.saveSubagents(false, bot.subagents.get(subagentId)); this.rowsChanged(true); }
    }
  }

  /** Claude's app-managed workers (claude-workers.ts), made when first needed; they belong to this bot, not to its head process. */
  claudeWorkerHost: ClaudeWorkers | null = null;
  /** Answers worker approval cards through this member's worker host (the bot's approvals keep the head that asked; a worker's is its manager). */
  private readonly workerApprovals = { running: true, answer: (requestId: string, allow: boolean, input: Record<string, unknown>, message?: string) => { this.workerHost?.answer(requestId, allow, input, message); } } as unknown as AgentHead;

  /** <member store>/worker-ledger.json: the one record of this member's app-managed workers (shared-core spec 3.2). */
  get workerLedgerFile() { return join(this.store.directory, "worker-ledger.json"); }
  /** What each of its workers' ledger records last said (the registry's and the rows' state come from it). */
  workerViews = new Map<string, WorkerLedgerRecord>();

  /**
   * This member's worker core, as its facade makes it (ClaudeWorkers, its Codex or Antigravity head): the member's
   * ledger (the old journals imported once, then never written), every transition projected, and a restart told from
   * a quit. One live core per member: a head's core goes with its head.
   */
  readonly workerCore: WorkerCoreFactory = (options, legacy) => {
    const core = new WorkerCore({
      ...options, store: new WorkerLedger(this.workerLedgerFile, legacy),
      projected: (record) => this.projectWorker(record),
      note: (note, text) => this.host.workerNote(note, text),
      closeReason: () => (this.swapHold ? "restart" : "quit"),
      log: (line) => this.log(line),
    });
    // Once the facade that asked for it is made (it may be made while this bot is).
    queueMicrotask(() => core.projectAll());
    return core;
  };

  /** Whether this bot's Claude subagents are app-managed workers (the default) or native Agent calls (settings.json `claudeWorkers: "native"`). */
  claudeWorkersOn(): boolean {
    return this.options.launch?.().claudeWorkers !== "native";
  }

  ensureClaudeWorkers(): ClaudeWorkers {
    if (this.claudeWorkerHost) return this.claudeWorkerHost;
    this.claudeWorkerHost = new ClaudeWorkers({
      file: claudeWorkersFile(this.store.directory),
      core: this.workerCore,
      ownerSessionId: () => this.session.sessionId,
      base: () => {
        try {
          const base = this.options.headConfig(this.profile, this.sessionStart(false, this.prompts()));
          const tree = this.owner.options.worktree?.() ?? null;
          return tree ? { ...base, cwd: tree.cwd, addDirs: [...new Set([...(base.addDirs ?? []), ...tree.addDirs])] } : base;
        } catch (error) { this.log(`claude workers: no head config: ${(error as Error).message}`); return null; }
      },
      cwd: () => this.owner.options.worktree?.()?.cwd ?? this.commandFolder,
      subagentModel: () => this.owner.choices().subagentModel,
      subagentEffort: () => this.owner.choices().subagentEffort,
      defaultMachine: () => this.owner.choices().workerMachine,
      pluginDirs: () => this.options.plugins?.().dirs ?? [],
      processStarted: (pid) => this.options.ledger.record(pid),
      maxRunning: () => this.options.launch?.().claudeWorkerLimit ?? DEFAULT_CLAUDE_WORKER_LIMIT,
      specWriters: () => this.options.launch?.().specWriters ?? DEFAULT_SPEC_WRITERS,
      siteToolsFolder: () => this.options.siteToolsFolder,
      browser: (name, args, caller) => this.botTool(name, args, caller),
      remote: () => this.options.remoteWorkers?.() ?? null,
    }, (item) => this.onWorkerOutput(item), (id, text) => this.workerReport(text, id), (config, handlers) => new ClaudeHead(config, handlers));
    this.syncWorkerOwners();
    return this.claudeWorkerHost;
  }

  /**
   * A bot tool call from this bot's head or one of its workers (core/bot-tools.ts): the browser tools read the user's
   * pane beside this bot's chat (saved data goes to the bot's own `.bot/browser/`); the Note tools read this project's
   * Notes and change this bot's own (a worker only reads).
   */
  async botTool(name: BotToolName, args: Record<string, unknown>, caller: ToolCaller = "coordinator"): Promise<unknown> {
    if (isNoteTool(name)) return runNoteTool(name, args, { botId: this.owner.profile.id, caller });
    if (name === COMPONENT_USAGE_TOOL) return this.componentUsage(args, caller);
    if (name === FETCH_TOOL) return this.fetchTool(args, caller);
    if (!isBrowserTool(name)) throw new Error(`Unknown app tool ${name}.`);
    return runBrowserTool(name, args, { botId: this.owner.profile.id, folder: this.owner.profile.folder });
  }

  /** app_fetch: files from another machine into this bot's `.bot/incoming/` (the server's `fetch` option does it; 2.x has none). */
  async fetchTool(args: Record<string, unknown>, caller: ToolCaller): Promise<string> {
    if (caller !== "coordinator") throw new Error("Only the bot itself fetches from another machine.");
    const fetch = this.options.fetch;
    if (!fetch) return "Fetching from another machine needs Botling 3.";
    return fetch(this.owner.profile.id, parseFetchRequest(args));
  }

  /** app_component_usage: one component's whole usage (its about.md), for the coordinator that is about to use it. */
  componentUsage(args: Record<string, unknown>, caller: ToolCaller): Record<string, unknown> {
    if (caller !== "coordinator") throw new Error("Only the bot itself reads component usage; a worker does not show components.");
    const library = this.context?.library;
    if (!library) throw new Error("The component library is not available here.");
    const wanted = typeof args.name === "string" ? args.name.trim() : "";
    const name = library.names.find((each) => each === wanted) ?? library.names.find((each) => each.toLowerCase() === wanted.toLowerCase());
    if (!name) throw new Error(`No component named "${wanted}". The library has: ${library.names.join(", ")}.`);
    const yours = this.ownComponents().includes(name) || BUILT_INS.includes(name);
    return {
      name, yours, command: library.command(name), usage: library.catalog([name]),
      ...(yours ? {} : { note: `Not on your list yet: ask Maintainer with <component name="${name}">add it to my list</component> before you show it.` }),
    };
  }

  /** A Claude worker's run ended: its report goes to this head as the app's message (waking it, or queued behind its turn). */
  workerReport(text: string, workerId?: string): boolean {
    if (this.shuttingDown || this.problem || this.profile.problem) return false;
    try { this.relayIfCallInWork((this.options.primary ?? this.host).deliverTo(this.engine, text, null, { origin: "app" }), workerId, "report"); return true; }
    catch (error) { this.log(`claude worker report not delivered: ${(error as Error).message}`); return false; }
  }

  /** Workers started in a call-in turn, by worker id (`CallInWork`): kept in the owner's settings, so a restart keeps them. */
  get callInWork(): CallInWorkBook {
    const bot = this.owner;
    bot.callInWorkBook ??= new CallInWorkBook({ load: () => bot.store.loadSettings().callInWork, save: (work) => bot.store.saveSetting("callInWork", work) });
    return bot.callInWorkBook;
  }
  callInWorkBook: CallInWorkBook | null = null;

  /** A worker just started: in a call-in turn (a bot's @ or the user's), its news is to go back to that chat. */
  linkCallInWork(workerId: string) {
    const turn = this.turn ?? this.owner.turn;
    if (!turn?.open || !turn.callIn || !turn.callInAsked) return;
    this.callInWork.link(workerId, turn.callIn, turn.callInAsked, turn.callInBy);
  }

  /** `turn` takes a worker's report or note: if that worker was started for a bot's @, its reply goes back there too. */
  relayIfCallInWork(turn: Turn, workerId: string | null | undefined, news: CallInRelay["news"]) {
    const relay = this.callInWork.relay(workerId, news);
    if (relay && turn.open && turn.origin !== "tidy") turn.relayTo = relay;
  }

  /** `turn` ended (`record`: its line, null when it showed nothing): a worker's news it was on goes back to the asking bot. */
  relayFollowUp(turn: Turn, status: Status, record: ChatRecord | null, error?: string) {
    const relay = turn.relayTo;
    if (!relay) return;
    const told = this.callInWork.followUp(relay, { status: status === "done" ? "done" : status === "stopped" ? "stopped" : "failed", visible: !!record, error: error ?? null });
    if (told?.kind === "reply" && record) this.owner.options.callInFollowUp?.(relay.caller, relay.asked, record, relay.by);
    else if (told?.kind === "noReply") this.owner.options.callInFollowUpMissed?.(relay.caller, relay.asked, told.why, relay.by);
  }

  /**
   * A note from one of this member's workers at work (app_notify_owner): a relay line in the chat (not the user's),
   * and this head woken with the <app_worker_note> message, or the note queued behind its turn. The run goes on.
   * Also the owner's side of a note from a worker another bot runs (the registry routes it here, `text` its words).
   */
  workerNote(note: Pick<WorkerNote, "kind" | "name" | "message" | "files"> & { id?: string }, text: string): boolean {
    const bot = this.options.primary ?? this.host;
    if (this.shuttingDown || this.problem || this.profile.problem || bot.shuttingDown) return false;
    try {
      bot.add({ id: newId(), role: "relay", text: workerNoteLine(note), date: toSwiftDate() });
      this.relayIfCallInWork(bot.deliverTo(this.engine, text, null, { origin: "app" }), note.id, "note");
      return true;
    } catch (error) { this.log(`worker note not delivered: ${(error as Error).message}`); return false; }
  }

  /**
   * The one entry for every app-managed worker's items, whatever engine runs it (shared-core spec S4b). Workers are
   * not the head's: their items come whether or not the head is awake (never dropped as an old head's), and only
   * their own bookkeeping happens here (the book, the step that started one, approvals, usage, speed),
   * never the coordinator's turn. Their state is the ledger's (`projectWorker`).
   */
  onWorkerOutput(item: CodexItem) {
    if (this.shuttingDown && item.kind !== "subagentEnded" && item.kind !== "permissionCancelled") return;
    switch (item.kind) {
      // Each usage's own spend (the core's), never a running total.
      case "usage": if (item.totalCost > 0 || totalTokens(item.tokens) > 0) this.options.usage?.(this.owner.profile.name, item.totalCost, item.tokens); return;
      case "request": this.noteRequest(item.request); return;
      case "rateLimits": this.options.rateLimits?.(item.engine, item.limits); return;
      case "connectionLost": if (item.parent) this.cutOffByNetwork.add(item.parent); return;
      case "permissionDenied": this.showDenial(item); return;
      case "workerReport": this.workerReported(item); return;
      case "workerNote": this.workerNoted(item); return;
      case "managedPending": this.onItemPending(item.pending); return;
      case "permission":
        if (this.routeWorkerApproval(this.workerApprovals, item)) return;
        return this.ask(this.workerApprovals, item, null);
      case "permissionCancelled":
        for (const [id, approval] of this.approvals) if (approval.head === this.workerApprovals && approval.requestId === item.requestId) this.settle(id, NO_LONGER_NEEDED, false);
        this.options.agents?.approvalCancelled?.(this.hostFacts(), item.requestId);
        return;
    }
    this.noteProgressOf(item);
    if (item.kind === "toolUse") this.noteToolCall(item);
    const handled = this.onSubagentItem(item);
    // A run whose end reached the ledger before its opening items did (Codex hands them over after the call that ended
    // it, e.g. a start that failed at once): its end shows now, over the opening's "running".
    const opened = item.kind === "subagentStarted" ? this.workerViews.get(item.id) : undefined;
    if (opened && opened.status !== "running") this.projectWorker(opened);
    if (handled) return;
    // The step in the coordinator's turn that started it.
    const turn = this.turn;
    if (item.kind === "toolUse" && item.parent === null && turn?.open && turn.origin !== "tidy") {
      turn.steps.push({ id: item.id, kind: "subagent", tool: item.tool, title: item.title, detail: item.detail, failed: false, done: false });
      this.emitSteps(turn);
    }
  }

  /**
   * The turn a worker is handed off in, as its job: workers handed off in one turn are listed as one job unless their
   * bot named one (app_handoff's `group`). Titled by the user's words (else the turn's), first 20 characters.
   */
  jobOfTurn(): { turnId: string; title: string } | undefined {
    const turn = this.turn ?? (this.options.primary as Bot | undefined)?.turn;
    if (!turn) return undefined;
    const said = turn.userId ? this.owner.records.find((record) => record.id === turn.userId)?.text : undefined;
    const words = (typeof said === "string" && said.trim() ? said : turn.words).replace(/\s+/g, " ").trim();
    return { turnId: turn.id, title: [...words].length > 20 ? `${[...words].slice(0, 20).join("")}…` : words };
  }

  /** Whether a Codex or Antigravity head keeps work it must stay awake for (its workers, a report turn to come). */
  onItemPending(pending: boolean) {
    this.managedPending = pending;
    if (!pending && !this.turn && !this.queue.length) this.scheduleIdle();
    if (!pending) this.checkSettingsHold();
  }

  /**
   * One of its workers' ledger records changed (WorkerCore `projected`): its row (subagents.json), its chip, its
   * registry entry and the step that started it follow, through status.ts and nothing else. The end of a run is told
   * once, here (`subagentEnded`): the step is done, a silent turn reports it, its cards stop being at work.
   */
  projectWorker(record: WorkerLedgerRecord, atStart = false) {
    this.workerViews.set(record.id, record);
    // A chip still in the turn under way (not yet in a reply) is the newest.
    const pending = this.turn?.tasks?.some((task) => task.id === record.id) ? { backgroundTasks: this.turn.tasks } as unknown as ChatRecord : null;
    const projected = projectWorker(this.subagents, pending ? [...this.records, pending] : this.records, record);
    if (projected.chip && projected.chip !== pending) this.changed(projected.chip);
    const row = projected.row;
    if (!row || atStart || (!projected.rowChanged && !this.options.agents)) return;
    if (projected.ended) this.subagentEnded(record.id);
    else if (projected.rowChanged) this.markWorkerStep(record.id, projected.stepFailed);
    // A row that did not change (every old worker, re-projected when its head starts) is told to the registry, but
    // the line that sent it is not drawn again: nothing on it changed.
    this.subagentChanged(row, false, projected.rowChanged || projected.ended);
  }

  /** The step that started a worker shows how its latest run ended (a report left unresolved later fails it too). */
  markWorkerStep(id: string, failed: boolean) {
    const mark = (steps: StepRecord[] | undefined) => {
      const step = steps?.findLast((candidate) => candidate.id === id);
      if (!step || step.failed === failed) return !!step;
      step.failed = failed;
      return true;
    };
    if (mark(this.turn?.steps)) { if (this.turn) this.emitSteps(this.turn); return; }
    for (let i = this.records.length - 1; i >= Math.max(0, this.records.length - 80); i--) {
      if (mark(this.records[i]!.steps)) { this.persist(true); return; }
    }
  }

  /**
   * At start: what its ledger says of its workers, before any core is up (a Codex or Antigravity core comes with its
   * head). One it still lists at work was cut off when the app went away: it shows as interrupted.
   */
  projectLedgerAtStart() {
    let records: WorkerLedgerRecord[];
    try { records = existsSync(this.workerLedgerFile) ? new WorkerLedger(this.workerLedgerFile).load() : []; }
    catch (error) { this.log(`worker ledger: ${(error as Error).message}`); return; }
    for (const record of records) {
      this.projectWorker(record.status === "running" ? { ...record, status: "interrupted", interruptedBy: "crash", report: { ...record.report, status: "interrupted", state: "none" } } : record, true);
    }
    if (records.length) { this.saveSubagents(); this.persist(true); }
  }

  /** This head's app-managed workers, whatever the engine (workers.ts): its Codex or Antigravity head, or its Claude workers. */
  get workerHost(): WorkerHost | null {
    if (this.engine === "claude") return this.claudeWorkerHost;
    const head = this.head as (AgentHead & { workerHost?: unknown }) | null;
    if (isWorkerHost(head?.workerHost)) return head.workerHost;
    return isWorkerHost(head) ? head : null;
  }

  /** The worker host holding this subagent of its own, when it is an app-managed worker (`load`: Claude's workers are read from their journal if they are not yet). */
  workerHostFor(nativeId: string, load = false): WorkerHost | null {
    const record = this.subagents.get(nativeId);
    if (!record || !isWorkerType(record.type)) return null;
    if (load && this.engine === "claude" && !this.claudeWorkerHost && this.claudeWorkersOn() && !this.shuttingDown) this.ensureClaudeWorkers();
    const host = this.workerHost;
    return host?.listWorkers().some((worker) => worker.id === record.id) ? host : null;
  }

  /** Its worker host told who owns each of its workers, as the registry has it (a move made while the host was not up). */
  syncWorkerOwners() {
    const host = this.workerHost;
    const port = this.options.agents;
    if (!host || !port) return;
    const moved = port.movedOut(this.engine);
    for (const worker of host.listWorkers()) {
      const entry = moved.get(worker.id);
      const wanted: WorkerOwner | null = entry ? { botId: entry.owner.botId, name: entry.ownerName, agentId: entry.agentId } : null;
      if ((worker.owner?.botId ?? null) === (wanted?.botId ?? null)) continue;
      const set = host.setWorkerOwner(worker.id, wanted);
      if (!set.ok) this.log(`worker ${worker.id}: owner not set yet (${set.reason})`);
    }
  }

  /**
   * Gives one of its workers to another bot (or back: null), through its worker host. Null: it is no worker of a host that is up
   * now; its host is told when it starts (`syncWorkerOwners`).
   */
  setWorkerOwner(nativeId: string, owner: WorkerOwner | null): WorkerOwnerResult | null {
    for (const bot of this.members) {
      if (!bot.subagents.get(nativeId)) continue;
      return bot.workerHostFor(nativeId, true)?.setWorkerOwner(nativeId, owner) ?? null;
    }
    return null;
  }

  /**
   * The owner's follow-up or stop for one of the workers this bot hosts (any engine, through its WorkerHost). A follow-up to a
   * worker whose Codex or Antigravity head is asleep wakes that head first (the worker lives in it).
   */
  async commandWorker(nativeId: string, action: { kind: "message"; text: string } | { kind: "stop" }): Promise<WorkerSendResult | { ok: true; how: "stopped" }> {
    const holder = this.members.find((bot) => bot.subagents.get(nativeId));
    if (!holder) return { ok: false, reason: "No such agent here." };
    let host = holder.workerHostFor(nativeId, true);
    if (!host && action.kind === "message" && holder.engine !== "claude" && isWorkerType(holder.subagents.get(nativeId)?.type)) {
      try { holder.ensureHead(); }
      catch (error) { return { ok: false, reason: `Its host could not start: ${(error as Error).message}` }; }
      host = holder.workerHostFor(nativeId);
    }
    if (!host) return { ok: false, reason: action.kind === "stop" ? "It is not at work." : "It is not an app-managed worker this bot can reach now." };
    if (action.kind === "stop") return (await host.stopWorker(nativeId)) ? { ok: true, how: "stopped" } : { ok: false, reason: "It is not at work." };
    return await host.sendToWorker(nativeId, action.text);
  }

  /** A worker another bot owns ended a run: its report goes to the registry, which hands it to the owner. */
  workerReported(item: Extract<CodexItem, { kind: "workerReport" }>) {
    const port = this.options.agents;
    if (port?.report) { port.report(this.hostFacts(), { nativeId: item.id, run: item.run, status: item.status, text: item.report }); return; }
    this.log(`worker ${item.id} reported for an owner, but there is no registry: its report stays in its row`);
  }

  /** A worker another bot owns sent a note: the registry hands it to the owner. */
  workerNoted(item: Extract<CodexItem, { kind: "workerNote" }>) {
    const port = this.options.agents;
    if (port?.note) { port.note(this.hostFacts(), { nativeId: item.id, run: item.run, kind: item.noteKind, name: item.name, message: item.message, files: item.files }); return; }
    this.log(`worker ${item.id} sent a note for an owner, but there is no registry: it was dropped`);
  }

  /** Subagent bookkeeping (subagents.json). True when the item was the subagent's own (not the turn's). */
  onSubagentItem(item: CodexItem): boolean {
    switch (item.kind) {
      case "toolUse":
        if (this.subagents.toolUse(item)) this.host.subagentChanged(this.subagents.get(item.parent ?? item.id));
        return item.parent !== null;
      case "toolResult": {
        const wasRunning = this.subagents.get(item.id)?.status === "running";
        if (this.subagents.toolResult(item)) {
          // A nested Agent result changes both the parent's tool step and the child's record.
          this.dirtySubagents.add(item.id);
          this.host.subagentChanged(this.subagents.get(item.parent ?? item.id));
        }
        if (wasRunning && this.subagents.get(item.id)?.status !== "running") this.host.subagentEnded(item.id);
        // The call that started it (not a SendMessage call's result) came back with claude's connection error.
        if (this.subagents.get(item.id)?.id === item.id) this.noteSubagentEnd(item.id, item.output);
        return item.parent !== null;
      }
      case "subagentRuntime":
        if (this.subagents.runtime(item.id, item.runtime, item.model)) this.host.subagentChanged(this.subagents.get(item.id), true);
        return true;
      case "subagentWaitingOn":
        if (this.subagents.waitingOn(item.id, item.on)) this.host.subagentChanged(this.subagents.get(item.id), true);
        return true;
      case "subagentOutput":
        if (this.subagents.output(item.id, item.counter, item.tokens)) this.host.subagentChanged(this.subagents.get(item.id), true);
        return true;
      case "subagentExecution":
        if (this.subagents.execution(item.id, item.execution)) this.host.subagentChanged(this.subagents.get(item.id));
        return true;
      case "subagentText":
        if (this.subagents.text(item.parent, item.text)) this.host.subagentChanged(this.subagents.get(item.parent), true);
        return true;
      case "subagentUser":
        if (this.subagents.said(item.parent, item.text, item.from)) this.host.subagentChanged(this.subagents.get(item.parent), true);
        return true;
      case "subagentStarted":
        // Initial ownership comes from the Agent call, never from whichever turn is now visible.
        if (this.subagents.started(item, undefined, isWorkerType(item.type) ? this.jobOfTurn() : undefined)) this.host.subagentChanged(this.subagents.get(item.id));
        if (item.background) this.addBackgroundTask(this.subagents.get(item.id)?.id ?? item.id, "agent", item.description);
        // A worker started for a bot's @: its news goes back to that bot (`callInWork`).
        if (isWorkerType(item.type)) this.linkCallInWork(item.id);
        // A worker for handed-over work: its report carries the hand-back.
        if ((this.engine === "codex" || this.engine === "agy") && this.turn?.conducted && this.turn.handoffId && (item.type === "codex-worker" || item.type === "agy-worker" || item.type === "ccb-core:component-editor")) {
          this.managedTaskHandoffs.set(item.id, this.turn.handoffId);
        }
        return true;
      case "subagentEnded": {
        const known = this.subagents.get(item.id)?.id ?? this.subagents.list.find(child=>child.agentID===item.id)?.id;
        // A worker's chip is its ledger's (`projectWorker`); other background work ends here.
        if (!isWorkerType((known ? this.subagents.get(known) : undefined)?.type)) this.endBackground(known ?? item.id, item.status, item.summary);
        const ended = this.subagents.ended(item);
        // A notification says more than the error, so a failed one counts if any line is it.
        if (known && (item.status.toLowerCase() === "failed" || item.status.toLowerCase() === "error" || this.cutOffByNetwork.has(known) || isConnectionError(item.summary ?? ""))) {
          this.noteSubagentEnd(known, connectionErrorLine(item.summary ?? ""));
        }
        if (ended) {
          this.host.subagentEnded(ended.id);
          this.host.subagentChanged(ended);
        }
        return true;
      }
      case "subagentWaiting":
        return true;
      default:
        return false;
    }
  }

  /** It changed: saved, its view sent, and the step that sent it (status, count) drawn again. */
  subagentChanged(subagent: SubagentRecord | undefined, progress = false, redrawLine = true) {
    if (!subagent) return;
    this.saveSubagents(progress && subagent.status === "running", subagent);
    if (!subagent.parentID) this.options.agents?.observed(this.hostFacts(), subagent, this.workerViews.get(subagent.id));
    this.rowsChanged();
    // The current run's tail is in memory; earlier runs (rare) come from its file so an open view keeps them.
    const live = subagent.runs ? { runs: this.subagentHistory(subagent).runs, steps: subagent.steps } : undefined;
    this.emit({ type: "subagent.updated", botId: this.id, subagent: subagentView(subagent, this.speaker, this.subagents, this.engine, live) });
    const top = subagent.parentID ? this.subagents.get(subagent.parentID) ?? subagent : subagent;
    if (this.turn?.steps.some((step) => step.id === top.id)) this.emitSteps(this.turn);
    if (!redrawLine) return;
    for (let i = this.records.length - 1, seen = 0; i >= 0 && seen < 80; i--, seen++) {
      const record = this.records[i]!;
      if (record !== this.turn?.record && record.steps?.some((step) => step.id === top.id)) {
        this.emit({ type: "message.updated", botId: this.id, message: this.messageView(record) });
        break;
      }
    }
  }

  /** A subagent ended: the step that sent it is done, and a silent turn will have to say what came of it. */
  subagentEnded(id: string) {
    const subagent = this.subagents.get(id);
    if (!subagent) return;
    if (!subagent.parentID) this.options.agents?.ended(this.hostFacts(), subagent, this.workerViews.get(subagent.id));
    // One another bot owns: its news is that bot's (its report is routed there), so no turn of this head reports it.
    const moved = !subagent.parentID && (this.options.agents?.movedOut(this.engine).has(subagent.id) ?? false);
    this.endSubagentTasks(subagent.id);
    const mark = (steps: StepRecord[] | undefined) => {
      const step = steps?.findLast((candidate) => candidate.id === id);
      if (!step) return false;
      step.done = true;
      step.failed = subagent.status === "failed";
      return true;
    };
    if (!mark(this.turn?.steps)) {
      for (let i = this.records.length - 1; i >= Math.max(0, this.records.length - 80); i--) {
        if (mark(this.records[i]!.steps)) { this.persist(true); break; }
      }
    }
    if (moved) { /* routed to its owner */ }
    else if (this.turn && this.turn.origin !== "tidy") this.turn.ended.push(id);
    else this.turns.subagentEnded(id);
    if (!this.turn && !this.queue.length && !this.tidying) this.scheduleIdle();
    this.checkSettingsHold();
  }

  /** Whether this turn hands its work back now (`takeHandback`): not while a worker it started for the hand-off owns it. */
  takeHandback(turn: Turn): boolean {
    const id = turn.handoffId;
    if ((this.engine === "codex" || this.engine === "agy") && turn.conducted && id && [...this.managedTaskHandoffs.values()].includes(id)) {
      this.managedHandbacks.add(id);
      return false;
    }
    return turn.conducted;
  }

  /** The return routes of a hand-off that stopped (or of all of them) are gone. */
  forgetReturnRoutes(handoffId?: string) {
    for (const [task, id] of [...this.managedTaskHandoffs]) if (!handoffId || id === handoffId) this.managedTaskHandoffs.delete(task);
    if (handoffId) this.managedHandbacks.delete(handoffId); else this.managedHandbacks.clear();
  }

  /** A subagent's call returned or it ended with claude's connection error: then it waits for the network like the bot. */
  noteSubagentEnd(id: string, text: string) {
    const subagent = this.subagents.get(id);
    if (!subagent || subagent.status === "running" || !(this.cutOffByNetwork.has(id) || isConnectionError(text))) return;
    this.cutOffByNetwork.delete(id);
    this.recordOutage({ subagents: [id] });
  }

  /** Words for the work that holds a model/effort restart back (the queue card). */
  ownWorkWords(): string {
    const parts: string[] = [];
    const subagents = this.inHeadSubagents.length;
    if (subagents) parts.push(`${subagents} ${this.engine === "claude" ? "subagent" : "worker"}${subagents === 1 ? "" : "s"}`);
    else if (this.managedPending) parts.push("its workers");
    if (this.backgroundWorkRunning) parts.push("background tasks");
    if (this.outage) parts.push("the network to come back");
    return parts.join(", ") || "its work";
  }

  /** Its workers this restart interrupted, as its ledger says (an entry from before the ledger names them itself). */
  restartedWorkers(entry: RestartEntry): WorkerLedgerRecord[] {
    if (entry.restartedAt === undefined) return [];
    return [...this.workerViews.values()].filter((r) => r.status === "interrupted" && r.interruptedBy === "restart" && (r.endedAt ?? 0) >= entry.restartedAt!);
  }
}
