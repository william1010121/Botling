// This device's membership (protocol v1 §3, §4.4): its keys, its server and its Add, kept in IndexedDB
// `botling3-device` (D32: every Botling 3 storage name starts with `botling3-`). The private keys are WebCrypto keys
// made non-extractable: no key bytes are ever readable by script. The Ed25519 key is stored as a CryptoKey (structured
// clone). WebKit reads a stored X25519 CryptoKey back as null (seen in headless WebKit, step 8), so that key is kept
// sealed instead: its PKCS#8 encrypted with AES-GCM under a non-extractable AES key stored beside it, and imported
// non-extractable on load. Script on this origin can use the AES key but never read it, as with the CryptoKeys.
import { IDB_PREFIX } from "../../src/fe-link/idb-storage";
import { toBase64Url, type ServerAddresses, type ServerState } from "../../src/protocol";
import { importDhKeyPair } from "../../src/session";

export const DEVICE_DB = `${IDB_PREFIX}device`;
export const SHELL_STORAGE_DB = `${IDB_PREFIX}shell-storage`;
const STORE = "device";
const SHELL_STORE = "namespaces";
const KEY = "self";

/** D70: a known cluster server stored on this device (`welcome.servers`, `peer{…}`), merged by id. */
export interface StoredServer {
  id: string;
  name: string;
  dh?: string;
  addresses?: ServerAddresses;
  state?: ServerState;
  since?: number | null;
}

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
  /** The server's room on the relay, from the pairing offer (M2 step 13), when it named one. */
  relay?: { url: string; room: string };
  /** D70: every cluster server this device has learned, merged by id (absent on M2/M3 records). */
  servers?: StoredServer[];
}

/** The record as stored: the X25519 key sealed (see above). */
interface StoredRecord extends Omit<DeviceRecord, "dhKey"> { dhSeal: { key: CryptoKey; iv: Uint8Array<ArrayBuffer>; data: Uint8Array<ArrayBuffer> } }

function cleanAddresses(addresses?: ServerAddresses): ServerAddresses | undefined {
  if (!addresses) return undefined;
  const out: ServerAddresses = {};
  if (addresses.tailnet) out.tailnet = addresses.tailnet;
  if (addresses.relay) out.relay = { url: addresses.relay.url, room: addresses.relay.room };
  return out.tailnet || out.relay ? out : undefined;
}

function legacyServer(record: Pick<DeviceRecord, "server" | "relay">): StoredServer {
  const dh = record.server.dhPub instanceof Uint8Array ? toBase64Url(record.server.dhPub) : undefined;
  const addresses = record.relay ? { relay: { url: record.relay.url, room: record.relay.room } } : undefined;
  return {
    id: record.server.memberId,
    name: record.server.name,
    ...(dh ? { dh } : {}),
    ...(addresses ? { addresses } : {}),
  };
}

/** D70: merges incoming server views (`welcome.servers` / `peer`) into `current` by id; `gone` clears addresses. */
export function mergeServers(current: readonly StoredServer[] | undefined, updates: readonly StoredServer[]): StoredServer[] {
  const byId = new Map<string, StoredServer>();
  for (const entry of current ?? []) {
    if (!entry || typeof entry.id !== "string") continue;
    if (entry.state === "gone") {
      byId.set(entry.id, {
        id: entry.id,
        name: entry.name || entry.id,
        ...(entry.dh ? { dh: entry.dh } : {}),
        state: "gone",
        ...(entry.since !== undefined ? { since: entry.since } : {}),
      });
    } else {
      const addresses = cleanAddresses(entry.addresses);
      byId.set(entry.id, {
        id: entry.id,
        name: entry.name || entry.id,
        ...(entry.dh ? { dh: entry.dh } : {}),
        ...(addresses ? { addresses } : {}),
        ...(entry.state !== undefined ? { state: entry.state } : {}),
        ...(entry.since !== undefined ? { since: entry.since } : {}),
      });
    }
  }
  for (const next of updates) {
    const prev = byId.get(next.id);
    const dh = next.dh ?? prev?.dh;
    const name = next.name || prev?.name || next.id;
    if (prev?.state === "gone" || next.state === "gone") {
      // D70: a revoked server stays permanently `gone` with no addresses.
      const since = prev?.state === "gone"
        ? (prev.since !== undefined ? prev.since : next.since)
        : (next.since !== undefined ? next.since : prev?.since);
      byId.set(next.id, {
        id: next.id,
        name,
        ...(dh ? { dh } : {}),
        state: "gone",
        ...(since !== undefined ? { since } : {}),
      });
      continue;
    }
    const addresses = next.addresses !== undefined ? cleanAddresses(next.addresses) : prev?.addresses;
    byId.set(next.id, {
      id: next.id,
      name,
      ...(dh ? { dh } : {}),
      ...(addresses ? { addresses } : {}),
      ...(next.state !== undefined ? { state: next.state } : prev?.state !== undefined ? { state: prev.state } : {}),
      ...(next.since !== undefined ? { since: next.since } : prev?.since !== undefined ? { since: prev.since } : {}),
    });
  }
  return [...byId.values()];
}

