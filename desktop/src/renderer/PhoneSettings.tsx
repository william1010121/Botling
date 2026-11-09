// Settings > Phone: turn the end-to-end encrypted relay on or off, make a one-time pairing code (QR) for the relay
// or one of the bridge's routes, see the routes a phone tries, and list or revoke paired phones. The core does the
// work (mobile-bridge/desk.ts, mobile-relay/connector.ts); this shows what it says. The pairing link is a secret:
// it is held in this component's state only until it is hidden, used, or expires, and is never written anywhere.
import { useCallback, useEffect, useState } from "react";
import type { BotView, MobileDeskView, MobilePairView } from "../contract";
import { Client, RequestFailed } from "./client";
import { mobileWords } from "./mobile-text";
import { QrCode } from "./qr-view";

const why = (failure: unknown) => (failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));
const when = (ms: number, lang: string | null) => new Date(ms).toLocaleDateString(lang ?? undefined, { month: "short", day: "numeric" });

export function PhoneSettings({ client, bots, lang }: { client: Client; bots: BotView[]; lang: string | null }) {
  const words = mobileWords(lang);
  const [view, setView] = useState<MobileDeskView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** The address in the code, once the user picked one; until then the relay when it is connected, else the first route. */
  const [route, setRoute] = useState<number | "relay" | null>(null);
  const [relayText, setRelayText] = useState<string | null>(null);
  const [savingRelay, setSavingRelay] = useState(false);
  const [offer, setOffer] = useState<MobilePairView | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => client.request({ type: "mobile.view" }).then((next) => { setView(next); setFailed(null); }, () => setFailed(words.unavailable)), [client, words.unavailable]);
  useEffect(() => { void refresh(); }, [refresh]);
  // The code disappears when it expires; the list of phones is read again then too (a scan may have just paired one).
  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= offer.expiresAt) { setOffer(null); void refresh(); }
    }, 1_000);
    return () => clearInterval(timer);
  }, [offer, refresh]);
  useEffect(() => {
    if (!offer) return;
    const poll = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(poll);
  }, [offer, refresh]);
  // While the relay is connecting, look again now and then (the core connects in the background).
  const relayState = view?.relay?.state;
  useEffect(() => {
    if (relayState !== "connecting" && relayState !== "offline") return;
    const poll = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(poll);
  }, [relayState, refresh]);
  // A phone appeared while a code was showing: that code was used.
  const [seen, setSeen] = useState<number | null>(null);
  useEffect(() => {
    if (!view) return;
    if (offer && seen !== null && view.devices.length > seen) setOffer(null);
    if (!offer) setSeen(view.devices.length);
  }, [view, offer, seen]);

  if (failed && !view) return <section className="settings-group" aria-label={words.title}><h3>{words.title}</h3><p className="settings-note">{failed}</p></section>;
  if (!view) return null;
  const relay = view.relay;
  if (!view.enabled && !relay) return <section className="settings-group" aria-label={words.title}><h3>{words.title}</h3><p className="settings-note">{words.off}</p></section>;

  const relayOnline = relay?.state === "online";
  const canPair = view.enabled || relayOnline;
  // Where the code points: a bridge route, or the relay (the only choice when the bridge is not set up, and the
  // default once it is connected: the user turned it on to pair through it).
  const target: number | "relay" = !view.enabled ? "relay" : route === null ? (relayOnline ? "relay" : 0) : route === "relay" && !relayOnline ? 0 : route;
  const create = async () => {
    setBusy(true); setFailed(null);
    try {
      setSeen(view.devices.length);
      // No bot list: a paired phone may use every bot, including bots added later (the core's all-bots scope).
      setOffer(await client.request(target === "relay" ? { type: "mobile.pair", relay: true } : { type: "mobile.pair", route: target }));
      setNow(Date.now());
    }
    catch (failure) { setFailed(why(failure)); }
    finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    setAsking(null);
    try { setView(await client.request({ type: "mobile.revoke", deviceId: id })); } catch (failure) { setFailed(why(failure)); void refresh(); }
  };
  const saveRelay = async (url: string | null) => {
    setSavingRelay(true); setFailed(null);
    try { setView(await client.request({ type: "mobile.relay", url })); setRelayText(null); setOffer(null); }
    catch (failure) { setFailed(why(failure)); }
    finally { setSavingRelay(false); }
  };
  const relayValue = relayText ?? relay?.url ?? "";

  return (
    <>
      {failed && <p className="settings-note" role="alert">{failed}</p>}
      {relay && (
        <section className="settings-group" aria-label={words.relayTitle}>
          <h3>{words.relayTitle}</h3>
          <p className="settings-note">{words.relayNote}</p>
          <div className="settings-card">
            <div className="settings-row">
              <div className="settings-label">{words.relayAddress}<div className="settings-hint">{words.relayState[relay.state]}</div></div>
              <div className="settings-control">
                <input type="url" aria-label={words.relayAddress} placeholder="wss://relay.example.com/ws" spellCheck={false} autoComplete="off"
                  value={relayValue} disabled={savingRelay} onChange={(event) => setRelayText(event.target.value)} />
              </div>
            </div>
            <div className="settings-actions">
              <button type="button" disabled={savingRelay || !relayValue.trim() || (relay.url === relayValue.trim() && relay.state !== "off")} onClick={() => void saveRelay(relayValue.trim())}>{savingRelay ? words.relaySaving : words.relayOn}</button>
              {relay.url && <button type="button" disabled={savingRelay} onClick={() => void saveRelay(null)}>{words.relayOff}</button>}
            </div>
          </div>
        </section>
      )}
      {!view.enabled && <p className="settings-note">{words.off}</p>}
      {canPair && (
      <section className="settings-group" aria-label={words.pairTitle}>
        <h3>{words.title}</h3>
        <p className="settings-note">{words.note}</p>
        <div className="settings-card">
          <div className="settings-row"><div className="settings-label">{words.pairTitle}<div className="settings-hint">{words.pairNote}</div></div></div>
          {view.enabled && (view.routes.length > 1 || relayOnline) && (
            <div className="settings-row">
              <div className="settings-label">{words.route}</div>
              <select aria-label={words.route} value={String(target)} onChange={(event) => setRoute(event.target.value === "relay" ? "relay" : Number(event.target.value))}>
                {view.routes.map((entry, index) => <option key={entry.origin} value={index}>{words.routeKind[entry.kind]} · {entry.origin}</option>)}
                {relayOnline && <option value="relay">{words.routeKind.relay} · {relay!.url}</option>}
              </select>
            </div>
          )}
          <div className="settings-actions">
            <button type="button" disabled={busy} onClick={() => void create()}>{busy ? words.creating : words.create}</button>
          </div>
          {offer && (
            <div className="phone-offer">
              <QrCode text={offer.url} label={words.scan} />
              <p className="settings-hint">{words.scan} · {words.expires(Math.max(1, Math.ceil((offer.expiresAt - now) / 60_000)))}</p>
              <button type="button" className="task-report" onClick={() => setOffer(null)}>{words.hide}</button>
            </div>
          )}
        </div>
      </section>
      )}
      {view.enabled && (
      <section className="settings-group" aria-label={words.routes}>
        <h3>{words.routes}</h3>
        <div className="settings-card">
          {view.routes.map((entry, index) => (
            <div className="settings-row" key={entry.origin}>
              <div className="settings-label">{words.routeKind[entry.kind]}<div className="settings-hint">{entry.origin}</div></div>
              <div className="settings-control">{index === 0 ? words.first : index + 1}</div>
            </div>
          ))}
        </div>
        <p className="settings-note">{words.routesNote}</p>
      </section>
      )}
      <section className="settings-group" aria-label={words.devices}>
        <h3>{words.devices}</h3>
        <div className="settings-card">
          {view.devices.length === 0 && <div className="settings-row"><div className="settings-label">{words.none}</div></div>}
          {view.devices.map((device) => {
            const name = device.label || words.unnamed;
            return (
              <div className="settings-row" key={`${device.via ?? "bridge"}-${device.id}`}>
                <div className="settings-label">{name}
                  <div className="settings-hint">{words.paired(when(device.pairedAt, lang))} · {words.until(when(device.expiresAt, lang))} · {device.botIds.includes("*") ? words.allBots : device.botIds.map((id) => bots.find((bot) => bot.id === id)?.name ?? id).join(", ")}{device.via === "relay" ? ` · ${words.viaRelay}` : ""}</div>
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
