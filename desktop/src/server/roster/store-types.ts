// The types and small pure helpers of the server roster store (M7-S90): moved out of store.ts unchanged (only `export`
// was added to `PendingRecoveryReplace` and `memberOf`, which store-merge.ts needs; `RosterBackend` and `RosterIdentity`
// moved with them so store-merge.ts need not import store.ts). store.ts re-exports every name it exported before.
import type { StatementBody } from "../../protocol";
import type { Command, Db } from "../store";
import type { RosterView, VerifiedStatement } from "./validity";

export interface RosterBackend {
  submit<T>(command: Command<T>): Promise<T>;
  openReader(): Db;
}

/** What the roster needs of the server's identity (identity/keys.ts). */
export interface RosterIdentity {
  readonly memberId: string;
  readonly keys: { readonly sign: string; readonly dh: string };
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export type RosterRefusal =
  | "no-cluster" | "cluster-exists" | "bad-root" | "self-revoked" | "bad-keys" | "revoked" | "not-a-device" | "server-revoke-root-only"
  | "cannot-revoke-root" | "not-a-server" | "bad-join" | "bad-code" | "already-root" | "not-root" | "bad-keep" | "not-dropped" | "bad-profile";

export class RosterError extends Error {
  constructor(readonly reason: RosterRefusal, message: string) { super(message); this.name = "RosterError"; }
}

export interface RosterChange {
  view: RosterView;
  /** Members valid before the change and not after it. */
  invalidated: string[];
}

export type AuditAct = "cluster.create" | "cluster.join" | "device.add" | "device.revoke" | "server.add" | "server.revoke" | "server.revoke.dropped" | "member.endorse" | "profile.write" | "statement.merge" | "root.change";

export interface AuditBody {
  act: AuditAct;
  at: number;
  statement: string;
  by: string;
  member?: string;
  name?: string;
  reason?: string;
}

export interface RosterStoreOptions {
  now?: () => number;
  log?: (line: string) => void;
}

/** A pending server revocation offered for `keep` at reroot (§4.8). */
export interface KeepCandidate {
  revokeId: string;
  member: string;
  signer: string;
  gen: number;
  receivedAt: number | null;
}

export const RECOVERY_REPLACE_TTL_MS = 10 * 60 * 1000;

export interface RecoveryReplaceStarted {
  /** The new recovery code, formatted in groups of four. Show it once; it is not kept. */
  code: string;
  clusterId: string;
  expiresAt: number;
}

export type RecoveryConfirmResult =
  | { ok: true; clusterId: string; rootId: string; gen: number }
  | { ok: false; reason: "no-cluster" | "not-root" | "no-setup" | "expired" | "stale" | "malformed" | "wrong-code" };

export interface PendingRecoveryReplace {
  rootId: string;
  cluster: string;
  newRecoveryPub: string;
  oldPrivateKey: CryptoKey;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export const memberOf = (body: StatementBody) => (body.type === "root" ? body.root : body.member);

/** The most statements one gossip set (`roster.statements` chunks up to the short last one) may carry. */
export const MAX_GOSSIP_SET = 20_000;

/**
 * Whether gossip stores a verified statement (§4.7, M3 step 5): see `RosterStore.mergeGossip`. A Root reaching here
 * already passed the chain-key check. Every clause only grows with the set.
 */
export function gossipKeeps(statement: VerifiedStatement, view: RosterView): boolean {
  const body = statement.body;
  switch (body.type) {
    case "root": return true;
    case "add": case "endorse": case "revoke": return view.servers.has(body.by) && statement.signer === body.by;
    case "profile": {
      const signer = statement.signer;
      if (view.servers.has(signer)) return true;
      return signer === body.member && (signer === view.self || view.members.has(signer));
    }
    default: return false;
  }
}
