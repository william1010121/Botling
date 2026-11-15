// A fake engine behind the server's TurnEngine (src/server/effects/engine.ts), for the intent and effect tests and the
// crash child. It emits contract events the way the 2.x core does for the parts the server cares about: a user line,
// `turn.started`, `turn.delta` chunks on a timer, `turn.finished`; card lines that can be chosen, answered or ignored
// (an answer starts a turn through `deferTurn`); reactions; bots made and removed; routines that defer their run.
import { randomUUID } from "node:crypto";
import { ContractError, type Command, type Event as ContractEvent, type MessageView } from "../../src/contract";
import type { ApplyNowCommand, CallInAnswer, CallInOptions, DeferredTurnRequest, EngineHost, TurnEngine, TurnRunning, TurnStart, TurnStatus } from "../../src/server/effects";

export interface FakeTurnEngineOptions {
  bots?: string[];
  /** The reply's chunks (one `turn.delta` each). */
  chunks?: string[];
  /** Between chunks. */
  chunkMs?: number;
  /** Turns never finish by themselves (only `stopTurn` / `finish` end them). */
  hold?: boolean;
  /** Called synchronously as a turn begins in the engine (the crash child logs it durably). */
  onSpawn?: (turnId: string, botId: string) => void;
  /** Called after each chunk is emitted, with the reply's text so far. */
  onChunk?: (turnId: string, text: string) => void;
}

interface FakeTurn {
  botId: string;
  turnId: string;
  replyId: string;
  text: string;
  next: number;
  timer: NodeJS.Timeout | null;
  ended: boolean;
  resolve: (status: TurnStatus) => void;
  done: Promise<TurnStatus>;
}

export const newLineId = () => randomUUID().toUpperCase();
const iso = () => new Date().toISOString();

export class FakeTurnEngine implements TurnEngine {
  host: EngineHost | null = null;
  readonly botSet: Set<string>;
  readonly lines = new Map<string, MessageView & { botId: string }>();
  readonly turns = new Map<string, FakeTurn>();
  /** Every turn begun in the engine, in order (a turn must never appear twice). */
  readonly spawns: string[] = [];
  /** startTurn calls (rows started from the outbox, not released kept turns). */
  readonly starts: TurnStart[] = [];
  readonly stops: string[] = [];
  readonly discarded: string[] = [];
  readonly removed: string[] = [];
  readonly runs: Command[] = [];
  /** startTurn answers with this turn id instead (a turn under way read it in). */
  absorbInto: string | null = null;
  /** The next startTurn rejects with this. */
  failNext: Error | null = null;
  /** M5-02b: every guest turn of a call-in the server asked for (`callInTurn`), in order. */
  readonly callIns: Array<{ guestId: string; prompt: string; options: CallInOptions; begun: boolean; aborted: boolean; settle(answer: CallInAnswer): void }> = [];
  /** What the next call-in turns answer; "hold": they wait for `settle` or an abort (cancelled). */
  callInMode: "reply" | "hold" | "busy" | "failed" = "reply";
  callInText = "All green.";
  /** Bots `botView` reports as the Maintainer or as a sub bot (not callable from another server). */
  readonly maintainers = new Set<string>();
  readonly subBots = new Set<string>();

  constructor(private readonly options: FakeTurnEngineOptions = {}) {
    this.botSet = new Set(options.bots ?? ["MAIN", "B1"]);
  }

  attach(host: EngineHost): void { this.host = host; }
  bots(): string[] { return [...this.botSet]; }
  hasBot(botId: string): boolean { return this.botSet.has(botId); }
  pendingFiles(): number { return 0; }

  botView(botId: string): import("../../src/contract").BotView | null {
    if (!this.botSet.has(botId)) return null;
    return { id: botId, name: `bot ${botId}`, role: "bot", ...(this.maintainers.has(botId) ? { maintainer: true } : {}), ...(this.subBots.has(botId) ? { parent: "MAIN" } : {}) } as unknown as import("../../src/contract").BotView;
  }

