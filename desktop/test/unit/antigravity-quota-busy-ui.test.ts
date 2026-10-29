// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AntigravityQuota } from '../../src/renderer/AntigravityQuota';
import { SettingsSheet } from '../../src/renderer/Settings';
import { settingsView } from '../../src/core/settings';
import { QuickSettingsUsage } from '../../src/renderer/QuickSettingsUsage';
import type { Client } from '../../src/renderer/client';
import type { AntigravityQuotaView } from '../../src/contract';
const busy: AntigravityQuotaView = { status:'unavailable', reason:'busy', source:'antigravity_acp' };
const available: Extract<AntigravityQuotaView, {status:'available'}> = { status:'available', source:'antigravity_acp', seen:123000, buckets:[{group:'Gemini Models', label:'Weekly Limit Remaining', remainingFraction:.91}] };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.useRealTimers());
it('labels retained quota with its original read time while busy, without inventing a value on first open', async () => {
 const host = document.createElement('div'), root = createRoot(host);
 try {
  await act(async () => root.render(createElement(AntigravityQuota, {quota:busy})));
  expect(host.textContent).toContain('Waiting to read quota');
  expect(host.textContent).not.toContain('%');
  await act(async () => root.render(createElement(AntigravityQuota, {quota:available})));
  expect(host.textContent).toContain('9%');
  await act(async () => root.render(createElement(AntigravityQuota, {quota:{...busy, lastKnown:available}})));
  expect(host.textContent).toContain('9%');
  expect(host.textContent).toContain('Last known quota');
  expect(host.textContent).toMatch(/as of \d+ (min|h|days)/);
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
  expect(host.textContent).toContain('9%');
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


it('retains core last-known quota across close/reopen in both surfaces and shares one polling loop', async () => {
 vi.useFakeTimers();
 const listeners = new Set<(event:any) => void>();
 let quota: AntigravityQuotaView = {...busy, lastKnown:{seen:available.seen,buckets:available.buckets}};
 const emptyLimits = {fiveHour:null,week:null};
 const usage = () => ({antigravity:quota, claude:emptyLimits,codex:emptyLimits,spendingStatus:'missing',byBot:[],history:[]});
 const usageRequest = vi.fn(async () => usage());
 const client = {request:async(cmd:any) => cmd.type === 'usage.view' ? usageRequest() : {status:'ready',models:[]},
  onEvent:(listener:any) => {listeners.add(listener);return () => listeners.delete(listener);}} as unknown as Client;
 const quick = document.createElement('div'), full = document.createElement('div');
 const quickRoot = createRoot(quick), fullRoot = createRoot(full);
 const fullElement = () => createElement(SettingsSheet,{client,settings:settingsView({}),bot:null,plugins:null,initialSection:'usage',onClose:()=>{}});
 try {
  await act(async () => {quickRoot.render(createElement(QuickSettingsUsage,{client}));fullRoot.render(fullElement());});
  expect(usageRequest).toHaveBeenCalledTimes(1);
  for (const host of [quick,full]) {
   expect(host.textContent).toContain('9%');
   expect(host.textContent).toContain('Last known quota');
   expect(host.textContent).toMatch(/as of \d+ (min|h|days)/);
  }
  await act(async () => {await vi.advanceTimersByTimeAsync(2000);});
  expect(usageRequest).toHaveBeenCalledTimes(2);
  // Destroy both quota surfaces, not just hide their DOM.
  await act(async () => {quickRoot.render(null);fullRoot.render(null);});
  await vi.advanceTimersByTimeAsync(10000);
  expect(usageRequest).toHaveBeenCalledTimes(2);
  await act(async () => fullRoot.render(fullElement()));
  expect(usageRequest).toHaveBeenCalledTimes(3);
  expect(full.textContent).toContain('Last known quota');
  expect(full.textContent).toContain('9%');
  quota = {...available,seen:Date.now(),buckets:[{group:'Gemini Models',label:'Weekly Limit Remaining',remainingFraction:.85}]};
  await act(async () => {for(const listener of listeners) listener({event:{type:'turn.finished'}});});
  expect(usageRequest).toHaveBeenCalledTimes(4);
  expect(full.textContent).toContain('15%');
  expect(full.textContent).not.toContain('Last known quota');
  await act(async () => {await vi.advanceTimersByTimeAsync(10000);});
  expect(usageRequest).toHaveBeenCalledTimes(4);
  await act(async () => {fullRoot.render(null);quickRoot.render(createElement(QuickSettingsUsage,{client}));});
  expect(quick.textContent).toContain('15%');
 } finally {await act(async () => {quickRoot.unmount();fullRoot.unmount();});}
});

it('bounds repeated manual retries while busy', async () => {
 vi.useFakeTimers();
 const request = vi.fn(async () => ({antigravity:busy}));
 const client = {request,onEvent:() => () => {}} as unknown as Client;
 const host=document.createElement('div'), root=createRoot(host);
 try {
  await act(async () => root.render(createElement(QuickSettingsUsage,{client})));
  await act(async () => {for(let i=0;i<10;i++)host.querySelector('button')!.click();});
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => {await vi.advanceTimersByTimeAsync(2000);});
  expect(request).toHaveBeenCalledTimes(2);
 } finally {await act(async () => root.unmount());}
});

it('shows only Gemini quotas as used-percent ring cards in the Claude/Codex layout', async () => {
 const now = Date.parse('2026-10-29T16:00:00Z');
 const quota: AntigravityQuotaView = { status:'available', source:'antigravity_acp', seen:now, buckets:[
  {group:'Gemini Models', label:'Weekly Limit Remaining', remainingFraction:.88, resetsAt:Date.parse('2026-11-04T12:42:00Z')},
  {group:'Gemini Models', label:'Five Hour Limit Remaining', remainingFraction:.91, resetsAt:now + 103*60_000},
  {group:'Claude and GPT models', label:'Weekly Limit Remaining', remainingFraction:.5},
  {group:'Claude and GPT models', label:'Five Hour Limit Remaining', remainingFraction:.4}]};
 const host = document.createElement('div'), root = createRoot(host);
 try {
  await act(async () => root.render(createElement(AntigravityQuota, {quota, now})));
  const cards = [...host.querySelectorAll('.quick-usage-card')];
  expect(cards).toHaveLength(2);
  expect(cards[0].textContent).toBe('9%5 hoursin 1h 43m');
  expect(cards[1].textContent).toMatch(/^12%Week/);
  expect(host.textContent).not.toContain('remaining');
  expect(host.textContent).not.toContain('50%');
  expect(host.textContent).not.toContain('60%');
  expect(host.textContent).not.toContain('Read ');
 } finally { await act(async () => root.unmount()); }
});
it('degrades gracefully for missing, disabled and amount-only Gemini buckets', async () => {
 const now = Date.now();
 const quota: AntigravityQuotaView = { status:'available', source:'antigravity_acp', seen:now, buckets:[
  {group:'Gemini Models', label:'Five Hour Limit Remaining', disabled:true},
  {group:'Claude and GPT models', label:'Weekly Limit Remaining', remainingFraction:.5}]};
 const host = document.createElement('div'), root = createRoot(host);
 try {
  await act(async () => root.render(createElement(AntigravityQuota, {quota, now})));
  const cards = [...host.querySelectorAll('.quick-usage-card')];
  expect(cards[0].textContent).toBe('–5 hoursdisabled');
  expect(cards[1].textContent).toBe('–Weekunavailable');
 } finally { await act(async () => root.unmount()); }
});
