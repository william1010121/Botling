// The core: owns the chat, runs agent turns, keeps card data, and answers the contract's commands.
// It is transport-agnostic: `receive` takes whatever arrived, `emit` is where answers and events go.
// It validates everything it receives itself — main validating first is defense in depth, not the
// reason the core is safe.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  ContractError, PROTOCOL_VERSION, MessageView, errorResponse, okResponse, parseInbound,
  type Command, type Event, type Outbound, type ResultOf, type CardView,
} from "../contract";
import { writeFileAtomic } from "./durable/atomic";
import { AgentTurn, type AgentConfig } from "./agent/runner";
import { extractCards, welcomeMessages } from "./cards";
import { ProcessLedger } from "./process/ledger";

export interface CoreOptions {
  dataDir: string;
  /** How to run the agent for a turn, given the chat's session id. */
  agent: (session: { id: string; resume: boolean }) => AgentConfig;
  emit: (message: Outbound) => void;
  log?: (line: string) => void;
}

interface ChatFile { version: 1; sessionId: string; started: boolean; messages: MessageView[] }

interface Running {
  turnId: string;
  messageId: string;
  turn: AgentTurn;
  done: Promise<"done" | "stopped" | "failed">;
  resolve: (status: "done" | "stopped" | "failed") => void;
}

export class Core {
  readonly epoch = randomUUID().slice(0, 18);
  private seq = 0;
  private chat: ChatFile;
  private running: Running | null = null;
  private inflight = new Map<string, AbortController>();
  private finished = new Map<string, "done" | "stopped" | "failed">();
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly file: string;
  private readonly ledger: ProcessLedger;

  constructor(private options: CoreOptions) {
    mkdirSync(options.dataDir, { recursive: true });
    this.file = join(options.dataDir, "chat.json");
    this.ledger = new ProcessLedger(join(options.dataDir, "children.json"));
    const leftovers = this.ledger.endLeftovers();
    if (leftovers.length) this.log(`ended agent process groups an earlier core left running: ${leftovers.join(", ")}`);
    this.chat = this.load();
  }

  private log(line: string) {
    this.options.log?.(line);
  }

  private load(): ChatFile {
    if (!existsSync(this.file)) {
      const fresh: ChatFile = { version: 1, sessionId: randomUUID(), started: false, messages: welcomeMessages() };
      writeFileAtomic(this.file, JSON.stringify(fresh, null, 2));
      return fresh;
    }
    const chat = JSON.parse(readFileSync(this.file, "utf8")) as ChatFile;
    if (chat.version !== 1) throw new Error(`Unsupported chat file version ${chat.version}.`);
    chat.messages = chat.messages.filter((message) => MessageView.safeParse(message).success);
    // A turn that was streaming when the core died is not resumed or re-sent: it is marked.
    let changed = false;
    for (const message of chat.messages) {
      if (message.state === "streaming") {
        message.state = "failed";
        message.text += (message.text ? "\n\n" : "") + "(Interrupted: the core restarted during this reply. It was not sent again.)";
        changed = true;
      }
    }
    if (changed) writeFileAtomic(this.file, JSON.stringify(chat, null, 2));
    return chat;
  }

