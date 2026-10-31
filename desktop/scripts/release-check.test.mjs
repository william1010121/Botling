import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { checkMetadata, checkFeed, assetNames, parseFeed } from './release-check.mjs';

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
