// The shell's outbox wiring: the front-end link (src/fe-link) over IndexedDB (`botling3-fe`, D45) and an encrypted
// WebSocket to the attached server (`/v3/ws`, or its relay room with §6.2 fallback and 60 s direct re-probing, plus
// §13.1 / D72 server choice and 30 s / 5-minute automatic & manual switching), with the connection words the shell shows
// (protocol v1 §13.3) and a small diagnostics record the headless harness reads.
import {
  DEFAULT_IDB_NAME, FeLink, IdbFeStorage, relaySocketImpl, ServerSwitchController, systemClock, wsDial, wsUrlFor,
  type Clock, type ConnModel, type Dial, type FeSocket, type FeStorage, type PendingView, type ServerCandidate, type ServerView, type SocketHandlers, type SwitchPath,
} from "../../src/fe-link";
import { encodeFrame, fromBase64Url, PROTOCOL_VERSION, toBase64Url, type OriginEpoch, type ServerAddresses, type ServerState } from "../../src/protocol";
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

function isWelcomeFrame(frame: string | Uint8Array): boolean {
  if (typeof frame !== "string" || !frame.includes('"welcome"')) return false;
  try {
    return (JSON.parse(frame) as { t?: unknown }).t === "welcome";
  } catch {
    return false;
  }
}

function isRevokedByeFrame(frame: string | Uint8Array): boolean {
  if (typeof frame !== "string" || !frame.includes('"bye"') || !frame.includes('"revoked"')) return false;
  try {
    const parsed = JSON.parse(frame) as { t?: unknown; reason?: unknown };
    return parsed.t === "bye" && parsed.reason === "revoked";
  } catch {
    return false;
  }
}

/**
 * Pure/isomorphic §6.2 path controller + D72 multi-server switch controller around `FeLink`: tries direct first; if no
 * welcome comes within 2 s (or it fails), falls back to the relay; while on the relay, re-probes direct every 60 s and
 * closes the old session before dialing direct when direct welcomes. In multi-server mode, switches to the next server
 * in §13.1 order after all paths fail for 30 s, enforces a 5-minute anti-flap holdoff, and supports manual `pickServer`.
 */
