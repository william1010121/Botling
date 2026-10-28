// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); delete (window as any).botlingEditor; vi.resetModules(); });
it('uses existing native unbind and changed-document bind notices without treating initial binding as disconnect', async () => {
  const first = { surfaceId: 'surface', documentGeneration: 'first' };
  let receive!: (packet: any) => void; const unsubscribe = vi.fn();
  (window as any).botlingEditor = { current: () => first, subscribe: (callback: typeof receive) => { receive = callback; callback({ stamp: first, bound: true }); return unsubscribe; } };
  const { onTransportDisconnect } = await import('../../src/renderer/chat-frame/transport');
  const lost = vi.fn(); cleanup = onTransportDisconnect(lost); expect(lost).not.toHaveBeenCalled();
  receive({ stamp: first, unbound: true }); expect(lost).toHaveBeenCalledTimes(1);
  const next = { ...first, documentGeneration: 'next' }; receive({ stamp: next, bound: true }); expect(lost).toHaveBeenCalledTimes(1);
  receive({ stamp: { ...next, documentGeneration: 'third' }, bound: true }); expect(lost).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event('pagehide')); expect(lost).toHaveBeenCalledTimes(3);
  cleanup(); cleanup = undefined; expect(unsubscribe).toHaveBeenCalledOnce();
});
