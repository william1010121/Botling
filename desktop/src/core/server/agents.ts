// M7-S64: `CoreAgents` cut out of `Core` (core/server.ts). The app-wide agent registry's side of the core: agent notices and status files, the rows
// of agents a bot owns but another runs, "Move to…" (`moveAgent`, `groupAgents`, `moveOwners`, `finishMove`), an owner's reports, approvals, follow-ups
// and stops, and the owner commands. Same bridge convention as `CoreWatch` (core/server/watch.ts, in its header): a block of one-line forwarders to
// `host` first, then the fields this class owns, then the members as they were in `Core`, byte for byte (a member that `Core` or another collaborator
// calls lost its `private`).
import type { Core } from "../server";
import { Layout, type BotProfile } from "../store/workspace";
import { readSettings } from "../settings";
import { ContractError, type ResultOf, type SubagentRowView, type AgentTargetView } from "../../contract";
import { AgentRegistry, isDetached, newMoveId, rowStatus, TERMINAL_STATES, type AgentPort, type AgentRecord, type ApprovalAnswerer, type HostFacts, type MoveIntent, type ReconcileReport, type WorkerApproval } from "../agent-registry";
import { planMove, unmovable, type BotFacts, type MoveFacts, type MoveTarget } from "../agent-moves";
import { agentMessageNotice, agentNoteTail, agentReportNote, agentToldOfMove, backNote, handedNote, handedNotice, hostLostNotice, movedAwayNote, movedAwayNotice, notOwnedNote, ownedAgentsBriefing, ownerGoneNotice, queuedSentNotice, subBotAdoptedFirstMessage, subBotGroupFirstMessage } from "../agent-relay";
import { workerNoteText } from "../worker-core";
import type { WorkerOwner } from "../agent/workers";
import { AgentStatusWriter } from "../agent-status";
import type { Bot } from "../bot";
import type { BotRequest } from "../reply";

export class CoreAgents {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private get activated() { return this.host.activated; }
  private bot(...a: Parameters<Core["bot"]>) { return this.host.bot(...a); }
  private get bots() { return this.host.bots; }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private get maintainerId() { return this.host.maintainerId; }
  private makeSubBot(...a: Parameters<Core["makeSubBot"]>) { return this.host.makeSubBot(...a); }
  private get options() { return this.host.options; }
  private get profiles() { return this.host.profiles; }
  private removeBot(...a: Parameters<Core["removeBot"]>) { return this.host.removeBot(...a); }
  private get removed() { return this.host.removed; }
  private subBotRequested(...a: Parameters<Core["subBotRequested"]>) { return this.host.subBotRequested(...a); }

  /** The app-wide agent registry (agents.json, A1): who owns each agent apart from who runs it. */
  agents!: AgentRegistry;
  readonly agentStatus = new AgentStatusWriter();
  /** What the constructor's reconcile found, told once the core is active (a candidate start changes nothing outside the data folder). */
  private agentReconcile: ReconcileReport | null = null;
  private flagCache: { at: number; agentMoves: boolean; claudeOwnerMoves: boolean } | null = null;

  // ---- Agents (A1): the registry, "Move to…", notices, status files ----

  /** settings.json's agent flags (read at most every 2 s: rows ask often). */
  agentFlags(): { agentMoves: boolean; claudeOwnerMoves: boolean } {
    const now = Date.now();
    if (!this.flagCache || now - this.flagCache.at > 2_000) {
      const raw = readSettings(Layout.settings(this.options.dataDir)) as Record<string, unknown>;
      // agentMoves is on unless settings.json turns it off (A2 shipped).
      this.flagCache = { at: now, agentMoves: raw.agentMoves !== false, claudeOwnerMoves: raw.claudeOwnerMoves === true };
    }
    return this.flagCache;
  }

  private requireAgentMoves() {
    if (!this.agentFlags().agentMoves) throw new ContractError("forbidden", "Moving agents is off (agentMoves in settings.json).");
  }

  /** A bot's name as agent notices say it. */
  agentBotName(id: string): string {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    return !profile ? "a removed bot" : profile.role === "main" ? "Main bot" : profile.name;
  }

  private botFacts(id: string): BotFacts | null {
    const profile = this.profiles.find((candidate) => candidate.id === id);
    const bot = this.bots.get(id);
    if (!profile || !bot || this.removed.has(id)) return null;
    return { id, name: this.agentBotName(id), role: profile.role, parent: profile.parent ?? null, maintainer: id === this.maintainerId, problem: profile.problem, folder: profile.folder, engine: bot.engine, heads: bot.headEngines };
  }

