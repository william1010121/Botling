import { describe, it, expect } from 'vitest';
import { TicketStore, TICKET_TTL_MS } from './tickets';

describe('event stream tickets', () => {
  it('are single use and bound to the client that asked', () => {
    const store = new TicketStore();
    const a = store.issue('pair-a')!, b = store.issue('pair-b')!;
    expect(a.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.redeem(b.ticket)).toBe('pair-b');
    expect(store.redeem(b.ticket)).toBeUndefined();
    expect(store.redeem(a.ticket)).toBe('pair-a');
  });
  it('expire after about thirty seconds', () => {
    let now = 1_000;
    const store = new TicketStore(() => now);
    const t = store.issue('pair-a')!;
    expect(t.expiresAt - now).toBe(TICKET_TTL_MS);
    expect(TICKET_TTL_MS).toBeLessThanOrEqual(30_000);
    now += TICKET_TTL_MS;
    expect(store.redeem(t.ticket)).toBeUndefined();
  });
  it('refuse junk, other tokens and too many at once; forget drops a client', () => {
    const store = new TicketStore();
    expect(store.redeem(undefined)).toBeUndefined();
    expect(store.redeem('short')).toBeUndefined();
    expect(store.redeem('z'.repeat(43))).toBeUndefined();
    const keep = store.issue('pair-a')!; store.forget('pair-a');
    expect(store.redeem(keep.ticket)).toBeUndefined();
    for (let i = 0; i < 64; i++) expect(store.issue('c')).not.toBeNull();
    expect(store.issue('c')).toBeNull();
  });
});
