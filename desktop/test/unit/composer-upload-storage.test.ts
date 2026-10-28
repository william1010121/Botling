import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PendingFiles } from '../../src/core/attachments';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('writes original bytes asynchronously before acknowledging an attachment, with private permissions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'composer-upload-')); roots.push(root);
  const pending = new PendingFiles(root, () => {});
  const bytes = Buffer.alloc(1024 * 1024, 123);
  const start = performance.now(); const result = pending.addData('A', 'a/b.png', bytes.toString('base64'));
  expect(pending.views('A')).toHaveLength(0);
  await result;
  const file = pending.list('A')[0]; expect(file.name).toBe('a-b.png');
  expect(readFileSync(file.path).equals(bytes)).toBe(true); expect(statSync(file.path).mode & 0o777).toBe(0o600);
  console.log(`1 MiB decode + async write + acceptance: ${(performance.now() - start).toFixed(1)} ms`);
});
it('failed storage leaves no accepted attachment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'composer-upload-')); roots.push(root);
  const pending = new PendingFiles(join(root, 'bad\0path'), () => {});
  await expect(pending.addData('A', 'photo.png', 'YWJj')).rejects.toThrow(); expect(pending.views('A')).toEqual([]);
});
