// BotSettings (M7-S48): heads, engine switching/handoff, model & effort settings.
import { ContractError, type BotSettingsView, type ResultOf } from "../../contract";
import { AGY_EXECUTION_BLOCKED } from "../agent/agy";
import { verifyAcpRuntime } from "../agent/agy-acp";
import type { Bot } from "../bot";
import { EFFORTS_BY_ENGINE, effortsFor, type EngineEfforts } from "../engine-defaults";
import { displayName, fitted, headsJSON, resolvePrimary, type Engine, type Heads } from "../heads";
import { isPlainOK, type BotPrompts } from "../prompts";
import { codexWorkerDefaults, codexWorkersJSON } from "../settings";
import type { BotStore } from "../store/bot-store";
import { newId, toSwiftDate, type ChatRecord } from "../store/records";
import type { BotContext } from "./context";
import type { AgentHead, BotOptions } from "./types";
import { sleep } from "./view-functions";

export class BotSettings {
  constructor(private readonly host: Bot, private readonly ctx: BotContext) {}

  // ---- Bridge: shared names via `ctx`, Bot's own via `host` ----
  private get options(): BotOptions { return this.ctx.options; }
  private get store(): BotStore { return this.ctx.store; }
  private get engine(): Engine { return this.ctx.engine; }
  private get owner(): Bot { return this.ctx.owner; }
  private get members(): Bot[] { return this.ctx.members; }
  private get peers(): Bot[] { return this.ctx.peers; }
  private get profile() { return this.ctx.profile; }
  private log(line: string) { this.ctx.log(line); }

  private get partners() { return this.host.partners; }
  private get conductor() { return this.host.conductor; }
  private get readOnly() { return this.host.readOnly; }
  private get head() { return this.host.head; }
  private get turn() { return this.host.turn; }
  private get tidying() { return this.host.tidying; }
  private get approvals() { return this.host.approvals; }
  private get inHeadSubagents() { return this.host.inHeadSubagents; }
  private get managedPending() { return this.host.managedPending; }
  private get shuttingDown() { return this.host.shuttingDown; }
  private get session() { return this.host.session; }
  private sessionResumed(sessionId: string) { this.host.headRun.sessionResumed(sessionId); }
  private briefingGiven() { this.host.headRun.briefingGiven(); }

  private appPrimary(): Engine | null { return this.host.appPrimary(); }
  private updated() { return this.host.updated(); }
  private headsChanged(): void { return this.host.headsChanged(); }
  private add(record: ChatRecord, options?: { archive?: boolean }) { return this.host.add(record, options); }
  private newSession() { return this.host.newSession(); }
  private clearIdle() { return this.host.clearIdle(); }
  private maintenance(text: string, timeoutMs: number, head: AgentHead): Promise<string | null> { return this.host.maintenance(text, timeoutMs, head); }
  private ensureHead(): AgentHead { return this.host.ensureHead(); }
  private wakeNote(): string { return this.host.delivery.wakeNote(); }
  private componentNote(): string { return this.host.cards.componentNote(); }
  private prompts(): BotPrompts { return this.host.prompts(); }
  private withSavedMemory(prompt: string): string { return this.host.withSavedMemory(prompt); }
  private showAppReply(raw: string) { return this.host.showAppReply(raw); }
  private scheduleIdle() { return this.host.scheduleIdle(); }
  private next(): void { return this.host.next(); }

  // ---- Owned state ----
  headsSettings!: Heads;
  switchTo: Engine | null = null;
  /** The switch of engine that waited for the head to end is taken (or is not wanted any more). */
  clearSwitchTo() { this.switchTo = null; }
  switching = false;