  /** The registry as one bot's heads see it (a partner head shares its primary's). */
  agentPort(profile: BotProfile): AgentPort {
    const id = profile.id;
    return {
      observed: (host, rec, worker) => { this.agents.observe(host, rec, worker); },
      // Its report (if any) comes as the host's `workerReport` and goes to the owner (`report`).
      ended: (host, rec, worker) => { this.agents.observe(host, rec, worker); },
      report: (host, r) => this.agentReported(host, r),
      note: (host, n) => this.agentNoted(host, n),
      approval: (host, nativeId, item, head) => this.agentApproval(host, nativeId, item, head),
      approvalCancelled: (_host, requestId) => { for (const bot of this.bots.values()) bot.settleWorkerApproval(requestId); },
      retained: (engine) => this.agents.retained(id, engine),
      movedOut: (engine) => new Map([...this.agents.movedOut(id, engine)].map(([nativeId, record]) => [nativeId, {
        agentId: record.id, owner: { botId: record.owner.botId, engine: record.owner.engine }, ownerName: this.agentBotName(record.owner.botId), muted: record.relay.muted,
      }])),
      movedInRows: () => this.movedInRows(id),
      settle: (ownerBotId, nativeId, settled) => this.agents.settle(ownerBotId, nativeId, settled),
      rowInfo: (engine, nativeId) => {
        const record = this.agents.byNative(id, engine, nativeId);
        if (!record) return {};
        return { agentId: record.id, ...(this.agentFlags().agentMoves ? { movable: this.movability(record) } : {}) };
      },
    };
  }

  private movability(record: AgentRecord): { ok: boolean; reason: string | null } {
    const owner = this.botFacts(record.owner.botId);
    if (!owner) return { ok: false, reason: "Its owner is gone." };
    const reason = unmovable(record, { owner, pending: this.agents.moving(record.id), claudeOwnerMoves: this.agentFlags().claudeOwnerMoves });
    return { ok: !reason, reason: reason ? reason.slice(0, 200) : null };
  }

  /** The rows of agents this bot owns that another bot runs: the host's row, with the registry's status, settling and host. */
  private movedInRows(ownerId: string): SubagentRowView[] {
    const moves = this.agentFlags().agentMoves;
    return this.agents.movedIn(ownerId).map((record): SubagentRowView => {
      const row = this.bots.get(record.host.botId)?.workers.subagentRowFor(record.nativeId) ?? null;
      return {
        outputTokens: row?.outputTokens ?? null,
        id: record.nativeId.slice(0, 200),
        title: (row?.title || record.summary.description).slice(0, 400),
        status: rowStatus(record.state),
        head: row?.head ?? record.host.engine,
        startedAt: row?.startedAt ?? record.createdAt,
        endedAt: record.state === "running" ? null : row?.endedAt ?? record.endedAt,
        unsettledAt: record.ownerView.unsettledAt,
        settled: record.ownerView.settledAt !== null,
        prompt: (row?.prompt ?? record.summary.prompt).slice(0, 1_000),
        agentId: record.id,
        host: { botId: record.host.botId, name: this.agentBotName(record.host.botId).slice(0, 400) },
        ...(moves ? { movable: this.movability(record) } : {}),
      };
    });
  }

  /** A registry record changed: the rows of the bots it concerns, and its status file while it is owned elsewhere. */
  agentChanged(record: AgentRecord, previous: AgentRecord | null) {
    const detached = isDetached(record);
    if (!detached && !(previous && isDetached(previous))) return;
    const ownerChanged = !!previous && previous.owner.botId !== record.owner.botId;
    const rowChanged = !previous || ownerChanged || previous.state !== record.state || previous.summary.description !== record.summary.description
      || previous.endedAt !== record.endedAt || previous.ownerView.settledAt !== record.ownerView.settledAt || previous.ownerView.unsettledAt !== record.ownerView.unsettledAt;
    if (rowChanged) {
      this.bots.get(record.owner.botId)?.refresh();
      if (ownerChanged) { this.bots.get(previous!.owner.botId)?.refresh(); this.bots.get(record.host.botId)?.refresh(); }
    }
    if (detached && this.activated) this.writeAgentStatus(record, !previous || previous.state !== record.state || ownerChanged);
  }

  /** <owner folder>/.bot/agents/<id>/status.md (A1.4); its path, or null when it could not be written. */
  private writeAgentStatus(record: AgentRecord, force: boolean): string | null {
    const owner = this.profiles.find((candidate) => candidate.id === record.owner.botId);
    if (!owner || owner.problem) return null;
    try {
      const file = this.agentStatus.write(owner.folder, record, () => this.bots.get(record.host.botId)?.agentFacts(record.nativeId)?.steps ?? [], this.agentBotName(record.host.botId), force);
      if (record.summary.statusFile !== file) this.agents.setFiles(record.id, { statusFile: file });
      return file;
    } catch (error) {
      this.log(`agent status ${record.id}: ${(error as Error).message}`);
      return null;
    }
  }

