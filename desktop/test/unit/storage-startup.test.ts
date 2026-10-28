import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { tempDir } from '../helpers';
import { authorizeStorageStartup } from '../../src/main/storage-startup';
function put(path: string, value: unknown) { fs.mkdirSync(dirname(path), { recursive: true }); fs.writeFileSync(path, JSON.stringify(value)); }
function fixture() {
  const root = fs.realpathSync(tempDir('storage-startup')), dataDir = join(root, 'data'), target = join(root, 'Botling 2.app');
  const contract = { version: 1, epoch: 2 };
  const options = { dataDir, target, version: '2.0.1', packageContract: contract, coreContract: contract, argv: [] as string[], fs };
  put(join(dataDir, 'core/history.json'), [{ text: 'retained' }]);
  return { root, options, history: join(dataDir, 'core/history.json') };
}
describe('first-install storage startup fence', () => {
  it('legacy developer restart cannot migrate an existing unmarked profile', async () => {
    const f = fixture(), before = fs.readFileSync(f.history);
    await expect(authorizeStorageStartup(f.options)).rejects.toThrow('snapshot-protected');
    expect(fs.readFileSync(f.history)).toEqual(before);
    expect(fs.existsSync(join(f.options.dataDir, 'installed-storage-contract.json'))).toBe(false);
  });
  it('accepts matching snapshot provenance without acknowledging boot early; later startup uses the epoch receipt', async () => {
    const f = fixture(), token = randomUUID(), root = fs.mkdtempSync(join(f.root, '.botling-update-'));
    const pending = { root, target: f.options.target, version: f.options.version, token };
    put(join(f.options.dataDir, 'update-pending.json'), pending);
    put(join(root, 'owner.json'), { ...pending, dataDir: f.options.dataDir });
    fs.mkdirSync(join(root, 'data-before')); fs.writeFileSync(join(root, 'snapshot.complete'), 'complete');
    f.options.argv = ['--botling-update-token=' + randomUUID()];
    await expect(authorizeStorageStartup(f.options)).rejects.toThrow('snapshot-protected');
    f.options.argv = ['--botling-update-token=' + token];
    await authorizeStorageStartup(f.options);
    expect(fs.existsSync(join(root, 'boot.ok'))).toBe(false);
    f.options.argv = []; await authorizeStorageStartup(f.options);
    f.options.packageContract.epoch = 3;
    await expect(authorizeStorageStartup(f.options)).rejects.toThrow('snapshot-protected');
  });
  it('fresh profile may initialize known metadata; unknown or mismatched metadata cannot start', async () => {
    const f = fixture(); f.options.dataDir = join(f.root, 'fresh');
    await authorizeStorageStartup(f.options);
    expect(JSON.parse(fs.readFileSync(join(f.options.dataDir, 'installed-storage-contract.json'), 'utf8'))).toEqual({ version: 1, epoch: 2 });
    await expect(authorizeStorageStartup({ ...f.options, coreContract: null })).rejects.toThrow('missing or inconsistent');
    await expect(authorizeStorageStartup({ ...f.options, coreContract: { version: 1, epoch: 3 } })).rejects.toThrow('missing or inconsistent');
  });
});
