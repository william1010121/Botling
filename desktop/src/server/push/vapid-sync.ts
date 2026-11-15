// Cluster VAPID key rotation and distribution after server revocation or root takeover (Q-P3, protocol v1 §18.4, M4-26).
// - Reconciles on `start()`, on every roster change, and on a retry timer if writing `vapid-keys.json` fails (F1):
//   if this server is the current valid revocation root and either `record.gen < view.root.gen` (for `gen > 1`) or
//   any revoked server (`view.revoked ∩ view.servers`) is missing from `record.covers`, mints a fresh pair ordered by
//   `(gen, id)` and broadcasts `vapid.key{gen, id, pub, priv}` ONLY over open full peer sessions to valid servers.
// - Valid servers that were offline when a rotation occurred receive the current rotated key (`gen >= 1, id >= 1`) from
//   the root when their full peer session opens (`sessionOpened`).
// - Receivers accept `vapid.key` ONLY from the current revocation root (`view.root?.root === session.peer`) on an open
//   full peer session, verify the P-256 pair matches, and retain the key with the highest `(gen, id)`. Secrets are
//   never logged.
import { lstatSync } from "node:fs";
import type { WireMessage } from "../../protocol";
import {
  acceptVapidKey, readVapidKeyRecord, revokedServerIds, rotateVapidKeys, VAPID_FILE, vapidFilePath,
  type VapidKeyRecord,
} from "../identity/vapid";
import type { RosterChange, RosterView } from "../roster";

export const DEFAULT_VAPID_RETRY_MS = 5_000;

export interface VapidSyncSession {
  readonly peer: string | null;
  readonly state: string;
  sendWire(message: WireMessage): boolean;
}

export interface VapidSyncRoster {
  readonly memberId: string;
  readonly view: RosterView;
  onChange(listener: (change: RosterChange) => void): () => void;
}

export interface VapidKeySyncOptions {
  dataDir: string;
  roster: VapidSyncRoster;
  sessions: () => readonly VapidSyncSession[];
  log?: (line: string) => void;
  retryMs?: number;
}

function isValidServer(view: RosterView, memberId: string): boolean {
  return view.servers.has(memberId) && view.valid.has(memberId) && !view.revoked.has(memberId);
}

function isRootSelf(view: RosterView, selfMemberId: string): boolean {
  return view.root !== null && view.root.root === selfMemberId && view.valid.has(selfMemberId) && !view.revoked.has(selfMemberId);
}

function pathPresent(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== "ENOENT";
  }
}

export class VapidKeySync {
  private unlisten: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly retryMs: number;

  constructor(private readonly options: VapidKeySyncOptions) {
    this.retryMs = options.retryMs ?? DEFAULT_VAPID_RETRY_MS;
  }

  start(): void {
    if (this.closed || this.unlisten) return;
    this.unlisten = this.options.roster.onChange((change) => this.reconcile(change.view));
    this.reconcile(this.options.roster.view);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearRetry();
    this.unlisten?.();
    this.unlisten = null;
  }

  /**
   * Called when a full peer session opens (after `roster.revocations` sync). If this server is the valid root and
   * holds a rotated key (`gen >= 1, id >= 1`), sends it to the valid peer so servers offline during rotation catch up.
   */
  sessionOpened(session: VapidSyncSession): void {
    if (this.closed || session.state !== "open" || !session.peer) return;
    const self = this.options.roster.memberId;
    const view = this.options.roster.view;
    if (!isRootSelf(view, self)) return;
    if (session.peer === self || !isValidServer(view, session.peer)) return;
    const record = readVapidKeyRecord(this.options.dataDir);
    if (!record || record.gen < 1 || record.id < 1) return;
    this.sendToSession(session, record);
  }

  /** Handles an incoming peer `vapid.key` frame; returns false for any other message type. */
  onMessage(session: VapidSyncSession, message: WireMessage): boolean {
    if (message.t !== "vapid.key") return false;
    if (this.closed || session.state !== "open" || !session.peer) return true;
    const self = this.options.roster.memberId;
    const view = this.options.roster.view;
    if (!view.valid.has(self) || view.revoked.has(self)) {
      this.options.log?.(`push: ignoring vapid.key gen=${message.gen} id=${message.id}; this server is not valid`);
      return true;
    }
    if (session.peer === self || !isValidServer(view, session.peer)) {
      this.options.log?.(`push: ignoring vapid.key gen=${message.gen} id=${message.id} from non-valid peer ${session.peer}`);
      return true;
    }
    if (view.root?.root !== session.peer) {
      this.options.log?.(`push: ignoring vapid.key gen=${message.gen} id=${message.id} from non-root peer ${session.peer}`);
      return true;
    }
    const result = acceptVapidKey(this.options.dataDir, {
      gen: message.gen,
      id: message.id,
      pub: message.pub,
      priv: message.priv,
    });
    if (result.accepted) {
      this.options.log?.(
        `push: updated cluster VAPID key to gen=${result.record.gen} id=${result.record.id} from root ${session.peer}`,
      );
    } else if (result.reason !== "stale") {
      this.options.log?.(
        `push: rejected vapid.key gen=${message.gen} id=${message.id} from root ${session.peer} (${result.reason})`,
      );
    }
    return true;
  }

  private reconcile(view: RosterView): void {
    if (this.closed) return;
    const self = this.options.roster.memberId;
    if (!isRootSelf(view, self) || !view.root) {
      this.clearRetry();
      return;
    }
    const revoked = revokedServerIds(view);
    const record = readVapidKeyRecord(this.options.dataDir);
    if (record === null) {
      // Wait for first server pairing (`ensureVapidKeys`) only while no file/symlink exists, gen is 1, and no server is revoked.
      if (revoked.length === 0 && view.root.gen === 1 && !pathPresent(vapidFilePath(this.options.dataDir))) {
        this.clearRetry();
        return;
      }
    } else {
      if (record.gen > view.root.gen) return;
      const covered = new Set(record.covers);
      const uncovered = revoked.some((id) => !covered.has(id));
      const newRootGen = view.root.gen > 1 && record.gen < view.root.gen;
      if (!uncovered && !newRootGen) {
        this.clearRetry();
        return;
      }
    }
    try {
      const next = rotateVapidKeys(this.options.dataDir, { gen: view.root.gen, covers: revoked });
      this.clearRetry();
      this.options.log?.(
        `push: rotated cluster VAPID key to gen=${next.gen} id=${next.id} covering ${next.covers.length} revoked server(s)`,
      );
      this.broadcast(next, view);
    } catch (error) {
      const code = typeof (error as NodeJS.ErrnoException)?.code === "string"
        ? ` (${(error as NodeJS.ErrnoException).code})`
        : "";
      // Name only the file (and OS error code when present), never paths or key material.
      this.options.log?.(`push: failed to update ${VAPID_FILE}${code}; will retry`);
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed) this.reconcile(this.options.roster.view);
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private broadcast(record: VapidKeyRecord, view: RosterView): void {
    const self = this.options.roster.memberId;
    for (const session of this.options.sessions()) {
      if (session.state !== "open" || !session.peer) continue;
      if (session.peer === self || !isValidServer(view, session.peer)) continue;
      this.sendToSession(session, record);
    }
  }

  private sendToSession(session: VapidSyncSession, record: VapidKeyRecord): void {
    session.sendWire({
      t: "vapid.key",
      gen: record.gen,
      id: record.id,
      pub: record.keys.publicKey,
      priv: record.keys.privateKey,
    });
  }
}
