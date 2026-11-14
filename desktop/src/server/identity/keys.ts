// The server's identity (protocol v1 §3): an Ed25519 signing key and an X25519 key, made on the first start and kept
// in `<data>/server-keys.json` (mode 0600, the data folder itself is 0700). `serverId` (the member id the roster names
// it by) = the first 26 characters of the lower-case base32 SHA-256 of the raw signing public key.
//
// - WebCrypto only (`globalThis.crypto.subtle`, Node 24): no dependency. Keychain sealing stays optional (not in M2).
// - The private keys are imported back as non-extractable CryptoKeys; nothing here logs or returns their bytes.
// - The file is written once (temp file + fsync + rename), never rewritten. A file that does not parse, or whose
//   public keys do not belong to its private keys, stops the start: a new identity would be a different server.
// - `server.db` remembers the member id (`meta.memberId`, `bindServerIdentity`), so a lost or swapped keys file is
//   refused instead of silently starting as another member.
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { fromBase64Url, memberIdFromKey, toBase64Url } from "../../protocol";
import type { Db } from "../store";

export const KEYS_FILE = "server-keys.json";

/** The server's own keys. `memberId` is its `serverId` in the roster (§3). */
export interface ServerIdentity {
  readonly memberId: string;
  /** Both public keys as base64url (the roster's `MemberKeys`). */
  readonly keys: { readonly sign: string; readonly dh: string };
  readonly signPub: Uint8Array;
  readonly dhPub: Uint8Array;
  /** Non-extractable private keys (the session layer derives with `dhKey`, M2 step 3). */
  readonly signKey: CryptoKey;
  readonly dhKey: CryptoKey;
  /** Ed25519 signature over `bytes`. */
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

interface KeysFile {
  v: 1;
  sign: { pub: string; pkcs8: string };
  dh: { pub: string; pkcs8: string };
}

export class ServerIdentityError extends Error {
  constructor(message: string) { super(message); this.name = "ServerIdentityError"; }
}

const subtle = () => globalThis.crypto.subtle;
const ED25519 = { name: "Ed25519" } as const;
const X25519 = { name: "X25519" } as const;
const buf = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;

export function keysFilePath(dataDir: string): string {
  return join(dataDir, KEYS_FILE);
}

/** Makes a new pair of keys in memory (not written). */
async function generateKeysFile(): Promise<KeysFile> {
  const sign = await subtle().generateKey(ED25519, true, ["sign", "verify"]) as CryptoKeyPair;
  const dh = await subtle().generateKey(X25519, true, ["deriveBits"]) as CryptoKeyPair;
  const part = async (pair: CryptoKeyPair) => ({
    pub: toBase64Url(new Uint8Array(await subtle().exportKey("raw", pair.publicKey))),
    pkcs8: toBase64Url(new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey))),
  });
  return { v: 1, sign: await part(sign), dh: await part(dh) };
}

/** Writes the file with mode 0600 through a temp file, fsync and rename, so a crash leaves either nothing or all. */
function writeKeysFile(file: string, keys: KeysFile): void {
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(keys)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  try {
    const dir = openSync(dirname(file), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* directory fsync is best effort (not every platform allows it) */ }
}

function parseKeysFile(text: string): KeysFile {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ServerIdentityError(`${KEYS_FILE} is not valid JSON`); }
  const file = value as Partial<KeysFile> | null;
  const ok = (part: unknown): part is { pub: string; pkcs8: string } =>
    !!part && typeof (part as { pub?: unknown }).pub === "string" && typeof (part as { pkcs8?: unknown }).pkcs8 === "string";
  if (!file || file.v !== 1 || !ok(file.sign) || !ok(file.dh)) throw new ServerIdentityError(`${KEYS_FILE} has an unknown format`);
  return file as KeysFile;
}

/**
 * Imports one private key: once extractable to read its public half from the JWK and compare it with the stored
 * public key, then again non-extractable for use.
 */
