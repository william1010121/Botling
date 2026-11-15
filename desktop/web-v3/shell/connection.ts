// The shell's outbox wiring: the front-end link (src/fe-link) over IndexedDB (`botling3-fe`, D45) and an encrypted
// WebSocket to the attached server (`/v3/ws`, or its relay room with §6.2 fallback and 60 s direct re-probing, plus
// §13.1 / D72 server choice and 30 s / 5-minute automatic & manual switching), with the connection words the shell shows
// (protocol v1 §13.3) and a small diagnostics record the headless harness reads.
import {
  DEFAULT_IDB_NAME, IdbFeStorage, relaySocketImpl, systemClock, wsDial, wsUrlFor,
  type ConnModel, type Dial, type PendingView, type ServerView, type SocketHandlers,
} from "../../src/fe-link";
import { fromBase64Url, toBase64Url } from "../../src/protocol";
import { relayDeviceToken } from "../../src/session";
import type { LinkPort } from "../../src/main-v3/renderer-adapter";
import type { DeviceRecord } from "./device-store";
import {
  FE_VERSION, OFFLINE_AFTER_MS, REVOKED_BANNER, UNSETTLED_STOPPED_TEXT,
  type Connection, type Diagnostics, type DialPath, type ServerDialTarget,
} from "./connection-types";
import { openFallbackLink, type OpenConnectionOptions } from "./fallback-link";

// The old home of these names: connection.ts keeps exporting every one of them.
export {
  FE_VERSION, OFFLINE_AFTER_MS, DIRECT_TIMEOUT_MS, REPROBE_INTERVAL_MS, REVOKED_BANNER, UNSETTLED_STOPPED_TEXT, UNSETTLED_LEGACY_WARNING,
  newDiagnostics, askedPath, pairsThroughRelay,
} from "./connection-types";
export type { Diagnostics, Connection, DialPath, VisibilitySource, ServerDialTarget, FallbackLinkOptions, FallbackLink } from "./connection-types";
export { openFallbackLink } from "./fallback-link";
export type { OpenConnectionOptions } from "./fallback-link";