  /** Reconcile (A1.3). `notify`: tell what it found (and what the constructor's found), and finish moves cut short. */
  reconcileAgents(notify: boolean) {
    const alive = [...this.bots.keys()].filter((id) => !this.removed.has(id));
    const report = this.agents.reconcile({ hosts: alive.flatMap((id) => this.bots.get(id)!.workers.hostBooks()), bots: new Set(alive) });
    const held = this.agentReconcile;
    this.agentReconcile = null;
    const found: ReconcileReport = held ? { ...report, hostLost: [...held.hostLost, ...report.hostLost], ownerReverted: [...held.ownerReverted, ...report.ownerReverted] } : report;
    if (report.added.length || report.dropped.length || report.interrupted.length) this.log(`agents: ${report.added.length} added, ${report.dropped.length} dropped, ${report.interrupted.length} interrupted`);
    if (!notify) { this.agentReconcile = found; return; }
    for (const record of found.hostLost) {
      this.bots.get(record.owner.botId)?.appNotice(hostLostNotice({ title: record.summary.description || "Subagent", host: this.agentBotName(record.host.botId), statusFile: record.summary.statusFile }), undefined, undefined, { moveNotice: `lost:${record.id}` });
    }
    for (const { record, from } of found.ownerReverted) {
      const host = this.bots.get(record.host.botId);
      host?.setWorkerOwner(record.nativeId, null);
      host?.appNotice(ownerGoneNotice({ title: record.summary.description || "Subagent", owner: this.agentBotName(from.botId) }));
    }
    for (const move of found.resend) {
      try { this.finishMove(move, {}); } catch (error) { this.log(`agent move ${move.id}: ${(error as Error).message}`); }
    }
    this.redeliverAgentReports();
  }

  /** `removeBot`'s part: reconcile rules 4 and 5 for that bot, before it leaves the profiles. */
  agentsOfRemovedBot(id: string) {
    const name = this.agentBotName(id);
    const gone = this.agents.botRemoved(id, (other) => other !== id && this.bots.has(other) && !this.removed.has(other));
    for (const record of gone.hostLost) {
      this.bots.get(record.owner.botId)?.appNotice(hostLostNotice({ title: record.summary.description || "Subagent", host: name, statusFile: record.summary.statusFile }), undefined, undefined, { moveNotice: `lost:${record.id}` });
    }
    for (const { record } of gone.ownerReverted) {
      const host = this.bots.get(record.host.botId);
      // Its host hears its reports again (it never stopped running).
      host?.setWorkerOwner(record.nativeId, null);
      host?.appNotice(ownerGoneNotice({ title: record.summary.description || "Subagent", owner: name }));
      host?.refresh();
    }
  }

  /** The wake note's part for agents it owns that run on another bot. */
  ownedAgentsNote(profile: BotProfile): string {
    return ownedAgentsBriefing(this.agents.movedIn(profile.id).filter((record) => !TERMINAL_STATES.has(record.state) || record.ownerView.settledAt === null).map((record) => ({
      title: record.summary.description || "Subagent", id: record.nativeId, engine: record.engine, host: this.agentBotName(record.host.botId), state: record.state, statusFile: record.summary.statusFile,
    })));
  }

  /** An agent by the bot whose rows show it and its row id: that bot's own book first, then the agents it owns elsewhere. */
  private resolveAgent(botId: string, subagentId: string): AgentRecord {
    this.bot(botId);
    const record = this.agents.byHostBot(botId, subagentId) ?? this.agents.movedIn(botId).find((candidate) => candidate.nativeId === subagentId);
    if (!record) throw new ContractError("not_found", "No such agent.");
    return record;
  }

  /** `subagent.view`: one of the bot's own, or one it owns that another bot runs (read from its host, named as the owner's). */
  agentView(botId: string, subagentId: string): ResultOf<"subagent.view"> {
    const view = this.agentViewBase(botId, subagentId);
    // Words the host could not take while the run worked wait here; they show as the last lines, marked queued, until sent.
    const record = this.agents.byHostBot(botId, subagentId) ?? this.agents.movedIn(botId).find((candidate) => candidate.nativeId === subagentId);
    const waiting = record?.relay.pendingMessages ?? [];
    if (!waiting.length) return view;
    return { ...view, subagent: { ...view.subagent, steps: [...view.subagent.steps, ...waiting.map((message) => ({
      id: `queued:${message.id}`, kind: "message" as const, tool: null, title: message.text.slice(0, 2_000), detail: null, output: null, failed: false, done: true,
      from: "owner", time: new Date(message.at).toISOString(), queued: true,
    }))].slice(-500) } };
  }

