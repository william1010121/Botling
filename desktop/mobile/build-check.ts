// A new deploy reaching the home-screen app. Nothing caches the page (no service worker; the relay and the bridge send
// `Cache-Control: no-store`), but iOS resumes a home-screen app that was only suspended, with the web.js it loaded
// days ago, so a redeployed relay would not show until the app is closed. The build stamps its id in index.html
// (`<meta name="botling-build">`) and writes the same id to version.json; when the page comes back it asks for
// version.json and, if the build changed (or the bridge says this page's generation is gone: 410), it is reloaded.
// The caller decides when a reload is safe (the sign-in page: nothing typed is lost).

/** At most one look per this many milliseconds (visibilitychange, pageshow and online often come together). */
const MIN_GAP_MS = 30_000;

/** The build this page was loaded from, or null where the page carries none (a dev or test page): then nothing is checked. */
export function pageBuild(doc: Document = document): string | null {
  const value = doc.querySelector('meta[name="botling-build"]')?.getAttribute('content') ?? '';
  return /^[a-f0-9]{8,64}$/.test(value) ? value : null;
}

/** The build the server has now: its id, `gone` (the bridge's previous generation, 410), or null when unknown. */
export async function serverBuild(fetcher: typeof fetch = fetch): Promise<string | 'gone' | null> {
  try {
    const response = await fetcher('./version.json', { cache: 'no-store', credentials: 'omit' });
    if (response.status === 410) return 'gone';
    if (!response.ok) return null;
    const body = await response.json() as { build?: unknown };
    return typeof body.build === 'string' && /^[a-f0-9]{8,64}$/.test(body.build) ? body.build : null;
  } catch { return null; }
}

/** Calls `onNewBuild` once when the page comes back (shown again, restored, back online) and the server has a newer build. */
export function watchBuild(onNewBuild: () => void, { fetcher = fetch, doc = document, win = window, now = () => Date.now(), build = pageBuild(doc) }:
  { fetcher?: typeof fetch; doc?: Document; win?: Window; now?: () => number; build?: string | null } = {}): () => void {
  if (!build) return () => {};
  let last = 0, stopped = false, busy = false;
  const look = async () => {
    if (stopped || busy || doc.hidden || now() - last < MIN_GAP_MS) return;
    busy = true; last = now();
    try {
      const current = await serverBuild(fetcher);
      if (!stopped && (current === 'gone' || (current !== null && current !== build))) { stopped = true; onNewBuild(); }
    } finally { busy = false; }
  };
  const back = () => { void look(); };
  doc.addEventListener('visibilitychange', back);
  win.addEventListener('pageshow', back);
  win.addEventListener('online', back);
  return () => { stopped = true; doc.removeEventListener('visibilitychange', back); win.removeEventListener('pageshow', back); win.removeEventListener('online', back); };
}
