// The core: owns every bot's chat and head, and answers the contract's commands. It is
// transport-agnostic: `receive` takes whatever arrived, `emit` is where answers and events go. It
// validates everything it receives itself — main validating first is defense in depth, not the
// reason the core is safe.
//
// Its data folder has the Swift app's layout (store/workspace.ts). On the first start with an
// empty folder it imports a 1.x folder when one is given (read-only; store/importer.ts).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ContractError, PROTOCOL_VERSION, errorResponse, okResponse, parseInbound,
  type Command, type Event, type ImportView, type Outbound, type ResultOf,
} from "../contract";
import { Bot, type SessionStart, type SessionStartCodex } from "./bot";
import type { HeadConfig } from "./agent/head";
import { CodexThreads, type CodexHeadConfig } from "./agent/codex";
import type { Engine, Heads } from "./heads";
import { botPrompts, isAppLanguage, isResultPublishing, preferredLanguage, type BotPrompts } from "./prompts";
import { readJSON } from "./store/bot-store";
import { DEFAULT_ONE_X_PROCESS, ProjectLock, type OneXCheck } from "./store/lock";
import { ProcessLedger } from "./process/ledger";
import { importFrom1x, importRecord, looksLike1x, needsImport } from "./store/importer";
import { MAIN_BOT_ID } from "./store/records";
import { Layout, loadProfiles, type BotProfile } from "./store/workspace";
import { CatchUpCache, CatchUps, catchUpSettings, type CatchUpViewData, type Summarizer } from "./catchup";
import { ComponentsContext } from "./components/service";
import { readdirSync } from "node:fs";
import { Plugins, type BotInfo } from "./plugins";
import type { HostCommand, HostTiming } from "./plugins/host-client";
import type { Sealer } from "./plugins/secrets";
import { MaintainerDesk, maintainerProfile, prepareLibrary, MAINTAINER_ID } from "./maintainer";
import { maintainerInstructions } from "./maintainer-text";
import type { ChatRecord } from "./store/records";

export interface CoreOptions {
  dataDir: string;
  /** How to run a bot's head for a session. */
  headConfig: (profile: BotProfile, session: SessionStart) => HeadConfig;
  /** How to run a Codex head (threads: <data>/codex-threads); null when Codex is not available. */
  codexConfig?: ((profile: BotProfile, session: SessionStartCodex, threads: CodexThreads) => CodexHeadConfig) | null;
  /** How long the second head waits for the lead's first words (1.x: 20 s). */
  claimWaitMs?: number;
  emit: (message: Outbound) => void;
  log?: (line: string) => void;
  /** A Botling 1.x data folder to import from on the first start (read-only). */
  importFrom?: string | null;
  approvalTimeoutMs?: number;
  idleMs?: number;
  interruptGraceMs?: number;
  tidyTimeoutMs?: number;
  /** How long an awake bot may tidy when the app quits (0: not at all). */
  quitTidyMs?: number;
  /** The system's preferred languages, best first (for bots' reply language when settings name none). */
  languages?: string[];
  /** How to tell that Botling 1.x has a project open (its data folder; null: do not look). */
  oneX?: OneXCheck;
  /** How often routines are checked (1.x: every 30 s); 0: never (tests drive `checkRoutines`). */
  routineTickMs?: number;
  /** Writes Catch-up summaries (an isolated `codex exec`); null: there is no summary service. */
  summarizer?: Summarizer | null;
  /** How often the component library is looked at for changes on disk (0: never; 1.x: 1.5 s). */
  componentScanMs?: number;
  /** The plugin host (null: plugins' program parts do not run) and how secrets are sealed. */
  plugins?: { node: HostCommand | null; hostScript: string; sealer: Sealer | null; timing?: HostTiming } | null;
  /** Maintainer's `ccb plugin check` command (null: none this time). */
  checkCommand?: string | null;
}

export class Core {
  readonly epoch = randomUUID().slice(0, 18);
  private seq = 0;
  private bots = new Map<string, Bot>();
  private order: string[] = [];
  private inflight = new Map<string, AbortController>();
  private readonly ledger: ProcessLedger;
  private imported: ImportView | null = null;
  private routineClock: NodeJS.Timeout | null = null;
  private readonly catchUps: CatchUps;
  private readonly components: ComponentsContext;
  private componentStamp = 0;
  private componentClock: NodeJS.Timeout | null = null;
  private pinClock: NodeJS.Timeout | null = null;
  /** The pins the user can see now, in the chat on screen (`RefreshSight`). */
  private visiblePins: { botId: string; ids: string[] } | null = null;
  readonly plugins: Plugins;
  readonly maintainer: MaintainerDesk;
  private lastPlugins = "";

