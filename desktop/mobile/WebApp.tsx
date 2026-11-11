// Botling Web: access-token sign-in (or a relay pairing code), then the desktop app's own renderer (src/renderer/App.tsx: the left
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
import { betterRoute, deviceId, deviceName, redeemPairing, takePairingLink, type PairingLink } from './pair';
import { readPairingInput } from './pair-input';
import { QrScanner, cameraError, openCamera } from './QrScanner';
import { PHONE_QUERY, phoneWidth } from './layout';
import { WebBridge, forgetLocal } from './web-bridge';
import { RelayClient, type RelaySession } from './relay-client';
import { forgetBridgeLogin, forgetRelaySession, loadBridgeLogin, loadRelaySession, saveBridgeLogin, saveRelaySession } from './relay-session';
import { parseRelayFragment, type RelayLink } from '../src/mobile-relay/protocol';

const POLL_MS = 2_500;
/** While the event stream is up, a slow read is only a safety net. */
const LIVE_POLL_MS = 30_000;
/** Away from the page longer than this, the relay socket may have died while looking open: connect again. */
const STALE_MS = 10_000;
/** Signed out by a network failure with a kept sign-in: try again this often (and whenever the page comes back). */
const RETRY_MS = 15_000;
type Auth = 'checking' | 'signedOut' | 'denied' | 'unavailable';
const TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
/** The bridge over HTTPS (a token), or the end-to-end encrypted relay (a paired phone). */
export interface Connected { transport: MobileTransport | RelayClient; bridge: WebBridge; client: Client; store: WorkspaceStore; wake: { poke: () => void }; shown: { value: boolean } }

function storage(): Storage | null { try { return window.localStorage; } catch { return null; } }

export function connectWorkspace(token: string, onAuthLost: (error: MobileError) => void, fetcher: typeof fetch = fetch, routes: RouteBook | null = null): Connected {
  return workspaceOver(new MobileTransport(endpointURL('/api/mobile/command', location.origin), token, fetcher, routes), onAuthLost);
}

