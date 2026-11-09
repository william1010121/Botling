// The @ routing and call-in state machine of spec/models/callin/Callin.tla, action for action.
// Pure: a step takes a state and returns the next one, or null when the action is not enabled.
// A bot that asked with @ below the depth limit is handed a turn when the call-in ends, answered or not.

export type Outcome = "queued" | "answering" | "answered" | "unheard" | "unreachable" | "dropped" | "merged" | "seen";
export type PendingState = "queued" | "answering";

/** One @ routed: who it was for, from a user line or a bot's reply (`msg`, 1-based; 0 for a user line). */
export interface At { chat: string; to: string; by: "user" | "bot"; body: string | null; depth: number; msg: number; st: Outcome; told: boolean; /** Turns handed back on it to the bot that asked. */ woke: number }

export interface CallinConfig {
  top: string[];
  /** Each sub bot's parent. */
  parent: Record<string, string>;
  cap: number;
  maxDepth: number;
  /**
   * "silent": before 78bf1640 (drops left no notice); "sub": before 9d7c0bda (and sub bots not callable either);
   * "nowake": a bot's @ that failed handed nothing back to the bot that asked (only an answer did).
   */
  bug?: "none" | "silent" | "sub" | "nowake";
}

export interface CallinState {
  ev: At[];
  pending: Record<string, { ev: number; st: PendingState }[]>;
  cur: Record<string, number>;
  phase: Record<string, "idle" | "wait" | "turn">;
  followUp: Record<string, number>;
  /** "to\nbody" of the bot @s delivered since the chat's last user line. */
  recent: Record<string, string[]>;
  own: Record<string, number>;
  guest: Record<string, boolean>;
  gone: string[];
}

export type CallinAction =
  | { name: "UserLine"; c: string; t: string | null }
  | { name: "BotReply"; c: string; t: string | null; b: string }
  | { name: "Rehear"; k: number }
  | { name: "OwnEnd"; b: string }
  | { name: "Remove"; s: string }
  | { name: "Start"; c: string }
  | { name: "Take"; c: string }
  | { name: "GiveUp"; c: string }
  | { name: "Answer"; c: string }
  | { name: "NoAnswer"; c: string };

const OPEN: Outcome[] = ["queued", "answering"];
const DELIVERED: Outcome[] = ["queued", "answering", "answered", "unheard"];
const pair = (to: string, body: string | null) => `${to}\n${body ?? ""}`;
const clone = (s: CallinState): CallinState => structuredClone(s);

export class CallinReference {
  constructor(readonly config: CallinConfig) {}

  get bots(): string[] { return [...this.config.top, ...Object.keys(this.config.parent)]; }
  private get silent() { return this.config.bug === "silent" || this.config.bug === "sub"; }
  /** A bot asked call-in `e`, below the depth limit: its end is handed back to the chat's bot. */
  private asks(e: At) { return e.by === "bot" && e.depth < this.config.maxDepth; }
  /** ... also when it was not answered. */
  private failWakes(e: At) { return this.asks(e) && this.config.bug !== "nowake"; }
  /** Call-in `e` of chat `c` hands its end back to the bot that asked. */
  private handBack(s: CallinState, c: string, e: At) { e.woke += 1; s.followUp[c] = e.depth; s.own[c]! += 1; }

  init(): CallinState {
    const per = <T>(keys: string[], value: () => T) => Object.fromEntries(keys.map((key) => [key, value()]));
    const top = this.config.top;
    return {
      ev: [], pending: per(top, () => []), cur: per(top, () => 0), phase: per(top, () => "idle" as const),
      followUp: per(top, () => 0), recent: per(top, () => []), own: per(this.bots, () => 0), guest: per(this.bots, () => false), gone: [],
    };
  }

  callable(s: CallinState, c: string): string[] {
    if (!this.config.top.includes(c)) return [];
    const subs = this.config.bug === "sub" ? [] : Object.keys(this.config.parent).filter((sub) => this.config.parent[sub] === c);
    return [...this.config.top.filter((other) => other !== c), ...subs].filter((bot) => !s.gone.includes(bot));
  }

  callee(s: CallinState, c: string): string { return s.ev[s.cur[c]! - 1]!.to; }

  private settle(s: CallinState, c: string, k: number) { s.pending[c] = s.pending[c]!.filter((p) => p.ev !== k); }

  private route(s: CallinState, c: string, t: string, b: string, m: number) {
    const d = s.followUp[c]!;
    s.followUp[c] = 0;
    const add = (st: Outcome, told: boolean, depth = d) => { s.ev.push({ chat: c, to: t, by: "bot", body: b, depth, msg: m, st, told, woke: 0 }); };
    if (!this.callable(s, c).includes(t)) return add("unreachable", !this.silent);
    if (s.ev.some((e) => e.msg === m && DELIVERED.includes(e.st))) return add("seen", false);
    if (d >= this.config.maxDepth) return add("dropped", !this.silent);
    if (s.recent[c]!.includes(pair(t, b))) {
      const covered = s.pending[c]!.some((p) => s.ev[p.ev - 1]!.to === t && s.ev[p.ev - 1]!.body === b);
      return covered ? add("merged", false) : add("dropped", !this.silent);
    }
    if (s.recent[c]!.length >= this.config.cap) return add("dropped", true);
    add("queued", false, d + 1);
    s.recent[c]!.push(pair(t, b));
    s.pending[c]!.push({ ev: s.ev.length, st: "queued" });
  }

