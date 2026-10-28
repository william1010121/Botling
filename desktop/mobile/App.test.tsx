// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { PROTOCOL_VERSION } from '../src/contract';
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/mobile/");
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('continues refreshing after opening the already-selected chat', async () => {
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
    if (String(_url).endsWith('/session')) return new Response(JSON.stringify({ principal: 'a'.repeat(64), csrf: 'c'.repeat(43), expiresAt: Date.now() + 3600000, botIds: ['main'] }));
    const request = JSON.parse(init.body as string); reads++;
    return new Response(JSON.stringify({ v: PROTOCOL_VERSION, id: request.id, ok: true, result: {
      epoch: 'epoch', seq: reads,
      bots: [{ id: 'main', name: 'Main', role: 'main', working: false, approvals: 0, unread: 0, problem: null, heads: ['claude'] }],
      chat: { botId: 'main', messages: [{ id: 'message', role: 'bot', text: `revision-${reads}`, time: '2026-10-28T00:00:00Z' }], tasks: [], pendingFiles: [] },
    } }));
  }));
  await act(async () => root.render(<App />));
  expect(container.querySelector('input[name="token"]')).toBeNull();
  expect(container.querySelector('nav')!.className).not.toContain('open');
  const before = reads;
  await act(async () => { (container.querySelector('nav button') as HTMLButtonElement).click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(reads).toBeGreaterThan(before);
  expect(container.querySelector('.messages')!.textContent).toContain(`revision-${reads}`);
});

