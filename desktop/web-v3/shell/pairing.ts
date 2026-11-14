// Pairing this page with a server (protocol v1 §4.4) over `/v3/ws` in `pair` mode: the offer's one-time secret is
// mixed into the handshake, both screens show the 6-digit code from the transcript, the user confirms on the server
// side, the server commits the device's `Add` and sends `pair.added`; the page stores its membership durably and only
// then answers `pair.ack` naming the Add (its id = statementId(add.body), step 5). A lost ack gives the offer back on the
// server; a retry with the same link and the same keys gets the same Add.
import {
  decodeFrame, encodeFrame, fromBase64Url, memberIdFromKey, statementId, toBase64Url, PROTOCOL_VERSION,
  type Message, type PairOffer,
} from "../../src/protocol";
import { generateDhKeyPair, importDhKeyPair, SessionLink, signPairProof, type DhKeyPair, type SessionTransport } from "../../src/session";
import type { DeviceRecord } from "./device-store";

const PAIRING = { local: false, pairing: true } as const;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The keys one pairing attempt (and its retries with the same link) uses. */
export interface PairKeys {
  sign: CryptoKeyPair; signPub: string; dh: DhKeyPair; memberId: string;
  /** The X25519 private key's PKCS#8, only until it is sealed into the device store (device-store.ts says why). */
  dhPkcs8: Uint8Array;
}

export async function makePairKeys(): Promise<PairKeys> {
  const sign = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", sign.publicKey));
  // Made once extractable, for the seal only; the key in use is a non-extractable import of it.
  const made = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const dhPkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", made.privateKey));
  const dh = await importDhKeyPair(dhPkcs8);
  return { sign, signPub: toBase64Url(pub), dh, memberId: await memberIdFromKey(pub), dhPkcs8 };
}

/** Whether this browser has what pairing needs (v1 §3: Ed25519 and X25519 in WebCrypto, IndexedDB). */
export async function pairingSupported(): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return "This browser has no WebCrypto here (the page must be opened over HTTPS).";
  if (!globalThis.indexedDB) return "This browser cannot keep data for this page (IndexedDB is off).";
  try {
    await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    await generateDhKeyPair();
  } catch {
    return "This browser does not support the keys Botling 3 needs (Ed25519 and X25519). Update it and try again.";
  }
  return null;
}

export class PairingError extends Error {
  constructor(message: string, readonly reason: string) { super(message); }
}

export interface PairAttempt {
  /** The 6-digit code, once the handshake is done (show it; the user compares it with the server's). */
  readonly code: Promise<string>;
  /** The stored membership, after `pair.added` was saved and acknowledged. */
  readonly done: Promise<DeviceRecord>;
  /** The codes differ: tell the server (it burns the offer). */
  decline(): void;
  cancel(): void;
}

export interface PairOptions {
  offer: PairOffer;
  keys: PairKeys;
  name: string;
  wsUrl: string;
  feVersion: string;
  /** Called with the membership before the ack is sent; must resolve once it is durable. */
  save: (record: DeviceRecord, dhPkcs8: Uint8Array) => Promise<void>;
  WebSocketImpl?: typeof WebSocket;
  /** The transport the handshake names: `relay` when WebSocketImpl is the relay socket (M2 step 13). */
  transport?: "tailnet" | "relay";
}

const DECLINED: Record<string, string> = {
  code: "The codes did not match, so the pairing was cancelled. Create a new pairing link on the computer.",
  expired: "This pairing link has expired. Create a new one on the computer.",
  used: "This pairing link was already used. Create a new one on the computer.",
  busy: "Another device is pairing with this link right now.",
  cancelled: "The pairing was cancelled on the computer.",
  unsupported: "The computer could not check this browser's key. Try again.",
};

