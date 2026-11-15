// The guest's owner runs a call-in (M5-02b, protocol v1 §15, D51, Q-C1). Server B applies `callin.ask` (intake.ts: an
// effect row `callin`), the worker runs the guest's turn in the guest's own session (`TurnEngine.callInTurn`, the 2.x
// call-in turn, kept in the guest's own chat), and the outcome goes back as `callin.reply` to the host bot's server, as a
// server-origin command (`ServerOrigin.submit`, M5-04a).
//
//   at most one guest turn per call-in   the row's id is derived from (sender, guest, callId): a second ask is a primary
//                                        key conflict, refused at apply; a crash makes a started row `interrupted`,
//                                        never started again (recovery.ts)
//   the answer is queued exactly once   `replied` is set, the row ends AND the answer is queued (`ServerOrigin.submitIn`, the
//                                        server's own queue row) in ONE transaction (fu-callin-outbox): a crash leaves either
//                                        all of it (the queue sends the answer after the restart) or none of it (the row is
//                                        still started, so recovery answers `failed` once); never a marked row with no answer
//   a restart with the row started       one `failed` reply "its machine restarted during the answer" (the 2.x rule),
//                                        queued once the origin is attached (`attach` → `resume`), also in one transaction
//   cancel (D51)                         a queued row is cancelled (no turn, no reply); a started one aborts the turn
//                                        (`signal`) and answers `failed` "cancelled"
import type { Command } from "../../contract";
import type { Slot, Target } from "../../protocol";
import type { Db } from "../store";
import { oneLine } from "../../core/groups";
import {
  effectsIn, moveEffect, readEffect, setEffectPayload,
  type CallInAnswer, type CallInPayload, type CallInRunner, type EffectRow, type TurnEngine, type TxScope,
} from "../effects";
import { SlotRefusal } from "../slots";
import type { CallInCrash } from "./crash";
import { guestPrompt, cleanLine, stripControls } from "./prompt";
import { CALLIN_NAME_LIMIT, CALLIN_REPLY_LIMIT, CALLIN_WHY_LIMIT, cutEscaped, cutUnits } from "./wire-text";

/** Where the guest's answer goes: `ServerOrigin` (botlingd binds it after it exists). */
export interface CallInSender {
  /** The peer server that owns `target` (a `bot:` stream), or null. */
  ownerOf(target: Target): string | null;
  /** Sends `cmd` as this server's own command. Throws (leaving nothing) for one that does not parse or cannot be sent. */
  submit(target: Target, cmd: Command): Promise<Slot>;
}

/** What the guest needs of `ServerOrigin`: the answer is queued inside the guest's own transaction. */
export interface CallInGuestSender extends CallInSender {
  /**
   * `submit` inside the caller's writer transaction `tx`: throws (writing nothing) for a command that does not parse or cannot be
   * sent. After `tx` committed the caller runs `done()` (never when it rolled back): it tracks the slot and pumps the queue.
   */
  submitIn(tx: Db, target: Target, cmd: Command): { slot: Slot; done(): void };
}

export interface CallInGuestOptions {
  scope: TxScope;
  engine: TurnEngine;
  now?: () => number;
  log?: (line: string) => void;
  /** How long a busy guest is waited for (below the host's own wait, 2.x `SUB_BOT_WAIT_MS` 75 s), then `busy`. */
  busyWaitMs?: number;
  /** How long the guest's turn may take (the host cancels long before; this only bounds a lost cancel). */
  answerMs?: number;
  /** Test hook (`BOTLING_SERVER_CALLIN_CRASH`, fake agent only): called right after the answer's transaction committed. */
  crash?: CallInCrash | null;
}

type Outcome = Extract<Command, { type: "callin.reply" }>["outcome"];

const RESTARTED = "its machine restarted during the answer";
const COULD_NOT_SEND = "its answer could not be sent";
const CUT_NOTE = "\n…(cut: the answer was longer than the limit)";
const errorText = (error: unknown) => oneLine(error instanceof Error ? error.message : String(error), 300);

