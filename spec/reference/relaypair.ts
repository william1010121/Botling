// spec/models/relaypair/RelayPair.tla and LanPair.tla as TypeScript state machines: the same variables and
// actions under the same names. Pure: no app imports, no I/O. `next` lists every successor, as TLC would.

type By<T> = Readonly<Record<string, T>>;
const each = <T>(keys: readonly string[], value: (key: string) => T): By<T> => Object.fromEntries(keys.map((k) => [k, value(k)]));
const put = <T>(record: By<T>, key: string, value: T): By<T> => ({ ...record, [key]: value });

// ---- RelayPair: pairing and connecting a phone through the relay (desktop/src/mobile-relay/connector.ts).

export type RelayPc = "idle" | "new" | "hs" | "keys" | "granting" | "ready" | "serving" | "closed";
export type RelayUp = "hs" | "conf" | "req";
export type RelayDown = "ack" | "nope" | "paired" | "ready" | "res" | "revoked" | "bye";
export type RelayPh = "off" | "wait" | "keys" | "ready" | "refused" | "lost";
export type RelayOfferState = "unmade" | "live" | "used";
export type RelayBug = "none" | "old" | "noRecheck";
export type RelayAction = "Make" | "Expire" | "JoinPair" | "JoinSession" | "Drop" | "DeskClose" | "Recv" | "Request"
  | "Take" | "HsCheck" | "HsKeys" | "Confirm" | "Grant" | "ReqCheck" | "ReqSend" | "Revoke" | "RevokeDone";

export interface RelayConsts {
  conns: readonly string[];
  offers: readonly string[];
  /** "old": the connector before the model (no claim, steps resume on closed peers); "noRecheck": confirm of a
   * reconnecting phone does not look the device up again. */
  bug: RelayBug;
}

/** null is the model's None. */
export interface RelayState {
  offer: By<RelayOfferState>;
  exp: By<boolean>;
  claim: By<string | null>;
  by: By<readonly string[]>;
  store: readonly string[];
  pc: By<RelayPc>;
  busy: By<boolean>;
  mode: By<"pair" | "session" | null>;
  code: By<string | null>;
  dev: By<string | null>;
  up: By<readonly RelayUp[]>;
  down: By<readonly RelayDown[]>;
  ph: By<RelayPh>;
  sent: By<boolean>;
  cut: By<boolean>;
  kicked: By<boolean>;
  saved: readonly string[];
  rv: By<"no" | "running" | "done">;
  late: readonly string[];
  wasted: boolean;
}

export interface RelayStep {
  action: RelayAction;
  /** The connection (or, for Revoke/RevokeDone, the device) it is about. */
  conn?: string;
  offer?: string;
  /** JoinSession: the device the phone connects as. */
  device?: string;
  state: RelayState;
}

export function relayInit(c: RelayConsts): RelayState {
  return {
    offer: each(c.offers, () => "unmade"), exp: each(c.offers, () => false),
    claim: each(c.offers, () => null), by: each(c.offers, () => []),
    store: [], saved: [], late: [], wasted: false,
    pc: each(c.conns, () => "idle"), busy: each(c.conns, () => false), mode: each(c.conns, () => null),
    code: each(c.conns, () => null), dev: each(c.conns, () => null),
    up: each(c.conns, () => []), down: each(c.conns, () => []),
    ph: each(c.conns, () => "off"), sent: each(c.conns, () => false),
    cut: each(c.conns, () => false), kicked: each(c.conns, () => false),
    rv: each(c.conns, () => "no"),
  };
}

const KNOWN: ReadonlySet<RelayPc> = new Set(["keys", "granting", "ready", "serving"]);
const SERVED: ReadonlySet<RelayPc> = new Set(["granting", "ready", "serving"]);
const add = (set: readonly string[], x: string) => (set.includes(x) ? set : [...set, x].sort());
const drop = (set: readonly string[], x: string) => set.filter((y) => y !== x);

