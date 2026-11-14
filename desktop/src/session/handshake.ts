// The session handshake (protocol v1 §5.1): KK, IK and pair, from WebCrypto primitives only. It generalises the 2.x
// `src/mobile-relay/e2e.ts` (three DH, HKDF, AES-GCM per direction), which stays untouched.
//
// Three messages, all binary; the first byte is the kind:
//
//   HS1  I → R   0x10 ‖ version ‖ mode ‖ transport ‖ e_i (32) ‖ offerLen ‖ offer ‖ AEAD_k1(id_i (26) ‖ s_i (32))
//   HS2  R → I   0x11 ‖ e_r (32) ‖ AEAD_{r→i, epoch 0, counter 0}(h)
//   HS3  I → R   0x12 ‖ AEAD_{i→r, epoch 0, counter 0}(h)
//
//   h1  = SHA-256(lp("botling/3 hs1", "botling/3", "1", mode, transport, cluster, id_r, s_r, e_i, offer))
//   k1  = HKDF(DH(e_i, s_r), salt = SHA-256(lp("botling/3 hs1 salt", P)), info = h1)  (P: pair mode's secret, else empty)
//   h   = SHA-256(lp("botling/3 hs", h1, id_i, s_i, e_r))            — the transcript hash; session id = h[0..16)
//   ikm = DH(e_i, e_r) ‖ DH(e_i, s_r) ‖ DH(s_i, e_r)                  — v1 §5.1
//   HKDF(ikm, salt = SHA-256(lp("botling/3 session salt", mode, P)), info = h) → k_{i→r} ‖ k_{r→i} ‖ chain ‖ code
//
// - The initiator's id and static key travel encrypted under k1 in every mode (KK, IK and pair share one wire format);
//   the responder decrypts them and runs the roster check (`checkPeer`) before it answers. KK additionally names the
//   initiator the responder expects.
// - The cluster id, both member ids, both static keys, both ephemerals, the mode, the transport kind and the offer are
//   all in the transcript: either side holding a different view fails the AEAD, so nothing is negotiated in the clear.
// - Both sides prove their static keys before any data frame: R by HS2 (needs s_r), I by HS3 (needs s_i). The
//   responder hands out nothing before HS3 verified (§5.1: nothing is parsed before both keys were checked).
// - The 6-digit code comes from the same key schedule (info = h), so it is bound to the transcript and to the DH
//   secrets.
import {
  aesKey, aesOpen, aesSeal, ascii, concat, equalBytes, hkdf, isAscii, lp, SessionError, sha256, u32, u64, utf8,
} from "./bytes";
import { checkPublicKey, dh, generateDhKeyPair, type DhKeyPair } from "./x25519";

export const SESSION_PROTOCOL = "botling/3";
export const SESSION_VERSION = 1;

export type HandshakeMode = "kk" | "ik" | "pair";
export type TransportKind = "tailnet" | "relay" | "memory";
export type Role = "initiator" | "responder";
export type Direction = "i2r" | "r2i";

export const FRAME_KIND = { HS1: 0x10, HS2: 0x11, HS3: 0x12, DATA: 0x20, REKEY: 0x21, REKEY_ACK: 0x22, SWITCH: 0x23 } as const;
const MODE_BYTE: Record<HandshakeMode, number> = { kk: 1, ik: 2, pair: 3 };
const TRANSPORT_BYTE: Record<TransportKind, number> = { tailnet: 1, relay: 2, memory: 3 };
const DIRECTION_TAG: Record<Direction, number> = { i2r: 0x69, r2i: 0x72 };

const MEMBER_ID = /^[a-z2-7]{26}$/;
const CLUSTER_ID = /^[0-9a-f]{32}$/;
const OFFER_ID = /^[A-Za-z0-9_-]{16,32}$/;
const TAG_BYTES = 16;
const PAYLOAD1_BYTES = 26 + 32;
const HS2_BYTES = 1 + 32 + 32 + TAG_BYTES;
const HS3_BYTES = 1 + 32 + TAG_BYTES;

