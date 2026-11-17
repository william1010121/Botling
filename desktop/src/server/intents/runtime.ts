// The intent side of `botlingd` assembled (M1 step 6): the slot engine on the real log, the core set's intent
// handlers, legacy apply, the effect worker, the event tap with the live channel, and recovery at start.
//
//   front end cmd ─► receive ─► intent: SlotEngine (handlers.ts in the command's transaction) ─► after commit: worker
//                             └► legacy: the core's handler, then SlotEngine (legacy.ts)
//   engine events ─► EventTap ─► log entries (and effect rows), `turn.delta` ─► LiveChannel
//   engine deferTurn ─► a queued row (in the running command, or one of its own for a routine) ─► worker
//
// Everything that writes goes through one TxScope over the store's writer, so the tap and the handlers share the
// command's transaction and LogHub hears about every stream a commit touched.
import type { Event as ContractEvent } from "../../contract";
import type { CmdBody, Slot } from "../../protocol";
import { CallInGuest, CallInHost, type CallInCrash, type CallInHostOptions } from "../callin";
import { contentLineHook, type ContentService } from "../content";
import { ensureStream, type LogHub } from "../log";
import { ContractLiveFeed, type LiveChannel } from "../live";
import type { TapHooks } from "../effects/tap";
import { keptResult, SlotEngine, type Audit, type Authorize, type ReceiveOptions, type ReceiveStatus } from "../slots";
import {
  ensureBot, EffectWorker, EventTap, recoverEffects, serverStreamOf, TxScope,
  type DeferredTurnRequest, type RecoveryReport, type Submitter, type TurnEngine,
} from "../effects";
import { routeOf } from "./commands";
import { applyIntent, effectBasisReader, queueKeptTurn, type IntentDeps, type UploadedFiles } from "./handlers";
import { LegacyApply } from "./legacy";
import { dbSlotLog } from "./slot-log";

export interface IntentRuntimeOptions {
  store: Submitter;
  engine: TurnEngine;
  hub?: LogHub | null;
  /** The live channel `turn.delta` goes to (its checkpoint sink: effects `effectCheckpointSink`). */
  live?: LiveChannel | null;
  now?: () => number;
  log?: (line: string) => void;
  onServerEvent?: (event: ContractEvent) => void;
  /** EventTapOptions `serverEvents` / `mirrorBotUpdates` (botlingd: every server event and bot update in `srv:`). */
  serverEvents?: "settings" | "all";
  mirrorBotUpdates?: boolean;
  authorize?: Authorize;
  audit?: Audit;
  /** The content index (src/server/content): a finished line's files are noted in its entry's transaction. */
  content?: ContentService | null;
  /** M2 step 12: files a page uploaded (server/content/put.ts), checked by `chat.send` with `files`. */
  uploads?: UploadedFiles | null;
  /** Extra event tap hooks (M3: the server's summary rows, src/server/replica). */
  tapHooks?: Pick<TapHooks, "eventSeen" | "eventStored">;
  /** Botling 3's server: called after a commit that changed a `plugin:` row's grants (`plugin.grant`). */
  pluginRowsChanged?: () => void;
  /** Botling 3's server: called after a commit where the user allowed a plugin (`plugin.grant`, not a revoke): Maintainer is told. */
  pluginGranted?: (plugin: string) => void;
  /** M5-03b test knob: the host's wait timers (botlingd: `callInTimers(env)`, only with the fake agent). */
  callHostTimers?: Pick<CallInHostOptions, "staleMs" | "capMs" | "tickMs">;
  /** Test hook (`BOTLING_SERVER_CALLIN_CRASH`, fake agent only): kills the process right after a call-in step committed. */
  callInCrash?: CallInCrash | null;
}

export class NotASlotCommandError extends Error {
  constructor(readonly type: string, readonly route: string) {
    super(`${type} is a ${route} command; it does not go through a slot`);
    this.name = "NotASlotCommandError";
  }
}

export class IntentRuntime {
  readonly scope: TxScope;
  readonly worker: EffectWorker;
  readonly tap: EventTap;
  readonly slots: SlotEngine;
  readonly legacy: LegacyApply;
  /** M5-02b: the guest's side of call-ins (botlingd attaches the server origin once it exists). */
  readonly callIns: CallInGuest;
  /** M5-02c: the host's side (botlingd attaches the server origin and binds `remoteTurn` into the core). */
  readonly callHost: CallInHost;
  private readonly deps: IntentDeps;
  private readonly now: () => number;

