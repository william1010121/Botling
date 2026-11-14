// The shell's outbox wiring: the front-end link (src/fe-link) over IndexedDB (`botling3-fe`, D45) and an encrypted
// WebSocket to this page's own server (`/v3/ws`), with the connection words the shell shows (protocol v1 §13.3) and a
// small diagnostics record the headless harness reads (live frame times, every delivery state an item went through).
import { DEFAULT_IDB_NAME, FeLink, IdbFeStorage, systemClock, wsDial, wsUrlFor, type ConnModel, type PendingView } from "../../src/fe-link";
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

export function newDiagnostics(): Diagnostics { return { live: [], states: {}, conn: [], frames: 0, ends: [], media: {}, player: newPlayerDiagnostics("tailnet"), uploads: {} }; }

export interface Connection {
  link: FeLink;
  port: LinkPort;
  close(): Promise<void>;
}

/** Opens the link for a paired device (not started: the renderer mounts first, then `link.start()`). */
export async function openConnection(device: DeviceRecord, diag: Diagnostics, pageUrl: string): Promise<Connection> {
  const storage = await IdbFeStorage.open({ name: DEFAULT_IDB_NAME });
  const dial = wsDial({
    url: () => wsUrlFor(pageUrl),
    identity: { cluster: device.cluster, memberId: device.memberId, dh: { privateKey: device.dhKey, publicKey: device.dhPub }, server: { memberId: device.server.memberId, dhPub: device.server.dhPub } },
    onEnd: (end) => { diag.ends.push(`${end.reason}: ${end.detail}`.slice(0, 200)); if (diag.ends.length > 200) diag.ends.shift(); },
    onFrame: () => { diag.frames += 1; },
    network: { online: () => navigator.onLine !== false, events: window },
  });
  const link = await FeLink.open({ storage, dial, deviceId: device.memberId, feVersion: FE_VERSION, local: false, clock: systemClock, offlineAfterMs: OFFLINE_AFTER_MS });
  link.on((event) => {
    if (event.type === "live" && !event.stale && event.view) diag.live.push(performance.now());
    if (event.type === "state") { const last = diag.conn[diag.conn.length - 1]; if (last !== event.status.state) diag.conn.push(event.status.state); }
    if (event.type === "pending" || event.type === "outcome") recordStates(diag, link.pending());
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
  }
}

const hhmm = (ms: number) => {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

/** The banner's words for a connection state (v1 §13.3), or null while live with nothing waiting. */
export function bannerText(status: ConnModel, pending: PendingView[]): string | null {
  const waiting = pending.filter((item) => !item.lost && (item.state === "waiting" || item.state === "held")).length;
  const tail = waiting ? ` · ${waiting} waiting` : "";
  switch (status.state) {
    case "live": return null;
    case "connecting": return `connecting…${tail}`;
    case "offline": return `offline · as of ${hhmm(status.asOf ?? status.since)}${tail}`;
    case "catching up": return `catching up${tail}`;
    case "history restored": return `this machine's history was restored${status.restoredTo != null ? ` to ${new Date(status.restoredTo).toLocaleString()}` : ""}`;
    case "update required": return `update required${status.minFeVersion ? ` (${status.minFeVersion})` : ""}${tail}`;
    default: return `${status.state}${tail}`;
  }
}
