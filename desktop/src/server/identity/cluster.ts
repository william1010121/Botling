// Creating the cluster (protocol v1 §3, §4.8, D48), at the first pairing (M2 step 5 calls this):
//
//   begin()           → a fresh recovery code, returned once to be shown; the server keeps only the recovery PUBLIC
//                        key and the cluster id it derives, in memory, until `confirm` or expiry.
//   confirm(typed)    → the user typed the code back: the recovery key is derived again from what was typed; when its
//                        public key is the pending one, `Root{gen: 1, root: this server, recoveryPub, keep: [], prev:
//                        null}` is signed with it and stored with `meta.clusterId` in one transaction. The private key
//                        is dropped right after signing.
//
//   create()          → begin() and confirm() in one go (the first pairing in Settings › Phone and `botlingd pair`): the
//                        cluster exists at once and the code is returned to be shown once, like an API key. Nothing
//                        has to be typed back; the key material and the code are made exactly as above.
//
// The code is never written anywhere by the server (not server.db, not a file, not the log); after `begin` returns
// it lives only in the caller's hands. A wrong code changes nothing; the pending setup stays until it expires.
// No cluster exists until the code was confirmed, so "unconfirmed" is only ever a pending setup (`note`).
import { clusterIdFromRecoveryKey } from "../../protocol";
import type { RosterStore } from "../roster/store";
import { signStatement, signWith } from "../roster/verify";
import { formatRecoveryCode, newRecoveryCode, normalizeRecoveryCode, recoveryKeyFromCode } from "./recovery";

/** How long a shown code waits to be typed back. */
export const CLUSTER_SETUP_TTL_MS = 10 * 60 * 1000;

export interface ClusterSetupStarted {
  /** The recovery code, formatted in groups of four. Show it once; it is not kept. */
  code: string;
  clusterId: string;
  expiresAt: number;
}

export type ClusterConfirm =
  | { ok: true; clusterId: string; rootId: string }
  | { ok: false; reason: "no-setup" | "expired" | "malformed" | "wrong-code" | "cluster-exists" };

interface Pending { recoveryPub: string; clusterId: string; expiresAt: number }

export class ClusterSetup {
  private pending: Pending | null = null;
  private readonly now: () => number;

  constructor(private readonly roster: RosterStore, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  get exists(): boolean { return this.roster.clusterId !== null; }

  /** A pending setup that was shown and not yet confirmed (and not expired). */
  get waiting(): { clusterId: string; expiresAt: number } | null {
    if (!this.pending || this.pending.expiresAt <= this.now()) return null;
    return { clusterId: this.pending.clusterId, expiresAt: this.pending.expiresAt };
  }

  /** Starts (or restarts) the setup with a new code. Refused when the cluster exists. */
  async begin(): Promise<ClusterSetupStarted> {
    if (this.exists) throw new Error("this server already belongs to a cluster");
    const code = newRecoveryCode();
    const key = await recoveryKeyFromCode(code);
    const clusterId = await clusterIdFromRecoveryKey(key.publicKey);
    const expiresAt = this.now() + CLUSTER_SETUP_TTL_MS;
    this.pending = { recoveryPub: key.recoveryPub, clusterId, expiresAt };
    return { code: formatRecoveryCode(code), clusterId, expiresAt };
  }

  /** The user typed the code back. */
  async confirm(typed: string): Promise<ClusterConfirm> {
    if (this.exists) return { ok: false, reason: "cluster-exists" };
    const pending = this.pending;
    if (!pending) return { ok: false, reason: "no-setup" };
    if (pending.expiresAt <= this.now()) { this.pending = null; return { ok: false, reason: "expired" }; }
    if (!normalizeRecoveryCode(typed)) return { ok: false, reason: "malformed" };
    const key = await recoveryKeyFromCode(typed);
    if (key.recoveryPub !== pending.recoveryPub) return { ok: false, reason: "wrong-code" };
    const root = await signStatement(
      { type: "root", cluster: pending.clusterId, gen: 1, root: this.roster.memberId, recoveryPub: key.recoveryPub, keep: [], prev: null },
      "recovery",
      signWith(key.privateKey),
    );
    await this.roster.createCluster(root, pending.clusterId);
    this.pending = null;
    return { ok: true, clusterId: pending.clusterId, rootId: root.id };
  }

  /** Makes the cluster now and returns its recovery code, to be shown once (nothing is typed back). */
  async create(): Promise<{ code: string; clusterId: string }> {
    const started = await this.begin();
    const made = await this.confirm(started.code);
    if (!made.ok) throw new Error(made.reason === "cluster-exists" ? "this server already belongs to a cluster" : `the cluster was not made (${made.reason})`);
    return { code: started.code, clusterId: made.clusterId };
  }

  /** Forgets a pending setup (the pairing was cancelled). */
  cancel(): void { this.pending = null; }

  /** The Doctor / `botlingd status` note while a shown code waits to be typed back (§4.8), else null. */
  note(): string | null {
    const waiting = this.waiting;
    if (!waiting) return null;
    return `The recovery code was shown but not typed back yet; the cluster is made only after it is confirmed (until ${new Date(waiting.expiresAt).toISOString().replace(/\.\d+Z$/, "Z")}).`;
  }
}
