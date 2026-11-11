// The phone's relay pairing, kept so the phone does not need a new code every time the page opens. It lives in this
// origin's IndexedDB. The private key is a non-extractable CryptoKey: a script on this page can use it while the page
// is open, but cannot read it out. Nothing of any chat is stored. Sign out (or a revocation) deletes the record.
import type { RelaySession } from './relay-client';

const DB = 'botling-relay', STORE = 'session', KEY = 'current';
let memory: RelaySession | null = null;

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

/** Keeps the pairing; false when this browser cannot store it (private mode): it then lasts only for this page. */
export async function saveRelaySession(session: RelaySession): Promise<boolean> {
  memory = session;
  const db = await open();
  if (!db) return false;
  const saved = await run(db, 'readwrite', store => store.put(session, KEY));
  db.close();
  return saved !== null;
}
export async function loadRelaySession(): Promise<RelaySession | null> {
  const db = await open();
  if (!db) return memory;
  const value = await run<RelaySession | undefined>(db, 'readonly', store => store.get(KEY));
  db.close();
  if (!value || typeof value !== 'object' || !value.keys?.privateKey || !(value.expiresAt > Date.now())) return memory;
  return value;
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