  private agentViewBase(botId: string, subagentId: string): ResultOf<"subagent.view"> {
    const bot = this.bot(botId);
    const own = this.agents.byHostBot(botId, subagentId);
    if (own || bot.agentFacts(subagentId)) {
      return bot.subagentView(subagentId, own && isDetached(own) ? { owner: this.agentBotName(own.owner.botId), host: this.agentBotName(botId) } : undefined);
    }
    const moved = this.agents.movedIn(botId).find((candidate) => candidate.nativeId === subagentId);
    if (!moved) return bot.subagentView(subagentId);
    const host = this.removed.has(moved.host.botId) ? undefined : this.bots.get(moved.host.botId);
    if (!host) throw new ContractError("not_found", "The bot that ran it is gone.");
    return host.subagentView(subagentId, { owner: this.agentBotName(botId), host: this.agentBotName(moved.host.botId) });
  }

  private moveFacts(record: AgentRecord, to?: MoveTarget): MoveFacts {
    const owner = this.botFacts(record.owner.botId);
    if (!owner) throw new ContractError("not_found", "Its owner is gone.");
    return {
      owner, host: this.botFacts(record.host.botId),
      ...(to?.kind === "bot" ? { target: this.botFacts(to.botId) } : {}),
      project: owner.parent ? this.botFacts(owner.parent) : owner,
      pending: this.agents.moving(record.id),
      claudeOwnerMoves: this.agentFlags().claudeOwnerMoves,
    };
  }

  /** `agent.targets`: where "Move to…" can take it, each with why not when it cannot. */
  agentTargets(botId: string, subagentId: string): ResultOf<"agent.targets"> {
    this.requireAgentMoves();
    const record = this.resolveAgent(botId, subagentId);
    const base = this.moveFacts(record);
    const view = (kind: AgentTargetView["kind"], target: MoveTarget, botIdOf: string | null, name: string, folder: string, facts: MoveFacts): AgentTargetView => {
      const plan = planMove(record, target, facts);
      return { kind, botId: botIdOf, name: name.slice(0, 400), folder: folder.slice(0, 4_000), sameFolder: folder === record.host.folder,
        disabled: "refuse" in plan ? plan.refuse.slice(0, 400) : null, mode: "refuse" in plan ? "owner" : plan.mode };
    };
    const targets: AgentTargetView[] = [];
    if (isDetached(record) && base.host) targets.push(view("back", { kind: "back" }, base.host.id, base.host.name, base.host.folder, base));
    const handoff = record.engine === "claude" && !(record.background && base.claudeOwnerMoves);
    targets.push(view("newSubBot", { kind: "newSubBot", name: "New sub bot" }, null, "New sub bot…", (handoff ? base.owner.folder : base.project?.folder) ?? base.owner.folder, base));
    // Its project's own family first (the project bot and its sub bots), then every other bot that can take one.
    const project = base.project?.id ?? null;
    const candidates = this.profiles.filter((profile) => !this.removed.has(profile.id) && profile.role !== "main" && profile.id !== this.maintainerId && profile.id !== record.owner.botId && !(isDetached(record) && profile.id === record.host.botId));
    const family = (profile: BotProfile) => profile.id === project || (project !== null && profile.parent === project) ? 0 : 1;
    for (const profile of [...candidates].sort((a, b) => family(a) - family(b))) {
      const facts = { ...base, target: this.botFacts(profile.id) };
      targets.push(view("bot", { kind: "bot", botId: profile.id }, profile.id, this.agentBotName(profile.id), profile.folder, facts));
    }
    return { engine: record.engine, targets: targets.slice(0, 200) };
  }

  /**
   * `agent.move` (A1.6). An owner move writes its intent first, makes the new sub bot when asked, tells the host who owns the
   * worker now (its reports, approvals and coordinator calls follow), then changes the owner and commits in one write; the
   * notices follow, once per move (sent again at the next start when cut short). A Claude subagent inside its parent's
   * process (a sidechain, only with claudeWorkers "native") goes by the sub-bot hand-off instead (unchanged).
   */
  async moveAgent(botId: string, subagentId: string, to: MoveTarget, options: { notifyAgent?: boolean } = {}): Promise<ResultOf<"agent.move">> {
    this.requireAgentMoves();
    const record = this.resolveAgent(botId, subagentId);
    const plan = planMove(record, to, this.moveFacts(record, to));
    if ("refuse" in plan) throw new ContractError("conflict", plan.refuse);
    if (plan.mode === "handoff") {
      const host = this.bots.get(record.host.botId);
      if (!host) throw new ContractError("not_found", "The bot that runs it is gone.");
      void this.subBotRequested(host, { name: to.kind === "newSubBot" ? to.name : "", subagent: record.nativeId, note: to.kind === "newSubBot" ? to.note ?? "" : "" });
      return { agentId: record.id, ownerBotId: record.owner.botId, mode: "handoff" };
    }
    const owner = await this.moveOwners([record], to, { notifyAgent: options.notifyAgent === true, note: to.kind === "newSubBot" ? to.note : undefined });
    return { agentId: record.id, ownerBotId: owner, mode: "owner" };
  }