function browserFixture() {
  const principal = 'b'.repeat(64); const csrf = 's'.repeat(43);
  let status = 200, reads = 0, active = 0, maximum = 0;
  let gate: Promise<void> | undefined;
  const fetcher = vi.fn(async (url: unknown, init: RequestInit) => {
    if (String(url).endsWith('/logout')) return new Response('{"loggedOut":true}');
    if (String(url).endsWith('/session')) return new Response(JSON.stringify({ principal, csrf, expiresAt: Date.now() + 3600000, botIds: ['main'] }));
    const request = JSON.parse(init.body as string); reads++; active++; maximum = Math.max(active, maximum);
    try {
      if (gate) await gate;
      if (status === 401) return new Response(JSON.stringify({ error: { code: 'auth_required' } }), { status });
      if (status === 403) return new Response(JSON.stringify({ v: PROTOCOL_VERSION, id: request.id, ok: false, error: { code: 'forbidden', message: 'Not granted' } }), { status });
      return new Response(JSON.stringify({ v: PROTOCOL_VERSION, id: request.id, ok: true, result: {
        epoch: 'epoch', seq: reads, bots: [{ id: 'main', name: 'Main', role: 'main', working: false, approvals: 0, unread: 0, problem: null, heads: ['claude'] }],
        chat: { botId: 'main', messages: [], tasks: [], pendingFiles: [] },
      } }));
    } finally { active--; }
  });
  vi.stubGlobal('fetch', fetcher);
  sessionStorage.setItem('botling-mobile-drafts', JSON.stringify({ principal, drafts: { main: 'unsent draft' } }));
  return { fetcher, principal, csrf, status: (next: number) => { status = next; }, gate: (next?: Promise<void>) => { gate = next; }, maximum: () => maximum };
}
it('restores drafts on return/reload and sends cookie credentials without bearer or storage credentials', async () => {
  const fixture = browserFixture();
  await act(async () => root.render(<App />));
  expect((container.querySelector('#compose') as HTMLTextAreaElement).value).toBe('unsent draft');
  const init = fixture.fetcher.mock.calls.find(([url]) => String(url).endsWith('/browser/command'))![1];
  expect(init).toMatchObject({ credentials: 'same-origin', redirect: 'manual', headers: { 'X-Botling-CSRF': fixture.csrf } });
  expect(init.headers).not.toHaveProperty('Authorization');
  expect(JSON.stringify(sessionStorage)).not.toContain(fixture.csrf);
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => root.render(<App />));
  expect((container.querySelector('#compose') as HTMLTextAreaElement).value).toBe('unsent draft');
});
it('preserves drafts on expiry and reconnects without an automatic login redirect', async () => {
  const fixture = browserFixture(); await act(async () => root.render(<App />));
  fixture.status(401); await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.textContent).toContain('Sign in with Google');
  expect(sessionStorage.getItem('botling-mobile-drafts')).toContain('unsent draft');
  fixture.status(200);
  await act(async () => { Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Check connection')!.click(); });
  expect((container.querySelector('#compose') as HTMLTextAreaElement).value).toBe('unsent draft');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it('keeps the authenticated UI and draft on bot denial, then clears the error after successful refresh', async () => {
  const fixture = browserFixture(); await act(async () => root.render(<App />));
  fixture.status(403); await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.textContent).toContain('This bot or action is not authorized');
  expect((container.querySelector('#compose') as HTMLTextAreaElement).value).toBe('unsent draft');
  fixture.status(200); await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
it('does not overlap polls when online/visibility events arrive during an in-flight refresh', async () => {
  const fixture = browserFixture(); await act(async () => root.render(<App />));
  let release!: () => void; fixture.gate(new Promise<void>(resolve => { release = resolve; }));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  await act(async () => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(500); });
  expect(fixture.maximum()).toBe(1);
  fixture.gate(); await act(async () => release());
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  expect(fixture.maximum()).toBe(1);
});
it.each(['auth_required', 'access_denied', 'auth_unavailable'])('shows safe callback error %s without erasing drafts or automatic redirects', async code => {
  browserFixture(); window.history.replaceState(null, '', '/mobile/?auth_error=' + code);
  await act(async () => root.render(<App />));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).toContain('Sign in with Google');
  expect(window.location.search).toBe('');
  expect(sessionStorage.getItem('botling-mobile-drafts')).toContain('unsent draft');
});
it('signs out through the app session endpoint, clears draft storage, and remains on the login screen', async () => {
  const f = browserFixture(); await act(async () => root.render(<App />));
  await act(async () => { Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Sign out')!.click(); });
  expect(f.fetcher.mock.calls.some(([url]) => url === '/api/mobile/logout')).toBe(true);
  expect(sessionStorage.getItem('botling-mobile-drafts')).toBeNull();
  expect(container.textContent).toContain('Sign in with Google'); expect(container.querySelector('#compose')).toBeNull();
  expect(window.location.pathname).toBe('/mobile/');
});
it('preserves the draft on offline transition and resumes polling when online', async () => {
  const f = browserFixture(); await act(async () => root.render(<App />));
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  await act(async () => { window.dispatchEvent(new Event('offline')); });
  expect(container.textContent).toContain('Offline');
  expect((container.querySelector('#compose') as HTMLTextAreaElement).value).toBe('unsent draft');
  const calls = f.fetcher.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(10000)); expect(f.fetcher.mock.calls.length).toBe(calls);
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(f.fetcher.mock.calls.length).toBeGreaterThan(calls);
  expect((container.querySelector('#compose') as HTMLTextAreaElement).value).toBe('unsent draft');
});
it('keeps the session and draft when logout fails so the user can retry', async () => {
  const f = browserFixture(); await act(async () => root.render(<App />));
  f.fetcher.mockImplementationOnce(async () => new Response('{}', { status: 503 }));
  await act(async () => { Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Sign out')!.click(); });
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect((container.querySelector('#compose') as HTMLTextAreaElement).value).toBe('unsent draft');
  expect(sessionStorage.getItem('botling-mobile-drafts')).toContain('unsent draft');
});

function viewport(initial: boolean) {
  const media = new EventTarget() as EventTarget & { matches: boolean };
  media.matches = initial;
  vi.stubGlobal('matchMedia', () => media);
  return async (wide: boolean) => { await act(async () => { media.matches = wide; media.dispatchEvent(new Event('change')); }); };
}
it('keeps desktop navigation visible on selection and resets the phone drawer across resizing', async () => {
  const resize = viewport(true); browserFixture(); await act(async () => root.render(<App />));
  const toggle = container.querySelector('#chat-toggle') as HTMLButtonElement;
  expect(toggle.hidden).toBe(true);
  await act(async () => (container.querySelector('nav button') as HTMLButtonElement).click());
  expect(container.querySelector('nav')!.className).toBe('open');
  await resize(false); expect(toggle.hidden).toBe(false); expect(container.querySelector('nav')!.className).toBe('');
  await act(async () => toggle.click()); expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('.conversation')!.hasAttribute('inert')).toBe(true);
  await act(async () => container.querySelector('nav')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(document.activeElement).toBe(toggle);
  await act(async () => toggle.click());
  await act(async () => (container.querySelector('nav button') as HTMLButtonElement).click());
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect((container.querySelector('#compose') as HTMLTextAreaElement).value).toBe('unsent draft');
  await resize(true); expect(container.querySelector('nav')!.className).toBe('open');
});
it.each(['ctrlKey', 'metaKey'])('sends once with %s+Enter but not plain Enter or IME composition', async modifier => {
  const f = browserFixture(); await act(async () => root.render(<App />));
  const commands = () => f.fetcher.mock.calls.filter(([, init]) => init.body && JSON.parse(String(init.body)).cmd?.type === 'chat.send');
  const input = container.querySelector('#compose')!;
  for (const options of [{}, { [modifier]: true, isComposing: true }]) {
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...options })));
  }
  expect(commands()).toHaveLength(0);
  f.fetcher.mockImplementationOnce(async (url, init) => {
    const request = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ v: PROTOCOL_VERSION, id: request.id, ok: true, result: { messageId: 'sent', turnId: null } }));
  });
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, [modifier]: true })));
  expect(commands()).toHaveLength(1);
  expect((input as HTMLTextAreaElement).value).toBe('');
});
