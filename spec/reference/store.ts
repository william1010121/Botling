// spec/models/store/Store.tla as a TypeScript state machine: the same variables and actions under the same names.
// Pure: no app imports, no I/O. `next` lists every successor, as TLC would.

export type StoreAction = "Start" | "Commit" | "Flush" | "Ack" | "Close" | "Crash" | "PowerLoss" | "Push" | "Sub" | "Disconnect";
export type StoreBug = "none" | "noflush" | "norotate";

export interface StoreConsts {
  acks: readonly string[];
  events: readonly string[];
  maxFault: number;
  /** "noflush": acknowledge after COMMIT without the flush; "norotate": no boot check. */
  bug: StoreBug;
}

export interface StoreState {
  up: boolean;
  log: readonly string[];
  synced: number;
  owed: readonly string[];
  acked: readonly string[];
  logId: number;
  openMark: boolean;
  bootMark: number;
  boot: number;
  rOn: boolean;
  rLog: readonly string[];
  rId: number;
  faults: number;
}

export interface StoreStep {
  action: StoreAction;
  /** Commit, Ack: the command. */
  cmd?: string;
  /** PowerLoss: how many commits stay. */
  keep?: number;
  state: StoreState;
}

const isPrefix = (a: readonly string[], b: readonly string[]) => a.length <= b.length && a.every((x, i) => b[i] === x);
const add = (set: readonly string[], x: string) => (set.includes(x) ? set : [...set, x].sort());
const drop = (set: readonly string[], x: string) => set.filter((y) => y !== x);

export function init(_c: StoreConsts): StoreState {
  return {
    up: false, log: [], synced: 0, owed: [], acked: [], logId: 0, openMark: false, bootMark: 0, boot: 0,
    rOn: false, rLog: [], rId: 0, faults: 0,
  };
}

export function Start(c: StoreConsts, s: StoreState): StoreState | null {
  if (s.up) return null;
  const rotate = s.openMark && s.bootMark !== s.boot && c.bug !== "norotate";
  return { ...s, up: true, logId: rotate ? s.logId + 1 : s.logId, openMark: true, bootMark: s.boot, synced: s.log.length };
}

export function Commit(c: StoreConsts, s: StoreState, cmd: string): StoreState | null {
  if (!s.up || s.log.includes(cmd)) return null;
  return { ...s, log: [...s.log, cmd], owed: c.acks.includes(cmd) ? add(s.owed, cmd) : s.owed };
}

export function Flush(_c: StoreConsts, s: StoreState): StoreState | null {
  if (!s.up || s.synced >= s.log.length) return null;
  return { ...s, synced: s.log.length };
}

export function Ack(c: StoreConsts, s: StoreState, cmd: string): StoreState | null {
  if (!s.up || !s.owed.includes(cmd)) return null;
  if (c.bug !== "noflush" && s.log.indexOf(cmd) + 1 > s.synced) return null;
  return { ...s, acked: add(s.acked, cmd), owed: drop(s.owed, cmd) };
}

export function Close(_c: StoreConsts, s: StoreState): StoreState | null {
  if (!s.up || s.owed.length) return null;
  return { ...s, up: false, rOn: false, openMark: false, synced: s.log.length };
}

export function Crash(c: StoreConsts, s: StoreState): StoreState | null {
  if (!s.up || s.faults >= c.maxFault) return null;
  return { ...s, up: false, rOn: false, owed: [], faults: s.faults + 1 };
}

export function PowerLoss(c: StoreConsts, s: StoreState, keep: number): StoreState | null {
  if (s.faults >= c.maxFault || keep < s.synced || keep > s.log.length) return null;
  return { ...s, log: s.log.slice(0, keep), synced: keep, up: false, rOn: false, owed: [], boot: s.boot + 1, faults: s.faults + 1 };
}

export function Push(_c: StoreConsts, s: StoreState): StoreState | null {
  if (!s.up || !s.rOn || s.rId !== s.logId || s.rLog.length >= s.log.length) return null;
  return { ...s, rLog: [...s.rLog, s.log[s.rLog.length]!] };
}

export function Sub(_c: StoreConsts, s: StoreState): StoreState | null {
  if (!s.up || s.rOn) return null;
  if (s.rId === s.logId && s.rLog.length > s.log.length) {
    return { ...s, rOn: true, logId: s.logId + 1, rId: s.logId + 1, rLog: s.log, synced: s.log.length };
  }
  if (s.rId !== s.logId) return { ...s, rOn: true, rId: s.logId, rLog: s.log };
  return { ...s, rOn: true };
}

export function Disconnect(_c: StoreConsts, s: StoreState): StoreState | null {
  return s.rOn ? { ...s, rOn: false } : null;
}

export function next(c: StoreConsts, s: StoreState): StoreStep[] {
  const out: StoreStep[] = [];
  const push = (action: StoreAction, state: StoreState | null, extra: Partial<StoreStep> = {}) => { if (state) out.push({ action, ...extra, state }); };
  push("Start", Start(c, s));
  push("Flush", Flush(c, s));
  push("Close", Close(c, s));
  push("Crash", Crash(c, s));
  for (let keep = s.synced; keep <= s.log.length; keep++) push("PowerLoss", PowerLoss(c, s, keep), { keep });
  push("Push", Push(c, s));
  push("Sub", Sub(c, s));
  push("Disconnect", Disconnect(c, s));
  for (const cmd of [...c.acks, ...c.events]) {
    push("Commit", Commit(c, s, cmd), { cmd });
    push("Ack", Ack(c, s, cmd), { cmd });
  }
  return out;
}

/** The model's invariants that `s` breaks (names as in Store.tla). */
export function violated(_c: StoreConsts, s: StoreState): string[] {
  const out: string[] = [];
  if (!s.acked.every((cmd) => s.log.includes(cmd))) out.push("AckedKept");
  if (s.rOn && s.rId === s.logId && !isPrefix(s.rLog, s.log)) out.push("NoFork");
  if (s.synced > s.log.length) out.push("SyncedInLog");
  return out;
}
