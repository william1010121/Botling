// A Claude worker on another machine, reached over ssh or the relay (spec/models/remoteworker/RemoteWorker.tla) as a
// pure TypeScript state machine: the same variables, the same actions under the same names, the same invariants.
// No app imports. The app does not have this yet (multi-machine phase 1): spec/driver/remote-worker-driver.ts is the
// door its adapter will implement; until then spec/tests/remote-worker.spec.test.ts checks this machine against TLC
// (the same reachable states for RemoteWorker.cfg) and against the model's bugs.
// SPEC_BUG=remote-nolock, remote-stale, remote-nogen or remote-revoke turns on the bug of that name.

export type Bug = "none" | "nolock" | "stale" | "nogen" | "revoke";
export type Path = "ssh" | "relay";
export type Trust = "none" | "asked" | "trusted" | "revoked";
export type Conn = "down" | "hello" | "upgrade" | "attach" | "up";
export type WorkerState = "none" | "running" | "interrupted" | "cancelling" | "done" | "cancelled";
export type CardState = "none" | "open" | "sent" | "settled" | "closed";
export type ReqState = "none" | "pending" | "applied";
export type EvType = "out" | "ask" | "ans" | "done" | "cancelled";
export interface Ev { t: EvType; k: number }
/** app -> agent */
export interface DownMsg { t: "hello" | "attach" | "start" | "answer" | "cancel"; n: number }
/** agent -> app */
export interface UpMsg { t: "hi" | "ev" | "attached" | "refused"; n: number }

export interface Config {
  paths: Path[]; maxConns: number; maxReqs: number; maxOut: number; maxTries: number; maxPairs: number; bug?: Bug;
}

/** The model's variables. Arrays indexed by request or connection are 0-based here (request k is [k - 1]). */
export interface State {
  via: "none" | Path; trust: Trust; epoch: number; pairs: number; appv: number;
  agv: number; aseen: number; agen: number; astream: boolean; alive: number[]; runs: number; log: Ev[];
  req: ReqState[]; reqBy: number[]; applied: number[]; oldRun: boolean;
  down: DownMsg[][]; up: UpMsg[][];
  gen: number; conn: Conn; cepoch: number; w: WorkerState; sweep: boolean; got: number; gap: boolean;
  card: CardState[]; live: boolean[]; noted: boolean[]; tries: number[];
}

export type Action =
  | { type: "Pair"; p: Path } | { type: "Approve" } | { type: "Decline" } | { type: "Expire" }
  | { type: "Revoke"; i: number } | { type: "AppUpdate" }
  | { type: "Connect" } | { type: "Upgrade" } | { type: "Start" } | { type: "Cancel" } | { type: "Notice" }
  | { type: "Answer"; k: number } | { type: "Drop"; i: number }
  | { type: "AppRecv"; g: number } | { type: "AgentRecv"; g: number }
  | { type: "Out"; r: number } | { type: "Ask"; r: number; k: number } | { type: "Finish"; r: number };

const BUGS: Record<string, Bug> = { "remote-nolock": "nolock", "remote-stale": "stale", "remote-nogen": "nogen", "remote-revoke": "revoke" };
export const bugFromEnv = (): Bug => {
  const bug = typeof process !== "undefined" ? process.env.SPEC_BUG : undefined;
  return (bug && BUGS[bug]) || "none";
};
const bugOf = (cfg: Config): Bug => cfg.bug ?? bugFromEnv();

const fill = <T>(n: number, v: T): T[] => Array.from({ length: n }, () => v);

export function init(cfg: Config): State {
  return {
    via: "none", trust: "none", epoch: 0, pairs: 0, appv: 1,
    agv: 0, aseen: 0, agen: 0, astream: false, alive: [], runs: 0, log: [],
    req: fill(cfg.maxReqs, "none" as ReqState), reqBy: fill(cfg.maxReqs, 0), applied: fill(cfg.maxReqs, 0), oldRun: false,
    down: fill(cfg.maxConns, []), up: fill(cfg.maxConns, []),
    gen: 0, conn: "down", cepoch: 0, w: "none", sweep: false, got: 0, gap: false,
    card: fill(cfg.maxReqs, "none" as CardState), live: fill(cfg.maxReqs, false), noted: fill(cfg.maxReqs, false),
    tries: fill(cfg.maxReqs, 0),
  };
}

