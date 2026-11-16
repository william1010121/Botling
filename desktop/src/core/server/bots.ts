// M7-S63: `CoreBots` cut out of `Core` (core/server.ts). The bot list and what changes it: `profiles`, `bots`, `order` and `removed`, making a bot
// (a bot of its own, a plugin's bot), attaching and removing one, the machine a tag names, and the main bot's <new-bot>. Same bridge convention
// as `CoreWatch` (core/server/watch.ts, in its header): a block of one-line forwarders to `host` first, then the members as they were in `Core`,
// byte for byte (a member that `Core` or another collaborator calls lost its `private`).
import { PEER_ID, type BotMaking, type Core } from "../server";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../durable/atomic";
import { launchSettings, readSettings, seedEngineDefaults } from "../settings";
import { HANDED_OUT, botName, firstLine, folderURLText, nextAvatar, prepareNotesFolder, removeProjectRow, saveProjectRow, updateProjectRow } from "../projects";
import { ContractError, PROTOCOL_VERSION, type SubagentRowView } from "../../contract";
import { Bot } from "../bot";
import { headsJSON, singleHead, type Engine } from "../heads";
import { BotStore } from "../store/bot-store";
import { isOpenQuestion } from "../store/records";
import { Layout, projectProfile, type BotProfile } from "../store/workspace";
import { progressFile, progressStatus, subBotBriefing } from "../sub-bots";
import { type BotInfo } from "../plugins";
import { agentStamp } from "../plugins/agent-contributions";
import { siteToolsFolder } from "../site-tools-guard";
import type { CodexThreads } from "../agent/codex";
import type { maintainerEditorBinding } from "../agent/component-editor";

export class CoreBots {
  constructor(private readonly host: Core) {}

  // The bridge: everything this class borrows from `Core`.
  private get activated() { return this.host.activated; }
  private agentPort(...a: Parameters<Core["agentPort"]>) { return this.host.agentPort(...a); }
  private agentsOfRemovedBot(...a: Parameters<Core["agentsOfRemovedBot"]>) { return this.host.agentsOfRemovedBot(...a); }
  private get agents() { return this.host.agents; }
  private agentWiring(...a: Parameters<Core["agentWiring"]>) { return this.host.agentWiring(...a); }
  private botInfo(...a: Parameters<Core["botInfo"]>) { return this.host.botInfo(...a); }
  private botView(...a: Parameters<Core["botView"]>) { return this.host.botView(...a); }
  private briefAwakeMainBot(...a: Parameters<Core["briefAwakeMainBot"]>) { return this.host.briefAwakeMainBot(...a); }
  private checkBot(...a: Parameters<Core["checkBot"]>) { return this.host.checkBot(...a); }
  private get components() { return this.host.components; }
  private get conversations() { return this.host.conversations; }
  private get copies() { return this.host.copies; }
  private developerBriefing(...a: Parameters<Core["developerBriefing"]>) { return this.host.developerBriefing(...a); }
  private get epoch() { return this.host.epoch; }
  private event(...a: Parameters<Core["event"]>) { return this.host.event(...a); }
  private get ledger() { return this.host.ledger; }
  private log(...a: Parameters<Core["log"]>) { return this.host.log(...a); }
  private mainBot(...a: Parameters<Core["mainBot"]>) { return this.host.mainBot(...a); }
  private get maintainer() { return this.host.maintainer; }
  private get mainBotId() { return this.host.mainBotId; }
  private get maintainerId() { return this.host.maintainerId; }
  private makeSubBot(...a: Parameters<Core["makeSubBot"]>) { return this.host.makeSubBot(...a); }
  private nextSeq(...a: Parameters<Core["nextSeq"]>) { return this.host.nextSeq(...a); }
  private get options() { return this.host.options; }
  private ownedAgentsNote(...a: Parameters<Core["ownedAgentsNote"]>) { return this.host.ownedAgentsNote(...a); }
  private pluginBot(...a: Parameters<Core["pluginBot"]>) { return this.host.pluginBot(...a); }
  private get plugins() { return this.host.plugins; }
  private projectBriefing(...a: Parameters<Core["projectBriefing"]>) { return this.host.projectBriefing(...a); }
  private projectRequests(...a: Parameters<Core["projectRequests"]>) { return this.host.projectRequests(...a); }
  private prompts(...a: Parameters<Core["prompts"]>) { return this.host.prompts(...a); }
  private refreshWaiting(...a: Parameters<Core["refreshWaiting"]>) { return this.host.refreshWaiting(...a); }
  private replied(...a: Parameters<Core["replied"]>) { return this.host.replied(...a); }
  private get usage() { return this.host.usage; }

