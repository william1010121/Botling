// Botling Web: Google sign-in, then the desktop app's own renderer (src/renderer/App.tsx: the left
// column, the chat page, the right panel) over WebBridge instead of Electron IPC. Phone widths keep
// the same chrome and show the left column as a drawer (web.css).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from '../src/renderer/App';
import { Client } from '../src/renderer/client';
import { WorkspaceStore } from '../src/renderer/store';
import { Icon } from '../src/renderer/icons';
import { MobileError, MobileTransport, endpointURL } from './transport';
import { Session, clearDrafts, sessionRequest } from './session';
import { WebBridge, forgetLocal } from './web-bridge';

const POLL_MS = 2_500;
type Auth = 'checking' | 'signedOut' | 'denied' | 'unavailable';
export interface Connected { csrf: string; bridge: WebBridge; client: Client; store: WorkspaceStore; wake: { poke: () => void } }

function storage(): Storage | null { try { return window.localStorage; } catch { return null; } }

export function connectWorkspace(csrf: string, onAuthLost: (error: MobileError) => void, fetcher: typeof fetch = fetch): Connected {
  const transport = new MobileTransport(endpointURL('/api/mobile/browser/command', location.origin), { csrf }, fetcher);
  const wake = { poke: () => {} };
  const bridge = new WebBridge({ transport, storage: storage(), onAuthLost,
    openURL: url => { window.open(url, '_blank', 'noopener,noreferrer'); },
    onMutated: () => wake.poke(), onLocalChange: () => { void store.resync(); } });
  const client = new Client(bridge);
  const store = new WorkspaceStore(botId => client.request({ type: 'chat.snapshot', ...(botId ? { botId } : {}) }));
  client.onEvent(event => store.receive(event));
  return { csrf, bridge, client, store, wake };
}

/** Re-reads the chat on screen every few seconds (and soon after a send); resyncs the store when it changed. */
export function startSync(connected: Connected, interval = POLL_MS): () => void {
  let stopped = false, busy = false, timer: ReturnType<typeof setTimeout> | undefined;
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
    if (!stopped && !connected.bridge.closed) timer = setTimeout(tick, interval);
  };
  connected.wake.poke = () => { clearTimeout(timer); timer = setTimeout(tick, 300); };
  const visible = () => { if (!document.hidden) { clearTimeout(timer); void tick(); } };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', visible);
  timer = setTimeout(tick, interval);
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', visible); };
}

const narrowQuery = '(max-width: 700px)';

export function WebApp() {
  const [auth, setAuth] = useState<Auth>('checking');
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState<Connected | null>(null);
  const [navOpen, setNavOpen] = useState(() => window.matchMedia?.(narrowQuery).matches ?? false);
  const [busy, setBusy] = useState(false);
  const connecting = useRef(false);

  const lost = useCallback((error: MobileError) => {
    setConnected(current => { current?.bridge.close(); return null; });
    setAuth('signedOut'); setMessage(error.message);
  }, []);

  const connect = useCallback(async () => {
    if (connecting.current) return;
    connecting.current = true; setAuth('checking'); setMessage('');
    try {
      const session = Session.parse(await sessionRequest('session'));
      if (session.expiresAt <= Date.now()) throw new MobileError('Session expired. Sign in again.', true);
      const next = connectWorkspace(session.csrf, lost);
      await next.store.resync();
      setConnected(next);
    } catch (cause) {
      setAuth(cause instanceof MobileError ? cause.auth ? 'signedOut' : cause.denied ? 'denied' : 'unavailable' : 'unavailable');
      setMessage(cause instanceof MobileError ? cause.message : 'Sign-in is unavailable. Try again.');
    } finally { connecting.current = false; }
  }, [lost]);

  useEffect(() => {
    const url = new URL(window.location.href), code = url.searchParams.get('auth_error');
    if (code) {
      url.searchParams.delete('auth_error'); window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      setMessage(code === 'access_denied' ? 'This Google account is not authorized.' : code === 'auth_unavailable'
        ? 'Google sign-in is temporarily unavailable. Try again.' : 'Google sign-in was cancelled or expired. Try again.');
      setAuth(code === 'access_denied' ? 'denied' : 'signedOut');
    } else void connect();
  }, [connect]);

  useEffect(() => connected ? startSync(connected) : undefined, [connected]);
  useEffect(() => () => connected?.bridge.close(), [connected]);

  const signOut = useCallback(async () => {
    if (!connected || busy) return;
    setBusy(true);
    try {
      await sessionRequest('logout', connected.csrf);
      connected.bridge.close(); clearDrafts(); forgetLocal(storage()); setConnected(null); setAuth('signedOut'); setMessage('');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Could not sign out. Try again.'); }
    finally { setBusy(false); }
  }, [connected, busy]);

  const chrome = useMemo(() => ({
    headerLead: <button type="button" className="web-nav-button" aria-label="Bots" aria-expanded={navOpen} onClick={() => setNavOpen(open => !open)}>
      <Icon name="sidebarLeft" size={15} /></button>,
    railFooter: <button type="button" className="rail-button web-sign-out" disabled={busy} onClick={() => void signOut()}>{busy ? 'Signing out…' : 'Sign out'}</button>,
  }), [navOpen, busy, signOut]);

  if (!connected) return <main className="web-signin" aria-busy={auth === 'checking'}>
    <div className="web-signin-card">
      <img className="web-signin-icon" src="./icon.svg" alt="" />
      <h1>Botling</h1>
      <p className="web-signin-lead">Your bots, from any browser. Sign in with the Google account your Botling allows.</p>
      {message && <p className="web-signin-message" role="alert">{message}</p>}
      {auth === 'checking' ? <p role="status" className="web-signin-muted">Checking your session…</p> : <div className="web-signin-actions">
        <button type="button" className="web-primary" onClick={() => window.location.assign('/api/mobile/login')}>Sign in with Google</button>
        <button type="button" className="web-secondary" onClick={() => void connect()}>Check again</button>
      </div>}
      <p className="web-signin-muted">Keep Botling running on your computer. Sign-in lasts at most an hour.</p>
    </div>
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