export async function openFallbackLink(options: FallbackLinkOptions): Promise<FallbackLink> {
  const clock = options.clock ?? systemClock;
  const directTimeoutMs = options.directTimeoutMs ?? DIRECT_TIMEOUT_MS;
  const reprobeMs = options.reprobeIntervalMs ?? REPROBE_INTERVAL_MS;
  const forced = options.forcedPath;
  const isLocal = options.local ?? false;

  const targetsById = new Map<string, ServerDialTarget>();
  for (const s of options.servers ?? []) {
    targetsById.set(
      s.id,
      s.state === "gone"
        ? { id: s.id, name: s.name || s.id, state: "gone", ...(s.dh ? { dh: s.dh } : {}) }
        : { ...s },
    );
  }

  const resolveDialsFor = (target: ServerDialTarget): { directDial?: Dial; relayDial?: Dial } => {
    if (target.state === "gone") return {};
    if (target.directDial || target.relayDial) {
      return {
        ...(target.directDial ? { directDial: target.directDial } : {}),
        ...(target.relayDial && forced !== "direct" ? { relayDial: target.relayDial } : {}),
      };
    }
    const resolved = options.resolveServerDial?.(target);
    return {
      ...(resolved?.directDial ? { directDial: resolved.directDial } : {}),
      ...(resolved?.relayDial && forced !== "direct" ? { relayDial: resolved.relayDial } : {}),
    };
  };

  const toCandidate = (target: ServerDialTarget): ServerCandidate => {
    const dials = resolveDialsFor(target);
    return {
      id: target.id,
      name: target.name,
      ...(target.state !== undefined ? { state: target.state } : {}),
      ...(target.dh ? { dh: target.dh } : {}),
      ...(target.addresses ? { addresses: target.addresses } : {}),
      dialable: !!(dials.directDial || dials.relayDial),
    };
  };

  let switching = false;
  let link!: FeLink;
  let stopped = false;
  let revoked = false;
  let started = false;

  const controller = options.servers?.length
    ? new ServerSwitchController({
      servers: options.servers.map(toCandidate),
      designatedId: options.designatedServerId ?? options.servers[0].id,
      lastGoodId: options.lastGoodServerId ?? null,
      clock,
      ...(options.switchAfterMs !== undefined ? { switchAfterMs: options.switchAfterMs } : {}),
      ...(options.antiFlapMs !== undefined ? { antiFlapMs: options.antiFlapMs } : {}),
      onServer: options.onServer,
      onLastGoodServer: options.onLastGoodServer,
      onSwitch: (ev) => {
        options.onSwitch?.(ev);
        if (!revoked && !stopped) {
          switching = true;
          try { link.replaceSocket(); } finally { switching = false; }
        }
      },
    })
    : null;

  const currentDials = (): { serverId: string | null; directDial?: Dial; relayDial?: Dial } => {
    if (!controller) {
      return {
        serverId: null,
        ...(options.directDial ? { directDial: options.directDial } : {}),
        ...(options.relayDial && forced !== "direct" ? { relayDial: options.relayDial } : {}),
      };
    }
    const id = controller.current();
    const target = targetsById.get(id);
    if (!target) return { serverId: id };
    const dials = resolveDialsFor(target);
    return { serverId: id, ...dials };
  };

  const initial = currentDials();
  let currentPath: DialPath = forced === "relay" && initial.relayDial ? "relay" : (!initial.directDial && initial.relayDial ? "relay" : "direct");
  let attachedOnRelay = false;
  let probeTimer: unknown = undefined;
  let activeProbe: { cancel(): void } | null = null;
  let nextProbeAt: number | null = null;

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

  const markRevoked = () => {
    if (revoked) return;
    revoked = true;
    stopped = true;
    attachedOnRelay = false;
    nextProbeAt = null;
    cancelProbe();
    controller?.stop();
    options.visibility?.removeEventListener("visibilitychange", onVisibility);
  };

  const isHidden = () => options.visibility?.hidden === true;

  const scheduleProbe = (reset = false) => {
    clearProbeTimer();
    const { relayDial, directDial } = currentDials();
    if (stopped || forced === "relay" || !relayDial || !directDial || !attachedOnRelay || currentPath !== "relay") {
      nextProbeAt = null;
      return;
    }
    if (reset || nextProbeAt === null) nextProbeAt = clock.now() + reprobeMs;
    if (isHidden()) return;
    const delay = Math.max(0, nextProbeAt - clock.now());
    probeTimer = clock.setTimeout(() => {
      probeTimer = undefined;
      runProbe();
    }, delay);
  };

  const runProbe = () => {
    const { serverId: probeServerId, directDial, relayDial } = currentDials();
    if (stopped || forced === "relay" || !relayDial || !directDial || !attachedOnRelay || currentPath !== "relay" || isHidden() || activeProbe) return;
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
      scheduleProbe(true);
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
        try { socket?.close(); } catch { /* ignore */ }
      },
    };
    activeProbe = probe;
    timer = clock.setTimeout(() => failProbe("timeout"), directTimeoutMs);

    try {
      socket = directDial({
        open() {
          if (cancelled) { try { socket?.close(); } catch { /* ignore */ } return; }
          if (!socket) { openedEarly = true; return; }
          sendProbeHello();
        },
        frame(frame) {
          if (cancelled || welcomed) return;
          if (isRevokedByeFrame(frame)) {
            cancelled = true;
            cleanup();
            try { socket?.close(); } catch { /* ignore */ }
            markRevoked();
            void link.stop();
            options.onRevoked?.();
            return;
          }
          if (isWelcomeFrame(frame)) {
            welcomed = true;
            cleanup();
            const bye = encodeFrame({ t: "bye", reason: "closing" }, "fe", { local: isLocal });
            if (bye.ok) { try { socket?.send(bye.text); } catch { /* ignore */ } }
            try { socket?.close(); } catch { /* ignore */ }
            if (controller && controller.current() !== probeServerId) return;
            options.onProbe?.("welcomed");
            // D18: close the relay session first (inside replaceSocket) before dialing direct fresh.
            attachedOnRelay = false;
            nextProbeAt = null;
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
      if (nextProbeAt !== null && clock.now() >= nextProbeAt) runProbe();
      else scheduleProbe();
    }
  };
  options.visibility?.addEventListener("visibilitychange", onVisibility);

  const dial: Dial = (handlers) => {
    cancelProbe();
    attachedOnRelay = false;
    nextProbeAt = null;

    if (revoked || stopped) {
      return { send() { /* revoked */ }, close() { /* revoked */ } };
    }

    const { serverId: targetId, directDial, relayDial } = currentDials();
    const availablePaths: SwitchPath[] = forced === "relay" && relayDial
      ? ["relay"]
      : forced === "direct" && directDial
        ? ["direct"]
        : [...(directDial ? ["direct" as const] : []), ...(relayDial ? ["relay" as const] : [])];
    if (controller && targetId) controller.noteDialStart(targetId, availablePaths);

    const forwardFrame = (f: string | Uint8Array) => {
      const hit = isRevokedByeFrame(f);
      if (hit) markRevoked();
      handlers.frame(f);
      if (hit) {
        void link.stop();
        options.onRevoked?.();
      }
    };

    if ((forced === "relay" && relayDial) || (!directDial && relayDial)) {
      setPath("relay");
      if (controller && targetId) controller.notePathAttempt(targetId, "relay", availablePaths);
      let relayWelcomed = false;
      return relayDial({
        ...handlers,
        frame(f) {
          if (!relayWelcomed && isWelcomeFrame(f)) {
            relayWelcomed = true;
            attachedOnRelay = true;
            if (forced !== "relay" && directDial) scheduleProbe(true);
          }
          forwardFrame(f);
        },
        close(detail) {
          attachedOnRelay = false;
          nextProbeAt = null;
          cancelProbe();
          handlers.close(detail);
        },
      });
    }

    if (!directDial) {
      queueMicrotask(() => handlers.close("no dial path"));
      return { send() { /* closed */ }, close() { /* closed */ } };
    }

    if (!relayDial) {
      setPath("direct");
      if (controller && targetId) controller.notePathAttempt(targetId, "direct", availablePaths);
      return directDial({ ...handlers, frame: forwardFrame });
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
      if (controller && targetId) controller.notePathAttempt(targetId, "relay", availablePaths);
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
              scheduleProbe(true);
            }
            forwardFrame(f);
          },
          close(detail) {
            if (cancelled || phase !== "relay") return;
            attachedOnRelay = false;
            nextProbeAt = null;
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
          nextProbeAt = null;
          cancelProbe();
          handlers.close(String(error));
        }
      }
    };

    setPath("direct");
    if (controller && targetId) controller.notePathAttempt(targetId, "direct", availablePaths);
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
      const sock = directDial({
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
          forwardFrame(f);
        },
        close(detail) {
          if (cancelled || phase !== "direct") return;
          clearDirectTimer();
          if (welcomed || revoked) handlers.close(detail);
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
        nextProbeAt = null;
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
    ...(options.absentTableMs !== undefined ? { absentTableMs: options.absentTableMs } : {}),
  });

  if (controller) {
    const syncServers = (views: ServerView[]): ServerCandidate[] => {
      for (const view of views) {
        const prev = targetsById.get(view.id);
        const isGone = prev?.state === "gone" || view.state === "gone";
        const dh = view.dh ?? prev?.dh;
        const name = view.name || prev?.name || view.id;
        if (isGone) {
          targetsById.set(view.id, {
            id: view.id,
            name,
            state: "gone",
            ...(dh ? { dh } : {}),
          });
        } else {
          const addresses = view.addresses !== undefined ? view.addresses : prev?.addresses;
          targetsById.set(view.id, {
            id: view.id,
            name,
            state: view.state,
            ...(dh ? { dh } : {}),
            ...(addresses ? { addresses } : {}),
            ...(prev?.directDial ? { directDial: prev.directDial } : {}),
            ...(prev?.relayDial ? { relayDial: prev.relayDial } : {}),
          });
        }
      }
      return views.map((view) => toCandidate(targetsById.get(view.id)!));
    };
    const staleStreamIds = new Set<string>();
    link.on((event) => {
      if (event.type === "attached") {
        if (event.attached) {
          staleStreamIds.clear();
          const attachedId = link.attachedServerId() ?? controller.current();
          controller.noteAttached(attachedId, syncServers(link.servers()));
        } else if (!revoked && !stopped && !switching) {
          controller.noteDisconnected(controller.current());
        }
      } else if (event.type === "servers") {
        controller.updateServers(syncServers(link.servers()));
        controller.updateStaleStreams(staleStreamIds.size);
      } else if (event.type === "message" && event.message.t === "stale") {
        staleStreamIds.add(event.message.stream);
        controller.updateStaleStreams(staleStreamIds.size);
      } else if ((event.type === "entries" || event.type === "snap") && staleStreamIds.delete(event.type === "entries" ? event.stream : event.snap.stream)) {
        controller.updateStaleStreams(staleStreamIds.size);
      }
    });
  }

  return {
    link,
    get path() { return currentPath; },
    get revoked() { return revoked; },
    get serverId() { return controller ? controller.current() : link.attachedServerId(); },
    pickServer(serverId: string) {
      return controller ? controller.pickServer(serverId) : false;
    },
    start() {
      if (started) return;
      started = true;
      link.start();
    },
    async close() {
      stopped = true;
      attachedOnRelay = false;
      nextProbeAt = null;
      cancelProbe();
      controller?.stop();
      options.visibility?.removeEventListener("visibilitychange", onVisibility);
      await link.close();
    },
  };
}

export interface OpenConnectionOptions {
  forcedPath?: DialPath;
  onPath?: (path: DialPath) => void;
  onServer?: (serverId: string) => void;
  onRevoked?: () => void;
  directTimeoutMs?: number;
  reprobeIntervalMs?: number;
  switchAfterMs?: number;
  antiFlapMs?: number;
}

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
