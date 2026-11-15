// The host's side of a call-in (M5-02c, protocol v1 §15, D51, Q-C1). H is a chat on this server A; its bot @-mentions a bot
// that lives on server B. `Conversations` (2.x, core/conversations.ts) calls `remoteTurn`; this file asks B with one
// `callin.ask` (a server-origin slot, `ServerOrigin.submit`), waits for B's `callin.reply` to be applied here, and gives the
// answer back as a `GuestAnswer`, so the guest's line is appended to H by the same code that appends a local guest's line:
// only A writes H, once per call-in.
//
//   every wait ends exactly once   reply · failed · busy (B's outcomes), the wait running out, B not reachable (not in the
//                                  roster, owned by another server, the ask refused), the ask could not be sent, cancel (an
//                                  aborted signal), or this host closing. `settle` is the one place a wait ends: it removes
//                                  the entry and the timer first, so a second ending (a duplicate or late reply, a timer that
//                                  fires after a reply) finds nothing to do.
//   the reply is peer text         it is cleaned before it is an answer (`cleanReply`): control characters and direction
//                                  marks removed, every `<` that opens a tag turned into a look-alike so no tag of the 2.x
//                                  reply parser (`<show command=…>`, choices, requests) can act on H; a `why` is one clean line.
//   the reply is authentic         the slot's origin must be the server the ask went to, and the bot ids must be the ones
//                                  asked (`check`, in the command's transaction); a reply from anyone else is refused and
//                                  leaves the wait alone.
//   the wait ends after the commit `deliver` runs after the reply's transaction committed, never inside it.
//   restart                        the waits are in memory: a restart of A loses them, and a reply that arrives later finds no
//                                  wait and is dropped (applied, logged once, no line, nobody woken). M5-03a keeps given-up
//                                  call-ins and posts a late line.
import { randomUUID } from "node:crypto";
import type { Command } from "../../contract";
import type { GuestAnswer } from "../../core/bot";
import type { RemoteTurnRequest } from "../../core/conversations";
import { SUB_BOT_WAIT_MS } from "../../core/sub-bots";
import { transcriptLines } from "../../core/groups";
import type { ChatRecord } from "../../core/store/records";
import { slotKey, type Outcome, type Slot, type Target } from "../../protocol";
import type { ApplyContext } from "../slots";
import { SlotRefusal } from "../slots";
import type { TxScope } from "../effects";
import type { CallInSender } from "./guest";
import { cleanLine, stripControls } from "./prompt";
import { CALLIN_TRANSCRIPT_LIMIT, cutOldest } from "./wire-text";

/** How long the host waits for the guest (the 2.x call-in wait; above the guest's own 60 s busy wait). */
export const CALLIN_HOST_WAIT_MS = SUB_BOT_WAIT_MS;
/** `callin.ask.asked`, in UTF-16 units (the contract's `.max(4_000)`). */
const ASKED_UNITS = 4_000;
/** The longest `why` the host passes on, in characters. */
const WHY_CHARS = 300;

type Ask = Extract<Command, { type: "callin.ask" }>;
type Reply = Extract<Command, { type: "callin.reply" }>;

/** What the host needs of `ServerOrigin` besides the guest's needs: this server's own id and the slot outcomes. */
export interface CallInHostSender extends CallInSender {
  /** This server's roster member id: the `host.server` of every ask (the guest's owner checks it against the origin). */
  self: string;
  /** Subscribes to outcomes of slots this server originated; returns an unsubscribe. */
  onOutcome?(listener: (slot: Slot, outcome: Outcome) => void): () => void;
  /** The outcome already known for `slot`, or null. */
  outcome?(slot: Slot): Outcome | null;
}

export interface CallInHostOptions {
  /** How long a wait lasts (default `CALLIN_HOST_WAIT_MS`); tests make it short. */
  waitMs?: number;
  log?: (line: string) => void;
}

interface Wait {
  server: string;
  guestBotId: string;
  hostBotId: string;
  /** The machine's name as shown (quoted, one clean line). */
  machine: string;
  settle(answer: GuestAnswer): void;
}

