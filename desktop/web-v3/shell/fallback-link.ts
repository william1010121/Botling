// The §6.2 / D72 path controller of the shell link (moved out of connection.ts; connection.ts re-exports its names).
import { FeLink, ServerSwitchController, systemClock, type Dial, type FeSocket, type ServerCandidate, type ServerView, type SwitchPath } from "../../src/fe-link";
import { encodeFrame, PROTOCOL_VERSION } from "../../src/protocol";
import { DIRECT_TIMEOUT_MS, REPROBE_INTERVAL_MS, type DialPath, type FallbackLink, type FallbackLinkOptions, type ServerDialTarget } from "./connection-types";

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