  // ---- Moved from `Bot` ----
  /** One head or two (1.x's Settings → Heads). An awake head that goes away tidies first. */
  async setHeads(engines: Engine[]): Promise<ResultOf<"heads.set">> {
    if (this.options.primary) return this.options.primary.setHeads(engines);
    const kept = (["claude", "codex", "agy"] as Engine[]).filter((engine) => engines.includes(engine));
    if (!kept.length) throw new ContractError("bad_request", "A bot needs a head.");
    if (kept.includes("codex") && !this.options.codexConfig) throw new ContractError("conflict", "Codex is not available here.");
    if (kept.length > 3) throw new ContractError("bad_request", "Choose at most three engines.");
    if (kept.includes("agy")) {
      const config = this.options.agyConfig?.(this.profile, {command:"agy",cwd:this.profile.folder,sessionId:this.session.sessionId,resume:this.session.started});
      if (config?.transport !== "acp") throw new ContractError("conflict", AGY_EXECUTION_BLOCKED);
      verifyAcpRuntime(config.command);
    }
    const settings = this.headsSettings;
    // Its own head goes (1.x's `setHeads` / `switchEngine`): it runs on the other one, through a handoff.
    const target = kept.includes(this.engine) ? this.engine : kept[0]!;
    if (target === this.engine) this.switchTo = null;
    const switching = target !== this.engine ? target : null;
    settings.engines = kept;
    // A bot with no primary of its own keeps following the app's; one it has is kept if it still has that engine.
    if (settings.answerWith && !kept.includes(settings.answerWith as Engine)) settings.answerWith = fitted(settings, settings.answerWith, this.appPrimary());
    this.conductor.settings = settings;
    this.saveHeads(switching ?? undefined);
    for (const partner of this.peers.filter(peer => !kept.includes(peer.engine) || peer.engine === switching)) {
      if (target === "agy" && partner.engine === "agy") {
        const saved = partner.store.loadSettings();
        if (typeof saved.agyConversation === "string") this.store.saveSetting("agyConversation", saved.agyConversation);
        if (saved.agyRecovery) this.store.saveSetting("agyRecovery", saved.agyRecovery);
      }
      await partner.shutdown();
      this.partners.delete(partner.engine);
    }
    if (switching) this.switchEngine(switching);
    for (const bot of this.members) if (bot.head?.running) bot.pendingNote = [bot.pendingNote, `(App: Collaboration settings changed. Available engines: ${settings.engines.join(", ")}. Each message has one primary recipient. Delegate only when useful, using a handoff tag with the intended engine in its to attribute and task, review or discuss in its kind attribute. Include the authorized phase, scope, constraints and acceptance criteria. Never delegate a refused action to bypass it.)`].filter(Boolean).join("\n\n");
    this.updated();
    this.headsChanged();
    return { engines: settings.engines };
  }

  /** Its own choices in bot.json (1.x's `model`, `effort`, `subagentModel`, `codexWorkers`). */
  choices(): { model: string | null; effort: string | null; efforts: EngineEfforts; subagentModel: string | null; subagentEffort: string | null; codexWorkers: { model: string | null; effort: string | null; fast: boolean | null } | null; agyWorkerModel: string | null; agyWorkerEffort: string | null; workerMachine: string | null } {
    const settings = this.store.loadSettings();
    const pick = (value: unknown, list: readonly string[]) => (typeof value === "string" && list.includes(value) ? value : null);
    const workers = codexWorkerDefaults(settings.codexWorkers);
    return {
      model: typeof settings.model === "string" ? settings.model : null,
      effort: pick(settings.effort, ["low", "medium", "high", "xhigh", "max"]),
      // Each engine's own effort, the old single one standing in where an engine has none.
      efforts: effortsFor(settings),
      subagentModel: typeof settings.subagentModel === "string" ? settings.subagentModel : null,
      subagentEffort: pick(settings.subagentEffort, EFFORTS_BY_ENGINE.claude),
      // None set: Codex's own config (~/.codex/config.toml).
      codexWorkers: workers.model || workers.effort || workers.fast !== null ? workers : null,
      // Antigravity workers' own model and effort; none: the same as its Antigravity head (agy-workers.ts).
      agyWorkerModel: typeof settings.agyWorkerModel === "string" && settings.agyWorkerModel.trim() ? settings.agyWorkerModel.trim() : null,
      agyWorkerEffort: pick(settings.agyWorkerEffort, EFFORTS_BY_ENGINE.agy),
      // Where its Claude workers run when app_handoff names no machine (Settings › Machines); none: here.
      workerMachine: typeof settings.workerMachine === "string" && settings.workerMachine.trim() ? settings.workerMachine.trim() : null,
    };
  }