/** `remoteTurn`'s request, plus an optional signal that cancels the wait. */
export type CallInTurnRequest = RemoteTurnRequest & { signal?: AbortSignal };

const failed = (why: string): GuestAnswer => ({ kind: "failed", why });
const errorText = (error: unknown) => cleanLine(error instanceof Error ? error.message : String(error), 200);

/** The guest's reply as an answer for H: peer text, so controls are gone and no tag can act (see the file header). */
export function cleanReply(text: string): string {
  return stripControls(text).replace(/\r\n?/g, "\n").replace(/<(?=[A-Za-z/!?])/g, "＜");
}

/** `text` cut to at most `units` UTF-16 units without splitting a surrogate pair. */
function cutUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  const end = /[\uD800-\uDBFF]/.test(text[units - 1] ?? "") ? units - 1 : units;
  return text.slice(0, end);
}

export class CallInHost {
  private sender: CallInHostSender | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  /** The waits by callId. */
  private readonly waits = new Map<string, Wait>();
  /** The ask's slot → its callId, so a refusal of the ask ends the wait at once. */
  private readonly asked = new Map<string, string>();
  private readonly waitMs: number;
  private readonly log: (line: string) => void;

  constructor(options: CallInHostOptions = {}) {
    this.waitMs = options.waitMs ?? CALLIN_HOST_WAIT_MS;
    this.log = options.log ?? (() => undefined);
  }

  /** Binds the server origin (botlingd does it once `ServerOrigin` exists); until then every call-in is "not reachable". */
  attach(sender: CallInHostSender): void {
    this.unsubscribe?.();
    this.sender = sender;
    this.unsubscribe = sender.onOutcome?.((slot, outcome) => this.askEnded(slot, outcome)) ?? null;
  }

  /** How many call-ins are waiting for their answer. */
  get waiting(): number { return this.waits.size; }

