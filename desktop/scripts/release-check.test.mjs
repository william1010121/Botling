import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMetadata, checkMetadataV3, checkFeed, assetNames, parseFeed, releaseTrack, tagVersion, releaseFlags, checkPublishedV3, checkCiGreen, v3Tag, V3_CHANNEL } from './release-check.mjs';

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

const zip = Buffer.from('synthetic ZIP bytes');
const feed = (version, bytes = zip, name = `Botling-2-${version}-mac-arm64.zip`) => `version: ${version}
files:
  - url: ${name}
    sha512: ${createHash('sha512').update(bytes).digest('base64')}
    size: ${bytes.length}
path: ${name}
sha512: ${createHash('sha512').update(bytes).digest('base64')}
releaseDate: '2026-10-31T00:00:00.000Z'
`;
test('the update feed must name this version, list the platform installer and match its checksum', () => {
  const read = () => zip;
  checkFeed(feed('2.0.0'), '2.0.0', 'mac', read);
  assert.deepEqual(parseFeed(feed('2.0.0')).files.map((file) => file.url), ['Botling-2-2.0.0-mac-arm64.zip']);
  assert.throws(() => checkFeed(feed('2.0.1'), '2.0.0', 'mac', read), /not 2\.0\.0/);
  assert.throws(() => checkFeed(feed('2.0.0', zip, 'other.zip'), '2.0.0', 'mac', read), /does not list/);
  assert.throws(() => checkFeed(feed('2.0.0'), '2.0.0', 'mac', () => Buffer.from('tampered')), /Checksum/);
  assert.throws(() => assetNames('2.0.0', 'amiga'));
  assert.deepEqual(assetNames('2.0.0', 'win'), { feed: 'latest.yml', files: ['Botling-2-2.0.0-win-x64.exe'] });
});

// ---- Botling 3 (tags v3.x.y-v3, feed v3-mac.yml, a pre-release that is never Latest) ----
const pkg3 = { version: '3.2.2', botlingDevTrial: true };
const lock3 = { version: '3.2.2', packages: { '': { version: '3.2.2' } } };
test('a v3 tag carries the update channel, and the stable-looking tag that 3.x installs would never find is refused', () => {
  assert.equal(V3_CHANNEL, 'v3');
  assert.equal(v3Tag('3.2.2'), 'v3.2.2-v3');
  assert.equal(checkMetadataV3(pkg3, lock3, 'v3.2.2-v3'), '3.2.2');
  assert.equal(checkMetadataV3(pkg3, lock3), '3.2.2');
  for (const tag of ['v3.2.2', 'v3.2.2-v2', 'v3.2.3-v3', 'v2.6.0', '3.2.2-v3']) assert.throws(() => checkMetadataV3(pkg3, lock3, tag), /tag must be v3\.2\.2-v3/);
  for (const version of ['2.6.0', '3.0.0-beta.1', '3.2', '4.0.0']) {
    assert.throws(() => checkMetadataV3({ ...pkg3, version }, { version, packages: { '': { version } } }, undefined), /stable Botling 3 version/);
  }
  assert.throws(() => checkMetadataV3(pkg3, { ...lock3, version: '3.2.1' }), /differ/);
  assert.throws(() => checkMetadataV3(pkg3, { ...lock3, packages: { '': { version: '3.2.1' } } }), /differ/);
  // The 2.x gate is unchanged: it still refuses a 3.x package and a v3 tag.
  assert.throws(() => checkMetadata({ ...pkg3, botlingDevTrial: false }, lock3, undefined), /2\.x/);
});

