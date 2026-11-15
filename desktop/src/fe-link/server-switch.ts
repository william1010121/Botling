// Front-end server selection (§13.1) and automatic/manual switching (D72):
// - Server choice: last good server first, then the designated server, then roster order; health = handshake time +
//   staleness of the streams the FE needs.
// - D72 auto-switch: only after the current server has been unreachable on every path (direct and relay) for a full
//   30 s; then pick the next candidate in §13.1 order; never auto-switch back to a server left on its own within 5 min.
// - Manual pick: switches immediately regardless of the 30 s timer or 5-minute anti-flap holdoff.
//
// Pure TypeScript: no DOM, no Electron, no Node built-ins; time comes from an injected Clock.
import type { ServerAddresses, ServerState } from "../protocol";
import { systemClock, type Clock } from "./link";

/** D72: auto-switch only after all paths to the current server fail for a full 30 s. */
export const UNREACHABLE_SWITCH_MS = 30_000;
/** D72: do not auto-switch back to a server we left on our own for 5 minutes. */
export const ANTI_FLAP_MS = 300_000;
/** Weight per stale subscribed stream in health score (ms-equivalent penalty). */
export const STALE_STREAM_PENALTY_MS = 10_000;

export type SwitchPath = "direct" | "relay";

export interface ServerCandidate {
  id: string;
  name: string;
  state?: ServerState;
  /** False when the client lacks key/address info to dial this server. */
  dialable?: boolean;
  dh?: string;
  addresses?: ServerAddresses;
}

export interface ServerHealth {
  handshakeMs?: number;
  staleStreams: number;
  updatedAt: number;
}

export function serverHealthScore(health: ServerHealth | undefined): number {
  if (!health) return Number.POSITIVE_INFINITY;
  return (health.handshakeMs ?? 0) + health.staleStreams * STALE_STREAM_PENALTY_MS;
}

export interface OrderCandidatesOptions {
  servers: readonly ServerCandidate[];
  lastGoodId: string | null;
  designatedId: string | null;
  excludeId?: string | null;
  holdoffUntil?: ReadonlyMap<string, number>;
  now?: number;
}

/**
 * §13.1 server candidate ordering: last good server first, then the designated server, then roster order.
 * Skips revoked (`gone`), non-dialable, `excludeId`, and servers still inside their D72 5-minute holdoff.
 */
export function orderServerCandidates(options: OrderCandidatesOptions): ServerCandidate[] {
  const { servers, lastGoodId, designatedId, excludeId, holdoffUntil, now } = options;
  const eligible = servers.filter((s) => {
    if (s.state === "gone" || s.dialable === false) return false;
    if (excludeId && s.id === excludeId) return false;
    if (holdoffUntil && now !== undefined) {
      const until = holdoffUntil.get(s.id);
      if (until !== undefined && until > now) return false;
    }
    return true;
  });
  const byId = new Map(eligible.map((s) => [s.id, s]));
  const ordered: ServerCandidate[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    const found = byId.get(id);
    if (!found) return;
    seen.add(id);
    ordered.push(found);
  };
  push(lastGoodId);
  push(designatedId);
  for (const s of eligible) push(s.id);
  return ordered;
}

export function mergeServerCandidates(
  current: readonly ServerCandidate[],
  updates: readonly ServerCandidate[],
): ServerCandidate[] {
  const byId = new Map<string, ServerCandidate>();
  for (const entry of current) {
    if (entry.state === "gone") {
      byId.set(entry.id, {
        id: entry.id,
        name: entry.name || entry.id,
        state: "gone",
        ...(entry.dh ? { dh: entry.dh } : {}),
        dialable: false,
      });
    } else {
      byId.set(entry.id, { ...entry });
    }
  }
  for (const next of updates) {
    const prev = byId.get(next.id);
    const dh = next.dh ?? prev?.dh;
    const name = next.name || prev?.name || next.id;
    if (prev?.state === "gone" || next.state === "gone") {
      byId.set(next.id, {
        id: next.id,
        name,
        state: "gone",
        ...(dh ? { dh } : {}),
        dialable: false,
      });
      continue;
    }
    const state = next.state ?? prev?.state;
    const addresses = next.addresses ?? prev?.addresses;
    byId.set(next.id, {
      id: next.id,
      name,
      ...(state !== undefined ? { state } : {}),
      ...(dh ? { dh } : {}),
      ...(addresses ? { addresses } : {}),
      ...(next.dialable !== undefined ? { dialable: next.dialable } : prev?.dialable !== undefined ? { dialable: prev.dialable } : {}),
    });
  }
  return [...byId.values()];
}

