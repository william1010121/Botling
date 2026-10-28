/** PROPOSED owner interface, not an implemented/exported transaction API.
 * Owner: eb85fb09 (shared transaction internals). Adapter: release-bootstrap.
 * Return a pinned source revision/export location implementing these semantics.
 * Keep snapshot/swap/recovery entirely inside the existing VerifiedInstaller.
 */
export interface ApprovedUpgrade {
  planSha256: string;
  appPath: string; // canonical, verified .18 bundle, not a symlink
  dataDir: string; // canonical existing trial profile
  currentAsarSha256: string;
  candidateZipSha256: string;
  publicKeyFingerprint: string;
}
export interface ParentIdentity {
  pid: number;
  /** Kernel start identity, not rounded ps output or caller-supplied timestamp. */
  startIdentity: string;
  uid: number;
  executablePath: string;
  appPath: string;
  dataDir: string;
}
/** Opaque in the actual implementation. Neither caller nor candidate can mint it. */
export interface ProfileClaim { readonly opaqueClaim: unique symbol }
export interface ApprovedQuitCapability { readonly opaqueQuit: unique symbol }
export type TransactionState =
  | { state: 'unarmed'; claim: ProfileClaim }
  | { state: 'armed' | 'committed' | 'rolled-back' | 'recovery-required'; transactionId: string; journalPath: string };
export interface FirstUpgradeTransactionBridge {
  /** Before stageLocal (which currently runs recovery and writes metadata).
   * Identify live .18 and all profile writers. Exclude other install/recovery
   * owners and ordinary app launches using a mechanism honored by installed .18.
   * A newly invented flock/mkdir that .18 does not honor is NOT sufficient.
   * Refuse unknown writers or unsupported legacy coordination without mutation.
   */
  acquire(input: ApprovedUpgrade): Promise<{ claim: ProfileClaim; parent: ParentIdentity }>;
  /** Resolve the existing explicit-approved install quit flow to this live .18.
   * Must not invoke prepareInstall/legacy replacement, send OS termination
   * signals, inject Electron evaluation, patch .18, or manufacture approval.
   * Return the endpoint protocol/authentication description for adapter review.
   * This operation resolves/binds authority; it does NOT request quit yet.
   */
  bindApprovedQuit(claim: ProfileClaim, parent: ParentIdentity,
    approval: { planSha256: string; explicitInstallApproval: true }): Promise<ApprovedQuitCapability>;
  /** Atomic identity/claim validation and ownership handoff around existing
   * VerifiedInstaller.restart(actualParentPID), then the approved graceful quit.
   * Owner may extend restart with a claim parameter rather than add this method.
   * Identity must remain bound through helper waiting; do not just compare ps
   * twice before passing a reusable integer to the old helper.
   * Claim remains held across flush/exit, snapshot, swap, candidate boot and
   * commit/rollback; released only by the durable transaction outcome.
   * Helper inherits explicitly supplied clean environment, not process.env.
   * Ambiguous spawn/quit/crash must be discoverable by lookup(planSha256).
   * After arming, errors carry transaction identity and never authorize discard.
   */
  armAndQuit(claim: ProfileClaim, input: {
    parent: ParentIdentity;
    quit: ApprovedQuitCapability;
    installer: { restart(actualParentPID: number): Promise<void> };
    launchEnv: Readonly<Record<string, string>>;
  }): Promise<Exclude<TransactionState, { state: 'unarmed' }>>;
  /** Release only a provably unarmed claim; fail if owned by an armed helper. */
  releaseUnarmed(claim: ProfileClaim): Promise<void>;
  /** Read-only, identity-checked durable state lookup after driver interruption. */
  lookup(planSha256: string): Promise<TransactionState | null>;
}