test('releaseTrack: v2.* is 2.x, v3.x.y-v3 is 3.x, nothing else passes; with no tag the package version decides', () => {
  assert.equal(releaseTrack('v2.6.0'), 'v2');
  assert.equal(releaseTrack('v2.0.1-dev.1'), 'v2');
  assert.equal(releaseTrack('v3.2.2-v3'), 'v3');
  assert.throws(() => releaseTrack('v3.2.2'), /v3\.x\.y-v3/);
  assert.throws(() => releaseTrack('v3.2.2-beta.1'), /v3\.x\.y-v3/);
  assert.throws(() => releaseTrack('v3.2.2-v3-x'), /v3\.x\.y-v3/);
  assert.throws(() => releaseTrack('v4.0.0'), /Unknown release tag/);
  assert.throws(() => releaseTrack('latest'), /Unknown release tag/);
  assert.equal(releaseTrack('', '2.6.0'), 'v2');
  assert.equal(releaseTrack(undefined, '3.2.2'), 'v3');
  assert.throws(() => releaseTrack('', '4.0.0'), /Cannot tell/);
  assert.throws(() => releaseTrack('', undefined), /Cannot tell/);
});

test('tagVersion drops the v and the channel suffix', () => {
  assert.equal(tagVersion('v2.6.0'), '2.6.0');
  assert.equal(tagVersion('v3.2.2-v3'), '3.2.2');
  assert.throws(() => tagVersion('v3.2.2'));
});

test('v2 is finished as Latest; v3 stays a pre-release, never Latest, and is not published by the workflow', () => {
  assert.deepEqual(releaseFlags('v2'), ['--draft=false', '--latest']);
  assert.deepEqual(releaseFlags('v3'), ['--prerelease', '--latest=false']);
  assert.ok(!releaseFlags('v3').includes('--draft=false'));
  assert.throws(() => releaseFlags('v4'));
});

test('a published v3 release must be a pre-release and not GitHub Latest', () => {
  const view = { tagName: 'v3.2.2-v3', isPrerelease: true, isDraft: true };
  checkPublishedV3('v3.2.2-v3', view, 'v2.6.0');
  checkPublishedV3('v3.2.2-v3', view, undefined);
  assert.throws(() => checkPublishedV3('v3.2.2-v3', { ...view, isPrerelease: false }, 'v2.6.0'), /not marked pre-release/);
  assert.throws(() => checkPublishedV3('v3.2.2-v3', { ...view, isPrerelease: undefined }, 'v2.6.0'), /not marked pre-release/);
  assert.throws(() => checkPublishedV3('v3.2.2-v3', view, 'v3.2.2-v3'), /Latest/);
  assert.throws(() => checkPublishedV3('v3.2.2-v3', { ...view, tagName: 'v3.2.1-v3' }, 'v2.6.0'), /is not v3\.2\.2-v3/);
  assert.throws(() => checkPublishedV3('v3.2.2-v3', undefined, 'v2.6.0'));
});

const feed3 = (version, bytes = zip, name = `Botling-3-${version}-mac-arm64.zip`) => feed(version, bytes, name);
test('v3 assets: Botling-3 zip and dmg, the v3-mac.yml feed, macOS only', () => {
  assert.deepEqual(assetNames('3.2.2', 'mac', 'v3'), { feed: 'v3-mac.yml', files: ['Botling-3-3.2.2-mac-arm64.zip', 'Botling-3-3.2.2-mac-arm64.dmg'] });
  assert.deepEqual(assetNames('2.0.0', 'mac'), { feed: 'latest-mac.yml', files: ['Botling-2-2.0.0-mac-arm64.zip', 'Botling-2-2.0.0-mac-arm64.dmg'] });
  assert.throws(() => assetNames('3.2.2', 'win', 'v3'), /only macOS/);
  assert.throws(() => assetNames('3.2.2', 'linux', 'v3'), /only macOS/);
  const read = () => zip;
  checkFeed(feed3('3.2.2'), '3.2.2', 'mac', read, 'v3');
  assert.throws(() => checkFeed(feed3('3.2.2', zip, 'Botling-2-3.2.2-mac-arm64.zip'), '3.2.2', 'mac', read, 'v3'), /does not list Botling-3-3\.2\.2/);
  assert.throws(() => checkFeed(feed3('3.2.1'), '3.2.2', 'mac', read, 'v3'), /not 3\.2\.2/);
  assert.throws(() => checkFeed(feed3('3.2.2'), '3.2.2', 'mac', () => Buffer.from('tampered'), 'v3'), /Checksum/);
});

