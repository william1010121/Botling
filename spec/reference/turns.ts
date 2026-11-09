// A bot's turn schedule of spec/models/turns/Turns.tla (and TurnsAgy.tla), action for action. Pure: a step takes a
// state and returns the next one, or null when the action is not enabled. Each bot.ts call chain is a function of
// the whole state, as in the model, so they compose the same way. Sets are sorted arrays, so that a state's JSON is
// its identity (the conformance test explores the reference like TLC and compares the count of distinct states).

export type Bug = "silentsteer" | "apphold" | "steerold" | "reportgate" | "gracesend" | "drainnext" | "tidysteer";
export type Engine = "claude" | "agy";
export type Kind = "user" | "app" | "bg" | "tidy";

export interface TurnsConfig {
  /** Lines typed by the user (a call-in's relay counts). */
  users: string[];
  /** The app's own wake-ups: a routine, a worker's report, the continue note, a follow-up. */
  apps: string[];
  /** The app wake-ups that are handed-over work. */
  conducted: string[];
  engine: Engine;
  maxMoves: number;
  maxWork: number;
  maxSwaps: number;
  bug?: Bug;
}

/** The resume note's line, the tidy's, and none (a turn the head started itself). */
export const R = "resume";
export const T = "tidy";
export const NoLine = "none";

export interface TurnRec {
  line: string;
  /** The line whose "completed" ends it while set aside (your line steered into it, from then on). */
  cid: string;
  kind: Kind;
  carries: string[];
  unread: string[];
  shown: boolean;
  conducted: boolean;
  sent: boolean;
  open: boolean;
}

export interface TurnsState {
  fresh: string[];
  claim: string;
  queue: string[];
  offered: string[];
  turn: TurnRec;
  deferred: TurnRec;
  loose: string[];
  ignore: number;
  draining: boolean;
  paused: boolean;
  hold: boolean;
  swap: boolean;
  swaps: number;
  tidying: boolean;
  gate: boolean;
  folder: number;
  moves: number;
  awake: boolean;
  headAt: number;
  pending: boolean;
  work: boolean;
  works: number;
  rep: boolean;
  inbox: string[];
  cturn: boolean;
  cline: string;
  read: Record<string, number>;
  stopped: string[];
  stale: boolean;
}

export type TurnsAction =
  | { name: "Arrive"; m: string }
  | { name: "Claim"; m: string }
  | { name: "StopQueued"; m: string }
  | { name: "AgyInsert"; m: string }
  | { name: "ReleaseClaim" }
  | { name: "Stop" }
  | { name: "StopDeferred" }
  | { name: "StopClaim" }
  | { name: "Grace" }
  | { name: "CBegin" }
  | { name: "CRead"; said: boolean }
  | { name: "CShow" }
  | { name: "CEnd" }
  | { name: "CReport" }
  | { name: "StartWork" }
  | { name: "EndWork" }
  | { name: "GateOn" }
  | { name: "GateOff" }
  | { name: "Move" }
  | { name: "SwapOn" }
  | { name: "SwapOff" }
  | { name: "ReleaseHold" }
  | { name: "Tidy" }
  | { name: "TidyLate" }
  | { name: "Sleep" };

const add = (set: string[], ...items: string[]) => [...new Set([...set, ...items])].sort();
const without = (set: string[], ...items: string[]) => set.filter((e) => !items.includes(e));
const has = (t: TurnRec) => t.open;

const turnOf = (line: string, kind: Kind, carries: string[], conducted: boolean): TurnRec =>
  ({ line, cid: line, kind, carries: [...carries].sort(), unread: [], shown: false, conducted, sent: false, open: true });
export const noTurn = (): TurnRec => ({ line: NoLine, cid: NoLine, kind: "bg", carries: [], unread: [], shown: false, conducted: false, sent: false, open: false });

export class TurnsReference {
  constructor(readonly config: TurnsConfig) {}

  get msgs(): string[] { return [...this.config.users, ...this.config.apps].sort(); }
  private get bug() { return this.config.bug; }

  kind(l: string): Kind { return this.config.users.includes(l) ? "user" : "app"; }
  /** LTurn: the turn that carries line l (the resume note carries the work it resumes). */
  lturn(l: string): TurnRec { return turnOf(l, this.kind(l), this.msgs.includes(l) ? [l] : [], this.config.conducted.includes(l) || l === R); }

