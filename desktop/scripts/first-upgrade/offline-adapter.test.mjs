import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { offlinePlan, approve, prepareOffline, operatorAction, requireCleanEnvironment } from './offline-adapter.mjs';
import { CURRENT, CURRENT_ASAR } from './driver.mjs';
import { persistentDigest, verifySnapshot } from './offline-snapshot.mjs';
const key = JSON.parse(readFileSync(new URL('../../release-config.json', import.meta.url))).publicKey;
const input = { appPath: '/fixture/Botling 2.app', dataDir: '/fixture/Library/Application Support/Botling 2 Dev Trial', candidatePath: '/candidate/Botling 2.app', current: CURRENT, currentAsarSha256: CURRENT_ASAR, arch: 'arm64', candidateZipSha256: 'a'.repeat(64), candidateDevTrial: true, runtimePath: '/reviewed/runtime.mjs', runtimeSha256: 'b'.repeat(64) };
const plan = offlinePlan(input, key);
const approval = action => ({ explicitApproval: true, manualWindowAccepted: true, planSha256: plan.planSha256, action });
test('offline plan binds runtime hash and manual window; each action needs own approval', () => {
  assert.notEqual(plan.planSha256, offlinePlan({ ...input, runtimeSha256: 'c'.repeat(64) }, key).planSha256);
  assert.throws(() => approve(plan, key, approval('prepare'), 'launch'), /approval/);
  assert.throws(() => approve(plan, key, { ...approval('prepare'), manualWindowAccepted: false }, 'prepare'), /no-relaunch/);
  assert.throws(() => approve({ ...plan, candidateZipSha256: 'c'.repeat(64) }, key, approval('prepare'), 'prepare'), /Plan changed/);
});
test('hostile launch overrides rejected; ordinary env allowed', () => {
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'BOTLING_DATA_DIR', 'ELECTRON_RUN_AS_NODE']) assert.throws(() => requireCleanEnvironment({ [name]: 'x' }), /clean/);
  assert.doesNotThrow(() => requireCleanEnvironment({ HOME: '/fixture', PATH: '/usr/bin:/bin' }));
});
function services(events, fail) {
  let checks = 0;
  return {
    check: async () => { events.push('check'); if (++checks === fail) throw new Error('writer appeared'); },
    verifyArchitecture: async () => {},
    verifyInstalled: async () => ({ appIdentity: '1:2', profileIdentity: '1:3' }), hashFile: async () => input.candidateZipSha256,
    runtime: {
      authenticateLocalBuild: async () => { events.push('authenticate'); return { zip: '/auth.zip', app: '/auth.app', version: '2.0.0' }; },
      openApp: async () => ({ read: async () => Buffer.from(JSON.stringify({ botlingDevTrial: true, version: '2.0.0' })) }),
      VerifiedInstaller: class { constructor(options) { assert.ok(options.maintenance); } },
    },
  };
}
function binding(events) { return {
  acquire: async () => { events.push('acquire'); return { record: { token: 'test' }, stage: async () => events.push('stage'), activateAwaitingOperator: async () => { events.push('activate'); return { state: 'awaiting-operator', transactionId: 'test-token' }; }, recordFailure: async () => events.push('retain') }; },
  removeAuthenticationScratch: async () => events.push('cleanup'),
}; }
test('missing approval and missing binding refuse before source mutations', async () => {
  const events = [], deps = services(events);
  await assert.rejects(prepareOffline(plan, key, {}, binding(events), deps), /approval/);
  await assert.rejects(prepareOffline(plan, key, approval('prepare'), {}, deps), /binding unavailable/);
  assert.deepEqual(events, []);
});
for (const step of [1, 2, 3, 4, 5]) test(`writer refusal at boundary ${step} never activates`, async () => {
  const events = [];
  await assert.rejects(prepareOffline(plan, key, approval('prepare'), binding(events), services(events, step)), /writer/);
  assert.ok(!events.includes('activate')); if (events.includes('acquire')) assert.ok(events.includes('retain'));
});
test('prepare pauses and never issues launch or an online restart', async () => {
  const events = []; const result = await prepareOffline(plan, key, approval('prepare'), binding(events), services(events));
  assert.equal(result.state, 'awaiting-operator'); assert.equal(result.installed, false); assert.ok(events.includes('activate'));
});
test('operator choice requires exact transaction and fresh writer check', async () => {
  let resumed = false;
  await assert.rejects(operatorAction(plan, key, approval('launch'), 'launch', 'abcdefgh', { resume: () => { resumed = true; } }, { check: async () => {} }), /transaction-bound/);
  await assert.rejects(operatorAction(plan, key, { ...approval('launch'), transactionId: 'abcdefgh' }, 'launch', 'abcdefgh', { resume: () => { resumed = true; } }, { check: async () => { throw new Error('writer'); } }), /writer/);
  assert.equal(resumed, false);
});
test('real file snapshot verification detects a changed or missing persistent file, preserving core Cache', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'offline-snapshot-'));
  try {
    const dataDir = join(root, 'data'); await fs.mkdir(join(dataDir, 'core/Cache'), { recursive: true });
    await fs.mkdir(join(dataDir, 'electron/Cache'), { recursive: true });
    await fs.writeFile(join(dataDir, 'core/Cache/history'), 'old'); await fs.writeFile(join(dataDir, 'electron/Cache/disposable'), 'cache');
    const before = await persistentDigest(dataDir, ['update-pending.json']);
    await fs.cp(dataDir, join(root, 'data-before'), { recursive: true }); await fs.writeFile(join(root, 'snapshot.complete'), 'complete');
    const record = { root, dataDir };
    assert.equal(await verifySnapshot(record, before, ['update-pending.json']), before);
    await fs.writeFile(join(dataDir, 'electron/Cache/disposable'), 'changed cache'); assert.equal(await verifySnapshot(record, before, ['update-pending.json']), before);
    await fs.writeFile(join(dataDir, 'core/Cache/history'), 'new'); await assert.rejects(verifySnapshot(record, before, []), /changed/);
    await fs.writeFile(join(dataDir, 'core/Cache/history'), 'old'); await fs.rm(join(root, 'data-before/core/Cache/history'));
    await assert.rejects(verifySnapshot(record, before, []), /changed/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
