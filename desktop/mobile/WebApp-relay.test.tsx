// @vitest-environment jsdom
// The phone page opened from a relay pairing code: it pairs and shows the workspace with no token prompt, and when
// pairing fails it asks for a new code. The relay serves no token API, so an "Access token" field could never work there.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const pair = vi.fn();
const resumed: boolean[] = [];
vi.mock('./relay-client', () => ({
  RelayClient: class { static pair = pair; static connect = vi.fn(); watch() { return () => {}; } close() {} resume(restart: boolean) { resumed.push(restart); } },
}));
vi.mock('./relay-session', () => ({ loadRelaySession: async () => null, saveRelaySession: async () => true, forgetRelaySession: async () => {},
  loadBridgeLogin: async () => null, saveBridgeLogin: async () => true, forgetBridgeLogin: async () => {} }));
const { WebApp } = await import('./WebApp');
const { MobileError } = await import('./transport');

const MAIN = '6A0B0000-0000-4000-8000-000000000002';
const KEY = 'a'.repeat(43);
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', `/mobile/#relay=${KEY}&k=${KEY}&s=${KEY}`);
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as any;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  pair.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const bot = (id: string, name: string, role: string) => ({ id, name, role, avatar: 'circle', folder: name, phase: 'awake', working: false, approvals: 0, unread: 0,
  subagents: 0, problem: null, heads: ['claude'], job: null, subagentRows: [], lastActivity: null });

it('a scanned relay code pairs and opens the bots with no token prompt', async () => {
  const requests: any[] = [];
  const client = new (await import('./relay-client')).RelayClient() as any;
  client.request = async (cmd: any) => { requests.push(cmd); return { epoch: 'e', seq: 1, imported: null, components: {}, waiting: { items: [], doing: {} },
    settings: { language: null, effectiveLanguage: 'en', botLook: 'original', chatAvatarSize: null, rightPanelCollapsed: false, railCollapsed: false, pinnedBots: ['p2'], idleBots: ['p3'] },
    bots: [bot(MAIN, 'Main bot', 'main'), bot('DEC0DE00-0000-4000-8000-00000000DEC0', 'Maintainer', 'bot'), bot('p1', 'botling', 'manager'), bot('p2', 'hotel', 'manager'), bot('p3', 'garden', 'manager')],
    chat: { botId: cmd.botId ?? MAIN, messages: [], running: null, live: [], runs: [], heads: null, pins: [], floating: [], pinChoices: [], pendingFiles: [] } }; };
  client.closed = false;
  pair.mockResolvedValue({ client, session: { botIds: ['*'] } });
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(pair).toHaveBeenCalledOnce();
  expect(pair.mock.calls[0][0]).toMatchObject({ room: KEY, deskKey: KEY, secret: KEY });
  expect(location.hash).toBe(''); // the secret left the address bar
  expect(container.querySelector('input.web-token')).toBeNull();
  expect(requests[0]).toEqual({ type: 'chat.snapshot' });
  // The desktop's own left column: Main, Maintainer, Pinned, projects, and the collapsed Idle group.
  const rows = [...container.querySelectorAll('.rail .bot-row')].map(row => row.getAttribute('data-bot'));
  expect(rows).toEqual(expect.arrayContaining([MAIN, 'DEC0DE00-0000-4000-8000-00000000DEC0', 'p1', 'p2']));
  expect(rows).not.toContain('p3');
  expect(container.querySelector('[aria-label="Idle, 1 bot"]')).not.toBeNull();
  expect(container.textContent).toContain('Pinned');
});

it('a relay code that fails asks for a new code, never for an access token', async () => {
  pair.mockRejectedValue(new MobileError('This code has expired or already been used. Show a new code on your computer.', true));
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Show a new code');
  expect(container.querySelector('input.web-token')).toBeNull();
  expect(container.textContent).not.toContain('access token');
  expect(container.textContent).toContain('Settings › Phone');
});

it('coming back to the page reconnects the relay at once: a long absence or a network change replaces the socket', async () => {
  const client = new ((await import('./relay-client')).RelayClient as any)();
  client.request = async (cmd: any) => ({ epoch: 'e', seq: 1, imported: null, components: {}, waiting: { items: [], doing: {} },
    settings: { language: null, effectiveLanguage: 'en', botLook: 'original', chatAvatarSize: null, rightPanelCollapsed: false, railCollapsed: false, pinnedBots: [] },
    bots: [bot(MAIN, 'Main bot', 'main')], chat: { botId: cmd.botId ?? MAIN, messages: [], running: null, live: [], runs: [], heads: null, pins: [], floating: [], pinChoices: [], pendingFiles: [] } });
  client.closed = false;
  pair.mockResolvedValue({ client, session: { botIds: ['*'] } });
  await act(async () => root.render(<WebApp />));
  await flush();
  resumed.length = 0;
  let hidden = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  const now = vi.spyOn(Date, 'now');
  try {
    now.mockReturnValue(1_000_000);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    hidden = false;
    now.mockReturnValue(1_000_000 + 60_000);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { window.dispatchEvent(new Event('online')); });
  } finally { now.mockRestore(); Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); }
  expect(resumed).toEqual([true, true]);
});