/** The same workspace over any command transport (the HTTPS bridge, or a relay client). */
export function workspaceOver(transport: MobileTransport | RelayClient, onAuthLost: (error: MobileError) => void): Connected {
  const wake = { poke: () => {} };
  const shown = { value: false };
  const bridge = new WebBridge({ transport, storage: storage(), onAuthLost, narrow: phoneWidth,
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
  const transport = connected.transport;
  let hiddenAt = document.hidden ? Date.now() : 0;
  // Back on the page (shown, online again, restored from the back-forward cache): reconnect the relay now (a socket
  // that slept may look open and carry nothing), then read the chat on screen, which catches up what was missed.
  const visible = (event: Event) => {
    if (document.hidden) { hiddenAt ||= Date.now(); return; }
    if (transport instanceof RelayClient) {
      const away = hiddenAt > 0 && Date.now() - hiddenAt > STALE_MS;
      transport.resume(away || event.type === 'online' || (event as PageTransitionEvent).persisted === true);
    }
    hiddenAt = 0;
    clearTimeout(timer); void tick();
  };
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', visible);
  window.addEventListener('pageshow', visible);
  timer = setTimeout(tick, interval);
  // The core says when something changed; reading stays the (checked) snapshot request.
  const onChange = () => { clearTimeout(timer); timer = setTimeout(tick, 100); };
  const onLive = (value: boolean) => { live = value; if (!value) { clearTimeout(timer); timer = setTimeout(tick, 300); } };
  const stopEvents = transport instanceof RelayClient ? transport.watch(onChange, onLive) : watchEvents({ origin: () => transport.origin, ticket: () => transport.ticket(), recover: () => transport.recover(),
    onChange, onLive });
  return () => { stopped = true; stopEvents(); clearTimeout(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', visible); window.removeEventListener('pageshow', visible); };
}


export function WebApp() {
  const [auth, setAuth] = useState<Auth>('signedOut');
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState<Connected | null>(null);
  const [navOpen, setNavOpen] = useState(() => phoneWidth());
  const [tokenText, setTokenText] = useState('');
  /** The camera open for scanning a pairing code (opened from the Scan button's tap). */
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const connecting = useRef(false);
  /** A relay pairing is saved in this browser (it can reconnect without a new code). */
  const [relaySaved, setRelaySaved] = useState(false);
  /** A bridge sign-in (token) is kept in this browser. */
  const [bridgeSaved, setBridgeSaved] = useState(false);
  /** This page came from a relay pairing code (or holds a relay pairing): an access token has no use here (the relay
   * serves no token API), so a failed pairing asks for a new code instead of a token. */
  const [relayPage, setRelayPage] = useState(() => parseRelayFragment(location.hash) !== null);

  const lost = useCallback((error: MobileError) => {
    setConnected(current => { current?.bridge.close(); if (current?.transport instanceof RelayClient) current.transport.close(); return null; });
    setAuth('signedOut'); setMessage(error.message);
  }, []);
  // The desktop revoked this phone: forget the pairing too.
  const relayLost = useCallback((error: MobileError) => { setRelaySaved(false); void forgetRelaySession(); lost(error); }, [lost]);

  /** Shows the workspace over a relay channel that is up (paired just now, or reconnected). */
  const showRelay = useCallback(async (relay: RelayClient) => {
    let ended: MobileError | undefined;
    const next = workspaceOver(relay, error => { ended = error; relayLost(error); });
    try { await next.store.resync(); } catch (cause) { next.bridge.close(); relay.close(); throw ended ?? cause; }
    next.shown.value = true;
    setMessage('');
    setConnected(next);
  }, [relayLost]);

  const failed = useCallback((cause: unknown, fallback: string) => {
    setAuth(cause instanceof MobileError ? cause.auth ? 'signedOut' : cause.denied ? 'denied' : 'unavailable' : 'unavailable');
    setMessage(cause instanceof MobileError ? cause.message : fallback);
  }, []);

  /** The desktop renewed the pairing (a phone in use stays paired): keep the new expiry. */
  const keepRelay = useCallback((session: RelaySession) => { void saveRelaySession(session); }, []);

  /** Reconnects with the pairing this browser saved. */
  const reconnectRelay = useCallback(async () => {
    if (connecting.current) return;
    const saved = await loadRelaySession();
    setRelaySaved(!!saved);
    if (!saved) return;
    setRelayPage(true);
    connecting.current = true; setAuth('checking'); setMessage('');
    try { await showRelay(await RelayClient.connect(saved, { onRevoked: relayLost, onSession: keepRelay })); }
    catch (cause) {
      if (cause instanceof MobileError && cause.auth) { setRelaySaved(false); await forgetRelaySession(); }
      failed(cause, 'Could not reach Botling through the relay. Try again.');
    } finally { connecting.current = false; }
  }, [showRelay, relayLost, failed, keepRelay]);

  const connect = useCallback(async (token: string, coreId?: string) => {
    if (connecting.current) return;
    connecting.current = true; setAuth('checking'); setMessage('');
    try {
      if (!TOKEN.test(token.trim())) throw new MobileError('Enter the server’s access token.', true);
      // A fresh bridge each time: an ended one stays closed. Its first read settles either way.
      let ended: MobileError | undefined;
      // The core's own list of routes, pinned to its id: where this session may follow it if the connection drops.
      const routes = await loadRouteBook(location.origin, coreId);
      // A token the bridge no longer accepts (401: revoked or expired on the desktop) is forgotten here too.
      const next = connectWorkspace(token, error => { ended = error; if (error.auth) { setBridgeSaved(false); void forgetBridgeLogin(); } lost(error); }, undefined, routes);
      try { await next.store.resync(); } catch (cause) { next.bridge.close(); throw ended ?? cause; }
      next.shown.value = true;
      setTokenText('');
      setConnected(next);
      // Kept (encrypted) so the page opened again signs in without a new code; Sign out forgets it.
      setBridgeSaved(await saveBridgeLogin({ token: token.trim(), origin: location.origin, ...(routes?.coreId ?? coreId ? { coreId: routes?.coreId ?? coreId } : {}) }));
    } catch (cause) {
      if (cause instanceof MobileError && cause.auth) { setBridgeSaved(false); void forgetBridgeLogin(); }
      setAuth(cause instanceof MobileError ? cause.auth ? 'signedOut' : cause.denied ? 'denied' : 'unavailable' : 'unavailable');
      setMessage(cause instanceof MobileError ? cause.message : 'Sign-in is unavailable. Try again.');
    } finally { connecting.current = false; }
  }, [lost]);

  /** Signs in again with what this browser kept: the relay pairing, else the bridge's token for this origin. */
  const resumeSaved = useCallback(async () => {
    if (connecting.current) return;
    if (await loadRelaySession()) return reconnectRelay();
    const login = await loadBridgeLogin(location.origin);
    setBridgeSaved(!!login);
    if (login) await connect(login.token, login.coreId);
  }, [reconnectRelay, connect]);

  // Not connected because Botling or the network could not be reached, with a sign-in kept: try again when the page
  // comes back or the network does, and every little while meanwhile.
  const canRetry = !connected && auth === 'unavailable' && (relaySaved || bridgeSaved);
  useEffect(() => {
    if (!canRetry) return;
    const again = () => { if (!document.hidden) void resumeSaved(); };
    document.addEventListener('visibilitychange', again);
    window.addEventListener('online', again);
    window.addEventListener('pageshow', again);
    const timer = setInterval(again, RETRY_MS);
    return () => { document.removeEventListener('visibilitychange', again); window.removeEventListener('online', again); window.removeEventListener('pageshow', again); clearInterval(timer); };
  }, [canRetry, resumeSaved]);

  /** Pairs through the relay this page came from (end-to-end encrypted): the secret stays in this function. */
  const pairRelay = useCallback(async (relayLink: RelayLink) => {
    if (connecting.current) return;
    setRelayPage(true);
    connecting.current = true; setAuth('checking'); setMessage('Pairing…');
    try {
      const { client, session } = await RelayClient.pair(relayLink, location.origin, deviceName(), { onRevoked: relayLost, onSession: keepRelay });
      setRelaySaved(await saveRelaySession(session));
      await showRelay(client);
    } catch (cause) { failed(cause, 'Pairing failed. Show a new code on your computer.'); }
    finally { connecting.current = false; }
  }, [showRelay, relayLost, failed, keepRelay]);

  /** A bridge pairing link: redeem it once for a token, then sign in exactly as a pasted token does. */
  const pairBridge = useCallback(async (link: PairingLink, mayMove: boolean) => {
    setAuth('checking'); setMessage('Pairing…');
    try {
      // A route the core lists ahead of this one may be reachable (the home network, say): continue there.
      const better = mayMove ? await betterRoute(link, location.origin) : null;
      if (better) { location.replace(better); return; }
      await connect(await redeemPairing(link, deviceId(), location.origin), link.coreId);
    }
    catch (cause) {
      setAuth('signedOut'); setMessage(cause instanceof MobileError ? cause.message : 'Pairing failed. Show a new code on your computer.');
    }
  }, [connect]);

  /** What was scanned, pasted or typed on the sign-in page: a pairing link (the QR code's own) or an access token. */
  const takeInput = useCallback((text: string) => {
    const input = readPairingInput(text, location.origin);
    if (input.kind === 'relay') { setTokenText(''); return void pairRelay(input.link); }
    if (input.kind === 'bridge') { setTokenText(''); return void pairBridge(input.link, true); }
    // A code for another address (this page may talk only to its own): open it there.
    if (input.kind === 'elsewhere') { setTokenText(''); location.assign(input.url); return; }
    if (input.kind === 'token' && !relayPage) return void connect(input.token);
    setAuth('signedOut');
    setMessage(relayPage || input.kind === 'token' ? 'That is not a pairing link. Scan the code, or copy its link on your computer and paste it here.'
      : 'Enter a pairing link or the server’s access token.');
  }, [pairRelay, pairBridge, connect, relayPage]);

  const scan = useCallback(async () => {
    setMessage('');
    // Asked straight from the tap: iOS opens the camera only from a user gesture.
    try { setCamera(await openCamera()); } catch (cause) { setMessage(cameraError(cause)); }
  }, []);
  const scanned = useCallback((text: string) => { setCamera(null); takeInput(text); }, [takeInput]);
  const closeCamera = useCallback(() => setCamera(null), []);
  const pasteLink = useCallback(async () => {
    try { const text = await navigator.clipboard.readText(); if (text.trim()) takeInput(text); else setMessage('The clipboard is empty. Copy the pairing link on your computer first.'); }
    catch { setMessage('Paste the link into the field (touch and hold, then Paste).'); }
  }, [takeInput]);

  // A scanned pairing link that opened this page: the fragment is cleared first, then it pairs as one scanned here.
  useEffect(() => {
    const relayLink = parseRelayFragment(location.hash);
    if (relayLink) {
      history.replaceState(null, '', location.pathname + location.search);
      void pairRelay(relayLink);
      return;
    }
    const link = takePairingLink();
    if (!link) { void resumeSaved(); return; }
    void pairBridge(link, true);
  }, [pairRelay, pairBridge, resumeSaved]);

  useEffect(() => connected ? startSync(connected) : undefined, [connected]);
  // Across the phone width (a rotation, a resized window): the drawer closes and the left column is shown as that width
  // shows it (folded only on the desktop's own setting, never in the phone's drawer).
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query || !connected) return;
    const changed = () => { setNavOpen(false); void connected.store.resync().catch(() => {}); };
    query.addEventListener?.('change', changed);
    return () => query.removeEventListener?.('change', changed);
  }, [connected]);
  useEffect(() => () => connected?.bridge.close(), [connected]);

  const signOut = useCallback(() => {
    if (!connected) return;
    connected.bridge.close(); clearDrafts(); forgetLocal(storage()); setConnected(null); setAuth('signedOut'); setMessage('');
    setBridgeSaved(false); void forgetBridgeLogin();
    // Signing out of a relay session forgets its pairing in this browser (the desktop can revoke it in Settings › Phone).
    if (connected.transport instanceof RelayClient) { connected.transport.close(); setRelaySaved(false); void forgetRelaySession(); }
  }, [connected]);

  const chrome = useMemo(() => ({
    headerLead: <button type="button" className="web-nav-button" aria-label="Bots" aria-expanded={navOpen} onClick={() => setNavOpen(open => !open)}>
      <Icon name="sidebarLeft" size={15} /></button>,
    railFooter: <button type="button" className="rail-button web-sign-out" onClick={signOut}>Sign out</button>,
  }), [navOpen, signOut]);

  const busy = auth === 'checking';
  if (!connected) return <main className="web-signin" aria-busy={busy}>
    <form className="web-signin-card" onSubmit={event => { event.preventDefault(); takeInput(tokenText); }}>
      <img className="web-signin-icon" src="./icon.svg" alt="" />
      <h1>Botling</h1>
      <p className="web-signin-lead">Your bots, from anywhere. On your computer, open Botling › Settings › Phone, create a pairing code and scan it here.</p>
      {message && <p className="web-signin-message" role="alert">{message}</p>}
      {relaySaved && <button type="button" className="web-primary" disabled={busy} onClick={() => void reconnectRelay()}>Reconnect through the relay</button>}
      {!relaySaved && bridgeSaved && auth !== 'signedOut' && <button type="button" className="web-primary" disabled={busy} onClick={() => void resumeSaved()}>Reconnect</button>}
      <div className="web-signin-actions">
        <button type="button" className={relaySaved || (bridgeSaved && auth !== 'signedOut') ? 'web-secondary web-scan-button' : 'web-primary web-scan-button'} disabled={busy} onClick={() => void scan()}>
          <Icon name="camera" size={16} />Scan QR code</button>
        <div className="web-signin-or" aria-hidden="true">or</div>
        <div className="web-paste-row">
          <input className="web-token" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false}
            aria-label={relayPage ? 'Pairing link' : 'Pairing link or access token'} placeholder={relayPage ? 'Paste the pairing link' : 'Pairing link or access token'}
            value={tokenText} onChange={event => setTokenText(event.target.value)} disabled={busy} />
          {!tokenText && typeof navigator.clipboard?.readText === 'function' && <button type="button" className="web-secondary web-paste" disabled={busy} onClick={() => void pasteLink()}>Paste</button>}
        </div>
        {tokenText && <button type="submit" className="web-primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>}
      </div>
      {busy && !tokenText && <p className="web-signin-muted">Connecting…</p>}
      <p className="web-signin-muted">{relayPage ? 'Keep Botling running on your computer. Everything between this phone and Botling is end-to-end encrypted.'
        : 'Keep Botling running on your computer. This phone stays signed in until you sign out here or revoke it on your computer.'}</p>
    </form>
    {camera && <QrScanner stream={camera} onResult={scanned} onClose={closeCamera} />}
  </main>;

  return <div className="web-root" data-nav={navOpen ? 'open' : 'closed'}
    onClickCapture={event => {
      if (!phoneWidth()) return;
      const target = event.target as Element;
      // On a phone the column is a drawer: its fold button closes it (a folded strip of faces is the desktop's).
      if (target.closest?.('.rail .rail-toggle')) { event.preventDefault(); event.stopPropagation(); setNavOpen(false); return; }
      // A bot picked in the drawer opens its chat.
      if (target.closest?.('.bot-row, .strip-bot, .subagent-open')) setNavOpen(false);
    }}>
    <App client={connected.client} store={connected.store} web={chrome} />
    {message && <div className="banner bottom web-banner" role="alert">{message}<button type="button" onClick={() => setMessage('')} aria-label="Dismiss">×</button></div>}
    <div className="web-scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
  </div>;
}