function isLoopbackPage(pageUrl: string): boolean {
  try {
    const { hostname } = new URL(pageUrl);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** Opens the link for a paired device (not started: the renderer mounts first, then `link.start()`). */
export async function openConnection(device: DeviceRecord, diag: Diagnostics, pageUrl: string, pathOrOptions?: DialPath | OpenConnectionOptions): Promise<Connection> {
  const opts: OpenConnectionOptions = typeof pathOrOptions === "string" ? { forcedPath: pathOrOptions } : (pathOrOptions ?? {});
  const storage = await IdbFeStorage.open({ name: DEFAULT_IDB_NAME });
  const { loadPref, savePref } = await import("./device-store");
  const savedServerId = await loadPref("server").catch(() => null);
  const onEnd = (end: { reason: string; detail: string }) => {
    diag.ends.push(`${end.reason}: ${end.detail}`.slice(0, 200));
    if (diag.ends.length > 200) diag.ends.shift();
  };
  const onFrame = () => { diag.frames += 1; };
  const network = { online: () => navigator.onLine !== false, events: window };

  const initialServers: ServerDialTarget[] = (device.servers?.length ? device.servers : []).map((s) => ({
    id: s.id,
    name: s.name,
    ...(s.state !== undefined ? { state: s.state } : {}),
    ...(s.dh ? { dh: s.dh } : {}),
    ...(s.addresses ? { addresses: s.addresses } : {}),
  }));
  if (!initialServers.some((s) => s.id === device.server.memberId)) {
    initialServers.unshift({
      id: device.server.memberId,
      name: device.server.name,
      dh: toBase64Url(device.server.dhPub),
      ...(device.relay ? { addresses: { relay: device.relay } } : {}),
    });
  }

  const dialCache = new Map<string, { directDial?: Dial; relayDial?: Dial }>();
  const resolveServerDial = (server: ServerDialTarget): { directDial?: Dial; relayDial?: Dial } | null => {
    if (server.state === "gone") return null;
    const isPairedServer = server.id === device.server.memberId;
    const dhB64 = server.dh ?? (isPairedServer ? toBase64Url(device.server.dhPub) : undefined);
    if (!dhB64) return null;
    const directUrl = isPairedServer && isLoopbackPage(pageUrl)
      ? wsUrlFor(pageUrl)
      : (server.addresses?.tailnet ?? (isPairedServer ? wsUrlFor(pageUrl) : undefined));
    const relay = server.addresses?.relay ?? (isPairedServer ? device.relay : undefined);
    if (!directUrl && !relay) return null;

    const cacheKey = `${server.id}\u0000${dhB64}\u0000${directUrl ?? ""}\u0000${relay?.url ?? ""}\u0000${relay?.room ?? ""}`;
    const cached = dialCache.get(cacheKey);
    if (cached) return cached;

    const dhPub = isPairedServer && !server.dh ? device.server.dhPub : fromBase64Url(dhB64);
    if (!dhPub) return null;
    const identity = {
      cluster: device.cluster,
      memberId: device.memberId,
      dh: { privateKey: device.dhKey, publicKey: device.dhPub },
      server: { memberId: server.id, dhPub },
    };
    const directDial = directUrl ? wsDial({ url: () => directUrl, identity, onEnd, onFrame, network }) : undefined;

    // The relay join token: from the static DH with this server's roster key, computed once per server/key.
    let token: Promise<string> | null = null;
    const relayDial = relay ? wsDial({
      url: () => directUrl ?? wsUrlFor(pageUrl),
      transport: "relay",
      WebSocketImpl: relaySocketImpl(() => ({
        url: relay.url,
        room: relay.room,
        token: (token ??= relayDeviceToken(device.memberId, device.dhKey, dhPub)),
      })),
      identity,
      onEnd,
      onFrame,
      network,
    }) : undefined;

    const entry = { ...(directDial ? { directDial } : {}), ...(relayDial ? { relayDial } : {}) };
    dialCache.set(cacheKey, entry);
    return entry;
  };

  const fb = await openFallbackLink({
    storage,
    servers: initialServers,
    designatedServerId: device.server.memberId,
    lastGoodServerId: savedServerId,
    resolveServerDial,
    ...(opts.forcedPath ? { forcedPath: opts.forcedPath } : {}),
    deviceId: device.memberId,
    feVersion: FE_VERSION,
    local: false,
    clock: systemClock,
    offlineAfterMs: OFFLINE_AFTER_MS,
    ...(opts.directTimeoutMs !== undefined ? { directTimeoutMs: opts.directTimeoutMs } : {}),
    ...(opts.reprobeIntervalMs !== undefined ? { reprobeIntervalMs: opts.reprobeIntervalMs } : {}),
    ...(opts.switchAfterMs !== undefined ? { switchAfterMs: opts.switchAfterMs } : {}),
    ...(opts.antiFlapMs !== undefined ? { antiFlapMs: opts.antiFlapMs } : {}),
    ...(typeof document !== "undefined" ? { visibility: document } : {}),
    onPath: opts.onPath,
    onServer: opts.onServer,
    onLastGoodServer: (id) => { void savePref("server", id).catch(() => undefined); },
    onRevoked: () => {
      revoked = true;
      if (diag.conn[diag.conn.length - 1] !== "needs pairing") diag.conn.push("needs pairing");
      opts.onRevoked?.();
    },
  });

  const { link } = fb;
  let revoked = fb.revoked;
  link.on((event) => {
    if (event.type === "bye" && event.reason === "revoked") {
      revoked = true;
      if (diag.conn[diag.conn.length - 1] !== "needs pairing") diag.conn.push("needs pairing");
    }
    if (event.type === "live" && !event.stale && event.view) diag.live.push(performance.now());
    if (event.type === "state" && !revoked) { const last = diag.conn[diag.conn.length - 1]; if (last !== event.status.state) diag.conn.push(event.status.state); }
    if (event.type === "pending" || event.type === "outcome" || event.type === "servers") recordStates(diag, link.pending());
    if (event.type === "servers") recordServers(diag, link.servers());
  });
  return {
    link,
    port: link as unknown as LinkPort,
    get path() { return fb.path; },
    get revoked() { return fb.revoked; },
    get serverId() { return fb.serverId ?? device.server.memberId; },
    pickServer(serverId: string) { return fb.pickServer(serverId); },
    async close() { await fb.close(); },
  };
}

function recordStates(diag: Diagnostics, items: PendingView[]): void {
  for (const item of items) {
    const label = item.lost ? "lost" : item.stopped ? "stopped" : item.state;
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
  if (item.stopped) return UNSETTLED_STOPPED_TEXT;
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
export function bannerText(status: ConnModel, pending: PendingView[], servers: ServerView[] = [], revoked = false): string | null {
  if (revoked || status.state === "needs pairing") return REVOKED_BANNER;
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
