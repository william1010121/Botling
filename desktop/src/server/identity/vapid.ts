// The cluster's Web Push key pair (protocol v1 §18.4, m3-brief Q4, Q-P3, M4-26): one P-256 pair for the whole
// cluster, made once by the first server that needs it (at its first server pairing) and handed to every joining
// server inside the encrypted pairing session (`join.welcome.vapid`). After a server revocation or a root change,
// the current revocation root mints a new pair ordered by `(gen, id)` covering `view.revoked ∩ view.servers`, and
// distributes `vapid.key{gen, id, pub, priv}` over full peer sessions to valid servers; each server keeps the pair
// with the highest `(gen, id)`. Kept in `<data>/vapid-keys.json`, mode 0600, symlink-safely read and atomically
// written (temp + O_NOFOLLOW + fsync + rename); nothing here logs keys.
import { createECDH, generateKeyPairSync, timingSafeEqual } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  compareVapidKeyId, fromBase64Url, MemberId, toBase64Url, VapidKeyCounter, VapidKeyGen, VapidKeys,
  type VapidKeyId,
} from "../../protocol";

export const VAPID_FILE = "vapid-keys.json";

const CoversSchema = z.array(MemberId).max(256);

export interface VapidKeyRecord {
  gen: number;
  id: number;
  covers: string[];
  keys: VapidKeys;
}

export type AcceptVapidResult =
  | { accepted: true; record: VapidKeyRecord }
  | { accepted: false; reason: "malformed" | "mismatch" | "stale"; record: VapidKeyRecord | null };

export function vapidFilePath(dataDir: string): string { return join(dataDir, VAPID_FILE); }

let tempSeq = 0;

function normalizeCovers(covers: readonly string[]): string[] {
  const parsed = CoversSchema.parse([...covers]);
  return [...new Set(parsed)].sort();
}

/** Sorted member ids of revoked servers in the cluster roster view (`view.revoked ∩ view.servers`). */
export function revokedServerIds(view: { readonly servers: ReadonlySet<string>; readonly revoked: ReadonlySet<string> }): string[] {
  return [...view.revoked].filter((id) => view.servers.has(id)).sort();
}

/** Verifies that `privateKey` is a valid P-256 scalar whose uncompressed public point matches `publicKey`. */
export function vapidKeyPairMatches(publicKey: string, privateKey: string): boolean {
  const pubBytes = fromBase64Url(publicKey);
  const privBytes = fromBase64Url(privateKey);
  if (!pubBytes || pubBytes.length !== 65 || pubBytes[0] !== 4 || !privBytes || privBytes.length !== 32) return false;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(privBytes);
    const derived = ecdh.getPublicKey(undefined, "uncompressed");
    return derived.length === pubBytes.length && timingSafeEqual(derived, pubBytes);
  } catch {
    return false;
  }
}

/**
 * The cluster VAPID key record (`{ gen, id, covers, keys }`) this data folder holds, or null (none yet, symlink,
 * or malformed). Pre-M4-26 files without `gen`/`id`/`covers` read as `{ gen: 0, id: 0, covers: [] }`.
 */
export function readVapidKeyRecord(dataDir: string): VapidKeyRecord | null {
  const file = vapidFilePath(dataDir);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
    const value = JSON.parse(readFileSync(fd, "utf8")) as {
      v?: unknown;
      gen?: unknown;
      id?: unknown;
      covers?: unknown;
      publicKey?: unknown;
      privateKey?: unknown;
    };
    if (value?.v !== 1) return null;
    let gen = 0;
    if (value.gen !== undefined) {
      const parsedGen = VapidKeyGen.safeParse(value.gen);
      if (!parsedGen.success) return null;
      gen = parsedGen.data;
    }
    let id = 0;
    if (value.id !== undefined) {
      const parsedId = VapidKeyCounter.safeParse(value.id);
      if (!parsedId.success) return null;
      id = parsedId.data;
    }
    let covers: string[] = [];
    if (value.covers !== undefined) {
      const parsedCovers = CoversSchema.safeParse(value.covers);
      if (!parsedCovers.success) return null;
      covers = [...new Set(parsedCovers.data)].sort();
    }
    const parsedKeys = VapidKeys.safeParse({ publicKey: value.publicKey, privateKey: value.privateKey });
    if (!parsedKeys.success) return null;
    return { gen, id, covers, keys: parsedKeys.data };
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** The cluster VAPID keys this data folder holds, or null (none yet, or a file that does not parse). */
export function readVapidKeys(dataDir: string): VapidKeys | null {
  return readVapidKeyRecord(dataDir)?.keys ?? null;
}

/** Atomically writes `{ v: 1, gen, id, covers, publicKey, privateKey }` (0600, O_NOFOLLOW + dev:ino + fsync + rename). */
export function writeVapidKeyRecord(dataDir: string, record: VapidKeyRecord): void {
  const checkedGen = VapidKeyGen.parse(record.gen);
  const checkedId = VapidKeyCounter.parse(record.id);
  const checkedCovers = normalizeCovers(record.covers);
  const checkedKeys = VapidKeys.parse(record.keys);
  const file = vapidFilePath(dataDir);
  const temp = `${file}.${process.pid}.${++tempSeq}.tmp`;
  const fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const lst = lstatSync(temp);
    const fst = fstatSync(fd);
    if (!lst.isFile() || !fst.isFile() || lst.dev !== fst.dev || lst.ino !== fst.ino) {
      throw new Error("vapid: staged file is not a regular file");
    }
    writeSync(fd, `${JSON.stringify({ v: 1, gen: checkedGen, id: checkedId, covers: checkedCovers, ...checkedKeys })}\n`);
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
    closeSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    try { rmSync(temp, { force: true }); } catch { /* ignore */ }
    throw error;
  }
}

