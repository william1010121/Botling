import { createHash, createPublicKey } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';

export const APPROVED_KEY = '1a423f6b0027da46675d0df7a63dfc43b11a3f2bdef1264027b66049dbb8f0c1';
export const CURRENT = '2.0.0-dev.20261029.18';
export const CURRENT_ASAR = '260f2c24e67955b9fd48795bc695725529c4d6e1d8c444b6e15e3258cecd8259';
const sha = value => createHash('sha256').update(value).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
export function fingerprint(pem) {
  const key = createPublicKey(pem);
  requireThat(key.asymmetricKeyType === 'ed25519', 'Ed25519 required');
  return sha(key.export({ type: 'spki', format: 'der' }));
}
export function plan(input, publicKey) {
  requireThat(fingerprint(publicKey) === APPROVED_KEY, 'Unapproved trust fingerprint');
  for (const field of ['appPath', 'dataDir', 'candidatePath']) {
    const path = input[field];
    requireThat(typeof path === 'string' && isAbsolute(path) && normalize(path) === path && !/[\r\n\0]/.test(path), `Explicit normalized ${field} required`);
  }
  requireThat(input.appPath.endsWith('.app') && input.candidatePath.endsWith('.app'), 'App bundles required');
  const paths = [input.appPath, input.dataDir, input.candidatePath];
  requireThat(paths.every((a, i) => paths.every((b, j) => i === j || (a !== b && !a.startsWith(b + '/')))), 'Paths must be disjoint');
  requireThat(input.current === CURRENT && input.currentAsarSha256 === CURRENT_ASAR, 'Installed .18 identity required');
  requireThat(['arm64', 'x64'].includes(input.arch), 'Explicit architecture required');
  requireThat(/^[a-f0-9]{64}$/.test(input.candidateZipSha256), 'Pin reviewed candidate ZIP SHA-256');
  requireThat(input.candidateDevTrial === true, 'Ordinary launches must retain trial profile');
  requireThat(input.dataDir.endsWith('/Library/Application Support/Botling 2 Dev Trial'), 'This upgrade retains the trial profile');
  const value = {
    schema: 1, appPath: input.appPath, dataDir: input.dataDir, candidatePath: input.candidatePath,
    current: CURRENT, currentAsarSha256: CURRENT_ASAR, arch: input.arch,
    candidateZipSha256: input.candidateZipSha256, candidateDevTrial: true,
    publicKeyFingerprint: APPROVED_KEY, platform: 'darwin',
    method: 'authenticateLocalBuild -> VerifiedInstaller.stageLocal -> restart(actualParentPID) -> approved graceful quit',
    status: 'blocked: reviewed runtime bridge and explicit install approval required',
  };
  return { ...value, planSha256: sha(JSON.stringify(value)) };
}

/** Ports are an audited runtime boundary, NOT user configuration or candidate-supplied code.
 * No production bridge is shipped until exclusion/identity/quit semantics are resolved.
 * authenticate/stage/restart use the candidate APIs; this module never implements rollback.
 */
export async function execute(reviewed, publicKey, approval, ports) {
  const expected = plan(reviewed, publicKey);
  requireThat(expected.planSha256 === reviewed.planSha256, 'Plan changed');
  requireThat(approval?.planSha256 === reviewed.planSha256 && approval?.explicitInstallApproval === true, 'Explicit approval of this exact plan required');
  requireThat(ports?.contract === 'first-upgrade-exclusive-v1', 'Reviewed runtime bridge unavailable');
  // This lease MUST cover every writer of this profile, through helper commit/rollback.
  const lease = await ports.acquireExclusive(reviewed);
  let authenticated, installer, handedOff = false;
  try {
    const initial = await lease.inspect();
    checkIdentity(initial, reviewed);
    authenticated = await ports.authenticateLocalBuild(reviewed.candidatePath, reviewed.appPath, publicKey);
    const metadata = await ports.inspectAuthenticated(authenticated);
    requireThat(metadata.zipSha256 === reviewed.candidateZipSha256 && metadata.botlingDevTrial === true, 'Signed candidate/profile mode changed');
    requireThat(metadata.publicKeyFingerprint === APPROVED_KEY && metadata.arch === reviewed.arch, 'Candidate trust/architecture changed');
    requireThat(metadata.ordinaryDataDir === reviewed.dataDir, 'Ordinary launch profile differs');
    requireThat(metadata.startupFenceReviewed === true && metadata.recoveryReviewed === true, 'Candidate safety dependencies not reviewed');
    installer = ports.createVerifiedInstaller({ current: reviewed.current, appPath: reviewed.appPath,
      dataDir: reviewed.dataDir, publicKey, platform: 'darwin', arch: reviewed.arch,
      fetch: async () => { throw new Error('Bootstrap forbids network fallback'); }, launchArgs: [] });
    await installer.stageLocal(authenticated.zip, authenticated.version);
    const actual = await lease.inspect();
    checkIdentity(actual, reviewed);
    requireThat(actual.pid === initial.pid && actual.birth === initial.birth, 'Parent process replaced during staging');
    // Atomic with respect to the lease: a mere ps PID observation is insufficient.
    await lease.withValidatedParent(actual, async () => {
      await installer.restart(actual.pid);
      handedOff = true;
      await lease.transferToInstaller();
      await lease.approvedGracefulQuit(actual);
    });
    return { status: 'helper-armed', pid: actual.pid, installed: false };
  } finally {
    // Once armed, never discard staging/journal or release protection under the helper.
    // A quit/transfer failure must retain it for explicit recovery, not force-kill .18.
    if (!handedOff) {
      try { if (installer) await installer.discard(); }
      finally { await lease.release(); }
    }
    if (authenticated) await ports.removeAuthenticationScratch(authenticated);
  }
}
function checkIdentity(process, reviewed) {
  requireThat(Number.isSafeInteger(process.pid) && process.pid > 1 && typeof process.birth === 'string' && process.birth.length > 0, 'Live parent identity unavailable');
  requireThat(process.appPath === reviewed.appPath && process.dataDir === reviewed.dataDir && process.current === CURRENT && process.asarSha256 === CURRENT_ASAR && process.exclusive === true, 'Installed identity/profile/exclusion mismatch');
}