async function importPrivate(part: { pub: string; pkcs8: string }, algorithm: typeof ED25519 | typeof X25519, usages: KeyUsage[], label: string): Promise<{ key: CryptoKey; pub: Uint8Array }> {
  const pkcs8 = fromBase64Url(part.pkcs8);
  const pub = fromBase64Url(part.pub);
  if (!pkcs8 || !pub || pub.length !== 32) throw new ServerIdentityError(`${KEYS_FILE}: the ${label} key is damaged`);
  let derived: string | undefined;
  try {
    const probe = await subtle().importKey("pkcs8", buf(pkcs8), algorithm, true, usages);
    derived = (await subtle().exportKey("jwk", probe)).x;
  } catch {
    throw new ServerIdentityError(`${KEYS_FILE}: the ${label} key is damaged`);
  }
  if (derived !== part.pub) throw new ServerIdentityError(`${KEYS_FILE}: the ${label} public key does not belong to its private key`);
  const key = await subtle().importKey("pkcs8", buf(pkcs8), algorithm, false, usages);
  return { key, pub };
}

async function identityFrom(file: KeysFile): Promise<ServerIdentity> {
  const sign = await importPrivate(file.sign, ED25519, ["sign"], "signing");
  const dh = await importPrivate(file.dh, X25519, ["deriveBits"], "X25519");
  const memberId = await memberIdFromKey(sign.pub);
  return {
    memberId,
    keys: { sign: file.sign.pub, dh: file.dh.pub },
    signPub: sign.pub,
    dhPub: dh.pub,
    signKey: sign.key,
    dhKey: dh.key,
    sign: async (bytes) => new Uint8Array(await subtle().sign(ED25519, sign.key, buf(bytes))),
  };
}

export interface LoadIdentityOptions {
  /** False: refuse instead of making keys when the file is missing (server.db already names a member). */
  create?: boolean;
}

/**
 * The data folder's identity: read from `server-keys.json`, or made and written there on the first start. A file
 * readable by others is tightened to 0600 before it is read.
 */
export async function loadOrCreateServerIdentity(dataDir: string, options: LoadIdentityOptions = {}): Promise<ServerIdentity & { created: boolean }> {
  const file = keysFilePath(dataDir);
  if (!existsSync(file)) {
    if (options.create === false) throw new ServerIdentityError(`${KEYS_FILE} is missing, but server.db belongs to an existing server; restore the file from a backup of this data folder`);
    const keys = await generateKeysFile();
    writeKeysFile(file, keys);
    return { ...(await identityFrom(keys)), created: true };
  }
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  return { ...(await identityFrom(parseKeysFile(readFileSync(file, "utf8")))), created: false };
}

/**
 * Ties server.db to the identity (one writer transaction, before anything else uses `meta.serverId`):
 * - `meta.memberId`, `meta.signPub`, `meta.dhPub` (public keys only) are written on the first bind; a later bind with
 *   another member id is refused (the keys file was swapped or lost).
 * - `meta.serverId`, the id this server's streams and references are named by, becomes the member id while server.db
 *   has no stream yet (a fresh data folder). An M1 data folder keeps its earlier id there; the roster then names the
 *   server by `memberId`.
 */
export function bindServerIdentity(tx: Db, identity: Pick<ServerIdentity, "memberId" | "keys">): { serverId: string; memberId: string } {
  const meta = (key: string) => {
    const row = tx.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row ? String(row.value) : undefined;
  };
  const put = tx.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const known = meta("memberId");
  if (known !== undefined && known !== identity.memberId) {
    throw new ServerIdentityError(`${KEYS_FILE} belongs to another server than server.db; restore the keys file of this data folder`);
  }
  if (known === undefined) {
    put.run("memberId", identity.memberId);
    put.run("signPub", identity.keys.sign);
    put.run("dhPub", identity.keys.dh);
  }
  let serverId = meta("serverId");
  if (serverId !== identity.memberId && !tx.prepare("SELECT 1 FROM streams LIMIT 1").get()) {
    put.run("serverId", identity.memberId);
    serverId = identity.memberId;
  }
  if (!serverId) throw new ServerIdentityError("server.db has no serverId");
  return { serverId, memberId: identity.memberId };
}

/** The member id server.db was bound to, if any (a reader is enough). */
export function boundMemberId(db: Db): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'memberId'").get();
  return row ? String(row.value) : undefined;
}
