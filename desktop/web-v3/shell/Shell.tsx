// Botling 3's phone/browser page shell (protocol v1 §13, §18.3; plan change N5): pairing (sign-in), the connection
// banner (§13.3), "This device", and the outbox wiring. The 2.x renderer is mounted by bridge-v3.ts into the one element
// `#v3-renderer` this shell owns; the shell puts its own controls into the renderer's chrome slots, as the 2.x page did.
// Looks: the 2.x page's own sign-in card and phone drawer (desktop/mobile/web.css), nothing new.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parsePairLink, type PairOffer } from "../../src/protocol";
import { DEFAULT_IDB_NAME, wsUrlFor } from "../../src/fe-link";
import { Icon } from "../../src/renderer/icons";
import { QrScanner, cameraError, openCamera } from "../../mobile/QrScanner";
import { PHONE_QUERY, phoneWidth } from "../../mobile/layout";
import { mountRenderer, type MountedRenderer, type PageCapabilities } from "../bridge-v3";
import { forgetDevice, loadDevice, saveDevice, type DeviceRecord } from "./device-store";
import { makePairKeys, pair, pairingSupported, PairingError, type PairAttempt, type PairKeys } from "./pairing";
import { bannerText, FE_VERSION, newDiagnostics, openConnection, type Connection, type Diagnostics } from "./connection";
import type { DeviceScope } from "../../src/protocol";

/** Diagnostics for the headless harness and support (not a capability; the renderer never sees it). */
export const diagnostics: Diagnostics = newDiagnostics();
(globalThis as { botling3Diagnostics?: Diagnostics }).botling3Diagnostics = diagnostics;

type Phase =
  | { kind: "loading" }
  | { kind: "pair"; message?: string }
  | { kind: "pairing"; code: string | null }
  | { kind: "app"; device: DeviceRecord };

function defaultName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  return "Browser";
}

const groupCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

