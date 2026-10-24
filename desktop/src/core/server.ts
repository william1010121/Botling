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
import { Bot } from "./bot";
import type { HeadConfig } from "./agent/head";
import { ProcessLedger } from "./process/ledger";
import { importFrom1x, importRecord, looksLike1x, needsImport } from "./store/importer";
import { MAIN_BOT_ID } from "./store/records";
import { loadProfiles, type BotProfile } from "./store/workspace";

export interface CoreOptions {
  dataDir: string;
  /** How to run a bot's head for a session. */
  headConfig: (profile: BotProfile, session: { sessionId: string; resume: boolean }) => HeadConfig;
  emit: (message: Outbound) => void;
  log?: (line: string) => void;
  /** A Botling 1.x data folder to import from on the first start (read-only). */
  importFrom?: string | null;
  approvalTimeoutMs?: number;
  idleMs?: number;
  interruptGraceMs?: number;
}

export class Core {
  readonly epoch = randomUUID().slice(0, 18);
  private seq = 0;
  private bots = new Map<string, Bot>();
  private order: string[] = [];
  private inflight = new Map<string, AbortController>();
  private readonly ledger: ProcessLedger;
  private imported: ImportView | null = null;

  constructor(private options: CoreOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    this.ledger = new ProcessLedger(join(options.dataDir, "children.json"));
    const leftovers = this.ledger.endLeftovers();
    if (leftovers.length) this.log(`ended agent process groups an earlier core left running: ${leftovers.join(", ")}`);
    this.importOnce();
    const { profiles, problem } = loadProfiles(options.dataDir);
    if (problem) this.log(`projects: ${problem}`);
    for (const profile of profiles) {
      const bot = new Bot({
        profile,
        headConfig: options.headConfig,
        ledger: this.ledger,
        emit: (event) => this.event(event),
        log: (line) => this.log(line),
        approvalTimeoutMs: options.approvalTimeoutMs ?? 10 * 60_000,
        idleMs: options.idleMs ?? 30 * 60_000,
        interruptGraceMs: options.interruptGraceMs ?? 2_000,
        welcome: profile.id === MAIN_BOT_ID && !this.imported,
      });
      this.bots.set(profile.id, bot);
      this.order.push(profile.id);
    }
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
      case "chat.send": return this.bot(cmd.botId).send(cmd.text);
      case "chat.choose": return this.bot(cmd.botId).choose(cmd.messageId, cmd.index);
      case "chat.read": return this.bot(cmd.botId).read();
      case "turn.stop": return this.bot(cmd.botId).stop(cmd.turnId);
      case "turn.await": return this.bot(cmd.botId).await(cmd.turnId, signal);
      case "card.save": return this.bot(cmd.botId).cardSave(cmd.messageId, cmd.cardId, cmd.data);
      case "card.action": return this.bot(cmd.botId).cardAction(cmd.messageId, cmd.cardId, cmd.name, cmd.value);
      case "card.html": return { html: this.bot(cmd.botId).card(cmd.messageId, cmd.cardId).html } satisfies ResultOf<"card.html">;
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
    await Promise.all([...this.bots.values()].map((bot) => bot.shutdown()));
  }
}