  /** Ends every wait ("this machine is stopping") and stops listening. */
  close(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const wait of [...this.waits.values()]) wait.settle(failed("this machine is stopping"));
  }

  /** The `remoteTurn` of the 2.x core option (`Conversations`): asks B, waits, answers. Never rejects. */
  readonly remoteTurn = (call: CallInTurnRequest): Promise<GuestAnswer> => {
    const sender = this.sender;
    const machine = JSON.stringify(cleanLine(call.member.serverName, 60));
    const unreachable = failed(`its machine ${machine} is not reachable`);
    if (call.signal?.aborted) return Promise.resolve(failed("cancelled"));
    if (this.closed) return Promise.resolve(failed("this machine is stopping"));
    const target = `bot:${call.member.id}` as Target;
    // The bot is on the machine its member says, and that machine is still in the roster (fail closed otherwise).
    if (!sender || sender.ownerOf(target) !== call.member.server) return Promise.resolve(unreachable);
    const callId = randomUUID();
    const ask: Ask = {
      type: "callin.ask", botId: call.member.id, callId,
      host: { server: sender.self, botId: call.host.botId, name: cleanLine(call.host.name, 80) || "bot" },
      transcript: this.transcriptOf(call),
      asked: cutUnits(stripControls(call.asked), ASKED_UNITS) || `@${cleanLine(call.member.name, 80)}`,
      by: call.by, depth: Math.min(2, Math.max(1, Math.trunc(call.depth) || 1)),
    };
    return new Promise<GuestAnswer>((resolve) => {
      let done = false;
      let slotId: string | null = null;
      let timer: NodeJS.Timeout | null = null;
      const onAbort = () => settle(failed("cancelled"));
      const settle = (answer: GuestAnswer) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        call.signal?.removeEventListener("abort", onAbort);
        this.waits.delete(callId);
        if (slotId) this.asked.delete(slotId);
        resolve(answer);
      };
      this.waits.set(callId, { server: call.member.server, guestBotId: call.member.id, hostBotId: call.host.botId, machine, settle });
      timer = setTimeout(() => settle(unreachable), this.waitMs);
      timer.unref?.();
      call.signal?.addEventListener("abort", onAbort, { once: true });
      sender.submit(target, ask).then((slot) => {
        if (done) return;
        call.onBegin?.();
        slotId = slotKey(slot);
        this.asked.set(slotId, callId);
        // Refused before we looked (the outcome is already known): end now.
        const known = sender.outcome?.(slot) ?? null;
        if (known) this.askEnded(slot, known);
      }, (error: unknown) => {
        // `ServerOrigin.submit` checks before it commits: nothing was queued, nothing will answer.
        this.log(`callin: the call-in to ${machine} could not be sent (${errorText(error)})`);
        settle(failed(`its machine ${machine} could not be asked`));
      });
    });
  };

  /** The ask's own slot ended refused at B (or the machine was revoked): the wait ends now instead of after the wait. */
  private askEnded(slot: Slot, outcome: Outcome): void {
    const callId = this.asked.get(slotKey(slot));
    const wait = callId ? this.waits.get(callId) : undefined;
    if (!wait || outcome.kind !== "refused") return;
    const machine = wait.machine;
    // The reason is one of a closed set; the owner's `detail` is peer text and is not shown.
    wait.settle(outcome.reason === "revoked" ? failed(`its machine ${machine} is not reachable`) : failed(`its machine ${machine} did not take it (${outcome.reason})`));
  }

  /** The host chat's slice, one `Who: text` line per message, newest last, the oldest cut to 64 KiB escaped bytes. */
  private transcriptOf(call: CallInTurnRequest): string {
    // Files named on this machine stay here: another machine gets the words and a count, never a path.
    const records: ChatRecord[] = call.transcript.map((record) => {
      const { attachments, ...rest } = record;
      return attachments?.length ? { ...rest, text: `${rest.text} [${attachments.length} attachment(s) not shared with another machine]` } : rest;
    });
    return cutOldest(transcriptLines(records, call.newest, call.speakerName, call.host.name), CALLIN_TRANSCRIPT_LIMIT);
  }

  /**
   * `callin.reply`'s check, inside the command's transaction: when a call-in is waiting, the reply must come from the
   * server it was asked of and name the bots it was asked about. Nothing waiting is not a refusal (it is dropped later).
   */
  check(origin: string, cmd: Reply): void {
    const wait = this.waits.get(cmd.callId);
    if (wait && !this.matches(wait, origin, cmd)) throw new SlotRefusal("invalid", "that answer is not for this call-in");
  }

  /** After the reply's transaction committed: ends the wait with the answer, or drops a reply nobody waits for. */
  deliver(origin: string, cmd: Reply): void {
    const wait = this.waits.get(cmd.callId);
    if (!wait || !this.matches(wait, origin, cmd)) {
      // A duplicate, a late reply, one for a call-in that was never asked or lost in a restart (D51; M5-03a posts late ones).
      this.log("callin: dropped an answer: no call-in is waiting for it (finished, given up, or this server restarted)");
      return;
    }
    wait.settle(this.answerOf(cmd.outcome));
  }

  private matches(wait: Wait, origin: string, cmd: Reply): boolean {
    return origin === wait.server && cmd.botId === wait.hostBotId && cmd.guest.botId === wait.guestBotId;
  }

  private answerOf(outcome: Reply["outcome"]): GuestAnswer {
    if (outcome.kind === "busy") return { kind: "busy" };
    if (outcome.kind === "failed") return failed(cleanLine(outcome.why, WHY_CHARS) || "it could not answer");
    return { kind: "reply", text: cleanReply(outcome.text), steps: [], engine: outcome.engine };
  }
}

/** `callin.reply` at the owner of the host bot (the intent handler): checked now, delivered after the commit. */
export function callInReply(deps: { scope: TxScope; callHost?: CallInHost }, { slot }: ApplyContext, cmd: Reply) {
  const host = deps.callHost;
  if (!host) throw new SlotRefusal("invalid", "call-ins are not ready on this server");
  host.check(slot.origin, cmd);
  deps.scope.afterCommit(() => host.deliver(slot.origin, cmd));
  return { result: { applied: true as const } };
}
