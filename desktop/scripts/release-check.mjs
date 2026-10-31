// Read-only release gate. Never changes configuration, signs or publishes.
//   node scripts/release-check.mjs [--tag v2.1.0]      the version, lockfile, profile and tag agree
//   node scripts/release-check.mjs --artifacts <dir> --platform mac|win|linux
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

/** What electron-builder writes for each platform (electron-builder.config.cjs: artifactName, and the feed names electron-updater reads). */
export function assetNames(version, platform) {
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
export function checkFeed(feedText, version, platform, read) {
  const { version: feedVersion, files } = parseFeed(feedText);
  if (feedVersion !== version) throw new Error(`Update feed is for ${feedVersion}, not ${version}`);
  const expected = assetNames(version, platform).files.filter((name) => !name.endsWith('.dmg') && !name.endsWith('.deb'));
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
  const tag = value('--tag');
  if (args.includes('--tag') && !tag) throw new Error('--tag needs a value');
  const pkg = json('package.json');
  // A dev-trial build is not a stable release (no stable-version rule), but its artifacts are still checked.
  const version = args.includes('--artifacts') && pkg.botlingDevTrial === true ? pkg.version : checkMetadata(pkg, json('package-lock.json'), tag);
  if (args.includes('--artifacts')) {
    const dir = value('--artifacts'), platform = value('--platform');
    if (!dir || dir.startsWith('--')) throw new Error('--artifacts needs a directory');
    if (!platform) throw new Error('--artifacts needs --platform mac|win|linux');
    const names = assetNames(version, platform);
    for (const name of names.files) if (!statSync(join(resolve(dir), name)).isFile() || statSync(join(resolve(dir), name)).size <= 0) throw new Error(`${name} is missing or empty`);
    checkFeed(readFileSync(join(resolve(dir), names.feed), 'utf8'), version, platform, name => readFileSync(join(resolve(dir), name)));
  }
  console.log(`Electron ${version}: requested release checks passed`);
}
