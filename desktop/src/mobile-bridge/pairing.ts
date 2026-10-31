/** One-time QR pairing for the phone bridge. Local setup mints an offer (a random secret that lives only in a
 * QR/URL fragment); the phone redeems it once for an ordinary bearer token. A paired client is the same
 * record a hand-issued token has (explicit bot list, 30 days), so pairing grants nothing a token did not.
 * Only SHA-256 hashes are stored. State is files under an owner-only directory, shared by the bridge and the
 * local `pair` command, changed under a file lock. Nothing here logs. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '../contract';
import { withFileLock, writeFileAtomic } from '../core/durable/atomic';
import type { Client } from './bridge';

export const PAIR_TTL_MS = 5 * 60_000;
const PAIRED_TTL_MS = 30 * 86_400_000; // as `setup.mjs issue`
const MAX_PENDING = 5;
const FAIL_LIMIT = 5, FAIL_WINDOW_MS = 60_000;
export const SECRET = /^[A-Za-z0-9_-]{43}$/;
export const DEVICE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const BOT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const sha = (text: string) => createHash('sha256').update(text).digest();

interface Offer { secretHash: string; botIds: string[]; expiresAt: number }
export type Redeemed = { ok: true; token: string; expiresAt: number; coreId: string } | { ok: false; reason: 'invalid' | 'limited' };
export interface CoreDescriptor { app: 'botling'; coreId: string; protocol: typeof PROTOCOL_VERSION; pairing: { ttlSeconds: number } }

export const pairingURL = (origin: string, coreId: string, secret: string) => `${origin}/mobile/#pair=${secret}&core=${coreId}`;

export class PairingStore {
  private failures: number[] = [];
  constructor(private dir: string, private now: () => number = Date.now) {
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
    return { app: 'botling', coreId: this.coreId(), protocol: PROTOCOL_VERSION, pairing: { ttlSeconds: PAIR_TTL_MS / 1000 } };
  }
  /** Local setup only. Returns the secret once; it is not recoverable afterwards. */
  createOffer(botIds: string[]): { secret: string; expiresAt: number } {
    if (!botIds.length || botIds.some(id => !BOT_ID.test(id))) throw new Error('Explicit bot IDs required.');
    const file = this.file('pairing-offers.json');
    return withFileLock(file, () => {
      const now = this.now();
      const offers = this.read<Offer[]>('pairing-offers.json', []).filter(o => o.expiresAt > now);
      if (offers.length >= MAX_PENDING) throw new Error('Too many pending pairing codes; wait for them to expire.');
      const secret = randomBytes(32).toString('base64url');
      const offer = { secretHash: sha(secret).toString('hex'), botIds: [...botIds], expiresAt: now + PAIR_TTL_MS };
      writeFileAtomic(file, JSON.stringify([...offers, offer]));
      return { secret, expiresAt: offer.expiresAt };
    });
  }
  /** Unknown, used, expired and malformed all fail the same way; failures are limited globally (the bridge
   * sits behind a tunnel, so a per-address limit would see one address). */
  redeem(secret: unknown, deviceId: unknown): Redeemed {
    const now = this.now();
    this.failures = this.failures.filter(t => now - t < FAIL_WINDOW_MS);
    if (this.failures.length >= FAIL_LIMIT) return { ok: false, reason: 'limited' };
    const fail = (): Redeemed => { this.failures.push(now); return { ok: false, reason: 'invalid' }; };
    if (typeof secret !== 'string' || !SECRET.test(secret) || typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return fail();
    const offersFile = this.file('pairing-offers.json');
    const pairedFile = this.file('paired-clients.json');
    const result = withFileLock(offersFile, () => {
      const offers = this.read<Offer[]>('pairing-offers.json', []);
      const digest = sha(secret);
      let match: Offer | undefined;
      // Compare against every offer so timing does not reveal which (if any) matched.
      for (const offer of offers) if (timingSafeEqual(digest, Buffer.from(offer.secretHash, 'hex')) && offer.expiresAt > now) match = offer;
      const live = offers.filter(o => o.expiresAt > now && o !== match);
      if (live.length !== offers.length) writeFileAtomic(offersFile, JSON.stringify(live)); // single use, before issuing
      if (!match) return null;
      const token = randomBytes(32).toString('base64url');
      const client: Client = { id: `pair-${deviceId}`, tokenHash: sha(token).toString('hex'), botIds: match.botIds, expiresAt: now + PAIRED_TTL_MS };
      withFileLock(pairedFile, () => {
        const others = this.read<Client[]>('paired-clients.json', []).filter(c => c.id !== client.id && c.expiresAt > now);
        writeFileAtomic(pairedFile, JSON.stringify([...others, client])); // one session per device
      });
      return { token, expiresAt: client.expiresAt };
    });
    return result ? { ok: true, ...result, coreId: this.coreId() } : fail();
  }
  /** Paired sessions still valid; the bridge merges these with the hand-issued clients file. */
  clients(): Client[] {
    const now = this.now();
    try { return this.read<Client[]>('paired-clients.json', []).filter(c => c.expiresAt > now); } catch { return []; }
  }
}