  bots = new Map<string, Bot>();

  order: string[] = [];

  /** Every bot's profile, in the left column's order (Maintainer last). */
  profiles: BotProfile[] = [];

  newBot!: (profile: BotProfile) => Bot;

  /** Makes the `Bot` for a profile (`newBot` adds it to `bots`): what it is given from the core's options and the plugins, every callback reading the core when asked. */
  build(profile: BotProfile, threads: CodexThreads, editorBinding: ReturnType<typeof maintainerEditorBinding>): Bot {
    const options = this.options;
    const codexConfig = options.codexConfig;
    const bot: Bot = new Bot({
      profile,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      deferStartup: options.deferStartup && !this.activated,
      headConfig: options.headConfig,
      agyConfig: options.agyConfig,
      codexConfig: codexConfig ? (p, session) => ({
        ...codexConfig(p, session, threads),
        componentEditor: editorBinding(p, session),
        editorStarted: (pid) => { if (pid > 0) this.ledger.record(pid); },
      }) : null,
      claimWaitMs: options.claimWaitMs,
      prompts: (engine, heads) => this.prompts(profile, engine, heads, profile.role === "main" || profile.id === this.maintainerId ? null : this.plugins.sessionFolder(profile.id)?.cwd ?? profile.folder),
      // A project's manager works in the user's own folder, shared with 1.x: one Botling at a time.
      tidyTimeoutMs: options.tidyTimeoutMs,
      quitTidyMs: options.quitTidyMs,
      ledger: this.ledger,
      emit: (event) => this.event(event),
      log: (line) => this.log(line),
      approvalTimeoutMs: options.approvalTimeoutMs ?? 10 * 60_000,
      idleMs: options.idleMs ?? 50 * 60_000,
      interruptGraceMs: options.interruptGraceMs ?? 2_000,
      projectBriefing: profile.role === "main" ? () => this.projectBriefing() : undefined,
      // The main bot wakes with the project list (`mainBot.wakeNote`) and may write every inbox (`--add-dir`).
      wakeNote: profile.role === "main" ? () => this.projectBriefing()
        // The developer project's manager hears what developer mode lets it do (`developerBriefing`).
        : profile.id !== this.maintainerId
          ? () => [profile.role === "manager" ? this.developerBriefing(profile.id) : "", this.plugins.sessionFolder(profile.id)?.note ?? "", this.subBotNote(profile), this.ownedAgentsNote(profile)].filter(Boolean).join("\n\n")
          : undefined,
      // A plugin may decide where a project's or bot's session starts (an app-made worktree: botling.git); the main bot and Maintainer never move.
      worktree: profile.role === "main" || profile.id === this.maintainerId ? undefined : () => {
        const folder = this.plugins.sessionFolder(profile.id);
        return folder && folder.cwd !== profile.folder ? { cwd: folder.cwd, addDirs: folder.addDirs } : null;
      },
      addDirs: profile.role === "main" ? () => this.profiles.filter((other) => other.role !== "main" && !other.parent && !other.problem).map((other) => join(other.folder, ".bot"))
        // Maintainer: the folders you let it read (<need-folder>).
        // and the browser's site tools, which are its alone.
        : profile.id === this.maintainerId ? () => [siteToolsFolder(options.dataDir, options.app?.dataDir), ...this.maintainer.approvedFolders()] : undefined,
      // Every other bot's Claude head and workers are refused writes into the site tools folder (site-tools-guard.ts).
      siteToolsFolder: profile.id === this.maintainerId ? undefined : siteToolsFolder(options.dataDir, options.app?.dataDir),
      remoteWorkers: () => options.remoteWorkers ?? null,
      subBotRows: profile.role === "main" || profile.id === this.maintainerId ? undefined : () => this.subBotRows(profile.id),
      components: this.components,
      onRequests: (bot, requests) => this.maintainer.handle(bot, this.projectRequests(bot, requests)),
      // What each turn used, by bot, and the subscriptions' limits (1.x's `record`, `note`).
      usage: (name, spent, tokens) => this.usage.record(spent, tokens, name),
      rateLimits: (engine, limits) => this.usage.note(engine, limits),
      // What a line shows besides itself for the component studio (botling.component-studio, through its seam): the library component a
      // reply already is. The studio draws its chips under replies itself (chat.decorate).
      lineExtras: (_bot, record) => this.plugins.studioLineExtras(record),
      replyFilter: (): ((text: string) => Promise<string>) | null => this.plugins.afterReplyFilter(() => this.botInfo(bot)),
      replied: (bot, record) => this.replied(bot, record),
      pluginTags: (bot, tags) => this.plugins.replyTags(this.botInfo(bot), tags),
      plugins: () => this.agentWiring(),
      pluginStamp: () => agentStamp(this.plugins.registry),
      launch: () => launchSettings(readSettings(Layout.settings(this.options.dataDir))),
      // (Asked while the bots are made, before the conversations exist.)
      guest: () => this.conversations?.speakers.get(profile.id) ?? null,
      callIns: () => this.conversations?.callIns(profile.id) ?? [],
      answeringIn: () => this.conversations?.answeringIn(profile.id) ?? null,
      callInNote: () => this.conversations?.callInStatus(profile.id) ?? null,
      callInFollowUp: (caller, asked, record, by) => this.conversations?.callInFollowUp(caller, bot, asked, record, by),
      callInFollowUpMissed: (caller, asked, why, by) => this.conversations?.callInFollowUpMissed(caller, bot, asked, why, by),
      agents: this.agentPort(profile),
      ...(options.deferTurn ? { deferTurn: options.deferTurn } : {}),
      ...(options.botStore ? { botStore: options.botStore } : {}),
    });
    return bot;
  }