function open(factory: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
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

export async function loadDevice(factory: IDBFactory = globalThis.indexedDB): Promise<DeviceRecord | null> {
  const db = await open(factory);
  try {
    const stored = await new Promise<StoredRecord | null>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as StoredRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
    if (!stored) return null;
    if (!stored.signKey || !stored.dhSeal?.key) throw new Error("device store: this browser could not read the stored keys back");
    const { dhSeal, ...rest } = stored;
    const servers = Array.isArray(rest.servers) ? rest.servers : [legacyServer(rest)];
    const pkcs8 = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: dhSeal.iv }, dhSeal.key, dhSeal.data));
    try {
      const dh = await importDhKeyPair(pkcs8);
      return { ...rest, servers, dhKey: dh.privateKey };
    } finally { pkcs8.fill(0); }
  } finally { db.close(); }
}

/** Resolves once the record is durable (`complete` of a strict-durability transaction), before the ack is sent. */
export async function saveDevice(record: DeviceRecord, dhPkcs8: Uint8Array, factory: IDBFactory = globalThis.indexedDB): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new Uint8Array(dhPkcs8)));
  const { dhKey: _inUse, ...rest } = record;
  const stored: StoredRecord = { ...rest, servers: rest.servers ?? [legacyServer(rest)], dhSeal: { key, iv, data } };
  const db = await open(factory);
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

/** D70: merges `updates` into the stored device record's `servers[]` by id in one strict-durability transaction. */
export async function saveDeviceServers(updates: readonly StoredServer[], factory: IDBFactory = globalThis.indexedDB): Promise<StoredServer[] | null> {
  const db = await open(factory);
  try {
    return await new Promise<StoredServer[] | null>((resolve, reject) => {
      const tx = (db.transaction as (names: string, mode: IDBTransactionMode, options?: { durability?: string }) => IDBTransaction)
        .call(db, STORE, "readwrite", { durability: "strict" });
      const store = tx.objectStore(STORE);
      const getReq = store.get(KEY);
      let nextServers: StoredServer[] | null = null;
      getReq.onsuccess = () => {
        const stored = (getReq.result as StoredRecord | undefined) ?? null;
        if (!stored) return;
        const base = Array.isArray(stored.servers) ? stored.servers : [legacyServer(stored)];
        nextServers = mergeServers(base, updates);
        store.put({ ...stored, servers: nextServers }, KEY);
      };
      getReq.onerror = () => reject(getReq.error ?? new Error("device store: read failed"));
      tx.oncomplete = () => resolve(nextServers);
      tx.onerror = () => reject(tx.error ?? new Error("device store: write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("device store: write aborted"));
    });
  } finally { db.close(); }
}

/** A small setting of this device (the player's choice, step 11), kept beside the record; gone with the device. */
export async function loadPref(name: string, factory: IDBFactory = globalThis.indexedDB): Promise<string | null> {
  const db = await open(factory);
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(`pref:${name}`);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

export async function savePref(name: string, value: string, factory: IDBFactory = globalThis.indexedDB): Promise<void> {
  const db = await open(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, `pref:${name}`);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("device store: write failed"));
    });
  } finally { db.close(); }
}

function openShellStorage(factory: IDBFactory = globalThis.indexedDB): Promise<IDBDatabase> {
  if (!factory) return Promise.reject(new Error("shell storage: IndexedDB is not available"));
  return new Promise((resolve, reject) => {
    const req = factory.open(SHELL_STORAGE_DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(SHELL_STORE)) req.result.createObjectStore(SHELL_STORE); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error("shell storage: open failed"));
    req.onblocked = () => reject(new Error("shell storage: blocked by another tab"));
  });
}

export async function loadShellStorageNamespace(namespace: string, factory: IDBFactory = globalThis.indexedDB): Promise<string | null> {
  const db = await openShellStorage(factory);
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const req = db.transaction(SHELL_STORE, "readonly").objectStore(SHELL_STORE).get(namespace);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => reject(req.error ?? new Error("shell storage: read failed"));
    });
  } finally { db.close(); }
}

export async function saveShellStorageNamespace(namespace: string, json: string | null, factory: IDBFactory = globalThis.indexedDB): Promise<void> {
  const db = await openShellStorage(factory);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SHELL_STORE, "readwrite");
      const store = tx.objectStore(SHELL_STORE);
      if (json === null) store.delete(namespace);
      else store.put(json, namespace);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("shell storage: write failed"));
      tx.onabort = () => reject(tx.error ?? new Error("shell storage: write aborted"));
    });
  } finally { db.close(); }
}

export function createWebShellStorageBackend(factory?: IDBFactory) {
  return {
    load: (namespace: string) => loadShellStorageNamespace(namespace, factory),
    save: (namespace: string, json: string | null) => saveShellStorageNamespace(namespace, json, factory),
  };
}

/** Forgets this device (sign-out / "pair again"): the membership and the front-end storage. */
export async function forgetDevice(other: string[] = [], factory: IDBFactory = globalThis.indexedDB): Promise<void> {
  for (const name of [...new Set([DEVICE_DB, SHELL_STORAGE_DB, ...other])]) {
    if (!name.startsWith(IDB_PREFIX)) throw new Error(`refusing to delete ${name}`);
    await new Promise<void>((resolve) => {
      const req = factory.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }
}
