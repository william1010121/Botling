// `botlingd machines` and the peer part of `botlingd status` (M3 step 13, protocol v1 §4.3, §10.5, §11.2): the other
// servers of this cluster, each with its state and since, and this server's forward queue; plus the two Doctor notes
// about them. Read from the data folder only (no admin session), so it works whether or not botlingd runs:
//
// - while it runs, each peer's state is the registry's (`botlingd.peers.json`, written on every change by
//   server/peer/peers.ts and tied to the running pid): `live` since the session opened, `stale` since the last frame
//   heard (on this server's clock), `gone` while the roster says the peer is not valid;
// - when it does not run (or the file is from another pid), nothing is live: every peer is `stale` since the last
//   frame this server heard from it as its copy of the peer's `srv:` table recorded (`streams.heardAt`, §7.3), or
//   `gone` if the copy was marked so; a peer with no copy yet has `since: null`;
// - peers are the servers an Add in this roster names (other than this server), with the name the Add gives;
// - the fingerprint is the member id grouped by four (what `botlingd join` / `add-machine` print): public, not a key.
//
// Doctor notes: a peer stale for more than an hour (`peer-stale`), and a row of the forward queue held for more than
// an hour (`forward-queue-old`, per owner). Nothing here reads a key file, a code, a token or the VAPID key, and no
// output carries one (step 13's log scan checks it).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { memberFingerprint, type ServerState } from "../protocol";
import type { ServerNote } from "./notes";
import { parseStored } from "./roster/verify";
import type { Db } from "./store";

/** botlingd.peers.json (the same name botlingd.ts exports as PEERS_FILE; kept here so the CLI does not load the daemon's graph twice). */
export const PEERS_STATE_FILE = "botlingd.peers.json";
/** A peer not heard from for longer than this gets a Doctor note. */
export const PEER_STALE_NOTE_MS = 60 * 60 * 1000;
/** A forward-queue row held for longer than this gets a Doctor note. */
export const FORWARD_OLD_NOTE_MS = 60 * 60 * 1000;

export interface MachineRow {
  member: string;
  name: string;
  fingerprint: string;
  state: ServerState;
  /** live: since the session opened; stale: the last frame heard (this server's clock); gone: when it was seen so. */
  since: number | null;
  /** Where the state comes from: the running server's registry, or the stored copy (botlingd not running). */
  from: "running" | "stored";
}

export interface MachinesReport {
  /** This server (null before server.db has an id). */
  self: { member: string; name: string | null; fingerprint: string } | null;
  peers: MachineRow[];
}

export interface ForwardQueueReport {
  /** Commands held for another server's targets, not yet answered by their owner. */
  rows: number;
  cancels: number;
  oldestHeldAt: number | null;
  owners: Array<{ owner: string; rows: number; oldestHeldAt: number }>;
}

interface PeersFile { pid?: number; peers?: Array<{ member?: unknown; name?: unknown; state?: unknown; since?: unknown }> }

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
const states = new Set<string>(["live", "stale", "gone"]);

function fingerprintOf(member: string): string {
  try { return memberFingerprint(member); } catch { return member; }
}

/** The running registry's peer states, when the file belongs to `pid`. */
function runningStates(dataDir: string, pid: number | null): Map<string, { name?: string; state: ServerState; since: number | null }> | null {
  if (pid === null) return null;
  let file: PeersFile;
  try { file = JSON.parse(readFileSync(join(dataDir, PEERS_STATE_FILE), "utf8")) as PeersFile; } catch { return null; }
  if (file.pid !== pid || !Array.isArray(file.peers)) return null;
  const out = new Map<string, { name?: string; state: ServerState; since: number | null }>();
  for (const peer of file.peers) {
    if (typeof peer.member !== "string" || typeof peer.state !== "string" || !states.has(peer.state)) continue;
    out.set(peer.member, {
      ...(typeof peer.name === "string" ? { name: peer.name } : {}),
      state: peer.state as ServerState,
      since: typeof peer.since === "number" ? peer.since : null,
    });
  }
  return out;
}

/** Every server an Add in this roster names, with the first name an Add gives it. */
function rosterServers(db: Db): Map<string, string> {
  const names = new Map<string, string>();
  let rows: Array<Record<string, unknown>>;
  try { rows = db.prepare("SELECT bytes FROM roster ORDER BY receivedAt, id").all(); } catch { return names; }
  for (const row of rows) {
    const statement = row.bytes instanceof Uint8Array ? parseStored(row.bytes) : null;
    const body = statement?.body;
    if (body?.type === "add" && body.kind === "server" && !names.has(body.member)) names.set(body.member, body.name);
  }
  return names;
}

