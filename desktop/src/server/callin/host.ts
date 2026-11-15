// The host's side of a call-in (M5-02c, protocol v1 §15, D51, Q-C1). H is a chat on this server A; its bot @-mentions a bot
// that lives on server B. `Conversations` (2.x, core/conversations.ts) calls `remoteTurn`; this file asks B with one
// `callin.ask` (a server-origin slot, `ServerOrigin.submit`), waits for B's `callin.reply` to be applied here, and gives the
// answer back as a `GuestAnswer`, so the guest's line is appended to H by the same code that appends a local guest's line:
// only A writes H, once per call-in.
//
//   how long it waits             the 75 s (`SUB_BOT_WAIT_MS`) is a LIVENESS wait, not an answer deadline: a guest may take up to
//                                  15 minutes. The host keeps waiting while B's server is live (`peerState`, the peer sessions'
//                                  own last-heard bookkeeping: no new heartbeat) and gives up when it has been stale for 75 s,
//                                  or gone from the roster, or at an overall cap of 15 min + 1 min.
//   every wait ends exactly once   reply · failed · busy (B's outcomes), B not reachable (not in the roster, owned by another
//                                  server, stale for 75 s, the cap, the ask refused), the ask could not be sent, cancel (an
//                                  aborted signal), or this host closing. `settle` is the one place a wait ends: it removes
//                                  the entry first, so a second ending (a duplicate or late reply, a tick after a reply)
//                                  finds nothing to do.
//   the reply is peer text         it is cleaned before it is an answer (`cleanReply`): control characters and direction
//                                  marks removed, every `<` that opens a tag turned into a look-alike so no tag of the 2.x
//                                  reply parser (`<show command=…>`, choices, requests) can act on H; a `why` is one clean line.
//   the reply is authentic         the slot's origin must be the server the ask went to, and the bot ids must be the ones
//                                  asked (`check`, in the command's transaction); a reply from anyone else is refused and
//                                  leaves the wait alone.
//   the wait ends after the commit `deliver` runs after the reply's transaction committed, never inside it.
//   restart                        the waits are in memory: a restart of A loses them, and a reply for a call-in nobody gave up
//                                  on (finished, never asked, lost in the restart) finds no wait and is dropped (applied, logged
//                                  once, no line, nobody woken).
//   giving up (M5-03a, D51)        when the wait ends because B is silent for 75 s, B is gone, or the cap is reached: ONE
//                                  `callin.cancel` goes to B (a slot: B skips the call-in if it has not started, stops the
//                                  guest turn if it has) and the callId is kept in `meta` for 7 days (`late.ts`). The wait ends
//                                  first (`settle`), so the give-up and the cancel happen once. Not a give-up: the ask could
//                                  not be sent or was refused (nothing was queued), this host closing.
//   a late reply                   a `callin.reply` for a given-up call-in is posted marked late through `bindLate` (the chat
//                                  notice and the guest's line) and wakes nobody: it never resolves a wait and never takes the
//                                  2.x wake path. It is used up by the first reply (at most one late line, across restarts);
//                                  a late `failed` or `busy` (a cancelled call answers `failed "cancelled"`) posts nothing.
//   a late line survives a crash   (fu-callin-outbox) the reply's transaction that uses the record up also writes the line as a
//                                  `callin:late:<callId>` row (`late-outbox.ts`); the line is posted after the commit and the row
//                                  deleted. A crash in between leaves the row and the next start posts it (`bindLate`); the chat
//                                  keys the line by callId, so a crash after the post and before the delete posts it once.
import { randomUUID } from "node:crypto";
import type { Command } from "../../contract";
import type { GuestAnswer } from "../../core/bot";
import type { RemoteTurnRequest } from "../../core/conversations";
import { SUB_BOT_WAIT_MS } from "../../core/sub-bots";
import { oneLine, transcriptLines } from "../../core/groups";
import type { ChatRecord } from "../../core/store/records";
import { slotKey, type Outcome, type Slot, type Target } from "../../protocol";
import type { ApplyContext } from "../slots";
import { SlotRefusal } from "../slots";
import type { TxScope } from "../effects";
import type { Db } from "../store";
import type { CallInSender } from "./guest";
import type { CallInCrash } from "./crash";
import { GaveUpBook, type GaveUp } from "./late";
import { LateOutbox, type LateRow } from "./late-outbox";
import { cleanLine, stripControls } from "./prompt";
import { CALLIN_NAME_LIMIT, CALLIN_REPLY_LIMIT, CALLIN_TRANSCRIPT_LIMIT, cutOldest, cutUnits } from "./wire-text";

