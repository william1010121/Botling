// X25519 for the session layer (protocol v1 §5.1): key pairs and a DH that refuses small-order points.
//
// Two checks, so the refusal does not depend on the engine: a public key on the known small-order list (the eight
// points of order 1, 2, 4 and 8 and their non-canonical encodings, compared with the top bit masked, as X25519 ignores
// it) is refused before the engine sees it; and a DH result of all zeros is refused after (an engine that computes
// it instead of throwing still gets no session). An engine that throws on such a point is refused the same way.
import { ab, SessionError } from "./bytes";

const subtle = () => globalThis.crypto.subtle;
const X25519 = { name: "X25519" } as const;

export interface DhKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: Uint8Array;
}

const hex = (text: string) => Uint8Array.from(text.match(/../g)!.map((pair) => parseInt(pair, 16)));

/**
 * Curve25519 u-coordinates of small order (libsodium's list): 0, 1, the two points of order 8, and p−1, p, p+1
 * (p−1 has order 2; p and p+1 are non-canonical encodings of 0 and 1). Top bit masked when compared.
 */
export const SMALL_ORDER_POINTS: readonly Uint8Array[] = [
  hex("0000000000000000000000000000000000000000000000000000000000000000"),
  hex("0100000000000000000000000000000000000000000000000000000000000000"),
  hex("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
  hex("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157"),
  hex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
  hex("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
  hex("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
];

/** Whether a raw X25519 public key is on the small-order list (top bit ignored, as X25519 does). */
export function isSmallOrder(publicKey: Uint8Array): boolean {
  if (publicKey.length !== 32) return false;
  for (const point of SMALL_ORDER_POINTS) {
    let diff = (publicKey[31]! & 0x7f) ^ point[31]!;
    for (let index = 0; index < 31; index++) diff |= publicKey[index]! ^ point[index]!;
    if (diff === 0) return true;
  }
  return false;
}

/** A fresh X25519 pair; the private key is non-extractable. */
export async function generateDhKeyPair(): Promise<DhKeyPair> {
  const pair = await subtle().generateKey(X25519, false, ["deriveBits"]) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle().exportKey("raw", pair.publicKey)) };
}

/** An X25519 pair from its PKCS#8 private key (test vectors, stored keys); the key in use is non-extractable. */
export async function importDhKeyPair(pkcs8: Uint8Array): Promise<DhKeyPair> {
  const probe = await subtle().importKey("pkcs8", ab(pkcs8), X25519, true, ["deriveBits"]);
  const jwk = await subtle().exportKey("jwk", probe);
  const x = jwk.x ?? "";
  const raw = atob(x.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (x.length % 4)) % 4));
  const publicKey = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
  if (publicKey.length !== 32) throw new SessionError("handshake", "an X25519 public key is 32 bytes");
  const privateKey = await subtle().importKey("pkcs8", ab(pkcs8), X25519, false, ["deriveBits"]);
  return { privateKey, publicKey };
}

/** The engine's X25519 result with no checks at all. Only the tests use it, to record what each engine does. */
export async function rawX25519(own: CryptoKey, peer: Uint8Array): Promise<Uint8Array> {
  const key = await subtle().importKey("raw", ab(peer), X25519, false, []);
  return new Uint8Array(await subtle().deriveBits({ name: "X25519", public: key } as unknown as AlgorithmIdentifier, own, 256));
}

/** Refuses an all-zero shared secret (a small-order point an engine computed instead of refusing). */
export function assertSharedSecret(bits: Uint8Array): Uint8Array {
  let any = 0;
  for (const byte of bits) any |= byte;
  if (bits.length !== 32 || any === 0) throw new SessionError("small-order", "the DH result is all zero");
  return bits;
}

/** Checks a peer's raw public key before any use: 32 bytes, not small-order. */
export function checkPublicKey(publicKey: Uint8Array, what: string): Uint8Array {
  if (publicKey.length !== 32) throw new SessionError("handshake", `${what} is not a 32-byte X25519 key`);
  if (isSmallOrder(publicKey)) throw new SessionError("small-order", `${what} is a small-order point`);
  return publicKey;
}

/** X25519(own, peer), refusing small-order peers and all-zero results whatever the engine does with them. */
export async function dh(own: CryptoKey, peer: Uint8Array, what = "the peer's key"): Promise<Uint8Array> {
  checkPublicKey(peer, what);
  let bits: Uint8Array;
  try { bits = await rawX25519(own, peer); }
  catch { throw new SessionError("small-order", `${what} was refused by X25519`); }
  return assertSharedSecret(bits);
}
