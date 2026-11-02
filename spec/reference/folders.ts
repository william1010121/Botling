// Where a bot's session starts (`sessions.folder`) of spec/models/folders/Folders.tla, action for action.
// Pure: a step takes a state and returns the next one, or null when the action is not enabled. `moves` is a
// ghost counter (not in the model): how often the session was told it moved (Plugins' sessionMoved calls).

/** A worktree's name, or "P": the bot's project folder (nothing assigned). */
export type Place = string;
export const P: Place = "P";
export type PState = "loading" | "running" | "crashed" | "failed" | "disabled";
export type FolderMsg = { m: "set" | "sync"; f: Place };

export interface FoldersConfig {
  folders: string[];
  maxUses: number;
  maxBoots: number;
  maxEnables: number;
  /** "nohold": your message goes to the old process while its own work runs; "noinvalidate": a failed plugin still answers. */
  bug?: "nohold" | "noinvalidate";
}

export interface FoldersState {
  pstate: PState;
  crashes: number;
  truth: Place;
  everSet: Place[];
  uses: number;
  chan: FolderMsg[];
  cache: Place;
  disk: Place;
  told: Place;
  boots: number;
  enables: number;
  awake: boolean;
  /** null: asleep (the model's None). */
  headFolder: Place | null;
  turn: boolean;
  turnFolder: Place | null;
  work: boolean;
  pending: boolean;
  held: boolean;
  restarted: boolean;
  moves: number;
}

export type FoldersAction =
  | { name: "Use"; f: Place }
  | { name: "Load" }
  /** `keep`: how many lines the dying host had written (they still arrive). */
  | { name: "Crash"; keep: number }
  | { name: "HostRestart" }
  | { name: "Disable" }
  | { name: "Enable" }
  /** `dup`: the same line comes again; `saved`: the write to disk worked. */
  | { name: "CoreRecv"; dup: boolean; saved: boolean }
  | { name: "AppRestart" }
  | { name: "Msg" }
  | { name: "Release" }
  | { name: "EndTurn" }
  | { name: "StartWork" }
  | { name: "EndWork" }
  | { name: "Sleep" };

const clone = (s: FoldersState): FoldersState => structuredClone(s);

export class FoldersReference {
  constructor(readonly config: FoldersConfig) {}

  get places(): Place[] { return [...this.config.folders, P]; }

  init(): FoldersState {
    return {
      pstate: "loading", crashes: 0, truth: P, everSet: [], uses: 0, chan: [], cache: P, disk: P, told: P, boots: 0, enables: 0,
      awake: false, headFolder: null, turn: false, turnFolder: null, work: false, pending: false, held: false, restarted: false, moves: 0,
    };
  }

  /** What the core answers (Res): a plugin off or failed decides nothing. */
  res(cache: Place, pstate: PState): Place {
    return pstate !== "disabled" && (pstate !== "failed" || this.config.bug === "noinvalidate") ? cache : P;
  }

  resolved(s: FoldersState): Place { return this.res(s.cache, s.pstate); }

  /** Tell(r) on `n` (whose `awake` is the step's): the session hears of a change, an awake bot owes a restart. */
  private tell(n: FoldersState, r: Place) {
    if (r === n.told) return;
    n.told = r; n.pending = n.awake; n.moves++;
  }

  /** Begin on `n`, from the state before the step (`s`). */
  private begin(s: FoldersState, n: FoldersState) {
    n.turn = true; n.held = false;
    const r = this.resolved(s);
    if (!s.awake) { n.awake = true; n.headFolder = r; n.turnFolder = r; n.pending = false; n.restarted = false; }
    else if (s.pending && !s.work) { n.headFolder = r; n.turnFolder = r; n.pending = false; n.restarted = true; }
    else { n.turnFolder = s.headFolder; n.restarted = false; }
  }