const ended = (s: State) => s.log.some((e) => e.t === "done" || e.t === "cancelled");
const asking = (s: State, r: number) => s.req.some((q, i) => q === "pending" && s.reqBy[i] === r);
const outs = (s: State) => s.log.filter((e) => e.t === "out").length;
const set = <T>(xs: T[], i: number, v: T): T[] => xs.map((x, j) => (j === i ? v : x));
const sorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
/** The session lock: a claude the agent starts stops any other (Bug "nolock": not). */
const locked = (s: State, bug: Bug, fresh: number[]) => sorted(bug === "nolock" ? [...s.alive, ...fresh] : fresh);
const applies = (s: State, bug: Bug, g: number, k: number) =>
  (g === s.agen || bug === "stale") && s.req[k - 1] === "pending" && s.alive.includes(s.reqBy[k - 1]!);
const reads = (s: State, bug: Bug, g: number) =>
  (g === s.gen && s.conn !== "down") || (bug === "nogen" && s.up[g - 1]![0]?.t === "refused");
const close = (c: CardState[]): CardState[] => c.map((x) => (x === "open" || x === "sent" ? "closed" : x));
const unlive = (s: State) => s.live.map(() => false);
const sendDown = (s: State, g: number, m: DownMsg): DownMsg[][] => set(s.down, g - 1, [...s.down[g - 1]!, m]);
const sendUp = (up: UpMsg[][], g: number, m: UpMsg): UpMsg[][] => set(up, g - 1, [...up[g - 1]!, m]);
/** An event into the session's log, and onto the connection the agent is on once it asked for the stream. */
const logged = (s: State, e: Ev): Pick<State, "log" | "up"> => ({
  log: [...s.log, e], up: s.agen !== 0 && s.astream ? sendUp(s.up, s.agen, { t: "ev", n: s.log.length + 1 }) : s.up,
});

export function enabled(s: State, cfg: Config, a: Action): boolean {
  const bug = bugOf(cfg);
  switch (a.type) {
    case "Pair": return cfg.paths.includes(a.p) && (s.trust === "none" || s.trust === "revoked") && s.pairs < cfg.maxPairs;
    case "Approve": case "Decline": return s.trust === "asked";
    case "Expire": return s.trust === "asked" && s.via === "relay";
    case "Revoke": return s.trust === "trusted"
      && (s.conn !== "down" && bug !== "revoke" ? a.i >= 0 && a.i <= s.down[s.gen - 1]!.length : a.i === 0);
    case "AppUpdate": return s.appv === 1 && s.conn === "down";
    case "Connect": return s.trust === "trusted" && s.conn === "down" && s.gen < cfg.maxConns;
    case "Upgrade": return s.conn === "upgrade";
    case "Start": return s.conn === "up" && s.w === "none";
    case "Cancel": return s.w === "running" || s.w === "interrupted";
    case "Notice": return s.agen !== 0 && (s.conn === "down" || s.gen !== s.agen);
    case "Answer": return a.k >= 1 && a.k <= cfg.maxReqs && s.card[a.k - 1] === "open" && s.tries[a.k - 1]! < cfg.maxTries;
    case "Drop": return s.conn !== "down" && a.i >= 0 && a.i <= s.down[s.gen - 1]!.length;
    case "AppRecv": return a.g >= 1 && a.g <= cfg.maxConns && s.up[a.g - 1]!.length > 0 && reads(s, bug, a.g);
    case "AgentRecv": return a.g >= 1 && a.g <= cfg.maxConns && s.down[a.g - 1]!.length > 0;
    case "Out": return s.alive.includes(a.r) && outs(s) < cfg.maxOut;
    case "Ask": {
      const q = s.req[a.k - 1];
      return s.alive.includes(a.r) && (q === "none" || (q === "pending" && !s.alive.includes(s.reqBy[a.k - 1]!)));
    }
    case "Finish": return s.alive.includes(a.r) && !asking(s, a.r) && !ended(s);
  }
}

/** The app's connection ends; the first i frames on their way to the agent still arrive. */
function cut(s: State, i: number): State {
  return {
    ...s, conn: "down", down: set(s.down, s.gen - 1, s.down[s.gen - 1]!.slice(0, i)),
    w: s.w === "running" ? "interrupted" : s.w === "cancelling" ? "cancelled" : s.w,
    sweep: s.sweep || s.w === "cancelling", card: s.w === "cancelling" ? close(s.card) : s.card, live: unlive(s),
  };
}

