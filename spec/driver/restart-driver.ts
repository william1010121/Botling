// The only door spec/tests/restart.spec.test.ts uses into the app's restart continuation
// (spec/models/restart). An interface: desktop/spec-adapters/restart-adapter.ts implements it.
// Each call is one action of the model (boot: Boot followed by the recovery the real code does).

export type RestartPhase = "none" | "preparing" | "ready";
export type RestartEntryState = "absent" | "pending" | "claimed" | "dispatched" | "blocked";
/** entry.blocked, by cause: none, the bot's own blocker, its own failed shutdown, its failed delivery. */
export type RestartBlocked = "none" | "own" | "shutdown" | "deliver";
/** Why a bot was told it is not continued. */
export type RestartReason = "own" | "shutdown" | "deliver" | "stale" | "unconfirmed" | "uncertain";

/** What can be seen of the protocol: the journal on disk, and what the bots received. */
export interface RestartObservation {
  phase: RestartPhase;
  entry: Record<string, RestartEntryState>;
  blk: Record<string, RestartBlocked>;
  /** Continuations delivered to each bot (ever). */
  sent: Record<string, number>;
  /** The last reason each bot was told ("none": never told). */
  told: Record<string, RestartReason | "none">;
}

/** One step the real recovery took, named as the model's action. */
export interface RestartRecoveryEvent {
  action: "Claim" | "Deliver" | "Dispatch" | "Notice" | "Block";
  bot: string;
  /** Deliver: whether delivery succeeded. */
  ok?: boolean;
  /** Notice: the reason told. */
  reason?: RestartReason;
}

export interface RestartBootPlan {
  /** Bots whose delivery throws. */
  fail: readonly string[];
  /** The new process dies after this many recovery events (journal writes and effects); none: it lives. */
  crashAfter?: number;
}

/** One line the app wrote with specTrace("restart", …), as the model's action and what it shows. */
export interface RestartTraceStep {
  action: string;
  bot?: string;
  part?: string;
  ok?: boolean;
  reason?: RestartReason;
  /** The journal as written by this step (journal-writing actions only). */
  journal?: { phase: RestartPhase; entry: Record<string, RestartEntryState>; blk: Record<string, RestartBlocked> };
}

export interface RestartDriver {
  /** Old app: work begins on `bot`; `own`: it has a blocker of its own (a pending permission, …). */
  start(bot: string, own: boolean): void;
  /** Old app: the bot's work ends (completes or is cancelled). */
  finish(bot: string): void;
  /** The user confirmed a restart: the journal is prepared. */
  prepare(): void;
  /** The restart was called off (a failed install). */
  cancel(): void;
  /** Shutdown begins: the journal is re-snapshotted, every participant starts to stop. */
  beginShutdown(): void;
  /** One participant (a bot, or the plugin host) has stopped, cleanly or not. */
  settle(part: string, ok: boolean): void;
  /** Every participant has settled: shutdown finishes and the old process exits. */
  ready(): Promise<void>;
  /** The current process dies at once. */
  crash(): void;
  /** Time passes until the journal is too old to resume. */
  expire(): void;
  /** A new process starts and runs restart recovery. `crashed`: it died after `crashAfter` events. */
  boot(plan: RestartBootPlan): { events: RestartRecoveryEvent[]; crashed: boolean };
  observe(): RestartObservation;
}

export interface RestartDriverOptions {
  bots: readonly string[];
  /** The plugin host's participant name. */
  plugins: string;
  /** An empty folder for the journal. */
  dataDir: string;
}