  callInTurn(guestId: string, prompt: string, onBegin: () => void, options: CallInOptions): Promise<CallInAnswer> {
    return new Promise((resolve) => {
      const entry = { guestId, prompt, options, begun: false, aborted: false, settle: (answer: CallInAnswer) => resolve(answer) };
      this.callIns.push(entry);
      options.signal.addEventListener("abort", () => { entry.aborted = true; resolve({ kind: "failed", why: "cancelled" }); }, { once: true });
      if (options.signal.aborted) { entry.aborted = true; resolve({ kind: "failed", why: "cancelled" }); return; }
      entry.begun = true;
      onBegin();
      if (this.callInMode === "reply") resolve({ kind: "reply", text: this.callInText, engine: "claude" });
      else if (this.callInMode === "busy") resolve({ kind: "busy" });
      else if (this.callInMode === "failed") resolve({ kind: "failed", why: "It could not answer." });
    });
  }

  checkRemove(botId: string): void {
    if (!this.botSet.has(botId)) throw new ContractError("not_found", "No such bot.");
    if (botId === "MAIN") throw new ContractError("forbidden", "The main bot and Maintainer cannot be removed.");
  }

  emit(event: ContractEvent): void {
    this.host?.event(event);
  }

  /** A line in a bot's chat (emitted as `message.added`). */
  addLine(botId: string, message: Partial<MessageView> & { role: MessageView["role"] }): MessageView {
    const line = { id: newLineId(), text: "", time: iso(), ...message } as MessageView;
    this.lines.set(line.id, { ...line, botId });
    this.emit({ type: "message.added", botId, message: line });
    return line;
  }

  /** A question card with two buttons. */
  addCard(botId: string): MessageView {
    return this.addLine(botId, {
      role: "bot", text: "Which one?",
      choices: [{ label: "A", detail: null, recommended: true, action: null }, { label: "B", detail: null, recommended: false, action: null }],
      chosen: null,
    });
  }

  private updateLine(id: string, change: Partial<MessageView>): MessageView {
    const line = this.lines.get(id);
    if (!line) throw new ContractError("not_found", "No such line.");
    Object.assign(line, change);
    const { botId, ...message } = line;
    this.emit({ type: "message.updated", botId, message: message as MessageView });
    return message as MessageView;
  }