export interface ServerSwitchControllerOptions {
  servers: readonly ServerCandidate[];
  designatedId: string;
  lastGoodId?: string | null;
  clock?: Clock;
  switchAfterMs?: number;
  antiFlapMs?: number;
  onServer?: (serverId: string) => void;
  onLastGoodServer?: (serverId: string) => void;
  onSwitch?: (event: { from: string; to: string; reason: "auto" | "manual" }) => void;
}

/**
 * Pure D72 / §13.1 server-switching state machine. Owns candidate selection, the 30 s all-paths-unreachable
 * auto-switch timer, the 5-minute anti-flap holdoff, and manual `pickServer(id)`.
 */
export class ServerSwitchController {
  private readonly clock: Clock;
  private readonly switchAfterMs: number;
  private readonly antiFlapMs: number;
  private readonly designatedId: string;
  private lastGoodId: string | null;
  private candidateList: ServerCandidate[];
  private currentId: string;
  private attached = false;
  private stopped = false;
  private unreachableSince: number | null = null;
  private dialStartedAt: number | null = null;
  private availablePaths = new Set<SwitchPath>();
  private pathsAttempted = new Set<SwitchPath>();
  private readonly holdoffs = new Map<string, number>();
  private readonly health = new Map<string, ServerHealth>();
  private switchTimer: unknown = undefined;

  constructor(private readonly options: ServerSwitchControllerOptions) {
    this.clock = options.clock ?? systemClock;
    this.switchAfterMs = options.switchAfterMs ?? UNREACHABLE_SWITCH_MS;
    this.antiFlapMs = options.antiFlapMs ?? ANTI_FLAP_MS;
    this.designatedId = options.designatedId;
    this.lastGoodId = options.lastGoodId ?? null;
    this.candidateList = mergeServerCandidates([], options.servers);
    const initial = orderServerCandidates({
      servers: this.candidateList,
      lastGoodId: this.lastGoodId,
      designatedId: this.designatedId,
    })[0];
    this.currentId = initial?.id ?? this.designatedId;
  }

  current(): string { return this.currentId; }
  lastGood(): string | null { return this.lastGoodId; }
  servers(): ServerCandidate[] { return this.candidateList.map((s) => ({ ...s })); }
  holdoffUntilOf(id: string): number | null { return this.holdoffs.get(id) ?? null; }
  healthOf(id: string): ServerHealth | undefined {
    const entry = this.health.get(id);
    return entry ? { ...entry } : undefined;
  }

  updateServers(updates: readonly ServerCandidate[]): void {
    this.candidateList = mergeServerCandidates(this.candidateList, updates);
  }

  updateStaleStreams(staleStreams: number): void {
    const prev = this.health.get(this.currentId);
    this.health.set(this.currentId, {
      ...(prev?.handshakeMs !== undefined ? { handshakeMs: prev.handshakeMs } : {}),
      staleStreams,
      updatedAt: this.clock.now(),
    });
  }

  noteDialStart(serverId: string, available: readonly SwitchPath[]): void {
    if (this.stopped || serverId !== this.currentId) return;
    const now = this.clock.now();
    this.dialStartedAt = now;
    this.availablePaths = new Set(available);
    if (!this.attached && this.unreachableSince === null) {
      this.unreachableSince = now;
    }
    this.armTimer();
  }

  notePathAttempt(serverId: string, path: SwitchPath, available?: readonly SwitchPath[]): void {
    if (this.stopped || serverId !== this.currentId) return;
    if (available) this.availablePaths = new Set(available);
    this.pathsAttempted.add(path);
    if (!this.attached && this.unreachableSince === null) {
      this.unreachableSince = this.clock.now();
    }
    this.armTimer();
  }

  noteAttached(serverId: string, updates?: readonly ServerCandidate[]): void {
    if (this.stopped) return;
    const now = this.clock.now();
    this.attached = true;
    this.unreachableSince = null;
    this.pathsAttempted.clear();
    this.clearTimer();
    const handshakeMs = this.dialStartedAt !== null ? Math.max(0, now - this.dialStartedAt) : undefined;
    this.dialStartedAt = null;
    const prevHealth = this.health.get(serverId);
    this.health.set(serverId, {
      ...(handshakeMs !== undefined ? { handshakeMs } : prevHealth?.handshakeMs !== undefined ? { handshakeMs: prevHealth.handshakeMs } : {}),
      staleStreams: prevHealth?.staleStreams ?? 0,
      updatedAt: now,
    });
    if (updates) this.updateServers(updates);
    if (this.currentId !== serverId) {
      this.currentId = serverId;
      this.options.onServer?.(serverId);
    }
    if (this.lastGoodId !== serverId) {
      this.lastGoodId = serverId;
      this.options.onLastGoodServer?.(serverId);
    }
  }

