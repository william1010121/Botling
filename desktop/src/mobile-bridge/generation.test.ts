import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMobileGeneration, generationBytes } from './generation';
import { handler, tokenHash, type BridgeOptions } from './bridge';
import type { IncomingMessage, ServerResponse } from 'node:http';
function assets() {
  const root = mkdtempSync(join(tmpdir(), 'mobile-generation-'));
  writeFileSync(join(root, 'index.html'), '<script src="./web.js"></script>');
  writeFileSync(join(root, 'web.js'), 'fetch("/api/mobile/command"); const page="/mobile/chat.html";');
  return root;
}
async function call(options: BridgeOptions, path: string, headers: Record<string, string> = {}, body?: string, afterBody?: () => void) {
  const req = Readable.from((async function* () { if (body) yield body; afterBody?.(); })()) as IncomingMessage;
  req.url = path; req.method = body ? 'POST' : 'GET'; req.headers = { host: 'example.invalid', ...headers };
  const result = { status: 0, body: '', headers: {} as Record<string, string> };
  const res = { setHeader: (k: string, v: string) => { result.headers[k.toLowerCase()] = v; },
    writeHead: (status: number, headers?: Record<string, string>) => { result.status = status; for (const [k,v] of Object.entries(headers ?? {})) result.headers[k.toLowerCase()] = v; },
    end: (body?: Buffer | string) => { result.body = body?.toString() ?? ''; } } as unknown as ServerResponse;
  await handler(options)(req, res); return result;
}
describe('mobile generation fencing', () => {
  it('pins every asset to an immutable snapshot while preserving API URLs', () => {
    const root = assets(); try {
      const a = loadMobileGeneration(root); writeFileSync(join(root, 'web.js'), 'replacement');
      const b = loadMobileGeneration(root); expect(a.id).not.toBe(b.id);
      expect(generationBytes(a, 'web.js')!.toString()).toContain('/api/mobile/command');
      expect(generationBytes(a, 'web.js')!.toString()).toContain(`/mobile/g/${a.id}/chat.html`);
      expect(generationBytes(a, 'web.js')!.toString()).not.toContain('replacement');
    } finally { rmSync(root, { recursive: true }); }
  });
  it('rejects missing entries and symlinks', () => {
    const root = assets(); try {
      symlinkSync('/etc/hosts', join(root, 'escape'));
      expect(() => loadMobileGeneration(root)).toThrow('symlink');
      rmSync(join(root, 'escape')); rmSync(join(root, 'web.js'));
      expect(() => loadMobileGeneration(root)).toThrow('missing');
    } finally { rmSync(root, { recursive: true }); }
  });
  it('redirects the entry, refuses mixed assets and stale commands, and fences activation', async () => {
    const root = assets(); try {
      const generation = loadMobileGeneration(root); let calls = 0, updating = false;
      const token = 'a'.repeat(43);
      const options = { assets: root, origin: 'https://example.invalid', generation, updating: () => updating,
        clients: () => [{ id: 'client', tokenHash: tokenHash(token), botIds: ['main'], expiresAt: Date.now() + 10000 }],
        core: { mobileCommand: async () => { calls++; return { v: 10, id: 's', ok: true, result: {} }; } } } as unknown as BridgeOptions;
      expect((await call(options, '/mobile/')).headers.location).toBe(`/mobile/g/${generation.id}/`);
      expect((await call(options, '/mobile/web.js')).status).toBe(410);
      expect((await call(options, `/mobile/g/${generation.id}/web.js`)).status).toBe(200);
      const headers = { origin: options.origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const request = JSON.stringify({ v: 10, id: 's', cmd: { type: 'chat.snapshot', botId: 'main' } });
      expect((await call(options, '/api/mobile/command', headers, request)).status).toBe(409);
      expect(calls).toBe(0);
      expect((await call(options, '/api/mobile/command', { ...headers, 'x-botling-generation': generation.id }, request)).status).toBe(200);
      expect(calls).toBe(1);
      updating = true;
      expect((await call(options, '/api/mobile/command', { ...headers, 'x-botling-generation': generation.id }, request)).status).toBe(503);
      expect(calls).toBe(1);
      updating = false;
      expect((await call(options, '/api/mobile/command', { ...headers, 'x-botling-generation': generation.id }, request, () => { updating = true; })).status).toBe(503);
      expect(calls).toBe(1);
    } finally { rmSync(root, { recursive: true }); }
  });
});
