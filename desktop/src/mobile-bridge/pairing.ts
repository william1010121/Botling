/** One-time QR pairing for the phone bridge. Local setup mints an offer (a random secret that lives only in a
 * QR/URL fragment); the phone redeems it once for an ordinary bearer token. A paired client is the same
 * record a hand-issued token has (explicit bot list, 30 days), so pairing grants nothing a token did not.
 * Only SHA-256 hashes are stored. State is files under an owner-only directory, shared by the bridge and the
 * local `pair` command, changed under a file lock. Nothing here logs.
 *
 * A phone that asks for it (`ack`) acknowledges its token (ack()). Until then its offer stays in the offers file,
 * held for that token until PAIR_ACK_MS (`held`; `expiresAt` 0, so a store from before acks, during a hand-over,
 * never matches it); the phone's record is written as usual but is not served once the hold's deadline passed.
 * The ack removes the hold: one write, and the pairing is final. A redeem that finds a hold past its deadline
 * first removes that phone's record, then lists the offer again (until its own TTL). spec/models/relaypair/LanPair.tla. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '../contract';
import { withFileLock, writeFileAtomic } from '../core/durable/atomic';
import type { Client } from './bridge';
import { ALL_BOTS } from './scope';

export const PAIR_TTL_MS = 5 * 60_000;
/** How long a phone that asked to acknowledge its token has to do it. */
export const PAIR_ACK_MS = 30_000;
const PAIRED_TTL_MS = 30 * 86_400_000; // as `setup.mjs issue`
const MAX_PENDING = 5;
const FAIL_LIMIT = 5, FAIL_WINDOW_MS = 60_000;
export const SECRET = /^[A-Za-z0-9_-]{43}$/;
export const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const BOT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const sha = (text: string) => createHash('sha256').update(text).digest();

interface Offer { secretHash: string; botIds: string[]; expiresAt: number; held?: { tokenHash: string; until: number; expiresAt: number } }
/** `ack`: the phone must acknowledge the token (ack()) before PAIR_ACK_MS, or the pairing is undone. */
export type Redeemed = { ok: true; token: string; expiresAt: number; coreId: string; ack?: true } | { ok: false; reason: 'invalid' | 'limited' };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** A way to reach this core, in the order a phone should try. Only routes the user configured are listed. */
export interface Route { kind: 'lan' | 'tailscale' | 'tunnel'; origin: string }
export interface CoreDescriptor { app: 'botling'; coreId: string; protocol: typeof PROTOCOL_VERSION; routes: Route[]; pairing: { ttlSeconds: number } }
/** A paired phone as the desktop lists it. The id is the device id (never the token or its hash). */
export interface Device { id: string; label: string; pairedAt: number; expiresAt: number; botIds: string[] }
const label = (value: unknown) => typeof value === 'string' ? value.replace(/[^\p{L}\p{N} ._()-]/gu, '').trim().slice(0, 40) : '';

export const pairingURL = (origin: string, coreId: string, secret: string) => `${origin}/mobile/#pair=${secret}&core=${coreId}`;

