import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriterCheck } from './offline-processes.mjs';
const start = 'Thu Oct 29 10:00:00 2026';
const plan = { appPath: '/fixture/Botling 2.app', dataDir: '/fixture/profile' };
const self = { pid: process.pid, ppid: 1, uid: process.getuid(), start, executable: '/bin/node', args: 'node fixture' };
function census(rows) {
  let index = 0;
  const identity = rows.map(p => `${p.pid} ${p.ppid} ${p.uid} ${p.start} ${p.executable}`).join('\n');
  const argv = rows.map(p => `${p.pid} ${p.args}`).join('\n');
  const files = rows.map(p => `p${p.pid}\0cfixture\0\nf3\0n${p.pid === process.pid ? '/dev/null' : plan.appPath + '/Contents/Info.plist'}\0\n`).join('');
  return async () => [identity, argv, files, identity, argv][index++];
}
// Each fixture registry represents an already attested ChildProcess registration.
// Native registration/handshake is exercised separately with real owned children.
function registration(expected) {
  return { attestObservations: async (...snapshots) => snapshots.flat().filter(p =>
    ['pid', 'ppid', 'uid', 'start', 'executable', 'args'].every(k => p[k] === expected[k])) };
}
for (const [name, executable, args] of [
  ['owned lipo verification', '/usr/bin/lipo', ['-archs', plan.appPath + '/Contents/MacOS/Botling 2']],
  ['owned PlistBuddy verification', '/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plan.appPath + '/Contents/Info.plist']],
  ['owned helper before helper.pid publication', '/bin/sh', ['/fixture/.botling-update-fixture/swap.sh', '', plan.appPath, plan.dataDir]],
]) test(name, async () => {
  const owned = { pid: 12345, ppid: self.pid, uid: self.uid, start, executable, args: [executable, ...args].join(' ') };
  const check = createWriterCheck({ ...plan, helper: () => null, ownership: registration(owned) }, census([self, owned]));
  assert.equal((await check()).observedWriters, 0);
});
