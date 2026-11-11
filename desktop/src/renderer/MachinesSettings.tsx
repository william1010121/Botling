// Settings › Machines: the computers Claude workers can run on (multi-machine phase 1, remote/service.ts). Add an ssh
// host from ~/.ssh/config (its host key is read; the user approves the fingerprint), or a machine over the relay (a
// one-line install command; the machine shows its name, fingerprint and a code, which the user types here); check,
// revoke or remove one. The core does the work; this shows what it says. The install line holds a one-time secret: it
// is held in this component's state only until it is hidden or expires, and is never written anywhere.
import { useCallback, useEffect, useState } from "react";
import type { MachinePairView, MachineView, MachinesView } from "../contract";
import { Client, RequestFailed } from "./client";
import { machinesWords } from "./machines-text";

const why = (failure: unknown) => (failure instanceof RequestFailed ? failure.error.message : String((failure as Error)?.message ?? failure));

export function MachinesSettings({ client, lang }: { client: Client; lang: string | null }) {
  const words = machinesWords(lang);
  const [view, setView] = useState<MachinesView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [hosts, setHosts] = useState<string[] | null>(null);
  const [host, setHost] = useState("");
  const [name, setName] = useState("");
  const [offer, setOffer] = useState<MachinePairView | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(() => client.request({ type: "machines.view" }).then((next) => { setView(next); }, () => setFailed(words.unavailable)), [client, words.unavailable]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!view?.enabled || hosts) return;
    void client.request({ type: "machines.hosts" }).then((answer) => setHosts(answer.hosts), () => setHosts([]));
  }, [client, view?.enabled, hosts]);
  // Machines connect, ask and get checked in the background: look again now and then while the page is open.
  useEffect(() => {
    if (!view?.enabled) return;
    const poll = setInterval(() => void refresh(), offer || view.machines.some((m) => m.trust === "asked") ? 2_000 : 5_000);
    return () => clearInterval(poll);
  }, [view?.enabled, view?.machines, offer, refresh]);
  // The install line disappears when it expires.
  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= offer.expiresAt) setOffer(null);
    }, 1_000);
    return () => clearInterval(timer);
  }, [offer]);

  const run = async (key: string, action: () => Promise<MachinesView | void>) => {
    setBusy(key); setFailed(null);
    try { const next = await action(); if (next) setView(next); }
    catch (failure) { setFailed(why(failure)); void refresh(); }
    finally { setBusy(null); }
  };

  if (failed && !view) return <section className="settings-group" aria-label={words.title}><h3>{words.title}</h3><p className="settings-note">{failed}</p></section>;
  if (!view) return null;
  if (!view.enabled) return <section className="settings-group" aria-label={words.title}><h3>{words.title}</h3><p className="settings-note">{words.off}</p></section>;

  const add = (target: string) => run("add", async () => {
    const next = await client.request({ type: "machines.add", host: target, ...(name.trim() ? { name: name.trim() } : {}) });
    setName("");
    return next;
  });
  const pair = () => run("pair", async () => {
    setOffer(await client.request({ type: "machines.pair" }));
    setCopied(false); setNow(Date.now());
  });
  const copy = async () => {
    if (!offer) return;
    try { await navigator.clipboard.writeText(offer.command); setCopied(true); } catch (failure) { setFailed(why(failure)); }
  };
  const approve = (machine: MachineView) => run(`approve:${machine.id}`, async () => {
    const next = await client.request(machine.via === "relay" ? { type: "machines.approve", id: machine.id, code: codes[machine.id] ?? "" } : { type: "machines.approve", id: machine.id });
    setCodes((all) => { const { [machine.id]: _gone, ...rest } = all; return rest; });
    // The pairing that line was for is done.
    if (machine.via === "relay") setOffer(null);
    return next;
  });

  const shownHost = host || hosts?.[0] || "";

  return (
    <>
      {failed && <p className="settings-note" role="alert">{failed}</p>}
      <section className="settings-group" aria-label={words.list}>
        <h3>{words.title}</h3>
        <p className="settings-note">{words.note}</p>
        <div className="settings-card">
          {view.machines.length === 0 && <div className="settings-row"><div className="settings-label">{words.none}</div></div>}
          {view.machines.map((machine) => (
            <MachineRow key={machine.id} machine={machine} words={words} busy={busy} asking={asking === machine.id} code={codes[machine.id] ?? ""}
              onCode={(code) => setCodes((all) => ({ ...all, [machine.id]: code }))}
              onApprove={() => void approve(machine)}
              onDecline={() => void run(`decline:${machine.id}`, () => client.request({ type: "machines.decline", id: machine.id }))}
              onCheck={() => void run(`check:${machine.id}`, () => client.request({ type: "machines.check", id: machine.id }))}
              onAsk={(on) => setAsking(on ? machine.id : null)}
              onRevoke={() => { setAsking(null); void run(`revoke:${machine.id}`, () => client.request({ type: "machines.revoke", id: machine.id })); }}
              onRemove={() => void run(`remove:${machine.id}`, () => client.request({ type: "machines.remove", id: machine.id }))} />
          ))}
        </div>
      </section>

      <section className="settings-group" aria-label={words.sshTitle}>
        <h3>{words.sshTitle}</h3>
        <p className="settings-note">{words.sshNote}</p>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-label">{words.host}</div>
            <div className="settings-control">
              {hosts && hosts.length === 0
                ? <span className="settings-hint">{words.noHosts}</span>
                : <select aria-label={words.host} value={shownHost} disabled={!hosts || busy === "add"} onChange={(event) => setHost(event.target.value)}>
                    {(hosts ?? []).map((entry) => <option key={entry} value={entry}>{entry}</option>)}
                  </select>}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-label">{words.name}</div>
            <div className="settings-control">
              <input type="text" aria-label={words.name} placeholder={words.namePlaceholder} spellCheck={false} autoComplete="off" maxLength={64}
                value={name} disabled={busy === "add"} onChange={(event) => setName(event.target.value)} />
            </div>
          </div>
          <div className="settings-actions">
            <button type="button" disabled={!shownHost || busy !== null} onClick={() => void add(shownHost)}>{busy === "add" ? words.adding : words.add}</button>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-label={words.relayTitle}>
        <h3>{words.relayTitle}</h3>
        <p className="settings-note">{words.relayNote}</p>
        <div className="settings-card">
          {!view.relay.url
            ? <div className="settings-row"><div className="settings-label">{words.relayOff}</div></div>
            : <>
                <div className="settings-row"><div className="settings-label">{view.relay.url}<div className="settings-hint">{words.relayState[view.relay.state]}</div></div></div>
                <div className="settings-actions">
                  <button type="button" disabled={busy !== null} onClick={() => void pair()}>{busy === "pair" ? words.creating : words.create}</button>
                </div>
              </>}
          {offer && (
            <div className="machine-offer">
              <div className="settings-label">{words.commandLabel}<div className="settings-hint">{words.expires(Math.max(1, Math.ceil((offer.expiresAt - now) / 60_000)))}</div></div>
              <pre className="machine-command" aria-label={words.commandLabel}><code>{offer.command}</code></pre>
              <div className="settings-actions">
                <button type="button" onClick={() => void copy()}>{copied ? words.copied : words.copy}</button>
                <button type="button" onClick={() => setOffer(null)}>{words.hide}</button>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

type MachineWords = ReturnType<typeof machinesWords>;

function MachineRow({ machine, words, busy, asking, code, onCode, onApprove, onDecline, onCheck, onAsk, onRevoke, onRemove }: {
  machine: MachineView; words: MachineWords; busy: string | null; asking: boolean; code: string;
  onCode: (code: string) => void; onApprove: () => void; onDecline: () => void; onCheck: () => void; onAsk: (on: boolean) => void; onRevoke: () => void; onRemove: () => void;
}) {
  const via = machine.via === "ssh" ? words.viaSsh(machine.host ?? machine.name) : words.viaRelay;
  const parts = [via, words.trust[machine.trust]];
  if (machine.via === "relay" && machine.trust === "trusted") parts.push(machine.connected ? words.online : words.offline);
  if (machine.workers) parts.push(words.workers(machine.workers));
  const info = machine.info;
  const found = info && !info.error ? [info.platform, info.node && `Node ${info.node.replace(/^v/, "")}`, info.git, info.claude ?? words.noClaude].filter(Boolean).join(" · ") : null;
  const mine = (action: string) => busy === `${action}:${machine.id}`;
  return (
    <div className="settings-row machine-row" data-machine={machine.id}>
      <div className="settings-label">{machine.name}
        <div className="settings-hint">{parts.join(" · ")}</div>
        {machine.trust === "asked" && machine.fingerprint && <div className="settings-hint">{words.fingerprint}: <code>{machine.fingerprint}</code>{machine.via === "ssh" ? ` — ${machine.known ? words.knownKey : words.newKey}` : ""}</div>}
        {machine.trust === "asked" && machine.via === "relay" && !machine.waiting && <div className="settings-hint">{words.pairingEnded}</div>}
        {machine.trust === "trusted" && found && <div className="settings-hint">{words.checked(found)}</div>}
        {machine.trust === "trusted" && info?.error && <div className="settings-hint" role="alert">{words.checkFailed(info.error)}</div>}
        {asking && <div className="settings-hint" role="alert">{words.revokeAsk(machine.name)}</div>}
      </div>
      <div className="settings-control">
        {machine.trust === "asked" && machine.via === "ssh" && <>
          <button type="button" disabled={busy !== null} onClick={onApprove}>{words.approveKey}</button> <button type="button" disabled={busy !== null} onClick={onDecline}>{words.decline}</button>
        </>}
        {machine.trust === "asked" && machine.via === "relay" && (machine.waiting
          ? <>
              <input type="text" aria-label={`${words.codeLabel} (${machine.name})`} title={words.codeHint} placeholder="XXXX-XXXX" spellCheck={false} autoComplete="off" maxLength={20}
                value={code} disabled={busy !== null} onChange={(event) => onCode(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && code.trim()) onApprove(); }} />{" "}
              <button type="button" disabled={busy !== null || !code.trim()} onClick={onApprove}>{words.approve}</button> <button type="button" disabled={busy !== null} onClick={onDecline}>{words.decline}</button>
            </>
          : <button type="button" disabled={busy !== null} onClick={onRemove}>{words.remove}</button>)}
        {machine.trust === "trusted" && (asking
          ? <><button type="button" onClick={onRevoke}>{words.revokeYes}</button> <button type="button" onClick={() => onAsk(false)}>{words.cancel}</button></>
          : <><button type="button" disabled={busy !== null} onClick={onCheck}>{mine("check") ? words.checking : words.check}</button> <button type="button" aria-label={`${words.revoke} ${machine.name}`} onClick={() => onAsk(true)}>{words.revoke}</button></>)}
        {machine.trust === "revoked" && <button type="button" disabled={busy !== null} onClick={onRemove}>{words.remove}</button>}
      </div>
    </div>
  );
}
