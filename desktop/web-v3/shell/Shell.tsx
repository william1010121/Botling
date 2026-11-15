// Botling 3's phone/browser page shell (protocol v1 §13, §18.3; plan change N5): pairing (sign-in), the connection
// banner (§13.3), "This device", and the outbox wiring. The 2.x renderer is mounted by bridge-v3.ts into the one element
// `#v3-renderer` this shell owns; the shell puts its own controls into the renderer's chrome slots, as the 2.x page did.
// Looks: the 2.x page's own sign-in card and phone drawer (desktop/mobile/web.css), nothing new.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parsePairLink, type PairOffer } from "../../src/protocol";
import { DEFAULT_IDB_NAME, relaySocketImpl, wsUrlFor } from "../../src/fe-link";
import { fromBase64Url } from "../../src/protocol";
import { relayPairToken } from "../../src/session";
import { Icon } from "../../src/renderer/icons";
import { QrScanner, cameraError, openCamera } from "../../mobile/QrScanner";
import { PHONE_QUERY, phoneWidth } from "../../mobile/layout";
import { mountRenderer, type MountedRenderer, type PageCapabilities } from "../bridge-v3";
import { forgetDevice, loadDevice, loadPref, saveDevice, saveDeviceServers, savePref, type DeviceRecord, type StoredServer } from "./device-store";
import { makePairKeys, pair, pairingSupported, PairingError, type PairAttempt, type PairKeys } from "./pairing";
import { MediaBroker } from "./media";
import { SwBridge } from "./sw-bridge";
import { safeBotId } from "../push-sw";
import { disablePushNotifications, enablePushNotifications, PUSH_ENABLED_PREF, pushSupport, syncPushOnAttach, type PushPrefs } from "./push";
import { PageUploads } from "./uploads";
import { clearContentCache, ContentCache, CONTENT_CACHE_CAP } from "./content-cache";
import { pathOfPage } from "../player";
import { askedPath, bannerText, FE_VERSION, itemWords, newDiagnostics, openConnection, UNSETTLED_LEGACY_WARNING, type Connection, type Diagnostics, type DialPath } from "./connection";
import { slotKey, type DeviceScope, type ServerState, type Slot } from "../../src/protocol";
import { grantCommands, linkPluginSource, listPlugins, ONLY_MANAGE, pluginSheet, type GrantTier, type PluginSource } from "./plugins";

/** Diagnostics for the headless harness and support (not a capability; the renderer never sees it). */
export const diagnostics: Diagnostics = newDiagnostics();
(globalThis as { botling3Diagnostics?: Diagnostics }).botling3Diagnostics = diagnostics;
diagnostics.player.path = pathOfPage(location.hostname);
/** The path this page load was asked for in its address (`?via=relay`, M2 step 13), else the device's saved choice. */
const ASKED_PATH = askedPath(location.search);

/**
 * The page's content cache (step 11, §9A.6): 200 MB. `botling3ContentCapBytes` on the page's global lowers the cap
 * (the headless harness sets it before the page loads; support can too); it is never raised above 200 MB.
 */
function contentCap(): number {
  const asked = Number((globalThis as { botling3ContentCapBytes?: unknown }).botling3ContentCapBytes);
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, CONTENT_CACHE_CAP) : CONTENT_CACHE_CAP;
}
export const contentCache = new ContentCache({ cap: contentCap() });

function reprobeMs(): number | undefined {
  const asked = Number((globalThis as { botling3ReprobeMs?: unknown }).botling3ReprobeMs);
  return Number.isFinite(asked) && asked > 0 ? asked : undefined;
}

