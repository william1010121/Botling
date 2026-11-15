// The shell link's names: version and timing constants, the diagnostics record, and the option / result shapes of the link
// (moved out of connection.ts; connection.ts re-exports every name).
import { relayPageOrigin } from "../../src/session";
import type { Clock, Dial, FeLink, FeStorage } from "../../src/fe-link";
import type { OriginEpoch, ServerAddresses, ServerState } from "../../src/protocol";
import type { LinkPort } from "../../src/main-v3/renderer-adapter";
import { newPlayerDiagnostics, type MediaDiagnostics, type PlayerDiagnostics } from "./media";
import { newBridgeDiagnostics, type BridgeDiagnostics } from "./sw-bridge";
import { newVideoDiagnostics, type VideoDiagnostics } from "./video-overlay";

export const FE_VERSION = "3.0.0-m2";
/** v1 §13.3 with §5.2's dead rule: without a session for 45 s, "connecting…" turns "offline · as of <time>". */
export const OFFLINE_AFTER_MS = 45_000;
/** §6.2 / M4-17: try direct first; if no welcome within 2 s (or it fails), fall back to the relay. */
export const DIRECT_TIMEOUT_MS = 2_000;
/** §6.2 / M4-17: while on the relay, re-probe direct every 60 s. */
export const REPROBE_INTERVAL_MS = 60_000;
/** D73 / §13.3: shown when the server tells this device bye{revoked}. */
export const REVOKED_BANNER = "This device was removed. Pair it again.";
export const UNSETTLED_STOPPED_TEXT = "The server could not take this command.";
export const UNSETTLED_LEGACY_WARNING = "A legacy command may already have run.";

export interface Diagnostics {
  /** `performance.now()` of every live frame the link handed up. */
  live: number[];
  /** Each outbox item's delivery states in order, by slot key. */
  states: Record<string, string[]>;
  /** M3 step 11: each item's owner words in order ("held at <S>", "waiting for <P>", "delivered", "lost: <P>"), by slot key. */
  words: Record<string, string[]>;
  /** M3 step 11: every server's state changes as the page heard them ("<name> <state>"), and the banner texts shown. */
  servers: string[];
  banners: string[];
  /** Connection states in order. */
  conn: string[];
  /** Session frames received. */
  frames: number;
  /** Session ends (reason: detail). */
  ends: string[];
  /** A line's media as the shell answered the chat frame, by key (step 9). */
  media: MediaDiagnostics;
  /** The player's rate, choice and switches, and the content cache's hits and clears (step 11). */
  player: PlayerDiagnostics;
  /** The page's uploads by key (step 12): state, bytes sent, puts and resume points. */
  uploads: Record<string, unknown>;
  /** The content bridge on the relay path (step 14): the worker's state and scope, and each read it asked for. */
  bridge: BridgeDiagnostics;
  /** The player over the page (step 14): first frame, seeks, switches. */
  video: VideoDiagnostics;
  /** M4-25 Web Push opt-in state (never holds endpoint or key bytes). */
  push: { state: "idle" | "subscribing" | "subscribed" | "error"; sends: number; error?: string };
}

export function newDiagnostics(): Diagnostics { return { live: [], states: {}, words: {}, servers: [], banners: [], conn: [], frames: 0, ends: [], media: {}, player: newPlayerDiagnostics("tailnet"), uploads: {}, bridge: newBridgeDiagnostics(), video: newVideoDiagnostics(), push: { state: "idle", sends: 0 } }; }

export interface Connection {
  link: FeLink;
  port: LinkPort;
  readonly path: DialPath;
  readonly revoked: boolean;
  /** Currently targeted (or attached) server id (D72). */
  readonly serverId?: string;
  /** D72: manually switch immediately to `serverId` (ignores 5-min anti-flap holdoff) and persist preference. */
  pickServer?(serverId: string): boolean;
  close(): Promise<void>;
}

/** How the page reaches its server: its own origin's `/v3/ws`, or the server's room on the relay (M2 step 13). */
export type DialPath = "direct" | "relay";

/** The path the page was asked for (`?via=relay` / `?via=tailnet` in its address), or null. */
export function askedPath(search: string): "relay" | "tailnet" | null {
  const via = new URLSearchParams(search).get("via");
  return via === "relay" || via === "tailnet" ? via : null;
}

/**
 * Whether pairing runs through the offer's relay room: when `?via=relay` asks for it, or when this page was loaded from
 * that relay (its root sends phones to `/v3/`; a Home Screen app opens `/v3/` with no `?via`), where there is no
 * `/v3/ws` to dial. `?via=tailnet` keeps it direct. Never without a relay in the offer.
 */
export function pairsThroughRelay(asked: "relay" | "tailnet" | null, relay: { url: string } | undefined, pageOrigin: string): boolean {
  if (!relay || asked === "tailnet") return false;
  if (asked === "relay") return true;
  try { return relayPageOrigin(relay.url) === pageOrigin; } catch { return false; }
}

export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface ServerDialTarget {
  id: string;
  name: string;
  state?: ServerState;
  dh?: string;
  addresses?: ServerAddresses;
  directDial?: Dial;
  relayDial?: Dial;
}

export interface FallbackLinkOptions {
  storage: FeStorage;
  directDial?: Dial;
  relayDial?: Dial;
  /** Multi-server D72 mode: candidate servers in roster order (overrides single `directDial`/`relayDial`). */
  servers?: ServerDialTarget[];
  designatedServerId?: string;
  lastGoodServerId?: string | null;
  resolveServerDial?: (server: ServerDialTarget) => { directDial?: Dial; relayDial?: Dial } | null;
  switchAfterMs?: number;
  antiFlapMs?: number;
  /** Forces one path (`?via=relay` or `?via=tailnet`); undefined = direct with 2 s relay fallback and 60 s re-probe. */
  forcedPath?: DialPath;
  deviceId: string;
  feVersion: string;
  local?: boolean;
  clock?: Clock;
  newEpoch?: () => OriginEpoch;
  offlineAfterMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  directTimeoutMs?: number;
  reprobeIntervalMs?: number;
  absentTableMs?: number;
  visibility?: VisibilitySource;
  onPath?: (path: DialPath) => void;
  onProbe?: (result: "welcomed" | "failed" | "timeout") => void;
  onServer?: (serverId: string) => void;
  onLastGoodServer?: (serverId: string) => void;
  onSwitch?: (event: { from: string; to: string; reason: "auto" | "manual" }) => void;
  onRevoked?: () => void;
}

export interface FallbackLink {
  readonly link: FeLink;
  readonly path: DialPath;
  readonly revoked: boolean;
  readonly serverId: string | null;
  pickServer(serverId: string): boolean;
  start(): void;
  close(): Promise<void>;
}