  constructor(private options: CoreOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    this.catchUps = new CatchUps({
      cache: new CatchUpCache(join(options.dataDir, "catchup-summaries.json")),
      summarizer: options.summarizer ?? null,
      settings: () => catchUpSettings(this.settingsFile()),
      language: () => this.language(),
      changed: (botId) => { const bot = this.bots.get(botId); if (bot) this.event({ type: "catchup.updated", botId, ...this.summaries(bot) }); },
    });
    // The component library: <data>/plugins/ccb-components/components first, then other plugins' components/.
    const plugins = join(options.dataDir, "plugins");
    const own = join(plugins, "ccb-components", "components");
    this.components = new ComponentsContext(options.dataDir, () => {
      let others: string[] = [];
      try { others = readdirSync(plugins).filter((name) => name !== "ccb-components" && !name.startsWith(".")).sort().map((name) => join(plugins, name, "components")); } catch { /* none */ }
      return [own, ...others];
    });
    this.componentStamp = this.components.library.stamp;
    this.components.commands.onChange = (card) => { for (const bot of this.bots.values()) bot.cardChanged(card); };
    this.ledger = new ProcessLedger(join(options.dataDir, "children.json"));
    const leftovers = this.ledger.endLeftovers();
    if (leftovers.length) this.log(`ended agent process groups an earlier core left running: ${leftovers.join(", ")}`);
    this.importOnce();
    const loaded = loadProfiles(options.dataDir);
    if (loaded.problem) this.log(`projects: ${loaded.problem}`);
    // Maintainer (1.x's built-in project): the plugin library is its folder, with the app's files in it.
    const editorModel = this.settingsFile()?.componentEditor;
    const { editedEditor } = prepareLibrary(options.dataDir, typeof editorModel === "string" && ["sonnet", "opus", "haiku"].includes(editorModel) ? editorModel : "sonnet");
    if (editedEditor) this.log("ccb-core/claude/agents/component-editor.md was edited by hand; it is left as it is");
    const profiles = [...loaded.profiles, maintainerProfile(options.dataDir, maintainerInstructions(join(options.dataDir, "plugins"), options.checkCommand ?? null, null))];
    const oneX: OneXCheck = options.oneX ?? { folder: null, process: DEFAULT_ONE_X_PROCESS };
    const threads = new CodexThreads(join(options.dataDir, "codex-threads"));
    const codexConfig = options.codexConfig;
    for (const profile of profiles) {
      const bot: Bot = new Bot({
        profile,
        headConfig: options.headConfig,
        codexConfig: codexConfig ? (p, session) => codexConfig(p, session, threads) : null,
        claimWaitMs: options.claimWaitMs,
        prompts: (engine, heads) => this.prompts(profile, engine, heads),
        // A project's manager works in the user's own folder, shared with 1.x: one Botling at a time.
        lock: profile.role === "manager" && !profile.problem ? new ProjectLock(profile.folder, options.dataDir, oneX) : null,
        tidyTimeoutMs: options.tidyTimeoutMs,
        quitTidyMs: options.quitTidyMs,
        ledger: this.ledger,
        emit: (event) => this.event(event),
        log: (line) => this.log(line),
        approvalTimeoutMs: options.approvalTimeoutMs ?? 10 * 60_000,
        idleMs: options.idleMs ?? 30 * 60_000,
        interruptGraceMs: options.interruptGraceMs ?? 2_000,
        welcome: profile.id === MAIN_BOT_ID && !this.imported,
        projectBriefing: profile.role === "main" ? () => this.projectBriefing(profiles) : undefined,
        components: this.components,
        onRequests: (bot, requests) => this.maintainer.handle(bot, requests),
        replyFilter: (): ((text: string) => Promise<string>) | null => this.plugins.afterReplyFilter(() => this.botInfo(bot)),
        replied: (bot, record) => this.replied(bot, record),
        plugins: () => ({ dirs: this.plugins.registry.claudeDirectories(), env: this.plugins.registry.secretEnvironment() }),
      });
      this.bots.set(profile.id, bot);
      this.order.push(profile.id);
    }
    this.maintainer = new MaintainerDesk({
      root: options.dataDir,
      maintainer: () => this.bots.get(MAINTAINER_ID) ?? null,
      mainBot: () => this.bots.get(MAIN_BOT_ID)!,
      bots: () => [...this.bots.values()],
      library: this.components.library,
      plugins: () => this.plugins,
      rescan: () => this.scanComponents(),
      log: (line) => this.log(`maintainer: ${line}`),
    });
    const host = options.plugins ?? null;
    this.plugins = new Plugins({
      dataDir: options.dataDir,
      node: host?.node ?? null,
      hostScript: host?.hostScript ?? "",
      sealer: host?.sealer ?? null,
      timing: host?.timing,
      onPid: (pid, alive) => (alive ? this.ledger.record(pid) : this.ledger.forget(pid)),
      world: {
        bots: () => this.order.map((id) => this.botInfo(this.bots.get(id)!)),
        send: (botId, text) => {
          const bot = this.bots.get(botId === "main" ? MAIN_BOT_ID : botId);
          try { bot?.send(text); } catch (error) { this.log(`plugin message to ${botId}: ${(error as Error).message}`); }
        },
        notice: (text) => this.bots.get(MAIN_BOT_ID)?.appNotice(text),
        addRoutine: (botId, cron, task) => {
          const bot = this.bots.get(botId === "main" ? MAIN_BOT_ID : botId);
          if (!bot) return "no-bot";
          return bot.addRoutine(cron, task) ? "added" : "bad-schedule";
        },
        changed: (view) => {
          const text = JSON.stringify(view);
          if (text === this.lastPlugins) return;
          this.lastPlugins = text;
          this.event({ type: "plugins.updated", plugins: view });
        },
        broken: (plugin, problem) => this.maintainer.broken(plugin, problem),
        log: (line) => this.log(line),
      },
    });
    // What the snapshot shows already is no event (an event comes only when something changes).
    this.lastPlugins = JSON.stringify(this.plugins.view());
    void this.plugins.start().catch((error) => this.log(`plugins: ${(error as Error).message}`));
    // Checking a wall-clock time every 30 s (rather than sleeping until it) survives the computer
    // sleeping; a time missed while the app was closed runs once later that day (1.x).
    const scan = options.componentScanMs ?? 1_500;
    if (scan > 0) {
      this.componentClock = setInterval(() => this.scanComponents(), scan);
      this.componentClock.unref?.();
    }
    // Pins refreshed every so often that the user can see run when their time comes (1.x: each second).
    this.pinClock = setInterval(() => {
      const seen = this.visiblePins;
      if (seen) this.bots.get(seen.botId)?.refreshDuePins(seen.ids);
    }, 1_000);
    this.pinClock.unref?.();
    const tick = options.routineTickMs ?? 30_000;
    if (tick > 0) {
      setTimeout(() => this.checkRoutines(), 0);
      this.routineClock = setInterval(() => this.checkRoutines(), tick);
      this.routineClock.unref?.();
    }
  }

