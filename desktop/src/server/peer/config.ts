// Peer session settings (M3 step 3): timers and where a peer server is dialled.
//
// - Timers (protocol v1 §5.2, §4.6, §20): `ping` after 15 s of this side's silence, a session that heard nothing for
//   45 s is dead; redial with backoff (1 s doubling to 60 s, ±25 %); a server that finds itself removed dials each peer
//   every 10 min for the revocation exchange only (D47). Tests shorten them with BOTLING_SERVER_PEER_TIMERS
//   ("ping=200,dead=600,redial=100,redialMax=1000,revoked=1500", milliseconds; unknown names are refused).
// - Addresses (§6.2): a member advertises them in its `Profile{field: "addresses"}`, whose value is a JSON object of
//   path kind → address. M3 dials only `loopback`: `ws://127.0.0.1:<port>/v3/ws` (two servers on one machine, or the
//   configured Linux host behind an ssh local port forward, m3-brief Q2). Any other address is ignored here; the
//   tailnet and relay paths and path choice are M4.

export interface PeerTimers {
  pingMs: number;
  deadMs: number;
  redialMinMs: number;
  redialMaxMs: number;
  revokedRedialMs: number;
}

export const DEFAULT_PEER_TIMERS: PeerTimers = {
  pingMs: 15_000,
  deadMs: 45_000,
  redialMinMs: 1_000,
  redialMaxMs: 60_000,
  revokedRedialMs: 10 * 60_000,
};

export const PEER_TIMERS_ENV = "BOTLING_SERVER_PEER_TIMERS";

const NAMES: Record<string, keyof PeerTimers> = {
  ping: "pingMs", dead: "deadMs", redial: "redialMinMs", redialMax: "redialMaxMs", revoked: "revokedRedialMs",
};

/** The timers from the environment (defaults when unset); a malformed value throws at start. */
export function peerTimers(env: Record<string, string | undefined>): PeerTimers {
  const text = (env[PEER_TIMERS_ENV] ?? "").trim();
  const timers = { ...DEFAULT_PEER_TIMERS };
  if (!text) return timers;
  for (const part of text.split(",")) {
    const match = /^\s*([A-Za-z]+)\s*=\s*(\d{1,9})\s*$/.exec(part);
    const key = match ? NAMES[match[1]] : undefined;
    if (!match || !key || Number(match[2]) < 10) throw new Error(`${PEER_TIMERS_ENV}: "${part}" is not name=milliseconds (ping, dead, redial, redialMax, revoked; at least 10)`);
    timers[key] = Number(match[2]);
  }
  if (timers.deadMs <= timers.pingMs) throw new Error(`${PEER_TIMERS_ENV}: dead must be longer than ping`);
  if (timers.redialMaxMs < timers.redialMinMs) throw new Error(`${PEER_TIMERS_ENV}: redialMax below redial`);
  return timers;
}

const LOOPBACK_WS = /^ws:\/\/127\.0\.0\.1:([0-9]{1,5})\/v3\/ws$/;

/** The address this M3 server dials for a peer, from its Profile `addresses` value, or null. */
export function loopbackAddress(value: string | null): string | null {
  if (!value) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const loopback = (parsed as Record<string, unknown>).loopback;
  if (typeof loopback !== "string") return null;
  const match = LOOPBACK_WS.exec(loopback);
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 ? loopback : null;
}

/**
 * The port this server names in its own `Profile{addresses}` (M3 step 5): its listener's port, unless
 * BOTLING_SERVER_ADVERTISE_PORT names another loopback port (tests: the fault proxy in front of it, so peers that learn
 * the address by gossip dial through the proxy). The listener still binds its own port on 127.0.0.1 only.
 */
export const ADVERTISE_PORT_ENV = "BOTLING_SERVER_ADVERTISE_PORT";
export function advertisedPort(env: Record<string, string | undefined>, port: number): number {
  const raw = env[ADVERTISE_PORT_ENV];
  if (raw === undefined || raw === "") return port;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : port;
}

/** A Profile `addresses` value naming this server's loopback listener. */
export function addressesValue(port: number): string {
  return JSON.stringify({ loopback: `ws://127.0.0.1:${port}/v3/ws` });
}
