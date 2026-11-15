// Settings › Phone, Botling 3 (shown by PhoneSettings when botlingd's view carries `v3`; botlingd answers these requests
// itself, server/pairing/phone-desk.ts). The relay (on, off, elsewhere: botlingd switches at once), the first pairing
// (one button: the cluster is made, its recovery code shown once in a dialog like an API key, never typed back, and the
// pairing code follows when it is saved), a pairing code as a QR of the Botling 3 link, the phone's 6-digit code to
// compare and accept or reject, and the paired phones. Secrets (the link, the recovery code) live in this component's
// state only until they are used, hidden or expire; they are never written anywhere or shown as plain text (the link).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MobileClusterView, MobileDeskView, MobilePairView, MobileV3View } from "../contract";
import { qrModules } from "../server/pairing/qr";
import { Client, RequestFailed } from "./client";
import { mobileWords } from "./mobile-text";
import { ShellOverlay } from "./ShellOverlay";

const why = (failure: unknown) => (failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));
const when = (ms: number, lang: string | null) => new Date(ms).toLocaleDateString(lang ?? undefined, { month: "short", day: "numeric" });
/** "042917" → "042 917" (easier to read off two screens). */
const grouped = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/** A QR code of a Botling 3 pairing link (about 600 bytes: the v3 encoder, every version), one SVG path. */
function PairQr({ text, label }: { text: string; label: string }) {
  const shape = useMemo(() => {
    try {
      const modules = qrModules(text);
      const quiet = 4;
      let d = "";
      modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + quiet},${y + quiet}h1v1h-1z`; }));
      return { size: modules.length + quiet * 2, d };
    } catch { return null; }
  }, [text]);
  if (!shape) return null;
  return (
    <svg className="qr-code" role="img" aria-label={label} viewBox={`0 0 ${shape.size} ${shape.size}`} width={256} height={256} shapeRendering="crispEdges">
      <rect width={shape.size} height={shape.size} fill="#fff" />
      <path d={shape.d} fill="#000" />
    </svg>
  );
}

type Props = {
  client: Client;
  lang: string | null;
  view: MobileDeskView & { v3: MobileV3View };
  setView: (view: MobileDeskView) => void;
  refresh: () => Promise<void>;
};

export function PhoneSettingsV3({ client, lang, view, setView, refresh }: Props) {
  const words = mobileWords(lang);
  const t = words.v3;
  const v3 = view.v3;
  const relay = view.relay ?? { url: null, state: "off" as const };
  const [failed, setFailed] = useState<string | null>(null);
  const [relayText, setRelayText] = useState<string | null>(null);
  const [savingRelay, setSavingRelay] = useState(false);
  /** The recovery code just made, shown once in a dialog; gone when "I've saved it" is pressed. */
  const [recovery, setRecovery] = useState<string | null>(null);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [clusterBusy, setClusterBusy] = useState(false);
  const [offer, setOffer] = useState<MobilePairView | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** The last pairing's outcome, said after its code is gone (paired, or why not). */
  const [outcome, setOutcome] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // In-flight guards (L-007): a double click sends one request.
  const busy = useRef({ cluster: false, pair: false, confirm: false, relay: false });

  const followed = offer ? v3.offers.find((entry) => entry.offer === offer.offer) ?? null : null;
  const state = followed?.state ?? (offer ? "waiting" : null);

  // While a code is out, look again every second (the phone's 6-digit code arrives as a pairing event in botlingd).
  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= offer.expiresAt && state !== "adding") { setOffer(null); setOutcome(t.declined.expired); }
      void refresh();
    }, 1_000);
    return () => clearInterval(timer);
  }, [offer, state, refresh, t.declined.expired]);
  // A finished pairing: the code goes, its outcome stays said.
  useEffect(() => {
    if (!offer || !followed) return;
    if (followed.state === "paired") { setOffer(null); setOutcome(t.paired(followed.device || words.unnamed)); }
    else if (followed.state === "declined") { setOffer(null); setOutcome(t.declined[followed.reason ?? "cancelled"]); }
  }, [offer, followed, t, words.unnamed]);
  // While the recovery code is shown, Escape does not close Settings under it (the code would be lost unseen).
  useEffect(() => {
    if (!recovery) return;
    const hold = (event: KeyboardEvent) => { if (event.key === "Escape") event.stopImmediatePropagation(); };
    window.addEventListener("keydown", hold, true);
    return () => window.removeEventListener("keydown", hold, true);
  }, [recovery]);

  const saveRelay = async (url: string | null) => {
    if (busy.current.relay) return;
    busy.current.relay = true; setSavingRelay(true); setFailed(null);
    try { setView(await client.request({ type: "mobile.relay", url })); setRelayText(null); setOffer(null); }
    catch (failure) { setFailed(why(failure)); }
    finally { busy.current.relay = false; setSavingRelay(false); }
  };
  const setUp = async () => {
    if (busy.current.cluster) return;
    busy.current.cluster = true; setClusterBusy(true); setFailed(null);
    try {
      const made: MobileClusterView = await client.request({ type: "mobile.cluster" });
      if (made.ok && made.code) { setRecovery(made.code); setRecoveryCopied(false); }
      await refresh();
    } catch (failure) { setFailed(why(failure)); void refresh(); }
    finally { busy.current.cluster = false; setClusterBusy(false); }
  };
  /** "I've saved it": the code goes, and the pairing code (the QR) follows at once. */
  const savedRecovery = () => { setRecovery(null); void createCode(); };
  const createCode = async () => {
    if (busy.current.pair) return;
    busy.current.pair = true; setCreating(true); setFailed(null); setOutcome(null);
    try { setOffer(await client.request({ type: "mobile.pair" })); setNow(Date.now()); void refresh(); }
    catch (failure) { setFailed(why(failure)); }
    finally { busy.current.pair = false; setCreating(false); }
  };
  const answer = async (accept: boolean, code: string) => {
    if (busy.current.confirm || !offer) return;
    busy.current.confirm = true; setFailed(null);
    try { setView(await client.request({ type: "mobile.confirm", offer: offer.offer!, accept, code })); }
    catch (failure) { setFailed(why(failure)); void refresh(); }
    finally { busy.current.confirm = false; }
  };
  const revoke = async (id: string) => {
    setAsking(null);
    try { setView(await client.request({ type: "mobile.revoke", deviceId: id })); } catch (failure) { setFailed(why(failure)); void refresh(); }
  };
  const copyLink = useCallback(async (url: string) => {
    try { await navigator.clipboard.writeText(url); setCopied(url); } catch (failure) { setFailed(why(failure)); }
  }, []);
  const copyRecovery = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setRecoveryCopied(true); } catch (failure) { setFailed(why(failure)); }
  };

  const relayValue = relayText ?? relay.url ?? "";
  const minutes = offer ? Math.max(1, Math.ceil((offer.expiresAt - now) / 60_000)) : 0;

  return (
    <>
      {failed && <p className="settings-note" role="alert">{failed}</p>}
      <section className="settings-group" aria-label={words.relayTitle}>
        <h3>{words.relayTitle}</h3>
        <p className="settings-note">{t.relayNote}</p>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-label">{words.relayAddress}<div className="settings-hint">{words.relayState[relay.state]}</div></div>
            <div className="settings-control">
              <input type="url" aria-label={words.relayAddress} placeholder="wss://relay.example.com/ws" spellCheck={false} autoComplete="off"
                value={relayValue} disabled={savingRelay || v3.relayFixed} onChange={(event) => setRelayText(event.target.value)} />
            </div>
          </div>
          {v3.relayFixed
            ? <div className="settings-row"><div className="settings-hint">{t.relayFixed}</div></div>
            : (
              <div className="settings-actions">
                <button type="button" disabled={savingRelay || !relayValue.trim() || (relay.url === relayValue.trim() && relay.state !== "off")} onClick={() => void saveRelay(relayValue.trim())}>{savingRelay ? words.relaySaving : words.relayOn}</button>
                {relay.url && <button type="button" disabled={savingRelay} onClick={() => void saveRelay(null)}>{words.relayOff}</button>}
              </div>
            )}
        </div>
      </section>

      <section className="settings-group" aria-label={words.pairTitle}>
        <h3>{words.title}</h3>
        <p className="settings-note">{words.note}</p>
        <div className="settings-card">
          {v3.cluster !== "ready" && (
            <>
              <div className="settings-row"><div className="settings-label">{words.pairTitle}<div className="settings-hint">{t.setupNote}</div></div></div>
              <div className="settings-actions">
                <button type="button" disabled={clusterBusy} onClick={() => void setUp()}>{clusterBusy ? words.creating : t.setup}</button>
              </div>
            </>
          )}
          {v3.cluster === "ready" && (
            <>
              <div className="settings-row"><div className="settings-label">{words.pairTitle}<div className="settings-hint">{t.pairNote}</div></div></div>
              {outcome && !offer && <div className="settings-row"><div className="settings-hint" role="status">{outcome}</div></div>}
              <div className="settings-actions">
                <button type="button" disabled={creating || (offer !== null && state !== "waiting")} onClick={() => void createCode()}>{creating ? words.creating : words.create}</button>
              </div>
              {offer && state === "waiting" && (
                <div className="phone-offer">
                  <PairQr text={offer.url} label={words.scan} />
                  <p className="settings-hint">{words.scan} · {words.expires(minutes)}</p>
                  {offer.note && <p className="settings-hint">{offer.note}</p>}
                  <p className="settings-hint">{words.copyNote}</p>
                  <div className="settings-actions">
                    <button type="button" onClick={() => void copyLink(offer.url)}>{copied === offer.url ? words.copied : words.copyLink}</button>
                    <button type="button" className="task-report" onClick={() => setOffer(null)}>{words.hide}</button>
                  </div>
                </div>
              )}
              {offer && state === "compare" && followed?.code && (
                <div className="phone-offer" role="group" aria-label={t.compareTitle}>
                  <p className="settings-label">{t.compareTitle}</p>
                  <p className="settings-hint">{t.compareNote(followed.device || words.unnamed)}</p>
                  <p><strong className="phone-compare-code">{grouped(followed.code)}</strong></p>
                  <div className="settings-actions">
                    <button type="button" onClick={() => void answer(true, followed.code!)}>{t.accept}</button>
                    <button type="button" className="task-report" onClick={() => void answer(false, followed.code!)}>{t.reject}</button>
                  </div>
                </div>
              )}
              {offer && state === "adding" && <div className="settings-row"><div className="settings-hint" role="status">{t.adding}</div></div>}
            </>
          )}
        </div>
      </section>

      {recovery && (
        <ShellOverlay><div className="dialog-backdrop">
          <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="phone-recovery-title" aria-describedby="phone-recovery-note">
            <h2 id="phone-recovery-title">{t.codeTitle}</h2>
            <p><code className="phone-recovery-code">{recovery}</code></p>
            <p id="phone-recovery-note">{t.codeNote}</p>
            <div className="dialog-buttons">
              <button type="button" className="dialog-cancel" onClick={() => void copyRecovery(recovery)}>{recoveryCopied ? t.copied : t.copyCode}</button>
              <button type="button" className="dialog-primary" onClick={savedRecovery} autoFocus>{t.saved}</button>
            </div>
          </div>
        </div></ShellOverlay>
      )}

      <section className="settings-group" aria-label={words.devices}>
        <h3>{words.devices}</h3>
        <div className="settings-card">
          {v3.devices.length === 0 && <div className="settings-row"><div className="settings-label">{words.none}</div></div>}
          {v3.devices.map((device) => {
            const name = device.name || words.unnamed;
            return (
              <div className="settings-row" key={device.id}>
                <div className="settings-label">{name}
                  <div className="settings-hint">{t.added(when(device.addedAt, lang))}</div>
                  {asking === device.id && <div className="settings-hint" role="alert">{words.revokeAsk(name)}</div>}
                </div>
                <div className="settings-control">
                  {asking === device.id
                    ? <><button type="button" onClick={() => void revoke(device.id)}>{words.revokeYes}</button> <button type="button" onClick={() => setAsking(null)}>{words.cancel}</button></>
                    : <button type="button" aria-label={`${words.revoke} ${name}`} onClick={() => setAsking(device.id)}>{words.revoke}</button>}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