  /** Bots taken out of the left column: what they still say goes nowhere. */
  removed = new Set<string>();

  /** Bots plugins made that you removed (`plugin/name`, lower case; removed-bots.json), so they stay removed. */
  removedPluginBots = new Set<string>();

  /**
   * Makes a bot of its own (`Workspace.makeBot`): a folder under <data>/bots/, a row in the left column,
   * its own memory, inbox and routines like a manager. One by the same name (ignoring case) is given
   * back as it is; a plugin gets back only one it made itself, and never one you removed. `setUp` sends
   * it its job at once, so it introduces itself and writes its routines.
   */
  makeBot(rawName: string, rawJob: string, options: { avatar?: string; setUp?: boolean; by?: string | null; plugin?: string | null; delegation?: "onRequest"; instructions?: string } = {}): BotMaking {
    const name = botName(rawName);
    const job = rawJob.trim();
    if (!name || !job) return { kind: "empty" };
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const existing = this.profiles.find((profile) => profile.role === "bot" && !profile.parent && same(profile.name, name));
    if (existing) return !options.plugin || existing.plugin === options.plugin ? { kind: "existing", botId: existing.id } : { kind: "taken" };
    // A name that would pass for someone else in a group chat or in an @.
    const others = ["Main bot", "Maintainer", "User", "App", "Notice", ...this.profiles.filter((profile) => profile.role === "manager").map((profile) => profile.name)];
    if (others.some((other) => same(other, name))) return { kind: "taken" };
    if (options.plugin && this.removedPluginBots.has(`${options.plugin}/${name}`.toLowerCase())) return { kind: "removedByUser" };
    const id = randomUUID().toUpperCase();
    const folder = Layout.standalone(this.options.dataDir, id);
    mkdirSync(folder, { recursive: true });
    const avatar = options.avatar && HANDED_OUT.includes(options.avatar) ? options.avatar : nextAvatar(this.profiles.filter((profile) => profile.role !== "main" && profile.id !== this.maintainerId).map((profile) => profile.avatar));
    prepareNotesFolder(folder);
    this.seedEngineDefaults(id);
    // A plugin's bot that does its work itself runs on Claude, the engine whose coordinator has tools of its own.
    if (options.delegation) this.singleEngine(id, "claude");
    const instructionsFile = this.writeInstructions(folder, id, false, options.instructions);
    const extras = { ...(options.plugin ? { plugin: options.plugin } : {}), ...(options.delegation ? { delegation: options.delegation } : {}), ...(instructionsFile ? { instructionsFile } : {}) };
    saveProjectRow(this.options.dataDir, { id, name, folder, avatar, job, ...extras });
    const profile = projectProfile(this.options.dataDir, { id, name, folder: folderURLText(folder), avatar, job, ...extras });
    this.attach(profile);
    this.mainBot()?.appNotice(`${options.by ? `New bot "${name}" (made by ${options.by})` : `New bot "${name}"`}: ${firstLine(job)}`, undefined, undefined, { sourceID: id });
    this.briefAwakeMainBot();
    if (options.setUp) {
      try {
        this.bots.get(id)?.relay(`(App) You were just created. Your job: ${job}\nIf it should happen at fixed times, add those jobs to your routines file now; if it is a report, also do the first one now. Then introduce yourself to the user in one sentence.`);
      } catch (error) { this.log(`new bot ${name}: ${(error as Error).message}`); }
    }
    this.log(`made the bot ${name} (${folder})`);
    return { kind: "made", botId: id };
  }

