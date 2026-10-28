import { verifyProfilePin, type InstallProfilePin } from './install-profile';
// Local developer builds use the same signed ZIP authority as downloaded releases.
// A user-selected .app is only a locator/comparison input, never the bytes installed.
import { join, dirname, basename, sep, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyManifest } from '../../scripts/release-manifest.mjs';
import { parseVersion, compareVersions } from './updates';
import type { Fs, Run } from './hot-install';

export async function exactTree(root: string, fs: Fs): Promise<string> {
  if (await fs.promises.realpath(root) !== root || !(await fs.promises.lstat(root)).isDirectory()) throw new Error('Bundle root must be a real directory');
  const hash = createHash('sha256');
  async function visit(path: string, rel: string) {
    const st = await fs.promises.lstat(path);
    const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : '';
    if (!kind) throw new Error('Unsupported bundle entry');
    hash.update(JSON.stringify([rel, kind, st.mode & 0o777]));
    if (kind === 'link') {
      const dest = await fs.promises.realpath(path);
      if (!dest.startsWith(root + sep)) throw new Error('Bundle symlink escapes its root');
      hash.update(await fs.promises.readlink(path));
    } else if (kind === 'dir') {
      for (const name of (await fs.promises.readdir(path)).sort()) await visit(join(path, name), `${rel}/${name}`);
    } else for await (const chunk of fs.createReadStream(path)) hash.update(chunk as Buffer);
  }
  await visit(root, '');
  return hash.digest('hex');
}
export function bundleVersion(text: string): string {
  const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1];
  if (!version || !parseVersion(version)) throw new Error('Invalid bundle version');
  return version;
}
export function requireNewer(version: string, current: string) {
  const a = parseVersion(version), b = parseVersion(current);
  if (!a || !b || a.major !== 2 || compareVersions(a, b) <= 0) throw new Error('Candidate must be newer than the installed version');
}
export interface AuthenticatedBuild { app: string; digest: string; version: string; root: string; zip: string }
export async function authenticateLocalBuild(path: string, target: string, publicKey: string | null, fs: Fs, run: Run, arch = process.arch, profilePin?: InstallProfilePin): Promise<AuthenticatedBuild> {
  const real = await fs.promises.realpath(path);
  if (real !== path || !path.endsWith('.app') || path === target || path.startsWith(target + sep) || target.startsWith(path + sep)) throw new Error('Unsafe candidate path');
  const current = bundleVersion(await fs.promises.readFile(join(target, 'Contents/Info.plist'), 'utf8'));
  const version = bundleVersion(await fs.promises.readFile(join(path, 'Contents/Info.plist'), 'utf8'));
  requireNewer(version, current);
  const name = `Botling-2-${version}-mac-${arch}.zip`;
  const candidates = [`${path}.zip`, join(dirname(path), name), join(dirname(dirname(path)), name)];
  const zip = candidates.find(file => fs.existsSync(file));
  if (!zip) throw new Error(`Signed ZIP required beside the build (${basename(path)}.zip or ${name}, with .manifest.json)`);
  for (const file of [zip, `${zip}.manifest.json`]) {
    if (!(await fs.promises.lstat(file)).isFile() || await fs.promises.realpath(file) !== file) throw new Error('Signed ZIP and manifest must be regular files');
  }
  if ((await fs.promises.stat(`${zip}.manifest.json`)).size > 16384) throw new Error('Manifest too large');
  const manifest = verifyManifest(JSON.parse(await fs.promises.readFile(`${zip}.manifest.json`, 'utf8')), publicKey);
  if (manifest.version !== version) throw new Error('Signed version differs from selected build');
  if ((await fs.promises.stat(zip)).size !== manifest.size) throw new Error('Signed ZIP size mismatch');
  const root = await fs.promises.mkdtemp(join(dirname(target), '.botling-hot-'));
  await fs.promises.chmod(root, 0o700);
  try {
    const archive = join(root, 'candidate.zip');
    await fs.promises.copyFile(zip, archive);
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of fs.createReadStream(archive)) { size += (chunk as Buffer).length; hash.update(chunk as Buffer); }
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('Signed ZIP content mismatch');
    const result = await run('/usr/bin/unzip', ['-Z1', archive]) as { stdout: string };
    const entries = result.stdout.trim().split('\n');
    if (!entries.length || entries.some(p => !p.startsWith('Botling 2.app/') || p.includes('\\') || /[\r\0]/.test(p) || p.split('/').some(n => n === '..' || n === '.'))) throw new Error('Unsafe ZIP paths');
    const summary = await run('/usr/bin/unzip', ['-Z', '-t', archive]) as { stdout: string };
    const bytes = Number(/(\d+) bytes uncompressed/.exec(summary.stdout)?.[1]);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 2 * 1024 ** 3) throw new Error('ZIP expanded size exceeds limit');
    const space = await fs.promises.statfs(root);
    if (space.bavail * space.bsize < bytes * 2 + 64 * 1024 * 1024) throw new Error('Insufficient space for candidate and runtime copies');
    await validateZipLinks(archive, fs, run);
    await run('/usr/bin/ditto', ['-x', '-k', archive, root]);
    const app = join(root, 'Botling 2.app');
    const digest = await exactTree(app, fs);
    if (digest !== await exactTree(path, fs)) throw new Error('Selected build differs from signed ZIP');
    const info = await fs.promises.readFile(join(app, 'Contents/Info.plist'), 'utf8');
    if (bundleVersion(info) !== version || !/<key>CFBundleIdentifier<\/key>\s*<string>io.github.william1010121.Botling2<\/string>/.test(info)) throw new Error('Signed bundle identity mismatch');
    const executable = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(info)?.[1];
    if (!executable || !/^[A-Za-z0-9 ._-]+$/.test(executable)) throw new Error('Invalid signed executable');
    const executableStat = await fs.promises.lstat(join(app, 'Contents/MacOS', executable));
    if (!executableStat.isFile() || !(executableStat.mode & 0o111)) throw new Error('Invalid signed executable');
    const { openApp } = await import('./hot-install');
    const source = await openApp(app, fs);
    if (JSON.parse((await source.read('package.json')).toString('utf8')).version !== version) throw new Error('Signed package version mismatch');
    if (profilePin) await verifyProfilePin(app, profilePin, fs);
    // Validate the entire mobile tree, including files outside the HTTP allowlist.
    const mobile = join(app, 'Contents/Resources/mobile');
    await visitMobile(mobile, fs);
    if (!(await fs.promises.lstat(join(mobile, 'index.html'))).isFile() || !(await fs.promises.lstat(join(mobile, 'web.js'))).isFile()) throw new Error('Missing mobile entry points');
    await fs.promises.writeFile(`${archive}.manifest.json`, JSON.stringify(manifest), { mode: 0o600 });
    return { app, digest, version, root, zip: archive };
  } catch (error) { await run('/bin/rm', ['-rf', root]); throw error; }
}
export async function visitMobile(root: string, fs: Fs): Promise<Record<string, string>> {
  const files: Record<string, string> = {}; let bytes = 0, count = 0;
  async function visit(path: string, rel: string) {
    const st = await fs.promises.lstat(path);
    if (st.isSymbolicLink()) throw new Error('Mobile resources cannot contain symlinks');
    if (st.isDirectory()) for (const name of (await fs.promises.readdir(path)).sort()) {
      if (name.includes('\\') || name === '..' || name === '.') throw new Error('Unsafe mobile path');
      await visit(join(path, name), rel ? `${rel}/${name}` : name);
    }
    else if (st.isFile()) {
      bytes += st.size;
      if (bytes > 128 * 1024 * 1024 || ++count > 4096) throw new Error('Mobile generation exceeds size limit');
      files[rel] = createHash('sha256').update(await fs.promises.readFile(path)).digest('hex');
    }
    else throw new Error('Unsupported mobile resource');
  }
  await visit(root, ''); return files;
}

