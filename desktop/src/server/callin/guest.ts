// The guest's owner runs a call-in (M5-02b, protocol v1 §15, D51, Q-C1). Server B applies `callin.ask` (intake.ts: an
// effect row `callin`), the worker runs the guest's turn in the guest's own session (`TurnEngine.callInTurn`, the 2.x
// call-in turn, kept in the guest's own chat), and the outcome goes back as `callin.reply` to the host bot's server, as a
// server-origin command (`ServerOrigin.submit`, M5-04a).
//
//   at most one guest turn per call-in   the row's id is derived from (sender, guest, callId): a second ask is a primary
//                                        key conflict, refused at apply; a crash makes a started row `interrupted`,
//                                        never started again (recovery.ts)
//   the answer is sent at most once      `replied` is set in the same transaction that ends the row, before the send; a
//                                        crash between the two loses the answer (the host's wait ends in "unreachable"),
//                                        never doubles it
//   a restart with the row started       one `failed` reply "its machine restarted during the answer" (the 2.x rule),
//                                        sent once the origin is attached (`attach` → `resume`)
//   cancel (D51)                         a queued row is cancelled (no turn, no reply); a started one aborts the turn
//                                        (`signal`) and answers `failed` "cancelled"
import type { Command } from "../../contract";
import type { Slot, Target } from "../../protocol";
import { oneLine } from "../../core/groups";
import {
  effectsIn, moveEffect, readEffect, setEffectPayload,
  type CallInAnswer, type CallInPayload, type CallInRunner, type EffectRow, type TurnEngine, type TxScope,
} from "../effects";
import { SlotRefusal } from "../slots";
import { guestPrompt, cleanLine, stripControls } from "./prompt";
import { CALLIN_NAME_LIMIT, CALLIN_REPLY_LIMIT, CALLIN_WHY_LIMIT, cutEscaped, cutUnits } from "./wire-text";

/** Where the guest's answer goes: `ServerOrigin` (botlingd binds it after it exists). */
export interface CallInSender {
  /** The peer server that owns `target` (a `bot:` stream), or null. */
  ownerOf(target: Target): string | null;
  /** Sends `cmd` as this server's own command. Throws (leaving nothing) for one that does not parse or cannot be sent. */
  submit(target: Target, cmd: Command): Promise<Slot>;
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
}

type Outcome = Extract<Command, { type: "callin.reply" }>["outcome"];

const RESTARTED = "its machine restarted during the answer";
const COULD_NOT_SEND = "its answer could not be sent";
const CUT_NOTE = "\n…(cut: the answer was longer than the limit)";
const errorText = (error: unknown) => oneLine(error instanceof Error ? error.message : String(error), 300);

export class CallInGuest implements CallInRunner {
  private sender: CallInSender | null = null;
  private resolveReady!: () => void;
  private readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });
  private resumed = false;
  /** Started rows' turns, to abort on `callin.cancel`. */
  private readonly running = new Map<string, AbortController>();
  /** A cancel that came before the runner created its controller (the row was just taken). */
  private readonly cancelled = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: CallInGuestOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Binds the server origin; the answers of call-ins a crash interrupted go out now. */
  attach(sender: CallInSender): void {
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
      await this.answer(row, payload, outcome);
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

  /** Ends the row and marks it answered in one transaction, then sends: at most once. */
  private async answer(row: EffectRow, payload: CallInPayload, outcome: Outcome): Promise<void> {
    if (outcome.kind !== "reply") this.options.log?.(`callin: TEMPDIAG answering ${outcome.kind} ${outcome.kind === "failed" ? outcome.why : ""}`);
    const reserved = await this.options.scope.submit((tx) => {
      const current = readEffect(tx, row.effectId);
      if (!current || current.state !== "started" || (current.payload as CallInPayload).replied) return false;
      setEffectPayload(tx, row.effectId, { ...payload, replied: true }, ["started"]);
      return moveEffect(tx, row.effectId, ["started"], "finished", this.now());
    });
    if (reserved) await this.send(row.botId, payload, outcome);
  }

  private async send(botId: string, payload: CallInPayload, outcome: Outcome): Promise<void> {
    const sender = this.sender;
    if (!sender) return;
    const target = `bot:${payload.host.botId}` as Target;
    const reply = (value: Outcome): Command => ({ type: "callin.reply", botId: payload.host.botId, callId: payload.callId, guest: { botId, name: this.nameOf(botId) }, outcome: value });
    try {
      await sender.submit(target, reply(outcome));
      return;
    } catch (error) {
      this.options.log?.(`callin: the answer to ${payload.callId} was not sent (${errorText(error)})`);
    }
    // Once more with a short outcome that always parses, so the host is not left waiting on a refusal of ours.
    if (outcome.kind === "failed" && outcome.why === COULD_NOT_SEND) return;
    try {
      await sender.submit(target, reply({ kind: "failed", why: COULD_NOT_SEND }));
    } catch (error) {
      this.options.log?.(`callin: even the short answer to ${payload.callId} was not sent (${errorText(error)})`);
    }
  }

  /** At start: each call-in a crash interrupted gets its one `failed` answer. */
  private async resume(): Promise<void> {
    if (this.resumed) return;
    this.resumed = true;
    try {
      const marked = await this.options.scope.submit((tx) => effectsIn(tx, "interrupted").filter((row) => {
        const payload = row.payload as CallInPayload;
        if (row.kind !== "callin" || payload.replied) return false;
        return setEffectPayload(tx, row.effectId, { ...payload, replied: true }, ["interrupted"]);
      }));
      for (const row of marked) await this.send(row.botId, row.payload as CallInPayload, { kind: "failed", why: RESTARTED });
    } catch (error) {
      this.options.log?.(`callin: answering interrupted call-ins failed (${errorText(error)})`);
    }
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