  /**
   * A plugin's `bots.create`: a bot of its own in the left column, or with `parent` a hidden sub bot under that project bot (or bot
   * of its own), in its folder. `instructions` (any length) go to a file the bot is told to read; `delegation: "onRequest"` makes it
   * do its work itself, starting subagents or workers only when the user asks (on Claude, the engine that can). Asked again by the
   * same plugin with the same name, the same bot comes back, its instructions and delegation set anew when given. Throws why not.
   */
  createPluginBot(plugin: string, title: string, input: { name: string; job: string; avatar?: string; parent?: string; instructions?: string; delegation?: "default" | "onRequest" }): BotInfo & { created: boolean } {
    const delegation = input.delegation === "onRequest" ? "onRequest" as const : undefined;
    const info = (id: string, created: boolean) => {
      const bot = this.bots.get(id);
      if (!bot) throw new Error("The bot could not be started.");
      return { ...this.botInfo(bot), created };
    };
    if (input.parent !== undefined) {
      const parent = this.pluginBot(input.parent)?.profile;
      if (!parent) throw new Error("No such bot.");
      if (parent.role === "main" || parent.id === this.maintainerId) throw new Error("A sub bot's parent is a project bot or a bot of its own, not the main bot or Maintainer.");
      if (parent.parent) throw new Error("A sub bot cannot have a sub bot of its own; name its project bot as the parent.");
      const name = botName(input.name);
      if (!name || !input.job.trim()) throw new Error("A bot needs a name and a job.");
      const existing = this.profiles.find((profile) => profile.parent === parent.id && !this.removed.has(profile.id) && profile.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (existing.plugin !== plugin) throw new Error(`The name "${name}" is taken by another sub bot of "${parent.name}".`);
        this.setPluginBotExtras(existing, input.instructions, input.delegation);
        return info(existing.id, false);
      }
      const id = this.makeSubBot(parent, name, input.job.trim().slice(0, 1_000), undefined, delegation ? "claude" : undefined, { plugin, delegation, instructions: input.instructions });
      const progress = progressFile(parent.folder, id);
      mkdirSync(join(progress, ".."), { recursive: true });
      writeFileAtomic(progress, "Status: working\n");
      this.bots.get(parent.id)?.appNotice(`New sub bot "${name}" (made by plugin "${title}").`, undefined, undefined, { sourceID: id });
      return info(id, true);
    }
    const made = this.makeBot(input.name, input.job, { avatar: input.avatar, by: `plugin "${title}"`, plugin, delegation, instructions: input.instructions });
    if (made.kind === "empty") throw new Error("A bot needs a name and a job.");
    if (made.kind === "taken") throw new Error(`The name "${input.name}" is taken (by another bot, a project, or the app).`);
    if (made.kind === "removedByUser") throw new Error(`The user removed the bot "${input.name}"; it is not made again.`);
    if (made.kind === "existing") {
      const profile = this.profiles.find((candidate) => candidate.id === made.botId);
      if (profile) this.setPluginBotExtras(profile, input.instructions, input.delegation);
    }
    return info(made.botId, made.kind === "made");
  }

