// Explicit sandbox-only integration: real owner transaction, fixture app/profile,
// throwaway signing key in memory, owned helper processes and no LaunchServices.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createOfflineBinding } from './offline-binding.mjs';
const runtimePath = process.env.BOOTSTRAP_TEST_RUNTIME;
if (!runtimePath) throw new Error('Set BOOTSTRAP_TEST_RUNTIME to the reviewed standalone fixture runtime');
const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'botling-offline-transaction-')));
const children = [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  if (command === '/bin/sh') {
    const script = fs.realpathSync(args[0]);
    assert.ok(script.startsWith(parent + '/'), 'Refuse helper outside owned sandbox');
    fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replaceAll('/usr/bin/open', '/usr/bin/false'));
    const child = originalSpawn.call(this, command, args, options); children.push(child); return child;
  }
  return originalSpawn.call(this, command, args, options);
};
syncBuiltinESMExports();
const runtime = await import(pathToFileURL(runtimePath).href);
const wait = async condition => { const until = Date.now() + 15000; while (Date.now() < until) { if (await condition()) return; await delay(40); } throw new Error('Fixture transaction timed out'); };
const text = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
async function fixture(mode = 'crash') {
  const base = fs.mkdtempSync(join(parent, 'case-')), dataDir = join(base, 'Botling 2 Dev Trial');
  fs.mkdirSync(join(dataDir, 'core'), { recursive: true }); fs.writeFileSync(join(dataDir, 'core/history'), 'original-flushed', { mode: 0o600 });
  const appPath = join(base, 'Botling 2.app'), source = join(base, 'source/Botling 2.app');
  function bundle(app, version, body) {
    fs.mkdirSync(join(app, 'Contents/MacOS'), { recursive: true }); fs.mkdirSync(join(app, 'Contents/Resources/app'), { recursive: true });
    fs.writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.github.william1010121.Botling2</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleExecutable</key><string>TestApp</string></dict></plist>`);
    fs.writeFileSync(join(app, 'Contents/MacOS/TestApp'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    fs.writeFileSync(join(app, 'Contents/Resources/app/package.json'), JSON.stringify({ version, botlingDevTrial: true }));
    fs.mkdirSync(join(app, 'Contents/Resources/mobile'), { recursive: true });
    for (const name of ['index.html', 'web.js']) fs.writeFileSync(join(app, 'Contents/Resources/mobile', name), 'fixture');
  }
  bundle(appPath, '2.0.0', 'exit 0');
  bundle(source, '2.0.1', `printf launched > ${quote(join(base, 'launched'))}\nprintf incompatible > ${quote(join(dataDir, 'core/history'))}\n${mode === 'hang' || mode === 'idle' ? 'exec /bin/sleep 30' : 'exit 1'}`);
  if (mode === 'idle') fs.writeFileSync(join(source, 'Contents/MacOS/TestApp'), `#!/bin/sh\nprintf launched > ${quote(join(base, 'launched'))}\nexec /bin/sleep 30\n`, { mode: 0o755 });
  const zip = source + '.zip'; childProcess.execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', source, zip]);
  const pair = generateKeyPairSync('ed25519'), publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const bytes = fs.readFileSync(zip), manifest = { version: '2.0.1', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  manifest.signature = sign(null, Buffer.from(JSON.stringify([manifest.version, manifest.sha256, manifest.size])), pair.privateKey).toString('base64');
  fs.writeFileSync(zip + '.manifest.json', JSON.stringify(manifest));
  const plan = { appPath, dataDir, planSha256: 'a'.repeat(64) };
  const binding = createOfflineBinding(runtime, plan, { HOME: base, TMPDIR: base });
  let checks = 0;
  const check = async () => { checks++; return { helperPresent: children.some(c => c.exitCode === null && c.signalCode === null) }; };
  const tx = await binding.acquire({ identities: { appIdentity: runtime.filesystemIdentity(appPath), profileIdentity: runtime.filesystemIdentity(dataDir) }, assertQuiescent: check });
  const installer = new runtime.VerifiedInstaller({ current: '2.0.0', appPath, dataDir, publicKey, platform: 'darwin', arch: process.arch,
    fetch: async () => { throw new Error('No network in fixture'); }, profilePin: { appDataDir: base, dataDir, devTrial: true }, bundleFs: fs, maintenance: tx.record });
  const authenticated = await runtime.authenticateLocalBuild(source, appPath, publicKey, fs,
    async (file, args) => ({ stdout: childProcess.execFileSync(file, args, { encoding: 'utf8', timeout: 10000 }) }), process.arch,
    { appDataDir: base, dataDir, devTrial: true });
  await tx.stage(installer, authenticated, check);
  await binding.removeAuthenticationScratch(authenticated);
  return { base, dataDir, appPath, plan, binding, tx, check, checks: () => checks };
}
test.after(async () => {
  // Only children spawned from validated fixture swap.sh can be signalled here.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
  childProcess.spawn = originalSpawn; syncBuiltinESMExports();
  await fsp.rm(parent, { recursive: true, force: true });
});
test('actual signed staging snapshots and pauses, then operator rollback restores old app without launching', async () => {
  const f = await fixture();
  const result = await f.tx.activateAwaitingOperator(f.check);
  assert.equal(result.state, 'awaiting-operator'); assert.ok(f.checks() >= 5);
  assert.equal(fs.existsSync(join(f.base, 'launched')), false);
  assert.equal(text(join(f.tx.record.root, 'data-before/core/history')), 'original-flushed');
  assert.match(text(join(f.appPath, 'Contents/Info.plist')), /2.0.1/);
  await f.tx.rollback(f.check);
  await wait(() => text(join(f.tx.record.root, 'maintenance-terminal')) === 'rolled-back');
  assert.match(text(join(f.appPath, 'Contents/Info.plist')), /2.0.0/);
  assert.equal(text(join(f.dataDir, 'core/history')), 'original-flushed');
  assert.equal(fs.existsSync(join(f.base, 'launched')), false);
  const fresh = createOfflineBinding(runtime, f.plan, { HOME: f.base });
  assert.equal(fresh.status(f.tx.record.token).state, 'rolled-back');
});
test('actual candidate crash restores the snapshot after incompatible writes', async () => {
  const f = await fixture(); await f.tx.activateAwaitingOperator(f.check);
  await f.tx.launch(f.check);
  await wait(() => text(join(f.tx.record.root, 'maintenance-terminal')) === 'rolled-back');
  assert.equal(text(join(f.base, 'launched')), 'launched');
  assert.equal(text(join(f.dataDir, 'core/history')), 'original-flushed');
  assert.match(text(join(f.appPath, 'Contents/Info.plist')), /2.0.0/);
});
test('writer appears after real snapshot: activation is refused and both original generations retained', async () => {
  const f = await fixture();
  const check = async () => {
    if (runtime.maintenancePhase(f.tx.record) === 'awaiting-activation') throw new Error('fixture writer appeared');
    return f.check();
  };
  await assert.rejects(f.tx.activateAwaitingOperator(check), /writer/);
  await f.tx.recordFailure(new Error('fixture writer'));
  await wait(() => text(join(f.tx.record.root, 'maintenance-phase')) === 'recovery-required');
  assert.match(text(join(f.appPath, 'Contents/Info.plist')), /2.0.0/);
  assert.equal(text(join(f.dataDir, 'core/history')), 'original-flushed');
  assert.equal(text(join(f.tx.record.root, 'snapshot.complete')), 'complete');
});
test('helper crash at paused activation resumes through owner API, then rolls back', async () => {
  const f = await fixture(); await f.tx.activateAwaitingOperator(f.check);
  const pid = Number(text(join(f.tx.record.root, 'helper.pid'))), child = children.find(c => c.pid === pid);
  assert.ok(child); const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exited;
  const resumed = await f.binding.resume({ transactionId: f.tx.record.token, assertQuiescent: async () => ({ helperPresent: false }) });
  await resumed.rollback(f.check);
  await wait(() => text(join(f.tx.record.root, 'maintenance-terminal')) === 'rolled-back');
  assert.match(text(join(f.appPath, 'Contents/Info.plist')), /2.0.0/);
  assert.equal(text(join(f.dataDir, 'core/history')), 'original-flushed');
  assert.equal(fs.existsSync(join(f.base, 'launched')), false);
});

test('actual copy is rejected if persistent bytes change before activation, retaining newer live data', async () => {
  const f = await fixture(); let changed = false;
  const check = async () => {
    if (!changed && runtime.maintenancePhase(f.tx.record) === 'awaiting-activation') {
      fs.writeFileSync(join(f.dataDir, 'core/history'), 'concurrent-newer'); changed = true;
    }
    return f.check();
  };
  await assert.rejects(f.tx.activateAwaitingOperator(check), /Snapshot\/profile changed/);
  await f.tx.recordFailure(new Error('snapshot changed'));
  await wait(() => text(join(f.tx.record.root, 'maintenance-phase')) === 'recovery-required');
  assert.equal(text(join(f.dataDir, 'core/history')), 'concurrent-newer');
  assert.equal(text(join(f.tx.record.root, 'data-before/core/history')), 'original-flushed');
  assert.match(text(join(f.appPath, 'Contents/Info.plist')), /2.0.0/);
});
test('post-launch writer uncertainty invalidates through owner API without restoring a stale snapshot', async () => {
  const f = await fixture('hang'); await f.tx.activateAwaitingOperator(f.check);
  await f.tx.launch(f.check); await wait(() => text(join(f.base, 'launched')) === 'launched');
  await f.binding.invalidate();
  await wait(() => text(join(f.tx.record.root, 'maintenance-phase')) === 'recovery-required');
  assert.equal(text(join(f.dataDir, 'core/history')), 'incompatible');
  assert.equal(text(join(f.tx.record.root, 'data-before/core/history')), 'original-flushed');
  assert.ok(fs.existsSync(join(f.tx.record.root, 'previous.app')));
});

for (const boundary of ['before-startup', 'during-receipt']) test(`real startup revocation ${boundary} never returns authorization, even if receipt exists`, async () => {
  const f = await fixture('idle'); await f.tx.activateAwaitingOperator(f.check);
  await f.tx.launch(f.check); await wait(() => text(join(f.base, 'launched')) === 'launched');
  const receipt = join(f.dataDir, 'installed-storage-contract.json');
  let wrapped = fs;
  if (boundary === 'before-startup') await f.binding.invalidate();
  else wrapped = { ...fs, promises: { ...fs.promises, rename: async (from, to) => {
    await fs.promises.rename(from, to);
    if (to === receipt) await f.binding.invalidate();
  } } };
  let authorized = false;
  await assert.rejects((async () => {
    await runtime.authorizeStorageStartup({ dataDir: f.dataDir, target: f.appPath, version: '2.0.1',
      packageContract: { version: 1, epoch: 2 }, coreContract: { version: 1, epoch: 2 }, fs: wrapped,
      argv: ['--botling-update-token=' + f.tx.record.token, '--botling-maintenance-launch=' + f.tx.record.token] });
    authorized = true;
  })(), /invalidated/);
  assert.equal(authorized, false);
  assert.equal(fs.existsSync(receipt), boundary === 'during-receipt');
  await wait(() => f.binding.status().state === 'recovery-required');
  assert.equal(text(join(f.dataDir, 'core/history')), 'original-flushed');
  assert.ok(runtime.readMaintenance(f.dataDir, f.appPath));
});
