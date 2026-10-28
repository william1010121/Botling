// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import type { ShellMessage } from '../../src/renderer/chat-frame/protocol';
const port = vi.hoisted(() => ({ receive: (_message: ShellMessage) => {}, sent: [] as any[] }));
vi.mock('../../src/renderer/chat-frame/transport', () => ({
  fromShell: (receive: typeof port.receive) => { port.receive = receive; return () => {}; },
  toShell: (message: unknown) => { port.sent.push(message); return true; },
}));
import { composerHost } from '../../../Web/src/composer-host';
import { readOriginal } from '../../src/renderer/chat-frame/composer-transport';
beforeEach(() => {
  port.sent.length = 0; document.body.innerHTML = '<div class="composer"></div>';
  document.documentElement.dataset.chat = 'A';
  port.receive({ botling: 'state', state: { botID: 'A' } } as ShellMessage);
});
const reply = (message: any, ok = true) => port.receive({ botling: 'composerResult', requestID: message.action.requestID, ok, ...(!ok ? { error: 'backend refused' } : {}) });
it('waits for backend acceptance, ignores unrelated acknowledgements and never waits for model output', async () => {
  let accepted = false;
  const start = performance.now();
  const pending = composerHost!.send({ type: 'send', botID: 'A', text: 'hello' }).then(() => { accepted = true; });
  const enqueued = performance.now(); expect(port.sent).toHaveLength(1);
  port.receive({ botling: 'composerResult', requestID: 'unrelated', ok: true }); await Promise.resolve(); expect(accepted).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 35)); expect(accepted).toBe(false);
  reply(port.sent[0]); await pending; expect(accepted).toBe(true);
  console.log(`Simulated transport: request enqueue ${(enqueued - start).toFixed(1)} ms; delayed acceptance ${(performance.now() - start).toFixed(1)} ms; no model response emitted`);
});
it('shows an attachment before reading, preserves its bytes, retains failures and retries explicitly', async () => {
  const bytes = new Uint8Array([0, 1, 2, 254, 255]);
  composerHost!.upload!(new File([bytes], 'original.png', { type: 'image/png' }));
  expect(document.querySelector('.composer-upload-status')!.textContent).toContain('Queued');
  expect(port.sent).toHaveLength(0);
  await vi.waitFor(() => expect(port.sent).toHaveLength(1));
  expect(port.sent[0].action.base64).toBe('AAEC/v8='); expect(port.sent[0].action.botID).toBe('A');
  await expect(composerHost!.send({ type: 'send', botID: 'A', text: 'with image' })).rejects.toThrow('pending attachments');
  reply(port.sent[0], false);
  await vi.waitFor(() => expect(document.querySelector('.composer-upload-status')!.textContent).toContain('backend refused'));
  document.documentElement.dataset.chat = 'B';
  document.querySelector<HTMLButtonElement>('.composer-upload-status button')!.click();
  await vi.waitFor(() => expect(port.sent).toHaveLength(2)); expect(port.sent[1].action.botID).toBe('A');
  reply(port.sent[1]); await vi.waitFor(() => expect(document.querySelector('.composer-upload-status')!.textContent).toBe(''));
});
it('measures a bounded image read/encode without altering the original', async () => {
  const bytes = new Uint8Array(1024 * 1024).fill(91); const start = performance.now();
  const encoded = await readOriginal(new File([bytes], 'large.png', { type: 'image/png' }));
  expect(atob(encoded).length).toBe(bytes.length); expect(atob(encoded).charCodeAt(0)).toBe(91);
  console.log(`1 MiB asynchronous FileReader/base64: ${(performance.now() - start).toFixed(1)} ms`);
});
