// Roster and preference gossip between servers (protocol v1 §4.7, §17; M3 step 5), over full peer sessions (the
// D47 exchange of Revoke/Root at every session start is server/peer/peer-session.ts; this is the rest).
//
// Roster:
//   - session start: `roster.have{digest}` from each side;
//   - `roster.have` whose digest is not this side's → `roster.ids` (every stored id, chunks of ≤ 2,000; the last
//     chunk is shorter, empty if need be: it closes the set);
//   - a whole `roster.ids` set → `roster.want` for the ids this side lacks (minus what it refused this round);
//   - `roster.want` → `roster.statements` with those statements (a set: chunks of ≤ 200, the last shorter);
//   - a whole `roster.statements` set is merged at once (RosterStore.mergeGossip: only what verifies and a known party
//     signed is stored, so an Endorse may travel before its Add inside one set);
//   - every roster change here: the statements this session has not carried yet are pushed at once (a set), then
//     `roster.have`, so anything still apart is found by the ids round. What was refused is asked for again only after
//     a later change (no loop on a statement this side cannot take).
// Preferences: `prefs.have{digest}` at start; a different digest → `prefs.ids{versions}` (chunks of ≤ 500, last shorter);
// a whole ids set → this side's newer rows pushed as `prefs.rows` and `prefs.want` for the peer's newer keys;
// `prefs.want` → `prefs.rows`; `prefs.rows` merged per frame (LWW per key, PrefsStore); every changed row is pushed
// to every live peer at once.
// Bounds: a set (ids, statements or prefs ids) larger than MAX_GOSSIP_SET ends the session (`bye{too-large}`).
// Frames are handled one at a time in order (the peer session awaits each: D58).
import { rosterDigest, statementId, PREFS_LIMIT, comparePrefVersions, type PrefRow, type PrefVersion, type SignedStatement, type WireMessage } from "../../protocol";
import type { PrefsStore } from "./prefs";
import { MAX_GOSSIP_SET, type RosterStore } from "./store";

/** Ids per `roster.ids` / `roster.want` frame (the messages' own cap). */
export const IDS_PER_FRAME = 2_000;
/** Statements per `roster.statements` frame (the message's own cap). */
export const STATEMENTS_PER_FRAME = 200;
export { MAX_GOSSIP_SET };

/** What gossip needs of a peer session (server/peer/peer-session.ts `PeerSession`). */
export interface GossipSession {
  readonly peer: string | null;
  readonly state: string;
  sendWire(message: WireMessage): boolean;
  bye(reason: "too-large", detail: string): void;
}

export type GossipRoster = Pick<RosterStore, "memberId" | "view" | "gossipStatements" | "statementsById" | "mergeGossip" | "onChange">;
export type GossipPrefs = Pick<PrefsStore, "rows" | "get" | "versions" | "digest" | "merge" | "onChange">;

interface PeerState {
  session: GossipSession;
  /** Statement ids the peer holds as far as this side knows (it listed them, sent them, or was sent them). */
  known: Set<string>;
  /** Ids this side could not take from this peer since the last roster change. */
  refused: Set<string>;
  ids: string[];
  statements: SignedStatement[];
  prefIds: PrefVersion[];
}

export interface GossipOptions {
  roster: GossipRoster;
  prefs: GossipPrefs;
  log(line: string): void;
}

const ROSTER_TYPES = new Set(["roster.have", "roster.ids", "roster.want", "roster.statements"]);
const PREFS_TYPES = new Set(["prefs.have", "prefs.ids", "prefs.want", "prefs.rows"]);

export class Gossip {
  private readonly peers = new Map<GossipSession, PeerState>();
  private unlisten: Array<() => void> = [];
  /** Counters for status and tests. */
  readonly stats = { statementsSent: 0, statementsTaken: 0, refused: 0, prefRowsSent: 0, prefRowsTaken: 0 };

  constructor(private readonly options: GossipOptions) {}

