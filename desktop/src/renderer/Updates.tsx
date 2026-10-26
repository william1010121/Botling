import { useEffect, useState } from "react";
import type { UpdateView,RetainedUpdateCopy } from "../contract";
import type { Client } from "./client";

/**
 * The banner: only an update recovery that needs you. A newer release is announced in the main bot's chat
 * (core/self-update.ts), where Install and restart installs it, as in 1.x.
 */
export function UpdateBanner({ client, enabled }: { client: Client; enabled: boolean | undefined }) {
  const [state, setState] = useState<UpdateView | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    if (enabled === undefined) return;
    let live = true;
    const check = () => { void client.request({ type: "updates.check", manual: false }).then((view) => { if (live) setState(view); }, () => {}); };
    check();
    const timer = setInterval(check, 6 * 60 * 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [client, enabled]);
  if (state?.recoveryError && dismissed !== state.recoveryId) return <div className="update-bar" role="alert" aria-label="Update recovery">
    <span>{state.recoveryError}</span><button type="button" onClick={() => {if(state.recoveryId)void client.request({type:"updates.dismiss",id:state.recoveryId}).then(()=>setDismissed(state.recoveryId!));}}>Dismiss</button>
  </div>;
  return null;
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

/** No automatic user-data expiry: every retained transaction remains visible after success. */
export function RecoveryCopies({client}:{client:Client}){
 const [copies,setCopies]=useState<RetainedUpdateCopy[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
 useEffect(()=>{let live=true;setBusy(true);void client.request({type:'updates.copies'}).then(value=>{if(live)setCopies(value);},failure=>{if(live)setError(failure.message);}).finally(()=>{if(live)setBusy(false);});return()=>{live=false;};},[client]);
 const remove=async(copy:RetainedUpdateCopy)=>{setBusy(true);setError(null);try{await client.request({type:'updates.deleteCopy',id:copy.id});setCopies(await client.request({type:'updates.copies'}));}catch(error){setError((error as Error).message);}finally{setBusy(false);}};
 const labels={snapshot:'Original data snapshot',newer:'NEWER candidate data (may contain newer messages)',restore:'Prepared restored data','previous-app':'Previous app','failed-app':'Failed candidate app'};
 if(!copies.length&&!error)return null;
 return <div aria-label="Retained update copies">{error&&<p role="alert">{error}</p>}
 {copies.map(copy=><div key={copy.id}><strong>{labels[copy.role]}</strong><p style={{overflowWrap:'anywhere'}}>{copy.path}<br/>{copy.bytes.toLocaleString()} bytes</p><button type="button" disabled={busy||!copy.deletable} onClick={()=>void remove(copy)}>{copy.role==='newer'?'Delete this NEWER data copy…':'Delete this copy…'}</button>{copy.reason&&<p>{copy.reason}</p>}</div>)}
 </div>;
}
