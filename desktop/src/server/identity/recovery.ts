// The recovery code and the recovery key (protocol v1 §3, §4.8, D48).
//
// - The code: 130 random bits as 26 base32 characters (upper case, RFC 4648 alphabet), shown in groups of four.
// - The recovery key: Ed25519 whose 32-byte seed is HKDF-SHA256 of the code (normalised: upper case, no separators),
//   salt `RECOVERY_SALT`, info `RECOVERY_INFO`. The same code gives the same key on any machine, so the code alone
//   brings the key back for a reroot (M4); no server stores either.
// - WebCrypto for HKDF/signing and Node crypto KeyObject for public-key derivation (no extractable private JWK).
//   The private key is used once (to sign a Root) and dropped; nothing here writes or logs the code.
import { createPrivateKey, createPublicKey } from "node:crypto";
import { RecoveryCode, toBase32, toBase64Url } from "../../protocol";

export const RECOVERY_SALT = "botling/3 recovery v1";
export const RECOVERY_INFO = "ed25519 seed";
/** PKCS#8 wrapper for a raw Ed25519 seed (RFC 8410): SEQUENCE { version 0, AlgorithmIdentifier id-Ed25519, OCTET STRING { OCTET STRING seed } }. */
const ED25519_PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

const subtle = () => globalThis.crypto.subtle;
const buf = (bytes: Uint8Array) => bytes as Uint8Array<ArrayBuffer>;
const utf8 = new TextEncoder();

/** A fresh recovery code, normalised (26 upper-case base32 characters; 130 random bits). */
export function newRecoveryCode(): string {
  const bytes = new Uint8Array(17); // 136 bits; the first 130 are used
  globalThis.crypto.getRandomValues(bytes);
  const code = toBase32(bytes).slice(0, 26).toUpperCase();
  bytes.fill(0);
  return code;
}

/** The code as shown to the user: groups of four joined by dashes (`ABCD-EFGH-…-YZ`). */
export function formatRecoveryCode(code: string): string {
  const normal = normalizeRecoveryCode(code);
  if (!normal) throw new RangeError("not a recovery code");
  return normal.match(/.{1,4}/g)!.join("-");
}

/** The typed code normalised, or null when it is not 26 base32 characters (spaces and dashes are allowed). */
export function normalizeRecoveryCode(typed: string): string | null {
  const parsed = RecoveryCode.safeParse(typed);
  return parsed.success ? parsed.data : null;
}

export interface RecoveryKey {
  /** Raw Ed25519 public key (`recoveryPub`). */
  publicKey: Uint8Array;
  /** base64url of `publicKey`, as it appears in a Root statement. */
  recoveryPub: string;
  /** Non-extractable signing key. */
  privateKey: CryptoKey;
}

/** The recovery key a code stands for (deterministic). Throws on a malformed code. */
export async function recoveryKeyFromCode(typed: string): Promise<RecoveryKey> {
  const code = normalizeRecoveryCode(typed);
  if (!code) throw new RangeError("not a recovery code");
  const codeBytes = utf8.encode(code);
  let seed: Uint8Array | null = null;
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + 32);
  try {
    const ikm = await subtle().importKey("raw", buf(codeBytes), "HKDF", false, ["deriveBits"]);
    codeBytes.fill(0);
    seed = new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(utf8.encode(RECOVERY_SALT)), info: buf(utf8.encode(RECOVERY_INFO)) }, ikm, 256));
    pkcs8.set(ED25519_PKCS8_PREFIX, 0);
    pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);
    // Derive the public key via KeyObject + SPKI rather than exporting an extractable JWK (which would allocate `d`).
    const keyObj = createPrivateKey({ key: Buffer.from(pkcs8.buffer, pkcs8.byteOffset, pkcs8.byteLength), format: "der", type: "pkcs8" });
    const pubSpki = createPublicKey(keyObj).export({ format: "der", type: "spki" });
    if (pubSpki.length !== 44) throw new Error("unexpected Ed25519 SPKI length");
    const publicKey = new Uint8Array(pubSpki.subarray(12));
    const privateKey = await subtle().importKey("pkcs8", buf(pkcs8), { name: "Ed25519" }, false, ["sign"]);
    return { publicKey, recoveryPub: toBase64Url(publicKey), privateKey };
  } finally {
    codeBytes.fill(0);
    seed?.fill(0);
    pkcs8.fill(0);
  }
}
