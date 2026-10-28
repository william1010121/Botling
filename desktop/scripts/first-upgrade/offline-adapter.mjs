import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, isAbsolute, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';
import { plan as legacyPlan, fingerprint, APPROVED_KEY } from './driver.mjs';
import { createWriterCheck } from './offline-processes.mjs';
const sha = data => createHash('sha256').update(data).digest('hex');
const demand = (condition, error) => { if (!condition) throw new Error(error); };
export const MANUAL_WINDOW = 'Old app fully quit; do not relaunch any copy or profile-writing tool until maintenance completes.';
export function offlinePlan(input, key) {
  const base = legacyPlan(input, key);
  demand(isAbsolute(input.runtimePath || '') && normalize(input.runtimePath) === input.runtimePath, 'Explicit reviewed runtime path required');
  demand(/^[a-f0-9]{64}$/.test(input.runtimeSha256 || ''), 'Reviewed standalone runtime SHA-256 required');
  const { planSha256: _, method: __, status: ___, ...pins } = base;
  const body = { ...pins, schema: 2, method: 'offline-maintenance', runtimePath: input.runtimePath, runtimeSha256: input.runtimeSha256,
    manualWindow: MANUAL_WINDOW, status: 'requires explicit prepare approval; launch and rollback are separate operator actions' };
  return { ...body, planSha256: sha(JSON.stringify(body)) };
}
export function approve(plan, key, approval, action) {
  demand(offlinePlan(plan, key).planSha256 === plan.planSha256, 'Plan changed');
  demand(approval?.planSha256 === plan.planSha256 && approval?.action === action && approval?.explicitApproval === true, 'Explicit approval of this action and exact plan required');
  demand(approval?.manualWindowAccepted === true, 'Manual no-relaunch window must be accepted');
}
async function canonicalDirectory(path) {
  const st = await fsp.lstat(path);
  demand(st.isDirectory() && !st.isSymbolicLink() && await fsp.realpath(path) === path, 'Canonical existing directory required');
  demand(st.uid === process.getuid(), 'Directory must belong to the invoking user');
  return `${st.dev}:${st.ino}`;
}
export async function hashFile(path) {
  const st = await fsp.lstat(path);
  demand(st.isFile() && !st.isSymbolicLink() && await fsp.realpath(path) === path, 'Canonical regular file required');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function requireCleanEnvironment(env) {
  for (const name of Object.keys(env)) {
    if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_|DYLD_|LD_PRELOAD|BOTLING_)/.test(name)) throw new Error(`Start with a clean maintenance environment; remove ${name}`);
  }
}
export async function verifyArchitecture(app, arch) {
  const plist = await fsp.readFile(join(app, 'Contents/Info.plist'), 'utf8');
  const executable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  demand(/^[A-Za-z0-9 ._-]+$/.test(executable || ''), 'Bundle executable identity unavailable');
  const { stdout } = await run('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS', executable)]);
  demand(stdout.trim().split(/\s+/).includes(arch === 'x64' ? 'x86_64' : arch), 'Native bundle architecture does not match the plan');
}
export async function verifyInstalled(plan) {
  demand(process.platform === 'darwin' && process.arch === plan.arch, 'Use matching macOS Node architecture');
  const home = userInfo().homedir;
  demand(dirname(dirname(dirname(plan.dataDir))) === home && process.env.HOME === home, 'Pinned ordinary profile must belong to the invoking user HOME');
  const appIdentity = await canonicalDirectory(plan.appPath), profileIdentity = await canonicalDirectory(plan.dataDir);
  await verifyArchitecture(plan.appPath, plan.arch);
  demand(await hashFile(join(plan.appPath, 'Contents/Resources/app.asar')) === plan.currentAsarSha256, 'Installed ASAR changed since approval');
  const plist = await fsp.readFile(join(plan.appPath, 'Contents/Info.plist'), 'utf8');
  demand(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] === plan.current, 'Installed version changed');
  return { appIdentity, profileIdentity };
}
export async function loadReviewedRuntime(plan) {
  demand(await hashFile(plan.runtimePath) === plan.runtimeSha256, 'Reviewed runtime artifact changed');
  // Must be a reviewed self-contained bundle of repository source, never a
  // candidate-provided module or arbitrary plugin. Its digest is approval-bound.
  const runtime = await import(pathToFileURL(plan.runtimePath).href);
  for (const name of ['authenticateLocalBuild', 'VerifiedInstaller', 'openApp']) demand(typeof runtime[name] === 'function', `Runtime missing ${name}`);
  return runtime;
}
const run = (file, args) => promisify(execFile)(file, args, { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });

