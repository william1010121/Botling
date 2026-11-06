// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { AntigravityQuota } from '../src/AntigravityQuota';
import { SettingsUsage } from '../src/SettingsUsage';
import { QuickUsage } from '../src/QuickUsage';
import type { UsageSource } from '../src/usage-session';
import type { AntigravityQuota as AntigravityQuotaView } from '../../../../Web/host/src/api';
const busy: AntigravityQuotaView = { status:'unavailable', reason:'busy', source:'antigravity_acp' };
const available: Extract<AntigravityQuotaView, {status:'available'}> = { status:'available', source:'antigravity_acp', seen:123000, buckets:[{group:'Gemini Models', label:'Weekly Limit Remaining', remainingFraction:.91}] };
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.useRealTimers());
it('labels retained quota with its original read time while busy, without inventing a value on first open', async () => {
 const host = document.createElement('div'), root = createRoot(host);
 try {
  await act(async () => root.render(createElement(AntigravityQuota, {quota:busy})));
  expect(host.querySelectorAll('.quick-usage-card')).toHaveLength(1);
  expect(host.textContent).toContain('Antigravity is busy');
  expect(host.textContent).not.toContain('%');
  await act(async () => root.render(createElement(AntigravityQuota, {quota:available})));
  expect(host.textContent).toContain('9%');
  await act(async () => root.render(createElement(AntigravityQuota, {quota:{...busy, lastKnown:available}})));
  expect(host.textContent).toContain('9%');
  expect(host.textContent).toMatch(/Updated \d+ (min|h|days) ago · Antigravity is busy/);
 } finally { await act(async () => root.unmount()); }
});
it('retries busy at a bounded interval, coalesces turn events, stops on success and cleans up on close', async () => {
 vi.useFakeTimers();
 let event: () => void = () => {};
 let resolve: ((value:any) => void) | undefined;
 let pending = false;
 let quota: AntigravityQuotaView = busy;
 const request = vi.fn(() => pending ? new Promise(r => { resolve = r; }) : Promise.resolve({antigravity:quota}));
 const off = vi.fn();
 const source = {view: request, onTurnFinished: (listener:any) => {event = listener; return off;}} as unknown as UsageSource;
 const host = document.createElement('div'), root = createRoot(host);
 try {
  await act(async () => root.render(createElement(QuickUsage, {source})));
  expect(request).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('Retry quota');
  await act(async () => { await vi.advanceTimersByTimeAsync(1999); });
  expect(request).toHaveBeenCalledTimes(1);
  pending = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => { event(); event(); });
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
 const listeners = new Set<() => void>();
 let quota: AntigravityQuotaView = {...busy, lastKnown:{seen:available.seen,buckets:available.buckets}};
 const emptyLimits = {fiveHour:null,week:null};
 const usage = () => ({antigravity:quota, claude:emptyLimits,codex:emptyLimits,spendingStatus:'missing',byBot:[],history:[]});
 const usageRequest = vi.fn(async () => usage());
 const source = {view: usageRequest,
  onTurnFinished:(listener:any) => {listeners.add(listener);return () => listeners.delete(listener);}} as unknown as UsageSource;
 const quick = document.createElement('div'), full = document.createElement('div');
 const quickRoot = createRoot(quick), fullRoot = createRoot(full);
 const fullElement = () => createElement(SettingsUsage,{source});
 try {
  await act(async () => {quickRoot.render(createElement(QuickUsage,{source}));fullRoot.render(fullElement());});
  expect(usageRequest).toHaveBeenCalledTimes(1);
  for (const host of [quick,full]) {
   expect(host.textContent).toContain('9%');
   expect(host.textContent).toMatch(/Updated \d+ (min|h|days) ago · Antigravity is busy/);
  }
  await act(async () => {await vi.advanceTimersByTimeAsync(2000);});
  expect(usageRequest).toHaveBeenCalledTimes(2);
  // Destroy both quota surfaces, not just hide their DOM.
  await act(async () => {quickRoot.render(null);fullRoot.render(null);});
  await vi.advanceTimersByTimeAsync(10000);
  expect(usageRequest).toHaveBeenCalledTimes(2);
  await act(async () => fullRoot.render(fullElement()));
  expect(usageRequest).toHaveBeenCalledTimes(3);
  expect(full.textContent).toContain('Antigravity is busy');
  expect(full.textContent).toContain('9%');
  quota = {...available,seen:Date.now(),buckets:[{group:'Gemini Models',label:'Weekly Limit Remaining',remainingFraction:.85}]};
  await act(async () => {for(const listener of listeners) listener();});
  expect(usageRequest).toHaveBeenCalledTimes(4);
  expect(full.textContent).toContain('15%');
  expect(full.textContent).not.toContain('Antigravity is busy');
  await act(async () => {await vi.advanceTimersByTimeAsync(10000);});
  expect(usageRequest).toHaveBeenCalledTimes(4);
  await act(async () => {fullRoot.render(null);quickRoot.render(createElement(QuickUsage,{source}));});
  expect(quick.textContent).toContain('15%');
 } finally {await act(async () => {quickRoot.unmount();fullRoot.unmount();});}
});

it('bounds repeated manual retries while busy', async () => {
 vi.useFakeTimers();
 const request = vi.fn(async () => ({antigravity:busy}));
 const source = {view: request,onTurnFinished:() => () => {}} as unknown as UsageSource;
 const host=document.createElement('div'), root=createRoot(host);
 try {
  await act(async () => root.render(createElement(QuickUsage,{source})));
  await act(async () => {for(let i=0;i<10;i++)host.querySelector('button')!.click();});
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => {await vi.advanceTimersByTimeAsync(2000);});
  expect(request).toHaveBeenCalledTimes(2);
 } finally {await act(async () => root.unmount());}
});

