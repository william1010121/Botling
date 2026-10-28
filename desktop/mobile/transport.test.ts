import { describe, expect, it, vi } from 'vitest';
import { MobileError, MobileTransport, endpointURL } from './transport';
import { PROTOCOL_VERSION } from '../src/contract';
const endpoint = new URL('https://bot.test/api/mobile/command');
const fixture = (botId = 'main') => ({ epoch: 'epoch', seq: 1, bots: [{ id: 'main', name: 'Main', role: 'main', working: false, approvals: 0, unread: 0, problem: null, heads: ['claude'] }], chat: { botId, messages: [], tasks: [] } });
function answer(result: unknown, change: Record<string, unknown> = {}) {
  return vi.fn(async (_url: unknown, init: RequestInit) => new Response(JSON.stringify({ v: PROTOCOL_VERSION, id: JSON.parse(init.body as string).id, ok: true, result, ...change }), { headers: { 'content-type': 'application/json' } }));
}
describe('mobile authentication and protocol', () => {
  it('uses same-origin HTTPS; refuses cross-origin, credential, query, fragment and insecure endpoints', () => {
    expect(endpointURL('', 'https://bot.test').href).toBe(endpoint.href);
    expect(endpointURL('', 'http://127.0.0.1:8000').protocol).toBe('http:');
    for (const url of ['https://other.test/api', 'https://user:pass@bot.test/api', '/api?token=secret', '/api#secret']) expect(() => endpointURL(url, 'https://bot.test')).toThrow(MobileError);
    expect(() => endpointURL('', 'http://192.168.1.2:8000')).toThrow('HTTPS');
  });
  it('sends existing command envelopes with bearer header, no cookies, no cache and no redirects', async () => {
    const fetcher = answer(fixture()); const client = new MobileTransport(endpoint, 'test-token', fetcher as typeof fetch);
    expect((await client.snapshot()).chat?.botId).toBe('main');
    const init = fetcher.mock.calls[0][1];
    expect(init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Authorization: 'Bearer test-token' } });
    expect(JSON.parse(init.body as string)).toMatchObject({ v: PROTOCOL_VERSION, cmd: { type: 'chat.snapshot' } });
    expect(endpoint.search).toBe('');
  });
  it.each([401, 403])('reports HTTP %i as authentication failure', async status => {
    const client = new MobileTransport(endpoint, 'test', async () => new Response('', { status }));
    await expect(client.snapshot()).rejects.toMatchObject({ auth: true });
  });
  it('rejects mismatched response ids and versions', async () => {
    for (const change of [{ id: 'wrong' }, { v: 999 }]) {
      const client = new MobileTransport(endpoint, 'test', answer(fixture(), change) as typeof fetch);
      await expect(client.snapshot()).rejects.toThrow();
    }
  });
  it('validates snapshot data and selected chat identity', async () => {
    for (const result of [{}, fixture('other')]) {
      const client = new MobileTransport(endpoint, 'test', answer(result) as typeof fetch);
      await expect(client.snapshot('main')).rejects.toThrow();
    }
  });
  it('invokes browser fetch without binding it to the transport', async () => {
    const fetcher = function(this: unknown, _url: unknown, init: RequestInit) {
      expect(this).toBeUndefined();
      return Promise.resolve(new Response(JSON.stringify({ v: PROTOCOL_VERSION, id: JSON.parse(init.body as string).id, ok: true, result: fixture() })));
    };
    await new MobileTransport(endpoint, 'test', fetcher as typeof fetch).snapshot();
  });
  it('does not retry ambiguous sends', async () => {
    const fetcher = vi.fn(async () => { throw new TypeError('network'); });
    const client = new MobileTransport(endpoint, 'test', fetcher);
    await expect(client.request({ type: 'chat.send', botId: 'main', text: 'hello' })).rejects.toMatchObject({ uncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('preserves send/reply and choice commands exactly', async () => {
    for (const cmd of [{ type: 'chat.send', botId: 'main', text: 'hello', replyTo: 'reply', to: 'codex' }, { type: 'chat.choose', botId: 'main', messageId: 'question', index: 1 }] as const) {
      const fetcher = answer(cmd.type === 'chat.send' ? { messageId: 'sent', turnId: null } : { accepted: true });
      const client = new MobileTransport(endpoint, 'test', fetcher as typeof fetch);
      await client.request(cmd); expect(JSON.parse(fetcher.mock.lastCall![1].body as string).cmd).toEqual(cmd);
    }
  });
  it('does not acknowledge a malformed send result', async () => {
    const client = new MobileTransport(endpoint, 'test', answer({}) as typeof fetch);
    await expect(client.request({ type: 'chat.send', botId: 'main', text: 'hello' })).rejects.toMatchObject({ uncertain: true });
  });
  it('does not treat an unaccepted question answer as success', async () => {
    const client = new MobileTransport(endpoint, 'test', answer({ accepted: false }) as typeof fetch);
    await expect(client.request({ type: 'chat.answer', botId: 'main', messageId: 'question', text: 'my answer' })).rejects.toThrow('no longer accepting');
  });
  it('disconnect aborts in-flight reads and prevents later sends', async () => {
    let signal: AbortSignal | undefined;
    const client = new MobileTransport(endpoint, 'test', ((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => { signal = init.signal!; signal.addEventListener('abort', () => reject(new Error('aborted'))); })) as typeof fetch);
    const pending = client.snapshot(); client.close();
    expect(signal?.aborted).toBe(true); await expect(pending).rejects.toThrow();
    await expect(client.request({ type: 'chat.send', botId: 'main', text: 'hello' })).rejects.toThrow('Disconnected');
  });
  it('times out a stalled request without retrying', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn((_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))));
      const client = new MobileTransport(endpoint, 'test', fetcher as typeof fetch);
      const result = expect(client.snapshot()).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15000); await result; expect(fetcher).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