/** Deletes everything the page cached (sign-out, unpairing, revocation), and says why in the diagnostics. */
export async function clearCachedContent(why: string): Promise<void> {
  await contentCache.clear();
  await clearContentCache();
  diagnostics.player.cache.cleared.push(why);
}

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
    // Through the relay when the page was asked to (`?via=relay`) and the offer names the server's room (M2 step 13).
    const relay = ASKED_PATH === "relay" ? offer.addresses.relay : undefined;
    const run = pair({
      offer, keys: k, name: defaultName(), wsUrl: wsUrlFor(location.href), feVersion: FE_VERSION, save: saveDevice,
      ...(relay ? { transport: "relay" as const, WebSocketImpl: relaySocketImpl(() => ({ url: relay.url, room: relay.room, token: relayPairToken(offer.offer, fromBase64Url(offer.secret)!) })) } : {}),
    });
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
  const [path, setPath] = useState<DialPath>("direct");
  const [serverId, setServerId] = useState<string>(device.server.memberId);
  const [deviceServers, setDeviceServers] = useState<StoredServer[]>(() => device.servers ?? []);
  const mounted = useRef<MountedRenderer | null>(null);

  useEffect(() => {
    setServerId(device.server.memberId);
    setDeviceServers(device.servers ?? []);
  }, [device]);

  const capabilities = useMemo<Omit<PageCapabilities, "uploads">>(() => ({
    openLink: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
    narrow: phoneWidth,
    scopes: device.scope as DeviceScope[],
  }), [device]);

  const forget = useCallback(async () => {
    mounted.current?.unmount();
    mounted.current = null;
    await connection?.close().catch(() => undefined);
    await forgetDevice([DEFAULT_IDB_NAME]);
    await clearCachedContent("sign-out");
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
    let media: MediaBroker | null = null;
    let uploads: PageUploads | null = null;
    let bridge: SwBridge | null = null;
    // D73: this device was removed from the roster (unpaired or revoked on the computer): the server says so with
    // `bye{revoked}` (both while connected and on later handshakes), what the page cached goes at once (§9A.6), the
    // outbox stays unsent, and the banner tells the user to pair again.
    let deviceRevoked = false;
    let updateBanner: (() => void) | null = null;
    const revoked = (why: string) => { deviceRevoked = true; media?.dropCached(); void clearCachedContent(why); updateBanner?.(); };
    const applyPath = (nextPath: DialPath) => {
      if (cancelled) return;
      setPath(nextPath);
      const kind = nextPath === "relay" ? "relay" : pathOfPage(location.hostname);
      diagnostics.player.path = kind;
      if (nextPath === "relay" && opened && !bridge) {
        bridge = new SwBridge(opened.link, diagnostics.bridge);
        bridge.start();
      }
      media?.setPath(kind, nextPath === "relay" ? bridge : null);
    };
    void (async () => {
      // `?via=` forces one path for this page load; otherwise saved manual "relay" override or automatic fallback.
      const saved = ASKED_PATH ? null : await loadPref("path").catch(() => null);
      const wanted = ASKED_PATH ?? (saved === "relay" ? "relay" : null);
      const forcedPath: DialPath | undefined = wanted === "relay" && device.relay ? "relay" : wanted === "tailnet" ? "direct" : undefined;
      const initialPath: DialPath = forcedPath ?? "direct";
      diagnostics.player.path = initialPath === "relay" ? "relay" : pathOfPage(location.hostname);
      if (!cancelled) setPath(initialPath);
      const reprobeIntervalMs = reprobeMs();
      return openConnection(device, diagnostics, location.href, {
        ...(forcedPath ? { forcedPath } : {}),
        onPath: applyPath,
        onServer: (nextServerId) => { if (!cancelled) setServerId(nextServerId); },
        onRevoked: () => revoked("revoked (bye)"),
        ...(reprobeIntervalMs !== undefined ? { reprobeIntervalMs } : {}),
      });
    })().then((conn) => {
      if (cancelled) { void conn.close(); return; }
      opened = conn;
      if (conn.revoked) deviceRevoked = true;
      if (conn.serverId) setServerId(conn.serverId);
      const update = () => {
        const text = bannerText(conn.link.status, conn.link.pending(), conn.link.servers(), deviceRevoked);
        const last = diagnostics.banners[diagnostics.banners.length - 1];
        if (text && last !== text) { diagnostics.banners.push(text); if (diagnostics.banners.length > 200) diagnostics.banners.shift(); }
        setBanner({ text, state: deviceRevoked ? "needs pairing" : conn.link.status.state === "live" && text ? "peer" : conn.link.status.state });
      };
      updateBanner = update;
      conn.link.on((event) => { if (event.type === "bye" && event.reason === "revoked") revoked("revoked (bye)"); });
      conn.link.on((event) => { if (event.type === "state" || event.type === "pending" || event.type === "outcome" || event.type === "servers") update(); });
      conn.link.on((event) => {
        if (event.type === "attached" && event.attached) {
          const nextId = conn.serverId ?? conn.link.attachedServerId();
          if (nextId) setServerId(nextId);
          void syncPushOnAttach({
            vapidPublicKey: conn.link.vapidPublicKey,
            sendPushSubscribe: (sub) => {
              const ok = conn.link.sendPushSubscribe(sub);
              if (ok) { diagnostics.push.state = "subscribed"; diagnostics.push.sends += 1; diagnostics.push.error = undefined; }
              return ok;
            },
            prefs: { load: loadPref, save: savePref },
          }).catch(() => undefined);
        }
        if ((event.type === "attached" && event.attached) || (event.type === "message" && event.message.t === "peer")) {
          void saveDeviceServers(conn.link.servers()).then((merged) => {
            if (!cancelled && Array.isArray(merged)) setDeviceServers(merged);
          }, () => undefined);
        }
      });
      // A line's media (step 9): the chat frame names a file, the shell answers with its ticketed /v3/c/ URL.
      const frame = () => (rendererRoot.current?.ownerDocument.querySelector("iframe[src*='/v3/chat.html']") as HTMLIFrameElement | null)?.contentWindow ?? null;
      // The relay path (step 14): the page's service worker answers its content URLs over this session.
      if (conn.path === "relay") { bridge = new SwBridge(conn.link, diagnostics.bridge); bridge.start(); }
      media = new MediaBroker(conn.link, frame, diagnostics.media,
        { cache: contentCache, path: diagnostics.player.path, player: diagnostics.player, storage: { load: loadPref, save: savePref }, bridge, video: diagnostics.video });
      media.start();
      applyPath(conn.path);
      // Attachments (step 12): the chat frame hands its files over, they are uploaded over the session.
      uploads = new PageUploads(conn.link, frame, diagnostics.uploads);
      uploads.start();
      mounted.current = mountRenderer(rendererRoot.current!, { link: conn.port, capabilities: { ...capabilities, uploads }, clock: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }, chrome });
      const initialBot = safeBotId(new URLSearchParams(location.search).get("bot"));
      if (initialBot) mounted.current.store.select(initialBot);
      conn.link.start();
      update();
      setConnection(conn);
    }, (error) => setFailure(`This page could not open its storage: ${String((error as Error)?.message ?? error)}`));
    return () => { cancelled = true; media?.stop(); uploads?.stop(); bridge?.stop(); mounted.current?.unmount(); mounted.current = null; void opened?.close(); };
    // The connection lives as long as this device's page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device]);

  useEffect(() => { mounted.current?.render(chrome); }, [chrome]);

  useEffect(() => {
    const sw = typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { botling3?: unknown; botId?: unknown } | null;
      if (data?.botling3 !== "push.open") return;
      const botId = safeBotId(data.botId);
      if (botId) mounted.current?.store.select(botId);
    };
    sw.addEventListener("message", onMessage);
    return () => sw.removeEventListener("message", onMessage);
  }, []);

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
    {banner.text && <div className="v3-conn" role="status" data-state={banner.state} data-path={path} data-testid="conn-banner">{banner.text}{path === "relay" && banner.state !== "needs pairing" ? " · via relay" : ""}</div>}
    <div id="v3-renderer" className="v3-renderer" ref={rendererRoot} />
    {failure && <div className="banner bottom web-banner" role="alert">{failure}</div>}
    <div className="web-scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
    {sheet && <ThisDevice device={device} connection={connection} path={path} serverId={serverId} knownServers={deviceServers} onClose={() => setSheet(false)} onForget={() => void forget()} />}
  </div>;
}