  step(s: FoldersState, a: FoldersAction): FoldersState | null {
    const n = clone(s);
    n.restarted = false;
    switch (a.name) {
      case "Use":
        if (s.pstate !== "running" || a.f === s.truth || s.uses >= this.config.maxUses || !this.places.includes(a.f)) return null;
        n.truth = a.f; if (!n.everSet.includes(a.f)) n.everSet.push(a.f); n.uses++;
        n.chan.push({ m: "set", f: a.f });
        return n;
      case "Load":
        if (s.pstate !== "loading") return null;
        n.pstate = "running"; n.chan.push({ m: "sync", f: s.truth });
        return n;
      case "Crash":
        if (s.pstate !== "loading" && s.pstate !== "running") return null;
        if (a.keep < 0 || a.keep > s.chan.length) return null;
        n.pstate = s.crashes + 1 >= 3 ? "failed" : "crashed";
        n.crashes = s.crashes + 1 >= 3 ? 0 : s.crashes + 1;
        n.chan = s.chan.slice(0, a.keep);
        this.tell(n, this.res(s.cache, n.pstate));
        return n;
      case "HostRestart":
        if (s.pstate !== "crashed") return null;
        n.pstate = "loading";
        return n;
      case "Disable":
        if (s.pstate === "disabled") return null;
        n.pstate = "disabled";
        this.tell(n, this.res(s.cache, n.pstate));
        return n;
      case "Enable":
        if ((s.pstate !== "disabled" && s.pstate !== "failed") || s.enables >= this.config.maxEnables) return null;
        n.pstate = "loading"; n.enables++;
        n.crashes = s.pstate === "failed" ? 0 : s.crashes;
        this.tell(n, this.res(s.cache, n.pstate));
        return n;
      case "CoreRecv": {
        const m = s.chan[0];
        if (!m) return null;
        const c = s.pstate === "disabled" || s.pstate === "failed" ? s.cache : m.f;
        // An unchanged answer writes nothing: a failed write is the same step as a good one.
        if (c === s.cache && !a.saved) return null;
        n.cache = c;
        if (c !== s.cache && a.saved) n.disk = c;
        this.tell(n, this.res(c, s.pstate));
        if (!a.dup) n.chan.shift();
        return n;
      }
      case "AppRestart":
        if (s.boots >= this.config.maxBoots) return null;
        n.boots++;
        n.pstate = s.pstate === "disabled" || s.pstate === "failed" ? s.pstate : "loading";
        n.crashes = 0; n.chan = []; n.cache = s.disk; n.told = this.res(s.disk, n.pstate);
        n.awake = false; n.headFolder = null; n.turn = false; n.turnFolder = null; n.work = false; n.pending = false; n.held = false;
        return n;
      case "Msg":
        if (s.turn || s.held) return null;
        if (s.awake && s.pending && s.work && this.config.bug !== "nohold") { n.held = true; return n; }
        this.begin(s, n);
        return n;
      case "Release":
        if (!s.held || s.work) return null;
        this.begin(s, n);
        return n;
      case "EndTurn":
        if (!s.turn) return null;
        n.turn = false; n.turnFolder = null;
        return n;
      case "StartWork":
        if (!s.turn || s.work) return null;
        n.work = true;
        return n;
      case "EndWork":
        if (!s.work) return null;
        n.work = false;
        return n;
      case "Sleep":
        if (!s.awake || s.turn || s.work || s.held) return null;
        n.awake = false; n.headFolder = null; n.pending = false;
        return n;
    }
  }

  enabled(s: FoldersState): FoldersAction[] {
    const candidates: FoldersAction[] = [
      ...this.places.map((f) => ({ name: "Use", f }) as FoldersAction),
      { name: "Load" }, ...Array.from({ length: s.chan.length + 1 }, (_, keep) => ({ name: "Crash", keep }) as FoldersAction),
      { name: "HostRestart" }, { name: "Disable" }, { name: "Enable" },
      ...[false, true].flatMap((dup) => [true, false].map((saved) => ({ name: "CoreRecv", dup, saved }) as FoldersAction)),
      { name: "AppRestart" }, { name: "Msg" }, { name: "Release" }, { name: "EndTurn" }, { name: "StartWork" }, { name: "EndWork" }, { name: "Sleep" },
    ];
    return candidates.filter((a) => this.step(s, a) !== null);
  }

  /** The model's invariants that fail in `s` (none: all hold). */
  invariants(s: FoldersState): string[] {
    const out: string[] = [];
    const fromPlugin = (f: Place) => f === P || s.everSet.includes(f);
    if (!fromPlugin(s.cache)) out.push("CacheFromPlugin");
    if (!fromPlugin(s.disk)) out.push("DiskFromPlugin");
    if (s.told !== this.resolved(s)) out.push("ToldIsAnswer");
    if (s.pending && !s.awake) out.push("PendingOnlyAwake");
    if (s.held && !(s.awake && s.pending && !s.turn)) out.push("HeldOnlyForRestart");
    if (!s.awake && (s.headFolder !== null || s.turn || s.work || s.pending || s.held)) out.push("AsleepIsQuiet");
    if (s.restarted && !s.turn) out.push("RestartBeforeTurn");
    return out;
  }

  /** The model's action properties that the step s -> n breaks (none: all hold). */
  stepProperties(s: FoldersState, n: FoldersState): string[] {
    const out: string[] = [];
    const began = !s.turn && n.turn;
    if (began && n.turnFolder !== this.resolved(n)) out.push("TurnStartsCurrent");
    if (began && n.turnFolder !== P && (n.pstate === "disabled" || n.pstate === "failed")) out.push("TurnNotDisabled");
    if (began && n.turnFolder !== P && !n.everSet.includes(n.turnFolder!)) out.push("TurnFromPlugin");
    if (n.restarted && !(s.pending && !n.pending)) out.push("RestartOnlyOwed");
    if (!s.pending && n.pending && n.told === s.told) out.push("OwedOnlyOnMove");
    return out;
  }
}

/** What the app's core shows of a state (what the conformance test compares; the bot's side is bot.ts's, tested apart). */
export interface FoldersView {
  pstate: PState;
  chan: FolderMsg[];
  cache: Place;
  disk: Place;
  /** What sessionFolder answers. */
  resolved: Place;
  moves: number;
}

export function viewOf(ref: FoldersReference, s: FoldersState): FoldersView {
  return { pstate: s.pstate, chan: s.chan, cache: s.cache, disk: s.disk, resolved: ref.resolved(s), moves: s.moves };
}