  private persist(soon = false) {
    if (soon) {
      this.saveTimer ??= setTimeout(() => { this.saveTimer = null; this.persist(); }, 500);
      return;
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    writeFileAtomic(this.file, JSON.stringify(this.chat, null, 2));
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
    Promise.race([this.handle(message.cmd, controller.signal), cancelled])
      .then((result) => this.options.emit(okResponse(message.id, result)))
      .catch((error) => {
        const wire = error instanceof ContractError ? error.toWire() : { code: "internal" as const, message: String((error as Error)?.message ?? error) };
        if (wire.code === "internal") this.log(`internal error: ${(error as Error)?.stack ?? error}`);
        this.options.emit(errorResponse(message.id, wire));
      })
      .finally(() => this.inflight.delete(message.id));
  }

  private async handle(cmd: Command, signal: AbortSignal): Promise<unknown> {
    switch (cmd.type) {
      case "chat.snapshot": return this.snapshot();
      case "chat.send": return this.send(cmd.text);
      case "turn.stop": return this.stop(cmd.turnId);
      case "turn.await": return this.await(cmd.turnId, signal);
      case "card.save": return this.cardSave(cmd.messageId, cmd.cardId, cmd.data);
      case "card.action": return this.cardAction(cmd.messageId, cmd.cardId, cmd.name, cmd.value);
      case "card.html": return { html: this.card(cmd.messageId, cmd.cardId).html } satisfies ResultOf<"card.html">;
      default: throw new ContractError("not_found", `The core does not handle ${cmd.type}.`);
    }
  }

  snapshot(): ResultOf<"chat.snapshot"> {
    return { epoch: this.epoch, seq: this.seq, messages: structuredClone(this.chat.messages), running: this.running?.turnId ?? null };
  }

  private send(text: string): ResultOf<"chat.send"> {
    if (this.running) throw new ContractError("conflict", "A reply is still being written. Stop it or wait for it first.");
    const now = new Date().toISOString();
    const user: MessageView = { id: `m-${randomUUID()}`, role: "user", text, time: now };
    const turnId = `t-${randomUUID()}`;
    const bot: MessageView = { id: `m-${randomUUID()}`, role: "bot", text: "", time: now, turnId, state: "streaming" };
    this.chat.messages.push(user, bot);
    const resume = this.chat.started;
    this.chat.started = true;
    this.persist();
    this.event({ type: "message.added", message: user });
    this.event({ type: "message.added", message: bot });

    let resolve!: Running["resolve"];
    const done = new Promise<"done" | "stopped" | "failed">((r) => (resolve = r));
    const turn = new AgentTurn(this.options.agent({ id: this.chat.sessionId, resume }), {
      onDelta: (piece) => {
        bot.text += piece;
        this.persist(true);
        this.event({ type: "turn.delta", turnId, messageId: bot.id, text: piece });
      },
      onFinish: (outcome) => {
        if (this.running?.turnId !== turnId) return;
        this.running = null;
        bot.text = outcome.text;
        bot.state = outcome.status;
        const cards = outcome.status === "done" ? extractCards(outcome.text) : null;
        if (cards) { bot.text = cards.text; bot.cards = cards.cards; }
        if (outcome.status === "failed" && !outcome.text) bot.text = outcome.error;
        this.persist();
        this.event({
          type: "turn.finished", turnId, messageId: bot.id, status: outcome.status, text: bot.text,
          ...(outcome.status === "failed" ? { error: outcome.error } : {}),
          ...(bot.cards ? { cards: bot.cards } : {}),
        });
        this.finished.set(turnId, outcome.status);
        resolve(outcome.status);
      },
    });
    this.running = { turnId, messageId: bot.id, turn, done, resolve };
    this.event({ type: "turn.started", turnId, messageId: bot.id });
    turn.start(text);
    if (turn.pid > 0) {
      const pgid = turn.pid;
      this.ledger.record(pgid);
      turn.exited.then(() => this.ledger.forget(pgid));
    }
    this.log(`turn ${turnId} started pid ${turn.pid}`);
    return { messageId: bot.id, turnId };
  }

  private async stop(turnId: string): Promise<ResultOf<"turn.stop">> {
    const running = this.running;
    if (!running || running.turnId !== turnId) return { stopped: false, killed: [], forced: false };
    // Order matters: the turn is closed (and says so) before the process is killed, and the turn's
    // own gate drops anything the dying process still prints.
    this.running = null;
    const bot = this.chat.messages.find((message) => message.id === running.messageId)!;
    const stopping = running.turn.stop();
    bot.text = running.turn.text;
    bot.state = "stopped";
    this.persist();
    this.event({ type: "turn.finished", turnId, messageId: bot.id, status: "stopped", text: bot.text });
    this.finished.set(turnId, "stopped");
    running.resolve("stopped");
    const result = await stopping;
    this.log(`turn ${turnId} stopped; killed ${result.killed.join(",")} forced=${result.forced}`);
    return { stopped: true, killed: result.killed, forced: result.forced };
  }

  private async await(turnId: string, signal: AbortSignal): Promise<ResultOf<"turn.await">> {
    const done = this.finished.get(turnId);
    if (done) return { status: done };
    if (this.running?.turnId !== turnId) throw new ContractError("not_found", "No such turn.");
    const status = await Promise.race([
      this.running.done,
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new ContractError("cancelled", "Stopped waiting.")))),
    ]);
    return { status };
  }

  private card(messageId: string, cardId: string): CardView {
    const message = this.chat.messages.find((candidate) => candidate.id === messageId);
    const card = message?.cards?.find((candidate) => candidate.id === cardId);
    if (!card) throw new ContractError("not_found", "No such card.");
    return card;
  }

  private cardSave(messageId: string, cardId: string, data: string): ResultOf<"card.save"> {
    const card = this.card(messageId, cardId);
    try {
      const value = JSON.parse(data);
      if (value === null || value === undefined) throw new Error("null");
    } catch {
      throw new ContractError("bad_request", "ccb.save takes JSON data that is not null.");
    }
    card.data = data;
    this.persist();
    this.event({ type: "card.updated", messageId, cardId, data });
    return { saved: true };
  }

  private cardAction(messageId: string, cardId: string, name: string, value: string): ResultOf<"card.action"> {
    this.card(messageId, cardId);
    // Card actions are requests, not commands: the core decides what (if anything) they do. In this
    // slice the only one is "say", which shows the value as a notice; nothing runs a shell or opens files.
    if (name !== "say") throw new ContractError("forbidden", `Cards cannot ask for "${name}".`);
    const notice: MessageView = { id: `m-${randomUUID()}`, role: "notice", text: `A card says: ${value}`, time: new Date().toISOString() };
    this.chat.messages.push(notice);
    this.persist();
    this.event({ type: "card.acted", messageId, cardId, name, value });
    this.event({ type: "message.added", message: notice });
    return { accepted: true };
  }

  /** Ends the running turn (if any) and writes everything out; for quitting. */
  async shutdown() {
    if (this.running) await this.stop(this.running.turnId);
    this.persist();
  }
}
