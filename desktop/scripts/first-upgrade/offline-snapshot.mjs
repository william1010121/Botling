// Verify the existing transaction's copy; never create a backup or restore here.
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const caches = new Set(['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']);
export async function persistentDigest(root, updateRecords) {
  const hash = createHash('sha256');
  async function visit(path, rel) {
    const st = await fsp.lstat(path, { bigint: true });
    const kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'link' : null;
    if (!kind) throw new Error('Unsupported persistent profile entry');
    hash.update(JSON.stringify([rel, kind, Number(st.mode & 0o777n)]));
    if (kind === 'dir') {
      for (const name of (await fsp.readdir(path)).sort()) {
        if (!rel && updateRecords.includes(name)) continue;
        if ((rel === 'electron' || /^electron\/Partitions\/[^/]+$/.test(rel)) && caches.has(name)) continue;
        await visit(join(path, name), rel ? `${rel}/${name}` : name);
      }
    } else if (kind === 'link') hash.update(await fsp.readlink(path));
    else {
      for await (const chunk of fs.createReadStream(path)) hash.update(chunk);
      const after = await fsp.lstat(path, { bigint: true });
      if (after.ino !== st.ino || after.size !== st.size || after.mtimeNs !== st.mtimeNs || after.ctimeNs !== st.ctimeNs) throw new Error('Profile changed while hashing');
    }
  }
  // Root directory mode may be chosen by ditto/mkdir; persisted descendants must match.
  for (const name of (await fsp.readdir(root)).sort()) if (!updateRecords.includes(name)) await visit(join(root, name), name);
  return hash.digest('hex');
}
export async function verifySnapshot(record, before, updateRecords) {
  if (await fsp.readFile(join(record.root, 'snapshot.complete'), 'utf8') !== 'complete') throw new Error('Incomplete snapshot');
  const copied = await persistentDigest(join(record.root, 'data-before'), updateRecords);
  const live = await persistentDigest(record.dataDir, updateRecords);
  if (copied !== before || live !== before) throw new Error('Snapshot/profile changed during copy; activation refused');
  return before;
}
