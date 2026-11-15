// Cluster VAPID key rotation and distribution after server revocation (Q-P3, protocol v1 §18.4, M4-26).
// - Only the current valid revocation root mints a replacement key (`rotateVapidKeys`) when it signs a server
//   revocation (`revokeServer` or `reroot` with `oldRootLost: true`), and distributes `vapid.key{id, pub, priv}` ONLY
//   over open full peer sessions to valid, unrevoked servers.
// - Valid servers that were offline when a revocation occurred receive the current rotated key (`id >= 1`) from the
//   root when their full peer session opens (`sessionOpened`).
// - Receivers accept `vapid.key` ONLY from the current revocation root (`view.root?.root === session.peer`) on an open
//   full peer session, verify the P-256 pair matches, and retain the key with the highest `id`. Secrets are never logged.
import type { WireMessage } from "../../protocol";
import { acceptVapidKey, readVapidKeyRecord, rotateVapidKeys, type VapidKeyRecord } from "../identity/vapid";
import type { RosterChange, RosterView } from "../roster";

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
}

function isValidServer(view: RosterView, memberId: string): boolean {
  return view.servers.has(memberId) && view.valid.has(memberId) && !view.revoked.has(memberId);
}

function isRootSelf(view: RosterView, selfMemberId: string): boolean {
  return view.root?.root === selfMemberId && view.valid.has(selfMemberId) && !view.revoked.has(selfMemberId);
}

export class VapidKeySync {
  private unlisten: (() => void) | null = null;
  private closed = false;

  constructor(private readonly options: VapidKeySyncOptions) {}

  start(): void {
    if (this.closed || this.unlisten) return;
    this.unlisten = this.options.roster.onChange((change) => this.onRosterChange(change));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten?.();
    this.unlisten = null;
  }

  /**
   * Called when a full peer session opens (after `roster.revocations` sync). If this server is the valid root and
   * holds a rotated key (`id >= 1`), sends it to the valid peer so servers offline during revocation catch up.
   */
  sessionOpened(session: VapidSyncSession): void {
    if (this.closed || session.state !== "open" || !session.peer) return;
    const self = this.options.roster.memberId;
    const view = this.options.roster.view;
    if (!isRootSelf(view, self)) return;
    if (session.peer === self || !isValidServer(view, session.peer)) return;
    const record = readVapidKeyRecord(this.options.dataDir);
    if (!record || record.id < 1) return;
    this.sendToSession(session, record);
  }

  /** Handles an incoming peer `vapid.key` frame; returns false for any other message type. */
  onMessage(session: VapidSyncSession, message: WireMessage): boolean {
    if (message.t !== "vapid.key") return false;
    if (this.closed || session.state !== "open" || !session.peer) return true;
    const self = this.options.roster.memberId;
    const view = this.options.roster.view;
    if (!view.valid.has(self) || view.revoked.has(self)) {
      this.options.log?.(`push: ignoring vapid.key id=${message.id}; this server is not valid`);
      return true;
    }
    if (session.peer === self || !isValidServer(view, session.peer)) {
      this.options.log?.(`push: ignoring vapid.key id=${message.id} from non-valid peer ${session.peer}`);
      return true;
    }
    if (view.root?.root !== session.peer) {
      this.options.log?.(`push: ignoring vapid.key id=${message.id} from non-root peer ${session.peer}`);
      return true;
    }
    const result = acceptVapidKey(this.options.dataDir, { id: message.id, pub: message.pub, priv: message.priv });
    if (result.accepted) {
      this.options.log?.(`push: updated cluster VAPID key to id=${result.record.id} from root ${session.peer}`);
    } else if (result.reason !== "stale") {
      this.options.log?.(`push: rejected vapid.key id=${message.id} from root ${session.peer} (${result.reason})`);
    }
    return true;
  }

  private onRosterChange(change: RosterChange): void {
    if (this.closed || !change.serverRevokeSigned) return;
    const self = this.options.roster.memberId;
    if (!isRootSelf(change.view, self)) return;
    const record = rotateVapidKeys(this.options.dataDir);
    this.options.log?.(`push: rotated cluster VAPID key to id=${record.id} after server revocation`);
    this.broadcast(record, change.view);
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
      id: record.id,
      pub: record.keys.publicKey,
      priv: record.keys.privateKey,
    });
  }
}