const here = fileURLToPath(new URL('.', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [join(here, 'release-check.mjs'), ...args], { encoding: 'utf8' });
test('--print-plan gives the workflow its line, version and finishing flags, and fails a bad tag', () => {
  assert.equal(run('--print-plan', 'v3.2.2-v3').stdout, 'track=v3\nversion=3.2.2\nrelease_flags=--prerelease --latest=false\n');
  assert.equal(run('--print-plan', 'v2.6.0').stdout, 'track=v2\nversion=2.6.0\nrelease_flags=--draft=false --latest\n');
  const bare = run('--print-plan', 'v3.2.2');
  assert.notEqual(bare.status, 0);
  assert.match(bare.stderr, /v3\.x\.y-v3/);
  assert.notEqual(run('--print-plan', 'v9.0.0').status, 0);
});

test('--published v3 reads the gh release view and refuses a non-pre-release or a Latest one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-check-'));
  const file = join(dir, 'view.json');
  writeFileSync(file, JSON.stringify({ tagName: 'v3.2.2-v3', isPrerelease: true, isDraft: true }));
  assert.equal(run('--published', 'v3', '--tag', 'v3.2.2-v3', '--release', file, '--latest-tag', 'v2.6.0').status, 0);
  assert.equal(run('--published', 'v3', '--tag', 'v3.2.2-v3', '--release', file, '--latest-tag', '').status, 0);
  assert.notEqual(run('--published', 'v3', '--tag', 'v3.2.2-v3', '--release', file, '--latest-tag', 'v3.2.2-v3').status, 0);
  writeFileSync(file, JSON.stringify({ tagName: 'v3.2.2-v3', isPrerelease: false, isDraft: false }));
  assert.notEqual(run('--published', 'v3', '--tag', 'v3.2.2-v3', '--release', file).status, 0);
  assert.notEqual(run('--published', 'v2', '--tag', 'v2.6.0', '--release', file).status, 0);
});