export interface WriteVapidOptions {
  gen?: number;
  id?: number;
  covers?: readonly string[];
}

/** Writes the keys (0600, temp file + fsync + rename): the joining server takes the cluster's pair. */
export function writeVapidKeys(dataDir: string, keys: VapidKeys, options: number | WriteVapidOptions = {}): void {
  const opts = typeof options === "number" ? { gen: 0, id: options, covers: [] } : options;
  writeVapidKeyRecord(dataDir, {
    gen: opts.gen ?? 1,
    id: opts.id ?? 0,
    covers: normalizeCovers(opts.covers ?? []),
    keys,
  });
}

/** Synchronous fresh P-256 pair: uncompressed public point (65 bytes) and private scalar (32 bytes), base64url. */
export function generateVapidKeysSync(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pubJwk = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  const privJwk = privateKey.export({ format: "jwk" }) as { d?: string };
  const x = pubJwk.x ? fromBase64Url(pubJwk.x) : null;
  const y = pubJwk.y ? fromBase64Url(pubJwk.y) : null;
  if (!x || x.length !== 32 || !y || y.length !== 32 || !privJwk.d) {
    throw new Error("vapid: failed to export generated P-256 key pair");
  }
  const uncompressed = new Uint8Array(65);
  uncompressed[0] = 0x04;
  uncompressed.set(x, 1);
  uncompressed.set(y, 33);
  return VapidKeys.parse({ publicKey: toBase64Url(uncompressed), privateKey: privJwk.d });
}

/** A fresh P-256 pair: the public key uncompressed (65 bytes), the private scalar (32 bytes), both base64url. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  return generateVapidKeysSync();
}

/**
 * Mints a fresh cluster VAPID key pair for `gen` (`id = current.gen === gen ? current.id + 1 : 1`), recording the
 * revoked servers `covers` it excludes, and stores it atomically. Refuses to move backwards in `gen`.
 */
export function rotateVapidKeys(
  dataDir: string,
  options: { gen?: number; covers?: readonly string[] } = {},
): VapidKeyRecord {
  const current = readVapidKeyRecord(dataDir);
  const targetGen = VapidKeyGen.parse(options.gen ?? Math.max(1, current?.gen ?? 1));
  if (targetGen < 1) throw new Error("vapid: rotation root gen must be >= 1");
  if (current && targetGen < current.gen) {
    throw new Error("vapid: cannot rotate to an older root generation");
  }
  const nextId = current && current.gen === targetGen ? current.id + 1 : 1;
  const covers = normalizeCovers(options.covers ?? current?.covers ?? []);
  const keys = generateVapidKeysSync();
  const record: VapidKeyRecord = { gen: targetGen, id: nextId, covers, keys };
  writeVapidKeyRecord(dataDir, record);
  return record;
}

/**
 * Stores a `vapid.key{gen, id, pub, priv}` received from the cluster root only if the pair is valid, matches
 * cryptographically, and has `(gen, id)` strictly higher than the currently stored record.
 */
export function acceptVapidKey(
  dataDir: string,
  input: { gen: number; id: number; pub: string; priv: string; covers?: readonly string[] },
): AcceptVapidResult {
  const parsedGen = VapidKeyGen.safeParse(input.gen);
  const parsedId = VapidKeyCounter.safeParse(input.id);
  const parsedKeys = VapidKeys.safeParse({ publicKey: input.pub, privateKey: input.priv });
  const current = readVapidKeyRecord(dataDir);
  if (!parsedGen.success || !parsedId.success || !parsedKeys.success || parsedGen.data < 1 || parsedId.data < 1) {
    return { accepted: false, reason: "malformed", record: current };
  }
  if (!vapidKeyPairMatches(parsedKeys.data.publicKey, parsedKeys.data.privateKey)) {
    return { accepted: false, reason: "mismatch", record: current };
  }
  const incoming: VapidKeyId = { gen: parsedGen.data, id: parsedId.data };
  if (current !== null && compareVapidKeyId(incoming, { gen: current.gen, id: current.id }) <= 0) {
    return { accepted: false, reason: "stale", record: current };
  }
  const covers = input.covers ? normalizeCovers(input.covers) : [];
  const next: VapidKeyRecord = { gen: incoming.gen, id: incoming.id, covers, keys: parsedKeys.data };
  writeVapidKeyRecord(dataDir, next);
  return { accepted: true, record: next };
}

const making = new Map<string, Promise<{ keys: VapidKeys; created: boolean }>>();

/**
 * The cluster's keys, made and written now when this data folder has none (the root at its first server pairing). Two
 * pairings at once share one making (review J3): otherwise each made its own pair, the second overwrote the first, and
 * the first joining server kept a key the rest of the cluster no longer had.
 */
export async function ensureVapidKeys(
  dataDir: string,
  options: { gen?: number; covers?: readonly string[] } = {},
): Promise<{ keys: VapidKeys; created: boolean }> {
  const known = readVapidKeys(dataDir);
  if (known) return { keys: known, created: false };
  const pending = making.get(dataDir);
  if (pending) return { keys: (await pending).keys, created: false };
  const run = (async () => {
    const keys = generateVapidKeysSync();
    const raced = readVapidKeys(dataDir);
    if (raced) return { keys: raced, created: false };
    writeVapidKeys(dataDir, keys, {
      gen: options.gen ?? 1,
      id: 0,
      covers: options.covers ?? [],
    });
    return { keys, created: true };
  })();
  making.set(dataDir, run);
  try { return await run; } finally { making.delete(dataDir); }
}
