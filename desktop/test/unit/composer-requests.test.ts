import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ComposerRequests, ACCEPTANCE_TIMEOUT_MS } from '../../src/renderer/chat-frame/composer-requests';
import { DeliveryUncertain } from '../../../Web/src/composer-host';
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('settles a lost acknowledgement as uncertain, clears the timeout, and resolves a late result once without retransmitting', async () => {
  const post = vi.fn((_action: Record<string, any>) => true), late = vi.fn(); const requests = new ComposerRequests(post, () => {});
  const result = requests.request({ type: 'send', botID: 'A', text: 'hello' }, late).catch(error => error);
  await vi.advanceTimersByTimeAsync(ACCEPTANCE_TIMEOUT_MS);
  expect(await result).toBeInstanceOf(DeliveryUncertain); expect(vi.getTimerCount()).toBe(0);
  const id = post.mock.calls[0][0].requestID;
  expect(requests.unknown('A')).toMatchObject([{ requestID: id }]);
  requests.response(id, { ok: true }); requests.response(id, { ok: true }); await vi.advanceTimersByTimeAsync(0);
  expect(late).toHaveBeenCalledExactlyOnceWith({ ok: true }); expect(requests.unknown()).toEqual([]); expect(post).toHaveBeenCalledTimes(1);
});
it('disconnect settles all in-flight chats but a proven pre-dispatch refusal is a normal failure', async () => {
  const post = vi.fn((_action: Record<string, any>) => true), requests = new ComposerRequests(post, () => {});
  const a = requests.request({ type: 'send', botID: 'A' }).catch(e => e);
  const b = requests.request({ type: 'pickFiles', botID: 'B' }).catch(e => e);
  requests.disconnect(); expect(await a).toBeInstanceOf(DeliveryUncertain); expect(await b).toBeInstanceOf(DeliveryUncertain);
  expect(requests.unknown('A')).toHaveLength(1); expect(requests.unknown('B')).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
  const refused = new ComposerRequests(() => false, () => {});
  const failure = await refused.request({ type: 'send', botID: 'C' }).catch(e => e);
  expect(failure).not.toBeInstanceOf(DeliveryUncertain); expect(refused.unknown()).toEqual([]);
});
it('does not infer non-delivery from a thrown transport error', async () => {
  const requests = new ComposerRequests(() => { throw Error('IPC interrupted'); }, () => {});
  await expect(requests.request({ type: 'send', botID: 'A' })).rejects.toBeInstanceOf(DeliveryUncertain);
  expect(requests.unknown('A')).toHaveLength(1);
});
it('keeps unresolved request identity across page reload without sending it again', async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const post = vi.fn((_action: Record<string, any>) => true), first = new ComposerRequests(post, () => {}, storage);
  const pending = first.request({ type: 'send', botID: 'A' }).catch(e => e);
  const reloaded = new ComposerRequests(post, () => {}, storage);
  expect(reloaded.unknown('A')).toMatchObject([{ requestID: post.mock.calls[0][0].requestID }]); expect(post).toHaveBeenCalledTimes(1);
  first.disconnect(); await pending;
});
it('explicit release never retries, and a subsequently arriving old acknowledgement is ignored', async () => {
  const post = vi.fn((_action: Record<string, any>) => true), late = vi.fn(), requests = new ComposerRequests(post, () => {});
  const pending = requests.request({ type: 'send', botID: 'A' }, late).catch(e => e);
  requests.disconnect(); await pending;
  const id = requests.unknown('A')[0].requestID; requests.forget(id); requests.response(id, { ok: true });
  await vi.advanceTimersByTimeAsync(0); expect(late).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledTimes(1);
});
it('a late rejection belongs only to the original request, including a reply immediately after disconnect', async () => {
  const post = vi.fn((_action: Record<string, any>) => true), late = vi.fn(), requests = new ComposerRequests(post, () => {});
  let uncertainRecorded = false;
  const pending = requests.request({ type: 'send', botID: 'A' }, result => { expect(uncertainRecorded).toBe(true); late(result); }).catch(() => { uncertainRecorded = true; });
  requests.disconnect(); requests.response(post.mock.calls[0][0].requestID, { ok: false, error: 'rejected' });
  await pending; await vi.advanceTimersByTimeAsync(0);
  expect(late).toHaveBeenCalledExactlyOnceWith({ ok: false, error: 'rejected' }); expect(post).toHaveBeenCalledTimes(1);
});
