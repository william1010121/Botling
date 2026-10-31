// Atomic whole-bundle exchange. macOS renamex_np(RENAME_SWAP) has no missing-target interval.
// The journal is durable before exchange; recovery identifies either side by exact bytes, so a
// crash between the syscall and its acknowledgement is recoverable without guessing.
import { randomUUID } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { exactTree } from './hot-auth';
import type { Fs, Run } from './hot-install';
export const HOT_PENDING = 'hot-install-pending.json';
const exchangeScript = 'ObjC.import("stdlib"); ObjC.bindFunction("renamex_np", ["int", ["char *", "char *", "unsigned int"]]); function run(argv) { if ($.renamex_np(argv[0], argv[1], 2) !== 0) throw Error("atomic bundle exchange failed"); }';
export async function syncDirectory(path: string, fs: Fs) {
  // Windows cannot open a directory for fsync (EPERM/EISDIR); its rename is journalled by NTFS already.
  let handle; try { handle = await fs.promises.open(path, 'r'); } catch (error) { if (process.platform === 'win32') return; throw error; }
  try { await handle.sync(); } catch (error) { if (process.platform !== 'win32') throw error; } finally { await handle.close(); }
}
export async function durableJSON(file: string, value: unknown, fs: Fs) {
  await fs.promises.mkdir(dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  const handle = await fs.promises.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await fs.promises.rename(tmp, file); await syncDirectory(dirname(file), fs);
}
async function syncTree(path: string, fs: Fs): Promise<void> {
  const st = await fs.promises.lstat(path);
  if (st.isDirectory()) {
    for (const name of await fs.promises.readdir(path)) await syncTree(join(path, name), fs);
    await syncDirectory(path, fs);
  } else if (st.isFile()) { const h = await fs.promises.open(path, 'r'); try { await h.sync(); } finally { await h.close(); } }
}
export async function exchangeBundles(target: string, candidate: string, fs: Fs, run: Run) {
  await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', exchangeScript, target, candidate]);
  await syncDirectory(dirname(target), fs); await syncDirectory(dirname(candidate), fs);
}
interface Journal { v: 1; target: string; candidate: string; before: string; after: string; committed: boolean }
export class HotTransaction {
  readonly file: string;
  constructor(private dataDir: string, private fs: Fs, private run: Run) { this.file = join(dataDir, HOT_PENDING); }
  async prepare(target: string, candidate: string, after: string) {
    if (this.fs.existsSync(this.file)) throw new Error('Previous hot install needs recovery');
    if (await exactTree(candidate, this.fs) !== after) throw new Error('Authenticated candidate changed');
    await syncTree(candidate, this.fs);
    await syncDirectory(dirname(candidate), this.fs); await syncDirectory(dirname(dirname(candidate)), this.fs);
    const record: Journal = { v: 1, target, candidate, before: await exactTree(target, this.fs), after, committed: false };
    await durableJSON(this.file, record, this.fs);
  }
  async activate() {
    const record = await this.read();
    if (await exactTree(record.target, this.fs) !== record.before || await exactTree(record.candidate, this.fs) !== record.after) throw new Error('Bundle changed before activation');
    await exchangeBundles(record.target, record.candidate, this.fs, this.run);
  }
  private async read(): Promise<Journal> {
    const st = await this.fs.promises.lstat(this.file);
    if (!st.isFile() || st.size > 16384 || (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw new Error('Unsafe hot-install journal');
    const r = JSON.parse(await this.fs.promises.readFile(this.file, 'utf8')) as Journal;
    const root = typeof r.candidate === 'string' ? dirname(r.candidate) : '';
    if (r.v !== 1 || typeof r.target !== 'string' || !r.target.endsWith('.app') || dirname(root) !== dirname(r.target)
      || !basename(root).startsWith('.botling-hot-') || basename(r.candidate) !== 'Botling 2.app'
      || !/^[a-f0-9]{64}$/.test(r.before) || !/^[a-f0-9]{64}$/.test(r.after) || typeof r.committed !== 'boolean'
      || await this.fs.promises.realpath(root) !== root || await this.fs.promises.realpath(r.target) !== r.target) throw new Error('Unsafe hot-install recovery paths');
    return r;
  }
  async commit() {
    const r = await this.read();
    if (await exactTree(r.target, this.fs) !== r.after) throw new Error('Installed candidate changed before commit');
    await durableJSON(this.file, { ...r, committed: true }, this.fs);
    await this.clear();
  }
  async rollback() { return this.recover(undefined, true); }
  /** Returns true if disk was rolled back: main must relaunch before starting any core/window. */
  async recover(expectedTarget?: string, retainBarrier = false): Promise<boolean> {
    if (!this.fs.existsSync(this.file)) return false;
    const r = await this.read();
    if (expectedTarget && r.target !== expectedTarget) throw new Error('Hot-install journal names another application');
    const current = await exactTree(r.target, this.fs);
    if (r.committed) {
      if (current !== r.after) throw new Error('Committed hot-install generation changed');
      await this.clear(); return false;
    }
    if (current === r.before) { if (!retainBarrier) await this.clear(); return false; }
    if (current !== r.after || await exactTree(r.candidate, this.fs) !== r.before) throw new Error('Hot-install recovery bytes do not match either generation');
    await exchangeBundles(r.target, r.candidate, this.fs, this.run);
    if (!retainBarrier) await this.clear(); return true;
  }
  private async clear() { await this.fs.promises.unlink(this.file); await syncDirectory(this.dataDir, this.fs); }
}
