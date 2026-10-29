// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AntigravityQuota } from '../../src/renderer/AntigravityQuota';
import { QuickSettingsUsage } from '../../src/renderer/QuickSettingsUsage';
import type { Client } from '../../src/renderer/client';
import type { AntigravityQuotaView } from '../../src/contract';
const busy: AntigravityQuotaView = { status:'unavailable', reason:'busy', source:'antigravity_acp' };
const available: AntigravityQuotaView = { status:'available', source:'antigravity_acp', seen:123000, buckets:[{group:'Models', label:'Week', remainingFraction:.91}] };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.useRealTimers());
it('labels retained quota with its original read time while busy, without inventing a value on first open', async () => {
 const host = document.createElement('div'), root = createRoot(host);
 try {
  await act(async () => root.render(createElement(AntigravityQuota, {quota:busy})));
  expect(host.textContent).toContain('Waiting to read quota');
  expect(host.textContent).not.toContain('%');
  await act(async () => root.render(createElement(AntigravityQuota, {quota:available})));
  expect(host.textContent).toContain('91% remaining');
  await act(async () => root.render(createElement(AntigravityQuota, {quota:busy})));
  expect(host.textContent).toContain('91% remaining');
  expect(host.textContent).toContain('Last known quota');
  expect(host.textContent).toContain(new Date(123000).toLocaleString());
  expect(host.textContent).toContain('Waiting to refresh quota');
 } finally { await act(async () => root.unmount()); }
});
it('retries busy at a bounded interval, coalesces turn events, stops on success and cleans up on close', async () => {
 vi.useFakeTimers();
 let event: (value:any) => void = () => {};
 let resolve: ((value:any) => void) | undefined;
 let pending = false;
 let quota: AntigravityQuotaView = busy;
 const request = vi.fn(() => pending ? new Promise(r => { resolve = r; }) : Promise.resolve({antigravity:quota}));
 const off = vi.fn();
 const client = {request, onEvent:(listener:any) => {event = listener; return off;}} as unknown as Client;
 const host = document.createElement('div'), root = createRoot(host);
 try {
  await act(async () => root.render(createElement(QuickSettingsUsage, {client})));
  expect(request).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('Retry quota');
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(request).toHaveBeenCalledTimes(1);
  pending = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => { event({event:{type:'turn.finished'}}); event({event:{type:'turn.finished'}}); });
  expect(request).toHaveBeenCalledTimes(2);
  quota = available; pending = false;
  await act(async () => { resolve!({antigravity:busy}); });
  expect(request).toHaveBeenCalledTimes(3);
  expect(host.textContent).toContain('91% remaining');
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(request).toHaveBeenCalledTimes(3);
 } finally { await act(async () => root.unmount()); }
 await vi.advanceTimersByTimeAsync(120000);
 expect(request).toHaveBeenCalledTimes(3); expect(off).toHaveBeenCalledOnce();
});
it('allows a manual retry when no reading exists', async () => {
 const retry = vi.fn(), host = document.createElement('div'), root = createRoot(host);
 try {
  await act(async () => root.render(createElement(AntigravityQuota, {quota:busy,onRetry:retry})));
  await act(async () => host.querySelector('button')!.click());
  expect(retry).toHaveBeenCalledOnce();
 } finally {await act(async () => root.unmount());}
});
