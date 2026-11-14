// The unchanged 2.x blind relay (relay/, protocol v1 §6.3, D22) as Botling 3 uses it (M2 step 13). Isomorphic (WebCrypto
// only): botlingd's connector (server/net/relay.ts) and the page's relay socket (fe-link/relay-socket.ts) share it.
//
// - botlingd keeps its own room: it opens it with a 32-byte room key (`{t:'desk', v:1, key}`); the room id the relay
//   answers is that key's SHA-256, so only botlingd can hold the room. Devices learn `{url, room}` from the pairing offer.
// - Who may join is the relay's allow list of token hashes (`{t:'allow', tokens:[{h, exp?}]}`), set by botlingd. The
//   tokens are derived, never stored or sent:
//     pairing   token = SHA-256("botling3/relay-pair/v1" ‖ 0 ‖ offer ‖ 0 ‖ P), P the offer's one-time secret (in the
//               link's fragment): only the holder of the link can join, and only until the offer expires.
//     device    token = SHA-256("botling3/relay-device/v1" ‖ 0 ‖ deviceId ‖ 0 ‖ X25519(device, server)), the static
//               DH both sides can compute from their own private key and the other's roster key. botlingd lists the
//               valid devices' tokens; a device leaving the roster leaves the list, and the relay closes its
//               connection at once (4403).
//   The token only admits a connection to the room (relay admission, not authentication): every session inside still
//   runs the full handshake and roster check (src/session), the relay sees only opaque `d` frames.
// - Session frames travel as base64url text in `d` (the relay takes text frames only).
import { ab, concat, utf8 } from "./bytes";
import { dh } from "./x25519";

export const RELAY_WIRE_VERSION = 1;
/** Close codes of the relay (relay/src/relay.ts CLOSE). */
export const RELAY_CLOSE = { bad: 4400, replaced: 4401, denied: 4403, offline: 4404, timeout: 4408, tooLarge: 4413, limited: 4429, full: 4503 } as const;

const subtle = () => globalThis.crypto.subtle;

function b64u(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(text: string): Uint8Array {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}
async function sha256(bytes: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await subtle().digest("SHA-256", ab(bytes))); }

/** The room id the relay gives a room key (base64url SHA-256 of the key's bytes, relay.ts `roomOf`). */
export async function relayRoomOf(key: string): Promise<string> { return b64u(await sha256(fromB64u(key))); }

/** A fresh room key: 32 random bytes as 43 base64url characters (what `{t:'desk'}` takes). */
export function newRelayRoomKey(): string { return b64u(globalThis.crypto.getRandomValues(new Uint8Array(32))); }

/** The relay's hash of a join token: hex SHA-256 of its UTF-8 (relay.ts `hashToken`). */
export async function relayTokenHash(token: string): Promise<string> {
  return [...await sha256(utf8.encode(token))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The join token of a pairing offer (the device holds the link; botlingd holds the offer). */
export async function relayPairToken(offer: string, secret: Uint8Array): Promise<string> {
  return b64u(await sha256(concat(utf8.encode("botling3/relay-pair/v1"), Uint8Array.of(0), utf8.encode(offer), Uint8Array.of(0), secret)));
}

/**
 * A paired device's join token: from the static X25519 of `own` (a private key) and `peer` (the other side's public
 * key). The device computes it with (its key, the server's key), botlingd with (its key, the device's key).
 */
export async function relayDeviceToken(deviceId: string, own: CryptoKey, peer: Uint8Array): Promise<string> {
  const shared = await dh(own, peer, "the relay token's peer key");
  try {
    return b64u(await sha256(concat(utf8.encode("botling3/relay-device/v1"), Uint8Array.of(0), utf8.encode(deviceId), Uint8Array.of(0), shared)));
  } finally { shared.fill(0); }
}
