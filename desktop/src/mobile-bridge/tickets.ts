/** Short-lived, single-use tickets for the event stream. A browser's EventSource cannot send an Authorization
 * header, so the stream would otherwise need the long-lived bearer token in its URL (which lands in logs and
 * history). Instead the phone asks for a ticket with its bearer token, then opens the stream with the ticket:
 * valid ~30 seconds, usable once, bound to the client that asked. Held in memory only (a restart voids them),
 * only SHA-256 hashes are kept, and nothing here logs. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TICKET_TTL_MS = 30_000;
const MAX_LIVE = 64;
export const TICKET = /^[A-Za-z0-9_-]{43}$/;
const sha = (text: string) => createHash('sha256').update(text).digest();

export class TicketStore {
  private live: { hash: Buffer; clientId: string; expiresAt: number }[] = [];
  constructor(private now: () => number = Date.now) {}
  private prune() { const now = this.now(); this.live = this.live.filter(t => t.expiresAt > now); }
  /** Null when too many are outstanding (a phone does not need more than a few). */
  issue(clientId: string): { ticket: string; expiresAt: number } | null {
    this.prune();
    if (this.live.length >= MAX_LIVE) return null;
    const ticket = randomBytes(32).toString('base64url'), expiresAt = this.now() + TICKET_TTL_MS;
    this.live.push({ hash: sha(ticket), clientId, expiresAt });
    return { ticket, expiresAt };
  }
  /** The client that asked, or undefined. The ticket is spent whether or not anything else goes wrong. */
  redeem(ticket: unknown): string | undefined {
    this.prune();
    if (typeof ticket !== 'string' || !TICKET.test(ticket)) return undefined;
    const digest = sha(ticket);
    let found = -1;
    this.live.forEach((t, i) => { if (timingSafeEqual(digest, t.hash)) found = i; }); // every entry compared
    if (found < 0) return undefined;
    const [spent] = this.live.splice(found, 1);
    return spent.clientId;
  }
  /** Drops what a client holds (its session was revoked). */
  forget(clientId: string) { this.live = this.live.filter(t => t.clientId !== clientId); }
}
