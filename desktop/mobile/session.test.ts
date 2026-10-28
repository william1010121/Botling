// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { clearDrafts, loadDrafts, saveDrafts, sessionRequest } from './session';
afterEach(() => { sessionStorage.clear(); vi.unstubAllGlobals(); });
it('separates draft ownership and erases saved drafts on explicit logout', () => {
  saveDrafts('owner', { main: 'draft' }); expect(loadDrafts('owner')).toEqual({ main: 'draft' });
  expect(loadDrafts('another-account')).toEqual({}); expect(loadDrafts('owner')).toEqual({});
  saveDrafts('owner', { main: 'again' }); clearDrafts(); expect(loadDrafts('owner')).toEqual({});
});
it('never follows an API login redirect and distinguishes missing identity from denial', async () => {
  for (const status of [401, 403]) {
    const fetcher = vi.fn(async () => new Response('<html>edge failure</html>', { status })); vi.stubGlobal('fetch', fetcher);
    await expect(sessionRequest('session')).rejects.toMatchObject({ auth: status === 401, denied: status === 403 });
    expect(fetcher.mock.calls).toHaveLength(1);
  }
});
it('uses same-origin cookies and CSRF for logout, never credentials in URL or body', async () => {
  const fetcher = vi.fn(async (_url: unknown, _init: RequestInit) => new Response('{"loggedOut":true}')); vi.stubGlobal('fetch', fetcher);
  await sessionRequest('logout', 'fixture-csrf');
  expect(fetcher.mock.calls[0]).toEqual(['/api/mobile/logout', expect.objectContaining({ method: 'POST', credentials: 'same-origin', redirect: 'manual', headers: { 'X-Botling-Session': '1', 'X-Botling-CSRF': 'fixture-csrf' } })]);
  expect(fetcher.mock.calls[0][1].body).toBeUndefined();
});
