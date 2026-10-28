// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Composer } from '../../../Web/src/composer';
import type { ShellMessage } from '../../src/renderer/chat-frame/protocol';
const port = vi.hoisted(() => ({ receive: (_message: ShellMessage) => {}, disconnect: () => {}, sent: [] as any[] }));
vi.mock('../../src/renderer/chat-frame/transport', () => ({
  fromShell: (receive: typeof port.receive) => { port.receive = receive; return () => {}; },
  onTransportDisconnect: (disconnect: () => void) => { port.disconnect = disconnect; return () => {}; },
  toShell: (message: unknown) => { port.sent.push(message); return true; },
}));
let composer: Composer;
const state = (botID = 'A') => ({ botID, placeholder: 'Message', pendingFiles: [], replyingTo: null } as any);
const status = () => document.querySelector('.composer-submission-status')!.textContent!;
const button = () => document.querySelector<HTMLButtonElement>('.send')!;
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const reply = (index: number, ok: boolean) => port.receive({ botling: 'composerResult', requestID: port.sent[index].action.requestID, ok, ...(!ok ? { error: 'backend refused' } : {}) });
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); sessionStorage.clear(); port.sent.length = 0; document.body.innerHTML = '';
  await import('../../src/renderer/chat-frame/composer-transport');
  const { Composer } = await import('../../../Web/src/composer');
  composer = new Composer(document.body); composer.update(state()); composer.setText('recoverable draft'); document.documentElement.dataset.chat = 'A';
  port.receive({ botling: 'state', state: state() } as ShellMessage);
});
afterEach(() => { composer.view.destroy(); vi.clearAllTimers(); vi.useRealTimers(); document.body.innerHTML = ''; });
it('timeout releases busy state but retains draft, explains uncertainty and suppresses repeated send', async () => {
  button().click(); expect(status()).toContain('Sending'); await vi.advanceTimersByTimeAsync(30_000);
  expect(status()).toContain('Delivery unconfirmed'); expect(status()).not.toContain('Not sent'); expect(button().disabled).toBe(false);
  expect(composer.text).toBe('recoverable draft'); button().click(); composer.submit(); expect(port.sent).toHaveLength(1);
});
it('native disconnect retains status across bot switches and a late acceptance clears only its unchanged draft', async () => {
  composer.submit(); port.disconnect(); await flush(); composer.update(state('B')); composer.setText('B text');
  expect(status()).toBe(''); composer.update(state()); expect(status()).toContain('Delivery unconfirmed');
  composer.update(state('B')); reply(0, true); await vi.advanceTimersByTimeAsync(0);
  expect(composer.text).toBe('B text'); composer.update(state()); expect(composer.text).toBe(''); expect(status()).toBe('');
});
it('a late rejection changes uncertainty to a retryable error without retrying automatically', async () => {
  composer.submit(); port.disconnect(); await flush(); reply(0, false); await vi.advanceTimersByTimeAsync(0);
  expect(status()).toContain('Not sent: backend refused'); expect(composer.text).toBe('recoverable draft'); expect(port.sent).toHaveLength(1);
  composer.submit(); expect(port.sent).toHaveLength(2); reply(1, true); await flush();
});
it('explicit user acknowledgement only enables manual sending; old replies cannot erase new typing', async () => {
  composer.submit(); port.disconnect(); await flush();
  document.querySelector<HTMLButtonElement>('.composer-submission-status button')!.click(); expect(port.sent).toHaveLength(1);
  composer.setText('new deliberate message'); composer.submit(); expect(port.sent).toHaveLength(2);
  reply(0, true); await vi.advanceTimersByTimeAsync(0); expect(composer.text).toBe('new deliberate message'); expect(status()).toContain('Sending');
  reply(1, true); await flush(); expect(composer.text).toBe('');
});
it('a late acceptance preserves edits made while delivery was unconfirmed', async () => {
  composer.submit(); port.disconnect(); await flush(); composer.setText('edited retained draft'); reply(0, true); await vi.advanceTimersByTimeAsync(0);
  expect(composer.text).toBe('edited retained draft'); expect(status()).toBe('');
});
it('releases picker busy state after disconnect while keeping an explicit attachment uncertainty guard', async () => {
  const { pickAttachments } = await import('../../src/renderer/chat-frame/composer-transport');
  pickAttachments(); expect(port.sent).toHaveLength(1); port.disconnect(); await flush(); await vi.advanceTimersByTimeAsync(0);
  const uploadStatus = () => document.querySelector('.composer-upload-status')!.textContent!;
  expect(uploadStatus()).toContain('Attachment delivery unconfirmed'); expect(uploadStatus()).not.toContain('Choosing / adding');
  pickAttachments(); expect(port.sent).toHaveLength(1); reply(0, true); await vi.advanceTimersByTimeAsync(0);
  expect(uploadStatus()).toBe(''); pickAttachments(); expect(port.sent).toHaveLength(2); reply(1, true); await flush();
});
