// Botling Web: access-token sign-in, then the desktop app's own renderer (src/renderer/App.tsx: the left
// column, the chat page, the right panel) over WebBridge instead of Electron IPC. Phone widths keep
// the same chrome and show the left column as a drawer (web.css).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from '../src/renderer/App';
import { Client } from '../src/renderer/client';
import { WorkspaceStore } from '../src/renderer/store';
import { Icon } from '../src/renderer/icons';
import { MobileError, MobileTransport, endpointURL } from './transport';
import { clearDrafts } from './session';
import { watchEvents } from './events';
import { loadRouteBook, type RouteBook } from './routes';
import { betterRoute, deviceId, redeemPairing, takePairingLink } from './pair';
import { WebBridge, forgetLocal } from './web-bridge';

const POLL_MS = 2_500;
/** While the event stream is up, a slow read is only a safety net. */
const LIVE_POLL_MS = 30_000;
type Auth = 'checking' | 'signedOut' | 'denied' | 'unavailable';
const TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
export interface Connected { transport: MobileTransport; bridge: WebBridge; client: Client; store: WorkspaceStore; wake: { poke: () => void }; shown: { value: boolean } }

function storage(): Storage | null { try { return window.localStorage; } catch { return null; } }

export function connectWorkspace(token: string, onAuthLost: (error: MobileError) => void, fetcher: typeof fetch = fetch, routes: RouteBook | null = null): Connected {
  const transport = new MobileTransport(endpointURL('/api/mobile/command', location.origin), token, fetcher, routes);
  const wake = { poke: () => {} };
  const shown = { value: false };
  const bridge = new WebBridge({ transport, storage: storage(), onAuthLost,
    openURL: url => { window.open(url, '_blank', 'noopener,noreferrer'); },
    onMutated: () => wake.poke(), onLocalChange: () => { void store.resync(); } });
  const client = new Client(bridge);
  // Once the workspace is shown, a read the ended session rejected has nobody to tell (the page is
  // going back to Sign in): it stays unsettled instead of an unhandled rejection. The first read
  // (connect) still fails, so Check again / sign-in start over with a fresh bridge.
  const store = new WorkspaceStore(botId => client.request({ type: 'chat.snapshot', ...(botId ? { botId } : {}) })
    .catch(error => { if (shown.value && bridge.closed) return new Promise<never>(() => {}); throw error; }));
  client.onEvent(event => store.receive(event));
  return { transport, bridge, client, store, wake, shown };
}

