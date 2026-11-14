// The cluster's Web Push key pair (protocol v1 §18.4, m3-brief Q4): one P-256 pair for the whole cluster, made once by
// the first server that needs it (the root, at its first server pairing) and handed to every joining server inside the
// encrypted pairing session (`join.welcome.vapid`). Kept in `<data>/vapid-keys.json`, mode 0600 (the data folder is
// 0700), written once through a temp file, fsync and rename. No push is sent before M4; nothing here logs the key.
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { toBase64Url, VapidKeys } from "../../protocol";

export const VAPID_FILE = "vapid-keys.json";

export function vapidFilePath(dataDir: string): string { return join(dataDir, VAPID_FILE); }

/** The cluster VAPID keys this data folder holds, or null (none yet, or a file that does not parse). */
export function readVapidKeys(dataDir: string): VapidKeys | null {
  const file = vapidFilePath(dataDir);
  if (!existsSync(file)) return null;
  if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; publicKey?: unknown; privateKey?: unknown };
    if (value?.v !== 1) return null;
    const parsed = VapidKeys.safeParse({ publicKey: value.publicKey, privateKey: value.privateKey });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Writes the keys (0600, temp file + fsync + rename): the joining server takes the cluster's pair. */
export function writeVapidKeys(dataDir: string, keys: VapidKeys): void {
  const checked = VapidKeys.parse(keys);
  const file = vapidFilePath(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify({ v: 1, ...checked })}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}

/** A fresh P-256 pair: the public key uncompressed (65 bytes), the private scalar (32 bytes), both base64url. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await globalThis.crypto.subtle.exportKey("jwk", pair.privateKey);
  return VapidKeys.parse({ publicKey: toBase64Url(raw), privateKey: jwk.d });
}

const making = new Map<string, Promise<{ keys: VapidKeys; created: boolean }>>();

/**
 * The cluster's keys, made and written now when this data folder has none (the root at its first server pairing). Two
 * pairings at once share one making (review J3): otherwise each made its own pair, the second overwrote the first, and
 * the first joining server kept a key the rest of the cluster no longer had.
 */
export async function ensureVapidKeys(dataDir: string): Promise<{ keys: VapidKeys; created: boolean }> {
  const known = readVapidKeys(dataDir);
  if (known) return { keys: known, created: false };
  const pending = making.get(dataDir);
  if (pending) return { keys: (await pending).keys, created: false };
  const run = (async () => {
    const keys = await generateVapidKeys();
    const raced = readVapidKeys(dataDir);
    if (raced) return { keys: raced, created: false };
    writeVapidKeys(dataDir, keys);
    return { keys, created: true };
  })();
  making.set(dataDir, run);
  try { return await run; } finally { making.delete(dataDir); }
}