/** Validate link targets before ditto can write anything through them. ZIP64 is unnecessary under
 * the signed/expanded size limits and is rejected; framework symlinks wholly inside the app work. */
export async function validateZipLinks(zip: string, fs: Fs, run: Run): Promise<void> {
  const h = await fs.promises.open(zip, 'r');
  const entries: { name: string; link: boolean }[] = [];
  try {
    const size = (await h.stat()).size, tail = Buffer.alloc(Math.min(size, 65557));
    await h.read(tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP directory');
    const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16);
    if (count === 65535 || length > 16 * 1024 * 1024 || offset + length > size - 22) throw new Error('ZIP directory exceeds bounds');
    const central = Buffer.alloc(length); if ((await h.read(central, 0, length, offset)).bytesRead !== length) throw new Error('Truncated ZIP');
    let p = 0; const names = new Set<string>();
    for (let i = 0; i < count; i++) {
      if (p + 46 > length || central.readUInt32LE(p) !== 0x02014b50 || (central.readUInt16LE(p + 8) & 1)) throw new Error('Invalid ZIP entry');
      const n = central.readUInt16LE(p + 28), extra = central.readUInt16LE(p + 30), comment = central.readUInt16LE(p + 32);
      if (p + 46 + n + extra + comment > length) throw new Error('Truncated ZIP entry');
      const name = central.subarray(p + 46, p + 46 + n).toString('utf8');
      if (!name.startsWith('Botling 2.app/') || /[\\\r\n\0]/.test(name) || name.split('/').some((v, i, all) => v === '..' || v === '.' || (!v && i < all.length - 1))) throw new Error('Unsafe ZIP paths');
      const canonical = name.normalize('NFD').toLowerCase();
      if (names.has(canonical)) throw new Error('Aliased ZIP paths');
      names.add(canonical); const mode = central.readUInt32LE(p + 38) >>> 16;
      entries.push({ name, link: (mode & 0o170000) === 0o120000 });
      p += 46 + n + extra + comment;
    }
    if (p !== length) throw new Error('ZIP directory length mismatch');
  } finally { await h.close(); }
  for (const entry of entries.filter(e => e.link)) {
    if (entries.some(e => e.name !== entry.name && e.name.normalize('NFD').toLowerCase().startsWith(entry.name.normalize('NFD').toLowerCase() + '/'))) throw new Error('ZIP writes through symlink');
    const result = await run('/usr/bin/unzip', ['-p', zip, entry.name]) as { stdout: string };
    const target = result.stdout;
    const resolved = posix.normalize(posix.join(posix.dirname(entry.name), target));
    if (!target || target.startsWith('/') || target.includes('\\') || target.includes('\0') || !resolved.startsWith('Botling 2.app/')) throw new Error('ZIP symlink escapes bundle');
  }
}
