// Byte helpers for the session layer (protocol v1 §5). Isomorphic: only `globalThis.crypto.subtle`, TextEncoder and
// typed arrays, no Node built-ins, so the same code runs in botlingd and in the page.

export const utf8 = new TextEncoder();

/** The reason a session ended (or a handshake was refused). Every check failure ends the session; none is retried. */
export type SessionEndReason =
  | "handshake"   // a handshake message was malformed, unexpected, or failed its authentication
  | "small-order" // a public key or DH result was a small-order point or all zero
  | "roster"      // the peer's static key failed the roster check (or was not the expected member)
  | "offer"       // pair mode: the offer is unknown, expired or used
  | "order"       // a frame's epoch/counter was not exactly the next one (replayed, skipped, reordered)
  | "auth"        // a frame failed AEAD authentication (altered, or not from this session)
  | "malformed"   // a frame's framing, kind, direction or size is wrong
  | "rekey"       // the rekey exchange was broken
  | "limit"       // a direction passed its hard frame or age limit without a rekey
  | "timeout"     // the handshake did not finish in time
  | "app"         // the receiver of a plaintext frame threw
  | "closed"      // closed by this side
  | "transport";  // the transport closed

export class SessionError extends Error {
  constructor(readonly reason: SessionEndReason, message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** WebCrypto wants an ArrayBuffer-backed view; a copy so a shared or offset buffer is never passed. */
export function ab(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer as ArrayBuffer;
}

export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError("not a u32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

export function u64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("not a safe u64");
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(n / 0x100000000), false);
  view.setUint32(4, n >>> 0, false);
  return out;
}

export function readU32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, false);
}

/** A big-endian u64, or -1 when it is above 2^53 (no counter ever gets there; the caller refuses it). */
export function readU64(bytes: Uint8Array, at: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset + at, 8);
  const high = view.getUint32(0, false);
  if (high > 0x1fffff) return -1;
  return high * 0x100000000 + view.getUint32(4, false);
}

/** Length-prefixed fields (u32 length, then the bytes): one unambiguous byte string per list of fields. */
export function lp(...fields: (Uint8Array | string)[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const field of fields) {
    const bytes = typeof field === "string" ? utf8.encode(field) : field;
    parts.push(u32(bytes.length), bytes);
  }
  return concat(...parts);
}

/** Equality without an early exit on the first differing byte. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}

export function isAscii(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte < 0x20 || byte > 0x7e) return false;
  return true;
}

export function ascii(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

const subtle = () => globalThis.crypto.subtle;

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", ab(bytes)));
}

/** HKDF-SHA256 (RFC 5869) through WebCrypto. */
export async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", ab(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: ab(salt), info: ab(info) }, key, length * 8));
}

export function aesKey(bytes: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", ab(bytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function aesSeal(key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: ab(nonce), additionalData: ab(aad), tagLength: 128 }, key, ab(plaintext)));
}

/** The plaintext, or null when the tag does not verify. */
export async function aesOpen(key: CryptoKey, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: ab(nonce), additionalData: ab(aad), tagLength: 128 }, key, ab(ciphertext)));
  } catch {
    return null;
  }
}