/** How long B's server may be silent before the host gives up (the 2.x call-in wait; above the guest's 60 s busy wait). */
export const CALLIN_HOST_WAIT_MS = SUB_BOT_WAIT_MS;
/** The most a call-in may wait whatever B's server does: the guest's own answer limit (15 min) and a minute. */
export const CALLIN_HOST_CAP_MS = 16 * 60_000;
/** How often the waits are checked against the peer's state. */
const TICK_MS = 5_000;
/** One transcript line, in characters (the renderer cuts the text to 400, and adds options and picks). */
const TRANSCRIPT_LINE_CHARS = 2_000;
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
  /** The peer session's state of `server` (the peer sessions' own: `live`, `stale` since its last frame, `gone`), or null. */
  peerState(server: string): { state: "live" | "stale" | "gone"; since: number | null } | null;
}

/** A late answer for the host chat (M5-03a): the guest's line is appended marked late; nobody is woken for it. */
export interface LateLine {
  /** The call-in: the chat posts the late line once per callId (a post after a crash is told by it). */
  callId: string;
  /** The host chat. */
  chatId: string;
  member: { id: string; name: string };
  answer: Extract<GuestAnswer, { kind: "reply" }>;
}

export interface CallInHostOptions {
  /** Where given-up call-ins are kept (`meta`); none: memory only (tests). */
  scope?: TxScope;
  /** How long a given-up call-in is remembered (default 7 days) and how many are kept (default 500). */
  keepMs?: number;
  maxGaveUp?: number;
  /** How long B's server may stay stale before the wait ends (default `CALLIN_HOST_WAIT_MS`). */
  staleMs?: number;
  /** The most a wait may last (default `CALLIN_HOST_CAP_MS`). */
  capMs?: number;
  /** How often the waits are checked (default 5 s). */
  tickMs?: number;
  now?: () => number;
  log?: (line: string) => void;
  /** Test hook (`BOTLING_SERVER_CALLIN_CRASH`, fake agent only): called right after a late reply's transaction committed. */
  crash?: CallInCrash | null;
}

interface Wait {
  server: string;
  guestBotId: string;
  hostBotId: string;
  /** The machine's name as shown (quoted, one clean line). */
  machine: string;
  startedAt: number;
  settle(answer: GuestAnswer): void;
  /** The wait ends "unreachable" and B is told to cancel (D51); a no-op once the wait has ended. */
  giveUp(): void;
}

/** `remoteTurn`'s request, plus an optional signal that cancels the wait. */
export type CallInTurnRequest = RemoteTurnRequest & { signal?: AbortSignal };

const failed = (why: string): GuestAnswer => ({ kind: "failed", why });
const errorText = (error: unknown) => cleanLine(error instanceof Error ? error.message : String(error), 200);

/**
 * The guest's reply as an answer for H: peer text, so controls are gone, runs of `>>>` / `<<<` are spaced out (a bot that
 * asked is handed the answer inside a quoted block of its prompt), and no tag can act (see the file header). Lines stay lines.
 */
export function cleanReply(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => cleanLine(line, CALLIN_REPLY_LIMIT)).join("\n").replace(/<(?=[A-Za-z/!?])/g, "＜");
}