  /** A template or about.md changed on disk: the page draws it anew; bots hear what changed with their next message. */
  scanComponents() {
    this.plugins.scan();
    const before = this.components.library.names.join("\n");
    const catalogChanged = this.components.library.rescan();
    if (catalogChanged) for (const bot of this.bots.values()) bot.componentsChanged();
    // Components bots asked Maintainer for that are in the library now go on their lists.
    if (catalogChanged || before !== this.components.library.names.join("\n")) this.maintainer.deliverAsked();
    if (this.components.library.stamp !== this.componentStamp) {
      this.componentStamp = this.components.library.stamp;
      this.event({ type: "components.updated", components: this.componentInfos() });
    }
  }

  /** Every library component as the page draws it. */
  private componentInfos(): ResultOf<"chat.snapshot">["components"] {
    const out: ResultOf<"chat.snapshot">["components"] = {};
    for (const name of this.components.library.names) {
      const info = this.components.library.info(name);
      if (info) out[name] = { ...info, template: info.template.slice(0, 1_000_000), sizes: info.sizes.slice(0, 16), title: info.title?.slice(0, 200) ?? null };
    }
    return out;
  }

  /** Every bot's routines that are due run now (`Workspace.checkRoutines`). */
  checkRoutines(now = Date.now()) {
    for (const bot of this.bots.values()) {
      try { bot.checkRoutines(now); } catch (error) { this.log(`routines of ${bot.profile.name}: ${(error as Error).message}`); }
    }
  }