  /**
   * "New sub bot with these…" and `<sub-bot subagents="…">`: several agents shown in one bot's rows move to one new sub bot (or
   * one bot) together. Every one is planned first; one that cannot go refuses them all.
   */
  async groupAgents(botId: string, subagentIds: string[], to: MoveTarget, options: { task?: string } = {}): Promise<ResultOf<"agent.group">> {
    this.requireAgentMoves();
    const records = [...new Map(subagentIds.map((id) => { const record = this.resolveAgent(botId, id); return [record.id, record] as const; })).values()];
    const owner = await this.moveOwners(records, to, { note: to.kind === "newSubBot" ? to.note : undefined, task: options.task });
    return { ownerBotId: owner, agentIds: records.map((record) => record.id) };
  }

  /** The owner of each of these (an app-managed worker) is told to its host: null when the new owner is the host itself. */
  private workerOwnerFor(record: AgentRecord, to: string): WorkerOwner | null {
    return to === record.host.botId ? null : { botId: to, name: this.agentBotName(to), agentId: record.id };
  }

  /**
   * Owner moves of one or more agents to one target, all or none: intents first, the sub bot (once), each host told the new
   * owner (a refusal undoes the ones before it and the sub bot), then the commits and the notices.
   */
  async moveOwners(records: AgentRecord[], to: MoveTarget, options: { notifyAgent?: boolean; note?: string; task?: string }): Promise<string> {
    if (!records.length) throw new ContractError("bad_request", "No agents to move.");
    const plans = records.map((record) => {
      const plan = planMove(record, to, this.moveFacts(record, to));
      if ("refuse" in plan) throw new ContractError("conflict", records.length > 1 ? `"${record.summary.description || record.nativeId}" cannot move: ${plan.refuse}` : plan.refuse);
      if (plan.mode !== "owner") throw new ContractError("conflict", `"${record.summary.description || record.nativeId}" is a Claude subagent inside its parent: it can only be handed over on its own, through handoff.md.`);
      return plan;
    });
    const sub = plans.find((plan) => plan.makeSubBot)?.makeSubBot;
    if (sub && plans.some((plan) => plan.makeSubBot && plan.makeSubBot.parentId !== sub.parentId)) throw new ContractError("conflict", "These agents belong to different projects; move them one project at a time.");
    const moves: MoveIntent[] = records.map((record, i) => ({ id: newMoveId(), agentId: record.id, kind: "owner", from: { owner: { botId: record.owner.botId, engine: record.owner.engine } }, to: { owner: plans[i]!.to }, phase: "intent", at: Date.now() }));
    const begun: MoveIntent[] = [];
    const told: AgentRecord[] = [];
    let subId: string | null = null;
    try {
      for (const move of moves) { this.agents.beginMove(move); begun.push(move); }
      if (sub) {
        const parent = this.profiles.find((candidate) => candidate.id === sub.parentId);
        if (!parent) throw new Error("its project bot is gone");
        const from = this.agentBotName(records[0]!.owner.botId);
        const job = records.length === 1 ? `Own the agent "${records[0]!.summary.description || "an agent"}" handed over by ${from}.` : `Own ${records.length} agents handed over by ${from}.`;
        subId = this.makeSubBot(parent, sub.name, `${job}${options.task?.trim() ? ` ${options.task.trim()}` : ""}`.slice(0, 1_000), undefined, sub.engine);
        for (const move of moves) this.agents.retarget(move.id, { botId: subId, engine: sub.engine });
      }
      for (const [i, record] of records.entries()) {
        const target = this.agents.pendingMoves.find((candidate) => candidate.id === moves[i]!.id)!.to.owner.botId;
        if (record.host.kind === "claude-sidechain") continue;
        const set = this.bots.get(record.host.botId)?.setWorkerOwner(record.nativeId, this.workerOwnerFor(record, target)) ?? null;
        if (set && !set.ok) throw new Error(`"${record.summary.description || record.nativeId}": ${set.reason}`);
        told.push(record);
      }
      for (const move of moves) this.agents.commitMove(move.id);
    } catch (error) {
      // Undo: the hosts are told the owners they had, the intents are dropped, the sub bot made for them goes.
      for (const record of told) this.bots.get(record.host.botId)?.setWorkerOwner(record.nativeId, this.workerOwnerFor(record, record.owner.botId));
      for (const move of begun) this.agents.endMove(move.id);
      if (subId) await this.removeBot(subId, { quiet: true }).catch(() => undefined);
      throw error instanceof ContractError ? error : new ContractError("conflict", `It was not moved: ${(error as Error).message}`);
    }
    const group = records.length > 1 || !!options.task;
    for (const move of moves) {
      const committed = this.agents.pendingMoves.find((candidate) => candidate.id === move.id);
      if (!committed) continue;
      try { this.finishMove(committed, { note: options.note, notifyAgent: options.notifyAgent === true, madeSubBot: !!subId && !group, quietFresh: group }); }
      catch (error) { this.log(`agent move ${move.id}: notices will be sent again at the next start (${(error as Error).message})`); }
    }
    const ownerId = this.agents.get(records[0]!.id)?.owner.botId ?? subId ?? "";
    // A sub bot made for several: one first message listing every one of them and its status file.
    if (subId && group) {
      const next = this.bots.get(subId);
      const parentId = this.profiles.find((candidate) => candidate.id === subId)?.parent ?? null;
      const from = this.agentBotName(moves[0]!.from.owner.botId);
      next?.relay(subBotGroupFirstMessage({
        parentName: parentId ? this.agentBotName(parentId) : from, name: next.profile.name, from, task: options.task ?? options.note,
        agents: records.map((record) => { const now = this.agents.get(record.id) ?? record; return { title: now.summary.description || "Agent", agentId: now.id, nativeId: now.nativeId, engine: now.engine, state: now.state, host: this.agentBotName(now.host.botId), statusFile: now.summary.statusFile }; }),
      }));
    }
    for (const record of records) this.log(`agent ${record.id} now belongs to ${this.agentBotName(this.agents.get(record.id)?.owner.botId ?? "")}`);
    return ownerId;
  }

