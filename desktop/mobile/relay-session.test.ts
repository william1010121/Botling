// The relay pairing a phone keeps must survive the page being opened again (a reload, the home-screen app reopened).
// WebKit (Safari, every iPhone browser) takes a record holding an X25519 CryptoKey without an error and reads it back
// as null (seen in headless WebKit 27.2): the fake IndexedDB below does the same in its `webkit` mode. "Opened again" is
// a fresh copy of relay-session.ts (vi.resetModules), so nothing is left in its memory.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RelaySession } from './relay-client';

type Mode = 'normal' | 'webkit' | 'forgetful';
let mode: Mode = 'normal';
let rows = new Map<string, unknown>();

/** A copy as IndexedDB keeps it; null where WebKit would give the record back as null. */
function keep(value: unknown): { value: unknown; lost: boolean } {
  let lost = false;
  const copy = (v: unknown): unknown => {
    if (v instanceof CryptoKey) { if (mode === 'webkit' && v.algorithm.name === 'X25519') lost = true; return v; }
    if (v instanceof Uint8Array) return new Uint8Array(v);
    if (v instanceof ArrayBuffer) return v.slice(0);
    if (Array.isArray(v)) return v.map(copy);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
    return v;
  };
  const kept = copy(value);
  return { value: kept, lost };
}
function request<T>(result: () => T) {
  const req: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
  queueMicrotask(() => { req.result = result(); req.onsuccess?.(); });
  return req;
}
const fakeIndexedDB = {
  open() {
    const db = {
      close() {},
      transaction() {
        return { objectStore: () => ({
          put: (value: unknown, key: string) => request(() => { const kept = keep(value); if (mode !== 'forgetful') rows.set(key, kept.lost ? null : kept.value); return key; }),
          get: (key: string) => request(() => rows.has(key) ? keep(rows.get(key)).value : undefined),
          delete: (key: string) => request(() => { rows.delete(key); return undefined; }),
        }) };
      },
    };
    const req: any = {};
    queueMicrotask(() => { req.result = db; req.onsuccess?.(); });
    return req;
  },
};

beforeEach(() => { rows = new Map(); mode = 'normal'; vi.resetModules(); vi.stubGlobal('indexedDB', fakeIndexedDB); });
afterEach(() => { vi.unstubAllGlobals(); });

const page = () => import('./relay-session');
async function paired(): Promise<RelaySession> {
  // The key the pairing makes (relay-client.ts: extractable, so it can be wrapped).
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { ws: 'wss://relay.example/ws', room: 'r'.repeat(43), deskKey: 'd'.repeat(43), deviceId: 'device-1', token: 't'.repeat(43),
    keys: { privateKey: pair.privateKey, publicKey }, coreId: 'core', botIds: ['main'], expiresAt: Date.now() + 30 * 86_400_000 };
}
/** Whether two private keys are the same key (they agree with one peer). */
async function sameKey(a: CryptoKey, b: CryptoKey) {
  const peer = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const bits = (k: CryptoKey) => crypto.subtle.deriveBits({ name: 'X25519', public: peer.publicKey } as unknown as AlgorithmIdentifier, k, 256);
  return Buffer.from(await bits(a)).equals(Buffer.from(await bits(b)));
}

for (const browser of ['normal', 'webkit'] as const) {
  it(`a paired phone is still paired when the page opens again (${browser} storage)`, async () => {
    mode = browser;
    const session = await paired();
    expect(await (await page()).saveRelaySession(session)).toBe(true);
    vi.resetModules();
    const loaded = await (await page()).loadRelaySession();
    expect(loaded).not.toBeNull();
    expect({ ...loaded!, keys: undefined }).toEqual({ ...session, keys: undefined });
    expect(loaded!.keys.publicKey).toEqual(session.keys.publicKey);
    expect(loaded!.keys.privateKey.extractable).toBe(false);
    expect(await sameKey(loaded!.keys.privateKey, session.keys.privateKey)).toBe(true);
  });
}

it('the stored record holds no usable private key: only the wrapped bytes, under a key that cannot be read out', async () => {
  const session = await paired();
  await (await page()).saveRelaySession(session);
  const stored = rows.get('current') as any;
  expect(stored.keys.privateKey).toBeUndefined();
  expect(stored.keys.sealed.data).toBeInstanceOf(ArrayBuffer);
  expect((rows.get('session-key') as CryptoKey).extractable).toBe(false);
});

it('a renewal (the desktop extends a phone in use) keeps the pairing usable after the next reload', async () => {
  mode = 'webkit';
  await (await page()).saveRelaySession(await paired());
  vi.resetModules();
  let store = await page();
  const loaded = (await store.loadRelaySession())!;
  expect(await store.saveRelaySession({ ...loaded, expiresAt: loaded.expiresAt + 1000 })).toBe(true);
  vi.resetModules();
  store = await page();
  expect((await store.loadRelaySession())?.expiresAt).toBe(loaded.expiresAt + 1000);
});

it('a browser that takes the record but does not give it back: the save says so (never reported as kept)', async () => {
  mode = 'forgetful';
  const store = await page();
  const session = await paired();
  expect(await store.saveRelaySession(session)).toBe(false);
  // It still lasts for this page.
  expect(await store.loadRelaySession()).toBe(session);
});

it('no IndexedDB at all (a private tab in some browsers): not kept, and it lasts for this page', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const store = await page();
  const session = await paired();
  expect(await store.saveRelaySession(session)).toBe(false);
  expect(await store.loadRelaySession()).toBe(session);
});

it('a pairing kept before wrapping (a CryptoKey stored as is, where the browser gave it back) still loads', async () => {
  const session = await paired();
  rows.set('current', session);
  const loaded = await (await page()).loadRelaySession();
  expect(loaded?.deviceId).toBe('device-1');
  expect(loaded?.keys.privateKey).toBe(session.keys.privateKey);
});

it('an expired pairing or a record wrapped under another key is not loaded; Sign out forgets it', async () => {
  let store = await page();
  await store.saveRelaySession(await paired());
  rows.set('session-key', await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']));
  vi.resetModules();
  store = await page();
  expect(await store.loadRelaySession()).toBeNull();
  await store.saveRelaySession({ ...(await paired()), expiresAt: Date.now() - 1 });
  vi.resetModules();
  store = await page();
  expect(await store.loadRelaySession()).toBeNull();
  await store.saveRelaySession(await paired());
  await store.forgetRelaySession();
  expect(rows.has('current')).toBe(false);
  expect(await store.loadRelaySession()).toBeNull();
});