export class PairingStore {
  private failures: number[] = [];
  constructor(private dir: string, private now: () => number = Date.now, private routes: Route[] = []) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = statSync(dir);
    if (!stat.isDirectory() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('Pairing directory must be owner-only.');
  }
  private file(name: string) { return join(this.dir, name); }
  private read<T>(name: string, fallback: T): T {
    const file = this.file(name);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : fallback;
  }
  /** Public, stable per core: lets a phone check it reached the Botling that showed the QR. Holds no secret. */
  coreId(): string {
    const file = this.file('core-id.json');
    return withFileLock(file, () => {
      const saved = this.read<{ coreId?: string }>('core-id.json', {}).coreId;
      if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved;
      const coreId = randomBytes(16).toString('hex');
      writeFileAtomic(file, JSON.stringify({ coreId }));
      return coreId;
    });
  }
  descriptor(): CoreDescriptor {
    return { app: 'botling', coreId: this.coreId(), protocol: PROTOCOL_VERSION, routes: this.routes.map(r => ({ ...r })), pairing: { ttlSeconds: PAIR_TTL_MS / 1000 } };
  }
  /** Local setup only. Returns the secret once; it is not recoverable afterwards. Without bot ids the phone gets every
   * bot (`*`, resolved by the core on each request, so bots added later too). */
  createOffer(botIds: string[] = [ALL_BOTS]): { secret: string; expiresAt: number } {
    if (botIds.includes(ALL_BOTS)) botIds = [ALL_BOTS];
    else if (!botIds.length || botIds.some(id => !BOT_ID.test(id))) throw new Error('Explicit bot IDs required.');
    const file = this.file('pairing-offers.json');
    return withFileLock(file, () => {
      const now = this.now();
      const offers = this.read<Offer[]>('pairing-offers.json', []).filter(o => o.held || o.expiresAt > now);
      if (offers.filter(o => !o.held).length >= MAX_PENDING) throw new Error('Too many pending pairing codes; wait for them to expire.');
      const secret = randomBytes(32).toString('base64url');
      const offer = { secretHash: sha(secret).toString('hex'), botIds: [...botIds], expiresAt: now + PAIR_TTL_MS };
      writeFileAtomic(file, JSON.stringify([...offers, offer]));
      return { secret, expiresAt: offer.expiresAt };
    });
  }
  /** Unknown, used, expired and malformed all fail the same way. Wrong guesses are counted and, past the limit,
   * answered 'limited'. The limit is global (behind a tunnel every request has one address) and applies only to
   * wrong guesses: a valid code is still honored, so a stranger's junk cannot lock the owner out. The code has
   * 256 bits, so throttling is about noise, not about guessing. */
  redeem(secret: unknown, deviceId: unknown, name?: unknown, ack = false): Redeemed {
    const now = this.now();
    this.failures = this.failures.filter(t => now - t < FAIL_WINDOW_MS);
    const limited = this.failures.length >= FAIL_LIMIT;
    const fail = (): Redeemed => { if (!limited) this.failures.push(now); return { ok: false, reason: limited ? 'limited' : 'invalid' }; };
    if (typeof secret !== 'string' || !SECRET.test(secret) || typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return fail();
    const offersFile = this.file('pairing-offers.json');
    const pairedFile = this.file('paired-clients.json');
    const result = withFileLock(offersFile, () => {
      const read = this.read<Offer[]>('pairing-offers.json', []);
      // Holds whose phone did not acknowledge in time: that phone's record goes first (so a crash before the
      // offers are written never leaves it served), then the offer is listed again.
      const late = new Set(read.filter(o => o.held && o.held.until <= now).map(o => o.held!.tokenHash));
      if (late.size) withFileLock(pairedFile, () => {
        const all = this.read<Client[]>('paired-clients.json', []);
        const kept = all.filter(c => !late.has(c.tokenHash));
        if (kept.length !== all.length) writeFileAtomic(pairedFile, JSON.stringify(kept));
      });
      const offers = read.map(o => o.held && late.has(o.held.tokenHash) ? { secretHash: o.secretHash, botIds: o.botIds, expiresAt: o.held.expiresAt } : o);
      const digest = sha(secret);
      let match: Offer | undefined;
      // Compare against every offer so timing does not reveal which (if any) matched.
      for (const offer of offers) if (timingSafeEqual(digest, Buffer.from(offer.secretHash, 'hex')) && !offer.held && offer.expiresAt > now) match = offer;
      const live = offers.filter(o => (o.held || o.expiresAt > now) && o !== match);
      const token = match && randomBytes(32).toString('base64url');
      if (match && ack) live.push({ secretHash: match.secretHash, botIds: match.botIds, expiresAt: 0, held: { tokenHash: sha(token!).toString('hex'), until: now + PAIR_ACK_MS, expiresAt: match.expiresAt } });
      // Single use (or held for this phone), before issuing.
      if (late.size || live.length !== read.length || match) writeFileAtomic(offersFile, JSON.stringify(live));
      if (!match || !token) return null;
      const client: Client = { id: `pair-${deviceId}`, tokenHash: sha(token).toString('hex'), botIds: match.botIds, expiresAt: now + PAIRED_TTL_MS,
        pairedAt: now, label: label(name) || undefined };
      withFileLock(pairedFile, () => {
        const others = this.read<Client[]>('paired-clients.json', []).filter(c => c.id !== client.id && c.expiresAt > now);
        writeFileAtomic(pairedFile, JSON.stringify([...others, client])); // one session per device
      });
      return { token, expiresAt: client.expiresAt };
    });
    return result ? { ok: true, ...result, coreId: this.coreId(), ...(ack ? { ack: true as const } : {}) } : fail();
  }
  /** The phone holds the token redeem() gave it: the pairing is final. False when it is too late (the deadline
   * passed, or the phone was revoked meanwhile): the phone scans the code again, which a later redeem lists again.
   * Asking again after a lost answer is true. */
  ack(token: unknown): boolean {
    if (typeof token !== 'string' || !TOKEN.test(token)) return false;
    const hash = sha(token).toString('hex');
    const offersFile = this.file('pairing-offers.json');
    return withFileLock(offersFile, () => {
      const now = this.now();
      const offers = this.read<Offer[]>('pairing-offers.json', []);
      // Read without the paired lock: no redeem runs (this holds the offers lock), so only a revoke may change it.
      const listed = this.read<Client[]>('paired-clients.json', []).some(c => c.tokenHash === hash && c.expiresAt > now);
      const held = offers.find(o => o.held?.tokenHash === hash);
      if (!held) return listed;
      if (held.held!.until <= now || !listed) return false;
      writeFileAtomic(offersFile, JSON.stringify(offers.filter(o => o !== held)));
      return true;
    });
  }
  /** Paired phones, newest first. Local setup only: a phone never lists or revokes another phone. */
  devices(): Device[] {
    return this.clients().filter(c => c.id.startsWith('pair-'))
      .map(c => ({ id: c.id.slice(5), label: c.label ?? '', pairedAt: c.pairedAt ?? 0, expiresAt: c.expiresAt, botIds: [...c.botIds] }))
      .sort((a, b) => b.pairedAt - a.pairedAt);
  }
  /** Ends a paired phone's session at once (the bridge re-reads clients on every request). Returns whether one existed. */
  revoke(deviceId: string): boolean {
    if (!DEVICE_ID.test(deviceId)) return false;
    const file = this.file('paired-clients.json');
    return withFileLock(file, () => {
      const all = this.read<Client[]>('paired-clients.json', []);
      const kept = all.filter(c => c.id !== `pair-${deviceId}`);
      if (kept.length === all.length) return false;
      writeFileAtomic(file, JSON.stringify(kept));
      return true;
    });
  }
  /** Paired sessions still valid; the bridge merges these with the hand-issued clients file. A phone whose ack did
   * not come in time is left out (the offers are read first: a redeem removes its record before listing its offer
   * again, so either read finds it gone). */
  clients(): Client[] {
    const now = this.now();
    try {
      const late = new Set(this.read<Offer[]>('pairing-offers.json', []).filter(o => o.held && o.held.until <= now).map(o => o.held!.tokenHash));
      return this.read<Client[]>('paired-clients.json', []).filter(c => c.expiresAt > now && !late.has(c.tokenHash));
    } catch { return []; }
  }
}