it('shows one used-percent ring per Gemini bucket, named by its group and window, with its reset time', async () => {
 const now = Date.parse('2026-10-29T16:00:00Z');
 const quota: AntigravityQuotaView = { status:'available', source:'antigravity_acp', seen:now, buckets:[
  {group:'Gemini', label:'Weekly', remainingFraction:.88, resetsAt:Date.parse('2026-11-04T12:42:00Z')},
  {group:'Gemini', label:'5-hour', remainingFraction:.91, resetsAt:now + 103*60_000},
  {group:'Gemini Argon', label:'Weekly', remainingFraction:.6},
  {group:'Claude & GPT (shared)', label:'Weekly', remainingFraction:.5},
  {group:'Claude & GPT (shared)', label:'5-hour', remainingFraction:.4}]};
 const host = document.createElement('div'), root = createRoot(host);
 try {
  await act(async () => root.render(createElement(AntigravityQuota, {quota, now})));
  const cards = [...host.querySelectorAll('.quick-usage-card')];
  expect(cards.map(c => c.querySelector('strong')!.textContent)).toEqual(['Gemini 5-hour', 'Gemini Weekly', 'Gemini Argon Weekly']);
  expect(cards[0].textContent).toBe('9%Gemini 5-hourin 1h 43m');
  expect(cards[1].textContent).toMatch(/^12%Gemini Weekly(Tue|Wed) /);
  expect(cards[2].textContent).toBe('40%Gemini Argon Weekly');
  expect(host.textContent).not.toMatch(/5 hours|Week(?!ly)|Claude|50%|60%/);
  expect(host.querySelector('.quick-usage-note')).toBeNull();
 } finally { await act(async () => root.unmount()); }
});
it('degrades gracefully for disabled and amount-only Gemini buckets, and says when Google reports none', async () => {
 const now = Date.now();
 const quota: AntigravityQuotaView = { status:'available', source:'antigravity_acp', seen:now, buckets:[
  {group:'Gemini', label:'5-hour', disabled:true}, {group:'Gemini', label:'Weekly', remainingAmount:'42'},
  {group:'Claude & GPT (shared)', label:'Weekly', remainingFraction:.5}]};
 let {host, done} = await renderOnce({quota, now});
 expect([...host.querySelectorAll('.quick-usage-card')].map(c => c.textContent)).toEqual(['–Gemini 5-hourdisabled', '–Gemini Weekly42 units left']);
 await done();
 ({host, done} = await renderOnce({quota:{...quota, buckets:[quota.buckets[2]]}, now}));
 expect([...host.querySelectorAll('.quick-usage-card')].map(c => c.textContent)).toEqual(['–Gemininot reported']);
 expect(host.querySelector('.quick-usage-note')!.textContent).toBe('Google reported no Gemini quota');
 await done();
});
it('gives a one-line reason for each unavailable quota', async () => {
 for (const [reason, text] of [['unsupported_connection', 'Sign in to Antigravity again in a Botling chat to read quota'], ['no_connection', 'Connect Antigravity to read quota'], ['missing_data', 'Google reported no Gemini quota']] as const) {
  const {host, done} = await renderOnce({quota:{status:'unavailable', reason, source:'antigravity_acp'}});
  expect(host.querySelector('.quick-usage-note')!.textContent).toBe(text);
  expect([...host.querySelectorAll('.quick-usage-card')].map(c => c.textContent)).toEqual(['–Gemininot read yet']);
  await done();
 }
});

const geminiBuckets = [{group:'Gemini', label:'5-hour', remainingFraction:.91}, {group:'Gemini', label:'Weekly', remainingFraction:.88}];
async function renderOnce(props: any) {
 const host = document.createElement('div'), root = createRoot(host);
 await act(async () => root.render(createElement(AntigravityQuota, props)));
 return {host, done: () => act(async () => root.unmount())};
}
it('keeps the Gemini ring cards with an updated-ago note when busy or a later read fails', async () => {
 const now = 10_000_000, seen = now - 12*60_000;
 const lastKnown = {seen, buckets: geminiBuckets};
 for (const props of [{quota:{...busy, lastKnown}}, {quota:{...busy, lastKnown}, failed:true}, {quota:{status:'error'} as any, failed:true}]) {
  const {host, done} = await renderOnce({...props, now, onRetry:()=>{}});
  const cards = [...host.querySelectorAll('.quick-usage-card')];
  if ((props.quota as any).status === 'error') { expect(cards).toHaveLength(1); expect(host.textContent).toContain('–'); }
  else { expect(cards.map(c => c.textContent)).toEqual([expect.stringMatching(/^9%Gemini 5-hour/), expect.stringMatching(/^12%Gemini Weekly/)]); expect(host.textContent).toContain('Updated 12 min ago'); }
  expect(host.querySelector('.quick-usage-note')!.textContent).toMatch(/busy|failed/);
  await done();
 }
});
it('shows one empty Gemini card (dash, no percent) when nothing was ever read, with a styled retry that disables while loading', async () => {
 for (const props of [{quota:busy}, {failed:true}, {quota:{status:'unavailable',reason:'no_connection',source:'antigravity_acp'} as any}, {loading:true}]) {
  const retry = vi.fn();
  const {host, done} = await renderOnce({...props, onRetry:retry});
  const cards = [...host.querySelectorAll('.quick-usage-card')];
  expect(cards).toHaveLength(1);
  expect(cards[0].textContent).toMatch(/^–Gemini/);
  expect(host.textContent).not.toContain('%');
  expect(host.querySelector('p.quick-usage-note')).not.toBeNull();
  expect(host.querySelector('.quick-usage-note button')).not.toBeNull();
  if ((props as any).loading) expect((host.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
  await done();
 }
});