// The workflow wiring that no function can check: what a v3 tag runs, and what it must never do.
const workflow = readFileSync(join(here, '../../.github/workflows/release.yml'), 'utf8');
const job = name => { const start = workflow.indexOf(`\n  ${name}:\n`); assert.ok(start >= 0, `job ${name}`); const next = workflow.slice(start + 1).search(/\n  [a-z]+:\n/); return next < 0 ? workflow.slice(start) : workflow.slice(start, start + 1 + next); };
test('release.yml: v3 tags start it, only a plan job decides the line, and Windows and Linux are 2.x only', () => {
  assert.match(workflow, /tags: \['v2\.\*', 'v3\.\*'\]/);
  assert.match(job('plan'), /release-check\.mjs --print-plan "\$TAG"/);
  for (const name of ['candidate', 'windows', 'linux', 'publish']) assert.match(job(name), /needs: (\[plan|plan)/, `${name} needs plan`);
  for (const name of ['windows', 'linux']) assert.match(job(name), /needs\.plan\.outputs\.track == 'v2'/, `${name} is 2.x only`);
  assert.match(job('candidate'), /TRACK: \$\{\{ needs\.plan\.outputs\.track \}\}/);
});
test('release.yml: a v3 build is checked with the v3 rules, packaged with the v3 config and its own version, and ships no agent assets', () => {
  const candidate = job('candidate');
  assert.match(candidate, /release-check\.mjs --track v3 --tag "\$REF_NAME"/);
  assert.match(candidate, /BOTLING_V3_VERSION=\$\(node -p 'require\("\.\/package\.json"\)\.version'\) npm run dist:mac:v3/);
  assert.match(candidate, /dist\/v3\/Botling-3-\$VERSION-mac-arm64\.zip/);
  assert.match(candidate, /Botling 3\.app/);
  assert.match(candidate, /release-check\.mjs --track v3 --artifacts dist\/v3 --platform mac/);
  assert.match(candidate, /name: Build the botling-agent assets[^\n]*\n(?:[^\n]*\n)*?\s+if: \$\{\{ env\.TRACK == 'v2' \}\}/);
  assert.match(candidate, /desktop\/dist\/v3\/v3-mac\.yml/);
  assert.doesNotMatch(candidate, /desktop\/dist\/v3\/latest-mac\.yml/);
});
test('release.yml: the publish job never makes a v3 release Latest or public, and checks it after', () => {
  const publish = job('publish');
  assert.match(publish, /RELEASE_FLAGS: \$\{\{ needs\.plan\.outputs\.release_flags \}\}/);
  assert.match(publish, /gh release edit "\$TAG" \$RELEASE_FLAGS/);
  assert.doesNotMatch(publish, /--latest\s*$/m);
  assert.doesNotMatch(publish, /--draft=false/);
  assert.match(publish, /release-check\.mjs --published v3 --tag "\$TAG" --release/);
  assert.match(publish, /A v3 release must not hold \$f/);
  assert.match(publish, /v3-mac\.yml/);
});

// ---- Fix round: the command line, the workflow's steps and the scripts they run, and package.mjs's wiring ----
// The functions above are tested directly; these run what the workflow runs, so a guard that is dropped or unwired fails.
const mkRoot = (pkgJson, lockJson) => {
  // The real path: the script runs its command line only when its own path is the one it was started from (/var is /private/var on macOS).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'release-root-')));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(join(here, 'release-check.mjs'), join(root, 'scripts/release-check.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkgJson));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lockJson));
  return root;
};
const runIn = (root, ...args) => spawnSync(process.execPath, [join(root, 'scripts/release-check.mjs'), ...args], { encoding: 'utf8' });
const mkDist = files => {
  const dir = mkdtempSync(join(tmpdir(), 'release-dist-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
};
const dist3 = (version = '3.2.2') => mkDist({ [`Botling-3-${version}-mac-arm64.zip`]: zip, [`Botling-3-${version}-mac-arm64.dmg`]: 'dmg', 'v3-mac.yml': feed3(version) });
const dist2 = (version = '2.0.0') => mkDist({ [`Botling-2-${version}-mac-arm64.zip`]: zip, [`Botling-2-${version}-mac-arm64.dmg`]: 'dmg', 'latest-mac.yml': feed(version) });

test('the command line: --track v3 checks a Botling 3 tag and the v3-mac.yml artifacts, and 2.x keeps its own rules', () => {
  const root3 = mkRoot({ version: '3.2.2', botlingDevTrial: true }, lock3);
  const ok = runIn(root3, '--track', 'v3', '--tag', 'v3.2.2-v3', '--artifacts', dist3(), '--platform', 'mac');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Botling 3\.2\.2: requested release checks passed/);
  assert.equal(runIn(root3, '--track', 'v3').status, 0);
  // No tag, no artifacts: the metadata alone; a 2.x tag, a bare v3 tag and a 2.x feed in place of the v3 one are refused.
  assert.notEqual(runIn(root3, '--track', 'v3', '--tag', 'v3.2.2').status, 0);
  assert.notEqual(runIn(root3, '--track', 'v3', '--artifacts', dist2('3.2.2'), '--platform', 'mac').status, 0);
  assert.notEqual(runIn(root3, '--track', 'v3', '--artifacts', mkDist({ 'Botling-3-3.2.2-mac-arm64.zip': zip, 'Botling-3-3.2.2-mac-arm64.dmg': 'dmg', 'v3-mac.yml': feed3('3.2.2', Buffer.from('other')) }), '--platform', 'mac').status, 0);
  assert.notEqual(runIn(root3, '--track', 'v3', '--artifacts', dist3(), '--platform', 'win').status, 0);
  // Without --track the 2.x gate runs, and it refuses this 3.x package.
  assert.notEqual(runIn(root3, '--tag', 'v3.2.2-v3').status, 0);
  assert.match(runIn(root3, '--track', 'v4').stderr, /--track needs v2 or v3/);
  // A 2.x package and its artifacts still pass the default track, and the v3 track refuses them.
  const root2 = mkRoot(pkg, lock);
  const ok2 = runIn(root2, '--tag', 'v2.0.0', '--artifacts', dist2(), '--platform', 'mac');
  assert.equal(ok2.status, 0, ok2.stderr);
  assert.match(ok2.stdout, /Electron 2\.0\.0: requested release checks passed/);
  assert.notEqual(runIn(root2, '--track', 'v3').status, 0);
});

test('--published only checks a v3 release', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'release-check-')), 'view.json');
  writeFileSync(file, JSON.stringify({ tagName: 'v2.6.0', isPrerelease: true, isDraft: false }));
  const result = run('--published', 'v2', '--tag', 'v2.6.0', '--release', file);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checks a v3 release/);
});