  /**
   * What the main bot's routines are told about the projects (`Workspace.projectBriefing`), without
   * what 2.0 does not have yet: inboxes (nothing delivers them) and teams.
   */
  private projectBriefing(profiles: BotProfile[]): string {
    const memory = (profile: BotProfile) => join(profile.folder, profile.memoryPath);
    const projects = profiles.filter((profile) => profile.role === "manager" && profile.id !== MAINTAINER_ID);
    const own = profiles.filter((profile) => profile.role === "bot");
    const maintainer = profiles.find((profile) => profile.id === MAINTAINER_ID);
    const projectLines = projects.length ? projects.map((profile) => `- ${profile.name} (folder ${profile.folder}): memory file ${memory(profile)}`).join("\n") : "(No projects yet.)";
    const botLines = own.length ? "\n(App: Bots of their own, which you check the same way.)\n" + own.map((profile) => `- ${profile.name} (${(profile.job ?? "").split("\n")[0]}): memory file ${memory(profile)}`).join("\n") : "";
    const maintainerLine = maintainer ? `\n- Maintainer (plugin-library extensions and in-chat components only): memory file ${memory(maintainer)}` : "";
    return `(App: Project list. To check progress, read the memory file and do not wake the manager.)\n${projectLines}${botLines}${maintainerLine}`;
  }

