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

interface SourceLike { addEventListener(name: string, fn: (event: { data: string }) => void): void; onerror: ((event?: unknown) => void) | null; close(): void }
export interface WatchOptions {
  /** The route in use now (it can change between reconnects). */
  origin: () => string;
  /** A fresh ticket for the stream (single use, so every connection asks again). */
  ticket: () => Promise<string>;
  /** Something changed on the core: read again. */
  onChange: () => void;
  /** Whether the stream is up (reading can be slow and rely on it) or down (read often). */
  onLive: (live: boolean) => void;
  /** After a failure to connect: look for another route. */
  recover?: () => Promise<unknown>;
  source?: new (url: string, init?: { withCredentials?: boolean }) => SourceLike;
}
const WAITS = [1_000, 3_000, 10_000, 30_000];

/** Keeps the event stream open for as long as it is not stopped. The ticket makes the address, nothing else does; when the
 * stream drops, a new ticket is asked for (with growing waits). Stops for good when the session itself is gone. */
export function watchEvents(options: WatchOptions): () => void {
  let stopped = false, source: SourceLike | null = null, timer: ReturnType<typeof setTimeout> | undefined, failures = 0, live = false;
  const setLive = (value: boolean) => { if (live !== value) { live = value; options.onLive(value); } };
  const retry = () => { if (!stopped) timer = setTimeout(() => { void open(); }, WAITS[Math.min(failures++, WAITS.length - 1)]); };
  const open = async () => {
    if (stopped) return;
    const Source = options.source ?? (typeof EventSource !== 'undefined' ? EventSource as unknown as NonNullable<WatchOptions['source']> : undefined);
    if (!Source) return; // no event stream in this browser: the caller keeps polling
    let ticket: string;
    try { ticket = await options.ticket(); }
    catch (error) {
      if (error instanceof MobileError && (error.auth || error.revoked)) { stopped = true; return; }
      setLive(false); await options.recover?.().catch(() => undefined); retry(); return;
    }
    if (stopped) return;
    const current = new Source(eventsURL(options.origin(), ticket), { withCredentials: false });
    source = current;
    current.addEventListener('ready', () => { failures = 0; setLive(true); });
    current.addEventListener('changed', () => { if (!stopped) options.onChange(); });
    current.onerror = () => { current.close(); if (source === current) source = null; setLive(false); retry(); };
  };
  void open();
  return () => { stopped = true; clearTimeout(timer); source?.close(); source = null; };
}