/** The app shows event e (the next in sequence). */
function show(s: State, e: Ev): State {
  switch (e.t) {
    case "ask": return {
      ...s, card: set(s.card, e.k - 1, s.card[e.k - 1] === "none" ? "open" : s.card[e.k - 1]!), live: set(s.live, e.k - 1, true),
    };
    case "ans": return { ...s, card: set(s.card, e.k - 1, "settled"), live: set(s.live, e.k - 1, false) };
    case "done": return { ...s, w: s.w === "cancelled" ? s.w : "done", card: close(s.card), live: unlive(s) };
    case "cancelled": return { ...s, w: "cancelled", card: close(s.card), live: unlive(s) };
    case "out": return s;
  }
}

function appRecv(s0: State, g: number): State {
  const m = s0.up[g - 1]![0]!;
  const s = { ...s0, up: set(s0.up, g - 1, s0.up[g - 1]!.slice(1)) };
  if (m.t === "hi" && s.conn === "hello") {
    if (m.n !== s.appv) return { ...s, conn: "upgrade" };
    if (s.w === "interrupted" || s.sweep) return { ...s, conn: "attach", down: sendDown(s, g, { t: "attach", n: s.got }) };
    return { ...s, conn: "up" };
  }
  if (m.t === "ev" && m.n === s.got + 1) return show({ ...s, got: m.n }, s.log[m.n - 1]!);
  if (m.t === "ev") return { ...s, gap: s.gap || m.n > s.got + 1 };
  if (m.t === "attached" && s.conn === "attach") {
    const next: State = {
      ...s, conn: "up", sweep: false,
      card: s.card.map((c) => (c === "sent" ? "open" : c)), noted: s.noted.map((n, i) => n || s.card[i] === "sent"),
    };
    return s.w === "interrupted" ? { ...next, w: "running", down: sendDown(next, g, { t: "start", n: s.appv }) } : next;
  }
  if (m.t === "refused") {
    const k = m.n - 1;
    return { ...s, card: set(s.card, k, s.card[k] === "sent" ? "open" : s.card[k]!), noted: set(s.noted, k, s.noted[k]! || s.card[k] === "sent") };
  }
  return s;
}

function agentRecv(s0: State, bug: Bug, g: number): State {
  const m = s0.down[g - 1]![0]!;
  const s = { ...s0, down: set(s0.down, g - 1, s0.down[g - 1]!.slice(1)) };
  if (m.t === "hello" && g > s.aseen) return { ...s, aseen: g, agen: g, astream: false, up: sendUp(s.up, g, { t: "hi", n: s.agv }) };
  if (m.t === "attach" && g === s.agen) {
    const replay: UpMsg[] = s.log.slice(m.n).map((_, i) => ({ t: "ev", n: m.n + i + 1 }));
    return { ...s, alive: locked(s, bug, []), astream: true, up: set(s.up, g - 1, [...s.up[g - 1]!, ...replay, { t: "attached", n: 0 }]) };
  }
  if (m.t === "start" && g === s.agen) {
    return { ...s, runs: s.runs + 1, alive: locked(s, bug, [s.runs + 1]), astream: true, oldRun: s.oldRun || m.n !== s.agv };
  }
  if (m.t === "answer" && applies(s, bug, g, m.n)) {
    return { ...s, req: set(s.req, m.n - 1, "applied"), applied: set(s.applied, m.n - 1, s.applied[m.n - 1]! + 1), ...logged(s, { t: "ans", k: m.n }) };
  }
  if (m.t === "answer") return { ...s, up: sendUp(s.up, g, { t: "refused", n: m.n }) };
  if (m.t === "cancel" && g === s.agen) return { ...s, alive: [], ...(ended(s) ? {} : logged(s, { t: "cancelled", k: 0 })) };
  return s;
}