  applyNow(cmd: ApplyNowCommand): unknown {
    switch (cmd.type) {
      case "chat.react": {
        const line = this.lines.get(cmd.messageId);
        if (!line) throw new ContractError("not_found", "No such line.");
        const reactions = (line.reactions ?? []).filter((reaction) => reaction.emoji !== cmd.emoji);
        if (cmd.present) reactions.push({ emoji: cmd.emoji, actor: "user" });
        this.updateLine(cmd.messageId, { reactions });
        return { changed: true };
      }
      case "chat.choose":
      case "chat.answer": {
        const line = this.lines.get(cmd.messageId);
        if (!line || line.chosen != null || line.answer != null) throw new ContractError("conflict", "That question was already answered.");
        const words = cmd.type === "chat.choose" ? line.choices![cmd.index]?.label ?? "?" : cmd.text;
        this.updateLine(cmd.messageId, cmd.type === "chat.choose" ? { chosen: cmd.index } : { answer: cmd.text });
        const user = this.addLine(cmd.botId, { role: "user", text: words });
        this.route({ botId: cmd.botId, userId: user.id, words, origin: "user", routine: false });
        return { accepted: true };
      }
      case "chat.ignoreQuestion":
        this.updateLine(cmd.messageId, { ignoredAt: iso() });
        return { accepted: true };
      case "component.approve":
        this.updateLine(cmd.messageId, { chosen: cmd.index });
        return { accepted: true };
      case "settings.set":
        return { changed: cmd.change.key };
      case "bots.create": {
        const botId = cmd.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 32) || "BOT";
        const created = !this.botSet.has(botId);
        this.botSet.add(botId);
        if (created) this.addLine(botId, { role: "notice", text: `Made ${cmd.name}: ${cmd.job}` });
        return { botId, created };
      }
    }
  }

  /** A turn the engine wants to start (an answer's, a routine's): through `deferTurn`, or begun now. */
  route(spec: { botId: string; userId: string | null; words: string; origin: "user" | "app"; routine: boolean }): string {
    const turnId = `t-${randomUUID()}`;
    const replyId = newLineId();
    let resolveDone!: (status: TurnStatus) => void;
    const done = new Promise<TurnStatus>((resolve) => (resolveDone = resolve));
    const request: DeferredTurnRequest = {
      botId: spec.botId, turnId, replyId, userId: spec.userId, words: spec.words, engine: "claude", origin: spec.origin, routine: spec.routine,
      done,
      release: () => {
        const running = this.begin(spec.botId, turnId, replyId);
        void running.done!.then(resolveDone);
        return running;
      },
    };
    if (!this.host?.deferTurn(request)) request.release();
    return turnId;
  }

  /** A routine's time came. */
  routine(botId: string): string {
    return this.route({ botId, userId: null, words: "Run the routine.", origin: "app", routine: true });
  }

  /** A turn the engine begins by itself (a call-in, a worker's report): no deferral. */
  coreTurn(botId: string, turnId = `t-${randomUUID()}`): TurnRunning {
    return this.begin(botId, turnId, newLineId());
  }

  async startTurn(turn: TurnStart): Promise<TurnRunning> {
    this.starts.push(turn);
    await Promise.resolve();
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (turn.send && turn.userId) {
      const line = { id: turn.userId, role: "user", text: turn.send.text.trim(), time: iso() } as MessageView;
      this.lines.set(line.id, { ...line, botId: turn.botId });
      this.emit({ type: "message.added", botId: turn.botId, message: line });
    }
    if (this.absorbInto) return { turnId: this.absorbInto };
    return this.begin(turn.botId, turn.turnId, turn.replyId);
  }

  begin(botId: string, turnId: string, replyId: string): TurnRunning {
    if (this.turns.has(turnId)) throw new Error(`fake engine: turn ${turnId} begun twice`);
    this.spawns.push(turnId);
    this.options.onSpawn?.(turnId, botId);
    let resolve!: (status: TurnStatus) => void;
    const done = new Promise<TurnStatus>((r) => (resolve = r));
    const turn: FakeTurn = { botId, turnId, replyId, text: "", next: 0, timer: null, ended: false, resolve, done };
    this.turns.set(turnId, turn);
    this.emit({ type: "turn.started", botId, turnId, messageId: replyId });
    this.schedule(turn);
    return { turnId, done };
  }

  private schedule(turn: FakeTurn): void {
    const chunks = this.options.chunks ?? ["Hello", ", ", "world."];
    turn.timer = setTimeout(() => {
      turn.timer = null;
      if (turn.ended) return;
      if (turn.next < chunks.length) {
        const chunk = chunks[turn.next++];
        turn.text += chunk;
        this.emit({ type: "turn.delta", botId: turn.botId, turnId: turn.turnId, messageId: turn.replyId, text: chunk });
        this.options.onChunk?.(turn.turnId, turn.text);
        this.schedule(turn);
        return;
      }
      if (!this.options.hold) this.finish(turn.turnId, "done");
    }, this.options.chunkMs ?? 1);
  }

  /** Ends a running turn now. */
  finish(turnId: string, status: TurnStatus): void {
    const turn = this.turns.get(turnId);
    if (!turn || turn.ended) return;
    turn.ended = true;
    if (turn.timer) clearTimeout(turn.timer);
    this.emit({ type: "turn.finished", botId: turn.botId, turnId, messageId: turn.replyId, status, text: turn.text });
    turn.resolve(status);
  }

  stopTurn(_botId: string, turnId: string): void {
    this.stops.push(turnId);
    this.finish(turnId, "stopped");
  }

  discardTurn(_botId: string, turnId: string): void {
    this.discarded.push(turnId);
  }

  async removeBot(botId: string): Promise<void> {
    await Promise.resolve();
    this.removed.push(botId);
    if (!this.botSet.delete(botId)) return;
    this.emit({ type: "bot.removed", botId });
  }

  async run(cmd: Command): Promise<unknown> {
    this.runs.push(cmd);
    await Promise.resolve();
    if (cmd.type === "files.remove") throw new ContractError("not_found", "No such file.");
    if (cmd.type === "chat.read") {
      this.emit({ type: "chat.decorations", botId: cmd.botId, decorations: [] });
      return {};
    }
    return { ok: true };
  }

  /** Every turn ended. */
  async allEnded(): Promise<void> {
    await Promise.all([...this.turns.values()].map((turn) => turn.done));
  }

  /** Clears timers (end of a test). */
  close(): void {
    for (const turn of this.turns.values()) if (turn.timer) clearTimeout(turn.timer);
  }
}
