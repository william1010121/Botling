// RFC 8291 Web Push payload encryption (`aes128gcm`, RFC 8188 record framing) using Node built-in `node:crypto`.
// Never logs or includes raw key material in error messages.
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";
import { fromBase64Url } from "../../protocol";

export const DEFAULT_RECORD_SIZE = 4096;
export const MIN_RECORD_SIZE = 18;
export const MAX_RECORD_SIZE = 0xffffffff;

const WEBPUSH_INFO_PREFIX = Buffer.from("WebPush: info\x00", "ascii");
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\x00", "ascii");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\x00", "ascii");
const UTF8 = new TextEncoder();

export interface EncryptPushOptions {
  /** Receiver's P-256 uncompressed public key (65 bytes, 0x04 prefix), raw or base64url. */
  p256dh: string | Uint8Array;
  /** Receiver's 16-byte authentication secret, raw or base64url. */
  auth: string | Uint8Array;
  /** Cleartext payload bytes or UTF-8 string. */
  plaintext: Uint8Array | string;
  /** Optional 16-byte salt override (for deterministic RFC 8291 test vectors). */
  salt?: Uint8Array;
  /** Optional 32-byte P-256 scalar override (for deterministic RFC 8291 test vectors). */
  localPrivateKey?: Uint8Array;
  /** RFC 8188 record size (default 4096). */
  recordSize?: number;
}

export interface EncryptedPushPayload {
  contentEncoding: "aes128gcm";
  body: Buffer;
}

function decodeKeyBytes(value: string | Uint8Array, expectedLength: number, label: string): Buffer {
  const bytes = typeof value === "string" ? fromBase64Url(value) : value;
  if (!bytes || bytes.length !== expectedLength) {
    throw new RangeError(`push: invalid ${label} length`);
  }
  return Buffer.from(bytes);
}

function xorSequence(baseNonce: Buffer, seq: number): Buffer {
  const out = Buffer.from(baseNonce);
  let n = BigInt(seq);
  for (let i = out.length - 1; i >= 0 && n > 0n; i--) {
    out[i] ^= Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * Encrypts a Web Push payload per RFC 8291 §3 (`aes128gcm`) and RFC 8188 record framing.
 */
export function encryptPushPayload(options: EncryptPushOptions): EncryptedPushPayload {
  const uaPublic = decodeKeyBytes(options.p256dh, 65, "p256dh");
  if (uaPublic[0] !== 0x04) throw new RangeError("push: p256dh must be an uncompressed P-256 point");

  const authSecret = decodeKeyBytes(options.auth, 16, "auth");

  const salt = options.salt !== undefined
    ? decodeKeyBytes(options.salt, 16, "salt")
    : randomBytes(16);

  const recordSize = options.recordSize ?? DEFAULT_RECORD_SIZE;
  if (!Number.isInteger(recordSize) || recordSize < MIN_RECORD_SIZE || recordSize > MAX_RECORD_SIZE) {
    throw new RangeError(`push: recordSize must be an integer in [${MIN_RECORD_SIZE}, ${MAX_RECORD_SIZE}]`);
  }

  const ecdh = createECDH("prime256v1");
  if (options.localPrivateKey !== undefined) {
    ecdh.setPrivateKey(decodeKeyBytes(options.localPrivateKey, 32, "localPrivateKey"));
  } else {
    ecdh.generateKeys();
  }
  const asPublic = ecdh.getPublicKey();
  if (asPublic.length !== 65 || asPublic[0] !== 0x04) {
    throw new Error("push: failed to derive uncompressed ephemeral P-256 key");
  }

  let shared: Buffer;
  try {
    shared = ecdh.computeSecret(uaPublic);
  } catch {
    throw new Error("push: invalid P-256 receiver public key");
  }

  // RFC 8291 §3.3: IKM = HKDF-Expand(HKDF-Extract(auth_secret, ecdh_secret), "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([WEBPUSH_INFO_PREFIX, uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));

  // RFC 8188 §2.2-2.3: CEK (16 bytes) and NONCE (12 bytes) from IKM and 16-byte salt
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, CEK_INFO, 16));
  const baseNonce = Buffer.from(hkdfSync("sha256", ikm, salt, NONCE_INFO, 12));

  // RFC 8188 §2.1 header: salt (16) || rs (4, uint32be) || idlen (1 = 65) || keyid (65)
  const header = Buffer.allocUnsafe(16 + 4 + 1 + asPublic.length);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header[20] = asPublic.length;
  asPublic.copy(header, 21);

  const plaintext = typeof options.plaintext === "string"
    ? Buffer.from(UTF8.encode(options.plaintext))
    : Buffer.from(options.plaintext);

  const maxChunk = recordSize - 17; // 1-byte padding delimiter + 16-byte GCM tag
  const parts: Buffer[] = [header];
  let offset = 0;
  let seq = 0;
  do {
    const end = Math.min(offset + maxChunk, plaintext.length);
    const isLast = end === plaintext.length;
    const chunk = plaintext.subarray(offset, end);
    const delimiter = Buffer.from([isLast ? 0x02 : 0x01]);
    const iv = seq === 0 ? baseNonce : xorSequence(baseNonce, seq);
    const cipher = createCipheriv("aes-128-gcm", cek, iv);
    const ciphertext = cipher.update(chunk);
    const paddedDelim = cipher.update(delimiter);
    const final = cipher.final();
    const tag = cipher.getAuthTag();
    parts.push(ciphertext, paddedDelim, final, tag);
    offset = end;
    seq++;
  } while (offset < plaintext.length);

  return { contentEncoding: "aes128gcm", body: Buffer.concat(parts) };
}