  /**
   * "Apply to all bots": this bot's engine set, models, effort and primary become the app's defaults
   * (its own primary is cleared, so it follows the app's). Heads go away or start as with Settings → Engines in
   * this bot; a head already running keeps its model until it next wakes, as with its own settings.
   */
  async applyEngineChoices(choices: { engines: Engine[]; model: string | null; efforts: EngineEfforts; codexModel: string | null; agyModel: string | null }) {
    const owner = this.owner;
    if (owner.readOnly) throw new ContractError("conflict", owner.problem ?? "Read-only.");
    if (owner.headsSettings.engines.join() !== choices.engines.join()) await owner.setHeads(choices.engines);
    // The old single effort goes: every engine has exactly the app's value for it (or its own default).
    owner.configure({ model: choices.model, effort: null, efforts: choices.efforts, codexModel: choices.codexModel, agyModel: choices.agyModel, primary: null });
  }

  /**
   * The app's engine defaults changed (1.x's `setSubagentModelDefault` / `setCodexWorkerDefaults`, which
   * set every bot): written into its bot.json and its other head's; a head already running keeps its own
   * until it next wakes, as with its own settings.
   */
  applyEngineDefaults(change: { subagentModel?: string | null; subagentEffort?: string | null; codexWorkers?: Record<string, unknown> | undefined; agyWorkerModel?: string | null; agyWorkerEffort?: string | null }) {
    const owner = this.owner;
    if (owner.readOnly) return;
    for (const store of owner.members.map(bot => bot.store)) {
      if (change.subagentModel !== undefined) store.saveSetting("subagentModel", change.subagentModel ?? undefined);
      if (change.subagentEffort !== undefined) store.saveSetting("subagentEffort", change.subagentEffort ?? undefined);
      if ("codexWorkers" in change) store.saveSetting("codexWorkers", change.codexWorkers);
      if (change.agyWorkerModel !== undefined) store.saveSetting("agyWorkerModel", change.agyWorkerModel ?? undefined);
      if (change.agyWorkerEffort !== undefined) store.saveSetting("agyWorkerEffort", change.agyWorkerEffort ?? undefined);
    }
  }

  /** What the bot's settings page shows. */
  settingsView(): BotSettingsView {
    const owner = this.owner;
    const choices = owner.choices();
    return {
      botId: owner.id, engines: [...owner.headsSettings.engines] as Engine[],
      primary: owner.headsSettings.answerWith && owner.headsSettings.answerWith !== "both" ? owner.headsSettings.answerWith : null,
      primaryEffective: resolvePrimary(owner.headsSettings, owner.appPrimary()),
      model: choices.model as BotSettingsView["model"], effort: choices.effort as BotSettingsView["effort"], efforts: choices.efforts as BotSettingsView["efforts"],
      subagentModel: choices.subagentModel as BotSettingsView["subagentModel"], subagentEffort: choices.subagentEffort as BotSettingsView["subagentEffort"], codexModel: owner.headsSettings.codexModel ?? null,
      agyModel: typeof owner.store.loadSettings().agyModel === "string" ? owner.store.loadSettings().agyModel as string : null,
      codexWorkers: choices.codexWorkers as BotSettingsView["codexWorkers"],
      agyWorkerModel: choices.agyWorkerModel, agyWorkerEffort: choices.agyWorkerEffort as BotSettingsView["agyWorkerEffort"],
      workerMachine: choices.workerMachine,
    };
  }

