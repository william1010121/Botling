// Remote workers over the relay (multi-machine phase 1, M2): what Botling and botling-agent say to each other through
// the relay (relay/src/relay.ts). Botling is the desk of its own "machines" room (its own room key, apart from the
// phone room); each machine's agent joins as a phone. The relay only moves end-to-end encrypted strings
// (mobile-relay/e2e.ts: X25519, three DH, HKDF, AES-GCM, strict counters).
//
// Pairing (device code): Botling makes an offer (relay address, room, Botling's static key, a one-time secret, an
// expiry) that the install line carries to the machine. The agent joins with the token derived from the secret and
// sends its name and static key; both sides derive the channel with the secret mixed in, so only the holder of the
// install line can finish it. Both show a short code computed from the channel (SAS): Botling lists the request with
// the machine's name and fingerprint, and the user types the code the machine printed. Only then does Botling send
// the machine its long-lived token (whose hash it puts on the room's allow list).
//
//   agent → Botling (plain)   {h:'mpair', v, offer, key, eph, name, platform}   pairing
//                             {h:'mhello', v, id, eph}                         a session (the agent's daemon)
//   Botling → agent (plain)   {h:'mack', eph} | {h:'nope', why}
//   then sealed values        pairing: {p:'granted', token, name} | {p:'declined'} ← → {p:'saved'}
//                             session: {m: [[link, frame] | [link, 0 (open)] | [link, 1 (close)], ...]}
//
// Links are the transport's connections (RemoteWorker.tla's connection numbers): each is one AgentLink in the daemon,
// as an ssh process is on the ssh path. Frames are batched: the relay allows 50 messages a second per connection.
import { b64u, deviceIdOf, sha256, type Channel } from "../../mobile-relay/e2e";

export const MACHINE_OFFER_PREFIX = "botling-machine1.";
export const MACHINE_WIRE = 1;
export const PAIR_TTL_MS = 10 * 60_000;

export interface MachineOffer {
  /** The relay address (wss://…/ws). */
  u: string;
  /** The room id (SHA-256 of Botling's machines room key). */
  r: string;
  /** Botling's static public key (base64url). */
  k: string;
  /** The one-time secret (base64url, 32 bytes). */
  s: string;
  /** When the offer ends (ms). */
  e: number;
}

export function encodeOffer(offer: MachineOffer): string { return MACHINE_OFFER_PREFIX + Buffer.from(JSON.stringify(offer)).toString("base64url"); }

export function decodeOffer(text: string): MachineOffer {
  const raw = text.trim();
  if (!raw.startsWith(MACHINE_OFFER_PREFIX)) throw new Error("That is not a Botling pairing code (it starts with botling-machine1.).");
  let offer: MachineOffer;
  try { offer = JSON.parse(Buffer.from(raw.slice(MACHINE_OFFER_PREFIX.length), "base64url").toString("utf8")); } catch { throw new Error("The pairing code is damaged."); }
  const b64 = (v: unknown, len: number) => typeof v === "string" && v.length === len && /^[A-Za-z0-9_-]+$/.test(v);
  if (!offer || typeof offer.u !== "string" || !/^wss?:\/\//.test(offer.u) || !b64(offer.r, 43) || !b64(offer.k, 43) || !b64(offer.s, 43) || !Number.isSafeInteger(offer.e)) {
    throw new Error("The pairing code is damaged.");
  }
  return offer;
}

/** The short code both sides show for a pairing (from the channel, so it differs for every attempt). */
export async function sasOf(channel: Channel): Promise<string> {
  const digest = await sha256(new TextEncoder().encode(`botling-machine/sas|${channel.session}`));
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I
  let bits = 0, value = 0, out = "";
  for (const byte of digest) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5 && out.length < 8) { out += alphabet[(value >> (bits - 5)) & 31]; bits -= 5; }
    if (out.length >= 8) break;
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** What the user types: case and separators do not matter. */
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");

/** A machine's fingerprint: its static key's id (as the phone path's device id), shown in groups. */
export async function fingerprintOf(publicKey: Uint8Array): Promise<string> { return deviceIdOf(publicKey); }
export const showFingerprint = (fp: string) => fp.replace(/(.{4})(?=.)/g, "$1 ");

export const decodeKey = (text: string) => b64u.decode(text);

/** A machine's name as Settings › Machines takes it (MACHINE_NAME), from whatever the machine calls itself. */
export function machineNameFrom(raw: string): string {
  const clean = raw.trim().replace(/[^A-Za-z0-9_.@-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  return clean || "machine";
}

// ---- Sending over a channel without exceeding the relay's message rate.

/** A token bucket for messages on one relay socket (the relay closes a socket that exceeds 50/s, burst 200). */
export class Pacer {
  private tokens: number;
  private at: number;
  constructor(private rate = 40, private burst = 120, private now: () => number = Date.now) { this.tokens = burst; this.at = now(); }
  private fill() { const t = this.now(); this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.rate); this.at = t; }
  take(): boolean { this.fill(); if (this.tokens < 1) return false; this.tokens -= 1; return true; }
  /** How long until a message may go (ms). */
  wait(): number { this.fill(); return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1000); }
}

export type MuxItem = [number, unknown];
export const MUX_OPEN = 0;
export const MUX_CLOSE = 1;
const MAX_BATCH = 1024 * 1024;

/**
 * One channel's outgoing side: link frames queue here and leave in batches, sealed in order. A frame larger than a
 * batch goes alone (blob chunks are 512 KiB, the relay takes 4 MiB).
 */
export class MuxSender {
  private queue: { item: MuxItem; size: number }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  constructor(private channel: Channel, private send: (sealed: string) => void, private pacer: Pacer, private delayMs = 5) {}

  push(item: MuxItem) {
    if (this.closed) return;
    this.queue.push({ item, size: JSON.stringify(item).length + 1 });
    this.schedule(this.delayMs);
  }

  private schedule(ms: number) {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, ms);
  }

  private flush() {
    while (this.queue.length && !this.closed) {
      if (!this.pacer.take()) { this.schedule(Math.max(5, this.pacer.wait())); return; }
      const batch: MuxItem[] = [];
      let size = 0;
      while (this.queue.length && (batch.length === 0 || size + this.queue[0]!.size <= MAX_BATCH)) {
        const next = this.queue.shift()!;
        batch.push(next.item);
        size += next.size;
      }
      this.channel.seal({ m: batch }).then((sealed) => { if (!this.closed) this.send(sealed); }, () => { /* the channel closed */ });
    }
  }

  close() { this.closed = true; this.queue = []; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}

/** The items of a received session message (anything else is not ours). */
export function muxItems(value: unknown): MuxItem[] {
  const m = (value as { m?: unknown })?.m;
  if (!Array.isArray(m)) return [];
  return m.filter((x): x is MuxItem => Array.isArray(x) && x.length === 2 && Number.isSafeInteger(x[0]) && (x[0] as number) > 0);
}