  private importOnce() {
    const source = this.options.importFrom;
    const root = this.options.dataDir;
    if (source && needsImport(root)) {
      if (looksLike1x(source)) {
        try {
          const report = importFrom1x(source, root);
          this.log(`imported ${report.bots.length} bot(s) and ${report.messages} message(s) from ${source} (read-only); skipped ${report.skipped.length}`);
        } catch (error) {
          this.log(`import from ${source} failed: ${(error as Error).message}`);
        }
      } else {
        this.log(`nothing to import: ${source} is not a Botling 1.x data folder`);
      }
    }
    const report = importRecord(root);
    if (report) {
      this.imported = {
        source: report.source.slice(0, 4_000), at: report.at, bots: report.bots.length, messages: report.messages,
        skipped: report.skipped.slice(0, 200).map((entry) => entry.slice(0, 2_000)),
      };
    }
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  /** How plugins see a bot (`Workspace.info(for:)`): "main", or its id. */
  private botInfo(bot: Bot): BotInfo {
    return { id: bot.id === MAIN_BOT_ID ? "main" : bot.id, name: bot.profile.name, role: bot.profile.role, awake: bot.awake };
  }

  /** A reply showed: plugins listening hear it; Maintainer's settles the component changes bots asked for. */
  private replied(bot: Bot, record: ChatRecord) {
    if (record.text) this.plugins.replied(this.botInfo(bot), record.text);
    if (bot.id === MAINTAINER_ID) this.maintainer.settle(record);
  }

  /** Your message through the plugins' beforeSend hooks first; one can change it or stop it (`Workspace.send`). */
  private async send(botId: string, text: string, options: { replyTo?: string; to?: "both" | "claude" | "codex" }): Promise<ResultOf<"chat.send">> {
    const bot = this.bot(botId);
    const outcome = await this.plugins.beforeSend(this.botInfo(bot), text);
    if ("stoppedBy" in outcome) {
      const plugin = this.plugins.registry.plugin(outcome.stoppedBy);
      const name = plugin ? (plugin.manifest.displayName ?? plugin.manifest.name) : outcome.stoppedBy;
      const messageId = bot.appNotice(`Plugin "${name}" stopped this message: ${text}`);
      return { messageId, turnId: null, stoppedBy: outcome.stoppedBy };
    }
    return bot.send(outcome.send.slice(0, 100_000) || text, options);
  }

  private settingsFile(): Record<string, unknown> | undefined {
    try {
      const value = readJSON(Layout.settings(this.options.dataDir));
      return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /** settings.json as 1.x writes it (`AppSettings`): only the keys the prompts need. */
  private settings(): { language: string | undefined; results: string | undefined } {
    const value = this.settingsFile();
    return { language: value?.languageChoice as string | undefined, results: value?.resultPublishingChoice as string | undefined };
  }

  /** The app's language: settings.json's, else the system's (`AppLanguage.preferred`). */
  private language() {
    const settings = this.settings();
    return isAppLanguage(settings.language) ? settings.language : preferredLanguage(this.options.languages ?? [Intl.DateTimeFormat().resolvedOptions().locale]);
  }

  private summaries(bot: Bot): { catchUp: CatchUpViewData | null; intervalSummaries: CatchUpViewData[] } {
    const views = this.catchUps.views(bot.catchUpChat());
    return { catchUp: views.catchUp, intervalSummaries: views.intervalSummaries.slice(-200) };
  }

  /** The bot's instructions (Prompts.swift's), from its profile and the app's settings. */
  prompts(profile: BotProfile, engine: Engine = "claude", heads: Heads | null = null): BotPrompts {
    const settings = this.settings();
    const languages = this.options.languages ?? [Intl.DateTimeFormat().resolvedOptions().locale];
    return botPrompts({
      profile: { ...profile, instructions: profile.instructions ?? null },
      language: isAppLanguage(settings.language) ? settings.language : preferredLanguage(languages),
      results: isResultPublishing(settings.results) ? settings.results : "artifactUnlessSensitive",
      engine,
      heads: heads && heads.engines.length > 1 ? { handoffs: heads.handoffs, limits: heads.limits } : null,
    });
  }

  private event(event: Event) {
    this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: ++this.seq, event });
    // Your line closes an interval: it may be summarized by itself (`summarizeClosedInterval`).
    if (event.type === "message.added" && event.message.role === "user") {
      const bot = this.bots.get(event.botId);
      if (bot) this.catchUps.closedInterval(bot.catchUpChat(), event.message.id);
    }
  }

  /** Handles one message from main. Exactly one response per request id, cancelled or not. */
  receive(raw: unknown) {
    const parsed = parseInbound(raw);
    if (!parsed.ok) {
      this.log(`refused: ${parsed.error.code} ${parsed.error.message}`);
      if (parsed.id) this.options.emit(errorResponse(parsed.id, parsed.error));
      return;
    }
    const message = parsed.value;
    if ("cancel" in message) {
      this.inflight.get(message.cancel)?.abort();
      return;
    }
    if (this.inflight.has(message.id)) {
      this.options.emit(errorResponse(message.id, { code: "conflict", message: "A request with this id is already running." }));
      return;
    }
    const controller = new AbortController();
    this.inflight.set(message.id, controller);
    const cancelled = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new ContractError("cancelled", "The request was cancelled."))),
    );
    cancelled.catch(() => {});
    Promise.resolve()
      .then(() => Promise.race([this.handle(message.cmd, controller.signal), cancelled]))
      .then((result) => this.options.emit(okResponse(message.id, result)))
      .catch((error) => {
        const wire = error instanceof ContractError ? error.toWire() : { code: "internal" as const, message: String((error as Error)?.message ?? error) };
        if (wire.code === "internal") this.log(`internal error: ${(error as Error)?.stack ?? error}`);
        this.options.emit(errorResponse(message.id, wire));
      })
      .finally(() => this.inflight.delete(message.id));
  }

  private bot(id: string): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw new ContractError("not_found", "No such bot.");
    return bot;
  }

  private async handle(cmd: Command, signal: AbortSignal): Promise<unknown> {
    switch (cmd.type) {
      case "chat.snapshot": return this.snapshot(cmd.botId);
      case "chat.send": return this.send(cmd.botId, cmd.text, { replyTo: cmd.replyTo, to: cmd.to });
      case "plugins.list": return this.plugins.view();
      case "plugins.enable": return this.plugins.setEnabled(cmd.name, cmd.enabled);
      case "plugins.setting": return this.plugins.setSetting(cmd.name, cmd.key, cmd.value);
      case "plugins.secret": return this.plugins.setSecret(cmd.name, cmd.key, cmd.value);
      case "plugins.command": return { result: await this.plugins.command(cmd.id) ?? null };
      case "plugins.panel": return this.plugins.panel(cmd.name, cmd.panel);
      case "plugins.call": return { result: await this.plugins.call(cmd.name, cmd.method, cmd.params) ?? null };
      case "heads.set": return this.bot(cmd.botId).setHeads(cmd.engines);
      case "heads.answerWith": return this.bot(cmd.botId).setAnswerWith(cmd.to);
      case "handoff.stop": return this.bot(cmd.botId).stopHandoff(cmd.handoffId);
      case "rounds.stop": return this.bot(cmd.botId).stopRounds();
      case "chat.choose": return this.bot(cmd.botId).choose(cmd.messageId, cmd.index, cmd.text);
      case "chat.answer": return this.bot(cmd.botId).answer(cmd.messageId, cmd.text);
      case "chat.react": return this.bot(cmd.botId).react(cmd.messageId, cmd.emoji, cmd.present);
      case "subagent.view": return this.bot(cmd.botId).subagentView(cmd.subagentId);
      case "chat.read": {
        // You came back to it: many unread replies fold into a summary first (`arrive(at:)`).
        const bot = this.bot(cmd.botId);
        this.catchUps.arrive(bot.catchUpChat());
        return bot.read();
      }
      case "component.command": return this.bot(cmd.botId).componentCommand(cmd.messageId, cmd.index, cmd);
      case "component.detail": return this.bot(cmd.botId).componentDetail(cmd.name, cmd.folder, cmd.values, cmd.card, cmd.command);
      case "component.save": return this.bot(cmd.botId).componentSave(cmd.messageId, cmd.index, cmd.data);
      case "pin.add": return this.bot(cmd.botId).pinAdd(cmd.id, { messageId: cmd.messageId, index: cmd.index, name: cmd.name }, cmd.refresh, cmd.minutes, cmd.seconds);
      case "pin.change": return this.bot(cmd.botId).pinChange(cmd.id, cmd.change);
      case "pin.arrange": return this.bot(cmd.botId).pinArrange(cmd.places);
      case "pin.command": return this.bot(cmd.botId).pinCommand(cmd.id, cmd);
      case "pin.shown": {
        const bot = this.bot(cmd.botId);
        if (cmd.visible) {
          this.visiblePins = { botId: cmd.botId, ids: cmd.ids ?? [] };
          return { ran: bot.refreshDuePins(cmd.ids ?? []) };
        }
        return bot.pinsShown(cmd.ids);
      }
      case "card.image": {
        const file = this.components.images.file(cmd.token);
        if (!file) throw new ContractError("not_found", "No such picture.");
        return file satisfies ResultOf<"card.image">;
      }
      case "catchup.retry": return { started: this.catchUps.retry(this.bot(cmd.botId).catchUpChat(), cmd.key) };
      case "catchup.interval": return { started: this.catchUps.interval(this.bot(cmd.botId).catchUpChat(), cmd.userMessageId) };
      case "turn.stop": return this.bot(cmd.botId).stop(cmd.turnId);
      case "turn.await": return this.bot(cmd.botId).await(cmd.turnId, signal);
      case "card.save": return this.bot(cmd.botId).cardSave(cmd.messageId, cmd.cardId, cmd.data);
      case "card.action": return this.bot(cmd.botId).cardAction(cmd.messageId, cmd.cardId, cmd.name, cmd.value);
      case "card.html": return { html: this.bot(cmd.botId).card(cmd.messageId, cmd.cardId).html } satisfies ResultOf<"card.html">;
      case "routines.list": return this.bot(cmd.botId).routinesView();
      case "routines.change": {
        const { type: _type, botId: _bot, requestId, ...rest } = cmd;
        return this.bot(cmd.botId).changeRoutine({ ...rest, ...(requestId ? { request_id: requestId } : {}) });
      }
      default: throw new ContractError("not_found", `The core does not handle ${cmd.type}.`);
    }
  }

  snapshot(botId?: string): ResultOf<"chat.snapshot"> {
    const bot = this.bots.get(botId ?? MAIN_BOT_ID);
    if (botId && !bot) throw new ContractError("not_found", "No such bot.");
    return {
      epoch: this.epoch,
      seq: this.seq,
      bots: this.order.map((id) => this.bots.get(id)!.view()),
      imported: this.imported,
      chat: bot ? { ...bot.snapshot(), ...this.summaries(bot) } : null,
      components: this.componentInfos(),
      plugins: this.plugins.view(),
    };
  }

  /** Ends every turn and head (with their trees) and writes everything out; for quitting. */
  async shutdown() {
    if (this.routineClock) { clearInterval(this.routineClock); this.routineClock = null; }
    if (this.componentClock) { clearInterval(this.componentClock); this.componentClock = null; }
    if (this.pinClock) { clearInterval(this.pinClock); this.pinClock = null; }
    await Promise.all([...this.bots.values()].map((bot) => bot.shutdown()).concat(this.plugins.shutdown()));
  }
}
