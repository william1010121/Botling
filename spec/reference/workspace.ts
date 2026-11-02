// The workspace change watch of spec/models/workspace/Workspace.tla, action for action.
// Pure: a step takes a state and returns the next one, or null when the action is not enabled.

export type ToCore = { m: "reg"; on: boolean } | { m: "read"; p: string };
export type ToHost = { m: "change" } | { m: "answer"; p: string; v: number };

export interface WorkspaceConfig {
  plugins: string[];
  maxVer: number;
  maxListens: number;
  /** The host says someone listens after the listener's first read (queueMicrotask). */
  bug?: boolean;
}

export interface WorkspaceState {
  ver: number;
  sub: Record<string, boolean>;
  listens: Record<string, number>;
  /** null: nothing read yet (the model's None). */
  known: Record<string, number | null>;
  reading: Record<string, boolean>;
  dirty: Record<string, boolean>;
  toCore: ToCore[];
  toHost: ToHost[];
  watching: boolean;
  seen: number | null;
  told: number;
}

export type WorkspaceAction =
  | { name: "Change" }
  | { name: "Listen"; p: string }
  | { name: "Unlisten"; p: string }
  | { name: "Read"; p: string }
  | { name: "HostRecv" }
  | { name: "CoreRecv" }
  | { name: "Check" };

const clone = (s: WorkspaceState): WorkspaceState => structuredClone(s);

export class WorkspaceReference {
  constructor(readonly config: WorkspaceConfig) {}

  init(): WorkspaceState {
    const per = <T>(value: T) => Object.fromEntries(this.config.plugins.map((p) => [p, value]));
    return {
      ver: 0, sub: per(false), listens: per(0), known: per<number | null>(null), reading: per(false), dirty: per(false),
      toCore: [], toHost: [], watching: false, seen: null, told: 0,
    };
  }

  step(s: WorkspaceState, a: WorkspaceAction): WorkspaceState | null {
    const n = clone(s);
    switch (a.name) {
      case "Change":
        if (s.ver >= this.config.maxVer) return null;
        n.ver++;
        return n;
      case "Listen": {
        if (s.sub[a.p] || s.reading[a.p] || s.listens[a.p]! >= this.config.maxListens) return null;
        n.sub[a.p] = true; n.listens[a.p]!++; n.reading[a.p] = true; n.dirty[a.p] = false;
        const reg: ToCore = { m: "reg", on: true }, read: ToCore = { m: "read", p: a.p };
        n.toCore.push(...(this.config.bug ? [read, reg] : [reg, read]));
        return n;
      }
      case "Unlisten":
        if (!s.sub[a.p]) return null;
        n.sub[a.p] = false; n.dirty[a.p] = false;
        n.toCore.push({ m: "reg", on: Object.values(n.sub).some(Boolean) });
        return n;
      case "Read":
        if (!s.sub[a.p] || !s.dirty[a.p] || s.reading[a.p]) return null;
        n.reading[a.p] = true; n.dirty[a.p] = false;
        n.toCore.push({ m: "read", p: a.p });
        return n;
      case "HostRecv": {
        const m = n.toHost.shift();
        if (!m) return null;
        if (m.m === "answer") { n.known[m.p] = m.v; n.reading[m.p] = false; }
        else for (const p of this.config.plugins) n.dirty[p] = s.dirty[p]! || s.sub[p]!;
        return n;
      }
      case "CoreRecv": {
        const m = n.toCore.shift();
        if (!m) return null;
        if (m.m === "reg") { n.watching = m.on; n.seen = !m.on ? null : s.watching ? s.seen : s.ver; }
        else n.toHost.push({ m: "answer", p: m.p, v: s.ver });
        return n;
      }
      case "Check":
        if (!s.watching || s.seen === s.ver) return null;
        n.seen = s.ver; n.told++;
        n.toHost.push({ m: "change" });
        return n;
    }
  }

  enabled(s: WorkspaceState): WorkspaceAction[] {
    const candidates: WorkspaceAction[] = [
      { name: "Change" }, { name: "HostRecv" }, { name: "CoreRecv" }, { name: "Check" },
      ...this.config.plugins.flatMap((p) => [{ name: "Listen", p }, { name: "Unlisten", p }, { name: "Read", p }] as WorkspaceAction[]),
    ];
    return candidates.filter((a) => this.step(s, a) !== null);
  }

  /** The model's invariants that fail in `s` (none: all hold). */
  invariants(s: WorkspaceState): string[] {
    const out: string[] = [];
    if (!s.watching && s.seen !== null) out.push("NoDigestUnwatched");
    if (s.seen !== null && s.seen > s.ver) out.push("SeenNotAhead");
    if (this.config.plugins.some((p) => s.known[p] != null && s.known[p]! > s.ver)) out.push("KnownNotAhead");
    return out;
  }
}

/** What the app shows of a state (what the conformance test compares). */
export interface WorkspaceView {
  ver: number;
  plugins: Record<string, { sub: boolean; known: number | null; reading: boolean; dirty: boolean }>;
  toCore: ToCore[];
  toHost: ToHost[];
  watching: boolean;
  told: number;
}

export function viewOf(s: WorkspaceState): WorkspaceView {
  return {
    ver: s.ver,
    plugins: Object.fromEntries(Object.keys(s.sub).map((p) => [p, { sub: s.sub[p]!, known: s.known[p]!, reading: s.reading[p]!, dirty: s.dirty[p]! }])),
    toCore: s.toCore, toHost: s.toHost, watching: s.watching, told: s.told,
  };
}