/** Production glue: defaults use real filesystem/process checks; tests may supply
 * only test-local services. Never expose injected services in CLI arguments.
 * The owner binding supplies maintenance operations, NOT a second transaction.
 */
export async function prepareOffline(plan, key, approval, binding, services = {}) {
  approve(plan, key, approval, 'prepare');
  demand(fingerprint(key) === APPROVED_KEY, 'Unapproved key');
  const check = services.check ?? createWriterCheck(plan);
  const verify = services.verifyInstalled ?? verifyInstalled;
  const runtime = services.runtime ?? await loadReviewedRuntime(plan);
  // Validate the binding before authenticate/stage can create scratch or recover.
  demand(typeof binding?.acquire === 'function', 'Offline transaction owner binding unavailable');
  await check();
  const before = await verify(plan);
  await check();
  let tx, authenticated;
  try {
    tx = await binding.acquire({ plan, identities: before, assertQuiescent: check });
    // Gate/ownership must already be durable before existing stageLocal recovery.
    await check();
    authenticated = await runtime.authenticateLocalBuild(plan.candidatePath, plan.appPath, key, fs, run, plan.arch,
      { appDataDir: dirname(plan.dataDir), dataDir: plan.dataDir, devTrial: true });
    demand(await (services.hashFile ?? hashFile)(authenticated.zip) === plan.candidateZipSha256, 'Authenticated ZIP differs from approved ZIP');
    await (services.verifyArchitecture ?? verifyArchitecture)(authenticated.app, plan.arch);
    const source = await runtime.openApp(authenticated.app, fs);
    const pkg = JSON.parse((await source.read('package.json')).toString('utf8'));
    demand(pkg.botlingDevTrial === true && pkg.version === authenticated.version, 'Signed candidate profile/version mismatch');
    await check();
    demand(JSON.stringify(await verify(plan)) === JSON.stringify(before), 'Target/profile identity changed');
    const installer = new runtime.VerifiedInstaller({ current: plan.current, appPath: plan.appPath, dataDir: plan.dataDir,
      publicKey: key, platform: 'darwin', arch: plan.arch, fetch: async () => { throw new Error('Network forbidden'); },
      profilePin: { appDataDir: dirname(plan.dataDir), dataDir: plan.dataDir, devTrial: true }, bundleFs: fs, launchArgs: [], maintenance: tx.record });
    // Binding attaches the owner's maintenance claim to existing stage/snapshot
    // code. It MUST NOT implement file copying/swap/recovery independently.
    await tx.stage(installer, authenticated, check);
    await check();
    const result = await tx.activateAwaitingOperator(check);
    demand(result?.state === 'awaiting-operator' && typeof result.transactionId === 'string', 'Offline helper did not return a durable paused transaction');
    return { ...result, installed: false, manualWindow: MANUAL_WINDOW };
  } catch (error) {
    // Never discard or release an ambiguous transaction. The owner's operation
    // either releases a provably unarmed claim or retains durable recovery state.
    if (tx) await tx.recordFailure(error);
    throw error;
  } finally {
    if (authenticated) await binding.removeAuthenticationScratch(authenticated);
  }
}
export async function operatorAction(plan, key, approval, action, transactionId, binding, services = {}) {
  demand(['launch', 'rollback'].includes(action), 'Invalid operator action');
  approve(plan, key, approval, action);
  demand(approval.transactionId === transactionId && /^[a-zA-Z0-9-]{8,100}$/.test(transactionId), 'Explicit transaction-bound approval required');
  const check = services.check ?? createWriterCheck(plan);
  await check();
  const tx = await binding.resume({ plan, transactionId, assertQuiescent: check });
  await check();
  return action === 'launch' ? tx.launch(check) : tx.rollback(check);
}