test('package.mjs refuses a Botling 3 release build without BOTLING_V3_VERSION before it builds anything', () => {
  const env = { ...process.env, BOTLING_RELEASE_BUILD: '1' };
  delete env.BOTLING_V3_VERSION;
  const result = spawnSync(process.execPath, [join(here, 'package.mjs'), '--v3', '--mac'], { encoding: 'utf8', env, timeout: 20000 });
  assert.equal(result.status, 1, `${result.signal ?? ''} ${result.stderr}`);
  assert.match(result.stderr, /A Botling 3 release/);
  assert.doesNotMatch(result.stdout, /built |esbuild|Building/i);
});

// Steps of a workflow job, found by a marker in the step's own text; `script` is the step's `run:` body.
const steps = name => job(name).split(/\n      - (?=\S)/).slice(1);
const step = (jobName, marker) => {
  const hits = steps(jobName).filter(s => s.includes(marker));
  assert.equal(hits.length, 1, `${jobName}: one step holds ${marker}`);
  return hits[0];
};
const script = text => {
  const body = /\n {8}run: \|\n((?: {10}[^\n]*\n|\n)+)/.exec(`${text}\n`)?.[1];
  assert.ok(body, 'a run body');
  return body.split('\n').map(line => line.slice(10)).join('\n');
};
const ifOf = text => /\n {8}if: (.*)\n/.exec(text)?.[1];

