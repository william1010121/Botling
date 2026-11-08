// End-to-end encryption between the desktop and a paired phone, over the relay. Shared by the desktop core (Node)
// and the phone web app (browser): only WebCrypto (`crypto.subtle`), no crypto of our own.
//
//   Keys      X25519 (static per desktop and per phone; a fresh ephemeral pair per connection on both sides)
//   Agreement three DH: ee = DH(Ep, Ed), es = DH(Ep, Sd), se = DH(Sp, Ed)  (both sides authenticated, forward secret)
//   KDF       HKDF-SHA256(ikm = ee‖es‖se, salt = SHA-256(label‖pairing secret?), info = SHA-256(transcript)) → 2×256 bits
//   AEAD      AES-256-GCM, one key per direction; nonce = direction tag ‖ 64-bit counter; AAD binds session, direction, counter
//   Replay    each direction's counter must be exactly the next one; a gap, repeat or failed tag ends the session
//
// Pairing uses the same handshake with the QR's one-time secret mixed into the salt, so only the phone that scanned
// the code can finish it, and the desktop learns that phone's static key at the same moment.
const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
const VERSION = 'botling-relay/v1';

export class E2EError extends Error {}

export const b64u = {
  encode(bytes: Uint8Array): string {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new E2EError('Not base64url.');
    const raw = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(raw, ch => ch.charCodeAt(0));
  },
};
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
/** WebCrypto wants an ArrayBuffer-backed view; copy so a shared or offset buffer is never passed. */
const buf = (bytes: Uint8Array) => new Uint8Array(bytes).buffer as ArrayBuffer;
export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await subtle().digest('SHA-256', buf(bytes))); }
export async function sha256Hex(text: string): Promise<string> { return [...await sha256(enc.encode(text))].map(b => b.toString(16).padStart(2, '0')).join(''); }

export interface KeyPair { privateKey: CryptoKey; publicKey: Uint8Array }
/** A new X25519 pair. The private key stays non-extractable unless asked (the desktop saves its own). */
export async function generateKeyPair(extractable = false): Promise<KeyPair> {
  const pair = await subtle().generateKey({ name: 'X25519' }, extractable, ['deriveBits']) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await subtle().exportKey('raw', pair.publicKey)) };
}
export async function exportPrivateKey(pair: KeyPair): Promise<Uint8Array> { return new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey)); }
export async function importKeyPair(pkcs8: Uint8Array, publicKey: Uint8Array): Promise<KeyPair> {
  const privateKey = await subtle().importKey('pkcs8', buf(pkcs8), { name: 'X25519' }, false, ['deriveBits']);
  return { privateKey, publicKey: new Uint8Array(publicKey) };
}
async function dh(own: CryptoKey, peer: Uint8Array): Promise<Uint8Array> {
  if (peer.length !== 32) throw new E2EError('Bad public key.');
  const key = await subtle().importKey('raw', buf(peer), { name: 'X25519' }, false, []);
  let bits: Uint8Array;
  try { bits = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: key } as unknown as AlgorithmIdentifier, own, 256)); }
  catch { throw new E2EError('Bad public key.'); } // small-order points are refused by WebCrypto
  if (bits.every(b => b === 0)) throw new E2EError('Bad public key.');
  return bits;
}

/** A phone's id is its static public key's fingerprint: the desktop can check that the two belong together. */
export async function deviceIdOf(devicePublicKey: Uint8Array): Promise<string> { return b64u.encode((await sha256(devicePublicKey)).slice(0, 16)); }
/** What the relay checks for a pairing phone: derived from the one-time secret, never the secret itself. */
export async function pairTokenOf(secret: Uint8Array): Promise<string> { return b64u.encode(await sha256(concat(enc.encode(`${VERSION}/pair-token`), secret))); }
/** Names the pending offer without revealing its secret (sent in the clear by the phone). */
export async function offerIdOf(secret: Uint8Array): Promise<string> { return b64u.encode((await sha256(concat(enc.encode(`${VERSION}/offer`), secret))).slice(0, 16)); }

export interface Transcript {
  mode: 'pair' | 'session';
  room: string; deviceId: string;
  deskStatic: Uint8Array; phoneStatic: Uint8Array; phoneEphemeral: Uint8Array; deskEphemeral: Uint8Array;
  /** Pairing only: the QR's one-time secret. */
  pairSecret?: Uint8Array;
}
export type Side = 'phone' | 'desk';
const TAG: Record<Side, number> = { phone: 0x70, desk: 0x64 };

