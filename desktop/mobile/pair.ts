// One-time QR pairing, phone side. The link is `/mobile/#pair=<secret>&core=<core id>`: the secret rides in the
// URL fragment (never sent to a server by the browser, never in a referrer), is read once, and the fragment is
// removed from the address bar before anything else happens. The secret goes only to the core whose public
// descriptor carries the core id the link names.
import { MobileError, endpointURL, mobileGeneration } from './transport';
import { cleanRoutes, pickRoute } from './routes';

export interface PairingLink { secret: string; coreId: string; hopped?: boolean }
const SECRET = /^[A-Za-z0-9_-]{43}$/, CORE = /^[a-f0-9]{32}$/;

export function parsePairingFragment(hash: string): PairingLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const secret = params.get('pair') ?? '', coreId = params.get('core') ?? '';
  return SECRET.test(secret) && CORE.test(coreId) ? { secret, coreId, ...(params.get('hop') === '1' ? { hopped: true } : {}) } : null;
}
/** Reads the link, then drops the fragment from the address bar and history entry. */
export function takePairingLink(): PairingLink | null {
  const link = parsePairingFragment(location.hash);
  if (location.hash.includes('pair=')) history.replaceState(null, '', location.pathname + location.search);
  return link;
}
/** A short name for the paired-phones list (what the desktop shows), from the browser's own description. */
export function deviceName(agent = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  return /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Macintosh/.test(agent) ? 'Mac browser' : /Windows/.test(agent) ? 'Windows browser' : 'Browser';
}
/** If an earlier route in the core's own list is reachable and is not this page's origin, the link to open there
 * instead (marked so it moves at most once). The secret goes only to a route that answered with this core's id. */
export async function betterRoute(link: PairingLink, origin: string, fetcher: typeof fetch = fetch, timeoutMs?: number): Promise<string | null> {
  if (link.hopped) return null;
  const init = { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
  const info = await fetcher(endpointURL('/api/mobile/core', origin), { ...init, headers: mobileGeneration() }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!info || info.app !== 'botling' || info.coreId !== link.coreId) return null;
  const routes = cleanRoutes(info.routes), here = new URL(origin).origin;
  const best = await pickRoute(routes, link.coreId, fetcher, timeoutMs);
  if (!best || best === here) return null;
  return `${best}/mobile/#pair=${link.secret}&core=${link.coreId}&hop=1`;
}

/** A random id for this browser; one pairing session per device (a new pairing replaces the old one). */
export function deviceId(): string {
  const key = 'botling-device-id';
  try {
    const saved = localStorage.getItem(key);
    if (saved && /^[A-Za-z0-9_-]{16,64}$/.test(saved)) return saved;
    const made = randomId(); localStorage.setItem(key, made); return made;
  } catch { return randomId(); }
}
function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns the bearer token. Errors never include the secret. */
export async function redeemPairing(link: PairingLink, device: string, origin: string, fetcher: typeof fetch = fetch): Promise<string> {
  const init = { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' } as const;
  const info = await fetcher(endpointURL('/api/mobile/core', origin), { ...init, headers: mobileGeneration() }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!info || info.app !== 'botling') throw new MobileError('Could not reach Botling. Check the connection and scan the code again.');
  if (info.coreId !== link.coreId) throw new MobileError('This code is for a different Botling. Open the link on the Botling that showed it.', true);
  const response = await fetcher(endpointURL('/api/mobile/pair', origin), { ...init, method: 'POST',
    headers: { 'Content-Type': 'application/json', ...mobileGeneration() }, body: JSON.stringify({ secret: link.secret, deviceId: device, name: deviceName() }) }).catch(() => null);
  if (!response) throw new MobileError('Could not reach Botling. Check the connection and try again.');
  if (response.status === 429) throw new MobileError('Too many attempts. Wait a minute, then show a new code.', true);
  if (response.status === 401) throw new MobileError('This code has expired or already been used. Show a new code on your computer.', true);
  if (!response.ok) throw new MobileError('Pairing is unavailable. Try again, or paste the access token instead.', true);
  const body = await response.json().catch(() => null);
  if (!body || typeof body.token !== 'string' || body.coreId !== link.coreId) throw new MobileError('Pairing failed. Show a new code on your computer.', true);
  return body.token;
}