  /** A committed move's notices (A1.7), each posted once (keyed by move id), then the move is done. */
  finishMove(move: MoveIntent, options: { note?: string; notifyAgent?: boolean; madeSubBot?: boolean; quietFresh?: boolean }) {
    const record = this.agents.get(move.agentId);
    if (record) {
      const title = record.summary.description || "Subagent";
      const fromId = move.from.owner.botId, toId = move.to.owner.botId, hostId = record.host.botId;
      const fromName = this.agentBotName(fromId), toName = this.agentBotName(toId), hostName = this.agentBotName(hostId);
      const back = toId === hostId;
      const statusFile = back ? null : this.writeAgentStatus(record, true);
      const old = this.removed.has(fromId) ? undefined : this.bots.get(fromId);
      if (old && !old.hasMoveNotice(`${move.id}:from`)) {
        old.appNotice(movedAwayNotice({ title, to: toName, host: hostName }), undefined, undefined, { sourceID: toId, moveNotice: `${move.id}:from` });
        old.queueNote(movedAwayNote({ title, nativeId: record.nativeId, to: toName }));
      }
      const next = this.removed.has(toId) ? undefined : this.bots.get(toId);
      if (next && !next.hasMoveNotice(`${move.id}:to`)) {
        if (back) {
          next.appNotice(`${fromName} gave "${title}" back. Its reports come to you again.`, undefined, undefined, { sourceID: fromId, moveNotice: `${move.id}:to` });
          next.queueNote(backNote({ title, nativeId: record.nativeId, from: fromName }));
        } else {
          // A sub bot made for it (or, after a crash, one that has said nothing yet) is woken with it; an existing bot hears with its next message.
          const fresh = !options.quietFresh && (options.madeSubBot ?? (!!next.profile.parent && next.view().lastActivity === null));
          next.appNotice(handedNotice({ from: fromName, title, engine: record.engine, state: record.state, host: hostName, folder: record.host.folder, statusFile: statusFile ?? "(not written yet)" }), undefined, undefined, { sourceID: fromId, moveNotice: `${move.id}:to` });
          if (fresh) {
            const parent = next.profile.parent ? this.agentBotName(next.profile.parent) : fromName;
            next.relay(subBotAdoptedFirstMessage({ parentName: parent, name: next.profile.name, from: fromName, title, nativeId: record.nativeId, agentId: record.id, engine: record.engine, host: hostName, folder: record.host.folder, statusFile: statusFile ?? "(not written yet)", ...(options.note ? { note: options.note } : {}) }));
          } else if (!options.quietFresh) next.queueNote(handedNote({ from: fromName, title, nativeId: record.nativeId, agentId: record.id, engine: record.engine, host: hostName, statusFile: statusFile ?? "(not written yet)" }));
        }
      }
      // The host, when it is neither: it must leave the agent alone too.
      if (hostId !== fromId && hostId !== toId) this.bots.get(hostId)?.queueNote(movedAwayNote({ title, nativeId: record.nativeId, to: toName }));
      // The agent itself: a running Codex worker, only when asked for. Never Claude, never Antigravity.
      if (options.notifyAgent && record.engine === "codex" && record.host.kind === "codex-thread" && record.state === "running") this.bots.get(hostId)?.askForHandoff(record.nativeId, agentToldOfMove(toName));
    }
    this.agents.setPhase(move.id, "notified");
    this.agents.endMove(move.id);
  }

  // ---- Agents (A2): reports, approvals, follow-ups and stops go to the owner; closing a sub bot ----

  /** Owner app turns carrying a report: turn id → the report (delivered once that turn starts). */
  reportTurns = new Map<string, { agentId: string; run: number }>();
  /** The turns that began while a report was being handed over (`deliverAgentReport`). */
  reportStarts: Set<string> | null = null;
  /** Reports handed to an owner in this run of the core (redelivery after a restart goes once per run). */
  private reportsHanded = new Set<string>();

