// Botling 3 wire protocol v1: byte encodings shared by the server and the page (base64url for keys, signatures and
// secrets; lower-case base32 for member ids; hex for hashes) and SHA-256 through WebCrypto. Isomorphic: only
// `globalThis.crypto`, `btoa` and `atob`, no Node built-ins.

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** Bytes as base64url without padding (RFC 4648 §5). */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url text (no padding) as bytes, or null when it is not canonical base64url. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  let binary: string;
  try { binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)); } catch { return null; }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  // Refuse non-canonical text (stray low bits in the last character): one encoding per byte string.
  return toBase64Url(bytes) === text ? bytes : null;
}

/** Bytes as lower-case base32 without padding (RFC 4648 §6 alphabet). */
export function toBase32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += BASE32[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const utf8 = new TextEncoder();
export function utf8Bytes(text: string): Uint8Array {
  return utf8.encode(text);
}

/** SHA-256 of bytes (WebCrypto). */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return new Uint8Array(digest);
}