interface PickerServer {
  id: string;
  name: string;
  state?: ServerState;
}

function serverOptionLabel(server: PickerServer, targetId: string, attachedId: string | null): string {
  const tags: string[] = [];
  if (server.id === attachedId) tags.push("attached");
  else if (server.id === targetId) tags.push("target");
  if (server.state === "gone") tags.push("removed");
  else if (server.state === "stale") tags.push("offline");
  return tags.length > 0 ? `${server.name} ${tags.map((t) => `(${t})`).join(" ")}` : server.name;
}

/** Settings › This device: who this device is, which server it is paired with, and forgetting it. */
export function ThisDevice({
  device,
  connection,
  path,
  serverId,
  knownServers,
  pushPrefs,
  onClose,
  onForget,
}: {
  device: DeviceRecord;
  connection: Connection | null;
  path: DialPath;
  serverId: string;
  knownServers?: readonly StoredServer[];
  pushPrefs?: PushPrefs;
  onClose: () => void;
  onForget: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [plugins, setPlugins] = useState(false);
  const [pendingItems, setPendingItems] = useState(() => connection?.link.pending() ?? []);
  const [attached, setAttached] = useState(() => connection?.link.attached ?? false);
  const [attachedServerId, setAttachedServerId] = useState<string | null>(
    () => (connection?.link.attached ? (connection.link.attachedServerId() ?? null) : null),
  );
  const [liveServers, setLiveServers] = useState<PickerServer[]>(() => (connection?.link.attached ? connection.link.servers() : []));
  const [selectedServerId, setSelectedServerId] = useState<string>(serverId);
  const prefs = useMemo<PushPrefs>(() => pushPrefs ?? { load: loadPref, save: savePref }, [pushPrefs]);
  const [pushSupportState, setPushSupportState] = useState(() => pushSupport());
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushNotice, setPushNotice] = useState<string | null>(null);
  const pushBusyRef = useRef(false);
  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(() => connection?.link.vapidPublicKey ?? null);

  useEffect(() => {
    let alive = true;
    void prefs.load(PUSH_ENABLED_PREF).then((value) => { if (alive) setPushEnabled(value === "1"); }, () => undefined);
    return () => { alive = false; };
  }, [prefs]);

  useEffect(() => {
    setSelectedServerId(serverId);
  }, [serverId]);

  useEffect(() => {
    if (!connection) {
      setPendingItems([]);
      setAttached(false);
      setAttachedServerId(null);
      setLiveServers([]);
      setVapidPublicKey(null);
      return;
    }
    const syncLink = (attachedOverride?: boolean) => {
      const isAttached = attachedOverride ?? connection.link.attached;
      setAttached(isAttached);
      setAttachedServerId(isAttached ? (connection.link.attachedServerId() ?? null) : null);
      setLiveServers(isAttached ? connection.link.servers() : []);
      setVapidPublicKey(connection.link.vapidPublicKey ?? null);
    };
    setPendingItems(connection.link.pending());
    syncLink();
    return connection.link.on((event) => {
      if (event.type === "pending" || event.type === "outcome") setPendingItems(connection.link.pending());
      if (event.type === "state") {
        syncLink();
      } else if (event.type === "attached") {
        syncLink(event.attached);
      } else if (event.type === "servers" || (event.type === "message" && event.message.t === "peer")) {
        syncLink();
      }
    });
  }, [connection]);

  const stickyServers = knownServers ?? device.servers ?? [];
  const goneIds = new Set(stickyServers.filter((s) => s.state === "gone").map((s) => s.id));
  const baseServers: readonly PickerServer[] = attached
    ? liveServers
    : (stickyServers.length > 0 ? stickyServers : [{ id: device.server.memberId, name: device.server.name }]);
  const serverOptions: PickerServer[] = baseServers.map((s) => (
    goneIds.has(s.id) && s.state !== "gone" ? { ...s, state: "gone" as const } : s
  ));
  if (!serverOptions.some((s) => s.id === selectedServerId)) {
    serverOptions.push({ id: selectedServerId, name: selectedServerId, ...(goneIds.has(selectedServerId) ? { state: "gone" as const } : {}) });
  }
  if (attachedServerId && !serverOptions.some((s) => s.id === attachedServerId)) {
    serverOptions.push({ id: attachedServerId, name: attachedServerId, ...(goneIds.has(attachedServerId) ? { state: "gone" as const } : {}) });
  }
  const serverName = (id: string): string => serverOptions.find((s) => s.id === id)?.name ?? id;
  const serverStatusText = attachedServerId
    ? (attachedServerId === selectedServerId
      ? `Attached to ${serverName(attachedServerId)}`
      : `Switching to ${serverName(selectedServerId)}… (attached to ${serverName(attachedServerId)})`)
    : `Connecting to ${serverName(selectedServerId)}…`;

  const pending = pendingItems.length;
  const stoppedItems = pendingItems.filter((item) => item.stopped);
  return <div className="v3-sheet-scrim" role="presentation" onClick={onClose}>
    <section className="v3-sheet" role="dialog" aria-label="This device" onClick={(event) => event.stopPropagation()}>
      <h2>This device</h2>
      <dl>
        <dt>Name</dt><dd>{device.name}</dd>
        <dt>Device id</dt><dd><code>{device.memberId}</code></dd>
        <dt>Paired with</dt><dd>{device.server.name}</dd>
        <dt><label htmlFor="v3-server-picker">Server</label></dt>
        <dd>
          <select
            id="v3-server-picker"
            data-testid="server-picker"
            aria-label="Server"
            value={selectedServerId}
            data-target={selectedServerId}
            data-attached={attachedServerId ?? ""}
            disabled={!connection?.pickServer || serverOptions.length === 0}
            onChange={(event) => {
              const nextId = event.target.value;
              if (!nextId || nextId === selectedServerId) return;
              // D72: M4-20a owns server switching and preference persistence; M4-20b only invokes pickServer.
              if (connection?.pickServer?.(nextId)) setSelectedServerId(nextId);
            }}
          >
            {serverOptions.map((server) => (
              <option key={server.id} value={server.id} disabled={server.state === "gone"}>
                {serverOptionLabel(server, selectedServerId, attachedServerId)}
              </option>
            ))}
          </select>
          <div className="v3-server-status" data-testid="server-status">{serverStatusText}</div>
        </dd>
        <dt>Allowed</dt><dd>{device.scope.join(", ")}</dd>
        <dt>Paired</dt><dd>{new Date(device.pairedAt).toLocaleString()}</dd>
        <dt>Waiting to send</dt><dd>{pending}</dd>
        <dt>Connected</dt><dd data-testid="dial-path">{path === "relay" ? "via relay" : diagnostics.player.path === "local" ? "on this computer" : "via tailnet"}</dd>
        <dt>Notifications</dt>
        <dd>
          <div className="v3-push-status" data-testid="push-status">
            {!pushSupportState.supported
              ? pushSupportState.message
              : (pushEnabled && typeof Notification !== "undefined" && Notification.permission === "granted" ? "Enabled" : "Off")}
          </div>
          {pushSupportState.supported && (
            pushEnabled && typeof Notification !== "undefined" && Notification.permission === "granted"
              ? <button
                  type="button"
                  className="web-secondary v3-push-btn"
                  data-testid="disable-notifications"
                  disabled={pushBusy}
                  onClick={() => {
                    if (pushBusyRef.current) return;
                    pushBusyRef.current = true;
                    setPushBusy(true);
                    setPushNotice(null);
                    void disablePushNotifications(prefs).then(() => {
                      setPushEnabled(false);
                      diagnostics.push.state = "idle";
                      diagnostics.push.error = undefined;
                      setPushNotice("Notifications turned off for this browser.");
                    }).finally(() => {
                      pushBusyRef.current = false;
                      setPushBusy(false);
                    });
                  }}
                >
                  Turn off notifications
                </button>
              : <button
                  type="button"
                  className="web-secondary v3-push-btn"
                  data-testid="enable-notifications"
                  disabled={pushBusy || !attached || !vapidPublicKey}
                  onClick={() => {
                    if (pushBusyRef.current) return;
                    pushBusyRef.current = true;
                    setPushBusy(true);
                    setPushNotice(null);
                    diagnostics.push.state = "subscribing";
                    diagnostics.push.error = undefined;
                    void enablePushNotifications({
                      vapidPublicKey,
                      sendPushSubscribe: (sub) => connection?.link.sendPushSubscribe(sub) ?? false,
                      prefs,
                    }).then((result) => {
                      setPushSupportState(pushSupport());
                      if (!result.ok) {
                        diagnostics.push.state = "error";
                        diagnostics.push.error = result.message;
                        setPushNotice(result.message);
                        return;
                      }
                      setPushEnabled(true);
                      diagnostics.push.state = "subscribed";
                      if (result.sent) {
                        diagnostics.push.sends += 1;
                        setPushNotice("Subscription sent to server. Lock screen shows only the bot name and \"needs you\".");
                      } else {
                        setPushNotice("Saved locally; will send when attached to the server.");
                      }
                    }, () => {
                      diagnostics.push.state = "error";
                      diagnostics.push.error = "Could not enable push notifications.";
                      setPushNotice("Could not enable push notifications.");
                    }).finally(() => {
                      pushBusyRef.current = false;
                      setPushBusy(false);
                    });
                  }}
                >
                  {pushBusy ? "Enabling…" : "Enable notifications"}
                </button>
          )}
          {!pushSupportState.supported && pushSupportState.reason === "ios-home-screen" && (
            <button type="button" className="web-secondary v3-push-btn" data-testid="enable-notifications" disabled>
              Enable notifications (requires Home Screen app on iOS)
            </button>
          )}
          <div className="v3-push-hint">On iPhone and iPad, open Botling from your Home Screen app.</div>
          {pushNotice && <div className="v3-push-hint" data-testid="push-notice">{pushNotice}</div>}
        </dd>
      </dl>
      {stoppedItems.length > 0 && <div className="v3-sheet-stopped" data-testid="stopped-items">
        {stoppedItems.map((item) => <div key={item.key} className="v3-sheet-stopped-item" data-testid="stopped-item">
          <p className="v3-sheet-stopped-title"><code>{item.cmd.type}</code></p>
          <p className="v3-sheet-stopped-msg">{itemWords(item)}</p>
          <p className="v3-sheet-warn">{UNSETTLED_LEGACY_WARNING}</p>
          <div className="v3-sheet-actions">
            <button type="button" className="web-secondary" onClick={() => void connection?.link.giveUp(item.slot).catch(() => undefined)}>Give up</button>
          </div>
        </div>)}
      </div>}
      <div className="v3-sheet-actions">
        <button type="button" className="web-secondary" data-testid="plugins-open" onClick={() => setPlugins(true)}>Plugins</button>
      </div>
      {device.relay && <div className="v3-sheet-actions">
        <button type="button" className="web-secondary" data-testid="switch-path" onClick={() => void savePref("path", path === "relay" ? "auto" : "relay").then(() => location.reload())}>
          {path === "relay" ? "Connect directly" : "Connect via relay"}</button>
      </div>}
      {confirm
        ? <><p className="v3-sheet-warn">Forget this device? Messages still waiting here are dropped, and you pair again with a new link. To stop it everywhere, revoke it on the computer (botlingd revoke-device).</p>
          <div className="v3-sheet-actions"><button type="button" className="web-secondary" onClick={() => setConfirm(false)}>Keep</button><button type="button" className="web-primary" onClick={onForget}>Forget</button></div></>
        : <div className="v3-sheet-actions"><button type="button" className="web-secondary" onClick={() => setConfirm(true)}>Forget this device…</button><button type="button" className="web-primary" onClick={onClose}>Done</button></div>}
    </section>
    {plugins && <PluginsSheet device={device} connection={connection} onClose={() => setPlugins(false)} />}
  </div>;
}