  /** Changes its own choices; a head already running keeps its own until it next wakes. */
  configure(change: { workerMachine?: string | null; agyModel?: string | null; agyWorkerModel?: string | null; agyWorkerEffort?: string | null; codexWorkers?: { model: string | null; effort: string | null; fast: boolean | null } | null; model?: string | null; effort?: string | null; subagentModel?: string | null; subagentEffort?: string | null; codexModel?: string | null; primary?: Engine | null; efforts?: Partial<Record<Engine, string | null>> }): BotSettingsView {
    const owner = this.owner;
    if (owner.readOnly) throw new ContractError("conflict", owner.problem ?? "Read-only.");
    const before = owner.settingsView();
    if (change.primary !== undefined) {
      // Its own primary engine, or null to follow the app's; one the bot does not have is refused.
      if (change.primary !== null && !owner.headsSettings.engines.includes(change.primary)) throw new ContractError("bad_request", `This bot does not have ${displayName(change.primary)}.`);
      owner.headsSettings.answerWith = change.primary;
      owner.saveHeads();
      owner.headsChanged();
    }
    if (change.efforts) {
      for (const [engine, level] of Object.entries(change.efforts) as [Engine, string | null | undefined][]) {
        if (level && !(EFFORTS_BY_ENGINE[engine] as readonly string[]).includes(level)) throw new ContractError("bad_request", `${displayName(engine)} has no ${level} effort.`);
      }
    }
    // The subagents' effort is read when each worker starts: nothing to restart.
    if (change.subagentEffort && !(EFFORTS_BY_ENGINE.claude as readonly string[]).includes(change.subagentEffort)) throw new ContractError("bad_request", `Claude has no ${change.subagentEffort} effort.`);
    if (change.agyWorkerEffort && !(EFFORTS_BY_ENGINE.agy as readonly string[]).includes(change.agyWorkerEffort)) throw new ContractError("bad_request", `Antigravity has no ${change.agyWorkerEffort} effort.`);
    // The Antigravity workers' model and effort are read when each worker starts, and the Codex workers' choice at a
    // Codex head's next wake (as the app's own Codex workers setting): nothing to restart.
    for (const key of ["model", "effort", "subagentModel", "subagentEffort", "agyModel", "agyWorkerModel", "agyWorkerEffort"] as const) {
      if (change[key] !== undefined) owner.store.saveSetting(key, change[key] ?? undefined);
    }
    // Read when each Claude worker starts: nothing to restart. A machine Settings › Machines does not have is refused.
    if (change.workerMachine !== undefined) {
      const name = change.workerMachine?.trim() || null;
      if (name && name !== "local") {
        const remote = owner.options.remoteWorkers?.();
        if (!remote) throw new ContractError("conflict", "Workers on other machines are not available here.");
        const found = remote.resolve(name);
        if ("error" in found) throw new ContractError("bad_request", found.error.replace(/ Nothing was started\.$/, ""));
        owner.store.saveSetting("workerMachine", found.name);
      } else owner.store.saveSetting("workerMachine", undefined);
    }
    if (change.codexWorkers !== undefined) owner.store.saveSetting("codexWorkers", change.codexWorkers ? codexWorkersJSON(change.codexWorkers) : undefined);
    if (change.codexModel !== undefined) {
      owner.headsSettings.codexModel = change.codexModel ?? null;
      owner.saveHeads();
    }
    // Switching (1.x's `switchModel`, `setEffort`, `setSubagentModel`, a Codex model): awake, each head goes on in
    // the same session on it just before its next message; asleep, the next wake has it.
    const heads = owner.members;
    const name = (model: string) => ({ haiku: "Haiku", sonnet: "Sonnet", opus: "Opus" } as Record<string, string>)[model] ?? model;
    const effortName = (level: string | null) => (level ? ({ low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" } as Record<string, string>)[level] ?? level : "default");
    if (change.model !== undefined && change.model !== before.model) {
      const claude = heads.find((bot) => bot.engine === "claude");
      const model = change.model ? name(change.model) : "Claude's default model";
      if (claude?.head?.running) claude.restartFor({ told: model, shown: model }, true);
      else if (claude) owner.add({ id: newId(), role: "divider", text: `Switched to ${model}`, date: toSwiftDate() });
    }
    if (change.efforts) {
      const saved = owner.store.loadSettings().efforts;
      const merged: Record<string, unknown> = { ...(saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : {}) };
      for (const [engine, level] of Object.entries(change.efforts)) { if (level === undefined) continue; if (level === null) delete merged[engine]; else merged[engine] = level; }
      owner.store.saveSetting("efforts", Object.keys(merged).length ? merged : undefined);
    }
    // An engine whose effort (its own, or the old one it uses) changed: only its heads are told.
    const after = owner.settingsView();
    for (const engine of ["claude", "codex", "agy"] as const) {
      const was = before.efforts?.[engine] ?? null, now = after.efforts?.[engine] ?? null;
      if (was === now) continue;
      for (const bot of heads) if (bot.engine === engine) bot.restartFor({ told: `${now ?? "default"} effort`, shown: `${effortName(now)} effort` }, true);
    }
    if (change.subagentModel !== undefined && change.subagentModel !== before.subagentModel) {
      const model = change.subagentModel;
      for (const bot of heads) if (bot.engine === "claude") bot.restartFor({ told: `subagents on ${model ? name(model) : "the same model"}`, shown: model ? `subagents on ${name(model)}` : "subagents on the same model" });
    }
    if (change.codexModel !== undefined && change.codexModel !== before.codexModel) {
      for (const bot of heads) if (bot.engine === "codex") bot.restartFor({ told: `Codex model ${change.codexModel ?? "default"}`, shown: change.codexModel ?? "Codex's default model" }, true);
    }
    if (change.agyModel !== undefined && change.agyModel !== before.agyModel) {
      for (const bot of heads) if (bot.engine === "agy") bot.restartFor({ told: `Antigravity model ${change.agyModel ?? "default"}`, shown: change.agyModel ?? "Antigravity default" }, true);
    }
    return owner.settingsView();
  }

  saveHeads(engine: Engine = this.switchTo ?? this.engine) {
    if (!this.readOnly) {
      this.store.saveSetting("heads", headsJSON(this.headsSettings));
      this.store.saveSetting("engine", engine);
    }
  }

  /**
   * Runs on the other CLI from now on (1.x's `switchEngine`). Asleep: the next wake starts on it
   * ("Switched to …"). Awake: just before its next message, a handoff — it writes what it is doing
   * into memory.md, ends, and a new session on the other engine reads it (one CLI cannot resume the
   * other's conversation). A running turn or a subagent at work is not cut off.
   */
  switchEngine(to: Engine) {
    if (to === this.engine && !this.switchTo) return;
    if (to === this.engine) { this.switchTo = null; return; }
    if (this.head?.running) { this.switchTo = to; return; }
    this.switchTo = null;
    this.becomeEngine(to);
    this.add({ id: newId(), role: "divider", text: `Switched to ${displayName(to)}`, date: toSwiftDate() });
  }

  /** Its head is `to` now; the next head is a new session. */
  becomeEngine(to: Engine) {
    (this.host as { engine: Engine }).engine = to;
    const saved = to === "agy" ? this.store.loadSettings().agyConversation : null;
    if (typeof saved === "string" && /^[0-9a-f-]{36}$/i.test(saved)) {
      this.sessionResumed(saved);
    } else this.newSession();
    this.store.saveHead(this.session);
    this.saveHeads(to);
  }

  /** The switch can be done now: nothing would be lost (`restartsBeforeMessage`). */
  get switchReady(): boolean {
    return !!this.switchTo && !this.turn && !this.tidying && !this.switching && !!this.head?.running && !this.approvals.size
      && !this.inHeadSubagents.length && !this.managedPending && !this.shuttingDown;
  }

  /**
   * 1.x's `handOver(reason: .engine)`: the old head writes the handoff, ends, a divider "Handoff → …",
   * the new engine's head starts in a new session and reads it (its resume note, with the wake
   * briefing; Codex is given the memory and recent chat, `withSavedMemory`); a reply that is more than
   * OK shows. Then the messages that waited go on.
   */
  async handOver(): Promise<void> {
    const to = this.switchTo;
    const old = this.head;
    if (!to || !old?.running) return;
    this.switchTo = null;
    this.clearIdle();
    this.switching = true;
    this.updated();
    this.log(`handing over to ${displayName(to)}: writing a handoff into memory.md`);
    try {
      // The head that writes it is told in its own terms (1.x sends the new engine's words; see the README).
      const timeout = this.options.tidyTimeoutMs ?? 5 * 60_000;
      const written = await this.maintenance(this.prompts().handoff, timeout, old);
      if (written !== null && !isPlainOK(written)) this.log(`its handoff reply was not a plain OK: ${written.slice(0, 200)}`);
      if (this.shuttingDown) return;
      if (this.head === old && old.running) {
        old.finish();
        const exited = await Promise.race([old.exited.then(() => true), sleep(5_000).then(() => false)]);
        if (!exited) await old.terminate(1_000);
      }
      if (this.shuttingDown) return;
      this.becomeEngine(to);
      this.add({ id: newId(), role: "divider", text: `Handoff → ${displayName(to)}`, date: toSwiftDate() });
      let head: AgentHead;
      try {
        head = this.ensureHead();
      } catch (error) {
        this.add({ id: newId(), role: "error", text: `Restart after handoff failed: ${(error as Error).message}`, date: toSwiftDate() });
        return;
      }
      this.briefingGiven();
      const briefing = [this.wakeNote(), this.componentNote()].filter(Boolean).join("\n\n");
      const resume = this.prompts().resume;
      const reply = await this.maintenance(this.withSavedMemory(briefing ? `${resume}\n\n${briefing}` : resume), timeout, head);
      if (reply && !isPlainOK(reply) && !this.shuttingDown) this.showAppReply(reply);
      if (head.running) this.scheduleIdle();
    } finally {
      this.switching = false;
      this.updated();
      if (!this.shuttingDown) this.next();
    }
  }
}
