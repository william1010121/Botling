// @vitest-environment jsdom
// The home-screen app: it keeps its own storage apart from Safari, so it pairs again on its own, from a code scanned
// in the page or its link pasted. And at phone width the left column is a drawer with the bots' names, never the
// desktop's folded strip of faces, whatever the desktop's own setting says.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const pair = vi.fn();
vi.mock('./relay-client', () => ({
  RelayClient: class { static pair = pair; static connect = vi.fn(); watch() { return () => {}; } close() {} resume() {} },
}));
vi.mock('./relay-session', () => ({ loadRelaySession: async () => null, saveRelaySession: async () => true, forgetRelaySession: async () => {},
  loadBridgeLogin: async () => null, saveBridgeLogin: async () => true, forgetBridgeLogin: async () => {} }));
const { WebApp } = await import('./WebApp');

const MAIN = '6A0B0000-0000-4000-8000-000000000002';
const KEY = 'a'.repeat(43);
let root: Root, container: HTMLDivElement, phone = false;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', '/mobile/');
  window.matchMedia = ((query: string) => ({ matches: phone && query.includes('700px'), media: query, addEventListener() {}, removeEventListener() {} })) as any;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  pair.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); phone = false; });
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const bot = (id: string, name: string, role: string) => ({ id, name, role, avatar: 'circle', folder: name, phase: 'awake', working: false, approvals: 0, unread: 0,
  subagents: 0, problem: null, heads: ['claude'], job: null, subagentRows: [], lastActivity: null });

async function relayClient(railCollapsed: boolean) {
  const requests: any[] = [];
  const client = new ((await import('./relay-client')).RelayClient as any)();
  client.request = async (cmd: any) => { requests.push(cmd); return { epoch: 'e', seq: 1, imported: null, components: {}, waiting: { items: [], doing: {} },
    settings: { language: null, effectiveLanguage: 'en', botLook: 'original', chatAvatarSize: null, rightPanelCollapsed: false, railCollapsed, pinnedBots: [] },
    bots: [bot(MAIN, 'Main bot', 'main'), bot('p1', 'botling', 'manager')],
    chat: { botId: cmd.botId ?? MAIN, messages: [], running: null, live: [], runs: [], heads: null, pins: [], floating: [], pinChoices: [], pendingFiles: [] } }; };
  client.closed = false;
  pair.mockResolvedValue({ client, session: { botIds: ['*'] } });
  return requests;
}
async function enter(text: string) {
  const input = container.querySelector('input.web-token') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
}

it('with nothing saved, offers Scan QR code first, and a pasted pairing link pairs in the page as a scan does', async () => {
  await relayClient(false);
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(container.querySelector('.web-primary')?.textContent).toBe('Scan QR code');
  expect(pair).not.toHaveBeenCalled();
  // Copied on the computer with words around it (a message to oneself): the link inside is what counts.
  await enter(`Botling pairing: ${location.origin}/mobile/#relay=${KEY}&k=${KEY}&s=${KEY}&v=2 `);
  await flush();
  expect(pair).toHaveBeenCalledOnce();
  expect(pair.mock.calls[0][0]).toEqual({ room: KEY, deskKey: KEY, secret: KEY, v: 2 });
  expect(pair.mock.calls[0][1]).toBe(location.origin);
  expect(container.querySelector('.shell')).not.toBeNull();
});

it('a scan that cannot open the camera says why and keeps the paste field', async () => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); }) } });
  try {
    await act(async () => root.render(<WebApp />));
    await flush();
    await act(async () => { (container.querySelector('.web-scan-button') as HTMLButtonElement).click(); });
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Camera access is off');
    expect(container.querySelector('.web-scan')).toBeNull();
    expect(container.querySelector('input.web-token')).not.toBeNull();
  } finally { delete (navigator as any).mediaDevices; }
});

it('something that is not a pairing link is refused before anything is sent', async () => {
  await act(async () => root.render(<WebApp />));
  await flush();
  await enter('https://example.com/not-a-code');
  await flush();
  expect(pair).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('pairing link');
});

it('at phone width the drawer shows the open column (names) even when the desktop folded it; its fold button closes the drawer', async () => {
  phone = true;
  const requests = await relayClient(true);
  window.history.replaceState(null, '', `/mobile/#relay=${KEY}&k=${KEY}&s=${KEY}`);
  await act(async () => root.render(<WebApp />));
  await flush();
  const web = container.querySelector('.web-root') as HTMLElement;
  expect(web.dataset.nav).toBe('open');
  expect(container.querySelector('.rail-strip')).toBeNull();
  expect([...container.querySelectorAll('.rail .bot-row')].map(row => row.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('botling')]));
  await act(async () => { (container.querySelector('.rail .rail-toggle') as HTMLButtonElement).click(); });
  await flush();
  expect(web.dataset.nav).toBe('closed');
  // Closing the drawer is not folding the column: nothing is saved, and it opens whole again.
  expect(requests.some(cmd => cmd.type === 'settings.set')).toBe(false);
  expect(container.querySelector('.rail-strip')).toBeNull();
});

it('on a wide screen the desktop\'s folded column stays folded', async () => {
  await relayClient(true);
  window.history.replaceState(null, '', `/mobile/#relay=${KEY}&k=${KEY}&s=${KEY}`);
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(container.querySelector('.rail-strip')).not.toBeNull();
});
