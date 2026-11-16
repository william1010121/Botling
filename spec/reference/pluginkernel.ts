// The plugin kernel model (spec/models/pluginkernel/PluginKernel.tla) as a pure TypeScript state machine: the same
// variables, the same actions with the same names, the same fixed topology (p1 provides s1 and owns slot k1; p2
// provides s2, owns k2 and contributes to k1; p3 requires s1 and s2 and contributes to k1 and k2). `Config.bug`
// turns on the model's bugs. spec/tests/pluginkernel.spec.test.ts explores it like TLC and replays the real kernel's
// event log (Web/src/plugin-kernel/) through it.

export type Plugin = "p1" | "p2" | "p3";
export type Service = "s1" | "s2";
export type Slot = "k1" | "k2";
export type PState = "absent" | "loading" | "active" | "unloading";
export type Want = "none" | "load" | "unload";
/** A registration: a service it provides, a contribution to a slot (`slot`), or a listener (t = "none"). */
export interface Reg { kind: "service" | "slot" | "listener"; t: string }
export type Bug =
  | "none" | "noundo" | "lateasync" | "providerfirst" | "acceptunloading" | "failstops" | "cycle"
  | "contribnoowner" | "unloadingdep" | "loadintounloading" | "ownerloading";

export interface Config { maxSwap: number; maxFail: number; maxRegs: number; bug?: Bug }

export interface State {
  state: Record<Plugin, PState>;
  regs: Record<Plugin, Reg[]>;
  pending: Record<Plugin, number>;
  undoing: Record<Plugin, Reg[]>;
  want: Record<Plugin, Want>;
  again: Record<Plugin, boolean>;
  nFail: number;
  nSwap: number;
}

export type Action =
  | { type: "RequestLoad" | "RequestUnload" | "Swap" | "StartLoad" | "Activate" | "RegisterAsyncStart" | "BeginUnload" | "FinishUnload"; p: Plugin }
  | { type: "Register" | "RegisterAsyncSettle"; p: Plugin; r: Reg }
  | { type: "CascadeUnload"; p: Plugin; q: Plugin }
  | { type: "RunUndo"; p: Plugin; fail: boolean };

export const PLUGINS: readonly Plugin[] = ["p1", "p2", "p3"];
export const SLOTS: readonly Slot[] = ["k1", "k2"];

// MARK: Topology (the model's constants)

export const PROVIDES: Record<Plugin, Service[]> = { p1: ["s1"], p2: ["s2"], p3: [] };
export const requires = (bug: Bug = "none"): Record<Plugin, Service[]> =>
  ({ p1: bug === "cycle" ? ["s2"] : [], p2: bug === "cycle" ? ["s1"] : [], p3: ["s1", "s2"] });
export const SLOT_OWNER: Record<Slot, Plugin> = { k1: "p1", k2: "p2" };
export const CONTRIBUTES: Record<Plugin, Slot[]> = { p1: [], p2: ["k1"], p3: ["k1", "k2"] };
/** The slots each plugin owns (SlotOwner turned around). */
export const OWNS: Record<Plugin, Slot[]> = { p1: ["k1"], p2: ["k2"], p3: [] };

const LIVE: readonly PState[] = ["loading", "active"];
const isLive = (st: PState) => LIVE.includes(st);
const uniq = <T>(xs: T[]) => [...new Set(xs)];

export function providers(p: Plugin, bug: Bug = "none"): Plugin[] {
  const req = requires(bug)[p];
  return PLUGINS.filter((q) => PROVIDES[q].some((s) => req.includes(s)));
}
export function owners(p: Plugin): Plugin[] {
  return uniq(CONTRIBUTES[p].map((k) => SLOT_OWNER[k])).filter((q) => q !== p);
}
export function deps(p: Plugin, bug: Bug = "none"): Plugin[] {
  return uniq([...providers(p, bug), ...owners(p)]);
}
/** Deps(p) and theirs (two levels, as the model). */
export function allDeps(p: Plugin, bug: Bug = "none"): Plugin[] {
  const d = deps(p, bug);
  return uniq([...d, ...d.flatMap((q) => deps(q, bug))]);
}
export function dependents(p: Plugin, bug: Bug = "none"): Plugin[] {
  const req = requires(bug);
  return PLUGINS.filter((q) => req[q].some((s) => PROVIDES[p].includes(s)) || CONTRIBUTES[q].some((k) => SLOT_OWNER[k] === p));
}
/** What p may register. */
export function regsOf(p: Plugin): Reg[] {
  return [
    ...PROVIDES[p].map((t): Reg => ({ kind: "service", t })),
    ...CONTRIBUTES[p].map((t): Reg => ({ kind: "slot", t })),
    { kind: "listener", t: "none" },
  ];
}
export const sameReg = (a: Reg, b: Reg) => a.kind === b.kind && a.t === b.t;
export const regLabel = (r: Reg) => `${r.kind}:${r.t}`;

// MARK: The machine

const per = <T>(value: (p: Plugin) => T) => Object.fromEntries(PLUGINS.map((p) => [p, value(p)])) as Record<Plugin, T>;

