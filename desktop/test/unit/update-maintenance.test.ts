import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { payload } from '../../scripts/release-manifest.mjs';
import { VerifiedInstaller, recoverUpdates, resumeMaintenance } from '../../src/main/update-install';
import { beginMaintenance, invalidateMaintenance, permitMaintenance, maintenancePhase, maintenanceEnvironment, checkMaintenanceStartup, readMaintenance } from '../../src/main/update-maintenance';
import { checkStorageStartup } from '../../src/main/storage-startup';
import { tempDir, until } from '../helpers';
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: (cmd: string, args: string[] = [], options?: any) => {
    if (cmd === '/bin/sh') {
      const script = args[0];
      if (!fs.realpathSync(script).startsWith(fs.realpathSync('.cache/test-data') + '/')) throw new Error('Not an owned fixture');
      fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replaceAll('/usr/bin/open', '/usr/bin/false'));
    }
    return actual.spawn(cmd, args, options);
  } };
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function put(path: string, text: string, mode = 0o600) { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, text, { mode }); }
const idle = async () => {};
async function fixture(mode: 'crash' | 'healthy' | 'hang' = 'crash') {
  const base = fs.realpathSync(tempDir('maintenance'));
  const data = join(base, 'Botling 2 Dev Trial'), target = join(base, 'Botling 2.app');
  put(join(data, 'core/history'), 'original-flushed');
  put(join(data, 'installed-storage-contract.json'), '{"version":1,"epoch":2}');
  function app(path: string, version: string, body: string) {
    put(join(path, 'Contents/Info.plist'), `<plist><dict><key>CFBundleIdentifier</key><string>io.github.william1010121.Botling2</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>TestApp</string></dict></plist>`);
    put(join(path, 'Contents/MacOS/TestApp'), '#!/bin/sh\n' + body, 0o755);
    put(join(path, 'Contents/Resources/app/package.json'), JSON.stringify({ version, botlingDevTrial: true }));
  }
  app(target, '2.0.0', `echo unexpected-old-launch > '${base}/old-launched'`);
  const r = await beginMaintenance({ target, dataDir: data, planSha256: 'a'.repeat(64) }, idle);
  const source = join(base, 'source/Botling 2.app');
  app(source, '2.0.1', `echo launched > '${base}/launched'\nprintf incompatible > '${data}/core/history'\n${mode === 'crash' ? 'exit 1' : `${mode === 'healthy' ? `printf '${r.token}' > '${r.root}/boot.ok'` : ':'}; exec /bin/sleep 60`}\n`);
  const zip = join(base, 'signed.zip'); execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', source, zip]);
  const keys = generateKeyPairSync('ed25519'), bytes = fs.readFileSync(zip);
  const fields = { version: '2.0.1', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  put(zip + '.manifest.json', JSON.stringify({ ...fields, signature: sign(null, payload(fields), keys.privateKey).toString('base64') }));
  const installer = new VerifiedInstaller({ current: '2.0.0', appPath: target, dataDir: data, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    platform: 'darwin', arch: process.arch, fetch: async () => { throw new Error('local only'); }, maintenance: r,
    profilePin: { appDataDir: base, dataDir: data, devTrial: true } });
  const kill = (name: string) => { try { process.kill(Number(fs.readFileSync(join(r.root, name), 'utf8')), 'SIGKILL'); } catch {} };
  cleanup.push(async () => { kill('helper.pid'); kill('new.pid'); await new Promise(r => setTimeout(r, 150)); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, data, target, r, installer, zip, kill };
}
async function paused(f: Awaited<ReturnType<typeof fixture>>) {
  await f.installer.stageLocal(f.zip, '2.0.1');
  await f.installer.startMaintenance(idle, { HOME: f.base, TMPDIR: f.base, NODE_OPTIONS: '--invalid', BOTLING_DATA_DIR: '/wrong' });
  await until(() => maintenancePhase(f.r) === 'awaiting-snapshot');
  expect(fs.existsSync(join(f.r.root, 'snapshot.complete'))).toBe(false);
  await permitMaintenance(f.r, 'snapshot', idle);
  await until(() => maintenancePhase(f.r) === 'awaiting-activation', { timeout: 10000 });
  expect(fs.readFileSync(join(f.r.root, 'data-before/core/history'), 'utf8')).toBe('original-flushed');
  await permitMaintenance(f.r, 'activate', idle);
  await until(() => maintenancePhase(f.r) === 'activated-awaiting-operator-launch', { timeout: 10000 });
  expect(fs.existsSync(join(f.base, 'launched'))).toBe(false);
  expect(fs.readFileSync(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('2.0.1');
}
it('offline replacement pauses without launching; explicit rollback restores old app without reopening it', async () => {
  const f = await fixture(); await paused(f);
  expect(() => checkStorageStartup({ dataDir: f.data, target: f.target, version: '2.0.1', packageContract: { version: 1, epoch: 2 }, coreContract: { version: 1, epoch: 2 }, argv: [], fs })).toThrow(/Maintenance/);
  await recoverUpdates(f.data, f.target);
  expect(fs.existsSync(join(f.r.root, 'previous.app'))).toBe(true);
  await permitMaintenance(f.r, 'rollback', idle);
  await until(() => fs.existsSync(join(f.r.root, 'maintenance-terminal')), { timeout: 10000 });
  expect(fs.readFileSync(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('2.0.0');
  expect(fs.readFileSync(join(f.data, 'core/history'), 'utf8')).toBe('original-flushed');
  expect(fs.existsSync(join(f.base, 'launched')) || fs.existsSync(join(f.base, 'old-launched'))).toBe(false);
});
it('explicit candidate launch failure restores the same app/profile snapshot and never reopens the old app', async () => {
  const f = await fixture(); await paused(f); await permitMaintenance(f.r, 'launch', idle);
  await until(() => fs.existsSync(join(f.r.root, 'maintenance-terminal')), { timeout: 10000 });
  expect(fs.readFileSync(join(f.r.root, 'maintenance-terminal'), 'utf8')).toBe('rolled-back');
  expect(fs.readFileSync(join(f.data, 'core/history'), 'utf8')).toBe('original-flushed');
  expect(fs.readFileSync(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('2.0.0');
  expect(fs.existsSync(join(f.base, 'old-launched'))).toBe(false);
});
it('paused helper interruption is discoverable and resumes only to the same operator pause before rollback', async () => {
  const f = await fixture(); await paused(f); f.kill('helper.pid');
  await new Promise(r => setTimeout(r, 200));
  expect(readMaintenance(f.data, f.target)?.token).toBe(f.r.token);
  expect(() => checkMaintenanceStartup(f.data, f.target, [])).toThrow(/Maintenance/);
  await resumeMaintenance(f.r, idle, { HOME: f.base });
  await new Promise(r => setTimeout(r, 200));
  expect(fs.existsSync(join(f.base, 'launched'))).toBe(false);
  await permitMaintenance(f.r, 'rollback', idle);
  await until(() => fs.existsSync(join(f.r.root, 'maintenance-terminal')), { timeout: 10000 });
  expect(fs.readFileSync(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('2.0.0');
});
it('uncertain writer check invalidates the snapshot and cannot be retried into activation', async () => {
  const f = await fixture(); await f.installer.stageLocal(f.zip, '2.0.1'); await f.installer.startMaintenance(idle, { HOME: f.base });
  await until(() => maintenancePhase(f.r) === 'awaiting-snapshot');
  await permitMaintenance(f.r, 'snapshot', idle);
  await until(() => maintenancePhase(f.r) === 'awaiting-activation', { timeout: 10000 });
  await expect(permitMaintenance(f.r, 'activate', async () => { throw new Error('unknown writer'); })).rejects.toThrow('unknown writer');
  await until(() => maintenancePhase(f.r) === 'recovery-required', { timeout: 10000 });
  expect(fs.readFileSync(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('2.0.0');
  expect(fs.existsSync(join(f.base, 'launched'))).toBe(false);
  await expect(resumeMaintenance(f.r, idle, {})).rejects.toThrow(/recovery/);
});
it('helper environment strips inherited injection/profile overrides', () => {
  expect(maintenanceEnvironment({ HOME: '/tmp/fixture', NODE_OPTIONS: '--import=bad', DYLD_INSERT_LIBRARIES: 'bad', BOTLING_DATA_DIR: 'bad', ELECTRON_RUN_AS_NODE: '1' }))
    .toEqual({ HOME: '/tmp/fixture', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', BOTLING_UPDATE_OFFLINE: '1' });
});

it('explicit healthy launch commits and clears maintenance only after the boot receipt', async () => {
  const f = await fixture('healthy'); await paused(f);
  await permitMaintenance(f.r, 'launch', idle);
  await until(() => !fs.existsSync(join(f.data, 'update-maintenance.json')), { timeout: 10000 });
  expect(fs.readFileSync(join(f.r.root, 'maintenance-terminal'), 'utf8')).toBe('committed');
  expect(readMaintenance(f.data, f.target)).toBeNull();
  expect(fs.readFileSync(join(f.target, 'Contents/Info.plist'), 'utf8')).toContain('2.0.1');
  expect(fs.readFileSync(join(f.data, 'core/history'), 'utf8')).toBe('incompatible');
});
it('compatible maintenance launch still requires real snapshot provenance and rejects token replay', async () => {
  const f = await fixture(); await paused(f);
  const options = { dataDir: f.data, target: f.target, version: '2.0.1', packageContract: { version: 1, epoch: 2 }, coreContract: { version: 1, epoch: 2 }, argv: ['--botling-update-token=' + f.r.token, '--botling-maintenance-launch=' + f.r.token], fs };
  expect(() => checkStorageStartup(options)).toThrow(/Maintenance/);
  put(join(f.r.root, 'maintenance-phase'), 'launching');
  expect(() => checkStorageStartup(options)).not.toThrow();
  fs.renameSync(join(f.r.root, 'snapshot.complete'), join(f.r.root, 'snapshot.hidden'));
  expect(() => checkStorageStartup(options)).toThrow(/snapshot-protected/);
  fs.renameSync(join(f.r.root, 'snapshot.hidden'), join(f.r.root, 'snapshot.complete'));
  put(join(f.r.root, 'maintenance-phase'), 'activated-awaiting-operator-launch');
  expect(() => checkStorageStartup(options)).toThrow(/Maintenance/);
  await permitMaintenance(f.r, 'rollback', idle);
  await until(() => fs.existsSync(join(f.r.root, 'maintenance-terminal')), { timeout: 10000 });
});
it('tampering during the operator pause cannot obtain a launch permit', async () => {
  const f = await fixture(); await paused(f);
  fs.appendFileSync(join(f.target, 'Contents/MacOS/TestApp'), '#changed');
  await expect(permitMaintenance(f.r, 'launch', idle)).rejects.toThrow('candidate changed');
  expect(fs.existsSync(join(f.r.root, 'operator-choice'))).toBe(false);
  expect(fs.existsSync(join(f.base, 'launched'))).toBe(false);
  await permitMaintenance(f.r, 'rollback', idle);
  await until(() => maintenancePhase(f.r) === 'rolled-back', { timeout: 10000 });
});

it('competing helper handoffs cannot arm the same transaction twice', async () => {
  const f = await fixture(); await f.installer.stageLocal(f.zip, '2.0.1');
  const results = await Promise.allSettled([f.installer.startMaintenance(idle, {}), f.installer.startMaintenance(idle, {})]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  await until(() => maintenancePhase(f.r) === 'awaiting-snapshot');
  expect(fs.existsSync(join(f.r.root, 'snapshot.complete'))).toBe(false);
});

it('writer uncertainty after explicit launch retains generations without restoring an invalidated snapshot', async () => {
  const f = await fixture('hang'); await paused(f); await permitMaintenance(f.r, 'launch', idle);
  await until(() => fs.existsSync(join(f.base, 'launched')));
  await invalidateMaintenance(f.r);
  await until(() => maintenancePhase(f.r) === 'recovery-required', { timeout: 10000 });
  expect(fs.readFileSync(join(f.data, 'core/history'), 'utf8')).toBe('incompatible');
  expect(fs.readFileSync(join(f.r.root, 'data-before/core/history'), 'utf8')).toBe('original-flushed');
  expect(fs.existsSync(join(f.r.root, 'previous.app'))).toBe(true);
  expect(fs.existsSync(join(f.r.root, 'maintenance-terminal'))).toBe(false);
  expect(() => checkMaintenanceStartup(f.data, f.target, [])).toThrow(/Maintenance/);
});