  constructor(private readonly options: IntentRuntimeOptions) {
    const log = options.log;
    this.now = options.now ?? Date.now;
    this.scope = new TxScope(options.store, (streams) => options.hub?.committed(streams), (error) => log?.(`intents: an after-commit step failed (${error instanceof Error ? error.message : String(error)})`));
    this.callIns = new CallInGuest({ scope: this.scope, engine: options.engine, now: this.now, log, crash: options.callInCrash ?? null });
    this.callHost = new CallInHost({ log, scope: this.scope, now: this.now, crash: options.callInCrash ?? null, ...(options.callHostTimers ?? {}) });
    this.worker = new EffectWorker({ scope: this.scope, engine: options.engine, now: this.now, log, callIns: this.callIns });
    this.tap = new EventTap({
      scope: this.scope,
      live: options.live ? new ContractLiveFeed(options.live) : null,
      hooks: {
        turnEnded: (tx, botId, turnId, status) => this.worker.turnEnded(tx, botId, turnId, status),
        ...(options.content ? { lineStored: contentLineHook(options.content, this.scope) } : {}),
        ...(options.tapHooks?.eventSeen ? { eventSeen: options.tapHooks.eventSeen } : {}),
        ...(options.tapHooks?.eventStored ? { eventStored: options.tapHooks.eventStored } : {}),
      },
      now: this.now,
      log,
      onServerEvent: options.onServerEvent,
      ...(options.serverEvents ? { serverEvents: options.serverEvents } : {}),
      ...(options.mirrorBotUpdates ? { mirrorBotUpdates: true } : {}),
    });
    this.deps = { scope: this.scope, engine: options.engine, worker: this.worker, now: this.now, log, uploads: options.uploads ?? null, pluginRowsChanged: options.pluginRowsChanged, pluginGranted: options.pluginGranted, callIns: this.callIns, callHost: this.callHost };
    const slotLog = dbSlotLog(this.scope, log);
    this.slots = new SlotEngine({
      submit: (command) => this.scope.submit(command),
      log: slotLog,
      basis: effectBasisReader,
      apply: (context) => (routeOf(context.cmd.type).kind === "intent" ? applyIntent(this.deps, context) : this.legacy.apply(context)),
      ...(options.authorize ? { authorize: options.authorize } : {}),
      ...(options.audit ? { audit: options.audit } : {}),
    });
    this.legacy = new LegacyApply(this.scope, slotLog, options.engine, () => this.slots, () => this.tap.hold());
    options.engine.attach({ event: (event) => this.tap.event(event), deferTurn: (turn) => this.deferTurn(turn) });
  }

  /** At start, before any front end: every bot's stream and row, the server stream, recovery; then the worker runs. */
  async start(): Promise<RecoveryReport> {
    const report = await this.scope.submit((tx) => {
      ensureStream(tx, serverStreamOf(tx));
      for (const botId of this.options.engine.bots()) ensureBot(tx, botId);
      return recoverEffects(this.scope, tx, this.now(), this.options.log, this.options.engine);
    });
    this.worker.kick();
    return report;
  }

  /** One copy of a front end's command (a slot). Reads and app commands never come here. */
  receive(body: CmdBody, options: ReceiveOptions): Promise<ReceiveStatus> {
    const route = routeOf(body.cmd.type);
    if (route.kind === "intent") return this.slots.receive(body, options);
    if (route.kind === "legacy") return this.legacy.receive(body, options);
    return Promise.reject(new NotASlotCommandError(body.cmd.type, route.kind));
  }

  /** The result this server kept for a slot too large for its `cmd.applied` entry (N2; the `slot.result` req). */
  keptResult(slot: Slot): Promise<{ found: true; result: unknown } | { found: false }> {
    return this.scope.submit((tx) => keptResult(tx, slot));
  }

  /** Waits until the worker has nothing in hand (tests, shutdown). */
  idle(): Promise<void> {
    return this.worker.idle();
  }

  close(): void {
    this.callHost.close();
    this.worker.close();
  }

  private deferTurn(turn: DeferredTurnRequest): boolean {
    // The worker is starting this very turn (its row is started): let it through.
    if (this.worker.starting.has(turn.turnId)) return false;
    const tx = this.scope.tx;
    if (tx) {
      queueKeptTurn(this.deps, tx, turn, "command");
      return true;
    }
    if (!turn.routine) return false; // a turn the core begins by itself: its row comes with its `turn.started`
    this.worker.keep(turn);
    this.scope.submit((own) => {
      // Kept again by queueKeptTurn (same turn), with the rollback and the kick.
      queueKeptTurn(this.deps, own, turn, "routine");
    }).catch((error) => {
      // Not recorded: run it as 2.x would rather than lose the routine's run.
      this.options.log?.(`intents: a routine's turn of ${turn.botId} was not recorded (${error instanceof Error ? error.message : String(error)}); it runs unrecorded`);
      if (this.worker.forget(turn.turnId)) turn.release();
    });
    return true;
  }
}