export function relayNext(k: RelayConsts, s: RelayState): RelayStep[] {
  const out: RelayStep[] = [];
  const go = (action: RelayAction, change: Partial<RelayState>, extra: Partial<RelayStep> = {}) =>
    out.push({ action, ...extra, state: { ...s, ...change } });
  const frame = (p: string) => (s.busy[p] ? s.up[p]![0]! : null);
  const putMsgs = (p: string, msgs: readonly RelayDown[]) => (s.cut[p] || s.kicked[p] ? s.down[p]! : [...s.down[p]!, ...msgs]);
  const send = (p: string, msgs: readonly RelayDown[]) => ({ down: put(s.down, p, putMsgs(p, msgs)) });
  const shut = (p: string, msgs: readonly RelayDown[]): Partial<RelayState> => ({
    pc: put(s.pc, p, "closed"), up: put(s.up, p, s.busy[p] ? [s.up[p]![0]!] : []),
    down: put(s.down, p, putMsgs(p, msgs)), kicked: put(s.kicked, p, s.kicked[p] || msgs.length > 0),
  });
  const end = (p: string, msgs: readonly RelayDown[]): Partial<RelayState> => ({
    pc: put(s.pc, p, "closed"), up: put(s.up, p, []), busy: put(s.busy, p, false),
    down: put(s.down, p, putMsgs(p, msgs)), kicked: put(s.kicked, p, true),
  });
  const done = (p: string): Partial<RelayState> => ({ up: put(s.up, p, s.up[p]!.slice(1)), busy: put(s.busy, p, false) });
  const open = (o: string) => s.offer[o] === "live" && !s.exp[o];
  const free = (o: string, p: string) => k.bug === "old" || s.claim[o] === null || s.claim[o] === p || s.pc[s.claim[o]!] === "closed";
  const late = (p: string) => (s.rv[s.dev[p]!] !== "no" ? add(s.late, s.dev[p]!) : s.late);
  const spend = (p: string): Partial<RelayState> => {
    const o = s.code[p]!;
    return { offer: put(s.offer, o, "used"), by: put(s.by, o, add(s.by[o]!, p)), store: add(s.store, p) };
  };

  for (const o of k.offers) {
    if (s.offer[o] === "unmade") go("Make", { offer: put(s.offer, o, "live") }, { offer: o });
    if (s.offer[o] !== "unmade" && !s.exp[o]) go("Expire", { exp: put(s.exp, o, true) }, { offer: o });
  }
  for (const p of k.conns) {
    const pc = s.pc[p]!;
    // The world.
    if (pc === "idle") {
      const joined = { pc: put(s.pc, p, "new"), ph: put(s.ph, p, "wait"), up: put(s.up, p, ["hs"]) } as const;
      for (const o of k.offers) {
        if (s.offer[o] !== "unmade" && !s.exp[o])
          go("JoinPair", { ...joined, mode: put(s.mode, p, "pair"), code: put(s.code, p, o), dev: put(s.dev, p, p) }, { conn: p, offer: o });
      }
      for (const d of s.saved) if (d !== p) go("JoinSession", { ...joined, mode: put(s.mode, p, "session"), dev: put(s.dev, p, d) }, { conn: p, device: d });
    }
    const ph = s.ph[p]!;
    if ((ph === "wait" || ph === "keys" || ph === "ready") && !s.cut[p] && !s.kicked[p])
      go("Drop", { cut: put(s.cut, p, true), down: put(s.down, p, []), ph: put(s.ph, p, ph === "ready" ? "ready" : "lost") }, { conn: p });
    if (s.cut[p] && pc !== "idle" && pc !== "closed") go("DeskClose", shut(p, []), { conn: p });
    // The phone.
    const m = s.down[p]![0];
    if (m !== undefined) {
      const rest = { down: put(s.down, p, s.down[p]!.slice(1)) };
      if (m === "ack" && ph === "wait") go("Recv", { ...rest, ph: put(s.ph, p, "keys"), up: put(s.up, p, [...s.up[p]!, "conf"]) }, { conn: p });
      else if ((m === "paired" || m === "ready") && ph === "keys")
        go("Recv", { ...rest, ph: put(s.ph, p, "ready"), saved: m === "paired" ? add(s.saved, p) : s.saved }, { conn: p });
      else if ((m === "nope" || m === "revoked") && (ph === "wait" || ph === "keys" || ph === "ready")) go("Recv", { ...rest, ph: put(s.ph, p, "refused") }, { conn: p });
      else if (m === "bye") go("Recv", { ...rest, ph: put(s.ph, p, ph === "wait" || ph === "keys" ? "lost" : ph) }, { conn: p });
      else go("Recv", rest, { conn: p });
    }
    if (ph === "ready" && !s.sent[p] && !s.cut[p] && !s.kicked[p])
      go("Request", { sent: put(s.sent, p, true), up: put(s.up, p, [...s.up[p]!, "req"]) }, { conn: p });
    // The connector.
    if ((pc === "new" || pc === "keys" || pc === "ready") && !s.busy[p] && s.up[p]!.length) go("Take", { busy: put(s.busy, p, true) }, { conn: p });
    const f = frame(p);
    const gone = pc === "closed";
    if (f === "hs") {
      const o = s.code[p];
      if (gone) go("HsCheck", done(p), { conn: p });
      else if (s.mode[p] === "pair" && open(o!) && free(o!, p))
        go("HsCheck", { pc: put(s.pc, p, "hs"), ...done(p), claim: k.bug === "old" ? s.claim : put(s.claim, o!, p) }, { conn: p });
      else if (s.mode[p] === "session" && s.store.includes(s.dev[p]!)) go("HsCheck", { pc: put(s.pc, p, "hs"), ...done(p) }, { conn: p });
      else go("HsCheck", end(p, ["nope", "bye"]), { conn: p });
    }
    if (pc === "hs") go("HsKeys", { pc: put(s.pc, p, "keys"), ...send(p, ["ack"]) }, { conn: p });
    if (f === "conf") {
      if (gone) {
        if (k.bug === "old" && s.mode[p] === "pair" && open(s.code[p]!)) go("Confirm", { ...done(p), ...spend(p), wasted: true }, { conn: p });
        else go("Confirm", done(p), { conn: p });
      } else if (s.mode[p] === "pair" && open(s.code[p]!)) go("Confirm", { ...spend(p), pc: put(s.pc, p, "granting"), ...done(p) }, { conn: p });
      else if (s.mode[p] === "session" && (s.store.includes(s.dev[p]!) || k.bug === "noRecheck"))
        go("Confirm", { pc: put(s.pc, p, "granting"), ...done(p) }, { conn: p });
      else go("Confirm", end(p, ["bye"]), { conn: p });
    }
    if (pc === "granting") go("Grant", { pc: put(s.pc, p, "ready"), ...send(p, [s.mode[p] === "pair" ? "paired" : "ready"]), late: late(p) }, { conn: p });
    if (f === "req") {
      if (gone) go("ReqCheck", done(p), { conn: p });
      else if (s.store.includes(s.dev[p]!)) go("ReqCheck", { pc: put(s.pc, p, "serving"), ...done(p) }, { conn: p });
      else go("ReqCheck", end(p, ["revoked", "bye"]), { conn: p });
    }
    if (pc === "serving") go("ReqSend", { pc: put(s.pc, p, "ready"), ...send(p, ["res"]), late: late(p) }, { conn: p });
    // revoke(d), d = p as a device.
    if (s.store.includes(p) && s.rv[p] === "no") {
      const hit = k.conns.filter((q) => s.dev[q] === p && KNOWN.has(s.pc[q]!));
      const pcs = { ...s.pc }, ups = { ...s.up }, downs = { ...s.down }, kicks = { ...s.kicked };
      for (const q of hit) {
        pcs[q] = "closed";
        ups[q] = s.busy[q] ? [s.up[q]![0]!] : [];
        downs[q] = putMsgs(q, SERVED.has(s.pc[q]!) ? ["revoked", "bye"] : ["bye"]);
        kicks[q] = true;
      }
      go("Revoke", { store: drop(s.store, p), rv: put(s.rv, p, "running"), pc: pcs, up: ups, down: downs, kicked: kicks }, { conn: p });
    }
    if (s.rv[p] === "running") go("RevokeDone", { rv: put(s.rv, p, "done") }, { conn: p });
  }
  return out;
}

