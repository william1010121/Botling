import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMetadata, checkMetadataV3, checkFeed, assetNames, parseFeed, releaseTrack, tagVersion, releaseFlags, checkPublishedV3, v3Tag, V3_CHANNEL } from './release-check.mjs';

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