  /** A worker another bot owns ended a run (its host's `workerReport`): recorded, then handed to the owner as an app message. */
  private agentReported(host: HostFacts, r: { nativeId: string; run: number; status: string; text: string }) {
    const record = this.agents.byNative(host.botId, host.engine, r.nativeId);
    if (!record) { this.log(`agent report from ${host.botId} for ${r.nativeId}: not in the registry`); return; }
    if (!this.agents.reported(record.id, r)) return;
    this.deliverAgentReport(record.id);
    void this.sendQueuedMessages(record.id);
  }

  /** A worker another bot owns sent a note from its run under way (its host's `workerNote`): handed to the owner now, never kept. */
  private agentNoted(host: HostFacts, n: { nativeId: string; run: number; kind: "report" | "question"; name: string; message: string; files: string[] }) {
    const record = this.agents.byNative(host.botId, host.engine, n.nativeId);
    const owner = record && !this.removed.has(record.owner.botId) ? this.bots.get(record.owner.botId) : undefined;
    if (!record || !owner) { this.log(`agent note from ${host.botId} for ${n.nativeId}: no owner to take it`); return; }
    const name = record.summary.description || n.name;
    const text = workerNoteText({ id: record.id, run: n.run, kind: n.kind, name, message: n.message, files: n.files }, agentNoteTail({ kind: n.kind, host: this.agentBotName(record.host.botId), agentId: record.id }));
    if (!owner.workerNote({ kind: n.kind, name, message: n.message, files: n.files }, text)) this.log(`agent note for ${record.id}: its owner could not take it now`);
  }

  /** The owner's app turn with the report (its status file brought up to date first). Stays undelivered when the owner cannot run. */
  private deliverAgentReport(agentId: string) {
    const record = this.agents.get(agentId);
    const report = record?.relay.report;
    if (!record || !report || report.delivered) return;
    const key = `${agentId}:${report.run}`;
    if (this.reportsHanded.has(key)) return;
    const owner = this.removed.has(record.owner.botId) ? undefined : this.bots.get(record.owner.botId);
    if (!owner) return;
    const statusFile = isDetached(record) ? this.writeAgentStatus(record, true) : record.summary.statusFile;
    const from = record.owner.history.at(-1)?.botId ?? record.host.botId;
    // A free owner begins the turn (turn.started) before appMessage returns its id: those starts are caught here.
    const started = new Set<string>();
    this.reportStarts = started;
    let turnId: string | null;
    try {
      turnId = owner.appMessage(agentReportNote({
        engine: record.engine, title: record.summary.description || "Agent", from: this.agentBotName(from), host: this.agentBotName(record.host.botId),
        run: report.run, status: record.state === "failed" ? "failed" : record.state === "stopped" ? "stopped" : "completed", report: record.summary.lastReport ?? "", agentId, statusFile,
      }));
    } finally { this.reportStarts = null; }
    if (!turnId) return;
    this.reportsHanded.add(key);
    if (started.has(turnId)) this.agents.reportDelivered(agentId, report.run);
    else this.reportTurns.set(turnId, { agentId, run: report.run });
  }

  /** Words left for an agent whose host could not take them while it worked: sent now that its run ended. */
  private async sendQueuedMessages(agentId: string) {
    const record = this.agents.get(agentId);
    if (!record?.relay.pendingMessages.length) return;
    const host = this.removed.has(record.host.botId) ? undefined : this.bots.get(record.host.botId);
    const owner = this.removed.has(record.owner.botId) ? undefined : this.bots.get(record.owner.botId);
    if (!host) return;
    const words = this.agents.takeMessages(agentId);
    const sent = await host.commandWorker(record.nativeId, { kind: "message", text: words.map((message) => message.text).join("\n\n") });
    const title = record.summary.description || "Agent";
    if (sent.ok && sent.how !== "stopped") owner?.appNotice(queuedSentNotice({ title, run: sent.run }), undefined, undefined, { sourceID: record.host.botId });
    else if (!sent.ok && sent.busy) for (const message of words) this.agents.queueMessage(agentId, message);
    else if (!sent.ok) owner?.appNotice(`The words you left for "${title}" could not be sent: ${sent.reason}`);
  }

  /** Reports that never reached their owner (the app stopped first): handed over again, once. */
  private redeliverAgentReports() {
    for (const record of this.agents.all) if (record.relay.report && !record.relay.report.delivered) this.deliverAgentReport(record.id);
  }

