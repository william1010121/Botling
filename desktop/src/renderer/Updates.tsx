import { useEffect, useState } from "react";
import type { UpdateView } from "../contract";
import type { Client } from "./client";

/** The banner: asks main once the settings are known (main checks only when on and due). */
export function UpdateBanner({ client, enabled }: { client: Client; enabled: boolean | undefined }) {
  const [state, setState] = useState<UpdateView | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) { setState(null); return; }
    let live = true;
    const check = () => { void client.request({ type: "updates.check", manual: false }).then((view) => { if (live) setState(view); }, () => {}); };
    check();
    const timer = setInterval(check, 6 * 60 * 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [client, enabled]);
  const newer = state?.enabled ? state.newer : null;
  if (!newer || dismissed === newer.version) return null;
  return (
    <div className="update-bar" role="status" aria-label="Update">
      <span>Botling {newer.version} is available.</span>
      <button type="button" onClick={() => void client.request({ type: "updates.open" }).catch(() => {})}>Open release page</button>
      {state && <UpdateActions client={client} state={state} onChange={setState} />}
      <button type="button" className="quiet" onClick={() => setDismissed(newer.version)}>Later</button>
    </div>
  );
}

/** Two separate actions: staging never quits, and a normal quit never installs. */
export function UpdateActions({ client, state, onChange }: { client: Client; state: UpdateView; onChange: (view: UpdateView) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stage = async () => {
    setBusy(true); setError(null);
    try { onChange(await client.request({ type: "updates.stage" })); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const restart = async () => {
    setBusy(true); setError(null);
    try { await client.request({ type: "updates.restart" }); }
    catch (failure) { setError((failure as Error).message); setBusy(false); }
  };
  return <>
    {state.readyVersion ? <button type="button" disabled={busy} onClick={() => void restart()}>Restart to update</button>
      : state.newer?.asset && <button type="button" disabled={busy || !!state.installError} onClick={() => void stage()}>{busy ? "Downloading and verifying…" : "Download and verify"}</button>}
    {(error || state.installError) && <span role="status">{error || state.installError}</span>}
  </>;
}
