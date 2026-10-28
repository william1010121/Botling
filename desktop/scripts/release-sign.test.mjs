import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { checkArtifact } from './release-check.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'signer-input-')), desktop = join(root, 'checkout/desktop');
  mkdirSync(join(desktop, 'scripts'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['release-sign.mjs', 'release-manifest.mjs', 'release-check.mjs', 'release-variants.mjs', 'package.mjs'])
    cpSync(new URL(name, import.meta.url), join(desktop, 'scripts', name));
  const pair = generateKeyPairSync('ed25519');
  const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const key = join(root, 'dummy-private.pem'); writeFileSync(key, pem, { mode: 0o600 });
  writeFileSync(join(desktop, 'release-config.json'), JSON.stringify({ publicKey }));
  const env = { ...process.env, HOME: root };
  for (const name of ['BOTLING_RELEASE_KEY', 'BOTLING_RELEASE_KEY_FILE', 'CSC_LINK', 'CSC_NAME']) delete env[name];
  const invoke = (args, overrides = {}) => spawnSync(process.execPath, [join(desktop, 'scripts/release-sign.mjs'), ...args], { env: { ...env, ...overrides }, encoding: 'utf8' });
  return { root, desktop, key, pem, publicKey, env, invoke };
}
function rejected(result, secret) {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release signing failed/);
  assert.equal(result.stdout, '');
  assert.ok(!result.stderr.includes(secret));
  assert.ok(!result.stderr.includes('BEGIN PRIVATE KEY'));
  assert.ok(!result.stderr.includes('Error:'));
}
test('file-path preflight accepts matching dummy key silently without a legacy key or artifact', t => {
  const f = fixture(t);
  for (const result of [f.invoke(['preflight', '--key-file', f.key]), f.invoke(['preflight'], { BOTLING_RELEASE_KEY_FILE: f.key })]) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout + result.stderr, '');
  }
  assert.equal(existsSync(join(f.root, '.botling-release')), false);
});
test('file-path preflight rejects missing, mismatched, malformed, symlink and unsafe-mode dummy keys without disclosing input', t => {
  const f = fixture(t);
  rejected(f.invoke(['preflight', '--key-file', join(f.root, 'missing')]), f.pem);
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  writeFileSync(f.key, other); rejected(f.invoke(['preflight', '--key-file', f.key]), other);
  writeFileSync(f.key, 'SENSITIVE_TEST_SENTINEL'); rejected(f.invoke(['preflight', '--key-file', f.key]), 'SENSITIVE_TEST_SENTINEL');
  writeFileSync(f.key, f.pem); chmodSync(f.key, 0o644); rejected(f.invoke(['preflight', '--key-file', f.key]), f.pem);
  chmodSync(f.key, 0o600);
  const link = join(f.root, 'link'); symlinkSync(f.key, link); rejected(f.invoke(['preflight', '--key-file', link]), f.pem);
  rejected(f.invoke(['preflight', '--key-file', f.root]), f.pem);
});
test('dummy ZIP signing supports file path and existing CI PEM input without changing verification', t => {
  const f = fixture(t), zip = join(f.root, 'dummy.zip'), bytes = Buffer.from('synthetic fixture only');
  writeFileSync(zip, bytes);
  for (const [args, env] of [
    [['sign', '2.0.0', zip, '--key-file', f.key], {}],
    [['sign', '2.0.0', zip], { BOTLING_RELEASE_KEY_FILE: f.key }],
    [['sign', '2.0.0', zip], { BOTLING_RELEASE_KEY: f.pem }],
  ]) {
    const result = f.invoke(args, env); assert.equal(result.status, 0, result.stderr);
    checkArtifact(bytes, JSON.parse(readFileSync(`${zip}.manifest.json`)), f.publicKey, '2.0.0');
    assert.ok(!result.stdout.includes(f.pem));
  }
});
test('variants preflight stops missing/mismatched keys before any compile; matching file reaches only a fake compile sentinel', t => {
  const f = fixture(t), checkout = join(f.root, 'checkout'), marker = join(f.root, 'compile-attempt');
  const pkg = { version: '2.0.0', botlingDevTrial: false, botlingStorageContract: { version: 1, epoch: 2 } };
  writeFileSync(join(f.desktop, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(f.desktop, 'package-lock.json'), JSON.stringify({ version: pkg.version, packages: { '': { version: pkg.version } } }));
  writeFileSync(join(checkout, '.gitignore'), 'desktop/node_modules/\n');
  for (const name of ['electron', 'electron-builder', 'esbuild']) {
    mkdirSync(join(f.desktop, 'node_modules', name), { recursive: true });
    writeFileSync(join(f.desktop, 'node_modules', name, 'package.json'), JSON.stringify({ version: 'fixture' }));
  }
  // This is deliberately not the real builder: no compilation or packaging occurs.
  writeFileSync(join(f.desktop, 'build.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'called'); throw new Error('FAKE_COMPILE_STOP');`);
  const git = args => execFileSync('git', ['-C', checkout, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  git(['init']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const invoke = (suffix, args, env = {}) => spawnSync(process.execPath, [join(f.desktop, 'scripts/package.mjs'), '--release-variants', join(f.root, suffix), '--sign-manifests', ...args], { env: { ...f.env, ...env }, encoding: 'utf8' });
  let result = invoke('missing-output', ['--key-file', join(f.root, 'missing')]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Release signer failed/);
  assert.equal(existsSync(marker), false); assert.equal(existsSync(join(f.root, 'missing-output')), false);
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  writeFileSync(f.key, other);
  result = invoke('mismatch-output', [], { BOTLING_RELEASE_KEY_FILE: f.key });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Release signer failed/);
  assert.ok(!result.stderr.includes(other)); assert.ok(!result.stderr.includes(f.key));
  assert.equal(existsSync(marker), false); assert.equal(existsSync(join(f.root, 'mismatch-output')), false);
  writeFileSync(f.key, f.pem);
  result = invoke('pem-rejected-output', [], { BOTLING_RELEASE_KEY: f.pem });
  assert.notEqual(result.status, 0); assert.equal(existsSync(marker), false);
  assert.ok(!result.stderr.includes(f.pem));
  for (const [suffix, args, env] of [
    ['valid-flag-output', ['--key-file', f.key], {}],
    ['valid-env-output', [], { BOTLING_RELEASE_KEY_FILE: f.key }],
  ]) {
    result = invoke(suffix, args, env);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /FAKE_COMPILE_STOP/);
    assert.equal(readFileSync(marker, 'utf8'), 'called'); rmSync(marker);
    assert.ok(!result.stderr.includes(f.pem));
  }
});
test('signer input ambiguity and malformed PEM/argument errors remain redacted', t => {
  const f = fixture(t);
  rejected(f.invoke(['preflight', '--key-file', f.key], { BOTLING_RELEASE_KEY: f.pem }), f.pem);
  rejected(f.invoke(['preflight'], { BOTLING_RELEASE_KEY: 'SENSITIVE_ENV_SENTINEL' }), 'SENSITIVE_ENV_SENTINEL');
  rejected(f.invoke(['preflight', '--key-file', 'SENSITIVE_PATH_SENTINEL']), 'SENSITIVE_PATH_SENTINEL');
  rejected(f.invoke(['preflight', '--unknown', 'SENSITIVE_ARGUMENT_SENTINEL']), 'SENSITIVE_ARGUMENT_SENTINEL');
});
test('variants signer forwarding uses selected dummy file for preflight and synthetic manifest', async t => {
  const f = fixture(t), { runReleaseSigner } = await import('./release-variants.mjs');
  const zip = join(f.root, 'forwarded.zip'), bytes = Buffer.from('synthetic forwarded bytes');
  writeFileSync(zip, bytes);
  runReleaseSigner(f.desktop, ['preflight'], f.key);
  runReleaseSigner(f.desktop, ['sign', '2.0.0', zip], f.key);
  checkArtifact(bytes, JSON.parse(readFileSync(`${zip}.manifest.json`)), f.publicKey, '2.0.0');
  assert.throws(() => runReleaseSigner(f.desktop, ['preflight'], join(f.root, 'missing')), /^Error: Release signer failed; check key file ownership\/mode, validity and committed public trust$/);
});