  private finish(s: CallinState, c: string, st: Outcome, told: boolean, wake: boolean) {
    const k = s.cur[c]!, e = s.ev[k - 1]!;
    Object.assign(e, { st, told });
    if (wake) this.handBack(s, c, e);
    this.settle(s, c, k);
    s.cur[c] = 0;
    s.phase[c] = "idle";
  }

  /** The state after `a`, or null when `a` is not enabled. Bounds (how many @s, lines) are the caller's. */
  step(state: CallinState, a: CallinAction): CallinState | null {
    const s = clone(state);
    const top = this.config.top;
    switch (a.name) {
      case "UserLine": {
        if (!this.bots.includes(a.c) || s.gone.includes(a.c) || (a.t !== null && !this.callable(s, a.c).includes(a.t))) return null;
        s.own[a.c]! += 1;
        if (top.includes(a.c)) s.recent[a.c] = [];
        if (a.t !== null) {
          s.ev.push({ chat: a.c, to: a.t, by: "user", body: null, depth: 0, msg: 0, st: "queued", told: false, woke: 0 });
          s.pending[a.c]!.push({ ev: s.ev.length, st: "queued" });
        }
        return s;
      }
      case "BotReply": {
        if (!top.includes(a.c) || !(s.own[a.c]! > 0) || s.guest[a.c]) return null;
        if (a.t !== null && (!this.bots.includes(a.t) || a.t === a.c || s.gone.includes(a.t))) return null;
        s.own[a.c]! -= 1;
        if (a.t === null) s.followUp[a.c] = 0;
        else this.route(s, a.c, a.t, a.b, s.ev.length + 1);
        return s;
      }
      case "Rehear": {
        const e = s.ev[a.k - 1];
        if (!e || e.by !== "bot" || s.gone.includes(e.to)) return null;
        this.route(s, e.chat, e.to, e.body!, e.msg);
        return s;
      }
      case "OwnEnd": {
        if (!(s.own[a.b]! > 0) || s.guest[a.b]) return null;
        s.own[a.b]! -= 1;
        return s;
      }
      case "Remove": {
        if (!(a.s in this.config.parent) || s.gone.includes(a.s) || s.own[a.s]! > 0 || s.guest[a.s]) return null;
        s.gone.push(a.s);
        return s;
      }
      case "Start": {
        if (!top.includes(a.c) || s.cur[a.c] !== 0) return null;
        const k = s.ev.findIndex((e) => e.chat === a.c && e.st === "queued") + 1;
        if (k === 0) return null;
        const e = s.ev[k - 1]!;
        if (this.callable(s, a.c).includes(e.to)) {
          e.st = "answering";
          for (const p of s.pending[a.c]!) if (p.ev === k) p.st = "answering";
          s.cur[a.c] = k;
          s.phase[a.c] = "wait";
        } else {
          Object.assign(e, { st: "unheard", told: !this.silent });
          if (this.failWakes(e)) this.handBack(s, a.c, e);
          this.settle(s, a.c, k);
        }
        return s;
      }
      case "Take": {
        if (s.phase[a.c] !== "wait") return null;
        const b = this.callee(s, a.c);
        if (s.own[b]! > 0 || s.guest[b] || s.gone.includes(b)) return null;
        s.guest[b] = true;
        s.phase[a.c] = "turn";
        return s;
      }
      case "GiveUp": {
        if (s.phase[a.c] !== "wait") return null;
        const b = this.callee(s, a.c);
        if (!(s.own[b]! > 0 || s.guest[b] || s.gone.includes(b))) return null;
        this.finish(s, a.c, "unheard", true, this.failWakes(s.ev[s.cur[a.c]! - 1]!));
        return s;
      }
      case "Answer": {
        if (s.phase[a.c] !== "turn") return null;
        const k = s.cur[a.c]!, e = s.ev[k - 1]!;
        s.guest[e.to] = false;
        this.finish(s, a.c, "answered", false, this.asks(e));
        return s;
      }
      case "NoAnswer": {
        if (s.phase[a.c] !== "turn") return null;
        s.guest[this.callee(s, a.c)] = false;
        this.finish(s, a.c, "unheard", true, this.failWakes(s.ev[s.cur[a.c]! - 1]!));
        return s;
      }
    }
  }