/** Both sides compute the same keys from their own private keys and the other side's public keys. */
export async function deriveChannel(side: Side, own: { static: KeyPair; ephemeral: KeyPair }, t: Transcript): Promise<Channel> {
  if (t.mode === 'pair' && (!t.pairSecret || t.pairSecret.length !== 32)) throw new E2EError('Pairing needs its secret.');
  const [ee, es, se] = side === 'phone'
    ? await Promise.all([dh(own.ephemeral.privateKey, t.deskEphemeral), dh(own.ephemeral.privateKey, t.deskStatic), dh(own.static.privateKey, t.deskEphemeral)])
    : await Promise.all([dh(own.ephemeral.privateKey, t.phoneEphemeral), dh(own.static.privateKey, t.phoneEphemeral), dh(own.ephemeral.privateKey, t.phoneStatic)]);
  const transcript = enc.encode(JSON.stringify([VERSION, t.mode, t.room, t.deviceId,
    b64u.encode(t.deskStatic), b64u.encode(t.phoneStatic), b64u.encode(t.phoneEphemeral), b64u.encode(t.deskEphemeral)]));
  const info = await sha256(transcript);
  const salt = await sha256(concat(enc.encode(`${VERSION}/${t.mode}`), t.pairSecret ?? new Uint8Array()));
  const ikm = await subtle().importKey('raw', buf(concat(ee, es, se)), 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, ikm, 512));
  const aes = (bytes: Uint8Array) => subtle().importKey('raw', buf(bytes), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const [phoneToDesk, deskToPhone] = await Promise.all([aes(bits.slice(0, 32)), aes(bits.slice(32, 64))]);
  bits.fill(0);
  const session = b64u.encode(info.slice(0, 12));
  return side === 'phone' ? new Channel(session, 'phone', phoneToDesk, deskToPhone) : new Channel(session, 'desk', deskToPhone, phoneToDesk);
}

/** One connection's encrypted channel. Frames are `<counter>.<base64url ciphertext>`; JSON values inside. */
export class Channel {
  private sent = 0;
  private received = 0;
  private broken = false;
  /** Opening is serialized so frames are checked strictly in order even if callers do not await. */
  private opening: Promise<unknown> = Promise.resolve();
  /** Sealing too: frames leave in counter order even when several are sealed at once. */
  private sealing: Promise<unknown> = Promise.resolve();
  constructor(readonly session: string, private side: Side, private sendKey: CryptoKey, private receiveKey: CryptoKey) {}
  private nonce(side: Side, counter: number) {
    const nonce = new Uint8Array(12);
    nonce[0] = TAG[side];
    new DataView(nonce.buffer).setBigUint64(4, BigInt(counter));
    return nonce;
  }
  private aad(side: Side, counter: number) { return enc.encode(`${VERSION}|${this.session}|${side}|${counter}`); }
  seal(value: unknown): Promise<string> {
    const result = this.sealing.then(() => this.seal_(value));
    this.sealing = result.catch(() => undefined);
    return result;
  }
  private async seal_(value: unknown): Promise<string> {
    if (this.broken) throw new E2EError('Channel closed.');
    const counter = this.sent++;
    const data = await subtle().encrypt({ name: 'AES-GCM', iv: buf(this.nonce(this.side, counter)), additionalData: buf(this.aad(this.side, counter)) }, this.sendKey, buf(enc.encode(JSON.stringify(value))));
    return `${counter}.${b64u.encode(new Uint8Array(data))}`;
  }
  /** Throws (and refuses everything after) on a forged, altered, replayed, reordered or dropped frame. */
  open(frame: string): Promise<unknown> {
    const result = this.opening.then(() => this.open_(frame));
    this.opening = result.catch(() => undefined);
    return result;
  }
  private async open_(frame: string): Promise<unknown> {
    if (this.broken) throw new E2EError('Channel closed.');
    try {
      const match = /^(\d{1,15})\.([A-Za-z0-9_-]+)$/.exec(frame);
      if (!match) throw new E2EError('Malformed frame.');
      const counter = Number(match[1]);
      if (counter !== this.received) throw new E2EError('Replayed or out-of-order frame.');
      const peer: Side = this.side === 'phone' ? 'desk' : 'phone';
      let plain: ArrayBuffer;
      try { plain = await subtle().decrypt({ name: 'AES-GCM', iv: buf(this.nonce(peer, counter)), additionalData: buf(this.aad(peer, counter)) }, this.receiveKey, buf(b64u.decode(match[2]))); }
      catch { throw new E2EError('Frame failed authentication.'); }
      this.received++;
      return JSON.parse(dec.decode(plain));
    } catch (error) {
      this.broken = true;
      throw error instanceof E2EError ? error : new E2EError('Malformed frame.');
    }
  }
  close() { this.broken = true; }
}
