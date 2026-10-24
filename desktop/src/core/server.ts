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

  constructor(private options: CoreOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    this.ledger = new ProcessLedger(join(options.dataDir, "children.json"));
    const leftovers = this.ledger.endLeftovers();
    if (leftovers.length) this.log(`ended agent process groups an earlier core left running: ${leftovers.join(", ")}`);
    this.importOnce();
    const { profiles, problem } = loadProfiles(options.dataDir);
    if (problem) this.log(`projects: ${problem}`);
    const oneX: OneXCheck = options.oneX ?? { folder: null, process: DEFAULT_ONE_X_PROCESS };
    const threads = new CodexThreads(join(options.dataDir, "codex-threads"));
    const codexConfig = options.codexConfig;
    for (const profile of profiles) {
      const bot = new Bot({
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
      });
      this.bots.set(profile.id, bot);
      this.order.push(profile.id);
    }
    // Checking a wall-clock time every 30 s (rather than sleeping until it) survives the computer
    // sleeping; a time missed while the app was closed runs once later that day (1.x).
    const tick = options.routineTickMs ?? 30_000;
    if (tick > 0) {
      setTimeout(() => this.checkRoutines(), 0);
      this.routineClock = setInterval(() => this.checkRoutines(), tick);
      this.routineClock.unref?.();
    }
  }

  /** Every bot's routines that are due run now (`Workspace.checkRoutines`). */
  checkRoutines(now = Date.now()) {
    for (const bot of this.bots.values()) {
      try { bot.checkRoutines(now); } catch (error) { this.log(`routines of ${bot.profile.name}: ${(error as Error).message}`); }
    }
  }

  /**
   * What the main bot's routines are told about the projects (`Workspace.projectBriefing`), without
   * what 2.0 does not have yet: inboxes (nothing delivers them), Maintainer and teams.
   */
  private projectBriefing(profiles: BotProfile[]): string {
    const memory = (profile: BotProfile) => join(profile.folder, profile.memoryPath);
    const projects = profiles.filter((profile) => profile.role === "manager");
    const own = profiles.filter((profile) => profile.role === "bot");
    const projectLines = projects.length ? projects.map((profile) => `- ${profile.name} (folder ${profile.folder}): memory file ${memory(profile)}`).join("\n") : "(No projects yet.)";
    const botLines = own.length ? "\n(App: Bots of their own, which you check the same way.)\n" + own.map((profile) => `- ${profile.name} (${(profile.job ?? "").split("\n")[0]}): memory file ${memory(profile)}`).join("\n") : "";
    return `(App: Project list. To check progress, read the memory file and do not wake the manager.)\n${projectLines}${botLines}`;
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

  /** settings.json as 1.x writes it (`AppSettings`): only the keys the prompts need. */
  private settings(): { language: string | undefined; results: string | undefined } {
    try {
      const value = readJSON(Layout.settings(this.options.dataDir)) as Record<string, unknown> | undefined;
      return { language: value?.languageChoice as string | undefined, results: value?.resultPublishingChoice as string | undefined };
    } catch {
      return { language: undefined, results: undefined };
    }
  }

  /** The bot's instructions (Prompts.swift's), from its profile and the app's settings. */
  prompts(profile: BotProfile, engine: Engine = "claude", heads: Heads | null = null): BotPrompts {
    const settings = this.settings();
    const languages = this.options.languages ?? [Intl.DateTimeFormat().resolvedOptions().locale];
    return botPrompts({
      profile,
      language: isAppLanguage(settings.language) ? settings.language : preferredLanguage(languages),
      results: isResultPublishing(settings.results) ? settings.results : "artifactUnlessSensitive",
      engine,
      heads: heads && heads.engines.length > 1 ? { handoffs: heads.handoffs, limits: heads.limits } : null,
    });
  }

  private event(event: Event) {
    this.options.emit({ v: PROTOCOL_VERSION, epoch: this.epoch, seq: ++this.seq, event });
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
      case "chat.send": return this.bot(cmd.botId).send(cmd.text, { replyTo: cmd.replyTo, to: cmd.to });
      case "heads.set": return this.bot(cmd.botId).setHeads(cmd.engines);
      case "heads.answerWith": return this.bot(cmd.botId).setAnswerWith(cmd.to);
      case "handoff.stop": return this.bot(cmd.botId).stopHandoff(cmd.handoffId);
      case "rounds.stop": return this.bot(cmd.botId).stopRounds();
      case "chat.choose": return this.bot(cmd.botId).choose(cmd.messageId, cmd.index, cmd.text);
      case "chat.answer": return this.bot(cmd.botId).answer(cmd.messageId, cmd.text);
      case "chat.react": return this.bot(cmd.botId).react(cmd.messageId, cmd.emoji, cmd.present);
      case "subagent.view": return this.bot(cmd.botId).subagentView(cmd.subagentId);
      case "chat.read": return this.bot(cmd.botId).read();
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
      chat: bot ? bot.snapshot() : null,
    };
  }

  /** Ends every turn and head (with their trees) and writes everything out; for quitting. */
  async shutdown() {
    if (this.routineClock) { clearInterval(this.routineClock); this.routineClock = null; }
    await Promise.all([...this.bots.values()].map((bot) => bot.shutdown()));
  }
}
