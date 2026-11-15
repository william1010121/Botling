// The phone's relay pairing, kept so the phone does not need a new code every time the page opens. It lives in this
// origin's IndexedDB. Nothing of any chat is stored. Sign out (or a revocation) deletes the record.
//
// The phone's private key (X25519) is stored only wrapped: encrypted under a non-extractable AES-GCM key in this
// origin's key store, and unwrapped on load as a non-extractable key. A script on this page can use it while the page
// is open, but a copy of the browser's storage carries no usable key. It is not stored as a CryptoKey: WebKit (Safari,
// every iPhone browser, a home-screen app) writes a record holding an X25519 CryptoKey without an error and reads it
// back as null, so a phone paired there lost its pairing on every reload. A save is checked by reading it back.
import type { KeyPair } from '../src/mobile-relay/e2e';
import type { RelaySession } from './relay-client';

const DB = 'botling-relay', STORE = 'session', KEY = 'current', SESSION_KEY = 'session-key';
const WRAP_AAD = new TextEncoder().encode('botling-relay-key/v1');
let memory: RelaySession | null = null;
/** The wrapped form of each private key this page wrapped or unwrapped (a renewal saves a non-extractable key again). */
const wrappedOf = new WeakMap<CryptoKey, SealedKey>();

export interface SealedKey { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }
/** The record as stored: the session with its private key wrapped. */
interface StoredSession extends Omit<RelaySession, 'keys'> { keys: { publicKey: Uint8Array; sealed: SealedKey } }

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    try {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}
function run<T>(db: IDBDatabase, mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise(resolve => {
    try {
      const request = body(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

export function makeWrapKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']) as Promise<CryptoKey>;
}
/** Wraps an extractable private key (the one made when pairing) for storage. */
export async function wrapPrivateKey(wrapKey: CryptoKey, privateKey: CryptoKey): Promise<SealedKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.wrapKey('pkcs8', privateKey, wrapKey, { name: 'AES-GCM', iv, additionalData: WRAP_AAD });
  return { iv, data };
}
/** The stored private key, unwrapped as a non-extractable key, or null (another key, or tampered). */
export async function unwrapPrivateKey(wrapKey: CryptoKey, sealed: SealedKey): Promise<CryptoKey | null> {
  try {
    const key = await crypto.subtle.unwrapKey('pkcs8', sealed.data, wrapKey, { name: 'AES-GCM', iv: sealed.iv, additionalData: WRAP_AAD },
      { name: 'X25519' }, false, ['deriveBits']);
    wrappedOf.set(key, sealed);
    return key;
  } catch { return null; }
}

/** This origin's wrapping key, made (and stored) the first time; null when it cannot be stored. */
async function wrapKeyOf(db: IDBDatabase, create: boolean): Promise<CryptoKey | null> {
  const kept = await run<CryptoKey | undefined>(db, 'readonly', store => store.get(SESSION_KEY));
  if (kept instanceof CryptoKey || !create) return kept instanceof CryptoKey ? kept : null;
  const key = await makeWrapKey();
  if (await run(db, 'readwrite', store => store.put(key, SESSION_KEY)) === null) return null;
  const back = await run<CryptoKey | undefined>(db, 'readonly', store => store.get(SESSION_KEY));
  return back instanceof CryptoKey ? back : null;
}

/** The usable session in a stored record, or null. A record from before wrapping (a CryptoKey stored as is) is read
 * as it was, where the browser kept it. */
async function revive(db: IDBDatabase, value: unknown): Promise<RelaySession | null> {
  const v = value as Partial<StoredSession> & { keys?: Partial<KeyPair> & { sealed?: SealedKey } } | null | undefined;
  if (!v || typeof v !== 'object' || !v.keys || !(v.keys.publicKey instanceof Uint8Array) || typeof v.deviceId !== 'string' || typeof v.token !== 'string'
    || typeof v.ws !== 'string' || typeof v.room !== 'string' || typeof v.deskKey !== 'string' || !(typeof v.expiresAt === 'number' && v.expiresAt > Date.now())) return null;
  let privateKey: CryptoKey | null = null;
  if (v.keys.sealed?.iv && v.keys.sealed.data) {
    const wrapKey = await wrapKeyOf(db, false);
    privateKey = wrapKey && await unwrapPrivateKey(wrapKey, v.keys.sealed);
  } else if (v.keys.privateKey instanceof CryptoKey) privateKey = v.keys.privateKey;
  if (!privateKey) return null;
  return { ws: v.ws, room: v.room, deskKey: v.deskKey, deviceId: v.deviceId, token: v.token, coreId: v.coreId ?? '', botIds: Array.isArray(v.botIds) ? v.botIds : [],
    expiresAt: v.expiresAt, keys: { privateKey, publicKey: v.keys.publicKey } };
}

/** Keeps the pairing, and says whether it was kept: false when this browser cannot store it (a private tab, storage
 * turned off) or does not give it back. The pairing then lasts only while this page is open. */
export async function saveRelaySession(session: RelaySession): Promise<boolean> {
  memory = session;
  const db = await open();
  if (!db) return false;
  try {
    const { privateKey, publicKey } = session.keys;
    let sealed = wrappedOf.get(privateKey) ?? null;
    if (!sealed && privateKey.extractable) {
      const wrapKey = await wrapKeyOf(db, true);
      if (wrapKey) { sealed = await wrapPrivateKey(wrapKey, privateKey); wrappedOf.set(privateKey, sealed); }
    }
    if (!sealed) {
      // A key this page did not wrap (a renewal of a session loaded from before wrapping): the stored copy of the same
      // phone keeps its wrapped key.
      const stored = await run<Partial<StoredSession> | undefined>(db, 'readonly', store => store.get(KEY));
      if (stored?.deviceId === session.deviceId && stored.keys?.sealed) sealed = stored.keys.sealed;
    }
    const record: StoredSession | RelaySession = sealed ? { ...session, keys: { publicKey, sealed } } : session;
    if (await run(db, 'readwrite', store => store.put(record, KEY)) === null) return false;
    // Read it back: a browser may take a record it cannot give back (WebKit and an X25519 CryptoKey).
    const back = await revive(db, await run(db, 'readonly', store => store.get(KEY)));
    return back !== null && back.deviceId === session.deviceId;
  } catch { return false; } finally { db.close(); }
}
export async function loadRelaySession(): Promise<RelaySession | null> {
  const db = await open();
  if (!db) return memory;
  try {
    const value = await revive(db, await run(db, 'readonly', store => store.get(KEY)));
    return value ?? memory;
  } catch { return memory; } finally { db.close(); }
}
export async function forgetRelaySession(): Promise<void> {
  memory = null;
  const db = await open();
  if (!db) return;
  await run(db, 'readwrite', store => store.delete(KEY));
  db.close();
}

// ---- The bridge's sign-in (an access token over HTTPS), kept the same way so a phone opened again (a new tab, the
// home-screen app, a tab the system discarded) does not need a new code. The token is stored only encrypted, under a
// non-extractable AES-GCM key in this origin's key store: a script on this page can use it while the page is open,
// but a copy of the browser's storage carries no usable token. The desktop's expiry and revocation stay the authority:
// a token it no longer accepts (401) is forgotten.

/** What the phone keeps to sign in to the bridge again: the token and the core and origin it belongs to. */
export interface BridgeLogin { token: string; coreId?: string; origin: string }
export interface SealedLogin { iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }
const BRIDGE = 'bridge', BRIDGE_KEY = 'bridge-key';

export function makeLoginKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}
export async function sealLogin(key: CryptoKey, login: BridgeLogin): Promise<SealedLogin> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('botling-bridge-login/v1') }, key, new TextEncoder().encode(JSON.stringify(login)));
  return { iv, data };
}
export async function openLogin(key: CryptoKey, sealed: SealedLogin): Promise<BridgeLogin | null> {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv, additionalData: new TextEncoder().encode('botling-bridge-login/v1') }, key, sealed.data);
    const value = JSON.parse(new TextDecoder().decode(plain));
    if (!value || typeof value.token !== 'string' || typeof value.origin !== 'string' || (value.coreId !== undefined && typeof value.coreId !== 'string')) return null;
    return { token: value.token, origin: value.origin, ...(value.coreId ? { coreId: value.coreId } : {}) };
  } catch { return null; }
}

