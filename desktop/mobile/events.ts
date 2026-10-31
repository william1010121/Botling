// The event stream's sign-in, phone side. A browser EventSource cannot send an Authorization header, so the long-lived
// token must not go in its URL. Ask for a ticket with the token (a normal bearer request), then open the stream
// with the ticket: valid about 30 seconds, usable once.
import { MobileError, endpointURL, mobileGeneration } from './transport';

export async function requestTicket(origin: string, token: string, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(endpointURL('/api/mobile/ticket', origin), { method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
    headers: { ...mobileGeneration(), Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!response) throw new MobileError('Could not reach Botling.');
  if (response.status === 401) throw new MobileError('Your session expired or is unavailable. Connect again.', true);
  const body = response.ok ? await response.json().catch(() => null) : null;
  if (!body || typeof body.ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.ticket)) throw new MobileError('The event stream is unavailable.');
  return body.ticket;
}
/** The stream address for one ticket. The ticket is the only thing in it. */
export const eventsURL = (origin: string, ticket: string) => `${endpointURL('/api/mobile/events', origin).href}?ticket=${encodeURIComponent(ticket)}`;