export function step(s: State, cfg: Config, a: Action): State {
  if (!enabled(s, cfg, a)) throw new Error(`${label(a)} is not enabled`);
  const bug = bugOf(cfg);
  switch (a.type) {
    case "Pair": return { ...s, via: a.p, trust: "asked" };
    case "Approve": return { ...s, trust: "trusted", epoch: s.epoch + 1, pairs: s.pairs + 1 };
    case "Decline": case "Expire": return { ...s, trust: "none" };
    case "Revoke": {
      const next = { ...s, trust: "revoked" as Trust, epoch: s.epoch + 1 };
      return s.conn !== "down" && bug !== "revoke" ? cut(next, a.i) : next;
    }
    case "AppUpdate": return { ...s, appv: 2 };
    case "Connect": return {
      ...s, gen: s.gen + 1, conn: "hello", cepoch: s.epoch, down: set(s.down, s.gen, [{ t: "hello", n: 0 }]),
    };
    case "Upgrade": return { ...s, agv: s.appv, conn: "down" };
    case "Start": return { ...s, w: "running", down: sendDown(s, s.gen, { t: "start", n: s.appv }) };
    case "Cancel": return s.w === "running"
      ? { ...s, w: "cancelling", down: sendDown(s, s.gen, { t: "cancel", n: 0 }) }
      : { ...s, w: "cancelled", sweep: true, card: close(s.card), live: unlive(s) };
    case "Notice": return { ...s, agen: 0, astream: false, alive: [] };
    case "Answer": {
      const k = a.k - 1;
      const next = { ...s, tries: set(s.tries, k, s.tries[k]! + 1) };
      if (s.conn === "up" && s.w === "running" && s.live[k]) {
        return { ...next, card: set(s.card, k, "sent"), noted: set(s.noted, k, false), down: sendDown(s, s.gen, { t: "answer", n: a.k }) };
      }
      return { ...next, noted: set(s.noted, k, true) };
    }
    case "Drop": return cut(s, a.i);
    case "AppRecv": return appRecv(s, a.g);
    case "AgentRecv": return agentRecv(s, bug, a.g);
    case "Out": return { ...s, ...logged(s, { t: "out", k: 0 }) };
    case "Ask": return {
      ...s, req: set(s.req, a.k - 1, "pending"), reqBy: set(s.reqBy, a.k - 1, a.r), ...logged(s, { t: "ask", k: a.k }),
    };
    case "Finish": return { ...s, alive: s.alive.filter((r) => r !== a.r), ...logged(s, { t: "done", k: 0 }) };
  }
}

export function actions(s: State, cfg: Config): Action[] {
  const all: Action[] = [
    { type: "Approve" }, { type: "Decline" }, { type: "Expire" }, { type: "AppUpdate" }, { type: "Connect" }, { type: "Upgrade" },
    { type: "Start" }, { type: "Cancel" }, { type: "Notice" },
  ];
  for (const p of cfg.paths) all.push({ type: "Pair", p });
  const width = s.gen >= 1 ? s.down[s.gen - 1]!.length : 0;
  for (let i = 0; i <= width; i++) all.push({ type: "Revoke", i }, { type: "Drop", i });
  for (let k = 1; k <= cfg.maxReqs; k++) all.push({ type: "Answer", k });
  for (let g = 1; g <= cfg.maxConns; g++) all.push({ type: "AppRecv", g }, { type: "AgentRecv", g });
  for (let r = 1; r <= cfg.maxConns; r++) {
    all.push({ type: "Out", r }, { type: "Finish", r });
    for (let k = 1; k <= cfg.maxReqs; k++) all.push({ type: "Ask", r, k });
  }
  return all.filter((a) => enabled(s, cfg, a));
}

export const label = (a: Action): string => {
  const args = Object.entries(a).filter(([key]) => key !== "type").map(([, v]) => String(v));
  return args.length ? `${a.type}(${args.join(",")})` : a.type;
};

/** The model's invariants that fail in `s` (empty: none). */
export function violations(s: State): string[] {
  const out: string[] = [];
  if (s.alive.length > 1) out.push("OneProc");
  if (s.applied.some((n) => n > 1)) out.push("AnsweredOnce");
  if (s.card.some((c, i) => c === "open" && s.req[i] === "applied")) out.push("OpenNotApplied");
  if (s.card.some((c, i) => c === "settled" && s.req[i] !== "applied")) out.push("SettledIsApplied");
  if (s.got > s.log.length || s.gap) out.push("InSequence");
  if (s.conn !== "down" && !(s.trust === "trusted" && s.cepoch === s.epoch)) out.push("RevokeEnds");
  if (s.oldRun) out.push("SameVersion");
  if ((s.w === "running" || s.w === "cancelling") && s.conn !== "up") out.push("RunningIsUp");
  return out;
}

/** ReopenSaysSo, the model's action property: a card whose answer did not apply opens again with a note. */
export function stepViolations(s: State, n: State): string[] {
  return s.card.some((c, i) => c === "sent" && n.card[i] === "open" && !n.noted[i]) ? ["ReopenSaysSo"] : [];
}

/** What the app shows, which its adapter must match: the machine's trust and path, the connection, the worker, the
 * chat's last event number, each card and whether it says its last answer did not apply. */
export interface View {
  via: State["via"]; trust: Trust; conn: Conn; w: WorkerState; got: number; card: CardState[]; noted: boolean[];
}
export const view = (s: State): View => ({
  via: s.via, trust: s.trust, conn: s.conn, w: s.w, got: s.got, card: [...s.card], noted: s.noted.map((n, i) => n && s.card[i] === "open"),
});
