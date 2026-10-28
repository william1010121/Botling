import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createProcessOwnership } from './process-ownership.mjs';
import { parseProcesses, createWriterCheck } from './offline-processes.mjs';
import { watchWindow } from './offline-watch.mjs';
const originalSpawn = childProcess.spawn;
function inspect(pid) {
  const options = { encoding: 'utf8', timeout: 1000 };
  const a = childProcess.execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,uid=,lstart=,comm='], options);
  const b = childProcess.execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'pid=,args='], options);
  return parseProcesses(a, b)[0];
}
function sandbox() {
  const sandboxParent = new URL('./.generated/', import.meta.url).pathname; fs.mkdirSync(sandboxParent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(join(sandboxParent, 'bootstrap-owned-race-')));
  const appPath = join(root, 'Botling 2.app'), dataDir = join(root, 'profile');
  fs.mkdirSync(join(appPath, 'Contents'), { recursive: true }); fs.mkdirSync(dataDir);
  fs.writeFileSync(join(appPath, 'Contents/Info.plist'), 'fixture');
  const script = join(root, 'readonly.sh');
  fs.writeFileSync(script, 'exec 3< "$1/Contents/Info.plist"; /bin/sleep 0.25\n');
  const children = [], captures = new Map(), extra = new Set();
  const ownership = createProcessOwnership({ inspect: pid => { const row = inspect(pid); captures.set(pid, row); return row; } });
  ownership.install();
  const self = inspect(process.pid);
  let scans = 0;
  const runner = async (command, args) => {
    await delay(1); // overlap the watcher with spawn and the publication interval
    const rows = [self];
    for (const pid of new Set([...captures.keys(), ...extra])) {
      try { rows.push(inspect(pid)); }
      catch { /* own already-exited fixture only; no arbitrary PID is queried */ }
    }
    if (command === '/usr/sbin/lsof') {
      // PID-scoped native open-file observations only, never the user's census.
      let out = `p${self.pid}\0cnode\0\nf1\0n/dev/null\0\n`;
      for (const row of rows.slice(1)) {
        try { out += childProcess.execFileSync('/usr/sbin/lsof', ['-nP', '-p', String(row.pid), '-F0pcfn'], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}
      }
      return out;
    }
    scans++;
    return args.at(-1).includes('lstart') ? rows.map(p => `${p.pid} ${p.ppid} ${p.uid} ${p.start} ${p.executable}`).join('\n')
      : rows.map(p => `${p.pid} ${p.args}`).join('\n');
  };
  const check = createWriterCheck({ appPath, dataDir, ownership, helper: () => null }, runner);
  const finish = async () => {
    ownership.restore();
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, appPath, dataDir, script, ownership, captures, extra, children, check, finish, scans: () => scans };
}
test('real gated readonly child is attested before a captured gate census decision', async () => {
  const f = sandbox();
  try {
    await f.ownership.run('approved-readonly', async () => {
      const work = promisify(childProcess.execFile)('/bin/sh', [f.script, f.appPath], { encoding: 'utf8' });
      f.children.push(work.child);
      const captured = f.captures.get(work.child.pid);
      assert.equal(captured.ppid, process.pid); assert.equal(captured.executable, '/bin/sh');
      assert.equal(f.ownership.attestObservations([captured]).length, 1);
      assert.equal(f.ownership.attestObservations([{ ...captured, start: 'different birth' }]).length, 0);
      assert.equal(f.ownership.attestObservations([{ ...captured, ppid: 1 }]).length, 0);
      assert.equal(f.ownership.attestObservations([{ ...captured, args: captured.args + ' injected' }]).length, 0);
      await f.check(); await work;
    });
  } finally { await f.finish(); }
});
test('actual foreground watcher overlaps helper spawn before helper.pid publication', async () => {
  const f = sandbox(); let watcher;
  try {
    const record = { root: join(f.root, '.botling-update-fixture'), target: f.appPath, dataDir: f.dataDir, token: '11111111-1111-1111-1111-111111111111' };
    fs.mkdirSync(record.root);
    fs.writeFileSync(join(record.root, 'maintenance-stage.json'), JSON.stringify({ dataDir: f.dataDir, pending: { root: record.root, target: f.appPath, token: record.token, executable: 'Fixture' } }));
    const script = join(record.root, 'swap.sh');
    fs.writeFileSync(script, `/bin/sleep 0.3; printf '%s' $$ > '${record.root}/helper.pid'; /bin/sleep 0.3\n`);
    let invalidations = 0; watcher = watchWindow(f.check, async () => { invalidations++; }, 1);
    const args = [script, '', f.appPath, join(record.root, 'Botling 2.app'), join(record.root, 'previous.app'), join(record.root, 'boot.ok'), record.token, 'Fixture', '0', '0.1', f.dataDir, '1200', '50'];
    const child = f.ownership.withHelper(record, false, () => childProcess.spawn('/bin/sh', args, { stdio: 'ignore' })); f.children.push(child);
    assert.equal(fs.existsSync(join(record.root, 'helper.pid')), false);
    assert.equal(f.ownership.helperFor(record).pid, child.pid);
    await watcher.check(); await new Promise(resolve => child.once('exit', resolve));
    await watcher.stop(); assert.equal(invalidations, 0); assert.ok(f.scans() >= 4);
  } finally { if (watcher) await watcher.stop(); await f.finish(); }
});
test('same executable and real parent do not exempt an unregistered sibling writer', async () => {
  const f = sandbox();
  try {
    const child = originalSpawn('/bin/sh', [f.script, f.appPath], { stdio: 'ignore' }); f.children.push(child); f.extra.add(child.pid);
    await assert.rejects(f.check(), /Maintenance refused/);
  } finally { await f.finish(); }
});
test('registry has no authority outside the explicit operation scope', async () => {
  const f = sandbox();
  try {
    const work = promisify(childProcess.execFile)('/bin/sh', [f.script, f.appPath], { encoding: 'utf8' }); f.children.push(work.child); f.extra.add(work.child.pid);
    await assert.rejects(f.check(), /Maintenance refused/); await work;
    assert.equal(f.captures.size, 0);
  } finally { await f.finish(); }
});
test('real lipo and PlistBuddy on fixture files overlap the watcher without invalidation', async () => {
  const f = sandbox(); let watcher;
  try {
    fs.mkdirSync(join(f.appPath, 'Contents/MacOS'));
    fs.copyFileSync('/bin/sh', join(f.appPath, 'Contents/MacOS/Fixture'));
    fs.writeFileSync(join(f.appPath, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>2.0.0</string></dict></plist>');
    let invalidations = 0; watcher = watchWindow(f.check, async () => { invalidations++; }, 1);
    await f.ownership.run('fixture-native-verification', async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        for (const [file, args] of [
          ['/usr/bin/lipo', ['-archs', join(f.appPath, 'Contents/MacOS/Fixture')]],
          ['/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(f.appPath, 'Contents/Info.plist')]],
        ]) {
          const work = promisify(childProcess.execFile)(file, args, { encoding: 'utf8' }); f.children.push(work.child);
          try { await work; } catch (error) { throw new Error(watcher.failure?.message || error.message); }
        }
      }
    });
    await watcher.check(); await watcher.stop();
    assert.equal(invalidations, 0); assert.ok(f.scans() >= 4);
  } finally { if (watcher) await watcher.stop(); await f.finish(); }
});
test('unknown sibling during an active census aborts a registered gate without executing it', async () => {
  const f = sandbox();
  try {
    const pass = f.check();
    const marker = join(f.root, 'must-not-execute');
    const work = f.ownership.run('fixture-gated', () => promisify(childProcess.execFile)('/bin/sh', ['-c', `printf bad > '${marker}'`, f.appPath], { encoding: 'utf8' }));
    f.children.push(work.child);
    const refused = assert.rejects(work);
    const stranger = originalSpawn('/bin/sh', [f.script, f.appPath], { stdio: 'ignore' }); f.children.push(stranger); f.extra.add(stranger.pid);
    await assert.rejects(pass, /Maintenance refused/); await refused;
    assert.equal(fs.existsSync(marker), false);
  } finally { await f.finish(); }
});
test('resumed helper is attested while the old exited helper PID is still published', async () => {
  const f = sandbox();
  try {
    const old = originalSpawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' }); f.children.push(old);
    await new Promise(resolve => old.once('exit', resolve));
    const record = { root: join(f.root, '.botling-update-resume'), target: f.appPath, dataDir: f.dataDir, token: '22222222-2222-2222-2222-222222222222' };
    fs.mkdirSync(record.root); fs.writeFileSync(join(record.root, 'helper.pid'), String(old.pid));
    fs.writeFileSync(join(record.root, 'maintenance-stage.json'), JSON.stringify({ dataDir: f.dataDir, pending: { root: record.root, target: f.appPath, token: record.token, executable: 'Fixture' } }));
    const script = join(record.root, 'swap.sh'); fs.writeFileSync(script, `/bin/sleep 0.3; printf '%s' $$ > '${record.root}/helper.pid'; /bin/sleep 0.1\n`);
    const args = [script, '', f.appPath, join(record.root, 'Botling 2.app'), join(record.root, 'previous.app'), join(record.root, 'boot.ok'), record.token, 'Fixture', '0', '0.1', f.dataDir, '0', '50'];
    const child = f.ownership.withHelper(record, true, () => childProcess.spawn('/bin/sh', args, { stdio: 'ignore' })); f.children.push(child);
    assert.equal(f.ownership.helperFor(record, old.pid).pid, child.pid);
    assert.throws(() => f.ownership.helperFor(record, old.pid + child.pid), /publication differs/);
    await f.check(); await new Promise(resolve => child.once('exit', resolve));
    assert.equal(Number(fs.readFileSync(join(record.root, 'helper.pid'), 'utf8')), child.pid);
  } finally { await f.finish(); }
});
test('unfinished census cannot release a command: handshake times out without target effects', async () => {
  const f = sandbox(); const finish = f.ownership.beginCensus();
  try {
    const marker = join(f.root, 'never-executed'), began = Date.now();
    const work = f.ownership.run('fixture-deadline', () => promisify(childProcess.execFile)('/bin/sh', ['-c', `printf bad > '${marker}'`], { encoding: 'utf8' })); f.children.push(work.child);
    await assert.rejects(work, error => error.code === 125);
    assert.ok(Date.now() - began < 7000); assert.equal(fs.existsSync(marker), false);
  } finally { finish(false); await f.finish(); }
});
test('gate ignores exported shell functions without changing its actual UID', async () => {
  const f = sandbox();
  try {
    const marker = join(f.root, 'injected-function');
    const work = f.ownership.run('fixture-hostile-shell-env', () => promisify(childProcess.execFile)('/usr/bin/true', [], {
      env: { PATH: '/usr/bin:/bin', 'BASH_FUNC_exec%%': `() { printf bad > '${marker}'; }` }, encoding: 'utf8',
    })); f.children.push(work.child);
    await work;
    assert.equal(f.captures.get(work.child.pid).uid, process.getuid());
    assert.equal(fs.existsSync(marker), false);
  } finally { await f.finish(); }
});