  /** A worker another bot owns asks for an approval: the owner's chat shows the card. */
  private agentApproval(host: HostFacts, nativeId: string, item: WorkerApproval, head: ApprovalAnswerer): boolean {
    const record = this.agents.byNative(host.botId, host.engine, nativeId);
    if (!record || !isDetached(record)) return false;
    const owner = this.removed.has(record.owner.botId) ? undefined : this.bots.get(record.owner.botId);
    if (!owner) return false;
    owner.questions.askForWorker(head, { ...item, summary: `${item.summary} (worker "${record.summary.description || nativeId}" on ${this.agentBotName(record.host.botId)})` });
    return true;
  }

  /** An agent by what its owner calls it: its agent id, or the id its row shows (its native id). */
  private ownedAgent(ownerBotId: string, key: string): AgentRecord | undefined {
    return this.agents.get(key) ?? this.agents.movedIn(ownerBotId).find((record) => record.nativeId === key) ?? this.agents.byHostBot(ownerBotId, key);
  }

  /**
   * The owner's follow-up or stop (`agent.message` / `agent.stop`, `<agent-message>` / `<agent-stop>`), through the host's
   * WorkerHost. Only the registry owner may command. A follow-up a busy host cannot take now waits for the run to end.
   */
  async commandAgent(ownerBotId: string, key: string, action: { kind: "message"; text: string } | { kind: "stop" }): Promise<{ record: AgentRecord; how: "steered" | "newRun" | "queued" | "stopped"; run: number | null }> {
    const record = this.ownedAgent(ownerBotId, key);
    if (!record) throw new ContractError("not_found", `There is no agent "${key}".`);
    if (record.owner.botId !== ownerBotId) throw new ContractError("forbidden", `It belongs to ${this.agentBotName(record.owner.botId)}; only its owner may command it.`);
    if (record.host.kind === "claude-sidechain") throw new ContractError("conflict", "A Claude subagent inside its parent cannot be messaged or stopped on its own.");
    if (record.state === "lost") throw new ContractError("conflict", "Its host is gone.");
    const host = this.removed.has(record.host.botId) ? undefined : this.bots.get(record.host.botId);
    if (!host) throw new ContractError("conflict", "Its host is gone.");
    const result = await host.commandWorker(record.nativeId, action);
    if (!result.ok) {
      if (action.kind === "message" && result.busy) {
        this.agents.queueMessage(record.id, { text: action.text, from: this.agentBotName(ownerBotId) });
        return { record, how: "queued", run: null };
      }
      throw new ContractError("conflict", result.reason);
    }
    return { record, how: result.how, run: result.how === "stopped" ? null : result.run };
  }

  /** `agent.message` from a row's "Send a message…". */
  async agentMessageCommand(botId: string, subagentId: string, text: string): Promise<ResultOf<"agent.message">> {
    const done = await this.commandAgent(botId, subagentId, { kind: "message", text });
    const how = done.how === "stopped" ? "newRun" : done.how;
    this.bots.get(botId)?.appNotice(agentMessageNotice({ title: done.record.summary.description || "Agent", how, run: done.run ?? 0 }), undefined, undefined, { sourceID: done.record.host.botId });
    return { agentId: done.record.id, how, run: done.run };
  }

  /** `agent.stop` from a row's "Stop". */
  async agentStopCommand(botId: string, subagentId: string): Promise<ResultOf<"agent.stop">> {
    const done = await this.commandAgent(botId, subagentId, { kind: "stop" });
    this.bots.get(botId)?.appNotice(`Stopped "${done.record.summary.description || "Agent"}".`, undefined, undefined, { sourceID: done.record.host.botId });
    return { agentId: done.record.id, stopped: true };
  }

  /** A bot's `<agent-message>` / `<agent-stop>`: as the commands, with what went wrong told to it and the chat, never silently. */
  async agentTag(bot: Bot, request: Extract<BotRequest, { kind: "agentMessage" | "agentStop" }>) {
    const owner = this.bots.get(bot.id) ?? bot;
    try {
      const done = await this.commandAgent(owner.id, request.to, request.kind === "agentMessage" ? { kind: "message", text: request.text } : { kind: "stop" });
      const title = done.record.summary.description || "Agent";
      if (done.how === "stopped") owner.appNotice(`Stopped "${title}".`, undefined, undefined, { sourceID: done.record.host.botId });
      else owner.appNotice(agentMessageNotice({ title, how: done.how, run: done.run ?? 0 }), undefined, undefined, { sourceID: done.record.host.botId });
    } catch (error) {
      const record = this.agents.get(request.to) ?? this.agents.all.find((candidate) => candidate.nativeId === request.to);
      if (error instanceof ContractError && error.code === "forbidden") owner.queueNote(notOwnedNote(request.to, record ? this.agentBotName(record.owner.botId) : null));
      else owner.queueNote(`(App: Nothing reached the agent "${request.to}": ${(error as Error).message})`);
      owner.appNotice(`${request.kind === "agentStop" ? "Did not stop" : "Did not send to"} "${record?.summary.description || request.to}": ${(error as Error).message}`);
    }
  }
}