test('release.yml: each step is for its own line: the 2.x-only steps, the v3-only steps, and the plan job outputs', () => {
  const only2 = "${{ env.TRACK == 'v2' }}", only3 = "${{ env.TRACK == 'v3' }}";
  assert.equal(ifOf(step('candidate', 'name: Build the botling-agent assets')), only2);
  assert.equal(ifOf(step('candidate', 'name: Record source and checksums\n')), only2);
  assert.equal(ifOf(step('candidate', 'name: Botling-2-${{ env.RELEASE_VERSION }}-mac-arm64-candidate')), only2);
  assert.equal(ifOf(step('candidate', 'name: Record source and checksums (Botling 3)')), only3);
  assert.equal(ifOf(step('candidate', 'name: Botling-3-${{ env.RELEASE_VERSION }}-mac-arm64-candidate')), only3);
  assert.equal(ifOf(step('publish', "name: Check a v3 release is a pre-release")), only3);
  assert.match(step('publish', "name: Check a v3 release is a pre-release"), /--latest-tag "\$LATEST"/);
  const plan = job('plan');
  for (const key of ['track', 'version', 'release_flags']) assert.match(plan, new RegExp(`\\n      ${key}: \\$\\{\\{ steps\\.plan\\.outputs\\.${key} \\}\\}\\n`));
  assert.match(plan, /TAG: \$\{\{ github\.ref_type == 'tag' && github\.ref_name \|\| inputs\.tag \}\}/);
  const publish = job('publish');
  for (const [key, from] of [['TRACK', 'track'], ['VERSION', 'version'], ['RELEASE_FLAGS', 'release_flags']]) assert.match(publish, new RegExp(`\\n      ${key}: \\$\\{\\{ needs\\.plan\\.outputs\\.${from} \\}\\}\\n`));
  // The gate step: a v3 build gets the v3 rules with and without a tag; 2.x keeps its trial / stable branches and its artifact check.
  const gate = script(step('candidate', 'name: Check stable tag and production profile'));
  assert.match(gate, /if \[ "\$TRACK" = v3 \]; then\n  if \[ "\$REF_TYPE" = tag \]; then\n    node scripts\/release-check\.mjs --track v3 --tag "\$REF_NAME"\n  else\n    node scripts\/release-check\.mjs --track v3\n  fi\nelif \[ "\$\(node -p 'require\("\.\/package\.json"\)\.botlingDevTrial === true'\)" = true \]; then/);
  assert.match(gate, /\nelif \[ "\$REF_TYPE" = tag \]; then\n  node scripts\/release-check\.mjs --tag "\$REF_NAME"\nelse\n  node scripts\/release-check\.mjs\nfi\n/);
  assert.match(script(step('candidate', 'name: Check the installers')), /else\n  node scripts\/release-check\.mjs --artifacts dist --platform mac\nfi/);
  assert.match(script(step('candidate', 'name: Package macOS arm64')), /else\n  npm run dist:mac\nfi/);
});

// The publish job's "assets match the tag" step, run for real on a folder of fake assets.
const publishCheck = (track, version, names) => {
  const temp = mkdtempSync(join(tmpdir(), 'release-publish-'));
  mkdirSync(join(temp, 'assets'));
  for (const name of names) writeFileSync(join(temp, 'assets', name), 'x');
  const result = spawnSync('bash', ['-c', script(step('publish', 'name: Check the assets match the tag'))], {
    encoding: 'utf8', env: { ...process.env, TRACK: track, VERSION: version, TAG: track === 'v3' ? `v${version}-v3` : `v${version}`, RUNNER_TEMP: temp },
  });
  return { status: result.status, out: result.stdout + result.stderr };
};
const assets3 = ['Botling-3-3.2.2-mac-arm64.zip', 'Botling-3-3.2.2-mac-arm64.dmg', 'v3-mac.yml', 'SHA256SUMS.txt'];
const assets2 = ['Botling-2-2.6.0-mac-arm64.zip', 'Botling-2-2.6.0-mac-arm64.dmg', 'latest-mac.yml', 'latest-linux.yml', 'latest.yml', 'botling-agent-2.6.0.cjs', 'botling-agent-install.sh', 'SHA256SUMS-agent.txt'];
test('release.yml publish: a v3 release holds the macOS assets and no 2.x feed; a 2.x release holds what it always did', () => {
  assert.equal(publishCheck('v3', '3.2.2', assets3).status, 0);
  for (const feedName of ['latest-mac.yml', 'latest-linux.yml', 'latest.yml']) {
    const result = publishCheck('v3', '3.2.2', [...assets3, feedName]);
    assert.notEqual(result.status, 0, feedName);
    assert.match(result.out, new RegExp(`must not hold ${feedName.replace('.', '\\.')}`));
  }
  for (const missing of assets3) {
    const result = publishCheck('v3', '3.2.2', assets3.filter(name => name !== missing));
    assert.notEqual(result.status, 0, missing);
    assert.match(result.out, new RegExp(`Missing asset ${missing.replace('.', '\\.')}`));
  }
  assert.equal(publishCheck('v2', '2.6.0', assets2).status, 0);
  for (const missing of assets2) assert.notEqual(publishCheck('v2', '2.6.0', assets2.filter(name => name !== missing)).status, 0, missing);
  // 2.x does not need SHA256SUMS.txt, and a 3.x tag's assets do not satisfy it.
  assert.notEqual(publishCheck('v2', '3.2.2', assets3).status, 0);
});