/** The peers of this data folder and their states (`db`: a reader of server.db; `pid`: the running botlingd, or null). */
export function readMachines(dataDir: string, db: Db | null, pid: number | null): MachinesReport {
  const running = runningStates(dataDir, pid);
  if (!db) {
    const peers = [...(running ?? new Map()).entries()].map(([member, peer]) => ({
      member, name: peer.name ?? member, fingerprint: fingerprintOf(member), state: peer.state, since: peer.since, from: "running" as const,
    }));
    return { self: null, peers: peers.sort((a, b) => (a.member < b.member ? -1 : 1)) };
  }
  const self = String(db.prepare("SELECT value FROM meta WHERE key = 'serverId'").get()?.value ?? "") || null;
  const names = rosterServers(db);
  const stored = new Map<string, { state: string; heardAt: number | null }>();
  for (const row of db.prepare("SELECT stream, owner, state, heardAt FROM streams WHERE stream LIKE 'srv:%'").all()) {
    const owner = String(row.owner);
    if (owner === self || `srv:${owner}` !== row.stream) continue;
    stored.set(owner, { state: String(row.state), heardAt: row.heardAt == null ? null : Number(row.heardAt) });
  }
  const members = new Set<string>([...names.keys(), ...(running?.keys() ?? [])]);
  if (self) members.delete(self);
  const peers: MachineRow[] = [];
  for (const member of [...members].sort()) {
    const copy = stored.get(member);
    const live = running?.get(member);
    const name = names.get(member) ?? live?.name ?? member;
    if (live) {
      // `since: null` = no session in this run yet: the stored copy says when it was last heard.
      const since = live.since ?? (live.state === "stale" ? copy?.heardAt ?? null : null);
      peers.push({ member, name, fingerprint: fingerprintOf(member), state: live.state, since, from: "running" });
    } else {
      peers.push({ member, name, fingerprint: fingerprintOf(member), state: copy?.state === "gone" ? "gone" : "stale", since: copy?.heardAt ?? null, from: "stored" });
    }
  }
  return { self: self ? { member: self, name: names.get(self) ?? null, fingerprint: fingerprintOf(self) } : null, peers };
}

/** The forward queue (`forwardq`, `fwdcancels`): its length, its oldest row, per owner. */
export function readForwardQueue(db: Db): ForwardQueueReport {
  try {
    const owners = db.prepare("SELECT owner, COUNT(*) AS n, MIN(heldAt) AS oldest FROM forwardq GROUP BY owner ORDER BY owner").all()
      .map((row) => ({ owner: String(row.owner), rows: Number(row.n), oldestHeldAt: Number(row.oldest) }));
    const cancels = Number(db.prepare("SELECT COUNT(*) AS n FROM fwdcancels").get()?.n ?? 0);
    const rows = owners.reduce((sum, owner) => sum + owner.rows, 0);
    const oldestHeldAt = owners.length ? Math.min(...owners.map((owner) => owner.oldestHeldAt)) : null;
    return { rows, cancels, oldestHeldAt, owners };
  } catch {
    // A server.db from before the forward queue (schema < v8 is migrated at start; status may read it first).
    return { rows: 0, cancels: 0, oldestHeldAt: null, owners: [] };
  }
}

/** The Doctor notes about peers and the forward queue. */
export function peerNotes(machines: MachinesReport, queue: ForwardQueueReport, now = Date.now()): ServerNote[] {
  const notes: ServerNote[] = [];
  const names = new Map(machines.peers.map((peer) => [peer.member, peer.name]));
  for (const peer of machines.peers) {
    if (peer.state !== "stale" || peer.since === null || now - peer.since <= PEER_STALE_NOTE_MS) continue;
    notes.push({
      id: "peer-stale", level: "warning",
      text: `Machine "${peer.name}" (${peer.fingerprint}) has not been heard from since ${iso(peer.since)} (over an hour): its bots show their last summary, and commands for them wait in the forward queue until it is reachable again.`,
    });
  }
  for (const owner of queue.owners) {
    if (now - owner.oldestHeldAt <= FORWARD_OLD_NOTE_MS) continue;
    const name = names.get(owner.owner) ?? owner.owner;
    notes.push({
      id: "forward-queue-old", level: "warning",
      text: `${owner.rows} command${owner.rows === 1 ? "" : "s"} for machine "${name}" ${owner.rows === 1 ? "has" : "have"} been held since ${iso(owner.oldestHeldAt)} (over an hour); ${owner.rows === 1 ? "it is" : "they are"} sent once "${name}" is reachable again (botlingd machines shows its state).`,
    });
  }
  return notes;
}

/** `botlingd machines` as text lines. */
export function machinesLines(report: MachinesReport, queue: ForwardQueueReport | null): string[] {
  const lines: string[] = [];
  if (report.self) lines.push(`this machine${report.self.name ? ` "${report.self.name}"` : ""}: ${report.self.fingerprint}`);
  if (!report.peers.length) {
    lines.push("no other machines (pair one: botlingd join on it, then botlingd add-machine <link> here)");
    return lines;
  }
  const queued = new Map(queue?.owners.map((owner) => [owner.owner, owner]) ?? []);
  for (const peer of report.peers) {
    const since = peer.since !== null ? ` since ${iso(peer.since)}` : peer.state === "stale" ? " (not heard from yet)" : "";
    const held = queued.get(peer.member);
    const tail = held ? ` · ${held.rows} held for it` : "";
    lines.push(`"${peer.name}" ${peer.fingerprint}: ${peer.state}${since}${peer.from === "stored" ? " (botlingd is not running)" : ""}${tail}`);
  }
  return lines;
}