  noteDisconnected(serverId: string): void {
    if (this.stopped || serverId !== this.currentId) return;
    this.attached = false;
    if (this.unreachableSince === null) {
      this.unreachableSince = this.clock.now();
      this.pathsAttempted.clear();
    }
    this.armTimer();
  }

  /**
   * Manual server pick (D72): switches immediately regardless of 30 s timer or 5-minute holdoff; lastGood is persisted
   * only once the selected server attaches. Returns false if unknown, revoked (`gone`), or non-dialable.
   */
  pickServer(serverId: string): boolean {
    if (this.stopped) return false;
    const target = this.candidateList.find((s) => s.id === serverId);
    if (!target || target.state === "gone" || target.dialable === false) return false;
    this.holdoffs.delete(serverId);
    const from = this.currentId;
    // D72: re-picking the current target (attached or dialing) must not restart the 30 s window or re-dial.
    if (from === serverId) return true;
    this.currentId = serverId;
    this.attached = false;
    this.unreachableSince = this.clock.now();
    this.dialStartedAt = null;
    this.pathsAttempted.clear();
    this.clearTimer();
    this.armTimer();
    if (from !== serverId) this.options.onServer?.(serverId);
    this.options.onSwitch?.({ from, to: serverId, reason: "manual" });
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
  }

  private allPathsAttempted(): boolean {
    if (this.availablePaths.size === 0) return true;
    for (const p of this.availablePaths) {
      if (!this.pathsAttempted.has(p)) return false;
    }
    return true;
  }

  private clearTimer(): void {
    if (this.switchTimer !== undefined) {
      this.clock.clearTimeout(this.switchTimer);
      this.switchTimer = undefined;
    }
  }

  private armTimer(): void {
    this.clearTimer();
    if (this.stopped || this.attached || this.unreachableSince === null) return;
    const elapsed = this.clock.now() - this.unreachableSince;
    const waitMs = Math.max(0, this.switchAfterMs - elapsed);
    if (waitMs === 0) {
      // Wait for all paths on this server if one hasn't been tried yet; otherwise schedule next holdoff expiry check.
      if (!this.allPathsAttempted()) return;
      const now = this.clock.now();
      const next = this.nextAutoCandidate(now);
      if (!next) {
        const earliest = this.earliestHoldoffExpiry(now);
        if (earliest !== null) {
          this.switchTimer = this.clock.setTimeout(() => {
            this.switchTimer = undefined;
            this.tryAutoSwitch();
          }, Math.max(1, earliest - now));
        }
        return;
      }
    }
    this.switchTimer = this.clock.setTimeout(() => {
      this.switchTimer = undefined;
      this.tryAutoSwitch();
    }, waitMs);
  }

  private nextAutoCandidate(now: number): ServerCandidate | undefined {
    return orderServerCandidates({
      servers: this.candidateList,
      lastGoodId: this.lastGoodId,
      designatedId: this.designatedId,
      excludeId: this.currentId,
      holdoffUntil: this.holdoffs,
      now,
    })[0];
  }

  private earliestHoldoffExpiry(now: number): number | null {
    let earliest: number | null = null;
    for (const s of this.candidateList) {
      if (s.id === this.currentId || s.state === "gone" || s.dialable === false) continue;
      const until = this.holdoffs.get(s.id);
      if (until !== undefined && until > now) {
        earliest = earliest === null ? until : Math.min(earliest, until);
      }
    }
    return earliest;
  }

  private tryAutoSwitch(): void {
    if (this.stopped || this.attached || this.unreachableSince === null) return;
    const now = this.clock.now();
    if (now - this.unreachableSince < this.switchAfterMs) {
      this.armTimer();
      return;
    }
    if (!this.allPathsAttempted()) return;
    const next = this.nextAutoCandidate(now);
    if (!next) {
      this.clearTimer();
      const earliest = this.earliestHoldoffExpiry(now);
      if (earliest !== null) {
        this.switchTimer = this.clock.setTimeout(() => {
          this.switchTimer = undefined;
          this.tryAutoSwitch();
        }, Math.max(1, earliest - now));
      }
      return;
    }
    const from = this.currentId;
    // D72: after auto-switching away from `from`, do not auto-switch back for 5 minutes.
    this.holdoffs.set(from, now + this.antiFlapMs);
    this.currentId = next.id;
    this.attached = false;
    this.unreachableSince = now;
    this.dialStartedAt = null;
    this.pathsAttempted.clear();
    this.armTimer();
    this.options.onServer?.(next.id);
    this.options.onSwitch?.({ from, to: next.id, reason: "auto" });
  }
}