/** The invariants of the model (RelayPair.cfg's) that `s` breaks (none: an empty list). */
export function relayViolated(k: RelayConsts, s: RelayState): string[] {
  const checks: Record<string, () => boolean> = {
    OneDevicePerCode: () => k.offers.every((o) => s.by[o]!.length <= 1),
    RevokeEnds: () => s.late.length === 0,
    NoUseByClosed: () => !s.wasted,
  };
  return Object.keys(checks).filter((name) => !checks[name]!());
}

/** What the driver can see: offers (used, and which connection's handshake claimed each), the devices stored,
 * where each connection's peer is, and the frames on their way to each phone. */
export interface RelayView {
  used: By<boolean>;
  claim: By<string | null>;
  store: readonly string[];
  pc: By<RelayPc>;
  busy: By<boolean>;
  down: By<readonly RelayDown[]>;
  saved: readonly string[];
}

export function relayObserve(k: RelayConsts, s: RelayState): RelayView {
  return {
    used: each(k.offers, (o) => s.offer[o] === "used"),
    claim: s.claim,
    store: s.store,
    pc: s.pc, busy: s.busy, down: s.down, saved: s.saved,
  };
}

// ---- LanPair: the home network's PairingStore (desktop/src/mobile-bridge/pairing.ts).

export type LanSt = "idle" | "create" | "take" | "issue" | "issuing" | "answer" | "revoke" | "dead";
export type LanGot = "none" | "asking" | "token" | "invalid" | "lost";
export type LanAction = "BeginCreate" | "Create" | "BeginTake" | "Take" | "BeginIssue" | "Issue" | "Answer" | "BeginRevoke" | "Revoke"
  | "Crash" | "BreakO" | "BreakP" | "Expire";

