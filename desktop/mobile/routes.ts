// Routes, phone side: the core's descriptor lists the ways to reach it in the order to prefer (LAN, Tailscale,
// tunnel: only what the user configured). Each is probed with the public, secret-free descriptor and a short
// timeout; a route counts only if it answers with this core's id, so a secret is never sent to another machine.
export interface Route { kind: 'lan' | 'tailscale' | 'tunnel'; origin: string }
export const PROBE_MS = 2_500;
const CORE = /^[a-f0-9]{32}$/;

/** Keeps well-formed HTTPS origins (and localhost HTTP for development), drops the rest, at most six. */
export function cleanRoutes(value: unknown): Route[] {
  if (!Array.isArray(value)) return [];
  const out: Route[] = [];
  for (const entry of value) {
    if (!entry || !['lan', 'tailscale', 'tunnel'].includes(entry.kind) || typeof entry.origin !== 'string') continue;
    try {
      const url = new URL(entry.origin);
      const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol === 'https:' || local) && url.origin === entry.origin && !out.some(r => r.origin === url.origin)) out.push({ kind: entry.kind, origin: url.origin });
    } catch { /* not a URL */ }
    if (out.length === 6) break;
  }
  return out;
}

async function probe(origin: string, coreId: string, fetcher: typeof fetch, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // No custom headers, so a cross-origin probe needs no preflight.
    const response = await fetcher(new URL('/api/mobile/core', origin), { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
    const body = response.ok ? await response.json() : null;
    return !!body && body.app === 'botling' && CORE.test(body.coreId) && body.coreId === coreId;
  } catch { return false; } finally { clearTimeout(timer); }
}

/** The first route, in the given order, that answers as this core; null when none does. All are probed at once,
 * so the wait is one timeout, not one per dead route. */
export async function pickRoute(routes: Route[], coreId: string, fetcher: typeof fetch = fetch, timeoutMs = PROBE_MS): Promise<string | null> {
  const results = await Promise.all(routes.map(route => probe(route.origin, coreId, fetcher, timeoutMs)));
  const index = results.indexOf(true);
  return index < 0 ? null : routes[index].origin;
}