export function pair(options: PairOptions): PairAttempt {
  const { offer, keys } = options;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  let resolveDone!: (record: DeviceRecord) => void;
  let rejectDone!: (error: Error) => void;
  const done = new Promise<DeviceRecord>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  code.catch(() => undefined);
  let finished = false;
  /** Set once the ack is on its way: the server ends the session as soon as it reads it (often before our drain
   * returns), and that end is the pairing's success, not a failure. */
  let acked: DeviceRecord | null = null;
  const succeed = (record: DeviceRecord) => {
    if (finished) return;
    finished = true;
    resolveDone(record);
    setTimeout(() => { try { link.close(); } catch { /* ended */ } }, 500);
  };
  const fail = (error: PairingError) => {
    if (finished) return;
    finished = true;
    rejectCode(error);
    rejectDone(error);
    try { link.close(); } catch { /* ended */ }
    try { ws.close(); } catch { /* closed */ }
  };

  const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
  const ws = new Impl(options.wsUrl);
  ws.binaryType = "arraybuffer";
  const queue: Uint8Array[] = [];
  const transport: SessionTransport = {
    send(frame) { if (ws.readyState === 1) ws.send(frame); else if (ws.readyState === 0) queue.push(frame.slice()); },
    close() { try { ws.close(); } catch { /* closed */ } },
  };
  const send = (message: Message) => {
    const encoded = encodeFrame(message, "fe", PAIRING);
    if (!encoded.ok) throw new Error(encoded.detail);
    if (link.state === "open") link.send("control", encoder.encode(encoded.text));
  };
  const link: SessionLink = SessionLink.initiate(transport, {
    mode: "pair", transport: options.transport ?? "tailnet", cluster: offer.cluster,
    self: { memberId: keys.memberId, dhPub: keys.dh.publicKey, dhKey: keys.dh.privateKey },
    responder: { memberId: offer.server, dhPub: fromBase64Url(offer.keys.dh)! },
    pair: { offer: offer.offer, secret: fromBase64Url(offer.secret)! },
  }, {
    onFrame: async (bytes) => {
      const decoded = decodeFrame(decoder.decode(bytes), "server", PAIRING);
      if (!decoded.ok) throw new Error(`the server sent a bad frame: ${decoded.detail}`);
      const message = decoded.message;
      if (message.t === "pair.declined") { fail(new PairingError(DECLINED[message.reason] ?? `The pairing ended: ${message.reason}.`, message.reason)); return; }
      if (message.t !== "pair.added") return;
      const add = message.add.body;
      if (add.type !== "add" || add.member !== keys.memberId || add.keys.sign !== keys.signPub || add.keys.dh !== toBase64Url(keys.dh.publicKey) || add.cluster !== offer.cluster || add.by !== offer.server) {
        fail(new PairingError("The computer answered with a membership for another device. Try again with a new link.", "mismatch"));
        return;
      }
      const addId = await statementId(add);
      const record: DeviceRecord = {
        v: 1, memberId: keys.memberId, name: add.name, signKey: keys.sign.privateKey, signPub: keys.signPub,
        dhKey: keys.dh.privateKey, dhPub: keys.dh.publicKey, cluster: offer.cluster,
        server: { memberId: offer.server, name: offer.name, dhPub: fromBase64Url(offer.keys.dh)! },
        addId, scope: [...(add.scope ?? [])], pairedAt: Date.now(),
        ...(offer.addresses.relay ? { relay: { url: offer.addresses.relay.url, room: offer.addresses.relay.room } } : {}),
      };
      // Durable first: an ack the server hears means this page can dial with these keys after any crash.
      await options.save(record, keys.dhPkcs8);
      acked = record;
      send({ t: "pair.ack", addId } as Message);
      await link.drain().catch(() => undefined);
      succeed(record);
    },
    onEnd: (end) => {
      if (finished) return;
      if (acked) { succeed(acked); return; }
      const reason = end.reason === "offer" ? "offer" : end.reason;
      fail(new PairingError(end.reason === "transport" || end.reason === "offer"
        ? "The computer did not take this pairing link (it may have expired, been used, or Botling is not running). Create a new one and try again."
        : `Pairing failed (${end.reason}). Try again.`, reason));
    },
  });
  ws.onopen = () => { for (const frame of queue.splice(0)) ws.send(frame); };
  ws.onmessage = (event) => { if (event.data instanceof ArrayBuffer) link.receive(new Uint8Array(event.data)); };
  ws.onclose = () => link.transportClosed();
  ws.onerror = () => undefined;

  link.established.then(async (info) => {
    const proof = await signPairProof(keys.sign.privateKey, info.transcriptHash);
    send({ t: "pair.hello", name: options.name.slice(0, 100) || "Phone", sign: keys.signPub, proof: toBase64Url(proof), feVersion: options.feVersion, protocol: PROTOCOL_VERSION } as Message);
    resolveCode(info.code);
  }, () => undefined);

  return {
    code, done,
    decline() { if (!finished) { send({ t: "pair.declined", reason: "code" } as Message); setTimeout(() => fail(new PairingError(DECLINED.code!, "code")), 200); } },
    cancel() { fail(new PairingError("Cancelled.", "cancelled")); },
  };
}
