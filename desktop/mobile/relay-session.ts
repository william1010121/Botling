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
