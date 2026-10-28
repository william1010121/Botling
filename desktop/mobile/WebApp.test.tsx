// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WebApp } from './WebApp';

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', '/mobile/');
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as any;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const MAIN = '6A0B0000-0000-4000-8000-000000000002';
const bot = (id: string, name: string, role: string) => ({ id, name, role, avatar: 'circle', folder: name, phase: 'awake', working: false, approvals: 0, unread: 0,
  subagents: 0, problem: null, heads: ['claude'], job: null, subagentRows: [], openTasks: 0, lastActivity: null });
function server(options: { signedIn?: boolean; tasks?: any[] } = {}) {
  let signedIn = options.signedIn ?? true, commandStatus = 200;
  const commands: any[] = [], paths: string[] = [];
  const fetcher = vi.fn(async (url: unknown, init: RequestInit) => {
    const path = new URL(String(url), location.origin).pathname; paths.push(path);
    if (!signedIn) return new Response('{"error":{"code":"auth_required"}}', { status: 401 });
    if (path === '/api/mobile/session') return new Response(JSON.stringify({ principal: 'a'.repeat(64), csrf: 'c'.repeat(43), expiresAt: Date.now() + 3_600_000, botIds: ['*'] }));
    if (path === '/api/mobile/logout') { signedIn = false; return new Response('{"loggedOut":true}'); }
    const request = JSON.parse(init.body as string); commands.push(request.cmd);
    if (commandStatus !== 200) return new Response(commandStatus === 401 ? '{"error":{"code":"auth_required"}}' : '<html>edge denied</html>', { status: commandStatus });
    expect((init.headers as Record<string, string>)['X-Botling-CSRF']).toBe('c'.repeat(43));
    return new Response(JSON.stringify({ v: 10, id: request.id, ok: true, result: { epoch: 'e', seq: 1, imported: null, components: {}, teams: [], waiting: { items: [], doing: {} },
      settings: { language: null, effectiveLanguage: 'en', botLook: 'original', chatAvatarSize: null, messageColumnWidth: null, rightPanelCollapsed: false, railCollapsed: false, pinnedBots: [] },
      bots: [bot(MAIN, 'Main bot', 'main'), bot('DEC0DE00-0000-4000-8000-00000000DEC0', 'Maintainer', 'bot'), bot('p1', 'botling', 'manager'), bot('p2', 'hotel', 'manager')],
      chat: { botId: request.cmd.botId ?? MAIN, messages: [], running: null, live: [], tasks: options.tasks ?? [], runs: [], heads: null, catchUp: null, intervalSummaries: [], pins: [], floating: [], pinChoices: [], pendingFiles: [] } } }));
  });
  vi.stubGlobal('fetch', fetcher);
  return { commands, paths, expire: (status = 401) => { commandStatus = status; } };
}
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };

it('signed in, shows the desktop renderer with every bot and signs out back to Google sign-in', async () => {
  const { commands, paths } = server();
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(container.querySelector('.shell')).not.toBeNull();
  expect([...container.querySelectorAll('.bot-row')].map(row => (row as HTMLElement).dataset.bot)).toEqual([MAIN, 'DEC0DE00-0000-4000-8000-00000000DEC0', 'p1', 'p2']);
  const frame = container.querySelector('#chat-frame') as HTMLIFrameElement;
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  expect(container.querySelector('.rail-add')).toBeNull();
  await act(async () => { (container.querySelector('.bot-row[data-bot="p2"]') as HTMLButtonElement).click(); });
  await flush();
  expect(commands.at(-1)).toEqual({ type: 'chat.snapshot', botId: 'p2' });
  expect(container.querySelector('.chat-title')?.textContent).toBe('hotel');
  expect(commands.every(cmd => ['chat.snapshot', 'chat.send', 'chat.choose', 'chat.answer'].includes(cmd.type))).toBe(true);
  await act(async () => { (container.querySelector('.web-sign-out') as HTMLButtonElement).click(); });
  await flush();
  expect(paths).toContain('/api/mobile/logout');
  expect(container.querySelector('.shell')).toBeNull();
  expect(container.textContent).toContain('Sign in with Google');
});

it('signed out, offers Google sign-in and never shows the workspace', async () => {
  const { commands } = server({ signedIn: false });
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(container.querySelector('.shell')).toBeNull();
  expect(container.querySelector('.web-primary')?.textContent).toBe('Sign in with Google');
  expect(commands).toEqual([]);
});

it('a Google denial from the callback is shown without contacting the API', async () => {
  window.history.replaceState(null, '', '/mobile/?auth_error=access_denied');
  const { paths } = server();
  await act(async () => root.render(<WebApp />));
  expect(container.textContent).toContain('This Google account is not authorized.');
  expect(paths).toEqual([]);
  expect(location.search).toBe('');
});

const showsPrivateChat = () => !!container.querySelector('.shell, #chat-frame, .bot-row');