export class CallInHost {
  private sender: CallInHostSender | null = null;
  private unsubscribe: (() => void) | null = null;
  private closed = false;
  /** The waits by callId. */
  private readonly waits = new Map<string, Wait>();
  /** The ask's slot → its callId, so a refusal of the ask ends the wait at once. */
  private readonly asked = new Map<string, string>();
  private readonly staleMs: number;
  private readonly capMs: number;
  private readonly tickMs: number;
  private readonly now: () => number;
  private ticker: NodeJS.Timeout | null = null;
  private readonly log: (line: string) => void;
  private readonly options: CallInHostOptions;
  private readonly gaveUp: GaveUpBook;
  private lateSink: ((late: LateLine) => void | Promise<void>) | null = null;
  private readonly outbox = new LateOutbox();
  /** Late lines being posted now, by callId: a start-time drain and a fresh reply never post the same one at once. */
  private readonly posting = new Set<string>();

  constructor(options: CallInHostOptions = {}) {
    this.options = options;
    this.staleMs = options.staleMs ?? CALLIN_HOST_WAIT_MS;
    this.capMs = options.capMs ?? CALLIN_HOST_CAP_MS;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
    this.gaveUp = new GaveUpBook({ scope: options.scope ?? null, now: this.now, log: this.log, ...(options.keepMs !== undefined ? { keepMs: options.keepMs } : {}), ...(options.maxGaveUp !== undefined ? { max: options.maxGaveUp } : {}) });
  }

  /**
   * Binds where a late line goes (botlingd: the core's `Conversations.postLate`). Late lines a crash left in the outbox are
   * posted now; a late reply that comes before this stays in the outbox until then.
   */
  bindLate(sink: (late: LateLine) => void | Promise<void>): void {
    this.lateSink = sink;
    void this.drainLate();
  }