  /** Every action enabled in `s`, within the bounds of one behaviour (`maxAts` @s, `maxOwn` lines waiting in a bot). */
  enabled(s: CallinState, bodies: string[], { maxAts, maxOwn }: { maxAts: number; maxOwn: number }): CallinAction[] {
    const room = s.ev.length < maxAts;
    const targets = [null, ...this.bots];
    const candidates: CallinAction[] = [
      ...this.bots.flatMap((c) => (s.own[c]! < maxOwn ? targets.filter((t) => t === null || room).map((t) => ({ name: "UserLine" as const, c, t })) : [])),
      ...this.config.top.flatMap((c) => targets.filter((t) => t === null || room).flatMap((t) => (t === null ? [bodies[0]!] : bodies).map((b) => ({ name: "BotReply" as const, c, t, b })))),
      ...(room ? s.ev.map((_, i) => ({ name: "Rehear" as const, k: i + 1 })) : []),
      ...this.bots.map((b) => ({ name: "OwnEnd" as const, b })),
      ...Object.keys(this.config.parent).map((sub) => ({ name: "Remove" as const, s: sub })),
      ...this.config.top.flatMap((c) => (["Start", "Take", "GiveUp", "Answer", "NoAnswer"] as const).map((name) => ({ name, c }))),
    ];
    return candidates.filter((a) => this.step(s, a) !== null);
  }

  // ---- The invariants of Callin.tla, for tests.
  invariants(s: CallinState): string[] {
    const broken: string[] = [];
    const top = this.config.top;
    if (top.some((c) => s.ev.filter((e) => e.chat === c && e.st === "answering").length > 1)) broken.push("OneSpeaker");
    if (this.bots.some((b) => top.filter((c) => s.phase[c] === "turn" && this.callee(s, c) === b).length !== (s.guest[b] ? 1 : 0))) broken.push("OneTurnEach");
    if (s.ev.some((e) => ["unreachable", "dropped", "unheard"].includes(e.st) && !e.told)) broken.push("NoSilentDrop");
    if (s.ev.some((e, j) => s.ev.some((f, k) => j !== k && e.msg !== 0 && e.msg === f.msg && DELIVERED.includes(e.st) && DELIVERED.includes(f.st)))) broken.push("DeliveredOnce");
    if (s.ev.some((e) => e.depth > this.config.maxDepth)) broken.push("HopBound");
    if (s.ev.some((e) => e.woke > 1)) broken.push("WakeOnce");
    if (s.ev.some((e) => e.woke > 0 && !(this.asks(e) && (e.st === "answered" || e.st === "unheard")))) broken.push("WakeBelowDepth");
    if (s.ev.some((e) => e.st === "unreachable" && this.config.parent[e.to] === e.chat)) broken.push("SubReachable");
    if (s.ev.some((e) => DELIVERED.includes(e.st) && e.to in this.config.parent && this.config.parent[e.to] !== e.chat)) broken.push("SubOnlyInParent");
    if (top.some((c) => s.recent[c]!.length > this.config.cap)) broken.push("CapPerUserLine");
    for (const c of top) {
      const open = s.ev.flatMap((e, i) => (e.chat === c && OPEN.includes(e.st) ? [i + 1] : []));
      const listed = s.pending[c]!;
      if (listed.map((p) => p.ev).join() !== open.join() || listed.some((p) => s.ev[p.ev - 1]!.st !== p.st)) broken.push("PendingExact");
    }
    return broken;
  }
}

/** What the app shows of the call-ins, the same shape the driver reads from the real code. */
export interface CallinView {
  /** Each chat's call-ins not answered yet: who, answering or queued. */
  pending: Record<string, { id: string; state: PendingState }[]>;
  /** Notices the call-ins left in each chat (a dropped @, a call-in not answered). */
  notices: Record<string, number>;
  /** Called-in bots' lines posted in each chat. */
  answers: Record<string, number>;
  /** Who answers in each chat now. */
  speaker: Record<string, string | null>;
  /** The hand-back depth waiting for each chat bot's next reply (0: none). */
  followUp: Record<string, number>;
  /** Turns each chat's bot was handed on the end of its @s (an answer, or word that it was not answered). */
  wakes: Record<string, number>;
}

export function viewOf(ref: CallinReference, s: CallinState): CallinView {
  const per = <T>(f: (c: string) => T) => Object.fromEntries(ref.config.top.map((c) => [c, f(c)]));
  return {
    pending: per((c) => s.pending[c]!.map((p) => ({ id: s.ev[p.ev - 1]!.to, state: p.st }))),
    notices: per((c) => s.ev.filter((e) => e.chat === c && e.told).length),
    answers: per((c) => s.ev.filter((e) => e.chat === c && e.st === "answered").length),
    speaker: per((c) => (s.phase[c] !== "idle" ? ref.callee(s, c) : null)),
    followUp: per((c) => s.followUp[c]!),
    wakes: per((c) => s.ev.filter((e) => e.chat === c).reduce((sum, e) => sum + e.woke, 0)),
  };
}
