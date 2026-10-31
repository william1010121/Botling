import { useState } from "react";
import type { UpdateView } from "../contract";
import type { Client } from "./client";

/** Two separate actions: downloading never quits, and a normal quit never installs. */
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
      : state.newer?.asset && <button type="button" disabled={busy || !!state.installError} onClick={() => void stage()}>{busy ? "Downloading…" : "Download update"}</button>}
    {(error || state.installError) && <span role="status">{error || state.installError}</span>}
  </>;
}
