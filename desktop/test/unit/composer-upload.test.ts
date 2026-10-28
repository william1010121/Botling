import { expect, it, vi } from 'vitest';
import { UploadQueue, MAX_UPLOAD_BYTES } from '../../src/renderer/chat-frame/upload-queue';
const file = (name: string, size = 10) => ({ name, size }) as File;
it('announces queued files synchronously and reads only one until backend acceptance', async () => {
  let release!: () => void;
  const upload = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const queue = new UploadQueue(upload, () => {});
  queue.add('A', file('one')); queue.add('A', file('two'));
  expect(queue.items.map(x => x.state)).toEqual(['queued', 'queued']);
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
  expect(queue.blocked('A')).toBe(true); release();
  await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2)); release();
  await vi.waitFor(() => expect(queue.blocked('A')).toBe(false));
});
it('retains the original file on failure for explicit retry, bound to its original chat', async () => {
  const original = file('picture'); const upload = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined);
  const queue = new UploadQueue(upload, () => {}); queue.add('A', original);
  await vi.waitFor(() => expect(queue.items[0].state).toBe('failed'));
  expect(queue.blocked('A')).toBe(true); expect(queue.blocked('B')).toBe(false);
  queue.retry(queue.items[0]); await vi.waitFor(() => expect(queue.items).toHaveLength(0));
  expect(upload).toHaveBeenLastCalledWith('A', original);
});
it('rejects oversize files before reading and bounds total queued memory', () => {
  const upload = vi.fn(); const queue = new UploadQueue(upload, () => {});
  expect(() => queue.add('A', file('huge', MAX_UPLOAD_BYTES + 1))).toThrow();
  queue.add('A', file('one', MAX_UPLOAD_BYTES)); queue.add('A', file('two', MAX_UPLOAD_BYTES));
  expect(() => queue.add('A', file('three', 1))).toThrow(); expect(upload).not.toHaveBeenCalled();
});
it('does not retry an upload with an unknown outcome and releases it on a late acceptance', async () => {
  const { DeliveryUncertain } = await import('../../../Web/src/composer-host');
  const upload = vi.fn().mockRejectedValue(new DeliveryUncertain('upload-request'));
  const queue = new UploadQueue(upload, () => {}); queue.add('A', file('picture'));
  await vi.waitFor(() => expect(queue.items[0].state).toBe('uncertain'));
  queue.retry(queue.items[0]); expect(upload).toHaveBeenCalledTimes(1);
  expect(queue.blocked('A')).toBe(true); queue.settle('unrelated', { ok: true }); expect(queue.items).toHaveLength(1);
  queue.settle('upload-request', { ok: true }); expect(queue.blocked('A')).toBe(false); expect(queue.items).toHaveLength(0);
});
it('keeps the original upload recoverable after a late rejection, retrying only on explicit action', async () => {
  const { DeliveryUncertain } = await import('../../../Web/src/composer-host');
  const original = file('picture'), upload = vi.fn().mockRejectedValueOnce(new DeliveryUncertain('upload-request')).mockResolvedValue(undefined);
  const queue = new UploadQueue(upload, () => {}); queue.add('A', original);
  await vi.waitFor(() => expect(queue.items[0].state).toBe('uncertain'));
  queue.settle('upload-request', { ok: false, error: 'disk full' });
  expect(queue.items[0]).toMatchObject({ file: original, state: 'failed', error: 'disk full' }); expect(upload).toHaveBeenCalledTimes(1);
  queue.retry(queue.items[0]); await vi.waitFor(() => expect(queue.items).toHaveLength(0)); expect(upload).toHaveBeenCalledTimes(2);
});
