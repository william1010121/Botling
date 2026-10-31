// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { clearDrafts, loadDrafts, saveDrafts } from './session';
afterEach(() => { sessionStorage.clear(); });
it('separates draft ownership and erases saved drafts on explicit sign-out', () => {
  saveDrafts('owner', { main: 'draft' }); expect(loadDrafts('owner')).toEqual({ main: 'draft' });
  expect(loadDrafts('another-account')).toEqual({}); expect(loadDrafts('owner')).toEqual({});
  saveDrafts('owner', { main: 'again' }); clearDrafts(); expect(loadDrafts('owner')).toEqual({});
});