  /** Where a plugin's instructions for a bot are kept: its own notes folder (a sub bot's under the shared .bot/sub-bots/<id>/). */
  private instructionsPath(folder: string, id: string, parent: boolean): string {
    return parent ? join(folder, ".bot", "sub-bots", id, "instructions.md") : join(folder, ".bot", "instructions.md");
  }

  /** Writes a plugin's instructions for a new bot; the path for its projects.json row (undefined: none given). */
  writeInstructions(folder: string, id: string, parent: boolean, instructions: string | undefined): string | undefined {
    if (instructions === undefined || !instructions.trim()) return undefined;
    const file = this.instructionsPath(folder, id, parent);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileAtomic(file, instructions);
    return file;
  }

  /** The same plugin asked again for a bot it made: new instructions and delegation, when given, in its file, row and profile. */
  private setPluginBotExtras(profile: BotProfile, instructions: string | undefined, delegation: "default" | "onRequest" | undefined) {
    const patch: Record<string, unknown> = {};
    const file = this.writeInstructions(profile.folder, profile.id, Boolean(profile.parent), instructions);
    if (file && profile.instructionsFile !== file) { profile.instructionsFile = file; patch.instructionsFile = file; }
    if (delegation === "onRequest" && profile.delegation !== "onRequest") { profile.delegation = "onRequest"; patch.delegation = "onRequest"; }
    if (delegation === "default" && profile.delegation) { delete profile.delegation; patch.delegation = undefined; }
    if (Object.keys(patch).length) updateProjectRow(this.options.dataDir, profile.id, patch);
  }

  /** A sub bot (a hidden bot under a project bot) as opposed to a bot in the left column. */
  isSubBot(id: string): boolean {
    return Boolean(this.profiles.find((profile) => profile.id === id)?.parent);
  }

  /** The rows a project bot's subagent list shows for its sub bots: each opens as a chat with an input box. */
  subBotRows(parentId: string): SubagentRowView[] {
    return this.profiles.filter((profile) => profile.parent === parentId && !this.removed.has(profile.id)).map((profile) => ({
      id: profile.id, title: profile.name.slice(0, 400), status: "running" as const, head: "claude" as const, outputTokens: null,
      startedAt: profile.createdAt ?? 0, endedAt: null, unsettledAt: null, settled: false, prompt: (profile.job ?? "").slice(0, 1_000), subBot: profile.id,
    }));
  }

  /** The note a project bot wakes with when it has sub bots: who, and the progress file to read instead of waking them. */
  subBotNote(profile: BotProfile): string {
    return subBotBriefing(this.profiles.filter((sub) => sub.parent === profile.id && !this.removed.has(sub.id)).map((sub) => {
      const file = progressFile(profile.folder, sub.handoff ?? sub.id);
      let status: string | null = null;
      try { status = progressStatus(readFileSync(file, "utf8")); } catch { /* not written yet */ }
      return { name: sub.name, progress: file, working: Boolean(this.bots.get(sub.id)?.view().working), status };
    }), profile.role === "main" ? "Main bot" : profile.name);
  }

  /** The store of the bot kept in `directory`: 2.x's files, or Botling 3's server store (`CoreOptions.botStore`). */
  storeOf(directory: string): BotStore {
    return this.options.botStore ? this.options.botStore(directory) : new BotStore(directory);
  }

