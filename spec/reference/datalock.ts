// spec/models/datalock/DataLock.tla as a TypeScript state machine: the same variables and actions under
// the same names. Pure: no app imports, no I/O. `next` lists every successor, as TLC would.
import type { DataLockObservation } from "../driver/datalock-driver";

export type DataLockPc = "idle" | "try" | "look" | "break" | "verify" | "wait" | "ident" | "writing" | "exit" | "dead";
export type DataLockAction = "Start" | "Try" | "Look" | "Break" | "Verify" | "Ident" | "Retry" | "GiveUp" | "Check" | "Quit"
  | "Leave" | "Crash" | "Reuse" | "Swap";
export type DataLockBug = "none" | "naive" | "restore";

export interface DataLockConsts {
  cores: readonly string[];
  maxSwap: number;
  /** "naive": check, then write the lock over whatever is there; "restore": 7be956c7's move-aside-and-put-back. */
  bug: DataLockBug;
}

type By<T> = Readonly<Record<string, T>>;
/** null is the model's None. */
export interface DataLockState {
  pc: By<DataLockPc>;
  lock: readonly (string | null)[];
  gen: number;
  home: By<number | null>;
  mine: By<number | null>;
  again: By<boolean>;
  judged: By<string | null>;
  aside: By<string | null>;
  reused: By<boolean>;
}

export interface DataLockStep {
  action: DataLockAction;
  core?: string;
  /** Swap: the new folder is a copy carrying the lock (else a fresh one). */
  copy?: boolean;
  state: DataLockState;
}

const each = <T>(keys: readonly string[], value: (key: string) => T): By<T> => Object.fromEntries(keys.map((k) => [k, value(k)]));
const put = <T>(record: By<T>, key: string, value: T): By<T> => ({ ...record, [key]: value });
const set = (lock: readonly (string | null)[], f: number, holder: string | null) => lock.map((h, i) => (i === f ? holder : h));

export function init(c: DataLockConsts): DataLockState {
  return {
    pc: each(c.cores, () => "idle"),
    lock: Array.from({ length: c.maxSwap + 1 }, () => null), gen: 0,
    home: each(c.cores, () => null), mine: each(c.cores, () => null),
    again: each(c.cores, () => false), judged: each(c.cores, () => null), aside: each(c.cores, () => null),
    reused: each(c.cores, () => false),
  };
}

const pidAlive = (s: DataLockState, h: string) => s.pc[h] !== "dead" || s.reused[h];
const startedAfter = (s: DataLockState, h: string) => s.reused[h];
export const stale = (s: DataLockState, h: string) => !pidAlive(s, h) || startedAfter(s, h);

/** A process that is gone: what it knew goes with it. */
const gone = (s: DataLockState, c: string): Partial<DataLockState> => ({
  pc: put(s.pc, c, "dead"), home: put(s.home, c, null), mine: put(s.mine, c, null),
  again: put(s.again, c, false), judged: put(s.judged, c, null), aside: put(s.aside, c, null),
});

export function next(k: DataLockConsts, s: DataLockState): DataLockStep[] {
  const out: DataLockStep[] = [];
  const go = (action: DataLockAction, core: string | undefined, change: Partial<DataLockState>, extra: Partial<DataLockStep> = {}) =>
    out.push({ action, ...(core === undefined ? {} : { core }), ...extra, state: { ...s, ...change } });
  const at = s.lock[s.gen]!;
  for (const c of k.cores) {
    const pc = (p: DataLockPc) => put(s.pc, c, p);
    switch (s.pc[c]) {
      case "idle": go("Start", c, { pc: pc("try") }); break;
      case "try":
        go("Try", c, at === null ? { lock: set(s.lock, s.gen, c), home: put(s.home, c, s.gen), pc: pc("ident") } : { pc: pc("look") });
        break;
      case "look":
        if (at === c) go("Look", c, { pc: pc("writing"), again: put(s.again, c, false), mine: put(s.mine, c, s.mine[c] ?? s.gen) });
        else if (at !== null && !stale(s, at)) go("Look", c, { pc: pc(s.again[c] ? "exit" : "wait") });
        else go("Look", c, { pc: pc("break"), judged: put(s.judged, c, at) });
        break;
      case "break":
        if (k.bug === "naive") go("Break", c, { lock: set(s.lock, s.gen, c), home: put(s.home, c, s.gen), pc: pc("ident"), judged: put(s.judged, c, null) });
        else if (k.bug === "restore") {
          go("Break", c, at === null ? { pc: pc("try"), judged: put(s.judged, c, null) }
            : { aside: put(s.aside, c, at), lock: set(s.lock, s.gen, null), pc: pc("verify") });
        } else {
          go("Break", c, { lock: s.judged[c] !== null && at === s.judged[c] ? set(s.lock, s.gen, null) : s.lock, pc: pc("try"), judged: put(s.judged, c, null) });
        }
        break;
      case "verify":
        go("Verify", c, {
          lock: s.aside[c] !== s.judged[c] && at === null ? set(s.lock, s.gen, s.aside[c]) : s.lock,
          aside: put(s.aside, c, null), judged: put(s.judged, c, null), pc: pc("try"),
        });
        break;
      case "ident": go("Ident", c, { mine: put(s.mine, c, s.gen), again: put(s.again, c, false), pc: pc("writing") }); break;
      case "wait": go("Retry", c, { pc: pc("try") }); go("GiveUp", c, { pc: pc("exit") }); break;
      case "writing":
        if (s.mine[c] !== s.gen || (at !== c && at !== null)) go("Check", c, { pc: pc("exit") });
        else if (at === null) go("Check", c, { pc: pc("try"), again: put(s.again, c, true) });
        else go("Check", c, {});
        go("Quit", c, { pc: pc("exit") });
        break;
      case "exit": go("Leave", c, { ...gone(s, c), lock: at === c ? set(s.lock, s.gen, null) : s.lock }); break;
      case "dead": if (!s.reused[c]) go("Reuse", c, { reused: put(s.reused, c, true) }); break;
    }
    if (s.pc[c] !== "idle" && s.pc[c] !== "dead") go("Crash", c, gone(s, c));
  }
  if (s.gen < k.maxSwap) {
    const copies = at === null ? [false] : [true, false];
    for (const copy of copies) go("Swap", undefined, { gen: s.gen + 1, lock: set(s.lock, s.gen + 1, copy ? at : null) }, { copy });
  }
  return out;
}

/** The invariants of the model that `s` breaks (none: an empty list). */
export function violated(k: DataLockConsts, s: DataLockState): string[] {
  const writing = k.cores.filter((c) => s.pc[c] === "writing");
  const checks: Record<string, () => boolean> = {
    OneWriter: () => writing.every((c) => writing.every((d) => c === d || s.home[c] !== s.gen || s.home[d] !== s.gen)),
    HoldsLock: () => writing.every((c) => s.home[c] !== s.gen || s.lock[s.gen] === c),
  };
  return Object.keys(checks).filter((name) => !checks[name]!());
}

/** What the driver can see of `s`: the folder at the path, and whose record each folder's lock holds. */
export function observe(s: DataLockState): DataLockObservation {
  return { gen: s.gen, lock: [...s.lock] };
}