/** This side's static identity: its member id and X25519 key. */
export interface LocalStatic {
  readonly memberId: string;
  readonly dhPub: Uint8Array;
  readonly dhKey: CryptoKey;
}
/** The other side's static identity as the roster (or the pairing offer) names it. */
export interface PeerStatic {
  readonly memberId: string;
  readonly dhPub: Uint8Array;
}

/** What the responder's roster check is shown, after HS1 decrypted and before anything is answered. */
export interface PeerClaim {
  readonly mode: HandshakeMode;
  readonly memberId: string;
  readonly dhPub: Uint8Array;
  /** Pair mode: the offer the device answers. */
  readonly offer?: string;
}
export type PeerDecision = { ok: true } | { ok: false; detail?: string };

/** The keys and facts one finished handshake (or rekey) gives a session. */
export interface SessionSecrets {
  readonly role: Role;
  readonly mode: HandshakeMode;
  readonly transport: TransportKind;
  readonly cluster: string;
  readonly local: LocalStatic;
  readonly peer: PeerStatic;
  readonly offer?: string;
  /** The transcript hash `h` (pair mode: the device signs it in `pair.hello`). */
  readonly transcriptHash: Uint8Array;
  /** `h[0..16)`, bound into every frame's AAD. */
  readonly sessionIdBytes: Uint8Array;
  readonly sessionId: string;
  /** The 6-digit code both screens show (§4.4 step 3). Derived in every mode; only pair mode shows it. */
  readonly code: string;
  readonly sendKey: CryptoKey;
  readonly receiveKey: CryptoKey;
  /** Chaining secret for the next rekey (never leaves the session). */
  readonly chain: Uint8Array;
}

export interface InitiatorOptions {
  mode: HandshakeMode;
  transport: TransportKind;
  cluster: string;
  self: LocalStatic;
  /** The responder's keys, from the roster (KK, IK) or the pairing offer (pair). */
  responder: PeerStatic;
  /** Pair mode: the offer's id and its one-time 32-byte secret `P`. */
  pair?: { offer: string; secret: Uint8Array };
  /** Test vectors only: a fixed ephemeral pair. */
  ephemeral?: DhKeyPair;
}

export interface ResponderOptions {
  transport: TransportKind;
  cluster: string;
  self: LocalStatic;
  /** Which modes this responder takes (a server takes IK and pair from devices; KK between servers). */
  modes: readonly HandshakeMode[];
  /** KK: the member the responder expects; another id is refused. */
  expectInitiator?: string;
  /** The roster check of the initiator's decrypted id and static key; nothing is answered before it says ok. */
  checkPeer(claim: PeerClaim): Promise<PeerDecision> | PeerDecision;
  /** Pair mode: the pending offer's secret, or null when it is unknown, expired or used. */
  offerSecret?(offer: string): Promise<Uint8Array | null> | Uint8Array | null;
  /** Test vectors only: a fixed ephemeral pair. */
  ephemeral?: DhKeyPair;
}

const fail = (reason: ConstructorParameters<typeof SessionError>[0], message: string): never => { throw new SessionError(reason, message); };