export function init(_cfg: Config): State {
  return {
    state: per(() => "absent"), regs: per(() => []), pending: per(() => 0), undoing: per(() => []),
    want: per(() => "none"), again: per(() => false), nFail: 0, nSwap: 0,
  };
}

/** p takes registrations: loading or active and not asked to unload (K4). */
export const open = (s: State, p: Plugin) => isLive(s.state[p]) && s.want[p] !== "unload";

function canReg(s: State, cfg: Config, p: Plugin, r: Reg): boolean {
  return regsOf(p).some((x) => sameReg(x, r)) && (r.kind !== "slot" || s.state[SLOT_OWNER[r.t as Slot]] !== "absent" || cfg.bug === "contribnoowner");
}
function depBusy(s: State, cfg: Config, p: Plugin): Plugin[] {
  return dependents(p, cfg.bug).filter((q) => q !== p && (isLive(s.state[q]) || (s.state[q] === "unloading" && cfg.bug !== "unloadingdep")));
}
const k5Off = (cfg: Config) => cfg.bug === "ownerloading" || cfg.bug === "contribnoowner";

export function enabled(s: State, cfg: Config, a: Action): boolean {
  const bug = cfg.bug ?? "none";
  const { p } = a;
  switch (a.type) {
    case "RequestLoad": return s.state[p] === "absent" && s.want[p] === "none";
    case "RequestUnload": return isLive(s.state[p]) && s.want[p] === "none";
    case "Swap": return s.state[p] === "active" && s.want[p] === "none" && s.nSwap < cfg.maxSwap;
    case "StartLoad":
      return s.want[p] === "load" && s.state[p] === "absent"
        && providers(p, bug).every((q) => isLive(s.state[q]) && s.want[q] !== "unload")
        && (bug === "loadintounloading" || owners(p).every((q) => (s.state[q] === "active" || k5Off(cfg)) && s.state[q] !== "unloading" && s.want[q] !== "unload"));
    case "Activate":
      return s.state[p] === "loading" && (k5Off(cfg) ? providers(p, bug) : deps(p, bug)).every((q) => s.state[q] === "active");
    case "Register":
      return (open(s, p) || (bug === "acceptunloading" && s.state[p] === "unloading"))
        && s.regs[p].length + s.pending[p] < cfg.maxRegs && canReg(s, cfg, p, a.r);
    case "RegisterAsyncStart": return open(s, p) && s.regs[p].length + s.pending[p] < cfg.maxRegs;
    case "RegisterAsyncSettle": return s.pending[p] > 0 && regsOf(p).some((x) => sameReg(x, a.r));
    case "CascadeUnload":
      return s.want[p] === "unload" && dependents(p, bug).includes(a.q) && a.q !== p && isLive(s.state[a.q]) && s.want[a.q] !== "unload";
    case "BeginUnload": return s.want[p] === "unload" && isLive(s.state[p]) && (bug === "providerfirst" || depBusy(s, cfg, p).length === 0);
    case "RunUndo": return s.state[p] === "unloading" && s.undoing[p].length > 0 && (!a.fail || s.nFail < cfg.maxFail);
    case "FinishUnload": return s.state[p] === "unloading" && (s.undoing[p].length === 0 || bug === "noundo") && s.pending[p] === 0;
  }
}

const set = <K extends keyof State>(s: State, key: K, p: Plugin, value: State[K] extends Record<Plugin, infer V> ? V : never): State =>
  ({ ...s, [key]: { ...(s[key] as object), [p]: value } });

export function step(s: State, cfg: Config, a: Action): State {
  if (!enabled(s, cfg, a)) throw new Error(`${describe(a)} is not enabled`);
  const bug = cfg.bug ?? "none";
  const { p } = a;
  switch (a.type) {
    case "RequestLoad": {
      const need = [p, ...allDeps(p, bug)];
      return { ...s, want: per((q) => (need.includes(q) && s.state[q] === "absent" && s.want[q] === "none" ? "load" : s.want[q])) };
    }
    case "RequestUnload": return set(s, "want", p, "unload");
    case "Swap": return { ...set(set(s, "want", p, "unload"), "again", p, true), nSwap: s.nSwap + 1 };
    case "StartLoad": return set(s, "state", p, "loading");
    case "Activate": return set(set(s, "state", p, "active"), "want", p, s.want[p] === "load" ? "none" : s.want[p]);
    case "Register": return set(s, "regs", p, [...s.regs[p], a.r]);
    case "RegisterAsyncStart": return set(s, "pending", p, s.pending[p] + 1);
    case "RegisterAsyncSettle": {
      const keep = (open(s, p) && canReg(s, cfg, p, a.r)) || bug === "lateasync";
      return set(keep ? set(s, "regs", p, [...s.regs[p], a.r]) : s, "pending", p, s.pending[p] - 1);
    }
    case "CascadeUnload": return set(set(s, "want", a.q, "unload"), "again", a.q, true);
    case "BeginUnload": return set(set(s, "state", p, "unloading"), "undoing", p, s.regs[p]);
    case "RunUndo": {
      const stop = a.fail && bug === "failstops";
      const n = { ...s, nFail: a.fail ? s.nFail + 1 : s.nFail };
      return set(set(n, "undoing", p, stop ? [] : s.undoing[p].slice(0, -1)), "regs", p, stop ? s.regs[p] : s.regs[p].slice(0, -1));
    }
    case "FinishUnload": {
      let n = set(set(s, "state", p, "absent"), "undoing", p, []);
      if (bug !== "failstops" && bug !== "noundo") n = set(n, "regs", p, []);
      return set(set(n, "want", p, s.again[p] ? "load" : "none"), "again", p, false);
    }
  }
}

