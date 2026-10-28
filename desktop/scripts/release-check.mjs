// Read-only release gate. Never provisions trust, changes configuration or publishes.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trustKey, verifyManifest } from './release-manifest.mjs';

export function checkMetadata(pkg, lock, tag) {
  if (!/^2\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected stable Electron 2.x version');
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('Package/lock versions differ');
  if (pkg.botlingDevTrial !== false) throw new Error('Release must disable botlingDevTrial');
  if (tag !== undefined && tag !== `v${pkg.version}`) throw new Error('Tag must match desktop/package.json');
  return pkg.version;
}
export function checkSigningKey(pem, privatePem) {
  const publicKey = trustKey(pem);
  if (!privatePem) throw new Error('BOTLING_RELEASE_KEY is required (operator-owned Ed25519 PKCS8 PEM)');
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).equals(publicKey)) throw new Error('Signing key does not match committed update trust');
}
export function checkArtifact(bytes, manifest, pem, version) {
  verifyManifest(manifest, pem);
  if (manifest.version !== version || manifest.size !== bytes.length || manifest.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Artifact version, size or digest mismatch');
}
export function assetNames(version) {
  const base = `Botling-2-${version}-mac-arm64`;
  return [`${base}.zip`, `${base}.zip.manifest.json`, `${base}.dmg`];
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const json = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const tag = value('--tag');
  if (args.includes('--tag') && !tag) throw new Error('--tag needs a value');
  const version = checkMetadata(json('package.json'), json('package-lock.json'), tag);
  if (args.includes('--trust') || args.includes('--signing-key') || args.includes('--artifacts')) {
    const { publicKey } = json('release-config.json');
    trustKey(publicKey);
    if (args.includes('--signing-key')) checkSigningKey(publicKey, process.env.BOTLING_RELEASE_KEY);
    if (args.includes('--artifacts')) {
      const dir = value('--artifacts');
      if (!dir || dir.startsWith('--')) throw new Error('--artifacts needs a directory');
      const [zip, manifest, dmg] = assetNames(version).map(name => join(resolve(dir), name));
      checkArtifact(readFileSync(zip), JSON.parse(readFileSync(manifest, 'utf8')), publicKey, version);
      if (!statSync(dmg).isFile() || statSync(dmg).size <= 0) throw new Error('DMG is missing or empty');
    }
  }
  console.log(`Electron ${version}: requested release checks passed`);
}