function b64u(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The 12-byte AES-GCM nonce: direction tag ‖ epoch (3 bytes) ‖ counter (8 bytes). */
export function frameNonce(direction: Direction, epoch: number, counter: number): Uint8Array {
  if (epoch > 0xffffff) fail("limit", "too many rekeys");
  const nonce = new Uint8Array(12);
  nonce[0] = DIRECTION_TAG[direction];
  nonce[1] = (epoch >>> 16) & 0xff;
  nonce[2] = (epoch >>> 8) & 0xff;
  nonce[3] = epoch & 0xff;
  nonce.set(u64(counter), 4);
  return nonce;
}

/** A frame's AAD: protocol, version, session id, frame kind, direction, epoch, counter (v1 §5.1 plus kind and epoch). */
export function frameAad(sessionIdBytes: Uint8Array, kind: number, direction: Direction, epoch: number, counter: number): Uint8Array {
  return concat(utf8.encode(SESSION_PROTOCOL), Uint8Array.of(SESSION_VERSION), sessionIdBytes, Uint8Array.of(kind, DIRECTION_TAG[direction]), u32(epoch), u64(counter));
}

/** The 6-digit code from 8 bytes of the key schedule. */
export function pairingCodeOf(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
  return (value % 1_000_000n).toString().padStart(6, "0");
}

async function h1Of(mode: HandshakeMode, transport: TransportKind, cluster: string, responder: PeerStatic, ephemeral: Uint8Array, offer: string): Promise<Uint8Array> {
  return sha256(lp("botling/3 hs1", SESSION_PROTOCOL, String(SESSION_VERSION), mode, transport, cluster, responder.memberId, responder.dhPub, ephemeral, offer));
}

async function k1Of(es: Uint8Array, secret: Uint8Array | undefined, h1: Uint8Array): Promise<CryptoKey> {
  const salt = await sha256(lp("botling/3 hs1 salt", secret ?? new Uint8Array(0)));
  const bits = await hkdf(es, salt, h1, 32);
  const key = await aesKey(bits);
  bits.fill(0);
  return key;
}

interface Schedule { i2r: CryptoKey; r2i: CryptoKey; chain: Uint8Array; code: string }

async function scheduleOf(ikm: Uint8Array, mode: HandshakeMode, secret: Uint8Array | undefined, h: Uint8Array): Promise<Schedule> {
  const salt = await sha256(lp("botling/3 session salt", mode, secret ?? new Uint8Array(0)));
  const bits = await hkdf(ikm, salt, h, 32 + 32 + 32 + 8);
  ikm.fill(0);
  const [i2r, r2i] = await Promise.all([aesKey(bits.subarray(0, 32)), aesKey(bits.subarray(32, 64))]);
  const chain = bits.slice(64, 96);
  const code = pairingCodeOf(bits.subarray(96, 104));
  bits.fill(0);
  return { i2r, r2i, chain, code };
}

function checkIdentity(self: LocalStatic, cluster: string): void {
  if (!MEMBER_ID.test(self.memberId)) fail("handshake", "this side's member id is malformed");
  if (!CLUSTER_ID.test(cluster)) fail("handshake", "the cluster id is malformed");
  if (self.dhPub.length !== 32) fail("handshake", "this side's X25519 key is not 32 bytes");
}

function secretsOf(role: Role, base: { mode: HandshakeMode; transport: TransportKind; cluster: string; local: LocalStatic; peer: PeerStatic; offer?: string }, h: Uint8Array, schedule: Schedule): SessionSecrets {
  const sessionIdBytes = h.slice(0, 16);
  return {
    role, ...base,
    transcriptHash: h,
    sessionIdBytes,
    sessionId: b64u(sessionIdBytes),
    code: schedule.code,
    sendKey: role === "initiator" ? schedule.i2r : schedule.r2i,
    receiveKey: role === "initiator" ? schedule.r2i : schedule.i2r,
    chain: schedule.chain,
  };
}

/** The initiator: `start()` gives HS1; `receive(HS2)` gives HS3 and the session's secrets. */
export class Initiator {
  private ephemeral: DhKeyPair | null = null;
  private h1: Uint8Array | null = null;
  private es: Uint8Array | null = null;
  private done = false;

  constructor(private readonly options: InitiatorOptions) {}

  async start(): Promise<Uint8Array> {
    const { mode, transport, cluster, self, responder, pair } = this.options;
    if (this.ephemeral) fail("handshake", "the handshake was started already");
    checkIdentity(self, cluster);
    if (!MEMBER_ID.test(responder.memberId)) fail("handshake", "the responder's member id is malformed");
    checkPublicKey(responder.dhPub, "the responder's static key");
    if (!(mode in MODE_BYTE) || !(transport in TRANSPORT_BYTE)) fail("handshake", "unknown mode or transport");
    if (mode === "pair") {
      if (!pair || pair.secret.length !== 32 || !OFFER_ID.test(pair.offer)) fail("handshake", "pair mode needs the offer and its 32-byte secret");
    } else if (pair) fail("handshake", "only pair mode carries an offer");
    const offer = mode === "pair" ? pair!.offer : "";
    const ephemeral = this.options.ephemeral ?? await generateDhKeyPair();
    this.ephemeral = ephemeral;
    const h1 = await h1Of(mode, transport, cluster, responder, ephemeral.publicKey, offer);
    const es = await dh(ephemeral.privateKey, responder.dhPub, "the responder's static key");
    const k1 = await k1Of(es, pair?.secret, h1);
    const sealed = await aesSeal(k1, new Uint8Array(12), concat(Uint8Array.of(FRAME_KIND.HS1), h1), concat(utf8.encode(self.memberId), self.dhPub));
    this.h1 = h1;
    this.es = es;
    const offerBytes = utf8.encode(offer);
    return concat(Uint8Array.of(FRAME_KIND.HS1, SESSION_VERSION, MODE_BYTE[mode], TRANSPORT_BYTE[transport]), ephemeral.publicKey, Uint8Array.of(offerBytes.length), offerBytes, sealed);
  }

  /** Checks HS2 (the responder proved its static key) and gives HS3 with the secrets. */
  async receive(hs2: Uint8Array): Promise<{ hs3: Uint8Array; secrets: SessionSecrets }> {
    if (!this.ephemeral || !this.h1 || !this.es || this.done) fail("handshake", "unexpected HS2");
    this.done = true;
    if (hs2.length !== HS2_BYTES || hs2[0] !== FRAME_KIND.HS2) fail("handshake", "HS2 is malformed");
    const { mode, transport, cluster, self, responder, pair } = this.options;
    const er = hs2.slice(1, 33);
    checkPublicKey(er, "the responder's ephemeral key");
    const h = await sha256(lp("botling/3 hs", this.h1!, self.memberId, self.dhPub, er));
    const [ee, se] = await Promise.all([
      dh(this.ephemeral!.privateKey, er, "the responder's ephemeral key"),
      dh(self.dhKey, er, "the responder's ephemeral key"),
    ]);
    const schedule = await scheduleOf(concat(ee, this.es!, se), mode, pair?.secret, h);
    ee.fill(0); se.fill(0); this.es!.fill(0); this.es = null;
    const sessionIdBytes = h.slice(0, 16);
    const confirm = await aesOpen(schedule.r2i, frameNonce("r2i", 0, 0), frameAad(sessionIdBytes, FRAME_KIND.HS2, "r2i", 0, 0), hs2.subarray(33));
    if (!confirm || !equalBytes(confirm, h)) fail("handshake", "HS2 failed authentication (wrong responder key, cluster, transport or offer)");
    const sealed = await aesSeal(schedule.i2r, frameNonce("i2r", 0, 0), frameAad(sessionIdBytes, FRAME_KIND.HS3, "i2r", 0, 0), h);
    const secrets = secretsOf("initiator", { mode, transport, cluster, local: self, peer: responder, offer: pair?.offer }, h, schedule);
    return { hs3: concat(Uint8Array.of(FRAME_KIND.HS3), sealed), secrets };
  }
}

/** The responder: `receive(HS1)` runs the roster check and gives HS2; `finish(HS3)` gives the secrets. */
export class Responder {
  private pending: { secrets: SessionSecrets } | null = null;
  private stage: "hs1" | "hs3" | "done" = "hs1";

  constructor(private readonly options: ResponderOptions) {}

  /** The claim that passed the roster check, once HS1 is through. */
  peer: PeerStatic | null = null;

  async receive(hs1: Uint8Array): Promise<Uint8Array> {
    if (this.stage !== "hs1") fail("handshake", "unexpected HS1");
    this.stage = "done";
    const { transport, cluster, self, modes } = this.options;
    checkIdentity(self, cluster);
    if (hs1.length < 37 || hs1[0] !== FRAME_KIND.HS1) fail("handshake", "HS1 is malformed");
    if (hs1[1] !== SESSION_VERSION) fail("handshake", `HS1 is protocol version ${hs1[1]}, this side speaks ${SESSION_VERSION}`);
    const mode = (Object.keys(MODE_BYTE) as HandshakeMode[]).find((name) => MODE_BYTE[name] === hs1[2]);
    if (!mode || !modes.includes(mode)) fail("handshake", "this responder does not take that handshake mode");
    if (hs1[3] !== TRANSPORT_BYTE[transport]) fail("handshake", "HS1 names another transport");
    const ei = hs1.slice(4, 36);
    checkPublicKey(ei, "the initiator's ephemeral key");
    const offerLength = hs1[36]!;
    if (hs1.length !== 37 + offerLength + PAYLOAD1_BYTES + TAG_BYTES) fail("handshake", "HS1 has the wrong length");
    const offerBytes = hs1.subarray(37, 37 + offerLength);
    const offer = isAscii(offerBytes) ? ascii(offerBytes) : "";
    let secret: Uint8Array | undefined;
    if (mode === "pair") {
      if (!OFFER_ID.test(offer)) fail("handshake", "pair mode names its offer");
      const found = this.options.offerSecret ? await this.options.offerSecret(offer) : null;
      if (!found || found.length !== 32) fail("offer", "the offer is unknown, expired or used");
      secret = new Uint8Array(found!);
    } else if (offerLength !== 0) fail("handshake", "only pair mode carries an offer");
    const selfPeer: PeerStatic = { memberId: self.memberId, dhPub: self.dhPub };
    const h1 = await h1Of(mode!, transport, cluster, selfPeer, ei, offer);
    const es = await dh(self.dhKey, ei, "the initiator's ephemeral key");
    const k1 = await k1Of(es, secret, h1);
    const payload = await aesOpen(k1, new Uint8Array(12), concat(Uint8Array.of(FRAME_KIND.HS1), h1), hs1.subarray(37 + offerLength));
    if (!payload || payload.length !== PAYLOAD1_BYTES) fail("handshake", "HS1 failed authentication (wrong responder key, cluster, transport or offer secret)");
    const idBytes = payload!.subarray(0, 26);
    const memberId = isAscii(idBytes) ? ascii(idBytes) : "";
    if (!MEMBER_ID.test(memberId)) fail("handshake", "HS1 names a malformed member id");
    const si = payload!.slice(26);
    checkPublicKey(si, "the initiator's static key");
    if (memberId === self.memberId) fail("roster", "a member does not open a session with itself");
    if (mode === "kk" && this.options.expectInitiator !== undefined && this.options.expectInitiator !== memberId) fail("roster", "KK: not the member this side expected");
    if (mode === "kk" && this.options.expectInitiator === undefined) fail("handshake", "KK needs the expected initiator");
    const claim: PeerClaim = mode === "pair" ? { mode: mode!, memberId, dhPub: si, offer } : { mode: mode!, memberId, dhPub: si };
    let decision: PeerDecision;
    try { decision = await this.options.checkPeer(claim); }
    catch (error) { fail("roster", `the roster check failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (!decision!.ok) fail("roster", decision!.detail ?? "the initiator is not a valid member");
    const ephemeral = this.options.ephemeral ?? await generateDhKeyPair();
    const h = await sha256(lp("botling/3 hs", h1, memberId, si, ephemeral.publicKey));
    const [ee, se] = await Promise.all([dh(ephemeral.privateKey, ei, "the initiator's ephemeral key"), dh(ephemeral.privateKey, si, "the initiator's static key")]);
    const schedule = await scheduleOf(concat(ee, es, se), mode!, secret, h);
    ee.fill(0); se.fill(0); es.fill(0); secret?.fill(0);
    const peer: PeerStatic = { memberId, dhPub: si };
    const secrets = secretsOf("responder", { mode: mode!, transport, cluster, local: self, peer, offer: mode === "pair" ? offer : undefined }, h, schedule);
    const sealed = await aesSeal(secrets.sendKey, frameNonce("r2i", 0, 0), frameAad(secrets.sessionIdBytes, FRAME_KIND.HS2, "r2i", 0, 0), h);
    this.peer = peer;
    this.pending = { secrets };
    this.stage = "hs3";
    return concat(Uint8Array.of(FRAME_KIND.HS2), ephemeral.publicKey, sealed);
  }

  /** Checks HS3 (the initiator proved its static key): only now is the session open. */
  async finish(hs3: Uint8Array): Promise<SessionSecrets> {
    if (this.stage !== "hs3" || !this.pending) fail("handshake", "unexpected frame before HS3");
    this.stage = "done";
    const { secrets } = this.pending!;
    this.pending = null;
    if (hs3.length !== HS3_BYTES || hs3[0] !== FRAME_KIND.HS3) fail("handshake", "expected HS3");
    const confirm = await aesOpen(secrets.receiveKey, frameNonce("i2r", 0, 0), frameAad(secrets.sessionIdBytes, FRAME_KIND.HS3, "i2r", 0, 0), hs3.subarray(1));
    if (!confirm || !equalBytes(confirm, secrets.transcriptHash)) fail("handshake", "HS3 failed authentication (the initiator does not hold its static key)");
    return secrets;
  }
}

// ---------------------------------------------------------------------------------------------
// Rekey (v1 §5.1: a new handshake after 2^20 frames or 24 h). In-band, under the current keys, with fresh ephemerals
// and both static keys again, chained to the previous epoch so the new keys depend on everything before.

export interface RekeySchedule { i2r: CryptoKey; r2i: CryptoKey; chain: Uint8Array }

/**
 * Epoch `epoch`'s keys. The initiator passes its own new ephemeral and the responder's; the responder the reverse.
 *   ikm  = DH(e_i', e_r') ‖ DH(e_i', s_r) ‖ DH(s_i, e_r')
 *   HKDF(ikm, salt = SHA-256(lp("botling/3 rekey salt", chain)), info = SHA-256(lp("botling/3 rekey", h, epoch, e_i', e_r')))
 */
export async function rekeySchedule(secrets: SessionSecrets, chain: Uint8Array, epoch: number, own: DhKeyPair, peerEphemeral: Uint8Array): Promise<RekeySchedule> {
  checkPublicKey(peerEphemeral, "the peer's rekey key");
  const initiator = secrets.role === "initiator";
  const ei = initiator ? own.publicKey : peerEphemeral;
  const er = initiator ? peerEphemeral : own.publicKey;
  const [ee, es, se] = initiator
    ? await Promise.all([dh(own.privateKey, er), dh(own.privateKey, secrets.peer.dhPub), dh(secrets.local.dhKey, er)])
    : await Promise.all([dh(own.privateKey, ei), dh(secrets.local.dhKey, ei), dh(own.privateKey, secrets.peer.dhPub)]);
  const salt = await sha256(lp("botling/3 rekey salt", chain));
  const info = await sha256(lp("botling/3 rekey", secrets.transcriptHash, u32(epoch), ei, er));
  const ikm = concat(ee, es, se);
  ee.fill(0); es.fill(0); se.fill(0);
  const bits = await hkdf(ikm, salt, info, 96);
  ikm.fill(0);
  const [i2r, r2i] = await Promise.all([aesKey(bits.subarray(0, 32)), aesKey(bits.subarray(32, 64))]);
  const next = bits.slice(64, 96);
  bits.fill(0);
  return { i2r, r2i, chain: next };
}
