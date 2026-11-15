// The shell's outbox wiring: the front-end link (src/fe-link) over IndexedDB (`botling3-fe`, D45) and an encrypted
// WebSocket to this page's own server (`/v3/ws`, or its relay room with §6.2 fallback and 60 s direct re-probing),
// with the connection words the shell shows (protocol v1 §13.3) and a small diagnostics record the headless harness
// reads (live frame times, every delivery state an item went through).
import {
  DEFAULT_IDB_NAME, FeLink, IdbFeStorage, relaySocketImpl, systemClock, wsDial, wsUrlFor,
  type Clock, type ConnModel, type Dial, type FeSocket, type FeStorage, type PendingView, type ServerView, type SocketHandlers,
} from "../../src/fe-link";
import { encodeFrame, PROTOCOL_VERSION, type OriginEpoch } from "../../src/protocol";
import { relayDeviceToken } from "../../src/session";
import type { LinkPort } from "../../src/main-v3/renderer-adapter";
import type { DeviceRecord } from "./device-store";
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
}

export function newDiagnostics(): Diagnostics { return { live: [], states: {}, words: {}, servers: [], banners: [], conn: [], frames: 0, ends: [], media: {}, player: newPlayerDiagnostics("tailnet"), uploads: {}, bridge: newBridgeDiagnostics(), video: newVideoDiagnostics() }; }

export interface Connection {
  link: FeLink;
  port: LinkPort;
  readonly path: DialPath;
  close(): Promise<void>;
}

/** How the page reaches its server: its own origin's `/v3/ws`, or the server's room on the relay (M2 step 13). */
export type DialPath = "direct" | "relay";

/** The path the page was asked for (`?via=relay` / `?via=tailnet` in its address), or null. */
export function askedPath(search: string): "relay" | "tailnet" | null {
  const via = new URLSearchParams(search).get("via");
  return via === "relay" || via === "tailnet" ? via : null;
}

export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface FallbackLinkOptions {
  storage: FeStorage;
  directDial: Dial;
  relayDial?: Dial;
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
  visibility?: VisibilitySource;
  onPath?: (path: DialPath) => void;
  onProbe?: (result: "welcomed" | "failed" | "timeout") => void;
}

export interface FallbackLink {
  readonly link: FeLink;
  readonly path: DialPath;
  start(): void;
  close(): Promise<void>;
}

function isWelcomeFrame(frame: string | Uint8Array): boolean {
  if (typeof frame !== "string" || !frame.includes('"welcome"')) return false;
  try {
    return (JSON.parse(frame) as { t?: unknown }).t === "welcome";
  } catch {
    return false;
  }
}

/**
 * Pure/isomorphic §6.2 path controller around `FeLink`: tries direct first; if no welcome comes within 2 s (or it
 * fails), falls back to the relay; while on the relay, re-probes direct every 60 s and closes the old session before
 * dialing direct when direct welcomes. Stops timers when the page hides or closes.
 */