export class CallInGuest implements CallInRunner {
  private sender: CallInGuestSender | null = null;
  private resolveReady!: () => void;
  private readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });
  private resumed = false;
  /** A `resume` pass is running; `again`: a change came during it. `waiting`: interrupted rows the last pass left for later. */
  private resuming = false;
  private again = false;
  private waiting = 0;
  /** Started rows' turns, to abort on `callin.cancel`. */
  private readonly running = new Map<string, AbortController>();
  /** A cancel that came before the runner created its controller (the row was just taken). */
  private readonly cancelled = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: CallInGuestOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Binds the server origin; the answers of call-ins a crash interrupted go out now. */
  attach(sender: CallInGuestSender): void {
    this.sender = sender;
    this.resolveReady();
    void this.resume();
  }

  /** Whether `callin.ask` can be taken: an origin is attached (fail closed until then). */
  get attached(): boolean { return this.sender !== null; }

  /**
   * The checks of `callin.ask` that need this server's own rows (never the peer's word): it names itself as the host's
   * server, the host bot is that server's (the reply goes there and nowhere else), and the guest is one of ours that
   * another server may call (not the Maintainer, not a sub bot).
   */
  admit(origin: string, cmd: Extract<Command, { type: "callin.ask" }>): void {
    if (!this.sender) throw new SlotRefusal("invalid", "call-ins are not ready on this server");
    if (cmd.host.server !== origin) throw new SlotRefusal("invalid", "the call-in names another server as its host");
    if (this.sender.ownerOf(`bot:${cmd.host.botId}` as Target) !== origin) throw new SlotRefusal("invalid", "the host bot is not on the server that sent the call-in");
    if (!this.options.engine.hasBot(cmd.botId)) throw new SlotRefusal("invalid", `no bot ${cmd.botId}`);
    const view = this.options.engine.botView?.(cmd.botId) ?? null;
    if (view?.maintainer || view?.parent) throw new SlotRefusal("invalid", "that bot cannot be called in from another server");
  }

  /** `callin.cancel` of a started row (after its transaction committed): the turn stops. */
  cancel(effectId: string): void {
    const controller = this.running.get(effectId);
    if (controller) controller.abort();
    else {
      if (this.cancelled.size >= 256) this.cancelled.clear();
      this.cancelled.add(effectId);
    }
  }

  async run(row: EffectRow): Promise<void> {
    const payload = row.payload as CallInPayload;
    const controller = new AbortController();
    if (this.cancelled.delete(row.effectId)) controller.abort();
    this.running.set(row.effectId, controller);
    try {
      await this.ready;
      const answer: CallInAnswer = controller.signal.aborted ? { kind: "failed", why: "cancelled" } : await this.turn(row, payload, controller.signal);
      // A turn cancelled while it ran answers "cancelled", whatever it had ready (the host gave up, D51).
      const outcome = controller.signal.aborted ? ({ kind: "failed", why: "cancelled" } as const) : this.outcomeOf(answer);
      await this.finish(row, "started", outcome);
    } finally {
      this.running.delete(row.effectId);
    }
  }

  private async turn(row: EffectRow, payload: CallInPayload, signal: AbortSignal): Promise<CallInAnswer> {
    const engine = this.options.engine;
    if (!engine.callInTurn) return { kind: "failed", why: "this machine cannot take call-ins" };
    const hostName = payload.host.name;
    const prompt = guestPrompt({ hostName, guestName: this.nameOf(row.botId), transcript: payload.transcript, asked: payload.asked, by: payload.by });
    try {
      return await engine.callInTurn(row.botId, prompt, () => undefined, {
        host: { botId: payload.host.botId, name: cleanLine(hostName, 80) },
        asked: cleanLine(payload.asked, 2_000),
        by: payload.by,
        note: `Called into ${cleanLine(hostName, 80)}'s chat with @: ${cleanLine(payload.asked, 300)}`,
        busyWaitMs: this.options.busyWaitMs ?? 60_000,
        answerMs: this.options.answerMs ?? 15 * 60_000,
        signal,
      });
    } catch (error) {
      return { kind: "failed", why: errorText(error) || "Its turn could not start." };
    }
  }

  /** The wire outcome: the text cut to its escaped-byte limit (never a frame the peer link cannot send), the reason to one line. */
  private outcomeOf(answer: CallInAnswer): Outcome {
    if (answer.kind === "busy") return { kind: "busy" };
    if (answer.kind === "failed") return { kind: "failed", why: cutUnits(oneLine(stripControls(answer.why), CALLIN_WHY_LIMIT - 1), CALLIN_WHY_LIMIT) || "It could not answer." };
    return { kind: "reply", text: cutEscaped(answer.text, CALLIN_REPLY_LIMIT, CUT_NOTE), engine: answer.engine };
  }

  /**
   * The one durable step of an answer (fu-callin-outbox): in ONE writer transaction the row (still `from`, not yet `replied`)
   * is marked answered (and, when it was `started`, finished) and `callin.reply` is queued in the server's own forward queue
   * (`submitIn`). Either all of it commits or none: a kill leaves the row as it was (recovery answers it once) or the answer
   * queued (the forwarder sends it after the restart). A reply that cannot be queued (it does not parse, no peer owns the host
   * bot) is retried once as a short one that always parses; when that fails too the row ends without an answer, as before.
   */
  private async finish(row: EffectRow, from: "started" | "interrupted", outcome: Outcome): Promise<void> {
    const sender = this.sender;
    const payload = row.payload as CallInPayload;
    const target = `bot:${payload.host.botId}` as Target;
    const reply = (value: Outcome): Command => ({ type: "callin.reply", botId: payload.host.botId, callId: payload.callId, guest: { botId: row.botId, name: this.nameOf(row.botId) }, outcome: value });
    /** The row is still `from` and not answered (read in the transaction that acts on it). */
    const open = (tx: Db): boolean => {
      const current = readEffect(tx, row.effectId);
      return !!current && current.state === from && !(current.payload as CallInPayload).replied;
    };
    /** Marks it answered and, for a started row, finishes it (the same transaction as the queue row). */
    const end = (tx: Db): boolean => setEffectPayload(tx, row.effectId, { ...payload, replied: true }, [from])
      && (from !== "started" || moveEffect(tx, row.effectId, ["started"], "finished", this.now()));
    const attempts: Outcome[] = [outcome];
    if (!(outcome.kind === "failed" && outcome.why === COULD_NOT_SEND)) attempts.push({ kind: "failed", why: COULD_NOT_SEND });
    for (const [index, value] of attempts.entries()) {
      try {
        await this.options.scope.submit((tx) => {
          if (!sender) throw new Error("no origin is attached");
          if (!open(tx)) return false;
          // May throw: before any write of this step, so a refusal leaves the row untouched for the next attempt.
          const staged = sender.submitIn(tx, target, reply(value));
          if (!end(tx)) throw new Error("the call-in row changed under its answer");
          this.options.scope.afterCommit(() => { this.options.crash?.("guest", payload.callId); staged.done(); });
          return true;
        });
        return;
      } catch (error) {
        this.options.log?.(`callin: ${index === 0 ? "the" : "even the short"} answer to ${payload.callId} was not sent (${errorText(error)})`);
      }
    }
    // Neither could be queued: the row ends without an answer (the host's wait ends by its own rules).
    try { await this.options.scope.submit((tx) => { if (open(tx)) end(tx); }); } catch (error) { this.options.log?.(`callin: the call-in ${payload.callId} could not be ended (${errorText(error)})`); }
  }

  /**
   * At start: each call-in a crash interrupted gets its one `failed` answer, each in its own transaction. A row whose host
   * bot no peer owns YET (the directory knows no peer before `peers.start()`, or the roster has not caught up) is left alone:
   * not sent and not marked answered, so nothing is lost; `retry` answers it once the peer is known.
   */
  private async resume(): Promise<void> {
    if (this.resumed) return;
    this.resumed = true;
    this.resuming = true;
    this.again = false;
    try {
      const rows = await this.options.scope.submit((tx) => effectsIn(tx, "interrupted").filter((row) => row.kind === "callin" && !(row.payload as CallInPayload).replied));
      let waiting = 0;
      for (const row of rows) {
        const host = (row.payload as CallInPayload).host.botId;
        if (!this.sender?.ownerOf(`bot:${host}` as Target)) { waiting += 1; continue; }
        await this.finish(row, "interrupted", { kind: "failed", why: RESTARTED });
      }
      if (waiting && waiting !== this.waiting) this.options.log?.(`callin: ${waiting} interrupted call-in(s) wait for their host's server to be known before they are answered`);
      this.waiting = waiting;
    } catch (error) {
      this.waiting = Math.max(this.waiting, 1); // unknown: look again at the next change
      this.options.log?.(`callin: answering interrupted call-ins failed (${errorText(error)})`);
    } finally {
      this.resuming = false;
    }
    // A change that came while this pass ran may have made a host's server known after its row was looked at.
    if (this.again) this.retry();
  }

  /**
   * Something `ownerOf` reads changed (the roster, or a peer's `srv:` table copy, which fills only after the peer's session
   * opened, without a roster change): answers the interrupted call-ins that were waiting for their host's server. Nothing
   * happens while none waits, so it may be called on every copy change.
   */
  retry(): void {
    if (!this.sender) return;
    if (this.resuming) { this.again = true; return; }
    if (this.waiting === 0) return;
    this.resumed = false;
    void this.resume();
  }

  /**
   * The guest's name as the host shows it: one clean line, 1–150 characters and at most 200 UTF-16 units (the schema's
   * bound; the short fallback answer carries the same name, so a name over it would leave the host with no answer).
   */
  private nameOf(botId: string): string {
    const name = this.options.engine.botView?.(botId)?.name ?? "";
    return cutUnits(cleanLine(name, 150).trim(), CALLIN_NAME_LIMIT).trim() || "bot";
  }
}
