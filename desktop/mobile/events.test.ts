import { describe, it, expect, vi } from 'vitest';
import { eventsURL, requestTicket } from './events';

const TICKET = 'T'.repeat(43), TOKEN = 'K'.repeat(43);
describe('event stream ticket', () => {
  it('asks with the bearer token in a header, and the stream address carries only the ticket', async () => {
    const fetcher = vi.fn(async (_url: any, init: any) => {
      expect(init.method).toBe('POST'); expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`); expect(init.credentials).toBe('omit');
      return new Response(JSON.stringify({ ticket: TICKET, expiresAt: 1 }));
    }) as unknown as typeof fetch;
    const ticket = await requestTicket('https://h.example', TOKEN, fetcher);
    expect(ticket).toBe(TICKET);
    const url = eventsURL('https://h.example', ticket);
    expect(url).toBe(`https://h.example/api/mobile/events?ticket=${TICKET}`);
    expect(url).not.toContain(TOKEN);
  });
  it('reports a lost session, a missing stream and malformed answers without echoing secrets', async () => {
    const reply = (r: Response) => (async () => r) as unknown as typeof fetch;
    await expect(requestTicket('https://h.example', TOKEN, reply(new Response('{}', { status: 401 })))).rejects.toMatchObject({ auth: true });
    await expect(requestTicket('https://h.example', TOKEN, reply(new Response(JSON.stringify({ ticket: 'short' }))))).rejects.toThrow(/unavailable/);
    await expect(requestTicket('https://h.example', TOKEN, (async () => { throw new TypeError(TOKEN); }) as unknown as typeof fetch)).rejects.not.toThrow(TOKEN);
  });
});
