// The shell's outbox wiring: the front-end link (src/fe-link) over IndexedDB (`botling3-fe`, D45) and an encrypted
// WebSocket to this page's own server (`/v3/ws`), with the connection words the shell shows (protocol v1 §13.3) and a
// small diagnostics record the headless harness reads (live frame times, every delivery state an item went through).
import { DEFAULT_IDB_NAME, FeLink, IdbFeStorage, relaySocketImpl, systemClock, wsDial, wsUrlFor, type ConnModel, type PendingView, type ServerView } from "../../src/fe-link";
import { relayDeviceToken } from "../../src/session";
import type { LinkPort } from "../../src/main-v3/renderer-adapter";
import type { DeviceRecord } from "./device-store";
import { newPlayerDiagnostics, type MediaDiagnostics, type PlayerDiagnostics } from "./media";

export const FE_VERSION = "3.0.0-m2";
/** v1 §13.3 with §5.2's dead rule: without a session for 45 s, "connecting…" turns "offline · as of <time>". */
export const OFFLINE_AFTER_MS = 45_000;

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
}

export function newDiagnostics(): Diagnostics { return { live: [], states: {}, words: {}, servers: [], banners: [], conn: [], frames: 0, ends: [], media: {}, player: newPlayerDiagnostics("tailnet"), uploads: {} }; }

export interface Connection {
  link: FeLink;
  port: LinkPort;
  close(): Promise<void>;
}

/** How the page reaches its server: its own origin's `/v3/ws`, or the server's room on the relay (M2 step 13). */
export type DialPath = "direct" | "relay";

/** The path the page was asked for (`?via=relay` / `?via=tailnet` in its address), or null. */
export function askedPath(search: string): "relay" | "tailnet" | null {
  const via = new URLSearchParams(search).get("via");
  return via === "relay" || via === "tailnet" ? via : null;
}

/** Opens the link for a paired device (not started: the renderer mounts first, then `link.start()`). */
export async function openConnection(device: DeviceRecord, diag: Diagnostics, pageUrl: string, path: DialPath = "direct"): Promise<Connection> {
  const storage = await IdbFeStorage.open({ name: DEFAULT_IDB_NAME });
  const relay = path === "relay" ? device.relay : undefined;
  // The relay join token: from the static DH with the server's roster key (src/session/relay-wire.ts), computed once.
  let token: Promise<string> | null = null;
  const dial = wsDial({
    url: () => wsUrlFor(pageUrl),
    ...(relay ? {
      transport: "relay" as const,
      WebSocketImpl: relaySocketImpl(() => ({ url: relay.url, room: relay.room, token: (token ??= relayDeviceToken(device.memberId, device.dhKey, device.server.dhPub)) })),
    } : {}),
    identity: { cluster: device.cluster, memberId: device.memberId, dh: { privateKey: device.dhKey, publicKey: device.dhPub }, server: { memberId: device.server.memberId, dhPub: device.server.dhPub } },
    onEnd: (end) => { diag.ends.push(`${end.reason}: ${end.detail}`.slice(0, 200)); if (diag.ends.length > 200) diag.ends.shift(); },
    onFrame: () => { diag.frames += 1; },
    network: { online: () => navigator.onLine !== false, events: window },
  });
  const link = await FeLink.open({ storage, dial, deviceId: device.memberId, feVersion: FE_VERSION, local: false, clock: systemClock, offlineAfterMs: OFFLINE_AFTER_MS });
  link.on((event) => {
    if (event.type === "live" && !event.stale && event.view) diag.live.push(performance.now());
    if (event.type === "state") { const last = diag.conn[diag.conn.length - 1]; if (last !== event.status.state) diag.conn.push(event.status.state); }
    if (event.type === "pending" || event.type === "outcome" || event.type === "servers") recordStates(diag, link.pending());
    if (event.type === "servers") recordServers(diag, link.servers());
  });
  return {
    link,
    port: link as unknown as LinkPort,
    async close() { await link.close(); },
  };
}

function recordStates(diag: Diagnostics, items: PendingView[]): void {
  for (const item of items) {
    const label = item.lost ? "lost" : item.state;
    const seen = (diag.states[item.key] ??= []);
    if (seen[seen.length - 1] !== label) seen.push(label);
    const word = itemWords(item);
    const words = (diag.words[item.key] ??= []);
    if (words[words.length - 1] !== word) words.push(word);
  }
}

/** An item's delivery words (v1 §11.6): waiting, held at <S>, waiting for <machine>, delivered, not sent, lost. */
export function itemWords(item: PendingView): string {
  if (item.lost) return `delivered, then lost when ${item.ownerName ?? "its machine"} was restored`;
  if (item.state === "delivered") return "delivered";
  if (item.state === "not sent") return `not sent: ${item.reasonText ?? item.reason ?? "refused"}`;
  if (item.waitingFor) return `waiting for ${item.waitingFor}${item.state === "held" ? ` (held at ${item.heldAtName ?? item.heldAt ?? "?"})` : ""}`;
  if (item.state === "held") return `held at ${item.heldAtName ?? item.heldAt ?? "?"}`;
  return "waiting";
}

function recordServers(diag: Diagnostics, servers: ServerView[]): void {
  for (const server of servers) {
    const line = `${server.name} ${server.state}`;
    const last = [...diag.servers].reverse().find((seen) => seen.startsWith(`${server.name} `));
    if (last !== line) diag.servers.push(line);
  }
  if (diag.servers.length > 200) diag.servers.splice(0, diag.servers.length - 200);
}

const hhmm = (ms: number) => {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** The banner's words for a connection state (v1 §13.3), or null while live with nothing waiting. */
export function bannerText(status: ConnModel, pending: PendingView[], servers: ServerView[] = []): string | null {
  const waiting = pending.filter((item) => !item.lost && (item.state === "waiting" || item.state === "held")).length;
  const tail = waiting ? ` · ${waiting} waiting` : "";
  switch (status.state) {
    case "live": return peerBanner(pending, servers);
    case "connecting": return `connecting…${tail}`;
    case "offline": return `offline · as of ${hhmm(status.asOf ?? status.since)}${tail}`;
    case "catching up": return `catching up${tail}`;
    case "history restored": return `this machine's history was restored${status.restoredTo != null ? ` to ${new Date(status.restoredTo).toLocaleString()}` : ""}`;
    case "update required": return `update required${status.minFeVersion ? ` (${status.minFeVersion})` : ""}${tail}`;
    default: return `${status.state}${tail}`;
  }
}

/**
 * While attached and live, the words for the other machines that are not live (v1 §13.3 "one machine stale"):
 * "<machine> offline · as of <time>", and how many messages wait for it (held at the attached server). Null when every
 * machine is live.
 */
export function peerBanner(pending: PendingView[], servers: ServerView[]): string | null {
  const parts: string[] = [];
  for (const server of servers) {
    if (server.self || server.state === "live") continue;
    const waiting = pending.filter((item) => !item.lost && item.waitingFor === server.name && (item.state === "waiting" || item.state === "held"));
    const held = waiting.filter((item) => item.state === "held");
    const head = server.state === "gone" ? `${server.name} removed · read-only` : `${server.name} offline${server.since !== null ? ` · as of ${hhmm(server.since)}` : ""}`;
    parts.push(`${head}${waiting.length ? ` · ${waiting.length} waiting for ${server.name}${held.length ? `, held at ${held[0].heldAtName ?? held[0].heldAt}` : ""}` : ""}`);
  }
  return parts.length ? parts.join(" · ") : null;
}
