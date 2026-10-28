import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble, digest, inventory, releaseSource, verifyFrozen } from './release-variants.mjs';
import { ALLOWED_CHANGES, recoverLocal, recoverySourceEvidence, preservedTreeDigest, verifyRecovery } from './release-recovery.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'recovery-contract-'))), checkout = join(root, 'checkout'), desktop = join(checkout, 'desktop'), frozenRoot = join(root, 'frozen');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function put(path, bytes, mode = 0o644) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes, { mode }); }
  const json = (path, value, mode) => put(path, JSON.stringify(value), mode);
  const pkg = { version: '2.0.0', botlingDevTrial: false, botlingStorageContract: { version: 1, epoch: 2 }, devDependencies: { electron: 'fixture' } };
  json(join(desktop, 'package.json'), pkg);
  json(join(desktop, 'package-lock.json'), { version: pkg.version, packages: { '': { version: pkg.version } } });
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  json(join(desktop, 'release-config.json'), { publicKey });
  put(join(checkout, '.gitignore'), 'desktop/node_modules/\ndesktop/out/\ndesktop/src/ignored*\n');
  put(join(desktop, 'src/main.js'), 'unchanged compiled input');
  put(join(desktop, 'scripts/release-variants.mjs'), 'base packager');
  for (const name of ['electron', 'electron-builder', 'esbuild']) json(join(desktop, 'node_modules', name, 'package.json'), { version: 'fixture' });
  const git = args => execFileSync('git', ['-C', checkout, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']); return git(['rev-parse', 'HEAD']); };
  git(['init']); const compiledSHA = commit();
  put(join(desktop, 'scripts/release-variants.mjs'), 'reviewed config isolation');
  put(join(desktop, 'scripts/release-recovery.mjs'), 'reviewed complete recovery verifier');
  const assemblySHA = commit();
  const source = { ...releaseSource(desktop), sourceSHA: compiledSHA };
  json(join(frozenRoot, 'compiled/out/core/storage-contract.json'), pkg.botlingStorageContract);
  put(join(frozenRoot, 'compiled/out/core/main.cjs'), 'frozen core');
  put(join(frozenRoot, 'compiled/mobile/dist/web.js'), 'frozen mobile');
  json(join(frozenRoot, 'COMPILED_PROVENANCE.json'), { schema: 1, source, files: inventory(join(frozenRoot, 'compiled')) });
  for (const name of ['public-production', 'local-trial-preserving', 'stage-local']) put(join(frozenRoot, name, 'original'), `preserve ${name}`);
  put(join(frozenRoot, 'public-production/app/Versions/A/binary'), 'native app');
  symlinkSync('A', join(frozenRoot, 'public-production/app/Versions/Current'));
  const manifest = { schema: 1, scope: 'local-only-packager-recovery', variant: 'local', compiledSourceSHA: compiledSHA, assemblySourceSHA: assemblySHA,
    ...recoverySourceEvidence(desktop, compiledSHA, assemblySHA), frozenRoot,
    compiledManifestSHA256: digest(readFileSync(join(frozenRoot, 'COMPILED_PROVENANCE.json'))),
    preservedTrees: Object.fromEntries(['public-production', 'local-trial-preserving', 'stage-local'].map(name => [name, preservedTreeDigest(join(frozenRoot, name))])),
    stage: join(root, 'fresh-local-stage'), output: join(root, 'fresh-local-output') };
  const options = { desktop, manifestPath: join(root, 'manifest.json'), approvalPath: join(root, 'approval.json') };
  const approval = { schema: 1, action: 'assemble-local-recovery', manifestSHA256: '', assemblySourceSHA: assemblySHA, compiledSourceSHA: compiledSHA, variant: 'local', explicitApproval: true, reviewer: 'fixture-reviewer', recordId: 'fixture-external-approval' };
  const seal = () => {
    json(options.manifestPath, manifest, 0o600); options.manifestSHA256 = digest(readFileSync(options.manifestPath));
    approval.manifestSHA256 = options.manifestSHA256;
    json(options.approvalPath, approval, 0o600); options.approvalSHA256 = digest(readFileSync(options.approvalPath));
  };
  seal();
  const counts = { preflight: 0, builder: 0, sign: 0, codesign: 0 };
  const actions = {
    preflight: () => { counts.preflight++; },
    assemble: async ({ manifest: m, source: expected, recovery }) => assemble(desktop, m.frozenRoot, 'local', expected, async config => {
      counts.builder++;
      assert.equal(config.mac.extendInfo.BotlingGitCommit, compiledSHA);
      assert.equal(config.extraMetadata.botlingDevTrial, true);
      assert.equal(config.extraMetadata.version, '2.0.0-local-trial.20261029.1');
      return ['zip', 'dmg'].map(ext => {
        const path = join(config.directories.output, `Botling-2-${config.extraMetadata.version}-mac-arm64.${ext}`);
        put(path, 'fake assembly bytes'); return path;
      });
    }, { directories: {}, extraResources: [], extraMetadata: {}, mac: {}, dmg: {} }, () => { counts.codesign++; }, recovery),
    sign: () => { counts.sign++; },
  };
  return { root, checkout, desktop, frozenRoot, manifest, approval, options, policy: { compiledSHA }, source, counts, actions, seal, put, git, commit };
}
const flatten = error => [error.message, ...(error.errors ?? []).map(flatten)].join('\n');
async function blocked(f) {
  await assert.rejects(recoverLocal(f.options, f.actions, f.policy));
  assert.deepEqual(f.counts, { preflight: 0, builder: 0, sign: 0, codesign: 0 });
  assert.equal(existsSync(join(f.root, 'fresh-local-output')), false);
}
test('approved local recovery uses two identities, fresh paths, no compile, preserves complete trees', async t => {
  const f = fixture(t), originalManifest = readFileSync(join(f.frozenRoot, 'COMPILED_PROVENANCE.json'));
  assert.throws(() => verifyFrozen(f.frozenRoot, releaseSource(f.desktop)), /Source/); // Default remains exact-SHA.
  await recoverLocal(f.options, f.actions, f.policy);
  assert.deepEqual(f.counts, { preflight: 1, builder: 1, sign: 1, codesign: 1 });
  assert.equal(readFileSync(join(f.manifest.output, 'SOURCE_COMMIT.txt'), 'utf8').trim(), f.policy.compiledSHA);
  const provenance = JSON.parse(readFileSync(join(f.manifest.output, 'VARIANT_PROVENANCE.json')));
  assert.equal(provenance.source.sourceSHA, f.policy.compiledSHA);
  assert.equal(provenance.recovery.assemblySourceSHA, f.manifest.assemblySourceSHA);
  assert.equal(provenance.recovery.approvalSHA256, f.options.approvalSHA256);
  assert.equal(provenance.recovery.manifestSHA256, f.options.manifestSHA256);
  assert.deepEqual(readFileSync(join(f.frozenRoot, 'COMPILED_PROVENANCE.json')), originalManifest);
  for (const [name, pin] of Object.entries(f.manifest.preservedTrees)) assert.equal(preservedTreeDigest(join(f.frozenRoot, name)), pin);
  assert.ok(existsSync(join(f.manifest.output, 'RECOVERY_COMPLETE.json')));
  await assert.rejects(recoverLocal(f.options, f.actions, f.policy), /already exists/);
});
for (const change of ['missing-approval', 'wrong-approval-pin', 'manifest-mutated', 'self-approval', 'public-variant', 'wrong-final-sha', 'wrong-base', 'bad-diff', 'bad-inputs', 'bad-frozen-manifest', 'frozen-bytes', 'frozen-symlink', 'public-bytes', 'failed-mode', 'failed-empty-dir', 'public-link', 'untracked', 'ignored-source', 'hidden-tracked-change', 'added-runtime', 'symlink-input']) {
  test(`before callbacks rejects ${change}`, async t => {
    const f = fixture(t);
    if (change === 'missing-approval') rmSync(f.options.approvalPath);
    if (change === 'wrong-approval-pin') f.options.approvalSHA256 = '0'.repeat(64);
    if (change === 'manifest-mutated') f.put(f.options.manifestPath, readFileSync(f.options.manifestPath, 'utf8') + ' ');
    if (change === 'self-approval') { f.manifest.approved = true; f.seal(); }
    if (change === 'public-variant') { f.manifest.variant = 'public'; f.approval.variant = 'public'; f.seal(); }
    if (change === 'wrong-final-sha') { f.approval.assemblySourceSHA = f.policy.compiledSHA; f.seal(); }
    if (change === 'wrong-base') { f.manifest.compiledSourceSHA = '0'.repeat(40); f.seal(); }
    if (change === 'bad-diff') { f.manifest.diffSHA256 = '0'.repeat(64); f.seal(); }
    if (change === 'bad-inputs') { f.manifest.compiledInputsSHA256 = '0'.repeat(64); f.seal(); }
    if (change === 'bad-frozen-manifest') f.put(join(f.frozenRoot, 'COMPILED_PROVENANCE.json'), '{}');
    if (change === 'frozen-bytes') f.put(join(f.frozenRoot, 'compiled/mobile/dist/web.js'), 'tampered');
    if (change === 'frozen-symlink') { rmSync(join(f.frozenRoot, 'compiled/mobile/dist/web.js')); symlinkSync(join(f.desktop, 'src/main.js'), join(f.frozenRoot, 'compiled/mobile/dist/web.js')); }
    if (change === 'public-bytes') f.put(join(f.frozenRoot, 'public-production/original'), 'tampered');
    if (change === 'failed-mode') chmodSync(join(f.frozenRoot, 'stage-local/original'), 0o600);
    if (change === 'failed-empty-dir') mkdirSync(join(f.frozenRoot, 'local-trial-preserving/extra-empty'));
    if (change === 'public-link') { unlinkSync(join(f.frozenRoot, 'public-production/app/Versions/Current')); symlinkSync('./A', join(f.frozenRoot, 'public-production/app/Versions/Current')); }
    if (change === 'untracked') f.put(join(f.desktop, 'src/extra.js'), 'untracked');
    if (change === 'ignored-source') f.put(join(f.desktop, 'src/ignored.js'), 'ignored input');
    if (change === 'hidden-tracked-change') { f.git(['update-index', '--assume-unchanged', 'desktop/src/main.js']); f.put(join(f.desktop, 'src/main.js'), 'hidden change'); }
    if (change === 'added-runtime') {
      f.put(join(f.desktop, 'src/new.js'), 'new runtime'); f.manifest.assemblySourceSHA = f.commit(); f.approval.assemblySourceSHA = f.manifest.assemblySourceSHA; f.seal();
    }
    if (change === 'symlink-input') { rmSync(join(f.desktop, 'src/main.js')); symlinkSync(join(f.frozenRoot, 'compiled/out/core/main.cjs'), join(f.desktop, 'src/main.js')); }
    await blocked(f);
  });
}
for (const change of ['inside-public', 'inside-failed', 'inside-compiled', 'inside-checkout', 'overlap', 'symlink-parent', 'existing-output', 'noncanonical', 'record-symlink', 'record-mode']) {
  test(`unsafe recovery path rejects ${change} before callbacks`, async t => {
    const f = fixture(t);
    if (change === 'inside-public') f.manifest.output = join(f.frozenRoot, 'public-production/new');
    if (change === 'inside-failed') f.manifest.output = join(f.frozenRoot, 'local-trial-preserving/new');
    if (change === 'inside-compiled') f.manifest.output = join(f.frozenRoot, 'compiled/new');
    if (change === 'inside-checkout') f.manifest.output = join(f.desktop, 'new');
    if (change === 'overlap') f.manifest.output = f.manifest.stage;
    if (change === 'symlink-parent') { symlinkSync(f.root, join(f.root, 'alias')); f.manifest.output = join(f.root, 'alias/new'); }
    if (change === 'existing-output') mkdirSync(f.manifest.output);
    if (change === 'noncanonical') f.manifest.stage = `${f.root}/../${f.root.split('/').at(-1)}/stage`;
    f.seal();
    if (change === 'record-symlink') { const bytes = readFileSync(f.options.approvalPath); rmSync(f.options.approvalPath); f.put(join(f.root, 'elsewhere.json'), bytes, 0o600); symlinkSync(join(f.root, 'elsewhere.json'), f.options.approvalPath); }
    if (change === 'record-mode') chmodSync(f.options.approvalPath, 0o644);
    await assert.rejects(recoverLocal(f.options, f.actions, f.policy));
    assert.equal(f.counts.preflight, 0); assert.equal(f.counts.builder, 0);
  });
}
for (const failure of ['builder-throws', 'builder-mutates-then-throws', 'builder-mutates-success', 'signer-mutates-then-throws', 'signer-mutates-success', 'builder-mutates-failed-stage', 'signer-mutates-failed-output', 'source-and-public-change', 'preflight-mutates']) {
  test(`postcheck retained failure path: ${failure}`, async t => {
    const f = fixture(t), originalAssemble = f.actions.assemble;
    const mutate = () => f.put(join(f.frozenRoot, 'public-production/original'), 'unexpected mutation');
    if (failure === 'preflight-mutates') f.actions.preflight = () => { f.counts.preflight++; mutate(); };
    else if (failure.startsWith('signer-')) f.actions.sign = () => {
      f.counts.sign++;
      if (failure === 'signer-mutates-failed-output') mkdirSync(join(f.frozenRoot, 'local-trial-preserving/changed-empty-directory'));
      else mutate();
      if (failure === 'signer-mutates-then-throws') throw new Error('signer fixture failure');
    };
    else f.actions.assemble = async args => {
      const result = await originalAssemble(args);
      if (failure === 'builder-mutates-failed-stage') chmodSync(join(f.frozenRoot, 'stage-local'), 0o700);
      else if (failure !== 'builder-throws') mutate();
      if (failure === 'source-and-public-change') f.put(join(f.desktop, 'src/main.js'), 'dirty');
      if (failure === 'builder-throws' || failure === 'builder-mutates-then-throws') throw new Error('builder fixture failure');
      return result;
    };
    await assert.rejects(recoverLocal(f.options, f.actions, f.policy), error => {
      if (failure !== 'builder-throws') assert.match(flatten(error), /Preserved public\/failed-local/);
      if (failure.includes('throws')) assert.match(flatten(error), /fixture failure/);
      return true;
    });
    assert.equal(existsSync(join(f.manifest.output, 'RECOVERY_COMPLETE.json')), false);
    if (failure !== 'preflight-mutates') assert.ok(existsSync(join(f.manifest.output, 'VARIANT_PROVENANCE.json'))); // No automatic cleanup.
    if (!failure.startsWith('signer')) assert.equal(f.counts.sign, 0);
  });
}
test('entire verifier diff must be reviewed, not only the earlier config fix', async t => {
  const f = fixture(t);
  assert.ok(ALLOWED_CHANGES.includes('desktop/scripts/release-recovery.mjs'));
  f.put(join(f.desktop, 'scripts/release-recovery.mjs'), 'different verifier');
  f.manifest.assemblySourceSHA = f.commit(); f.approval.assemblySourceSHA = f.manifest.assemblySourceSHA;
  f.seal(); // Old diff digest deliberately retained.
  await blocked(f);
});

test('CLI refuses missing approval with nonzero exit and cannot override the fixed compiled base', t => {
  const f = fixture(t), env = { ...process.env };
  for (const key of ['CSC_LINK', 'CSC_NAME', 'BOTLING_RELEASE_KEY', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  const args = ['--check', '--manifest', f.options.manifestPath, '--manifest-sha256', f.options.manifestSHA256,
    '--approval', f.options.approvalPath, '--approval-sha256', f.options.approvalSHA256];
  const run = extra => spawnSync(process.execPath, [new URL('./release-recovery.mjs', import.meta.url).pathname, ...args, ...extra], { env, encoding: 'utf8' });
  let result = run([]);
  assert.equal(result.status, 1); assert.match(result.stderr, /Unreviewed compiled base/); assert.equal(result.stdout, '');
  result = run(['--compiled-sha', f.policy.compiledSHA]);
  assert.equal(result.status, 1); assert.match(result.stderr, /Invalid recovery arguments/);
  rmSync(f.options.approvalPath); result = run([]);
  assert.equal(result.status, 1); assert.match(result.stderr, /Local recovery refused/);
  assert.equal(existsSync(f.manifest.output), false);
});
test('late path replacement before exclusive mkdir is refused and existing evidence retained', async t => {
  const f = fixture(t), original = f.actions.assemble;
  f.actions.assemble = async args => {
    symlinkSync(join(f.frozenRoot, 'public-production'), f.manifest.output);
    return original(args);
  };
  await assert.rejects(recoverLocal(f.options, f.actions, f.policy), error => /destination already exists/.test(flatten(error)));
  assert.equal(f.counts.builder, 0); assert.equal(f.counts.sign, 0);
  for (const [name, pin] of Object.entries(f.manifest.preservedTrees)) assert.equal(preservedTreeDigest(join(f.frozenRoot, name)), pin);
});