it.each([401, 403])('a background poll that hears %i returns to sign-in, clears the chat and stops polling', async status => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { commands, expire } = server();
    await act(async () => root.render(<WebApp />));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(showsPrivateChat()).toBe(true);
    expire(status);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_600); });
    expect(showsPrivateChat()).toBe(false);
    expect(container.textContent).toContain('Sign in with Google');
    const sent = commands.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(commands.length).toBe(sent);
  } finally { vi.useRealTimers(); }
});

it('a command that hears 401 returns to sign-in and clears the chat', async () => {
  const { expire } = server();
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(showsPrivateChat()).toBe(true);
  expire(401);
  await act(async () => { (container.querySelector('.bot-row[data-bot="p2"]') as HTMLButtonElement).click(); });
  await flush();
  expect(showsPrivateChat()).toBe(false);
  expect(container.textContent).toContain('Sign in with Google');
});

it('sign-out clears the chat and this browser\'s kept layout', async () => {
  server();
  localStorage.setItem('botling-web-layout', JSON.stringify({ pinnedBots: ['p1'] }));
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(showsPrivateChat()).toBe(true);
  await act(async () => { (container.querySelector('.web-sign-out') as HTMLButtonElement).click(); });
  await flush();
  expect(showsPrivateChat()).toBe(false);
  expect(localStorage.getItem('botling-web-layout')).toBeNull();
});

it.each([401, 403])('a session that is already over at the first read (%i) can be checked again after signing in', async status => {
  const { paths, expire } = server();
  expire(status);
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(showsPrivateChat()).toBe(false);
  expect(container.textContent).toContain(status === 401 ? 'Your session expired' : 'Access was denied');
  const again = [...container.querySelectorAll('button')].find(button => button.textContent === 'Check again') as HTMLButtonElement;
  expect(again).toBeTruthy();
  // Signed in again elsewhere (the Google round trip): the bridge now answers.
  expire(200);
  const before = paths.length;
  await act(async () => { again.click(); });
  await flush();
  expect(paths.length).toBeGreaterThan(before);
  expect(showsPrivateChat()).toBe(true);
  expect(container.querySelectorAll('.bot-row')).toHaveLength(4);
});

it('390px Details opens and closes without changing the selected bot or saved layout', async () => {
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as any;
  const { commands } = server({ tasks: [{ id: 't1', name: 'Preserved task', state: 'done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageIDs: [], history: [] }] });
  await act(async () => root.render(<WebApp />));
  await flush();
  await act(async () => { (container.querySelector('.bot-row[data-bot="p2"]') as HTMLButtonElement).click(); });
  await flush();
  const entry = container.querySelector<HTMLButtonElement>('button[aria-label="Details"]');
  expect(entry).not.toBeNull();
  await act(async () => { entry!.focus(); entry!.click(); });
  const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Details"]')!;
  expect(dialog.hidden).toBe(false);
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(container.querySelector('.chat-pane')?.hasAttribute('inert')).toBe(true);
  await act(async () => { (dialog.querySelector('[aria-label="Show done"]') as HTMLButtonElement).click(); });
  await act(async () => { (dialog.querySelector('.task-row-open') as HTMLButtonElement).click(); });
  expect(dialog.querySelector('.task-card[data-task="t1"]')).not.toBeNull();
  const closeButton = dialog.querySelector<HTMLButtonElement>('[aria-label="Close Details"]')!;
  const last = [...dialog.querySelectorAll<HTMLButtonElement>('button')].at(-1)!;
  await act(async () => { closeButton.focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })); });
  expect(document.activeElement).toBe(last);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); });
  expect(document.activeElement).toBe(closeButton);
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(dialog.hidden).toBe(true);
  expect(document.activeElement).toBe(entry);
  expect(container.querySelector('.chat-pane')?.hasAttribute('inert')).toBe(false);
  await act(async () => { entry!.click(); });
  expect(dialog.querySelector('.task-card[data-task="t1"]')).not.toBeNull();
  await act(async () => { closeButton.click(); });
  expect(dialog.hidden).toBe(true);
  await act(async () => { entry!.click(); (dialog.querySelector('.task-details-backdrop') as HTMLElement).click(); });
  expect(dialog.hidden).toBe(true);
  expect(container.querySelector('.chat-title')?.textContent).toBe('hotel');
  expect(commands.every(cmd => cmd.type === 'chat.snapshot')).toBe(true);
});


it('desktop keeps the existing expanded and collapsed right-panel controls', async () => {
  server();
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(container.querySelector('.task-details-entry, .task-details-drawer')).toBeNull();
  expect(container.querySelector('.detail-panel')).not.toBeNull();
  await act(async () => { (container.querySelector('[aria-label="Hide right panel"]') as HTMLButtonElement).click(); });
  await flush();
  expect(container.querySelector('.right-strip')).not.toBeNull();
  expect(container.querySelector('[aria-label="Show right panel"]')).not.toBeNull();
  await act(async () => { (container.querySelector('[aria-label="Show right panel"]') as HTMLButtonElement).click(); });
  await flush();
  expect(container.querySelector('.detail-panel')).not.toBeNull();
});