// The release job runs no full unit suite: the plan job refuses a tag build unless CI finished green for the tagged commit.
const SHA = 'a7d379a0d10a0afe8f470fa0469cf1892a543a9a';
const OTHER = '4f2745f9e142065b3e28c0a9e0b933984db37626';
const ciRun = (databaseId, status, conclusion, createdAt, headSha = SHA) => ({ databaseId, status, conclusion, headSha, createdAt });
test('the CI gate passes only a finished, successful CI run of the tagged commit and fails closed otherwise', () => {
  assert.equal(checkCiGreen(SHA, [ciRun(7, 'completed', 'success', '2026-11-18T15:17:35Z')]), 7);
  assert.throws(() => checkCiGreen(SHA, []), /no CI run found/);
  // Runs of other commits are no evidence for this one.
  assert.throws(() => checkCiGreen(SHA, [ciRun(8, 'completed', 'success', '2026-11-18T15:17:35Z', OTHER)]), /no CI run found/);
  assert.throws(() => checkCiGreen(SHA, [ciRun(9, 'queued', '', '2026-11-18T15:17:35Z')]), /still queued/);
  assert.throws(() => checkCiGreen(SHA, [ciRun(9, 'in_progress', '', '2026-11-18T15:17:35Z')]), /still in_progress/);
  assert.throws(() => checkCiGreen(SHA, [ciRun(9, 'pending', null, '2026-11-18T15:17:35Z')]), /still pending/);
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', '', null, undefined]) {
    assert.throws(() => checkCiGreen(SHA, [ciRun(10, 'completed', conclusion, '2026-11-18T15:17:35Z')]), /not success/, String(conclusion));
  }
  // A run still going blocks even when an older one passed; among finished runs the newest decides (a cancelled older run, as the concurrency group makes, does not block).
  assert.throws(() => checkCiGreen(SHA, [ciRun(11, 'in_progress', '', '2026-11-18T16:00:00Z'), ciRun(10, 'completed', 'success', '2026-11-18T15:00:00Z')]), /still in_progress/);
  assert.equal(checkCiGreen(SHA, [ciRun(10, 'completed', 'cancelled', '2026-11-18T15:00:00Z'), ciRun(11, 'completed', 'success', '2026-11-18T16:00:00Z')]), 11);
  assert.equal(checkCiGreen(SHA, [ciRun(11, 'completed', 'success', '2026-11-18T16:00:00Z'), ciRun(10, 'completed', 'failure', '2026-11-18T15:00:00Z')]), 11);
  assert.throws(() => checkCiGreen(SHA, [ciRun(10, 'completed', 'success', '2026-11-18T15:00:00Z'), ciRun(11, 'completed', 'failure', '2026-11-18T16:00:00Z')]), /newest CI run 11/);
  // Not a list, junk entries, a short or empty sha.
  assert.throws(() => checkCiGreen(SHA, { message: 'Not Found' }), /not a JSON array/);
  assert.throws(() => checkCiGreen(SHA, [null, 'x', 3]), /no CI run found/);
  assert.throws(() => checkCiGreen(SHA.slice(0, 9), [ciRun(7, 'completed', 'success', '2026-11-18T15:17:35Z', SHA.slice(0, 9))]), /40-character/);
  assert.throws(() => checkCiGreen('', []), /40-character/);
  assert.throws(() => checkCiGreen(undefined, []), /40-character/);
});