  /** A new bot runs on one engine, as a single head (saved before it is made). */
  singleEngine(id: string, engine: Engine) {
    const store = this.storeOf(Layout.bot(this.options.dataDir, id));
    store.saveSetting("heads", headsJSON(singleHead(engine)));
    store.saveSetting("engine", engine);
  }

  /** The app's engine defaults saved into a new bot's bot.json before it is made (`seedEngineDefaults`). */
  seedEngineDefaults(id: string) {
    const store = this.storeOf(Layout.bot(this.options.dataDir, id));
    seedEngineDefaults(readSettings(Layout.settings(this.options.dataDir)), (key, value) => store.saveSetting(key, value));
  }

  /** A new project's or bot's row in the left column, before Maintainer (who stays last). */
  attach(profile: BotProfile): Bot {
    const at = this.profiles.findIndex((candidate) => candidate.id === this.maintainerId);
    this.profiles.splice(at < 0 ? this.profiles.length : at, 0, profile);
    const bot = this.newBot(profile);
    const orderAt = this.order.indexOf(this.maintainerId);
    this.order.splice(orderAt < 0 ? this.order.length : orderAt, 0, profile.id);
    this.event({ type: "bot.updated", bot: this.botView(bot) });
    return bot;
  }

  /** This machine's name as the main bot's tags name it (`machineName`, M5-04c), one clean line; "" when none is given. */
  private ownMachine(): string {
    const name = typeof this.options.machineName === "function" ? this.options.machineName() : this.options.machineName;
    return botName(name ?? "");
  }

  /**
   * The machine a tag's `machine="…"` names (M5-04d), matched without case against the peers' names (one clean line each):
   * this machine, one peer, none, or more than one with that name. The peer list needs a way to send, and an id that is
   * not a plain id is never a target (a peer's rows are schema-checked only).
   */
  machineNamed(raw: string): { kind: "here" } | { kind: "peer"; id: string; name: string } | { kind: "ambiguous"; name: string } | { kind: "unknown"; name: string } {
    const name = botName(raw);
    const key = name.toLowerCase();
    const peers = this.options.remoteCommand ? (this.options.machines?.() ?? []).map((machine) => ({ id: machine.id, name: botName(machine.name) }))
      .filter((machine) => machine.name && PEER_ID.test(machine.id)) : [];
    const found = peers.filter((machine) => machine.name.toLowerCase() === key);
    const own = this.ownMachine();
    if (own && own.toLowerCase() === key) return found.length ? { kind: "ambiguous", name } : { kind: "here" };
    if (found.length === 1) return { kind: "peer", id: found[0]!.id, name: found[0]!.name };
    return { kind: found.length ? "ambiguous" : "unknown", name };
  }

  /**
   * What the main bot is told about its acts on other machines (M5-04d): a line in its chat, and the same words as an
   * `(App: …)` note with its next message. The line is what keeps it: `queueNote` holds one note and none for a bot that is
   * not awake, and an outcome from another machine can come late (after a sleep, or two in one turn).
   */
  tellMain(words: (part: (text: string) => string) => string) {
    const main = this.mainBot();
    // The chat line is markdown: a peer's name or reason such as `[x](https://…)` must stay text, never a link (review
    // M5-04d); the note goes to the model as written.
    main?.appNotice(words(plainMarkdown));
    main?.queueNote(`(App: ${words((text) => text)})`);
  }

  /** The main bot's (or Maintainer's) <new-bot name="…">job</new-bot>: made and set up, or why not. */
  botRequested(name: string, job: string, by: string | null) {
    const main = this.mainBot();
    const made = this.makeBot(name, job, { setUp: true, by });
    if (made.kind === "existing") {
      const old = this.bots.get(made.botId)!;
      main?.appNotice(`There is already a bot called "${old.profile.name}"; nothing new was made. To change its job, tell it, or remove it from its menu first.`, undefined, undefined, { sourceID: made.botId });
    } else if (made.kind === "taken") {
      main?.appNotice(`No bot was made: the name "${botName(name)}" is already used by a project or the app.`);
    }
  }