/** Re-reads the chat on screen every few seconds (and soon after a send); resyncs the store when it changed. */
export function startSync(connected: Connected, interval = POLL_MS, liveInterval = LIVE_POLL_MS): () => void {
  let stopped = false, busy = false, live = false, timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    clearTimeout(timer);
    if (stopped) return;
    if (!busy && !document.hidden) {
      busy = true;
      try {
        const view = connected.store.getView();
        if (await connected.bridge.poll(view.chat?.botId)) await connected.store.resync();
      } catch { /* The next tick tries again; an ended session has closed the bridge (onAuthLost). */ }
      finally { busy = false; }
    }
    if (!stopped && !connected.bridge.closed) timer = setTimeout(tick, live ? liveInterval : interval);
  };
  connected.wake.poke = () => { clearTimeout(timer); timer = setTimeout(tick, 300); };
  const visible = () => { if (!document.hidden) { clearTimeout(timer); void tick(); } };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', visible);
  timer = setTimeout(tick, interval);
  // The core says when something changed; reading stays the (checked) snapshot request.
  const stopEvents = watchEvents({ origin: () => connected.transport.origin, ticket: () => connected.transport.ticket(), recover: () => connected.transport.recover(),
    onChange: () => { clearTimeout(timer); timer = setTimeout(tick, 100); },
    onLive: value => { live = value; if (!value) { clearTimeout(timer); timer = setTimeout(tick, 300); } } });
  return () => { stopped = true; stopEvents(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', visible); };
}

const narrowQuery = '(max-width: 700px)';

export function WebApp() {
  const [auth, setAuth] = useState<Auth>('signedOut');
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState<Connected | null>(null);
  const [navOpen, setNavOpen] = useState(() => window.matchMedia?.(narrowQuery).matches ?? false);
  const [tokenText, setTokenText] = useState('');
  const connecting = useRef(false);

  const lost = useCallback((error: MobileError) => {
    setConnected(current => { current?.bridge.close(); return null; });
    setAuth('signedOut'); setMessage(error.message);
  }, []);

  const connect = useCallback(async (token: string, coreId?: string) => {
    if (connecting.current) return;
    connecting.current = true; setAuth('checking'); setMessage('');
    try {
      if (!TOKEN.test(token.trim())) throw new MobileError('Enter the server’s access token.', true);
      // A fresh bridge each time: an ended one stays closed. Its first read settles either way.
      let ended: MobileError | undefined;
      // The core's own list of routes, pinned to its id: where this session may follow it if the connection drops.
      const routes = await loadRouteBook(location.origin, coreId);
      const next = connectWorkspace(token, error => { ended = error; lost(error); }, undefined, routes);
      try { await next.store.resync(); } catch (cause) { next.bridge.close(); throw ended ?? cause; }
      next.shown.value = true;
      setTokenText('');
      setConnected(next);
    } catch (cause) {
      setAuth(cause instanceof MobileError ? cause.auth ? 'signedOut' : cause.denied ? 'denied' : 'unavailable' : 'unavailable');
      setMessage(cause instanceof MobileError ? cause.message : 'Sign-in is unavailable. Try again.');
    } finally { connecting.current = false; }
  }, [lost]);

  // A scanned pairing link: redeem it once for a token (the secret never leaves this function), then sign in
  // exactly as a pasted token does. The fragment is cleared first; the token path stays available.
  useEffect(() => {
    const link = takePairingLink();
    if (!link) return;
    void (async () => {
      setAuth('checking'); setMessage('Pairing…');
      try {
        // A route the core lists ahead of this one may be reachable (the home network, say): continue there.
        const better = await betterRoute(link, location.origin);
        if (better) { location.replace(better); return; }
        await connect(await redeemPairing(link, deviceId(), location.origin), link.coreId);
      }
      catch (cause) {
        setAuth('signedOut'); setMessage(cause instanceof MobileError ? cause.message : 'Pairing failed. Show a new code on your computer.');
      }
    })();
  }, [connect]);

  useEffect(() => connected ? startSync(connected) : undefined, [connected]);
  useEffect(() => () => connected?.bridge.close(), [connected]);

  const signOut = useCallback(() => {
    if (!connected) return;
    connected.bridge.close(); clearDrafts(); forgetLocal(storage()); setConnected(null); setAuth('signedOut'); setMessage('');
  }, [connected]);

  const chrome = useMemo(() => ({
    headerLead: <button type="button" className="web-nav-button" aria-label="Bots" aria-expanded={navOpen} onClick={() => setNavOpen(open => !open)}>
      <Icon name="sidebarLeft" size={15} /></button>,
    railFooter: <button type="button" className="rail-button web-sign-out" onClick={signOut}>Sign out</button>,
  }), [navOpen, signOut]);

  if (!connected) return <main className="web-signin" aria-busy={auth === 'checking'}>
    <form className="web-signin-card" onSubmit={event => { event.preventDefault(); void connect(tokenText); }}>
      <img className="web-signin-icon" src="./icon.svg" alt="" />
      <h1>Botling</h1>
      <p className="web-signin-lead">Your bots, from any browser. Scan the pairing code shown by your Botling, or enter an access token.</p>
      {message && <p className="web-signin-message" role="alert">{message}</p>}
      <div className="web-signin-actions">
        <input className="web-token" type="password" autoComplete="off" spellCheck={false} aria-label="Access token" placeholder="Access token"
          value={tokenText} onChange={event => setTokenText(event.target.value)} disabled={auth === 'checking'} />
        <button type="submit" className="web-primary" disabled={auth === 'checking'}>{auth === 'checking' ? 'Connecting…' : 'Connect'}</button>
      </div>
      <p className="web-signin-muted">Keep Botling running on your computer. The token is kept only in this tab's memory.</p>
    </form>
  </main>;

  return <div className="web-root" data-nav={navOpen ? 'open' : 'closed'}
    onClickCapture={event => {
      // A bot picked in the drawer opens its chat (phone widths).
      if ((event.target as Element).closest?.('.bot-row, .strip-bot, .subagent-open') && window.matchMedia?.(narrowQuery).matches) setNavOpen(false);
    }}>
    <App client={connected.client} store={connected.store} web={chrome} />
    {message && <div className="banner bottom web-banner" role="alert">{message}<button type="button" onClick={() => setMessage('')} aria-label="Dismiss">×</button></div>}
    <div className="web-scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
  </div>;
}
