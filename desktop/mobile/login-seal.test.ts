// The bridge sign-in a phone keeps is stored only encrypted, under a key that cannot be read out of the browser.
import { expect, it } from 'vitest';
import { makeLoginKey, openLogin, sealLogin } from './relay-session';

it('seals the token so the stored record does not contain it, and opens only with its own key', async () => {
  const key = await makeLoginKey();
  expect(key.extractable).toBe(false);
  const login = { token: 'T'.repeat(43), origin: 'https://phone.example', coreId: 'c'.repeat(32) };
  const sealed = await sealLogin(key, login);
  expect(new TextDecoder().decode(sealed.data)).not.toContain('TTTT');
  expect(await openLogin(key, sealed)).toEqual(login);
  expect(await openLogin(await makeLoginKey(), sealed)).toBeNull();
  const tampered = new Uint8Array(sealed.data.slice(0)); tampered[0] ^= 1;
  expect(await openLogin(key, { iv: sealed.iv, data: tampered.buffer })).toBeNull();
});