export function describe(a: Action): string {
  switch (a.type) {
    case "Register": case "RegisterAsyncSettle": return `${a.type}(${a.p}, ${regLabel(a.r)})`;
    case "CascadeUnload": return `CascadeUnload(${a.p}, ${a.q})`;
    case "RunUndo": return `RunUndo(${a.p}, ${a.fail})`;
    default: return `${a.type}(${a.p})`;
  }
}

/** Every action enabled in `s` (the model's Next). */
export function actions(s: State, cfg: Config): Action[] {
  const all: Action[] = [];
  for (const p of PLUGINS) {
    for (const type of ["RequestLoad", "RequestUnload", "Swap", "StartLoad", "Activate", "RegisterAsyncStart", "BeginUnload", "FinishUnload"] as const) all.push({ type, p });
    for (const r of regsOf(p)) all.push({ type: "Register", p, r }, { type: "RegisterAsyncSettle", p, r });
    for (const q of PLUGINS) all.push({ type: "CascadeUnload", p, q });
    all.push({ type: "RunUndo", p, fail: false }, { type: "RunUndo", p, fail: true });
  }
  return all.filter((a) => enabled(s, cfg, a));
}

// MARK: Properties

/** The model's invariants that fail in `s` (empty: none). */
export function violations(s: State, cfg: Config): string[] {
  const bug = cfg.bug ?? "none";
  const out: string[] = [];
  const typeOk = PLUGINS.every((p) => s.regs[p].length <= cfg.maxRegs + 1 && s.pending[p] >= 0 && s.pending[p] <= cfg.maxRegs)
    && s.nFail >= 0 && s.nFail <= cfg.maxFail && s.nSwap >= 0 && s.nSwap <= cfg.maxSwap;
  if (!typeOk) out.push("TypeOK");
  if (!PLUGINS.every((p) => s.state[p] !== "absent" || (s.regs[p].length === 0 && s.pending[p] === 0))) out.push("NoResidue");
  if (!PLUGINS.every((p) => s.regs[p].every((r) => r.kind !== "slot" || (s.state[p] !== "absent" && s.state[SLOT_OWNER[r.t as Slot]] !== "absent")))) out.push("NoOrphan");
  if (!PLUGINS.every((p) => s.state[p] !== "active" || providers(p, bug).every((q) => s.state[q] === "active"))) out.push("DependencyGuard");
  if (!PLUGINS.every((p) => s.state[p] !== "active" || owners(p).every((q) => s.state[q] === "active"))) out.push("OwnerActive");
  const teardown = PLUGINS.every((p) => s.state[p] !== "unloading" || bug === "failstops" || (
    dependents(p, bug).filter((q) => q !== p).every((q) => !isLive(s.state[q]))
    && s.undoing[p].every((r, i) => s.regs[p][i] !== undefined && sameReg(r, s.regs[p][i]!))));
  if (!teardown) out.push("TeardownOrder");
  return out;
}

/** The model's action property ClosedUnload, for one step from `s` to `n`: nothing registers while unloading or absent. */
export function stepViolations(s: State, n: State): string[] {
  return PLUGINS.every((p) => !(s.state[p] === "unloading" || s.state[p] === "absent") || n.regs[p].length <= s.regs[p].length) ? [] : ["ClosedUnload"];
}

// MARK: What can be seen from outside

/**
 * The kernel's view: each plugin's state as the kernel shows it (an instance asked to unload is "unloading" at once, K4),
 * whether it is wanted and not up yet, its registrations in order, its pending async registrations, and what each slot
 * shows (the contributions of active contributors while the slot's owner is active and not asked to unload, P2).
 */
export interface View {
  state: Record<Plugin, PState>;
  waiting: Record<Plugin, boolean>;
  regs: Record<Plugin, string[]>;
  pending: Record<Plugin, number>;
  shown: Record<Slot, Plugin[]>;
}

export function view(s: State): View {
  const kernelState = (p: Plugin): PState => (isLive(s.state[p]) && s.want[p] === "unload" ? "unloading" : s.state[p]);
  const up = (p: Plugin) => kernelState(p) === "active";
  return {
    state: per(kernelState),
    waiting: per((p) => s.want[p] === "load"),
    regs: per((p) => s.regs[p].map(regLabel)),
    pending: per((p) => s.pending[p]),
    shown: Object.fromEntries(SLOTS.map((k) => [k, up(SLOT_OWNER[k])
      ? PLUGINS.filter(up).flatMap((p) => s.regs[p].filter((r) => r.kind === "slot" && r.t === k).map(() => p)).sort()
      : []])) as Record<Slot, Plugin[]>,
  };
}