export function Shell() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [linkText, setLinkText] = useState("");
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const [retry, setRetry] = useState<{ offer: PairOffer; keys: PairKeys } | null>(null);
  const attempt = useRef<PairAttempt | null>(null);

  useEffect(() => {
    // A scanned link that opened this page: the fragment (the one-time secret) is cleared from the address at once.
    const fromHash = parsePairLink(location.hash);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    void loadDevice().then((device) => {
      if (device) setPhase({ kind: "app", device });
      else { setPhase({ kind: "pair" }); if (fromHash) void start(fromHash, null); }
    }, () => setPhase({ kind: "pair", message: "This browser cannot keep data for this page (IndexedDB is off or full)." }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = useCallback(async (offer: PairOffer, keys: PairKeys | null) => {
    const unsupported = await pairingSupported();
    if (unsupported) { setPhase({ kind: "pair", message: unsupported }); return; }
    if (Date.now() >= offer.expiresAt) { setPhase({ kind: "pair", message: "This pairing link has expired. Create a new one on the computer." }); return; }
    const k = keys ?? await makePairKeys();
    setRetry(null);
    setPhase({ kind: "pairing", code: null });
    const run = pair({ offer, keys: k, name: defaultName(), wsUrl: wsUrlFor(location.href), feVersion: FE_VERSION, save: saveDevice });
    attempt.current = run;
    run.code.then((code) => { if (attempt.current === run) setPhase({ kind: "pairing", code }); }, () => undefined);
    try {
      const device = await run.done;
      if (attempt.current !== run) return;
      attempt.current = null;
      setLinkText("");
      // Ask the browser to keep this page's data (the outbox and the keys) under storage pressure (D45).
      void navigator.storage?.persist?.().catch(() => false);
      setPhase({ kind: "app", device });
    } catch (error) {
      if (attempt.current !== run) return;
      attempt.current = null;
      const reason = error instanceof PairingError ? error.reason : "error";
      // A dropped connection may be a lost ack: the same link and keys can try again (the server gives the offer back).
      if (reason === "transport" || reason === "offer" || reason === "handshake") setRetry({ offer, keys: k });
      setPhase({ kind: "pair", message: (error as Error).message });
    }
  }, []);

  const take = useCallback((text: string) => {
    const found = /https?:\/\/[^\s<>"']+/i.exec(text.trim())?.[0] ?? text.trim();
    const offer = parsePairLink(found);
    if (!offer) { setPhase({ kind: "pair", message: "That is not a Botling 3 pairing link. On the computer run botlingd pair, then scan its code or paste its link here." }); return; }
    void start(offer, null);
  }, [start]);

  const scan = useCallback(async () => {
    try { setCamera(await openCamera()); } catch (cause) { setPhase({ kind: "pair", message: cameraError(cause) }); }
  }, []);

  if (phase.kind === "app") return <Workspace device={phase.device} onForget={() => { setPhase({ kind: "pair", message: "This device was forgotten. Pair it again to use it." }); }} />;

  const busy = phase.kind === "pairing" || phase.kind === "loading";
  return <main className="web-signin v3-signin" aria-busy={busy}>
    <form className="web-signin-card" onSubmit={(event) => { event.preventDefault(); take(linkText); }}>
      <img className="web-signin-icon" src="./icon-192.png" alt="" />
      <h1>Botling</h1>
      {phase.kind === "pairing" ? <>
        {phase.code ? <>
          <p className="web-signin-lead">Check that your computer shows the same code, then confirm there.</p>
          <p className="v3-pair-code" data-testid="pair-code" aria-label={`Pairing code ${phase.code}`}>{groupCode(phase.code)}</p>
          <button type="button" className="web-secondary" onClick={() => attempt.current?.decline()}>The codes differ</button>
        </> : <p className="web-signin-lead">Pairing…</p>}
      </> : <>
        <p className="web-signin-lead">Your bots, from anywhere. On your computer run <code>botlingd pair</code>, then scan its code or paste its link here.</p>
        {phase.kind === "pair" && phase.message && <p className="web-signin-message" role="alert">{phase.message}</p>}
        {retry && <button type="button" className="web-primary" onClick={() => void start(retry.offer, retry.keys)}>Try again</button>}
        <div className="web-signin-actions">
          <button type="button" className={retry ? "web-secondary web-scan-button" : "web-primary web-scan-button"} disabled={busy} onClick={() => void scan()}>
            <Icon name="camera" size={16} />Scan QR code</button>
          <div className="web-signin-or" aria-hidden="true">or</div>
          <div className="web-paste-row">
            <input className="web-token" type="password" autoComplete="off" autoCapitalize="off" spellCheck={false}
              aria-label="Pairing link" placeholder="Paste the pairing link" value={linkText} onChange={(event) => setLinkText(event.target.value)} disabled={busy} />
          </div>
          {linkText && <button type="submit" className="web-primary" disabled={busy}>Pair</button>}
        </div>
      </>}
      <p className="web-signin-muted">Keep Botling running on your computer. Everything between this device and Botling is end-to-end encrypted.</p>
    </form>
    {camera && <QrScanner stream={camera} onResult={(text) => { setCamera(null); take(text); }} onClose={() => setCamera(null)} />}
  </main>;
}

/** The paired page: the connection banner, the renderer's root element, the drawer and "This device". */
function Workspace({ device, onForget }: { device: DeviceRecord; onForget: () => void }) {
  const rendererRoot = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [banner, setBanner] = useState<{ text: string | null; state: string }>({ text: "connecting…", state: "connecting" });
  const [navOpen, setNavOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const mounted = useRef<MountedRenderer | null>(null);

  const capabilities = useMemo<PageCapabilities>(() => ({
    openLink: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
    narrow: phoneWidth,
    scopes: device.scope as DeviceScope[],
  }), [device]);

  const forget = useCallback(async () => {
    mounted.current?.unmount();
    mounted.current = null;
    await connection?.close().catch(() => undefined);
    await forgetDevice([DEFAULT_IDB_NAME]);
    onForget();
  }, [connection, onForget]);

  const chrome = useMemo(() => ({
    headerLead: <button type="button" className="web-nav-button" aria-label="Bots" aria-expanded={navOpen} onClick={() => setNavOpen((open) => !open)}>
      <Icon name="sidebarLeft" size={15} /></button>,
    railFooter: <button type="button" className="rail-button web-sign-out" onClick={() => setSheet(true)}>This device</button>,
  }), [navOpen]);

  useEffect(() => {
    let cancelled = false;
    let opened: Connection | null = null;
    void openConnection(device, diagnostics, location.href).then((conn) => {
      if (cancelled) { void conn.close(); return; }
      opened = conn;
      const update = () => setBanner({ text: bannerText(conn.link.status, conn.link.pending()), state: conn.link.status.state });
      conn.link.on((event) => { if (event.type === "state" || event.type === "pending" || event.type === "outcome") update(); });
      mounted.current = mountRenderer(rendererRoot.current!, { link: conn.port, capabilities, clock: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }, chrome });
      conn.link.start();
      update();
      setConnection(conn);
    }, (error) => setFailure(`This page could not open its storage: ${String((error as Error)?.message ?? error)}`));
    return () => { cancelled = true; mounted.current?.unmount(); mounted.current = null; void opened?.close(); };
    // The connection lives as long as this device's page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  useEffect(() => { mounted.current?.render(chrome); }, [chrome]);

  useEffect(() => {
    // Across the phone width (a rotation): the drawer closes and the left column is shown as that width shows it.
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const changed = () => { setNavOpen(false); void mounted.current?.store.resync().catch(() => undefined); };
    query.addEventListener?.("change", changed);
    return () => query.removeEventListener?.("change", changed);
  }, []);

  return <div className="web-root v3-root" data-nav={navOpen ? "open" : "closed"}
    onClickCapture={(event) => {
      if (!phoneWidth()) return;
      const target = event.target as Element;
      if (target.closest?.(".rail .rail-toggle")) { event.preventDefault(); event.stopPropagation(); setNavOpen(false); return; }
      if (target.closest?.(".bot-row, .strip-bot, .subagent-open")) setNavOpen(false);
    }}>
    {banner.text && <div className="v3-conn" role="status" data-state={banner.state} data-testid="conn-banner">{banner.text}</div>}
    <div id="v3-renderer" className="v3-renderer" ref={rendererRoot} />
    {failure && <div className="banner bottom web-banner" role="alert">{failure}</div>}
    <div className="web-scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
    {sheet && <ThisDevice device={device} connection={connection} onClose={() => setSheet(false)} onForget={() => void forget()} />}
  </div>;
}

/** Settings › This device: who this device is, which server it is paired with, and forgetting it. */
function ThisDevice({ device, connection, onClose, onForget }: { device: DeviceRecord; connection: Connection | null; onClose: () => void; onForget: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const pending = connection?.link.pending().length ?? 0;
  return <div className="v3-sheet-scrim" role="presentation" onClick={onClose}>
    <section className="v3-sheet" role="dialog" aria-label="This device" onClick={(event) => event.stopPropagation()}>
      <h2>This device</h2>
      <dl>
        <dt>Name</dt><dd>{device.name}</dd>
        <dt>Device id</dt><dd><code>{device.memberId}</code></dd>
        <dt>Paired with</dt><dd>{device.server.name}</dd>
        <dt>Allowed</dt><dd>{device.scope.join(", ")}</dd>
        <dt>Paired</dt><dd>{new Date(device.pairedAt).toLocaleString()}</dd>
        <dt>Waiting to send</dt><dd>{pending}</dd>
      </dl>
      {confirm
        ? <><p className="v3-sheet-warn">Forget this device? Messages still waiting here are dropped, and you pair again with a new link. To stop it everywhere, revoke it on the computer (botlingd revoke-device).</p>
          <div className="v3-sheet-actions"><button type="button" className="web-secondary" onClick={() => setConfirm(false)}>Keep</button><button type="button" className="web-primary" onClick={onForget}>Forget</button></div></>
        : <div className="v3-sheet-actions"><button type="button" className="web-secondary" onClick={() => setConfirm(true)}>Forget this device…</button><button type="button" className="web-primary" onClick={onClose}>Done</button></div>}
    </section>
  </div>;
}
