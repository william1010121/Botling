import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { join, dirname } from 'node:path';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPackage } from '@electron/asar';
import { payload } from '../../scripts/release-manifest.mjs';
import { authenticateLocalBuild, exactTree } from '../../src/main/hot-auth';
import { HotTransaction, durableJSON } from '../../src/main/hot-transaction';
import { HotInstaller, bundlePrints, planInstall, type Run } from '../../src/main/hot-install';
import { tempDir } from '../helpers';
const execute = promisify(execFile);
const run: Run = (file, args) => execute(file, args);
const keys = generateKeyPairSync('ed25519');
const key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
function put(path: string, bytes: string) { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, bytes); }
async function bundle(parent: string, version: string, mobile = 'mobile-v1', shell = 'shell-v1') {
  const app = join(parent, 'Botling 2.app');
  put(join(app, 'Contents/Info.plist'), `<plist><dict><key>CFBundleIdentifier</key><string>io.github.william1010121.Botling2</string><key>CFBundleExecutable</key><string>Botling 2</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  put(join(app, 'Contents/MacOS/Botling 2'), 'launcher'); fs.chmodSync(join(app, 'Contents/MacOS/Botling 2'), 0o755);
  put(join(app, 'Contents/Resources/mobile/index.html'), '<script src="./web.js"></script>');
  put(join(app, 'Contents/Resources/mobile/web.js'), mobile);
  const source = join(parent, 'src');
  put(join(source, 'package.json'), JSON.stringify({ version, main: 'out/main/main.cjs', botlingStorageContract: { version: 1, epoch: 2 } }));
  put(join(source, 'out/main/main.cjs'), 'kernel'); put(join(source, 'out/preload/preload.cjs'), 'preload');
  put(join(source, 'out/core/main.cjs'), 'core');
  put(join(source, 'out/core/storage-contract.json'), JSON.stringify({ version: 1, epoch: 2 }));
  put(join(source, 'out/renderer/index.html'), shell);
  await createPackage(source, join(app, 'Contents/Resources/app.asar'));
  return app;
}
async function signed(app: string, version: string) {
  const zip = `${app}.zip`;
  await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  const bytes = fs.readFileSync(zip);
  const manifest = { version, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  put(`${zip}.manifest.json`, JSON.stringify({ ...manifest, signature: sign(null, payload(manifest), keys.privateKey).toString('base64') }));
  return zip;
}
async function fixture(shell = 'shell-v1') {
  const root = fs.realpathSync(tempDir('mobile-hot-apply'));
  const target = await bundle(join(root, 'installed'), '2.0.0');
  const candidate = await bundle(join(root, 'built'), '2.0.1', 'mobile-v2', shell);
  await signed(candidate, '2.0.1');
  const auth = () => authenticateLocalBuild(candidate, target, key, fs, run);
  return { root, target, candidate, auth };
}
describe('signed mobile hot application', () => {
  it('authenticates full ZIP bytes and classifies mobile as hot with a core handover', async () => {
    const f = await fixture(); const a = await f.auth();
    expect(await exactTree(a.app, fs)).toBe(await exactTree(f.candidate, fs));
    expect(planInstall(await bundlePrints(f.target, fs), await bundlePrints(a.app, fs))).toEqual({ mode: 'hot', parts: ['core', 'mobile'] });
    put(join(f.candidate, 'Contents/Resources/mobile/web.js'), 'tampered');
    await expect(f.auth()).rejects.toThrow('differs from signed ZIP');
  });
  it('real HotInstaller entry rejects unsigned input before staging, copying or runtime calls', async () => {
    const f = await fixture(); fs.unlinkSync(`${f.candidate}.zip.manifest.json`);
    let called = false;
    const installer = new HotInstaller({ target: f.target, dataDir: join(f.root, 'data'), fs, run, authenticate: f.auth,
      notify: () => { called = true; }, ports: {} as never });
    const before = await exactTree(f.target, fs);
    expect(await installer.install({ path: f.candidate, requester: 'test', note: '', from: '2.0.0', to: '2.0.1' })).toMatchObject({ ok: false, plan: { blocked: true } });
    expect(called).toBe(false); expect(await exactTree(f.target, fs)).toBe(before);
  });
  it('unknown/mismatched storage metadata never authorizes a hot migration', async () => {
    const f = await fixture(); const before = await bundlePrints(f.target, fs), after = await bundlePrints(f.candidate, fs);
    expect(planInstall({ ...before, storageContract: null }, after)).toMatchObject({ mode: 'restart' });
    expect(planInstall(before, { ...after, storageContract: { version: 1, epoch: 3 } })).toMatchObject({ mode: 'restart' });
  });
  it.each(['missing', 'mismatch'] as const)('signed %s storage sidecar is rejected before any runtime activation', async kind => {
    const f = await fixture(); const source = join(dirname(f.candidate), 'src');
    const sidecar = join(source, 'out/core/storage-contract.json');
    if (kind === 'missing') fs.unlinkSync(sidecar); else put(sidecar, JSON.stringify({ version: 1, epoch: 3 }));
    await createPackage(source, join(f.candidate, 'Contents/Resources/app.asar')); await signed(f.candidate, '2.0.1');
    const before = await exactTree(f.target, fs);
    const installer = new HotInstaller({ target: f.target, dataDir: join(f.root, 'data'), fs, run, authenticate: f.auth,
      notify: () => { throw new Error('must not activate'); }, ports: {} as never });
    expect(await installer.install({ path: f.candidate, requester: 'test', note: '', from: '2.0.0', to: '2.0.1' })).toMatchObject({ ok: false, plan: { mode: 'restart', reasons: [expect.stringContaining('storage compatibility')] } });
    expect(await exactTree(f.target, fs)).toBe(before);
  });
  it.each(['success', 'start-failure', 'shell-failure'] as const)('real signed entry coordinates mobile with runtime and disk: %s', async failure => {
    const f = await fixture('shell-v2'), data = join(f.root, 'data');
    const old = await exactTree(f.target, fs), reports: any[] = [], mobile: string[] = []; let loads = 0;
    const installer = new HotInstaller({ target: f.target, dataDir: data, fs, run, authenticate: f.auth,
      notify: r => reports.push(r), ports: {
        coreScript: () => '/unused-old-core',
        swapCore: async script => {
          expect(fs.existsSync(join(data, 'hot-install-pending.json'))).toBe(true);
          mobile.push(fs.readFileSync(join(f.target, 'Contents/Resources/mobile/web.js'), 'utf8'));
          if (failure === 'start-failure' && mobile.length === 1) return { ok: false, stage: 'start', error: 'synthetic start failure', rolledBack: true };
          return { ok: true, script, entries: 0, interrupted: [], ms: 1 };
        },
        useRenderer: () => '/previous-renderer', reloadChat: async () => true,
        reloadShell: async () => failure !== 'shell-failure' || ++loads > 1, log: () => {},
      } });
    expect(await installer.install({ path: f.candidate, requester: 'test', note: '', from: '2.0.0', to: '2.0.1' })).toMatchObject({ ok: true });
    await expect.poll(() => reports.length).toBe(1);
    expect(reports[0]).toMatchObject({ ok: failure === 'success', disk: failure === 'success' ? 'installed' : 'restored' });
    expect(mobile).toEqual(failure === 'success' ? ['mobile-v2'] : ['mobile-v2', 'mobile-v1']);
    expect(fs.existsSync(join(data, 'hot-install-pending.json'))).toBe(false);
    if (failure !== 'success') expect(await exactTree(f.target, fs)).toBe(old);
  });
  it('failed runtime rollback retains both generations and fences subsequent requests/installs', async () => {
    const f = await fixture('shell-v2'), data = join(f.root, 'data'), scripts: string[] = [], reports: any[] = [];
    const installer = new HotInstaller({ target: f.target, dataDir: data, fs, run, authenticate: f.auth, notify: r => reports.push(r), ports: {
      coreScript: () => '/unused', swapCore: async script => {
        scripts.push(script);
        return scripts.length === 1 ? { ok: true, script, entries: 0, interrupted: [], ms: 1 } : { ok: false, stage: 'start', error: 'rollback failed', rolledBack: false };
      }, useRenderer: () => '/previous', reloadChat: async () => true, reloadShell: async () => false, log: () => {},
    } });
    await installer.install({ path: f.candidate, requester: 'test', note: '', from: '2.0.0', to: '2.0.1' });
    await expect.poll(() => reports.length).toBe(1);
    expect(reports[0]).toMatchObject({ ok: false, applied: ['core', 'shell'] });
    expect(fs.existsSync(join(data, 'hot-install-pending.json'))).toBe(true);
    expect(scripts).toHaveLength(2); expect(scripts.every(path => fs.existsSync(path))).toBe(true);
    expect((await installer.plan(f.candidate)).plan).toMatchObject({ blocked: true });
  });
  it('rejects missing mobile, an older candidate, wrong trust and escaping symlinks', async () => {
    const f = await fixture();
    await expect(authenticateLocalBuild(f.candidate, f.target, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString(), fs, run)).rejects.toThrow('signature');
    await expect(authenticateLocalBuild(f.target, f.candidate, key, fs, run)).rejects.toThrow('newer');
    fs.rmSync(join(f.candidate, 'Contents/Resources/mobile'), { recursive: true }); await signed(f.candidate, '2.0.1');
    await expect(f.auth()).rejects.toThrow();
    fs.symlinkSync('/tmp', join(f.candidate, 'Contents/Resources/mobile')); await signed(f.candidate, '2.0.1');
    await expect(f.auth()).rejects.toThrow(/symlink|ZIP/);
  });
});
describe('whole-generation transaction recovery', () => {
  it('recovers before exchange, after exchange and after rollback acknowledgement loss', async () => {
    const f = await fixture(), a = await f.auth(), data = join(f.root, 'data');
    let tx = new HotTransaction(data, fs, run);
    const old = await exactTree(f.target, fs);
    await tx.prepare(f.target, a.app, a.digest);
    expect(await new HotTransaction(data, fs, run).recover(f.target)).toBe(false);
    await tx.prepare(f.target, a.app, a.digest); await tx.activate();
    expect(await exactTree(f.target, fs)).toBe(a.digest);
    tx = new HotTransaction(data, fs, run);
    expect(await tx.rollback()).toBe(true);
    expect(fs.existsSync(tx.file)).toBe(true); // still fences requests until runtime rollback completes
    expect(await exactTree(f.target, fs)).toBe(old);
    expect(await new HotTransaction(data, fs, run).recover(f.target)).toBe(false);
    expect(fs.existsSync(tx.file)).toBe(false);
  });
  it('startup after candidate exchange restores the complete old asar+mobile pair', async () => {
    const f = await fixture(), a = await f.auth(), data = join(f.root, 'data');
    const tx = new HotTransaction(data, fs, run), old = await exactTree(f.target, fs);
    await tx.prepare(f.target, a.app, a.digest); await tx.activate();
    expect(await new HotTransaction(data, fs, run).recover(f.target)).toBe(true);
    expect(await exactTree(f.target, fs)).toBe(old);
    expect(fs.readFileSync(join(f.target, 'Contents/Resources/mobile/web.js'), 'utf8')).toBe('mobile-v1');
  });
  it('durable committed decision survives lost cleanup, but tampered recovery paths fail closed', async () => {
    const f = await fixture(), a = await f.auth(); const tx = new HotTransaction(join(f.root, 'data'), fs, run);
    await tx.prepare(f.target, a.app, a.digest); await tx.activate();
    const journal = JSON.parse(fs.readFileSync(tx.file, 'utf8'));
    await durableJSON(tx.file, { ...journal, committed: true }, fs);
    expect(await tx.recover(f.target)).toBe(false); expect(await exactTree(f.target, fs)).toBe(a.digest);
    await durableJSON(tx.file, { ...journal, candidate: join(f.root, 'other.app') }, fs);
    await expect(tx.recover(f.target)).rejects.toThrow('paths');
    expect(await exactTree(f.target, fs)).toBe(a.digest);
  });
  it('exchange failure leaves the original whole bundle and recoverable journal', async () => {
    const f = await fixture(), a = await f.auth(); const old = await exactTree(f.target, fs);
    const tx = new HotTransaction(join(f.root, 'data'), fs, async () => { throw new Error('exchange failed'); });
    await tx.prepare(f.target, a.app, a.digest); await expect(tx.activate()).rejects.toThrow('exchange failed');
    expect(await exactTree(f.target, fs)).toBe(old); expect(await tx.recover()).toBe(false);
  });
});

it('pins signed candidate to trial profile for ordinary subsequent launches', async () => {
  const f = await fixture();
  const appDataDir = join(f.root, 'Application Support');
  const pin = { appDataDir, dataDir: join(appDataDir, 'Botling 2 Dev Trial'), devTrial: true };
  fs.mkdirSync(pin.dataDir, { recursive: true }); fs.mkdirSync(join(appDataDir, 'Botling 2'));
  const { VerifiedInstaller } = await import('../../src/main/update-install');
  const installer = new VerifiedInstaller({ current: '2.0.0', appPath: f.target, dataDir: pin.dataDir,
    publicKey: key, platform: 'darwin', arch: process.arch, profilePin: pin,
    fetch: async () => { throw new Error('local only'); } });
  await expect(authenticateLocalBuild(f.candidate, f.target, key, fs, run, process.arch, pin)).rejects.toThrow('profile');
  await expect(installer.stageLocal(`${f.candidate}.zip`, '2.0.1')).rejects.toThrow('profile');
  const source = join(dirname(f.candidate), 'src');
  const pkg = JSON.parse(fs.readFileSync(join(source, 'package.json'), 'utf8'));
  put(join(source, 'package.json'), JSON.stringify({ ...pkg, botlingDevTrial: true }));
  await createPackage(source, join(f.candidate, 'Contents/Resources/app.asar')); await signed(f.candidate, '2.0.1');
  await authenticateLocalBuild(f.candidate, f.target, key, fs, run, process.arch, pin);
  await installer.stageLocal(`${f.candidate}.zip`, '2.0.1'); expect(installer.ready).toBe('2.0.1');
  await installer.discard();
  const { packagedDataDir } = await import('../../src/main/main-environment');
  expect(packagedDataDir(appDataDir, pkg.botlingDevTrial === true)).not.toBe(pin.dataDir);
  expect(packagedDataDir(appDataDir, true)).toBe(pin.dataDir);
});