/** Keeps the bridge sign-in; false when this browser cannot store it (private mode): it then lasts only for this page. */
export async function saveBridgeLogin(login: BridgeLogin): Promise<boolean> {
  const db = await open();
  if (!db) return false;
  try {
    let key = await run<CryptoKey | undefined>(db, 'readonly', store => store.get(BRIDGE_KEY));
    if (!(key instanceof CryptoKey)) {
      key = await makeLoginKey();
      if (await run(db, 'readwrite', store => store.put(key, BRIDGE_KEY)) === null) return false;
    }
    const sealed = await sealLogin(key, login);
    return await run(db, 'readwrite', store => store.put(sealed, BRIDGE)) !== null;
  } catch { return false; } finally { db.close(); }
}
/** The kept bridge sign-in for this page's origin, or null. */
export async function loadBridgeLogin(origin: string): Promise<BridgeLogin | null> {
  const db = await open();
  if (!db) return null;
  try {
    const key = await run<CryptoKey | undefined>(db, 'readonly', store => store.get(BRIDGE_KEY));
    const sealed = await run<SealedLogin | undefined>(db, 'readonly', store => store.get(BRIDGE));
    if (!(key instanceof CryptoKey) || !sealed?.iv || !sealed.data) return null;
    const login = await openLogin(key, sealed);
    return login && login.origin === origin ? login : null;
  } catch { return null; } finally { db.close(); }
}
export async function forgetBridgeLogin(): Promise<void> {
  const db = await open();
  if (!db) return;
  await run(db, 'readwrite', store => store.delete(BRIDGE));
  db.close();
}
