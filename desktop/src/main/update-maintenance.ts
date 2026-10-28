// Offline coordination only. Old .18 does NOT honor this fence. The adapter/operator must keep
// all old app/core/profile writers closed; process checks detect uncertainty, not exclusion.
import * as fs from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { durableJSON, syncDirectory } from './hot-transaction';
export const MAINTENANCE = 'update-maintenance.json';
export interface MaintenanceRecord {
  v: 1; token: string; planSha256: string; target: string; dataDir: string; root: string;
  appIdentity: string; dataIdentity: string;
}
export type QuiescenceCheck = () => Promise<void>; // must throw on any writer or uncertain census
function json(path: string): any {
  const st = fs.lstatSync(path);
  if (!st.isFile() || st.size > 16384 || st.mode & 0o077 || st.uid !== process.getuid?.()) throw new Error('Unsafe maintenance record');
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}
export function filesystemIdentity(path: string): string {
  if (fs.realpathSync(path) !== path) throw new Error('Maintenance path must be canonical');
  const st = fs.lstatSync(path); if (!st.isDirectory()) throw new Error('Maintenance path must be a directory');
  return `${st.dev}:${st.ino}`;
}
export function readMaintenance(dataDir: string, target: string): MaintenanceRecord | null {
  let record: MaintenanceRecord | null = null;
  try {
    if (fs.existsSync(join(dataDir, MAINTENANCE))) record = json(join(dataDir, MAINTENANCE));
    else {
      // Survives a crash between profile restore renames, when the live marker is absent.
      for (const name of fs.readdirSync(dirname(target))) {
        if (!name.startsWith('.botling-update-')) continue;
        const root = join(dirname(target), name), owner = join(root, 'maintenance-owner.json');
        if (!fs.existsSync(owner)) continue;
        const r = json(owner);
        if (r.dataDir === dataDir && r.target === target && !fs.existsSync(join(root, 'maintenance-terminal'))) {
          if (record) throw new Error('Multiple maintenance owners'); record = r;
        }
      }
    }
    if (!record) return null;
    const r = record;
    if (r.v !== 1 || !/^[a-f0-9-]{36}$/.test(r.token) || !/^[a-f0-9]{64}$/.test(r.planSha256)
      || r.target !== target || r.dataDir !== dataDir || dirname(r.root) !== dirname(target)
      || !basename(r.root).startsWith('.botling-update-') || fs.realpathSync(r.root) !== r.root
      || JSON.stringify(json(join(r.root, 'maintenance-owner.json'))) !== JSON.stringify(r)) throw new Error('Invalid maintenance ownership');
    return r;
  } catch (cause) { throw new Error('Maintenance state requires offline recovery', { cause }); }
}
export async function beginMaintenance(input: { target: string; dataDir: string; planSha256: string }, assertQuiescent: QuiescenceCheck): Promise<MaintenanceRecord> {
  await assertQuiescent();
  if (!/^[a-f0-9]{64}$/.test(input.planSha256)) throw new Error('Invalid maintenance plan');
  const appIdentity = filesystemIdentity(input.target), dataIdentity = filesystemIdentity(input.dataDir);
  if (readMaintenance(input.dataDir, input.target) || fs.existsSync(join(input.dataDir, 'update-pending.json')) || fs.existsSync(join(input.dataDir, 'hot-install-pending.json'))) throw new Error('Existing transaction needs recovery');
  const root = fs.mkdtempSync(join(dirname(input.target), '.botling-update-')); fs.chmodSync(root, 0o700);
  const r: MaintenanceRecord = { v: 1, ...input, root, token: randomUUID(), appIdentity, dataIdentity };
  // Candidate discovers the owner even if the process dies before publishing the profile marker.
  await durableJSON(join(root, 'maintenance-owner.json'), r, fs);
  await durableJSON(join(root, 'owner.json'), { ...r, pid: process.pid }, fs);
  const h = await fs.promises.open(join(input.dataDir, MAINTENANCE), 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(r)); await h.sync(); } finally { await h.close(); }
  await syncDirectory(input.dataDir, fs);
  return r;
}
export function requireMaintenance(r: MaintenanceRecord): MaintenanceRecord {
  const current = readMaintenance(r.dataDir, r.target);
  if (!current || JSON.stringify(current) !== JSON.stringify(r)) throw new Error('Maintenance transaction changed');
  return current;
}
export function maintenancePhase(r: MaintenanceRecord): string {
  // Terminal lookup remains available after the profile marker has been removed.
  if (dirname(r.root) === dirname(r.target) && basename(r.root).startsWith('.botling-update-')
    && fs.realpathSync(r.root) === r.root && JSON.stringify(json(join(r.root, 'maintenance-owner.json'))) === JSON.stringify(r)
    && fs.existsSync(join(r.root, 'maintenance-terminal'))) {
    const terminal = fs.readFileSync(join(r.root, 'maintenance-terminal'), 'utf8');
    if (['committed', 'rolled-back'].includes(terminal)) return terminal;
    throw new Error('Invalid maintenance terminal state');
  }
  requireMaintenance(r);
  try { return fs.readFileSync(join(r.root, 'maintenance-phase'), 'utf8').trim(); } catch { return 'preparing'; }
}
/** Read-only early candidate guard, including already-compatible storage epochs. */
export function checkMaintenanceStartup(dataDir: string, target: string, argv: string[]): boolean {
  const r = readMaintenance(dataDir, target); if (!r) return false;
  if (maintenancePhase(r) !== 'launching' || !argv.includes('--botling-update-token=' + r.token)
    || !argv.includes('--botling-maintenance-launch=' + r.token)) throw new Error('Maintenance is active; use explicit offline launch or rollback');
  if (fs.existsSync(join(r.root, 'maintenance-invalidated'))) throw new Error('Maintenance snapshot invalidated; offline recovery required');
  return true; // caller must still validate snapshot provenance and signed storage contract
}
/** Clean environment at the actual helper spawn, not a promise about the caller's environment. */
export function maintenanceEnvironment(env: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', BOTLING_UPDATE_OFFLINE: '1' };
  for (const key of ['HOME', 'TMPDIR', 'USER', 'LOGNAME']) if (env[key]) out[key] = env[key];
  return out;
}
/** Adapter's continuous watcher calls this on any writer/identity uncertainty. */
export async function invalidateMaintenance(r: MaintenanceRecord): Promise<void> {
  requireMaintenance(r);
  await durableJSON(join(r.root, 'maintenance-invalidated'), { reason: 'writer check failed' }, fs);
}
export async function permitMaintenance(r: MaintenanceRecord, action: 'snapshot' | 'activate' | 'launch' | 'rollback', assertQuiescent: QuiescenceCheck): Promise<void> {
  requireMaintenance(r);
  try { await assertQuiescent(); } catch (error) {
    await invalidateMaintenance(r);
    throw error;
  }
  requireMaintenance(r);
  const phase = maintenancePhase(r);
  const expected = { snapshot: 'awaiting-snapshot', activate: 'awaiting-activation', launch: 'activated-awaiting-operator-launch', rollback: 'activated-awaiting-operator-launch' }[action];
  if (phase !== expected) throw new Error('Maintenance phase does not permit ' + action);
  if (fs.existsSync(join(r.root, 'maintenance-invalidated'))) throw new Error('Maintenance snapshot invalidated');
  const { verifyMaintenanceGeneration } = await import('./update-install');
  await verifyMaintenanceGeneration(r, action);
  const file = join(r.root, action === 'launch' || action === 'rollback' ? 'operator-choice' : 'permit-' + action);
  const handle = await fs.promises.open(file, 'wx', 0o600);
  try { await handle.writeFile(`${action}:${r.token}`); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(r.root, fs);
}

/** Durable, exclusive handoff claim. An interrupted spawn is retained, not silently retried.
 * A single explicit resume is available for a provably unlaunched activated pause. */
export async function claimMaintenanceHelper(r: MaintenanceRecord, resume = false): Promise<void> {
  requireMaintenance(r);
  const file = join(r.root, resume ? 'maintenance-resume-claim' : 'maintenance-arm-claim');
  const handle = await fs.promises.open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ token: r.token, pid: process.pid })); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(r.root, fs);
}
