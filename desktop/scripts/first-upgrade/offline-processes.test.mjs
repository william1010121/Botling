import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProcesses, parseOpenFiles, findWriters, createWriterCheck } from './offline-processes.mjs';
const p = (pid, exe, args = exe, start = 'Thu Oct 29 10:00:00 2026') => ({ pid, ppid: 1, uid: 501, executable: exe, args, start });
const opts = { appPath: '/fixture/Botling 2.app', dataDir: '/fixture/profile' };
test('ps captures complete executable path and process birth', () => {
  const rows = parseProcesses('123 1 501 Thu Oct 29 10:00:00 2026 /fixture/Botling 2.app/Contents/MacOS/Botling 2\n', '123 /fixture/Botling 2.app/Contents/MacOS/Botling 2 --x\n');
  assert.equal(rows[0].executable, opts.appPath + '/Contents/MacOS/Botling 2'); assert.equal(rows[0].start, p().start);
  assert.throws(() => parseProcesses('123 1 501 unknown /app', '123 /app'), /identity/);
  assert.throws(() => parseProcesses('123 1 501 Thu Oct 29 10:00:00 2026 /app', ''), /changed/);
});
test('NUL-delimited lsof records preserve spaces and reject malformed fields', () => {
  assert.deepEqual(parseOpenFiles('p123\0cnode\0\nf3\0n/fixture/profile/history file\0\n'), [{ pid: 123, path: '/fixture/profile/history file' }]);
  assert.throws(() => parseOpenFiles('n/path\0'), /identity/); assert.throws(() => parseOpenFiles(''), /Empty/);
});
test('target, copied app, core, profile args and open profile handles all refuse', async () => {
  const rows = [p(1, opts.appPath + '/Contents/MacOS/app'), p(2, '/other/Botling 2.app/Contents/MacOS/app'), p(3, '/bin/node', '/bin/node /other/out/core/main.cjs'), p(4, '/bin/node', '/bin/node --data=/fixture/profile'), p(5, '/bin/editor')];
  assert.deepEqual(await findWriters(rows, [{ pid: 5, path: '/fixture/profile/history' }], opts, async x => x), [1, 2, 3, 4, 5]);
});
test('allow list is tied to birth and executable, not reused PID', async () => {
  const row = p(123, opts.appPath + '/helper');
  assert.deepEqual(await findWriters([row], [], { ...opts, allowed: [row] }), []);
  assert.deepEqual(await findWriters([{ ...row, start: 'new process' }], [], { ...opts, allowed: [row] }), [123]);
});
test('real filesystem symlink alias resolves into synthetic profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'offline-process-test-'));
  try {
    const profile = join(root, 'profile'); await mkdir(profile); await symlink(profile, join(root, 'alias'));
    assert.deepEqual(await findWriters([p(123, '/bin/editor')], [{ pid: 123, path: join(root, 'alias') }], { ...opts, dataDir: profile }), [123]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('repeated census detects a writer arriving after first observation', async () => {
  let call = 0;
  const self = `${process.pid} 1 ${process.getuid()} Thu Oct 29 10:00:00 2026 /bin/node\n`;
  const run = async () => [self, `${process.pid} node\n`, `p${process.pid}\0cnode\0\nf1\0n/dev/null\0`, self + '123 1 501 Thu Oct 29 10:00:00 2026 /bin/editor\n', `${process.pid} node\n123 editor /fixture/profile\n`][call++];
  await assert.rejects(createWriterCheck(opts, run)(), /PIDs 123/); assert.equal(call, 5);
});
test('only exact owned shell and restricted descendants are exempted', async () => {
  const { transactionProcesses } = await import('./offline-processes.mjs');
  const helper = { pid: 12, script: '/fixture/.botling-update-id/swap.sh' };
  const shell = p(12, '/bin/sh', '/bin/sh ' + helper.script + ' target');
  helper.identity = shell; helper.args = shell.args;
  const copy = { ...p(13, '/usr/bin/ditto'), ppid: 12 };
  const stranger = { ...p(14, '/bin/node'), ppid: 12 };
  const unknownShell = { ...p(15, '/bin/sh', '/bin/sh -c unreviewed'), ppid: 12 };
  assert.deepEqual(transactionProcesses([shell, copy, stranger, unknownShell], helper).map(p => p.pid), [12, 13]);
  assert.deepEqual(transactionProcesses([{ ...shell, args: '/bin/sh /other/swap.sh' }, copy], helper), []);
});
test('candidate exemption requires actual helper ancestry and both launch tokens', async () => {
  const { transactionProcesses } = await import('./offline-processes.mjs');
  const h = { pid: 12, script: '/fixture/.botling-update-id/swap.sh', candidate: { appPath: opts.appPath, executable: opts.appPath + '/Contents/MacOS/Botling 2', token: 'bound-token' } };
  const shell = p(12, '/bin/sh', '/bin/sh ' + h.script + ' target');
  h.identity = shell; h.args = shell.args;
  const candidate = { ...p(15, h.candidate.executable, h.candidate.executable + ' --botling-update-token=bound-token --botling-maintenance-launch=bound-token'), ppid: 12 };
  assert.deepEqual(transactionProcesses([shell, candidate], h).map(p => p.pid), [12, 15]);
  assert.deepEqual(transactionProcesses([shell, { ...candidate, ppid: 1 }], h).map(p => p.pid), [12]);
  assert.deepEqual(transactionProcesses([shell, { ...candidate, args: 'old .18 ordinary launch' }], h).map(p => p.pid), [12]);
});
