// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Composer } from '../../../Web/src/composer';
import { setComposerHost } from '../../../Web/src/composer-host';
import type { ChatState } from '../../../Web/src/types';
const state = (botID = 'A') => ({ botID, placeholder: 'Message', pendingFiles: [], replyingTo: null } as unknown as ChatState);
let composer: Composer;
afterEach(() => { composer?.view.destroy(); document.body.innerHTML = ''; setComposerHost(null); });
function setup() {
  let resolve!: () => void, reject!: (e: Error) => void;
  const send = vi.fn(() => new Promise<void>((yes, no) => { resolve = yes; reject = no; }));
  setComposerHost({ send });
  composer = new Composer(document.body); composer.update(state()); composer.setText('original');
  return { send, accept: () => resolve(), fail: () => reject(new Error('offline')) };
}
it('acknowledges immediately, keeps the draft until acceptance and suppresses duplicate clicks', async () => {
  const request = setup(); const start = performance.now(); composer.submit(); composer.submit();
  expect(document.querySelector('[role=status]')?.textContent).toContain('Sending');
  expect(performance.now() - start).toBeLessThan(100);
  expect(composer.text).toBe('original'); expect(request.send).toHaveBeenCalledTimes(1);
  request.accept(); await vi.waitFor(() => expect(composer.text).toBe(''));
});
it('keeps failed text for retry and lets typing continue while pending', async () => {
  const request = setup(); composer.submit(); composer.setText('original plus next'); request.fail();
  await vi.waitFor(() => expect(document.querySelector('[role=status]')?.textContent).toContain('offline'));
  expect(composer.text).toBe('original plus next'); composer.submit(); expect(request.send).toHaveBeenCalledTimes(2);
  request.accept(); await vi.waitFor(() => expect(composer.text).toBe(''));
});
it('does not erase new typing or another chat on acceptance', async () => {
  const request = setup(); composer.submit(); composer.setText('new draft'); composer.update(state('B')); composer.setText('B text');
  request.accept(); await Promise.resolve(); await Promise.resolve(); expect(composer.text).toBe('B text');
  composer.update(state()); expect(composer.text).toBe('new draft');
});

it('clears only the accepted draft when switching away and back', async () => {
  const request = setup(); composer.submit(); composer.update(state('B')); composer.setText('B draft');
  request.accept(); await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.send')!.disabled).toBe(false));
  await Promise.resolve(); composer.update(state()); expect(composer.text).toBe('');
  composer.update(state('B')); expect(composer.text).toBe('B draft');
});
it('does not clear an attachment-only composer until acceptance and blocks repeat Enter', async () => {
  const request = setup(); composer.setText('');
  composer.update({ ...state(), pendingFiles: [{ id: 'file', kind: 'image', url: 'data:image/png;base64,AA==', name: 'photo' }] } as ChatState);
  composer.submit(); composer.submit(); expect(request.send).toHaveBeenCalledTimes(1);
  request.fail(); await vi.waitFor(() => expect(document.querySelector('[role=status]')?.textContent).toContain('offline'));
  expect(document.querySelectorAll('.pending')).toHaveLength(1);
});
