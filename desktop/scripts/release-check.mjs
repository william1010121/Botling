// Read-only release gate. Never changes configuration, signs or publishes.
//   node scripts/release-check.mjs [--track v2|v3] [--tag v2.1.0 | v3.2.2-v3]
//                                                      the version, lockfile, profile and tag agree (--track v3:
//                                                      Botling 3, whose tags end in `-v3`, the update channel)
//   node scripts/release-check.mjs --print-plan <tag|''>
//                                                      key=value lines for the workflow: track, version, release_flags
//   node scripts/release-check.mjs --published v3 --tag <tag> --release <view.json> [--latest-tag <tag>]
//                                                      a v3 release is a pre-release and never GitHub's Latest
//   node scripts/release-check.mjs [--track v3] --artifacts <dir> --platform mac|win|linux
//                                                      the installers and the update feed (latest*.yml) that
//                                                      electron-updater reads are all there, and the feed's
//                                                      checksums match the files
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkMetadata(pkg, lock, tag) {
  if (!/^2\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected stable Electron 2.x version');
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('Package/lock versions differ');
  if (pkg.botlingDevTrial !== false) throw new Error('Release must disable botlingDevTrial');
  if (tag !== undefined && tag !== `v${pkg.version}`) throw new Error('Tag must match desktop/package.json');
  return pkg.version;
}

/** The update channel Botling 3 follows (electron-builder.v3.config.cjs `publish.channel`, src/main/updates.ts UPDATE_CHANNELS). */
export const V3_CHANNEL = 'v3';

/** The tag of a Botling 3 version. electron-updater, with a channel set, only takes a release whose tag's pre-release
 * part is that channel (GitHubProvider.getLatestVersion), so the tag carries `-v3` while the app's version stays 3.x.y. */
export const v3Tag = version => `v${version}-${V3_CHANNEL}`;

/** Botling 3: a stable 3.x.y version in package.json and the lockfile, and a `v3.x.y-v3` tag. `botlingDevTrial` is not
 * judged here: Botling 3's main is the 2.x main and does read it, from the packed package.json, so
 * electron-builder.v3.config.cjs packs `false` (and its own DMG) whatever desktop/package.json says. */
export function checkMetadataV3(pkg, lock, tag) {
  if (!/^3\.\d+\.\d+$/.test(pkg.version)) throw new Error('Expected stable Botling 3 version (3.x.y)');
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('Package/lock versions differ');
  if (tag !== undefined && tag !== v3Tag(pkg.version)) throw new Error(`Botling 3 tag must be ${v3Tag(pkg.version)}: the -${V3_CHANNEL} suffix is the update channel 3.x installs follow`);
  return pkg.version;
}

/** Which line a tag (or, with no tag, a package version) belongs to: `v2` or `v3`. Throws for any other shape, so a
 * `v3.2.2` tag (which 3.x installs would never find) stops the run instead of making a release. */
export function releaseTrack(tag, version) {
  if (tag) {
    if (tag.startsWith('v2.')) return 'v2';
    if (/^v3\.\d+\.\d+-v3$/.test(tag)) return 'v3';
    if (tag.startsWith('v3.')) throw new Error(`Botling 3 tag must look like v3.x.y-${V3_CHANNEL} (got ${tag}): the -${V3_CHANNEL} suffix is the update channel 3.x installs follow`);
    throw new Error(`Unknown release tag ${tag}`);
  }
  const major = /^(\d+)\./.exec(version ?? '')?.[1];
  if (major === '2') return 'v2';
  if (major === '3') return 'v3';
  throw new Error(`Cannot tell the release line from version ${version}`);
}

/** The app version a tag releases (v2.6.0 -> 2.6.0, v3.2.2-v3 -> 3.2.2). */
export const tagVersion = tag => releaseTrack(tag) === 'v3' ? tag.slice(1, -(V3_CHANNEL.length + 1)) : tag.slice(1);

/** The `gh release edit` flags that finish a release: v2 is published as Latest (2.x installs read the Latest release's
 * latest-mac.yml); v3 stays a pre-release and never Latest, so 2.x update checks never see it, and stays a draft until a
 * person publishes it. */
export const releaseFlags = track => {
  if (track === 'v2') return ['--draft=false', '--latest'];
  if (track === 'v3') return ['--prerelease', '--latest=false'];
  throw new Error(`Unknown release line: ${track}`);
};

/** What `gh release view --json isPrerelease,tagName` and `gh api .../releases/latest` say once a v3 release is made. */
export function checkPublishedV3(tag, view, latestTag) {
  if (view?.tagName !== tag) throw new Error(`Release ${view?.tagName} is not ${tag}`);
  if (view.isPrerelease !== true) throw new Error(`${tag} is not marked pre-release: 2.x installs would read it as Latest and fail to find latest-mac.yml`);
  if (latestTag === tag) throw new Error(`${tag} is GitHub's Latest release: 2.x installs would read it and fail to find latest-mac.yml`);
}

/** What electron-builder writes for each platform (electron-builder.config.cjs: artifactName, and the feed names electron-updater reads). */
export function assetNames(version, platform, track = 'v2') {
  if (track === 'v3') {
    // electron-builder.v3.config.cjs: artifactName Botling-3-..., publish channel v3 (so v3-mac.yml); macOS only so far.
    if (platform !== 'mac') throw new Error(`Botling 3 releases only macOS so far, not ${platform}`);
    return { feed: `${V3_CHANNEL}-mac.yml`, files: [`Botling-3-${version}-mac-arm64.zip`, `Botling-3-${version}-mac-arm64.dmg`] };
  }
  const base = `Botling-2-${version}`;
  switch (platform) {
    case 'mac': return { feed: 'latest-mac.yml', files: [`${base}-mac-arm64.zip`, `${base}-mac-arm64.dmg`] };
    case 'win': return { feed: 'latest.yml', files: [`${base}-win-x64.exe`] };
    case 'linux': return { feed: 'latest-linux.yml', files: [`${base}-linux-x86_64.AppImage`, `${base}-linux-amd64.deb`] };
    default: throw new Error(`Unknown platform: ${platform}`);
  }
}

/** The fields of a latest*.yml that matter here: its version and each file's url and sha512 (electron-builder writes plain YAML). */
export function parseFeed(text) {
  const version = /^version:\s*(\S+)/m.exec(text)?.[1];
  const files = [];
  for (const block of text.split(/^  - /m).slice(1)) {
    const url = /^url:\s*(\S+)/m.exec(block)?.[1];
    const sha512 = /^\s*sha512:\s*(\S+)/m.exec(block)?.[1];
    if (url && sha512) files.push({ url: url.replace(/^['"]|['"]$/g, ''), sha512 });
  }
  return { version, files };
}

/** Throws unless the feed names this version and every file it lists is in `read`'s folder with the checksum it states. */
export function checkFeed(feedText, version, platform, read, track = 'v2') {
  const { version: feedVersion, files } = parseFeed(feedText);
  if (feedVersion !== version) throw new Error(`Update feed is for ${feedVersion}, not ${version}`);
  const expected = assetNames(version, platform, track).files.filter((name) => !name.endsWith('.dmg') && !name.endsWith('.deb'));
  for (const name of expected) if (!files.some((file) => file.url === name)) throw new Error(`Update feed does not list ${name}`);
  for (const file of files) {
    const bytes = read(file.url);
    if (createHash('sha512').update(bytes).digest('base64') !== file.sha512) throw new Error(`Checksum of ${file.url} differs from the update feed`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const json = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
  const args = process.argv.slice(2);
  const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const pkg = json('package.json');
  if (args.includes('--print-plan')) {
    // The workflow's plan job: the line, the version the tag releases and the flags that finish the release.
    const tag = value('--print-plan') ?? '';
    const track = releaseTrack(tag, pkg.version);
    console.log(`track=${track}\nversion=${tag ? tagVersion(tag) : ''}\nrelease_flags=${releaseFlags(track).join(' ')}`);
  } else if (args.includes('--published')) {
    if (value('--published') !== 'v3') throw new Error('--published checks a v3 release');
    const file = value('--release');
    if (!file) throw new Error('--published needs --release <gh release view json>');
    checkPublishedV3(value('--tag'), JSON.parse(readFileSync(file, 'utf8')), value('--latest-tag') || undefined);
    console.log(`${value('--tag')}: pre-release, not Latest`);
  } else {
    const track = value('--track') ?? 'v2';
    if (track !== 'v2' && track !== 'v3') throw new Error('--track needs v2 or v3');
    const tag = value('--tag');
    if (args.includes('--tag') && !tag) throw new Error('--tag needs a value');
    // A dev-trial build is not a stable release (no stable-version rule), but its artifacts are still checked.
    const version = track === 'v3' ? checkMetadataV3(pkg, json('package-lock.json'), tag)
      : args.includes('--artifacts') && pkg.botlingDevTrial === true ? pkg.version : checkMetadata(pkg, json('package-lock.json'), tag);
    if (args.includes('--artifacts')) {
      const dir = value('--artifacts'), platform = value('--platform');
      if (!dir || dir.startsWith('--')) throw new Error('--artifacts needs a directory');
      if (!platform) throw new Error('--artifacts needs --platform mac|win|linux');
      const names = assetNames(version, platform, track);
      for (const name of names.files) if (!statSync(join(resolve(dir), name)).isFile() || statSync(join(resolve(dir), name)).size <= 0) throw new Error(`${name} is missing or empty`);
      checkFeed(readFileSync(join(resolve(dir), names.feed), 'utf8'), version, platform, name => readFileSync(join(resolve(dir), name)), track);
    }
    console.log(`${track === 'v3' ? 'Botling' : 'Electron'} ${version}: requested release checks passed`);
  }
}