export interface LanConsts {
  procs: readonly string[];
  phones: readonly string[];
  codes: readonly string[];
  /** "nolock": the files are read and written without their locks. */
  bug: "none" | "nolock";
}

export interface LanState {
  offers: readonly string[];
  made: readonly string[];
  exp: readonly string[];
  clients: readonly string[];
  lockO: string | null;
  lockP: string | null;
  st: By<LanSt>;
  who: By<string | null>;
  sc: By<string | null>;
  snap: By<readonly string[]>;
  got: By<LanGot>;
  issued: By<readonly string[]>;
  taken: By<string | null>;
  rv: readonly string[];
}

export interface LanStep {
  action: LanAction;
  proc?: string;
  phone?: string;
  code?: string;
  /** Answer: what reached the phone. */
  result?: "token" | "lost";
  state: LanState;
}

export function lanInit(c: LanConsts): LanState {
  return {
    offers: [], made: [], exp: [], clients: [], lockO: null, lockP: null,
    st: each(c.procs, () => "idle"), who: each(c.procs, () => null), sc: each(c.procs, () => null), snap: each(c.procs, () => []),
    got: each(c.phones, () => "none"), issued: each(c.codes, () => []), taken: each(c.codes, () => null), rv: [],
  };
}

export function lanNext(k: LanConsts, s: LanState): LanStep[] {
  const out: LanStep[] = [];
  const go = (action: LanAction, change: Partial<LanState>, extra: Partial<LanStep> = {}) => out.push({ action, ...extra, state: { ...s, ...change } });
  const free = (l: string | null) => k.bug === "nolock" || l === null;
  const hold = (q: string) => (k.bug === "nolock" ? null : q);
  const letGo = (l: string | null, q: string) => (l === q ? null : l);
  const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
  for (const q of k.procs) {
    const st = s.st[q]!;
    const goTo = (to: LanSt) => put(s.st, q, to);
    if (st === "idle") {
      for (const c of k.codes) {
        if (!s.made.includes(c) && free(s.lockO))
          go("BeginCreate", { lockO: hold(q), snap: put(s.snap, q, s.offers), sc: put(s.sc, q, c), st: goTo("create") }, { proc: q, code: c });
      }
      for (const f of k.phones) {
        if (free(s.lockP)) go("BeginRevoke", { lockP: hold(q), snap: put(s.snap, q, s.clients), who: put(s.who, q, f), st: goTo("revoke") }, { proc: q, phone: f });
        for (const c of k.codes) {
          if (s.got[f] === "none" && s.made.includes(c) && free(s.lockO))
            go("BeginTake", { lockO: hold(q), snap: put(s.snap, q, s.offers), who: put(s.who, q, f), sc: put(s.sc, q, c), got: put(s.got, f, "asking"), st: goTo("take") },
              { proc: q, phone: f, code: c });
        }
      }
    }
    const snap = s.snap[q]!, who = s.who[q]!, sc = s.sc[q]!;
    if (st === "create")
      go("Create", { offers: sorted([...snap.filter((c) => !s.exp.includes(c)), sc]), made: sorted([...s.made, sc]), lockO: letGo(s.lockO, q), st: goTo("idle"), sc: put(s.sc, q, null) }, { proc: q });
    if (st === "take") {
      const match = snap.includes(sc) && !s.exp.includes(sc);
      const live = snap.filter((c) => !s.exp.includes(c) && !(match && c === sc));
      const offers = live.length !== snap.length ? live : s.offers;
      if (match) go("Take", { offers, st: goTo("issue"), taken: put(s.taken, sc, who) }, { proc: q });
      else go("Take", { offers, st: goTo("idle"), lockO: letGo(s.lockO, q), got: put(s.got, who, "invalid"), who: put(s.who, q, null), sc: put(s.sc, q, null) }, { proc: q });
    }
    if (st === "issue" && free(s.lockP)) go("BeginIssue", { lockP: hold(q), snap: put(s.snap, q, s.clients), st: goTo("issuing") }, { proc: q });
    if (st === "issuing")
      go("Issue", { clients: sorted([...snap, who]), issued: put(s.issued, sc, sorted([...s.issued[sc]!, who])), rv: s.rv.filter((f) => f !== who), lockP: letGo(s.lockP, q), st: goTo("answer") }, { proc: q });
    if (st === "answer") {
      for (const result of ["token", "lost"] as const)
        go("Answer", { got: put(s.got, who, result), lockO: letGo(s.lockO, q), st: goTo("idle"), who: put(s.who, q, null), sc: put(s.sc, q, null) }, { proc: q, result });
    }
    if (st === "revoke") {
      const listed = snap.includes(who);
      go("Revoke", { ...(listed ? { clients: snap.filter((f) => f !== who), rv: sorted([...s.rv, who]) } : {}), lockP: letGo(s.lockP, q), st: goTo("idle"), who: put(s.who, q, null) }, { proc: q });
    }
    if (st !== "idle" && st !== "dead") {
      const asking = st === "take" || st === "issue" || st === "issuing" || st === "answer";
      go("Crash", { st: goTo("dead"), got: asking ? put(s.got, who, "lost") : s.got }, { proc: q });
    }
  }
  if (s.lockO !== null && s.st[s.lockO] === "dead") go("BreakO", { lockO: null });
  if (s.lockP !== null && s.st[s.lockP] === "dead") go("BreakP", { lockP: null });
  for (const c of k.codes) if (s.made.includes(c) && !s.exp.includes(c)) go("Expire", { exp: sorted([...s.exp, c]) }, { code: c });
  return out;
}

/** The invariants of LanPair.cfg that `s` breaks. */
export function lanViolated(k: LanConsts, s: LanState): string[] {
  const checks: Record<string, () => boolean> = {
    SingleUse: () => k.codes.every((c) => s.issued[c]!.length <= 1),
    RevokeSticks: () => s.rv.every((f) => !s.clients.includes(f)),
  };
  return Object.keys(checks).filter((name) => !checks[name]!());
}

/** What the driver can see on disk: the codes pairing-offers.json lists, the phones paired-clients.json lists. */
export interface LanView { offers: readonly string[]; clients: readonly string[] }
export const lanObserve = (s: LanState): LanView => ({ offers: s.offers, clients: s.clients });
