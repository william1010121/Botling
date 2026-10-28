import { test } from 'node:test';
import { finished } from 'node:stream/promises';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, cpSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble, assemblyConfig, checkExtraResources, compileOnce, inventory, variants, verifyFrozen } from './release-variants.mjs';
import { checkMetadata } from './release-check.mjs';

function fixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'release-variants-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const desktop = join(tmp, 'desktop'), root = join(tmp, 'release');
  mkdirSync(desktop);
  const contract = { version: 1, epoch: 2 };
  writeFileSync(join(desktop, 'package.json'), JSON.stringify({ version: '2.0.0', botlingDevTrial: false,
    botlingStorageContract: contract, devDependencies: { electron: '44.9.3' }, dependencies: { example: '1' } }));
  const expected = { sourceSHA: 'reviewed-sha', sourceDirty: 0, storageContract: contract };
  const calls = [];
  const runner = (_cmd, args) => {
    calls.push(args);
    if (args[0].endsWith('/build.mjs') && !args[0].includes('/mobile/')) {
      mkdirSync(join(desktop, 'out/core'), { recursive: true });
      writeFileSync(join(desktop, 'out/core/storage-contract.json'), JSON.stringify(contract));
      writeFileSync(join(desktop, 'out/core/main.cjs'), 'compiled core');
      mkdirSync(join(desktop, 'out/report'), { recursive: true });
      for (const name of ['report-blocks.md', 'NOTICE', 'THIRD_PARTY_LICENSES.txt']) writeFileSync(join(desktop, 'out/report', name), `approved ${name}`);
    } else if (args[0].endsWith('/mobile/build.mjs')) {
      mkdirSync(join(desktop, 'mobile/dist'), { recursive: true });
      writeFileSync(join(desktop, 'mobile/dist/web.js'), 'compiled mobile');
      for (const name of ['index.html', 'styles.css', 'token-flow.css', 'web.css', 'chat.html', 'chat.js', 'chat.css', 'frame.css', 'frame-host.html', 'frame-host.js', 'manifest.webmanifest', 'icon.svg', 'plugins/ccb-latex/katex.min.css', 'plugins/ccb-latex/fonts/fixture.woff2']) {
        mkdirSync(join(desktop, 'mobile/dist', name, '..'), { recursive: true });
        writeFileSync(join(desktop, 'mobile/dist', name), `approved ${name}`);
      }
    }
  };
  const base = { directories: {}, extraMetadata: { main: 'out/main/main.cjs' }, mac: { extendInfo: {} }, dmg: {},
    extraResources: [{ from: 'mobile/dist', to: 'mobile' }, { from: 'out/report', to: 'report' }] };
  return { desktop, root, expected, calls, runner, base };
}
test('one desktop/mobile compilation feeds two independent assemblies with metadata fixed before signing', async t => {
  const f = fixture(t);
  await compileOnce(f.desktop, f.root, f.expected, f.runner, () => f.expected);
  const frozen = readFileSync(join(f.root, 'COMPILED_PROVENANCE.json'), 'utf8');
  const configs = [];
  const builder = async config => {
    configs.push(config);
    const pkg = JSON.parse(readFileSync(join(config.directories.app, 'package.json')));
    assert.equal(pkg.version, config.extraMetadata.version);
    assert.equal(pkg.botlingDevTrial, config.extraMetadata.botlingDevTrial);
    assert.equal(config.mac.extendInfo.CFBundleShortVersionString, pkg.version);
    assert.deepEqual(pkg.botlingStorageContract, f.expected.storageContract);
    assert.deepEqual(pkg.dependencies, {});
    assert.ok(readFileSync(join(config.directories.output, 'ASSEMBLY_PLAN.json')).length);
    return ['zip', 'dmg'].map(ext => {
      const path = join(config.directories.output, `Botling-2-${pkg.version}-mac-arm64.${ext}`);
      writeFileSync(path, `separately assembled ${pkg.version} ${ext}`); return path;
    });
  };
  for (const name of ['public', 'local']) await assemble(f.desktop, f.root, name, f.expected, builder, f.base, f.runner);
  assert.equal(f.calls.filter(args => args[0].endsWith('build.mjs')).length, 2);
  assert.equal(f.calls.filter(args => args[0] === '--force').length, 2);
  assert.notEqual(configs[0].directories.app, configs[1].directories.app);
  assert.notEqual(configs[0].directories.output, configs[1].directories.output);
  assert.equal(configs[0].extraMetadata.botlingDevTrial, false);
  assert.equal(configs[1].extraMetadata.botlingDevTrial, true);
  assert.equal(configs[0].dmg.contents[1].path, '/Applications');
  assert.equal(configs[1].dmg.contents[1].name, 'LOCAL-UPGRADE.md');
  assert.ok(!JSON.stringify(configs[1].dmg).includes('launch-dev-trial'));
  assert.equal(readFileSync(join(f.root, 'COMPILED_PROVENANCE.json'), 'utf8'), frozen);
  await assert.rejects(assemble(f.desktop, f.root, 'public', f.expected, builder, f.base, f.runner), /overwrite/);
  await assert.rejects(compileOnce(f.desktop, f.root, f.expected, f.runner, () => f.expected), /EEXIST/);
});
test('reuse refuses changed source, bytes, added files, symlinks and storage mismatch', async t => {
  const f = fixture(t);
  await compileOnce(f.desktop, f.root, f.expected, f.runner, () => f.expected);
  assert.throws(() => verifyFrozen(f.root, { ...f.expected, sourceSHA: 'other' }), /Source/);
  const file = join(f.root, 'compiled/mobile/dist/web.js');
  writeFileSync(file, 'tampered'); assert.throws(() => verifyFrozen(f.root, f.expected), /inventory/);
  writeFileSync(file, 'compiled mobile');
  const extra = join(f.root, 'compiled/extra'); writeFileSync(extra, 'added');
  assert.throws(() => verifyFrozen(f.root, f.expected), /inventory/); rmSync(extra);
  symlinkSync(file, extra); assert.throws(() => inventory(join(f.root, 'compiled')), /Symlink/); rmSync(extra);
  const contract = join(f.root, 'compiled/out/core/storage-contract.json');
  writeFileSync(contract, JSON.stringify({ version: 1, epoch: 3 }));
  const manifestPath = join(f.root, 'COMPILED_PROVENANCE.json');
  const manifest = JSON.parse(readFileSync(manifestPath)); manifest.files = inventory(join(f.root, 'compiled'));
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyFrozen(f.root, f.expected), /storage contract/);
});
test('public metadata gate remains strict; local override cannot pass as public', t => {
  const f = fixture(t), provenance = { source: f.expected };
  const cfg = assemblyConfig(f.base, f.desktop, '/stage', '/output', variants.local, provenance);
  assert.throws(() => checkMetadata(cfg.extraMetadata, { version: variants.local.version }), /stable/);
  assert.throws(() => assemblyConfig(f.base, f.desktop, '/stage', '/output', { version: 'fake' }, provenance), /Unknown/);
});
test('compile failures and mid-compile source changes cannot create reusable provenance', async t => {
  const f = fixture(t);
  await assert.rejects(compileOnce(f.desktop, f.root, f.expected, () => { throw new Error('build failed'); }, () => f.expected), /build failed/);
  assert.throws(() => verifyFrozen(f.root, f.expected), /ENOENT/);
  rmSync(f.root, { recursive: true });
  await assert.rejects(compileOnce(f.desktop, f.root, f.expected, f.runner, () => ({ ...f.expected, sourceSHA: 'changed' })), /Source after compilation/);
  assert.throws(() => verifyFrozen(f.root, f.expected), /ENOENT/);
});
test('packaged metadata refuses native/version/profile/storage relabeling', async () => {
  const { checkPackagedMetadata } = await import('./release-variants.mjs');
  const contract = { version: 1, epoch: 2 }, variant = variants.local;
  const pkg = { version: variant.version, botlingDevTrial: true, botlingUpdates: 'verified-updates', botlingStorageContract: contract };
  checkPackagedMetadata(pkg, variant.version, contract, variant, contract);
  assert.throws(() => checkPackagedMetadata(pkg, '2.0.0', contract, variant, contract), /Native version/);
  assert.throws(() => checkPackagedMetadata({ ...pkg, botlingDevTrial: false }, variant.version, contract, variant, contract), /profile/);
  assert.throws(() => checkPackagedMetadata(pkg, variant.version, { version: 1, epoch: 3 }, variant, contract), /storage/);
});
test('existing update version comparator orders installed dev < local trial < public', async () => {
  const { transpileModule, ModuleKind } = await import('typescript');
  const code = transpileModule(readFileSync(new URL('../src/main/updates.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext } }).outputText;
  const { compareVersions, parseVersion } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  assert.ok(compareVersions(parseVersion('2.0.0-dev.20261029.18'), parseVersion(variants.local.version)) < 0);
  assert.ok(compareVersions(parseVersion(variants.local.version), parseVersion(variants.public.version)) < 0);
});
test('pre-sign hook reads real temporary ASAR and native plist, rejects wrong local label', async t => {
  const f = fixture(t);
  await compileOnce(f.desktop, f.root, f.expected, f.runner, () => f.expected);
  const { createPackage } = await import('@electron/asar');
  const variant = variants.local, stage = join(f.root, 'compiled');
  writeFileSync(join(stage, 'package.json'), JSON.stringify({ version: variant.version,
    botlingDevTrial: true, botlingUpdates: 'verified-updates', botlingStorageContract: f.expected.storageContract }));
  const output = join(f.root, 'fake-app-output'), contents = join(output, 'Botling 2.app/Contents');
  mkdirSync(join(contents, 'Resources'), { recursive: true });
  cpSync(join(stage, 'mobile/dist'), join(contents, 'Resources/mobile'), { recursive: true });
  cpSync(join(stage, 'out/report'), join(contents, 'Resources/report'), { recursive: true });
  await finished(await createPackage(stage, join(contents, 'Resources/app.asar')));
  const plist = version => writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  plist(variant.version);
  const config = assemblyConfig(f.base, f.desktop, stage, output, variant, JSON.parse(readFileSync(join(f.root, 'COMPILED_PROVENANCE.json'))));
  await config.afterPack({ appOutDir: output });
  plist('2.0.0');
  await assert.rejects(config.afterPack({ appOutDir: output }), /Native version/);
});
test('both complete variant configs satisfy installed electron-builder schema without packaging', async t => {
  const f = fixture(t);
  const { default: base } = await import('../electron-builder.config.cjs');
  const { validateConfiguration } = await import('app-builder-lib/out/util/config/config.js');
  for (const variant of Object.values(variants)) {
    const config = assemblyConfig(base, f.desktop, '/temporary-stage', '/temporary-output', variant, { source: f.expected });
    await validateConfiguration(config, { isEnabled: false });
  }
});

for (const mutation of ['tamper-mobile', 'missing-mobile', 'symlink-mobile', 'tamper-report', 'extra-report', 'mode-mobile', 'mode-special', 'symlink-parent', 'missing-report', 'symlink-root', 'extra-mobile', 'extra-directory', 'tamper-font']) {
  test(`pre-sign hook rejects external resource ${mutation} with unchanged frozen sources`, async t => {
    const f = fixture(t);
    await compileOnce(f.desktop, f.root, f.expected, f.runner, () => f.expected);
    const stage = join(f.root, 'compiled'), provenance = verifyFrozen(f.root, f.expected);
    const variant = variants.local, output = join(f.root, 'app-output'), contents = join(output, 'Botling 2.app/Contents');
    mkdirSync(join(contents, 'Resources'), { recursive: true });
    writeFileSync(join(stage, 'package.json'), JSON.stringify({ version: variant.version, botlingDevTrial: true,
      botlingUpdates: 'verified-updates', botlingStorageContract: f.expected.storageContract }));
    const { createPackage } = await import('@electron/asar');
    await finished(await createPackage(stage, join(contents, 'Resources/app.asar')));
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${variant.version}</string></dict></plist>`);
    cpSync(join(stage, 'mobile/dist'), join(contents, 'Resources/mobile'), { recursive: true });
    cpSync(join(stage, 'out/report'), join(contents, 'Resources/report'), { recursive: true });
    const { default: base } = await import('../electron-builder.config.cjs');
    const config = assemblyConfig(base, f.desktop, stage, output, variant, provenance);
    await config.afterPack({ appOutDir: output });
    const mobile = join(contents, 'Resources/mobile/web.js');
    if (mutation === 'tamper-mobile') writeFileSync(mobile, 'tampered');
    if (mutation === 'missing-mobile') rmSync(join(contents, 'Resources/mobile/token-flow.css'));
    if (mutation === 'symlink-mobile') { rmSync(mobile); symlinkSync(join(stage, 'mobile/dist/web.js'), mobile); }
    if (mutation === 'tamper-report') writeFileSync(join(contents, 'Resources/report/NOTICE'), 'tampered');
    if (mutation === 'extra-report') writeFileSync(join(contents, 'Resources/report/extra.txt'), 'unexpected');
    if (mutation === 'mode-mobile') chmodSync(mobile, 0o777);
    if (mutation === 'mode-special') chmodSync(mobile, 0o4644);
    if (mutation === 'missing-report') rmSync(join(contents, 'Resources/report/THIRD_PARTY_LICENSES.txt'));
    if (mutation === 'symlink-root') {
      rmSync(join(contents, 'Resources/mobile'), { recursive: true });
      symlinkSync(join(stage, 'mobile/dist'), join(contents, 'Resources/mobile'));
    }
    if (mutation === 'extra-mobile') writeFileSync(join(contents, 'Resources/mobile/web.js.map'), 'not shipped by approved filter');
    if (mutation === 'extra-directory') mkdirSync(join(contents, 'Resources/report/unexpected-empty'));
    if (mutation === 'tamper-font') writeFileSync(join(contents, 'Resources/mobile/plugins/ccb-latex/fonts/fixture.woff2'), 'tampered');
    if (mutation === 'symlink-parent') {
      cpSync(join(contents, 'Resources'), join(f.root, 'redirected'), { recursive: true });
      rmSync(join(contents, 'Resources'), { recursive: true }); symlinkSync(join(f.root, 'redirected'), join(contents, 'Resources'));
    }
    await assert.rejects(config.afterPack({ appOutDir: output }), /resource|Symlink|ENOENT/);
    // The expected hashes did not change with the actual packaged payload.
    assert.equal(readFileSync(join(stage, 'mobile/dist/web.js'), 'utf8'), 'compiled mobile');
  });
}

test('external resource mapping rejects traversal, unsupported filters, missing approved sources and overlapping destinations', async t => {
  const f = fixture(t);
  await compileOnce(f.desktop, f.root, f.expected, f.runner, () => f.expected);
  const provenance = verifyFrozen(f.root, f.expected), output = join(f.root, 'actual');
  const resources = join(output, 'Botling 2.app/Contents/Resources');
  mkdirSync(resources, { recursive: true });
  cpSync(join(f.root, 'compiled/mobile/dist'), join(resources, 'mobile'), { recursive: true });
  const good = { from: 'mobile/dist', to: 'mobile' };
  checkExtraResources(output, [good], provenance);
  for (const path of ['/absolute', '../escape', 'mobile/../escape', 'mobile\\escape', 'mobile//nested']) {
    assert.throws(() => checkExtraResources(output, [{ ...good, to: path }], provenance), /Unsafe/);
    assert.throws(() => checkExtraResources(output, [{ ...good, from: path }], provenance), /Unsafe/);
  }
  assert.throws(() => checkExtraResources(output, [{ ...good, filter: ['**/*'] }], provenance), /Unsupported/);
  assert.throws(() => checkExtraResources(output, [{ ...good, filter: ['missing.js'] }], provenance), /Missing approved/);
  assert.throws(() => checkExtraResources(output, [good, { ...good, to: 'mobile/nested' }], provenance), /Overlapping/);
  // Frozen files excluded by the exact official mapping do not become packaged expectations.
  const excluded = { ...provenance.files.find(file => file.path === 'mobile/dist/web.js'), path: 'mobile/dist/web.js.map' };
  const { default: base } = await import('../electron-builder.config.cjs');
  checkExtraResources(output, [base.extraResources[0]], { ...provenance, files: [...provenance.files, excluded] });
});