export async function openFallbackLink(options: FallbackLinkOptions): Promise<FallbackLink> {
  const clock = options.clock ?? systemClock;
  const directTimeoutMs = options.directTimeoutMs ?? DIRECT_TIMEOUT_MS;
  const reprobeMs = options.reprobeIntervalMs ?? REPROBE_INTERVAL_MS;
  const forced = options.forcedPath;
  const relayDial = forced === "direct" ? undefined : options.relayDial;
  const isLocal = options.local ?? false;

  let currentPath: DialPath = forced === "relay" && relayDial ? "relay" : "direct";
  let stopped = false;
  let attachedOnRelay = false;
  let probeTimer: unknown = undefined;
  let activeProbe: { cancel(): void } | null = null;
  let lastProbeAt = 0;
  let link!: FeLink;

  const setPath = (next: DialPath) => {
    if (currentPath === next) return;
    currentPath = next;
    options.onPath?.(next);
  };

  const clearProbeTimer = () => {
    if (probeTimer !== undefined) { clock.clearTimeout(probeTimer); probeTimer = undefined; }
  };

  const cancelProbe = () => {
    clearProbeTimer();
    activeProbe?.cancel();
    activeProbe = null;
  };

  const isHidden = () => options.visibility?.hidden === true;

  const scheduleProbe = () => {
    clearProbeTimer();
    if (stopped || forced === "relay" || !relayDial || !attachedOnRelay || currentPath !== "relay" || isHidden()) return;
    probeTimer = clock.setTimeout(() => {
      probeTimer = undefined;
      runProbe();
    }, reprobeMs);
  };

  const runProbe = () => {
    if (stopped || forced === "relay" || !relayDial || !attachedOnRelay || currentPath !== "relay" || isHidden() || activeProbe) return;
    lastProbeAt = clock.now();
    let cancelled = false;
    let welcomed = false;
    let openedEarly = false;
    let socket: FeSocket | null = null;
    let timer: unknown = undefined;

    const cleanup = () => {
      if (timer !== undefined) { clock.clearTimeout(timer); timer = undefined; }
      if (activeProbe === probe) activeProbe = null;
    };
    const failProbe = (why: "failed" | "timeout") => {
      if (cancelled || welcomed) return;
      cancelled = true;
      cleanup();
      try { socket?.close(); } catch { /* already gone */ }
      options.onProbe?.(why);
      scheduleProbe();
    };
    const sendProbeHello = () => {
      if (cancelled || !socket) return;
      const hello = encodeFrame({
        t: "hello", deviceId: options.deviceId, feVersion: options.feVersion,
        protocol: PROTOCOL_VERSION, originEpoch: link.epoch, cursors: {}, outbox: [], want: [],
      }, "fe", { local: isLocal });
      if (!hello.ok) { failProbe("failed"); return; }
      try { socket.send(hello.text); } catch { failProbe("failed"); }
    };
    const probe = {
      cancel() {
        if (cancelled) return;
        cancelled = true;
        cleanup();
        try { socket?.close(); } catch { /* already gone */ }
      },
    };
    activeProbe = probe;
    timer = clock.setTimeout(() => failProbe("timeout"), directTimeoutMs);

    try {
      socket = options.directDial({
        open() {
          if (cancelled) { try { socket?.close(); } catch { /* ignore */ } return; }
          if (!socket) { openedEarly = true; return; }
          sendProbeHello();
        },
        frame(frame) {
          if (cancelled || welcomed) return;
          if (isWelcomeFrame(frame)) {
            welcomed = true;
            cleanup();
            const bye = encodeFrame({ t: "bye", reason: "closing" }, "fe", { local: isLocal });
            if (bye.ok) { try { socket?.send(bye.text); } catch { /* ignore */ } }
            try { socket?.close(); } catch { /* ignore */ }
            options.onProbe?.("welcomed");
            // D18: close the relay session first (inside replaceSocket) before dialing direct fresh.
            attachedOnRelay = false;
            link.replaceSocket();
          }
        },
        close() { failProbe("failed"); },
      });
      if (cancelled) { try { socket.close(); } catch { /* ignore */ } }
      else if (openedEarly) sendProbeHello();
    } catch {
      failProbe("failed");
    }
  };

  const onVisibility = () => {
    if (stopped) return;
    if (isHidden()) {
      cancelProbe();
    } else if (attachedOnRelay && currentPath === "relay" && forced !== "relay") {
      if (lastProbeAt > 0 && clock.now() - lastProbeAt >= reprobeMs) runProbe();
      else scheduleProbe();
    }
  };
  options.visibility?.addEventListener("visibilitychange", onVisibility);

  const dial: Dial = (handlers) => {
    cancelProbe();
    attachedOnRelay = false;

    if (forced === "relay" && relayDial) {
      setPath("relay");
      return relayDial(handlers);
    }

    if (!relayDial) {
      setPath("direct");
      return options.directDial(handlers);
    }

    let cancelled = false;
    let phase: DialPath = "direct";
    let welcomed = false;
    let helloSent = false;
    let lastHello: string | null = null;
    let directTimer: unknown = undefined;
    let directSocket: FeSocket | null = null;
    let relaySocket: FeSocket | null = null;

    const clearDirectTimer = () => {
      if (directTimer !== undefined) { clock.clearTimeout(directTimer); directTimer = undefined; }
    };

    const startRelay = () => {
      if (cancelled || phase === "relay") return;
      phase = "relay";
      clearDirectTimer();
      try { directSocket?.close(); } catch { /* ignore */ }
      directSocket = null;
      setPath("relay");
      let relayOpenedEarly = false;
      const onRelayOpen = () => {
        if (cancelled || phase !== "relay") return;
        if (helloSent && lastHello !== null) {
          // FeLink already sent `hello` on this Session when direct opened; replay it onto the relay socket.
          try { relaySocket?.send(lastHello); } catch { /* ignore */ }
        } else {
          handlers.open();
        }
      };
      try {
        const sock = relayDial({
          open() {
            if (!relaySocket) { relayOpenedEarly = true; return; }
            onRelayOpen();
          },
          frame(f) {
            if (cancelled || phase !== "relay") return;
            if (!welcomed && isWelcomeFrame(f)) {
              welcomed = true;
              attachedOnRelay = true;
              scheduleProbe();
            }
            handlers.frame(f);
          },
          close(detail) {
            if (cancelled || phase !== "relay") return;
            attachedOnRelay = false;
            cancelProbe();
            handlers.close(detail);
          },
        });
        if (cancelled || phase !== "relay") { try { sock.close(); } catch { /* ignore */ } return; }
        relaySocket = sock;
        if (relayOpenedEarly) onRelayOpen();
      } catch (error) {
        if (!cancelled && phase === "relay") {
          attachedOnRelay = false;
          cancelProbe();
          handlers.close(String(error));
        }
      }
    };

    setPath("direct");
    directTimer = clock.setTimeout(() => {
      if (cancelled || welcomed || phase !== "direct") return;
      startRelay();
    }, directTimeoutMs);

    let directOpenedEarly = false;
    const onDirectOpen = () => {
      if (cancelled || phase !== "direct") return;
      handlers.open();
    };

    try {
      const sock = options.directDial({
        open() {
          if (!directSocket) { directOpenedEarly = true; return; }
          onDirectOpen();
        },
        frame(f) {
          if (cancelled || phase !== "direct") return;
          if (!welcomed && isWelcomeFrame(f)) {
            welcomed = true;
            clearDirectTimer();
          }
          handlers.frame(f);
        },
        close(detail) {
          if (cancelled || phase !== "direct") return;
          clearDirectTimer();
          if (welcomed) handlers.close(detail);
          else startRelay();
        },
      });
      if (cancelled || phase !== "direct") {
        try { sock.close(); } catch { /* ignore */ }
      } else {
        directSocket = sock;
        if (directOpenedEarly) onDirectOpen();
      }
    } catch {
      if (!cancelled && phase === "direct") startRelay();
    }

    return {
      send(frame) {
        if (cancelled) return;
        if (!welcomed && phase === "direct") { helloSent = true; lastHello = frame; }
        (phase === "relay" ? relaySocket : directSocket)?.send(frame);
      },
      sendBytes(frame) {
        if (cancelled) return;
        (phase === "relay" ? relaySocket : directSocket)?.sendBytes?.(frame);
      },
      close() {
        if (cancelled) return;
        cancelled = true;
        attachedOnRelay = false;
        clearDirectTimer();
        cancelProbe();
        try { directSocket?.close(); } catch { /* ignore */ }
        try { relaySocket?.close(); } catch { /* ignore */ }
      },
    };
  };

  link = await FeLink.open({
    storage: options.storage,
    dial,
    deviceId: options.deviceId,
    feVersion: options.feVersion,
    local: isLocal,
    clock,
    ...(options.newEpoch ? { newEpoch: options.newEpoch } : {}),
    ...(options.offlineAfterMs !== undefined ? { offlineAfterMs: options.offlineAfterMs } : {}),
    ...(options.reconnectMinMs !== undefined ? { reconnectMinMs: options.reconnectMinMs } : {}),
    ...(options.reconnectMaxMs !== undefined ? { reconnectMaxMs: options.reconnectMaxMs } : {}),
  });

  return {
    link,
    get path() { return currentPath; },
    start() { link.start(); },
    async close() {
      stopped = true;
      attachedOnRelay = false;
      cancelProbe();
      options.visibility?.removeEventListener("visibilitychange", onVisibility);
      await link.close();
    },
  };
}

