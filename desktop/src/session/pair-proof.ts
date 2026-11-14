// Pair mode's proof of the device's signing key (protocol v1 §4.4; `pair.hello.proof`, src/protocol/messages.ts): the
// device signs the handshake's transcript hash with its Ed25519 key, so the server learns a signing key that belongs to
// the same device as the handshake's X25519 key, and the member id the handshake named is that key's id.
//
// The signed bytes are `PAIR_PROOF_DOMAIN ‖ h`, not `h` alone: a signature made here can never be taken for a roster
// statement's or anything else's (those carry their own domain text).
import { ab, concat, sha256, utf8 } from "./bytes";

export const PAIR_PROOF_DOMAIN = "botling/3 pair proof v1\n";
const ED25519 = { name: "Ed25519" } as const;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A member's id from its raw Ed25519 public key (§3; the same rule as protocol/roster.ts `memberIdFromKey`). */
export async function memberIdOfSignKey(signPub: Uint8Array): Promise<string> {
  if (signPub.length !== 32) throw new RangeError("an Ed25519 public key is 32 bytes");
  let out = "", buffer = 0, bits = 0;
  for (const byte of await sha256(signPub)) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += BASE32[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
    buffer &= (1 << bits) - 1;
  }
  return out.slice(0, 26);
}

export function pairProofBytes(transcriptHash: Uint8Array): Uint8Array {
  return concat(utf8.encode(PAIR_PROOF_DOMAIN), transcriptHash);
}

export async function signPairProof(signKey: CryptoKey, transcriptHash: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.sign(ED25519, signKey, ab(pairProofBytes(transcriptHash))));
}

/** Whether `proof` is `signPub`'s signature over this transcript and `signPub` is the member the handshake named. */
export async function verifyPairProof(signPub: Uint8Array, memberId: string, transcriptHash: Uint8Array, proof: Uint8Array): Promise<boolean> {
  if (signPub.length !== 32 || proof.length !== 64) return false;
  if (await memberIdOfSignKey(signPub) !== memberId) return false;
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", ab(signPub), ED25519, false, ["verify"]);
    return await globalThis.crypto.subtle.verify(ED25519, key, ab(proof), ab(pairProofBytes(transcriptHash)));
  } catch {
    return false;
  }
}
