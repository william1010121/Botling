// The follow-up route of a worker a bot started in a call-in turn for another bot's @ (spec/models/worker: Link,
// Expire, TurnEnd). The bot's turns on that worker's notes and reports go back to the asking bot's chat for three days,
// across restarts (kept in the bot's settings as `callInWork`); each such turn is told back there once when it ends:
// its reply, or, for a turn on a report that failed or showed nothing, that it ended without one.

/** A worker started in a call-in turn: the chat it was called into, what it was asked there, and until when its news goes back. */
export interface CallInWork { caller: string; asked: string; until: number }
/** How long a worker started for a bot's @ reports back there (its later runs too). */
export const CALL_IN_WORK_MS = 3 * 24 * 60 * 60_000;

/** A turn's route back: the worker's and which news the turn is on (a run's report, or a note from a run at work). */
export interface CallInRelay extends CallInWork { news: "report" | "note" }

/** Where the routes are kept (the owner bot's settings). */
export interface CallInWorkStore { load(): unknown; save(work: Record<string, CallInWork>): void }

export class CallInWorkBook {
  private cache: Record<string, CallInWork> | null = null;

  constructor(private readonly store: CallInWorkStore, private readonly now: () => number = Date.now) {}

  /** The routes not expired, as saved. */
  private all(): Record<string, CallInWork> {
    if (!this.cache) {
      const saved = this.store.load();
      const now = this.now();
      this.cache = Object.fromEntries(Object.entries(saved && typeof saved === "object" ? saved as Record<string, CallInWork> : {})
        .filter(([, work]) => work && typeof work.caller === "string" && typeof work.until === "number" && work.until > now));
    }
    return this.cache;
  }

  /** Worker `workerId` was started in a call-in turn into `caller`'s chat, asked `asked`: its news goes back there. */
  link(workerId: string, caller: string, asked: string) {
    const now = this.now();
    const work = Object.fromEntries(Object.entries(this.all()).filter(([, entry]) => entry.until > now));
    work[workerId] = { caller, asked, until: now + CALL_IN_WORK_MS };
    this.cache = work;
    this.store.save(work);
  }

  /** The route of a turn on `workerId`'s news now (undefined: none, or expired). */
  relay(workerId: string | null | undefined, news: CallInRelay["news"]): CallInRelay | undefined {
    const work = workerId ? this.all()[workerId] : undefined;
    return work && work.until > this.now() ? { ...work, news } : undefined;
  }

  /** What the asking bot is told as a turn with route `relay` ends (null: nothing). */
  followUp(relay: CallInRelay | undefined, end: TurnEnd): CallInFollowUp {
    return followUpOf(relay, end, this.now());
  }
}

/** How a turn ended: its status, whether it showed anything, and its error. */
export interface TurnEnd { status: "done" | "failed" | "stopped"; visible: boolean; error?: string | null }

/** The asking bot gets the turn's reply, or word that it ended without one (`why`). */
export type CallInFollowUp = { kind: "reply" } | { kind: "noReply"; why: string } | null;

/**
 * What the asking bot is told as the turn with route `relay` ends at `now`: its reply when it ended with words; for a
 * turn on a run's report, word that it ended without an answer otherwise (the asking bot must hear the run ended); a
 * turn on a note that says nothing, or a route that expired, tells nothing.
 */
export function followUpOf(relay: CallInRelay | undefined, end: TurnEnd, now: number): CallInFollowUp {
  if (!relay || relay.until <= now) return null;
  if (end.status === "done" && end.visible) return { kind: "reply" };
  if (relay.news !== "report") return null;
  const why = end.status === "stopped" ? "its turn was stopped" : end.status === "failed" ? `its turn failed${end.error ? `: ${end.error.split("\n")[0]!.slice(0, 200)}` : ""}` : "it said nothing";
  return { kind: "noReply", why };
}