export interface OpenConnectionOptions {
  forcedPath?: DialPath;
  onPath?: (path: DialPath) => void;
  directTimeoutMs?: number;
  reprobeIntervalMs?: number;
}

/** Opens the link for a paired device (not started: the renderer mounts first, then `link.start()`). */
export async function openConnection(device: DeviceRecord, diag: Diagnostics, pageUrl: string, pathOrOptions?: DialPath | OpenConnectionOptions): Promise<Connection> {
  const opts: OpenConnectionOptions = typeof pathOrOptions === "string" ? { forcedPath: pathOrOptions } : (pathOrOptions ?? {});
  const storage = await IdbFeStorage.open({ name: DEFAULT_IDB_NAME });
  const identity = {
    cluster: device.cluster,
    memberId: device.memberId,
    dh: { privateKey: device.dhKey, publicKey: device.dhPub },
    server: { memberId: device.server.memberId, dhPub: device.server.dhPub },
  };
  const onEnd = (end: { reason: string; detail: string }) => {
    diag.ends.push(`${end.reason}: ${end.detail}`.slice(0, 200));
    if (diag.ends.length > 200) diag.ends.shift();
  };
  const onFrame = () => { diag.frames += 1; };
  const network = { online: () => navigator.onLine !== false, events: window };
  const directDial = wsDial({ url: () => wsUrlFor(pageUrl), identity, onEnd, onFrame, network });

  // The relay join token: from the static DH with the server's roster key (src/session/relay-wire.ts), computed once.
  let token: Promise<string> | null = null;
  const relay = device.relay;
  const relayDial = relay ? wsDial({
    url: () => wsUrlFor(pageUrl),
    transport: "relay",
    WebSocketImpl: relaySocketImpl(() => ({
      url: relay.url,
      room: relay.room,
      token: (token ??= relayDeviceToken(device.memberId, device.dhKey, device.server.dhPub)),
    })),
    identity,
    onEnd,
    onFrame,
    network,
  }) : undefined;

  const fb = await openFallbackLink({
    storage,
    directDial,
    ...(relayDial ? { relayDial } : {}),
    ...(opts.forcedPath ? { forcedPath: opts.forcedPath } : {}),
    deviceId: device.memberId,
    feVersion: FE_VERSION,
    local: false,
    clock: systemClock,
    offlineAfterMs: OFFLINE_AFTER_MS,
    ...(opts.directTimeoutMs !== undefined ? { directTimeoutMs: opts.directTimeoutMs } : {}),
    ...(opts.reprobeIntervalMs !== undefined ? { reprobeIntervalMs: opts.reprobeIntervalMs } : {}),
    ...(typeof document !== "undefined" ? { visibility: document } : {}),
    onPath: opts.onPath,
  });

  const { link } = fb;
  link.on((event) => {
    if (event.type === "live" && !event.stale && event.view) diag.live.push(performance.now());
    if (event.type === "state") { const last = diag.conn[diag.conn.length - 1]; if (last !== event.status.state) diag.conn.push(event.status.state); }
    if (event.type === "pending" || event.type === "outcome" || event.type === "servers") recordStates(diag, link.pending());
    if (event.type === "servers") recordServers(diag, link.servers());
  });
  return {
    link,
    port: link as unknown as LinkPort,
    get path() { return fb.path; },
    async close() { await fb.close(); },
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
