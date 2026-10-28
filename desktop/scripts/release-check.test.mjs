import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { checkMetadata, checkSigningKey, checkArtifact, assetNames } from './release-check.mjs';
import { payload } from './release-manifest.mjs';

// Ephemeral in-memory test identity only; no release trust or key file is created.
const pair = generateKeyPairSync('ed25519');
const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const pkg = { version: '2.0.0', botlingDevTrial: false };
const lock = { version: '2.0.0', packages: { '': { version: '2.0.0' } } };
test('stable Electron tag and both lock versions must agree with the production profile', () => {
  assert.equal(checkMetadata(pkg, lock, 'v2.0.0'), '2.0.0');
  for (const tag of ['v1.20.0', 'v2.0.1', '2.0.0']) assert.throws(() => checkMetadata(pkg, lock, tag));
  assert.throws(() => checkMetadata({ ...pkg, botlingDevTrial: true }, lock));
  assert.throws(() => checkMetadata({ ...pkg, version: '2.0.0-dev.18' }, lock));
  assert.throws(() => checkMetadata(pkg, { ...lock, version: '2.0.1' }));
  assert.throws(() => checkMetadata(pkg, { ...lock, packages: { '': { version: '2.0.1' } } }));
});
test('signing requires existing matching Ed25519 trust and private key', () => {
  checkSigningKey(pem, privatePem);
  assert.throws(() => checkSigningKey(null, privatePem));
  assert.throws(() => checkSigningKey(pem, undefined));
  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => checkSigningKey(pem, other));
});
test('signed candidate rejects tampering, wrong version, wrong trust and missing signature', () => {
  const bytes = Buffer.from('synthetic ZIP bytes');
  const fields = { version: '2.0.0', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const manifest = { ...fields, signature: sign(null, payload(fields), pair.privateKey).toString('base64') };
  checkArtifact(bytes, manifest, pem, '2.0.0');
  assert.throws(() => checkArtifact(Buffer.from('tampered ZIP bytes'), manifest, pem, '2.0.0'));
  assert.throws(() => checkArtifact(bytes, manifest, pem, '2.0.1'));
  assert.throws(() => checkArtifact(bytes, { ...manifest, version: '2.0.1' }, pem, '2.0.1'));
  assert.throws(() => checkArtifact(bytes, { ...manifest, signature: undefined }, pem, '2.0.0'));
  assert.throws(() => checkArtifact(bytes, manifest, null, '2.0.0'));
  const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.throws(() => checkArtifact(bytes, manifest, other, '2.0.0'));
  assert.deepEqual(assetNames('2.0.0'), ['Botling-2-2.0.0-mac-arm64.zip', 'Botling-2-2.0.0-mac-arm64.zip.manifest.json', 'Botling-2-2.0.0-mac-arm64.dmg']);
});
