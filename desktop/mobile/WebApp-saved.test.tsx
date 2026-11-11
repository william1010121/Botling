// @vitest-environment jsdom
// A phone signed in once stays signed in: the bridge's token is kept (encrypted, relay-session.ts) and the page opened
// again (a new tab, the home-screen app, a tab the system discarded) signs in with it, without a code or a token field.
// A token the desktop no longer accepts is forgotten; signing out forgets it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const kept = { login: null as null | { token: string; origin: string; coreId?: string } };
const saveBridgeLogin = vi.fn(async (login: any) => { kept.login = login; return true; });
const forgetBridgeLogin = vi.fn(async () => { kept.login = null; });
vi.mock('./relay-session', () => ({
  loadRelaySession: async () => null, saveRelaySession: async () => true, forgetRelaySession: async () => {},
  loadBridgeLogin: async (origin: string) => kept.login?.origin === origin ? kept.login : null, saveBridgeLogin, forgetBridgeLogin,
}));
const { WebApp } = await import('./WebApp');

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.history.replaceState(null, '', '/mobile/');
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as any;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  kept.login = null; saveBridgeLogin.mockClear(); forgetBridgeLogin.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

const MAIN = '6A0B0000-0000-4000-8000-000000000002';
const TOKEN = 'k'.repeat(43);
const bot = (id: string, name: string, role: string) => ({ id, name, role, avatar: 'circle', folder: name, phase: 'awake', working: false, approvals: 0, unread: 0,
  subagents: 0, problem: null, heads: ['claude'], job: null, subagentRows: [], lastActivity: null });
function server() {
  const auth: string[] = [];
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    auth.push((init.headers as Record<string, string>).Authorization);
    if ((init.headers as Record<string, string>).Authorization !== `Bearer ${TOKEN}`) return new Response('{"error":{"code":"auth_required"}}', { status: 401 });
    return new Response(JSON.stringify({ v: 10, id: request.id, ok: true, result: { epoch: 'e', seq: 1, imported: null, components: {}, waiting: { items: [], doing: {} },
      settings: { language: null, effectiveLanguage: 'en', botLook: 'original', chatAvatarSize: null, rightPanelCollapsed: false, railCollapsed: false, pinnedBots: [] },
      bots: [bot(MAIN, 'Main bot', 'main')],
      chat: { botId: request.cmd.botId ?? MAIN, messages: [], running: null, live: [], runs: [], heads: null, pins: [], floating: [], pinChoices: [], pendingFiles: [] } } }));
  });
  vi.stubGlobal('fetch', fetcher);
  return { auth };
}
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };

it('opened again with a kept sign-in, the page shows the bots without asking for a code or a token', async () => {
  const { auth } = server();
  kept.login = { token: TOKEN, origin: location.origin };
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(container.querySelector('input.web-token')).toBeNull();
  expect(container.querySelector('.rail .bot-row')).not.toBeNull();
  expect(auth).toContain(`Bearer ${TOKEN}`);
});

it('a sign-in is kept for the next time the page opens', async () => {
  server();
  await act(async () => root.render(<WebApp />));
  await flush();
  const input = container.querySelector('input.web-token') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, TOKEN);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
  await flush();
  expect(saveBridgeLogin).toHaveBeenCalledWith(expect.objectContaining({ token: TOKEN, origin: location.origin }));
});

it('a kept token the desktop no longer accepts is forgotten and the page asks again', async () => {
  server();
  kept.login = { token: 'x'.repeat(43), origin: location.origin };
  await act(async () => root.render(<WebApp />));
  await flush();
  expect(forgetBridgeLogin).toHaveBeenCalled();
  expect(container.querySelector('input.web-token')).not.toBeNull();
});

it('signing out forgets the kept sign-in', async () => {
  server();
  kept.login = { token: TOKEN, origin: location.origin };
  await act(async () => root.render(<WebApp />));
  await flush();
  await act(async () => { (container.querySelector('.web-sign-out') as HTMLButtonElement).click(); });
  await flush();
  expect(forgetBridgeLogin).toHaveBeenCalled();
  expect(container.querySelector('input.web-token')).not.toBeNull();
});
