// Candidate-side fence also protects the FIRST install from older developer helpers that do not
// snapshot data. No core (and hence no storage migration) may start until this check succeeds.
import { join, dirname, basename } from 'node:path';
import { parseStorageContract, storageCompatible } from '../storage-contract';
import { durableJSON } from './hot-transaction';
import type { Fs } from './hot-install';
const RECEIPT = 'installed-storage-contract.json';
async function smallJSON(file: string, fs: Fs): Promise<any> {
  const st = await fs.promises.lstat(file);
  if (!st.isFile() || st.size > 16384) throw new Error('Invalid storage/update receipt');
  return JSON.parse(await fs.promises.readFile(file, 'utf8'));
}
export async function authorizeStorageStartup(options: {
  dataDir: string; target: string; version: string; packageContract: unknown; coreContract: unknown; argv: string[]; fs: Fs;
}): Promise<void> {
  const { dataDir, target, version, fs } = options;
  const candidate = parseStorageContract(options.packageContract);
  if (!candidate || !storageCompatible(candidate, options.coreContract)) throw new Error('Packaged storage compatibility metadata is missing or inconsistent');
  const receipt = join(dataDir, RECEIPT);
  let previous: unknown = null;
  if (fs.existsSync(receipt)) previous = await smallJSON(receipt, fs);
  const core = join(dataDir, 'core');
  const hasProfile = fs.existsSync(core) && (await fs.promises.readdir(core)).length > 0;
  if ((hasProfile || previous !== null) && !storageCompatible(previous, candidate)) {
    const token = options.argv.find(arg => arg.startsWith('--botling-update-token='))?.slice('--botling-update-token='.length);
    let protectedBoot = false;
    try {
      const pending = await smallJSON(join(dataDir, 'update-pending.json'), fs);
      const root = pending.root;
      if (token && /^[a-f0-9-]{36}$/.test(token) && pending.token === token && pending.target === target && pending.version === version
        && typeof root === 'string' && dirname(root) === dirname(target) && basename(root).startsWith('.botling-update-')
        && await fs.promises.realpath(root) === root) {
        const owner = await smallJSON(join(root, 'owner.json'), fs);
        const snapshot = join(root, 'data-before');
        protectedBoot = owner.token === token && owner.target === target && owner.dataDir === dataDir
          && (await fs.promises.lstat(snapshot)).isDirectory() && await fs.promises.realpath(snapshot) === snapshot
          && (await fs.promises.readFile(join(root, 'snapshot.complete'), 'utf8')) === 'complete';
      }
    } catch { /* An absent/invalid transaction is not permission to migrate. */ }
    if (!protectedBoot) throw new Error('Existing data requires a signed, snapshot-protected restart update before this storage generation can start. The legacy developer installer is not safe for this migration. No core was started.');
  }
  // This file is part of the protected updater's data snapshot and is restored with the profile.
  await durableJSON(receipt, candidate, fs);
}
