// Peer session settings (M3 step 3, M4-14): timers and where a peer server is dialled.
//
// - Timers (protocol v1 §5.2, §4.6, §20): `ping` after 15 s of this side's silence, a session that heard nothing for
//   45 s is dead; redial with backoff (1 s doubling to 60 s, ±25 %); a server that finds itself removed dials each peer
//   every 10 min for the revocation exchange only (D47). Tests shorten them with BOTLING_SERVER_PEER_TIMERS
//   ("ping=200,dead=600,redial=100,redialMax=1000,revoked=1500", milliseconds; unknown names are refused).
// - Addresses (§6.2): a member advertises them in its `Profile{field: "addresses"}`, whose value is a JSON object of
//   path kind → address (`loopback`, `tailnet`, `relay`). Unknown kinds are ignored (forward compatibility).
import { isIP } from "node:net";

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

export interface RelayAddress {
  url: string;
  room: string;
}

export interface PeerAddresses {
  loopback?: string;
  tailnet?: string;
  relay?: RelayAddress;
}

export interface AddressOptions {
  /** Tailnet https origins (`origins()` of LoopbackListener), converted to `wss://<name>/v3/ws`. */
  tailnet?: readonly string[] | string | null;
  /** Relay endpoint (`url` from `relayUrl`, `room` from `relayRoomOf`). Never pass the room key. */
  relay?: RelayAddress | null;
}

const LOOPBACK_WS = /^ws:\/\/127\.0\.0\.1:([0-9]{1,5})\/v3\/ws$/;
const RELAY_ROOM = /^[A-Za-z0-9_-]{1,200}$/;

function isValidTailnetHost(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false;
  // Never an IP (IPv4, IPv6 bracketed or unbracketed, or numeric/dotted digits).
  if (hostname.startsWith("[") || hostname.includes(":") || isIP(hostname) !== 0 || /^[0-9.]+$/.test(hostname)) return false;
  if (!/^[A-Za-z0-9.-]+$/.test(hostname)) return false;
  if (hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("..")) return false;
  return true;
}

function parseLoopbackUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const match = LOOPBACK_WS.exec(raw);
  if (!match) return undefined;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 ? raw : undefined;
}

function parseTailnetUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw || raw.length > 500 || /\s/.test(raw)) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "wss:" || url.pathname !== "/v3/ws") return undefined;
  if (url.search || url.hash || url.username || url.password) return undefined;
  if (!isValidTailnetHost(url.hostname)) return undefined;
  if (url.port !== "") {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  }
  return url.href;
}

function parseRelayAddress(raw: unknown): RelayAddress | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const rawUrl = record.url;
  const room = record.room;
  if (typeof rawUrl !== "string" || !rawUrl || rawUrl.length > 500 || /\s/.test(rawUrl)) return undefined;
  if (typeof room !== "string" || !RELAY_ROOM.test(room)) return undefined;
  let url: URL;
  try { url = new URL(rawUrl); } catch { return undefined; }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return undefined;
  if (url.hash || url.username || url.password) return undefined;
  return { url: url.href, room };
}

function tailnetAddressFromOrigin(origin: string): string | undefined {
  const trimmed = origin.trim();
  if (!trimmed || trimmed.length > 500 || /\s/.test(trimmed)) return undefined;
  let url: URL;
  try { url = new URL(trimmed); } catch { return undefined; }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) return undefined;
  if (!isValidTailnetHost(url.hostname)) return undefined;
  return parseTailnetUrl(`wss://${url.host}/v3/ws`);
}

/** Every valid peer address advertised in a member's Profile `addresses` value (§6.2); unknown kinds are ignored. */
export function peerAddresses(value: string | null): PeerAddresses {
  if (!value) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return {}; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;
  const out: PeerAddresses = {};
  const loopback = parseLoopbackUrl(record.loopback);
  if (loopback) out.loopback = loopback;
  const tailnet = parseTailnetUrl(record.tailnet);
  if (tailnet) out.tailnet = tailnet;
  const relay = parseRelayAddress(record.relay);
  if (relay) out.relay = relay;
  return out;
}

/** The loopback address this M3 caller dials for a peer, from its Profile `addresses` value, or null. */
export function loopbackAddress(value: string | null): string | null {
  return peerAddresses(value).loopback ?? null;
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

/** A Profile `addresses` value naming this server's reachable paths (loopback, tailnet, relay room). */
export function addressesValue(port: number | null, options: AddressOptions = {}): string {
  const out: PeerAddresses = {};
  if (port !== null && Number.isInteger(port) && port >= 1 && port <= 65_535) {
    out.loopback = `ws://127.0.0.1:${port}/v3/ws`;
  }
  if (out.loopback) {
    const origins = Array.isArray(options.tailnet) ? options.tailnet : options.tailnet ? [options.tailnet] : [];
    for (const origin of origins) {
      const tailnet = tailnetAddressFromOrigin(origin);
      if (tailnet) { out.tailnet = tailnet; break; }
    }
  }
  const relay = parseRelayAddress(options.relay);
  if (relay) out.relay = relay;
  return JSON.stringify(out);
}

/** A Profile `addresses` value for a single dialled WebSocket URL (`loopback` or `tailnet`), or null if unrecognized. */
export function addressesForUrl(url: string): string | null {
  const loopback = parseLoopbackUrl(url);
  if (loopback) return JSON.stringify({ loopback });
  const tailnet = parseTailnetUrl(url);
  if (tailnet) return JSON.stringify({ tailnet });
  return null;
}