  /**
   * Takes a bot of its own (`Workspace.removeBot`) — or, in 2.0, a project — out of the left column and
   * stops it. Nothing on disk is deleted: its folder (memory, results; a project's own files and .bot/)
   * and its chat files stay. Its questions copied into the main bot's chat can no longer be answered.
   */
  async removeBot(id: string, { quiet = false }: { quiet?: boolean } = {}): Promise<{ removed: boolean }> {
    this.checkBot(id);
    const profile = this.profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new ContractError("not_found", "No such bot.");
    if (profile.role === "main" || id === this.mainBotId || id === this.maintainerId) throw new ContractError("forbidden", "The main bot and Maintainer cannot be removed.");
    // Its sub bots go with it (they hang under it, in its folder).
    for (const sub of this.profiles.filter((candidate) => candidate.parent === id)) await this.removeBot(sub.id);
    const bot = this.bots.get(id);
    // Its agents (reconcile rules 4 and 5, at once): ones it ran for another owner are lost; ones it owned go back to their host.
    this.agentsOfRemovedBot(id);
    this.removed.add(id);
    this.profiles = this.profiles.filter((candidate) => candidate.id !== id);
    this.order = this.order.filter((candidate) => candidate !== id);
    this.bots.delete(id);
    removeProjectRow(this.options.dataDir, id);
    if (profile.plugin) {
      this.removedPluginBots.add(`${profile.plugin}/${profile.name}`.toLowerCase());
      writeFileAtomic(join(this.options.dataDir, "removed-bots.json"), JSON.stringify([...this.removedPluginBots].sort()));
    }
    const main = this.mainBot();
    for (const [copy, source] of [...this.copies]) {
      if (source.botId !== id) continue;
      this.copies.delete(copy);
      main?.settleAppQuestion(copy, { answer: "No longer needed" });
    }
    for (const copy of main?.guests.openCopies(id) ?? []) main?.settleAppQuestion(copy.id, { answer: "No longer needed" });
    // Its cards relayed into the chat that called it in (`callInFollowUp`: a copy naming its original) go the same way:
    // their original is gone with it (spec/models/callin/RelayedCard.tla, NoCopyOfGone).
    for (const chat of this.bots.values()) {
      for (const copy of chat.lines()) {
        if (copy.role === "bot" && copy.sourceID === id && typeof copy.sourceMessageID === "string" && isOpenQuestion(copy)) {
          chat.settleAppQuestion(copy.id, { answer: "No longer needed" });
        }
      }
    }
    this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: this.nextSeq(), event: { type: "bot.removed", botId: id } });
    this.plugins.event("botRemoved", { botId: id });
    this.briefAwakeMainBot();
    this.refreshWaiting();
    if (!quiet) main?.appNotice(profile.role === "bot"
      ? `Removed the bot "${profile.name}". Its folder stays at ${profile.folder}.`
      : `Removed the project "${profile.name}" from Botling. Its folder stays at ${profile.folder}, with its notes in .bot/.`);
    this.log(`removed ${profile.role === "bot" ? "the bot" : "the project"} ${profile.name} (${profile.folder} kept)`);
    // It stops at once (no tidy); its chat files stay where they are.
    await bot?.shutdown({ tidy: false }).catch((error) => this.log(`stopping ${profile.name}: ${(error as Error).message}`));
    return { removed: true };
  }
}

/**
 * Text from a peer as plain text in a markdown chat line (Web/src/markdown.ts renders notices): the punctuation that
 * makes links, autolinks, images, code or emphasis is backslash-escaped, which markdown shows as the character itself.
 * A piece can also open the line (`# Big did not make the bot`), so what is special only at the start of a line is
 * escaped at the start of the piece: `#` (heading), `-` and `+` (list, `---` rule) and `1.` (ordered list); `>` and
 * the fence characters are in the set above. Leading spaces go (four of them would make a code block).
 */
function plainMarkdown(text: string): string {
  return text
    .replace(/^\s+/, "")
    .replace(/[\\`*_[\]()<>!|~]/g, "\\$&")
    .replace(/^(?:([#+-])|(\d{1,9})\.)/, (_all, mark: string | undefined, digits: string | undefined) => (mark ? `\\${mark}` : `${digits}\\.`));
}