const NO_PLUGIN_SOURCE: PluginSource = { servers: () => [], rows: () => null };

/**
 * This device › Plugins (M5-14b, D54, §11.7): the list, and the grant sheet. It is the shell's own sheet, never drawn in a
 * plugin frame. [Allow] sends one `plugin.grant` per machine that holds the shown code hash, each as that machine's own
 * item (no `via`), and then shows each one's delivery words as for any command.
 */
export function PluginsSheet({ device, connection, onClose }: { device: DeviceRecord; connection: Connection | null; onClose: () => void }) {
  const [, setTick] = useState(0);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [choice, setChoice] = useState<GrantTier | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const link = connection?.link ?? null;
  const source = useMemo(() => (link ? linkPluginSource(link) : NO_PLUGIN_SOURCE), [link]);
  const canManage = device.scope.includes("manage");

  useEffect(() => {
    if (!link) return;
    // Rows (a peer's table changed) and delivery states change what the sheet shows.
    return link.on((event) => { if (event.type === "servers" || event.type === "pending" || event.type === "outcome" || event.type === "attached") setTick((n) => n + 1); });
  }, [link]);

  const review = (name: string) => {
    setFailure(null);
    setChoice(pluginSheet(source, name)?.selected ?? null);
    setReviewing(name);
  };
  const sheet = reviewing ? pluginSheet(source, reviewing) : null;
  const back = () => { setReviewing(null); setFailure(null); };

  // What this sheet already put in the outbox, by plugin, hash and machine, and the one tier it sent for that plugin and
  // hash: a retry after a part-way failure, or a second Review, sends only that tier and only to the machines that have
  // not got it (a resend would be a new slot and a new audit row; another tier would undo the first act on some machines
  // while the rows still show the old grant).
  const delivered = useRef(new Map<string, { name: string; slot: Slot }>());
  const lockedTier = useRef(new Map<string, GrantTier>());
  const sheetKey = (name: string, hash: string) => `${name}\u0000${hash}`;
  const deliveredKey = (name: string, hash: string, serverId: string) => `${sheetKey(name, hash)}\u0000${serverId}`;
  // One user act sends once: a second tap while the first is still being written to the outbox does nothing.
  const allowing = useRef(false);
  const allow = async () => {
    if (!link || !sheet || !canManage || allowing.current) return;
    const lock = sheetKey(sheet.name, sheet.codeHash);
    const tier = lockedTier.current.get(lock) ?? choice;
    if (tier === null) return;
    allowing.current = true;
    try {
      const items = grantCommands(sheet, tier);
      lockedTier.current.set(lock, tier); // before the first await: a radio change mid-send cannot split the act
      for (const item of items) {
        const serverId = item.target.slice("srv:".length);
        const key = deliveredKey(sheet.name, sheet.codeHash, serverId);
        if (delivered.current.has(key)) continue;
        const slot = (await link.submit(item.target, item.cmd)).slot;
        delivered.current.set(key, { name: sheet.targets.find((h) => h.serverId === serverId)?.serverName ?? serverId, slot });
        setTick((n) => n + 1);
      }
      setFailure(null);
    } catch (error) {
      // What was already sent stays shown, and [Allow] stays for the machines that have not got it. Nothing sent yet:
      // the tier is free again.
      if (!sheet.targets.some((h) => delivered.current.has(deliveredKey(sheet.name, sheet.codeHash, h.serverId)))) lockedTier.current.delete(lock);
      setFailure((error as Error).message);
    } finally {
      allowing.current = false;
      setTick((n) => n + 1);
    }
  };

  if (reviewing && sheet) {
    const views = link?.pending() ?? [];
    const locked = lockedTier.current.get(sheetKey(sheet.name, sheet.codeHash));
    const shownChoice = locked ?? choice;
    const sent = sheet.targets.flatMap((h) => delivered.current.get(deliveredKey(sheet.name, sheet.codeHash, h.serverId)) ?? []);
    return <div className="v3-sheet-scrim" role="presentation" onClick={onClose}>
      <section className="v3-sheet" role="dialog" aria-label="Plugin grant" data-testid="grant-sheet" onClick={(event) => event.stopPropagation()}>
        <h2>{sheet.title}</h2>
        <p>{sheet.askLine}</p>
        {sheet.differing.map((line) => <p key={line} className="v3-sheet-warn">{line}</p>)}
        {sheet.builtIn
          ? <p className="v3-sheet-warn">built in</p>
          : <fieldset className="v3-grant-options">
            <legend>Allow it to:</legend>
            {sheet.options.map((option) => <label key={option.tier} className="v3-grant-option">
              <input type="radio" name="v3-grant-tier" value={option.tier} checked={shownChoice === option.tier} disabled={locked !== undefined}
                onChange={() => setChoice(option.tier)} /> {option.words}</label>)}
          </fieldset>}
        {sent.length > 0 && <div data-testid="grant-sent">
          <p>{`Sent to ${sent.length} ${sent.length === 1 ? "machine" : "machines"}.`}</p>
          {sent.map(({ name, slot }) => {
            const view = views.find((item) => item.key === slotKey(slot));
            return <p key={slotKey(slot)} className="v3-sheet-warn">{view ? `${name}: ${itemWords(view)}` : name}</p>;
          })}
        </div>}
        {failure && <p className="v3-sheet-warn" role="alert">{failure}</p>}
        <div className="v3-sheet-actions">
          <button type="button" className="web-secondary" onClick={back}>{sent.length > 0 ? "Done" : "Cancel"}</button>
          {sent.length < sheet.targets.length && <button type="button" className="web-primary" disabled={!canManage || shownChoice === null || sheet.targets.length === 0} onClick={() => void allow()}>Allow</button>}
        </div>
      </section>
    </div>;
  }

  const list = listPlugins(source);
  return <div className="v3-sheet-scrim" role="presentation" onClick={onClose}>
    <section className="v3-sheet" role="dialog" aria-label="Plugins" data-testid="plugins-sheet" onClick={(event) => event.stopPropagation()}>
      <h2>This device › Plugins</h2>
      <div className="v3-plugin-list">
        {list.map((plugin) => <div key={plugin.name} className="v3-plugin-row" data-testid="plugin-row">
          <span className="v3-plugin-name">{plugin.name}</span>
          <span>{plugin.authorWords}</span>
          <span>{plugin.tierWords}</span>
          {!plugin.builtIn && (canManage
            ? <button type="button" className="web-secondary" onClick={() => review(plugin.name)}>Review</button>
            : <span className="v3-sheet-warn">{ONLY_MANAGE}</span>)}
        </div>)}
      </div>
      <div className="v3-sheet-actions"><button type="button" className="web-primary" onClick={onClose}>Done</button></div>
    </section>
  </div>;
}