  /** Binds the server origin (botlingd does it once `ServerOrigin` exists); until then every call-in is "not reachable". */
  attach(sender: CallInHostSender): void {
    void this.sweep(); // expired given-up records go at every start
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
    this.stopTicker();
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
      host: { server: sender.self, botId: call.host.botId, name: cutUnits(cleanLine(call.host.name, 80), CALLIN_NAME_LIMIT).trim() || "bot" },
      transcript: this.transcriptOf(call),
      asked: cutUnits(stripControls(call.asked), ASKED_UNITS) || `@${cleanLine(call.member.name, 80)}`,
      by: call.by, depth: Math.min(2, Math.max(1, Math.trunc(call.depth) || 1)),
    };
    return new Promise<GuestAnswer>((resolve) => {
      let done = false;
      let slotId: string | null = null;
      // The ask went out (true) or could not be sent (false): a cancel only follows an ask that was queued.
      let sent: Promise<boolean> = Promise.resolve(false);
      const who = { server: call.member.server, hostBotId: call.host.botId, guestBotId: call.member.id, guestName: call.member.name };
      // The caller stopped waiting: B is told, and the answer is not wanted later either (no record, so a reply is dropped).
      const onAbort = () => {
        if (done) return;
        settle(failed("cancelled"));
        void this.cancelAsk(target, callId, machine, sent);
      };
      // D51: B is silent, gone or over the cap. The wait ends first (so this runs once); the record is written before B is
      // told, so a reply to the cancel finds it.
      const giveUp = () => {
        if (done) return;
        settle(unreachable);
        void this.gaveUp.remember(callId, who).then(() => this.cancelAsk(target, callId, machine, sent));
      };
      const settle = (answer: GuestAnswer) => {
        if (done) return;
        done = true;
        call.signal?.removeEventListener("abort", onAbort);
        this.waits.delete(callId);
        if (this.waits.size === 0) this.stopTicker();
        if (slotId) this.asked.delete(slotId);
        resolve(answer);
      };
      this.waits.set(callId, { server: call.member.server, guestBotId: call.member.id, hostBotId: call.host.botId, machine, startedAt: this.now(), settle, giveUp });
      this.startTicker();
      call.signal?.addEventListener("abort", onAbort, { once: true });
      sent = sender.submit(target, ask).then((slot) => {
        if (done) return true; // ended before the ask was queued: it is queued now, and a cancel (if any) follows it
        call.onBegin?.();
        slotId = slotKey(slot);
        this.asked.set(slotId, callId);
        // Refused before we looked (the outcome is already known): end now.
        const known = sender.outcome?.(slot) ?? null;
        if (known) this.askEnded(slot, known);
        return true;
      }, (error: unknown) => {
        // `ServerOrigin.submit` checks before it commits: nothing was queued, nothing will answer.
        this.log(`callin: the call-in to ${machine} could not be sent (${errorText(error)})`);
        settle(failed(`its machine ${machine} could not be asked`));
        return false;
      });
    });
  };

  /** D51: tells B this host gave up (`callin.cancel`, one slot), after its ask was queued. A failure is logged, never retried. */
  private async cancelAsk(target: Target, callId: string, machine: string, sent: Promise<boolean>): Promise<void> {
    const sender = this.sender;
    try {
      if (!sender || !(await sent)) return;
      await sender.submit(target, { type: "callin.cancel", botId: target.slice("bot:".length), callId });
    } catch (error) {
      this.log(`callin: the cancel for the call-in to ${machine} could not be sent (${errorText(error)})`);
    }
  }

  private startTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => this.tick(), this.tickMs);
    this.ticker.unref?.();
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  /**
   * The wait is a liveness wait (file header): a wait ends here when B's server is gone from the roster, has been silent
   * (stale) for `staleMs`, or the wait is over the cap. Silence is counted from the peer's last frame, but never from before
   * this call-in began, so every call-in gets its full window. No state for the peer: counted as stale (fail closed).
   */
  private tick(): void {
    const sender = this.sender;
    const now = this.now();
    for (const wait of [...this.waits.values()]) {
      if (now - wait.startedAt >= this.capMs) { wait.giveUp(); continue; }
      let peer: ReturnType<CallInHostSender["peerState"]> = null;
      try { peer = sender?.peerState(wait.server) ?? null; } catch { peer = null; }
      if (peer?.state === "live") continue;
      if (peer?.state === "gone") { wait.giveUp(); continue; }
      const quietSince = Math.max(peer?.since ?? wait.startedAt, wait.startedAt);
      if (now - quietSince >= this.staleMs) wait.giveUp();
    }
  }

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
    // One line per message, whatever the chat text holds: `transcriptLines` already folds newlines (`oneLine`), and every
    // line is folded and stripped once more here, so no chat text can start a line of its own with a speaker's label
    // ("User (newest): …") for the guest to read as another speaker.
    const lines = transcriptLines(records, call.newest, call.speakerName, call.host.name).map((line) => oneLine(stripControls(line), TRANSCRIPT_LINE_CHARS));
    return cutOldest(lines, CALLIN_TRANSCRIPT_LIMIT);
  }

  /**
   * `callin.reply`'s check, inside the command's transaction. A call-in is waiting: the reply must come from the server it was
   * asked of and name the bots it was asked about (null: delivered to the wait after the commit). A call-in this server gave
   * up on (D51): the same, then its record is used up here, in this transaction, and the record is returned: the reply is
   * late. Nothing known: not a refusal (dropped after the commit).
   */
  check(tx: Db, origin: string, cmd: Reply): GaveUp | null {
    const wait = this.waits.get(cmd.callId);
    if (wait) {
      if (!this.matches(wait, origin, cmd)) throw new SlotRefusal("invalid", "that answer is not for this call-in");
      return null;
    }
    const record = this.gaveUp.find(tx, cmd.callId);
    if (!record) return null;
    if (!this.matches(record, origin, cmd)) throw new SlotRefusal("invalid", "that answer is not for this call-in");
    this.gaveUp.consume(tx, cmd.callId);
    // The line this reply owes goes into the same transaction as the consume: both commit or neither (a crash after the commit
    // leaves the row, and the next start posts it).
    const row = this.lateRowOf(record, cmd);
    if (row) this.outbox.stage(tx, cmd.callId, row, this.now());
    return record;
  }

  /** The line a late reply owes the chat: only an answer with words (a late `failed` or `busy` posts nothing). */
  private lateRowOf(record: GaveUp, cmd: Reply): LateRow | null {
    const outcome = cmd.outcome;
    if (outcome.kind !== "reply") return null;
    const text = cleanReply(outcome.text);
    if (!text.trim()) return null;
    const at = this.now();
    return { chatId: record.hostBotId, guestBotId: record.guestBotId, guestName: record.guestName, text, engine: outcome.engine, at, until: Math.max(record.until, at + 1) };
  }

  /** Sweeps the expired and damaged given-up records (a writer transaction of its own). */
  sweep(): Promise<void> {
    return this.options.scope?.submit((tx) => this.gaveUp.sweep(tx)).catch((error: unknown) => this.log(`callin: the given-up records could not be swept (${errorText(error)})`)) ?? Promise.resolve();
  }

  /**
   * After the reply's transaction committed: ends the wait with the answer; or, for a call-in given up on (`late`, from
   * `check`), posts the guest's line marked late (D51: wakes nobody, never resolves a wait); or drops a reply nobody waits for.
   */
  deliver(origin: string, cmd: Reply, late: GaveUp | null = null): void {
    if (late) { this.postLate(late, cmd); return; }
    const wait = this.waits.get(cmd.callId);
    if (!wait || !this.matches(wait, origin, cmd)) {
      // A duplicate, one for a call-in that was never asked, finished, or lost in a restart (no record of a give-up).
      this.log("callin: dropped an answer: no call-in is waiting for it (finished, given up, or this server restarted)");
      return;
    }
    wait.settle(this.answerOf(cmd.outcome));
  }

  /**
   * D51: the late line, after the reply's transaction committed (its row is in the outbox). Only an answer with words is posted;
   * a late `failed` (a cancelled call answers so) or `busy` is not.
   */
  private postLate(record: GaveUp, cmd: Reply): void {
    this.options.crash?.("host", cmd.callId);
    const row = this.lateRowOf(record, cmd);
    if (!row) { this.log("callin: a late answer without a line was dropped"); return; }
    void this.postRow(cmd.callId, row);
  }

  /** Posts one outbox row through the sink, then deletes it. A failure keeps the row (the next start posts it again). Never rejects. */
  private async postRow(callId: string, row: LateRow): Promise<void> {
    const sink = this.lateSink;
    if (!sink || this.posting.has(callId)) return; // unbound: the row waits for `bindLate`
    this.posting.add(callId);
    try {
      const answer = { kind: "reply" as const, text: row.text, steps: [], engine: row.engine };
      await sink({ callId, chatId: row.chatId, member: { id: row.guestBotId, name: row.guestName }, answer });
      await this.options.scope?.submit((tx) => this.outbox.drop(tx, callId));
    } catch (error) {
      this.log(`callin: a late answer could not be posted, it stays queued (${errorText(error)})`);
    } finally {
      this.posting.delete(callId);
    }
  }

  /** Posts every row the outbox still holds (at start, once the sink is bound). */
  private async drainLate(): Promise<void> {
    const scope = this.options.scope;
    if (!scope) return;
    try {
      const rows = await scope.submit((tx) => this.outbox.pending(tx, this.now()));
      for (const { callId, row } of rows) await this.postRow(callId, row);
    } catch (error) {
      this.log(`callin: the late lines could not be read (${errorText(error)})`);
    }
  }

  private matches(wait: { server: string; hostBotId: string; guestBotId: string }, origin: string, cmd: Reply): boolean {
    return origin === wait.server && cmd.botId === wait.hostBotId && cmd.guest.botId === wait.guestBotId;
  }

  private answerOf(outcome: Reply["outcome"]): GuestAnswer {
    if (outcome.kind === "busy") return { kind: "busy" };
    if (outcome.kind === "failed") return failed(cleanLine(outcome.why, WHY_CHARS) || "it could not answer");
    return { kind: "reply", text: cleanReply(outcome.text), steps: [], engine: outcome.engine };
  }
}

/** `callin.reply` at the owner of the host bot (the intent handler): checked now, delivered after the commit. */
export function callInReply(deps: { scope: TxScope; callHost?: CallInHost }, { slot, tx }: ApplyContext, cmd: Reply) {
  const host = deps.callHost;
  if (!host) throw new SlotRefusal("invalid", "call-ins are not ready on this server");
  const late = host.check(tx, slot.origin, cmd);
  deps.scope.afterCommit(() => host.deliver(slot.origin, cmd, late));
  return { result: { applied: true as const } };
}