test('--ci-green reads the gh run list file and exits non-zero for every case that is not a finished success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-check-ci-'));
  const file = join(dir, 'runs.json');
  const put = value => writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  put([ciRun(7, 'completed', 'success', '2026-11-18T15:17:35Z')]);
  const ok = run('--ci-green', SHA, '--runs', file);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /CI run 7 for a7d379a0d.*: success/);
  for (const bad of [[], [ciRun(7, 'in_progress', '', '2026-11-18T15:17:35Z')], [ciRun(7, 'completed', 'failure', '2026-11-18T15:17:35Z')], [ciRun(7, 'completed', 'success', '2026-11-18T15:17:35Z', OTHER)], '', 'not json', '{"message":"Bad credentials"}']) {
    put(bad);
    assert.notEqual(run('--ci-green', SHA, '--runs', file).status, 0, JSON.stringify(bad));
  }
  put([ciRun(7, 'completed', 'success', '2026-11-18T15:17:35Z')]);
  assert.notEqual(run('--ci-green', SHA).status, 0, 'no --runs');
  assert.notEqual(run('--ci-green', SHA, '--runs', join(dir, 'missing.json')).status, 0, 'no such file');
  assert.notEqual(run('--ci-green', 'abc123', '--runs', file).status, 0, 'a short sha');
});

test('release.yml: the plan job gates a tag build on CI, and the candidate job runs no full unit suite but keeps the typecheck and the whole signed build', () => {
  const gate = step('plan', 'name: CI must be green for the tagged commit');
  assert.equal(ifOf(gate), "${{ github.ref_type == 'tag' }}");
  assert.match(gate, /\n {10}GH_TOKEN: \$\{\{ github\.token \}\}\n/);
  assert.match(gate, /\n {10}SHA: \$\{\{ github\.sha \}\}\n/);
  const body = script(gate);
  assert.match(body, /gh run list -R "\$GITHUB_REPOSITORY" --workflow ci\.yml --commit "\$SHA" /);
  assert.match(body, /--json databaseId,status,conclusion,headSha,createdAt > "\$RUNNER_TEMP\/ci-runs\.json"/);
  assert.match(body, /node desktop\/scripts\/release-check\.mjs --ci-green "\$SHA" --runs "\$RUNNER_TEMP\/ci-runs\.json"/);
  // Fail closed: nothing in the step may turn a failure into a pass.
  assert.doesNotMatch(gate, /continue-on-error|\|\| *(true|:)|set \+e/);
  // It runs before the plan step, in the job whose failure stops every build job, and the job may read workflow runs.
  const names = steps('plan').map(s => /(?:^|\n) *(?:- )?(?:name|id): (\S[^\n]*)/.exec(s)?.[1] ?? '');
  const at = names.findIndex(n => n.startsWith('CI must be green'));
  assert.ok(at >= 0 && at < names.indexOf('plan'), JSON.stringify(names));
  assert.match(job('plan'), /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n/);
  // A job that is allowed to fail lets `needs: plan` pass: no continue-on-error anywhere in plan (the gate step is checked above).
  assert.doesNotMatch(job('plan'), /continue-on-error/);
  for (const name of ['candidate', 'linux', 'windows']) assert.match(job(name), /\n {4}needs: plan\n/, name);
  // The candidate job: no unit suite (CI owns it); the typecheck and the packaging, signing, verification and feed checks stay.
  const candidate = job('candidate');
  assert.doesNotMatch(candidate, /test:unit|vitest/);
  assert.match(candidate, /\n {6}- run: npm run typecheck\n/);
  for (const marker of ['name: Require signing credentials', 'name: Package macOS arm64', 'name: Verify the signature, notarization and Gatekeeper', 'name: Check the installers and the update feed']) step('candidate', marker);
  assert.match(script(step('candidate', 'name: Package macOS arm64')), /npm run dist:mac:v3/);
});
