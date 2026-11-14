// This device's membership (protocol v1 §3, §4.4): its keys, its server and its Add, kept in IndexedDB
// `botling3-device` (D32: every Botling 3 storage name starts with `botling3-`). The private keys are WebCrypto keys
// made non-extractable: no key bytes are ever readable by script. The Ed25519 key is stored as a CryptoKey (structured
// clone). WebKit reads a stored X25519 CryptoKey back as null (seen in headless WebKit, step 8), so that key is kept
// sealed instead: its PKCS#8 encrypted with AES-GCM under a non-extractable AES key stored beside it, and imported
// non-extractable on load. Script on this origin can use the AES key but never read it, as with the CryptoKeys.
import { IDB_PREFIX } from "../../src/fe-link/idb-storage";
import { importDhKeyPair } from "../../src/session";

export const DEVICE_DB = `${IDB_PREFIX}device`;
const STORE = "device";
const KEY = "self";

export interface DeviceRecord {
  v: 1;
  memberId: string;
  name: string;
  /** Ed25519 pair (private non-extractable) and the public key as base64url. */
  signKey: CryptoKey;
  signPub: string;
  /** X25519 pair (private non-extractable) and the raw public key. */
  dhKey: CryptoKey;
  dhPub: Uint8Array;
  cluster: string;
  server: { memberId: string; name: string; dhPub: Uint8Array };
  addId: string;
  scope: string[];
  pairedAt: number;
}

/** The record as stored: the X25519 key sealed (see above). */
interface StoredRecord extends Omit<DeviceRecord, "dhKey"> { dhSeal: { key: CryptoKey; iv: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer> } }

function open(factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DEVICE_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("device store: open failed"));
    req.onblocked = () => reject(new Error("device store: blocked by another tab"));
  });
}

export async function loadDevice(): Promise<DeviceRecord | null> {
  const db = await open();
  try {
    const stored = await new Promise<StoredRecord | null>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as StoredRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    if (!stored) return null;
    if (!stored.signKey || !stored.dhSeal?.key) throw new Error("device store: this browser could not read the stored keys back");
    const { dhSeal, ...rest } = stored;
    const pkcs8 = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: dhSeal.iv }, dhSeal.key, dhSeal.data));
    try {
      const dh = await importDhKeyPair(pkcs8);
      return { ...rest, dhKey: dh.privateKey };
    } finally { pkcs8.fill(0); }
  } finally { db.close(); }
}

/** Resolves once the record is durable (`complete` of a strict-durability transaction), before the ack is sent. */
export async function saveDevice(record: DeviceRecord, dhPkcs8: Uint8Array): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(dhPkcs8)));
  const { dhKey: _inUse, ...rest } = record;
  const stored: StoredRecord = { ...rest, dhSeal: { key, iv, data } };
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = (db.transaction as (names: string, mode: IDBTransactionMode, options?: { durability?: string }) => IDBTransaction)
        .call(db, STORE, "readwrite", { durability: "strict" });
      tx.objectStore(STORE).put(stored, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("device store: write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("device store: write aborted"));
    });
  } finally { db.close(); }
}

/** A small setting of this device (the player's choice, step 11), kept beside the record; gone with the device. */
export async function loadPref(name: string): Promise<string | null> {
  const db = await open();
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(`pref:${name}`);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

export async function savePref(name: string, value: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, `pref:${name}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("device store: write failed"));
    });
  } finally { db.close(); }
}

/** Forgets this device (sign-out / "pair again"): the membership and the front-end storage. */
export async function forgetDevice(other: string[] = []): Promise<void> {
  for (const name of [DEVICE_DB, ...other]) {
    if (!name.startsWith(IDB_PREFIX)) throw new Error(`refusing to delete ${name}`);
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }
}
