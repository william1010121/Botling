import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { plan, execute, CURRENT, CURRENT_ASAR } from './driver.mjs';
const key = JSON.parse(readFileSync(new URL('../../release-config.json', import.meta.url))).publicKey;
const input = { appPath: '/fixture/Applications/Botling 2.app', dataDir: '/fixture/Library/Application Support/Botling 2 Dev Trial', candidatePath: '/candidate/Botling 2.app', current: CURRENT, currentAsarSha256: CURRENT_ASAR, arch: 'arm64', candidateZipSha256: 'a'.repeat(64), candidateDevTrial: true };
function fixture(fail) {
  const events = [], p = plan(input, key);
  let reads = 0;
  const step = name => { events.push(name); if (fail === name) throw new Error(name); };
  const identity = () => ({ pid: 123, birth: 'unique-kernel-start-time', appPath: input.appPath, dataDir: input.dataDir, current: CURRENT, asarSha256: CURRENT_ASAR, exclusive: true });
  const lease = {
    inspect: async () => { step('inspect'); const value = identity(); if (++reads === 2 && fail === 'reuse') value.birth = 'reused'; if (fail === 'profile') value.dataDir = '/other'; if (fail === 'nonexclusive') value.exclusive = false; return value; },
    withValidatedParent: async (_identity, action) => { step('validate-atomic'); return action(); },
    transferToInstaller: async () => step('transfer'), approvedGracefulQuit: async () => step('quit'), release: async () => step('release'),
  };
  const ports = {
    contract: 'first-upgrade-exclusive-v1', acquireExclusive: async () => { step('acquire'); return lease; },
    authenticateLocalBuild: async () => { step('authenticate'); return { zip: '/scratch/authenticated.zip', version: '2.0.0' }; },
    inspectAuthenticated: async () => { step('metadata'); return { zipSha256: input.candidateZipSha256, botlingDevTrial: fail !== 'production', ordinaryDataDir: fail === 'ordinary' ? '/production' : input.dataDir, publicKeyFingerprint: p.publicKeyFingerprint, arch: input.arch, startupFenceReviewed: fail !== 'fence', recoveryReviewed: fail !== 'recovery' }; },
    createVerifiedInstaller: options => { step('create'); assert.equal(options.dataDir, input.dataDir); assert.deepEqual(options.launchArgs, []); return {
      stageLocal: async (zip, version) => { assert.equal(zip, '/scratch/authenticated.zip'); assert.equal(version, '2.0.0'); step('stage'); },
      restart: async pid => { assert.equal(pid, 123); step('restart'); }, discard: async () => step('discard'),
    }; }, removeAuthenticationScratch: async () => step('scratch-cleanup'),
  };
  return { events, p, ports, approval: { explicitInstallApproval: true, planSha256: p.planSha256 } };
}
test('plan binds exact inputs and approved public key without storing PID', () => {
  const p = plan(input, key); assert.equal(p.planSha256, plan(input, key).planSha256); assert.equal(p.pid, undefined);
  assert.notEqual(plan({ ...input, candidateZipSha256: 'b'.repeat(64) }, key).planSha256, p.planSha256);
  assert.throws(() => plan(input, key.replace('NW', 'XX').replace('ANwD', 'ANxD')), /fingerprint/);
});
for (const [field, value] of [['current', '2.0.0'], ['candidateDevTrial', false], ['appPath', '/fixture/../bad.app'], ['dataDir', input.appPath], ['candidateZipSha256', 'unknown'], ['arch', 'unknown']]) {
  test(`plan rejects invalid ${field}`, () => assert.throws(() => plan({ ...input, [field]: value }, key)));
}
test('approval cannot be inferred from elapsed time or preparation', async () => {
  const f = fixture(); await assert.rejects(execute(f.p, key, {}, f.ports), /approval/); assert.deepEqual(f.events, []);
});
test('mutated plan and absent runtime bridge fail before any operation', async () => {
  const f = fixture(); await assert.rejects(execute({ ...f.p, candidateZipSha256: 'b'.repeat(64) }, key, f.approval, f.ports), /Plan changed/);
  await assert.rejects(execute(f.p, key, f.approval, {}), /bridge unavailable/); assert.deepEqual(f.events, []);
});
for (const failure of ['acquire', 'profile', 'nonexclusive', 'authenticate', 'metadata', 'production', 'ordinary', 'fence', 'recovery', 'stage', 'reuse', 'validate-atomic', 'restart']) {
  test(`fail closed before graceful quit: ${failure}`, async () => {
    const f = fixture(failure); await assert.rejects(execute(f.p, key, f.approval, f.ports));
    assert.ok(!f.events.includes('quit')); assert.ok(!f.events.includes('transfer'));
    if (failure !== 'acquire') assert.ok(f.events.includes('release'));
    if (f.events.includes('stage')) assert.ok(f.events.includes('discard'));
  });
}
for (const failure of ['transfer', 'quit']) {
  test(`retain helper protection/journal after ${failure} failure`, async () => {
    const f = fixture(failure); await assert.rejects(execute(f.p, key, f.approval, f.ports));
    assert.ok(f.events.includes('restart')); assert.ok(!f.events.includes('release')); assert.ok(!f.events.includes('discard'));
  });
}
test('dummy endpoints receive actual parent; success means armed, never installed', async () => {
  const f = fixture(); assert.deepEqual(await execute(f.p, key, f.approval, f.ports), { status: 'helper-armed', pid: 123, installed: false });
  assert.deepEqual(f.events, ['acquire', 'inspect', 'authenticate', 'metadata', 'create', 'stage', 'inspect', 'validate-atomic', 'restart', 'transfer', 'quit', 'scratch-cleanup']);
});
test('CLI has no live execution command', () => {
  const r = spawnSync(process.execPath, [new URL('./cli.mjs', import.meta.url).pathname, 'execute'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /Live execution blocked/);
});