  start(): void {
    if (this.unlisten.length) return;
    this.unlisten.push(this.options.roster.onChange(() => this.rosterChanged()));
    this.unlisten.push(this.options.prefs.onChange((rows) => this.prefsChanged(rows)));
  }

  close(): void {
    for (const off of this.unlisten.splice(0)) off();
    this.peers.clear();
  }

  /** A full peer session is the pair's one session (peers.ts `sessionOpened`): roster sync first (§4.6, §4.7). */
  opened(session: GossipSession): void {
    if (this.peers.has(session)) return;
    this.peers.set(session, { session, known: new Set(), refused: new Set(), ids: [], statements: [], prefIds: [] });
    void this.sendHave(session);
  }

  closed(session: GossipSession): void { this.peers.delete(session); }

  /** A peer frame past the roster sync; false when it is not a gossip frame. */
  async onMessage(session: GossipSession, message: WireMessage): Promise<boolean> {
    if (!ROSTER_TYPES.has(message.t) && !PREFS_TYPES.has(message.t)) return false;
    const peer = this.peers.get(session);
    if (!peer) return true; // not (or no longer) the pair's session: dropped
    switch (message.t) {
      case "roster.have": {
        const mine = await rosterDigest(this.options.roster.gossipStatements().map((item) => item.id));
        if (message.digest !== mine) this.sendIds(peer);
        return true;
      }
      case "roster.ids": {
        const ids = message.ids;
        if (!this.collect(peer, "ids", ids, IDS_PER_FRAME)) return true;
        const set = peer.ids;
        peer.ids = [];
        for (const id of set) peer.known.add(id);
        const held = new Set(this.options.roster.gossipStatements().map((item) => item.id));
        const want = [...new Set(set)].filter((id) => !held.has(id) && !peer.refused.has(id));
        for (let at = 0; at < want.length; at += IDS_PER_FRAME) session.sendWire({ t: "roster.want", ids: want.slice(at, at + IDS_PER_FRAME) } as WireMessage);
        return true;
      }
      case "roster.want": {
        const carried = new Set(this.options.roster.gossipStatements().map((item) => item.id));
        const found = this.options.roster.statementsById(message.ids.filter((id) => carried.has(id)));
        this.sendStatements(peer, found);
        return true;
      }
      case "roster.statements": {
        const statements = message.statements;
        if (!this.collect(peer, "statements", statements, STATEMENTS_PER_FRAME)) return true;
        const set = peer.statements;
        peer.statements = [];
        if (!set.length) return true;
        for (const statement of set) peer.known.add(await statementId(statement.body));
        const { fresh, refused } = await this.options.roster.mergeGossip(set);
        for (const id of refused) peer.refused.add(id);
        this.stats.statementsTaken += fresh.length;
        this.stats.refused += refused.length;
        if (fresh.length || refused.length) this.options.log(`gossip: peer ${session.peer}: took ${fresh.length} statement(s)${refused.length ? `, ${refused.length} not taken (unverified or no known signer)` : ""}`);
        return true;
      }
      case "prefs.have": {
        if (message.digest !== (await this.options.prefs.digest())) this.sendPrefIds(peer);
        return true;
      }
      case "prefs.ids": {
        const versions = message.versions;
        if (!this.collect(peer, "prefIds", versions, PREFS_LIMIT)) return true;
        const theirs = new Map(peer.prefIds.map((version) => [version.key, version]));
        peer.prefIds = [];
        const newer: PrefRow[] = [];
        for (const row of this.options.prefs.rows()) {
          const other = theirs.get(row.key);
          if (!other || comparePrefVersions(other, row) < 0) newer.push(row);
        }
        const want: string[] = [];
        for (const version of theirs.values()) {
          const mine = this.options.prefs.get(version.key);
          if (!mine || comparePrefVersions(mine, version) < 0) want.push(version.key);
        }
        this.sendPrefRows(session, newer);
        for (let at = 0; at < want.length; at += PREFS_LIMIT) session.sendWire({ t: "prefs.want", keys: want.slice(at, at + PREFS_LIMIT) } as WireMessage);
        return true;
      }
      case "prefs.want": {
        const rows = message.keys.map((key) => this.options.prefs.get(key)).filter((row): row is PrefRow => !!row);
        this.sendPrefRows(session, rows);
        return true;
      }
      case "prefs.rows": {
        const changed = await this.options.prefs.merge(message.rows);
        this.stats.prefRowsTaken += changed.length;
        if (changed.length) this.options.log(`gossip: peer ${session.peer}: took ${changed.length} preference row(s)`);
        return true;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------

  /** Adds one chunk to a set; true once the set is whole (its chunk is shorter than the cap). */
  private collect<K extends "ids" | "statements" | "prefIds">(peer: PeerState, field: K, chunk: PeerState[K], cap: number): boolean {
    const set = peer[field] as unknown[];
    if (set.length + chunk.length > MAX_GOSSIP_SET) {
      (peer[field] as unknown[]) = [];
      peer.session.bye("too-large", `a gossip set holds at most ${MAX_GOSSIP_SET} items`);
      return false;
    }
    set.push(...chunk);
    return chunk.length < cap;
  }

  private async sendHave(session: GossipSession): Promise<void> {
    const digest = await rosterDigest(this.options.roster.gossipStatements().map((item) => item.id));
    const prefs = await this.options.prefs.digest();
    if (!this.peers.has(session)) return;
    session.sendWire({ t: "roster.have", digest } as WireMessage);
    session.sendWire({ t: "prefs.have", digest: prefs } as WireMessage);
  }

  private sendIds(peer: PeerState): void {
    const ids = this.options.roster.gossipStatements().map((item) => item.id);
    for (let at = 0; ; at += IDS_PER_FRAME) {
      const chunk = ids.slice(at, at + IDS_PER_FRAME);
      peer.session.sendWire({ t: "roster.ids", ids: chunk } as WireMessage);
      if (chunk.length < IDS_PER_FRAME) break;
    }
  }

  private sendStatements(peer: PeerState, items: Array<{ id: string; statement: SignedStatement }>): void {
    for (const item of items) peer.known.add(item.id);
    this.stats.statementsSent += items.length;
    for (let at = 0; ; at += STATEMENTS_PER_FRAME) {
      const chunk = items.slice(at, at + STATEMENTS_PER_FRAME).map((item) => item.statement);
      peer.session.sendWire({ t: "roster.statements", statements: chunk } as WireMessage);
      if (chunk.length < STATEMENTS_PER_FRAME) break;
    }
  }

  private sendPrefIds(peer: PeerState): void {
    const versions = this.options.prefs.versions();
    for (let at = 0; ; at += PREFS_LIMIT) {
      const chunk = versions.slice(at, at + PREFS_LIMIT);
      peer.session.sendWire({ t: "prefs.ids", versions: chunk } as WireMessage);
      if (chunk.length < PREFS_LIMIT) break;
    }
  }

  private sendPrefRows(session: GossipSession, rows: PrefRow[]): void {
    this.stats.prefRowsSent += rows.length;
    for (let at = 0; at < rows.length; at += PREFS_LIMIT) session.sendWire({ t: "prefs.rows", rows: rows.slice(at, at + PREFS_LIMIT) } as WireMessage);
  }

  /** New statements here: push what each peer has not been sent, then `roster.have` (§4.6 "pushed at once", §4.7). */
  private rosterChanged(): void {
    const all = this.options.roster.gossipStatements();
    for (const peer of this.peers.values()) {
      if (peer.session.state !== "open") continue;
      peer.refused.clear();
      const fresh = all.filter((item) => !peer.known.has(item.id));
      if (fresh.length) this.sendStatements(peer, fresh);
      void this.sendHave(peer.session);
    }
  }

  private prefsChanged(rows: PrefRow[]): void {
    for (const peer of this.peers.values()) if (peer.session.state === "open") this.sendPrefRows(peer.session, rows);
  }
}
