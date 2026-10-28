// Operator-owned local workflow. No upload/install; importing this module has no side effects.
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkArtifact, checkMetadata } from './release-check.mjs';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b, label) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} mismatch; refuse reuse`); };
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
export const variants = Object.freeze({
  public: Object.freeze({ directory: 'public-production', version: '2.0.0', botlingDevTrial: false }),
  local: Object.freeze({ directory: 'local-trial-preserving', version: '2.0.0-local-trial.20261029.1', botlingDevTrial: true }),
});
export function inventory(root) {
  const files = [];
  function walk(dir) {
    if (lstatSync(dir).isSymbolicLink()) throw new Error(`Symlink forbidden in compiled output: ${dir}`);
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Symlink forbidden in compiled output: ${path}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push({ path: relative(root, path), size: stat.size, mode: stat.mode & 0o777, sha256: digest(readFileSync(path)) });
      else throw new Error(`Non-file output: ${path}`);
    }
  }
  walk(root);
  if (!files.length) throw new Error(`Empty compiled output: ${root}`);
  return files;
}
function run(command, args, cwd) { return execFileSync(command, args, { cwd, stdio: 'inherit' }); }
function source(desktop) {
  const git = args => execFileSync('git', ['-C', desktop, ...args], { encoding: 'utf8' }).trim();
  if (git(['status', '--porcelain', '--untracked-files=all'])) throw new Error('Release requires a clean reviewed source checkout');
  const pkg = json(join(desktop, 'package.json'));
  checkMetadata(pkg, json(join(desktop, 'package-lock.json')));
  if (pkg.version !== '2.0.0') throw new Error('This release plan requires public 2.0.0');
  equal(pkg.botlingStorageContract, { version: 1, epoch: 2 }, 'Storage contract');
  const pem = json(join(desktop, 'release-config.json')).publicKey;
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Explicit Ed25519 update trust required');
  return { sourceSHA: git(['rev-parse', 'HEAD']), sourceDirty: 0,
    lockSHA256: digest(readFileSync(join(desktop, 'package-lock.json'))),
    publicKeySHA256: digest(key.export({ type: 'spki', format: 'der' })),
    storageContract: pkg.botlingStorageContract, node: process.version, platform: process.platform, arch: process.arch,
    tools: Object.fromEntries(['electron', 'electron-builder', 'esbuild'].map(name => [name, json(join(desktop, 'node_modules', name, 'package.json')).version])) };
}
export function verifyFrozen(root, expected) {
  const manifest = json(join(root, 'COMPILED_PROVENANCE.json'));
  if (manifest.schema !== 1) throw new Error('Unknown compiled provenance schema');
  equal(manifest.source, expected, 'Source/toolchain/trust');
  equal(inventory(join(root, 'compiled')), manifest.files, 'Compiled inventory');
  equal(json(join(root, 'compiled/out/core/storage-contract.json')), expected.storageContract, 'Compiled storage contract');
  return manifest;
}
export function checkPackagedMetadata(pkg, nativeVersion, coreContract, variant, contract) {
  equal(pkg.version, variant.version, 'ASAR version');
  equal(nativeVersion, variant.version, 'Native version');
  equal(pkg.botlingDevTrial, variant.botlingDevTrial, 'ASAR profile');
  equal(pkg.botlingUpdates, 'verified-updates', 'ASAR update authentication');
  equal(pkg.botlingStorageContract, contract, 'ASAR storage contract');
  equal(coreContract, contract, 'Packaged core storage contract');
}
export function assemblyConfig(base, desktop, stage, output, variant, provenance) {
  if (!Object.values(variants).includes(variant)) throw new Error('Unknown release variant');
  return { ...base,
    directories: { ...base.directories, app: stage, output },
    afterPack: async context => {
      const { extractFile } = await import('@electron/asar');
      const app = join(context.appOutDir, 'Botling 2.app');
      const archive = join(app, 'Contents/Resources/app.asar');
      const nativeVersion = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
      checkPackagedMetadata(JSON.parse(extractFile(archive, 'package.json')), nativeVersion,
        JSON.parse(extractFile(archive, 'out/core/storage-contract.json')), variant, provenance.source.storageContract);
      // Includes the main bundle that embeds update trust. Compare every shipped compiled file.
      for (const file of provenance.files.filter(file => file.path.startsWith('out/') && !file.path.endsWith('.map'))) {
        equal(digest(extractFile(archive, file.path)), file.sha256, `ASAR ${file.path}`);
      }
    },
    afterSign: async context => {
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', join(context.appOutDir, 'Botling 2.app')], { stdio: 'inherit' });
    },
    electronVersion: json(join(desktop, 'package.json')).devDependencies.electron,
    extraMetadata: { ...base.extraMetadata, version: variant.version, botlingDevTrial: variant.botlingDevTrial,
      botlingUpdates: 'verified-updates', botlingStorageContract: provenance.source.storageContract },
    // Never let a trial checkout choose the public DMG layout, nor launch a sibling trial-data profile.
    dmg: { ...base.dmg, contents: variant.botlingDevTrial ? [
      { x: 150, y: 180, type: 'file' },
      { x: 450, y: 180, type: 'file', path: join(desktop, 'docs/local-upgrade.md'), name: 'LOCAL-UPGRADE.md' },
    ] : [{ x: 150, y: 180, type: 'file' }, { x: 450, y: 180, type: 'link', path: '/Applications' }] },
    mac: { ...base.mac, extendInfo: { ...base.mac.extendInfo,
      CFBundleShortVersionString: variant.version, BotlingGitCommit: provenance.source.sourceSHA, BotlingGitDirty: '0' } },
    extraResources: base.extraResources.map(resource => ({ ...resource, from: join(stage, resource.from) })),
  };
}
export async function compileOnce(desktop, root, expected, runner = run, sourceReader = source) {
  for (const path of [join(desktop, 'out'), join(desktop, 'mobile'), join(desktop, 'mobile/dist')]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Compile output must be owned, not symlinked: ${path}`);
  }
  mkdirSync(root); // Exclusive: never bless arbitrary pre-existing output with fresh provenance.
  runner(process.execPath, [join(desktop, 'build.mjs')], desktop);
  runner(process.execPath, [join(desktop, 'mobile/build.mjs')], desktop);
  equal(sourceReader(desktop), expected, 'Source after compilation');
  mkdirSync(join(root, 'compiled'));
  cpSync(join(desktop, 'out'), join(root, 'compiled/out'), { recursive: true });
  cpSync(join(desktop, 'mobile/dist'), join(root, 'compiled/mobile/dist'), { recursive: true });
  equal(json(join(root, 'compiled/out/core/storage-contract.json')), expected.storageContract, 'Compiled storage contract');
  save(join(root, 'COMPILED_PROVENANCE.json'), { schema: 1, source: expected, files: inventory(join(root, 'compiled')) });
  verifyFrozen(root, expected);
}
export async function assemble(desktop, root, name, expected, builder, base, runner = run) {
  const frozen = verifyFrozen(root, expected), variant = variants[name];
  if (!variant) throw new Error('Choose --variant public or local');
  const output = join(root, variant.directory), stage = join(root, `stage-${name}`);
  if (existsSync(output) || existsSync(stage)) throw new Error(`Refusing to overwrite prior ${name} assembly`);
  mkdirSync(output); mkdirSync(stage);
  cpSync(join(root, 'compiled/out'), join(stage, 'out'), { recursive: true });
  cpSync(join(root, 'compiled/mobile'), join(stage, 'mobile'), { recursive: true });
  equal(inventory(stage), frozen.files, 'Staged compiled inventory');
  const config = assemblyConfig(base, desktop, stage, output, variant, frozen);
  // All runtime dependencies are bundled by the official builders. No dependency install in staging.
  const pkg = { ...json(join(desktop, 'package.json')), dependencies: {}, devDependencies: {}, ...config.extraMetadata };
  save(join(stage, 'package.json'), pkg);
  const overlay = { variant: name, extraMetadata: config.extraMetadata, nativeVersion: variant.version, source: expected };
  save(join(output, 'ASSEMBLY_PLAN.json'), overlay); // Written before any ASAR/native signing.
  const files = await builder(config);
  equal(json(join(stage, 'package.json')), pkg, 'Staged metadata after assembly');
  equal(inventory(join(stage, 'out')), inventory(join(root, 'compiled/out')), 'Staged desktop after assembly');
  equal(inventory(join(stage, 'mobile')), inventory(join(root, 'compiled/mobile')), 'Staged mobile after assembly');
  verifyFrozen(root, expected);
  // Each assembly's DMG receives its own seal. No app metadata is edited after builder signs.
  for (const file of files.filter(file => file.endsWith('.dmg'))) runner('/usr/bin/codesign', ['--force', '--sign', '-', file], desktop);
  const artifacts = ['zip', 'dmg'].map(ext => join(output, `Botling-2-${variant.version}-mac-arm64.${ext}`));
  for (const path of artifacts) if (!files.includes(path) || !lstatSync(path).size) throw new Error(`Missing expected artifact: ${path}`);
  writeFileSync(join(output, 'SOURCE_COMMIT.txt'), expected.sourceSHA + '\n', { flag: 'wx' });
  save(join(output, 'VARIANT_PROVENANCE.json'), { schema: 1, ...overlay,
    overlaySHA256: digest(readFileSync(join(output, 'ASSEMBLY_PLAN.json'))),
    compiledProvenanceSHA256: digest(readFileSync(join(root, 'COMPILED_PROVENANCE.json'))),
    artifacts: artifacts.map(path => ({ path: relative(output, path), sha256: digest(readFileSync(path)) })),
    acceptance: 'Assembly only; actual ASAR/native version, codesign, profile/bootstrap and release gates still required' });
  return { output, variant, zip: artifacts[0], artifacts };
}
export async function releaseVariants(desktop, args) {
  const value = flag => args[args.indexOf(flag) + 1];
  const modes = ['--release-variants', '--compile-only', '--reuse-built'].filter(flag => args.includes(flag));
  if (modes.length !== 1) throw new Error('Select exactly one release mode');
  const mode = modes[0], raw = value(mode);
  const allowed = new Set([mode, '--variant', '--sign-manifests']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unknown release argument: ${args[i]}`);
    if (args[i] !== '--sign-manifests') i++;
  }
  if (!raw || !isAbsolute(raw)) throw new Error('Release root must be an absolute path');
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This release requires macOS arm64');
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.BOTLING_RELEASE_KEY) throw new Error('Release variants require ad-hoc Apple signing and file-only Ed25519 signing');
  const root = resolve(raw), checkout = realpathSync(join(desktop, '..'));
  const parent = realpathSync(dirname(root));
  if (parent === checkout || parent.startsWith(checkout + '/')) throw new Error('Release root must be outside the source checkout');
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('Release root must not be a symlink');
  if (mode === '--reuse-built' && !variants[value('--variant')]) throw new Error('Reuse requires --variant public or local');
  if (mode !== '--reuse-built' && args.includes('--variant')) throw new Error('--variant requires --reuse-built');
  if (mode === '--compile-only' && args.includes('--sign-manifests')) throw new Error('Compile-only cannot sign');
  process.env.BOTLING_RELEASE_BUILD = '1'; process.env.BOTLING_UNSIGNED_UPDATES = '0';
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const expected = source(desktop);
  if (mode !== '--reuse-built') await compileOnce(desktop, root, expected);
  else verifyFrozen(root, expected);
  if (mode === '--compile-only') return;
  process.env.ELECTRON_BUILDER_CACHE ||= join(parent, 'cache/electron-builder');
  process.env.electron_config_cache ||= join(parent, 'cache/electron');
  const { build, Platform } = await import('electron-builder');
  const base = (await import(pathToFileURL(join(desktop, 'electron-builder.config.cjs')).href)).default;
  for (const name of mode === '--reuse-built' ? [value('--variant')] : ['public', 'local']) {
    equal(source(desktop), expected, 'Source before assembly');
    const result = await assemble(desktop, root, name, expected,
      config => build({ projectDir: desktop, targets: Platform.MAC.createTarget(), config, publish: 'never' }), base);
    if (args.includes('--sign-manifests')) {
      run(process.execPath, [join(desktop, 'scripts/release-sign.mjs'), 'sign', result.variant.version, result.zip], desktop);
      const manifest = `${result.zip}.manifest.json`;
      checkArtifact(readFileSync(result.zip), json(manifest), json(join(desktop, 'release-config.json')).publicKey, result.variant.version);
      result.artifacts.push(manifest);
    }
    writeFileSync(join(result.output, 'SHA256SUMS.txt'), result.artifacts.map(path => `${digest(readFileSync(path))}  ${relative(result.output, path)}\n`).join(''), { flag: 'wx' });
    console.log(`Assembled ${name}: ${result.output}; acceptance gates remain required`);
  }
}