  init(): TurnsState {
    const read: Record<string, number> = {};
    for (const m of this.msgs) read[m] = 0;
    return {
      fresh: this.msgs, claim: NoLine, queue: [], offered: [],
      turn: noTurn(), deferred: noTurn(), loose: [], ignore: 0, draining: false,
      paused: false, hold: false, swap: false, swaps: 0, tidying: false, gate: false,
      folder: 0, moves: 0, awake: false, headAt: -1, pending: false,
      work: false, works: 0, rep: false,
      inbox: [], cturn: false, cline: NoLine,
      read, stopped: [], stale: false,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The app (bot.ts).

  ownWork(x: TurnsState): boolean { return x.work || x.rep || x.loose.length > 0; }
  steered(x: TurnsState): string[] { return add(x.loose, ...x.turn.unread); }
  holds(x: TurnsState, k: Kind): boolean { return x.awake && x.pending && this.ownWork(x) && (k === "user" || this.bug !== "apphold"); }
  waiting(x: TurnsState): boolean { return x.queue.some((l) => this.kind(l) === "user" || this.bug !== "apphold"); }
  releaseOK(x: TurnsState): boolean { return !(this.waiting(x) && x.pending && x.awake && this.ownWork(x)); }

  gone(x: TurnsState): TurnsState {
    return { ...x, awake: false, headAt: -1, pending: false, inbox: [], cturn: false, cline: NoLine,
      loose: [], ignore: 0, paused: false, work: false, rep: false, offered: [], gate: false };
  }

  sendLine(x: TurnsState, l: string): TurnsState {
    return { ...x, inbox: [...x.inbox, l], turn: { ...x.turn, sent: true }, stale: x.stale || (l !== T && x.headAt !== x.folder) };
  }

  deliver(x: TurnsState, given: boolean): TurnsState {
    if (!given && this.holds(x, x.turn.kind)) return { ...x, turn: noTurn(), queue: [x.turn.line, ...x.queue], hold: true };
    const x1 = !given && x.awake && x.pending && !this.ownWork(x) ? { ...this.gone(x), awake: true, headAt: x.folder, turn: x.turn, deferred: x.deferred } : x;
    const x2 = !x1.awake ? { ...x1, awake: true, headAt: x1.folder, pending: false } : x1;
    return this.sendLine(x2, x2.turn.line);
  }

  begin(x: TurnsState, t: TurnRec, given: boolean): TurnsState {
    const x1 = { ...x, turn: t };
    return x.draining ? x1 : this.deliver(x1, given);
  }

  resume(x: TurnsState): TurnsState { return this.begin({ ...x, paused: false }, this.lturn(R), this.bug === "apphold"); }

  afterDeferred(x: TurnsState): TurnsState {
    if (x.swap) return x;
    if (x.paused && x.awake) return this.resume(x);
    const x1 = { ...x, paused: false };
    if (x1.hold && !this.releaseOK(x1)) return x1;
    const x2 = { ...x1, hold: false };
    if (!x2.queue.length) return x2;
    const m = x2.queue[0]!;
    return this.begin({ ...x2, queue: x2.queue.slice(1), offered: without(x2.offered, m) }, this.lturn(m), false);
  }

  doNext(x: TurnsState): TurnsState {
    if (has(x.turn) || x.tidying || (x.draining && this.bug !== "drainnext")) return x;
    const d = x.deferred;
    if (has(d) && x.awake) return { ...x, deferred: noTurn(), turn: d };
    const x1 = d.sent && !d.open && d.line !== NoLine && x.awake ? { ...x, deferred: noTurn(), ignore: x.ignore + 1 } : { ...x, deferred: noTurn() };
    return this.afterDeferred(x1);
  }

  checkHold(x: TurnsState): TurnsState {
    if (!x.hold || !this.releaseOK(x)) return x;
    const x1 = { ...x, hold: false };
    return !has(x1.turn) && !x1.tidying ? this.doNext(x1) : x1;
  }

  finish(x: TurnsState): TurnsState {
    const t = x.turn;
    const x1 = { ...x, turn: noTurn(), loose: add(x.loose, ...t.unread), gate: false };
    return t.kind === "tidy" ? x1 : this.doNext(x1);
  }

  canPause(x: TurnsState, m: string): boolean {
    return this.config.engine === "claude" && this.kind(m) === "user" && x.turn.kind !== "user" && x.turn.kind !== "tidy" && !x.paused
      && x.turn.sent && !x.queue.length && !x.draining && x.ignore === 0 && !x.gate;
  }
  canSteer(x: TurnsState, m: string): boolean {
    return this.config.engine === "claude" && this.kind(m) === "user" && x.turn.kind !== "tidy" && !x.turn.conducted && x.turn.sent
      && !x.draining && x.ignore === 0 && !x.queue.length && (x.turn.kind === "user" || !x.gate);
  }
  canOffer(x: TurnsState, m: string): boolean {
    return this.config.engine === "agy" && this.kind(m) === "user" && x.turn.kind !== "tidy" && !x.turn.conducted && x.turn.sent
      && !x.draining && x.ignore === 0 && x.queue.every((l) => x.offered.includes(l)) && (x.turn.kind === "user" || !x.gate);
  }

  steer(x: TurnsState, m: string): TurnsState {
    return { ...x, inbox: [...x.inbox, m], turn: { ...x.turn, kind: "user", conducted: false, cid: m, unread: add(x.turn.unread, m) }, stale: x.stale || x.headAt !== x.folder };
  }
  offer(x: TurnsState, m: string): TurnsState {
    return { ...x, queue: [...x.queue, m], offered: add(x.offered, m), stale: x.stale || x.headAt !== x.folder };
  }
  enq(x: TurnsState, m: string): TurnsState { return { ...x, queue: [...x.queue, m] }; }

  route(x: TurnsState, m: string): TurnsState {
    const k = this.kind(m);
    if (x.swap) return this.enq(x, m);
    if (x.hold) return this.checkHold(this.enq(x, m));
    if (!has(x.turn) && !x.tidying && this.holds(x, k)) return { ...x, queue: [m, ...x.queue], hold: true };
    if (!has(x.turn) && !x.tidying) return this.begin(x, this.lturn(m), false);
    if (!has(x.turn) || (x.tidying && this.bug !== "tidysteer")) return this.enq(x, m);
    if (x.pending && this.bug !== "steerold") return this.enq(x, m);
    if (this.canPause(x, m)) return { ...this.steer(x, m), paused: true };
    if (this.canSteer(x, m)) return this.steer(x, m);
    if (this.canOffer(x, m)) return this.offer(x, m);
    return this.enq(x, m);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The head's events.

  steeredStarted(x: TurnsState, l: string, mid: boolean): TurnsState {
    const w = x.turn;
    const x0 = { ...x, loose: without(x.loose, l), turn: { ...x.turn, unread: without(x.turn.unread, l) } };
    if (x.draining || x.ignore > 0) return x0;
    if (mid && this.bug !== "silentsteer") return x0;
    if (has(w) && (!w.sent || w.shown || has(x.deferred))) return x0;
    return { ...x0, deferred: has(w) ? x0.turn : x0.deferred, turn: { ...turnOf(l, "user", [l], false), sent: true } };
  }
  started(x: TurnsState, l: string, mid: boolean): TurnsState { return this.steered(x).includes(l) ? this.steeredStarted(x, l, mid) : x; }

  completed(x: TurnsState, l: string): TurnsState {
    const x0 = { ...x, loose: without(x.loose, l), turn: { ...x.turn, unread: without(x.turn.unread, l) } };
    return has(x0.deferred) && x0.deferred.cid === l ? { ...x0, deferred: noTurn() } : x0;
  }

  drainEnd(x: TurnsState): TurnsState { return this.doNext(has(x.turn) && !x.turn.sent ? this.deliver(x, false) : x); }

  result(x: TurnsState): TurnsState {
    if (x.ignore > 0) return { ...x, ignore: x.ignore - 1 };
    if (x.draining) return this.drainEnd({ ...x, draining: false });
    if (has(x.turn) && x.turn.sent) return this.finish(x);
    return x;
  }

  markRead(x: TurnsState, l: string): TurnsState { return this.msgs.includes(l) ? { ...x, read: { ...x.read, [l]: x.read[l]! + 1 } } : x; }

  canReport(x: TurnsState): boolean {
    return this.config.engine !== "agy" || (!has(x.turn) && !x.draining && (!x.queue.length || (x.hold && this.bug !== "reportgate")));
  }

  step(s: TurnsState, a: TurnsAction): TurnsState | null {
    const c = this.config;
    switch (a.name) {
      case "Arrive":
        if (!s.fresh.includes(a.m)) return null;
        return this.route({ ...s, fresh: without(s.fresh, a.m) }, a.m);
      case "Claim":
        if (!s.fresh.includes(a.m) || this.kind(a.m) !== "user" || s.claim !== NoLine) return null;
        return { ...s, fresh: without(s.fresh, a.m), claim: a.m };
      case "ReleaseClaim":
        if (s.claim === NoLine) return null;
        return this.route({ ...s, claim: NoLine }, s.claim);
      case "Stop": {
        if (!has(s.turn) || s.turn.kind === "tidy") return null;
        const t = s.turn;
        const x = { ...s, paused: false, stopped: add(s.stopped, ...t.carries), turn: noTurn(), loose: add(s.loose, ...t.unread), gate: false };
        return t.sent && s.awake ? { ...x, draining: true } : this.doNext(x);
      }
      case "StopQueued":
        if (!s.queue.includes(a.m) || !this.msgs.includes(a.m)) return null;
        return this.checkHold({ ...s, queue: s.queue.filter((l) => l !== a.m), offered: without(s.offered, a.m), stopped: add(s.stopped, a.m) });
      case "StopDeferred":
        if (!has(s.deferred)) return null;
        return { ...s, deferred: { ...s.deferred, open: false }, stopped: add(s.stopped, ...s.deferred.carries) };
      case "StopClaim":
        if (s.claim === NoLine) return null;
        return { ...s, claim: NoLine, stopped: add(s.stopped, s.claim) };
      case "Grace": {
        if (!s.draining || s.cturn || s.inbox.length) return null;
        const x0 = { ...s, draining: false };
        const x1 = this.bug === "gracesend" && has(x0.turn) && !x0.turn.sent ? this.deliver(x0, false) : x0;
        const x2 = { ...this.gone(x1), deferred: noTurn(), turn: x1.turn.sent ? noTurn() : x1.turn };
        return this.drainEnd(x2);
      }
      case "CBegin": {
        if (!s.awake || s.cturn || !s.inbox.length) return null;
        const l = s.inbox[0]!;
        return this.started(this.markRead({ ...s, inbox: s.inbox.slice(1), cturn: true, cline: l }, l), l, false);
      }
      case "CRead": {
        if (c.engine !== "claude" || !s.awake || !s.cturn || !s.inbox.length) return null;
        const l = s.inbox[0]!;
        const x = this.markRead({ ...s, inbox: s.inbox.slice(1) }, l);
        return this.completed(a.said ? this.started(x, l, true) : x, l);
      }
      case "CShow":
        if (!s.awake || !s.cturn || !has(s.turn) || !s.turn.sent || s.turn.shown || s.draining || s.ignore !== 0) return null;
        return { ...s, turn: { ...s.turn, shown: true } };
      case "CEnd": {
        if (!s.awake || !s.cturn) return null;
        const x = { ...s, cturn: false, cline: NoLine, offered: [] };
        return s.cline === NoLine ? this.result(x) : this.completed(this.result(x), s.cline);
      }
      case "AgyInsert":
        if (c.engine !== "agy" || !s.awake || !s.cturn || !s.offered.includes(a.m) || !s.queue.includes(a.m) || !has(s.turn) || !s.turn.sent) return null;
        return this.markRead({ ...s, queue: s.queue.filter((l) => l !== a.m), offered: without(s.offered, a.m),
          turn: { ...s.turn, kind: "user", carries: add(s.turn.carries, a.m) } }, a.m);
      case "CReport": {
        if (!s.awake || !s.rep || s.cturn || s.inbox.length || !this.canReport(s)) return null;
        const x = { ...s, rep: false, cturn: true, cline: NoLine };
        return !has(x.turn) && x.ignore === 0 ? { ...x, turn: { ...turnOf(NoLine, "bg", [], false), sent: true } } : x;
      }
      case "StartWork":
        if (!has(s.turn) || !s.turn.sent || !s.awake || s.work || s.works >= c.maxWork) return null;
        return { ...s, work: true, works: s.works + 1 };
      case "EndWork":
        if (!s.work) return null;
        return this.checkHold({ ...s, work: false, rep: true });
      case "GateOn":
        if (!has(s.turn) || !s.turn.sent || s.gate) return null;
        return { ...s, gate: true };
      case "GateOff":
        if (!s.gate) return null;
        return { ...s, gate: false };
      case "Move":
        if (s.moves >= c.maxMoves) return null;
        return { ...s, folder: s.folder + 1, moves: s.moves + 1, pending: s.awake };
      case "SwapOn":
        if (s.swap || s.swaps >= c.maxSwaps) return null;
        return { ...s, swap: true, swaps: s.swaps + 1 };
      case "SwapOff":
        if (!s.swap) return null;
        return this.doNext({ ...s, swap: false });
      case "ReleaseHold":
        if (!s.hold || !this.releaseOK(s)) return null;
        return this.checkHold(s);
      case "Tidy":
        if (!s.awake || has(s.turn) || s.queue.length || s.tidying || this.ownWork(s) || s.draining || s.hold || s.swap) return null;
        return this.begin({ ...s, tidying: true }, turnOf(T, "tidy", [], false), true);
      case "TidyLate":
        if (!s.tidying || !has(s.turn) || s.turn.kind !== "tidy") return null;
        return { ...s, turn: noTurn(), ignore: s.ignore + 1 };
      case "Sleep":
        if (!s.tidying || has(s.turn)) return null;
        return this.doNext({ ...this.gone(s), tidying: false, deferred: noTurn(), draining: false });
    }
  }

  /** Every action that could be enabled in `s` (the model's Next), enabled or not. */
  candidates(): TurnsAction[] {
    return [
      ...this.msgs.flatMap((m) => [{ name: "Arrive", m }, { name: "Claim", m }, { name: "StopQueued", m }, { name: "AgyInsert", m }] as TurnsAction[]),
      { name: "ReleaseClaim" }, { name: "Stop" }, { name: "StopDeferred" }, { name: "StopClaim" }, { name: "Grace" },
      { name: "CBegin" }, { name: "CRead", said: false }, { name: "CRead", said: true }, { name: "CShow" }, { name: "CEnd" }, { name: "CReport" },
      { name: "StartWork" }, { name: "EndWork" }, { name: "GateOn" }, { name: "GateOff" },
      { name: "Move" }, { name: "SwapOn" }, { name: "SwapOff" }, { name: "ReleaseHold" }, { name: "Tidy" }, { name: "TidyLate" }, { name: "Sleep" },
    ];
  }

  enabled(s: TurnsState): TurnsAction[] { return this.candidates().filter((a) => this.step(s, a) !== null); }

  /** The model's invariants that fail in `s` (none: all hold). */
  invariants(s: TurnsState): string[] {
    const out: string[] = [];
    if (this.msgs.some((m) => s.read[m]! > 1)) out.push("ReadOnce");
    if (s.stale) out.push("StaleSend");
    if (has(s.turn) && s.turn.kind === "user" && s.turn.conducted) out.push("PausedNotYours");
    if (s.queue.length && !(has(s.turn) || s.hold || s.swap || s.tidying || s.draining)) out.push("QueueWaits");
    if (has(s.deferred) && !(has(s.turn) || s.draining)) out.push("DeferredBehind");
    return out;
  }

  /** The model's action properties that the step s -> n breaks (none: all hold). */
  stepProperties(s: TurnsState, n: TurnsState): string[] {
    const became = s.stopped.some((m) => has(n.turn) && n.turn.carries.includes(m) && !(has(s.turn) && s.turn.carries.includes(m)));
    return became ? ["StoppedNeverStarts"] : [];
  }
}

/** What the app holds of a state: what the conformance test compares (claude's side is the adapter's stand-in). */
export interface TurnsView {
  /** The lines that wait, in order (the resume note as "resume"). */
  queue: string[];
  /** The turn under way: the line it was made for, its kind, whether it went to the head; null when none. */
  turn: { line: string; kind: Kind; sent: boolean } | null;
  deferred: string | null;
  /** Your lines steered into a turn and not read yet (the app's `steered`). */
  steered: string[];
  paused: boolean;
  hold: boolean;
  draining: boolean;
  awake: boolean;
  /** The folder its process started in (-1: asleep). */
  headAt: number;
  pending: boolean;
  /** The lines on the stdin of its process that claude has not read yet. */
  inbox: string[];
}

export function viewOf(s: TurnsState): TurnsView {
  return {
    queue: s.queue,
    turn: has(s.turn) ? { line: s.turn.line, kind: s.turn.kind, sent: s.turn.sent } : null,
    deferred: has(s.deferred) ? s.deferred.line : null,
    steered: add(s.loose, ...s.turn.unread),
    paused: s.paused, hold: s.hold, draining: s.draining,
    awake: s.awake, headAt: s.headAt, pending: s.pending,
    inbox: s.inbox,
  };
}
