import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eventsURL, requestTicket, watchEvents } from './events';
import { MobileError } from './transport';

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

class FakeSource {
  static all: FakeSource[] = [];
  listeners = new Map<string, (e: any) => void>(); closed = false; onerror: (() => void) | null = null;
  constructor(public url: string, public init?: unknown) { FakeSource.all.push(this); }
  addEventListener(name: string, fn: (e: any) => void) { this.listeners.set(name, fn); }
  emit(name: string, data = '{}') { this.listeners.get(name)?.({ data }); }
  close() { this.closed = true; }
}
describe('watching the event stream', () => {
  beforeEach(() => { FakeSource.all = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const flush = async () => { for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0); };
  const base = (over: Record<string, unknown> = {}) => {
    const seen = { changes: 0, live: [] as boolean[] };
    let n = 0;
    const options = { origin: () => 'https://h.example', ticket: vi.fn(async () => `${String(++n).padStart(43, 'T')}`), source: FakeSource as any,
      onChange: () => { seen.changes++; }, onLive: (v: boolean) => { seen.live.push(v); }, ...over };
    return { seen, options };
  };
  it('opens the stream with a ticket, reports live, and wakes the reader on every change', async () => {
    const { seen, options } = base();
    const stop = watchEvents(options as any);
    await flush();
    expect(FakeSource.all).toHaveLength(1);
    expect(FakeSource.all[0].url).toBe(`https://h.example/api/mobile/events?ticket=${'1'.padStart(43, 'T')}`);
    expect(FakeSource.all[0].url).not.toContain('Bearer');
    expect(FakeSource.all[0].init).toMatchObject({ withCredentials: false });
    FakeSource.all[0].emit('ready'); FakeSource.all[0].emit('changed', '{"seq":4}'); FakeSource.all[0].emit('changed', '{"seq":5}');
    expect(seen.live).toEqual([true]); expect(seen.changes).toBe(2);
    stop(); expect(FakeSource.all[0].closed).toBe(true);
  });
  it('asks for a fresh ticket after a drop (a ticket is single use), with growing waits, and reports not live meanwhile', async () => {
    const { seen, options } = base();
    const stop = watchEvents(options as any);
    await flush(); FakeSource.all[0].emit('ready');
    FakeSource.all[0].onerror!();
    expect(FakeSource.all[0].closed).toBe(true); expect(seen.live).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(500); expect(FakeSource.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000); expect(FakeSource.all).toHaveLength(2);
    expect(options.ticket).toHaveBeenCalledTimes(2);
    expect(FakeSource.all[1].url).not.toBe(FakeSource.all[0].url);
    stop();
  });
  it('stops for good when the session is gone, and keeps trying when only the network is', async () => {
    const lost = base({ ticket: vi.fn(async () => { throw new MobileError('gone', true); }) });
    watchEvents(lost.options as any); await flush(); await vi.advanceTimersByTimeAsync(120_000);
    expect(lost.options.ticket).toHaveBeenCalledTimes(1); expect(FakeSource.all).toHaveLength(0);
    let fail = true;
    const flaky = base({ ticket: vi.fn(async () => { if (fail) throw new MobileError('offline'); return 'F'.repeat(43); }) });
    const stop = watchEvents(flaky.options as any); await flush(); fail = false;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(FakeSource.all.length).toBe(1); stop();
  });
  it('does nothing after it was stopped', async () => {
    const { options } = base();
    const stop = watchEvents(options as any); stop(); await flush();
    expect(FakeSource.all).toHaveLength(0);
  });
});
