// What the server needs of the engine side (the 2.x core in botlingd, a fake in tests). The intent handlers, the effect
// worker and recovery talk only to this interface; `CoreEngine` (core-engine.ts) is the 2.x core behind it.
import type { Command, Event as ContractEvent } from "../../contract";
type Engine = import("zod").infer<typeof import("../../contract").Engine>;

export type TurnStatus = "done" | "stopped" | "failed";

/** A turn the effect worker starts (its row was committed `started` with its `turn.started` entry first). */
export interface TurnStart {
  botId: string;
  turnId: string;
  replyId: string;
  userId: string | null;
  /** chat.send: the user's text; the engine builds the head's message (plugins, call-ins, quoted line, files). */
  send?: { text: string; replyTo?: string; to?: "both" | "claude" | "codex" | "agy"; files?: Array<{ id: string; name: string }> };
  /** A turn kept aside earlier (an answer's message, a routine's run): the head's message as it was made. */
  words?: string;
  engine?: Engine;
  origin?: "user" | "app";
  routine?: boolean;
}

export interface TurnRunning {
  /** The turn that took it: the same id, another turn under way that read it in, or null (none: a plugin stopped it). */
  turnId: string | null;
  /** Settles once this turn ended, however it ended (when known). */
  done?: Promise<TurnStatus>;
}

/** A turn the engine wants to start and the server keeps aside first (bot.ts `deferTurn`). */
export interface DeferredTurnRequest {
  botId: string;
  turnId: string;
  replyId: string;
  userId: string | null;
  words: string;
  engine: Engine;
  origin: "user" | "app";
  routine: boolean;
  /** Settles once this turn ended. */
  done: Promise<TurnStatus>;
  /** Starts it in the engine (the same Turn object, while this process lives). */
  release(): TurnRunning;
}

/** The user's line of a `chat.send`, as its intent stored it in the log (`TurnEngine.userLine`). */
export interface UserLine {
  id: string;
  text: string;
  /** ISO time of the line in the log. */
  time: string;
  replyTo?: string;
  to?: "both" | "claude" | "codex" | "agy";
}

/** What the server gives the engine. */
export interface EngineHost {
  /** Everything the engine emits (contract events: turn text, lines, steps, cards…). */
  event(event: ContractEvent): void;
  /** A turn the engine is about to route; true: the server keeps it in its outbox and starts it later. */
  deferTurn(turn: DeferredTurnRequest): boolean;
}

/** Core-set commands the engine applies synchronously, inside the command's transaction. */
export type ApplyNowCommand = Extract<Command, { type: "chat.react" | "chat.choose" | "chat.answer" | "chat.ignoreQuestion" | "component.approve" | "settings.set" | "bots.create" }>;

export interface TurnEngine {
  /** Called once, before anything else: where the engine's events and deferred turns go. */
  attach(host: EngineHost): void;
  /** The bots it has now (each gets its stream and bot row at start). */
  bots(): string[];
  /** The engine's current view of a bot (M3 summary rows at start); optional, null when not known. */
  botView?(botId: string): import("../../contract").BotView | null;
  hasBot(botId: string): boolean;
  /** Throws the designated-server refusal when a command names "main" without a main bot here. */
  checkBot?(botId: string): void;
  /** Files waiting in a bot's input box: they go with the next message, so an empty message is not "nothing to send". */
  pendingFiles(botId: string): number;
  /** Throws what `bots.remove` would be refused with (the main bot, Maintainer, an unknown bot). */
  checkRemove(botId: string): void;
  /**
   * Applies a core-set command now, synchronously. Events it emits meanwhile go to `host.event` synchronously (and
   * land in the command's transaction); a turn it would start goes to `host.deferTurn`. Throws for a command it refuses.
   */
  applyNow(cmd: ApplyNowCommand): unknown;
  /**
   * Puts the user's line of a `chat.send` into the engine's own chat now, synchronously (a line it has already is left
   * alone): called in the intent's transaction, and again at recovery for a turn whose row was not ended, so the line
   * is in the chat the engine keeps (the 2.x core's rows, chat.json, the history) as soon as the log has it, and a
   * command naming it (a reaction) finds it while its turn waits. Its turn's `startTurn` finds it there by id. An engine
   * with no chat of its own leaves it out. Throws a ContractError to refuse the send.
   */
  userLine?(botId: string, line: UserLine): void;
  /** Starts a turn (after its `started` row committed). Rejects when the engine refused it. */
  startTurn(turn: TurnStart): Promise<TurnRunning>;
  /** Stops a running turn (its `turn.finished{stopped}` comes as an event). */
  stopTurn(botId: string, turnId: string): void;
  /** Forgets a turn kept aside that was cancelled before it started. */
  discardTurn(botId: string, turnId: string): void;
  /** Removes a bot (idempotent: a bot that is already gone resolves). */
  removeBot(botId: string): Promise<void>;
  /** Legacy apply: runs any other mutating command with the engine's own handler. */
  run(cmd: Command): Promise<unknown>;
}
