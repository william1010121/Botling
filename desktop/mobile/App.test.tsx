// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { PROTOCOL_VERSION } from '../src/contract';
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('continues refreshing after opening the already-selected chat', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string); reads++;
    return new Response(JSON.stringify({ v: PROTOCOL_VERSION, id: request.id, ok: true, result: {
      epoch: 'epoch', seq: reads,
      bots: [{ id: 'main', name: 'Main', role: 'main', working: false, approvals: 0, unread: 0, problem: null, heads: ['claude'] }],
      chat: { botId: 'main', messages: [{ id: 'message', role: 'bot', text: `revision-${reads}`, time: '2026-10-28T00:00:00Z' }], tasks: [], pendingFiles: [] },
    } }));
  }));
  await act(async () => root.render(<App />));
  (container.querySelector('input[name="token"]') as HTMLInputElement).value = 'fixture-token';
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  const before = reads;
  await act(async () => { (container.querySelector('nav button') as HTMLButtonElement).click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(reads).toBeGreaterThan(before);
  expect(container.querySelector('.messages')!.textContent).toContain(`revision-${reads}`);
});
