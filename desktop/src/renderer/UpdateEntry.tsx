// The left column's update entry: shown when a newer release is on GitHub. A click downloads it (progress in the
// same entry), then it reads "Restart to update". A failure shows in the entry and a click tries that step again.
import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateView } from "../contract";
import type { Client } from "./client";
import { Icon } from "./icons";
import { updateEntry, updateLabel, type UpdateLocal } from "./update-entry";

/** Main checks at most every 6 hours (Updater.check); asking more often only reads what it saved. */
const ASK_EVERY_MS = 30 * 60_000;
const PROGRESS_EVERY_MS = 700;

export function UpdateEntry({ client }: { client: Client }) {
  const [view, setView] = useState<UpdateView | null>(null);
  const [local, setLocal] = useState<UpdateLocal>({ downloading: false, error: null, failedStep: null });
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const ask = useCallback(() => {
    void client.request({ type: "updates.check", manual: false }).then((next) => { if (alive.current) setView(next); }, () => {});
  }, [client]);
  useEffect(() => {
    ask();
    const timer = setInterval(ask, ASK_EVERY_MS);
    return () => clearInterval(timer);
  }, [ask]);
  // The download's progress comes from asking while it runs.
  useEffect(() => {
    if (!local.downloading) return;
    const timer = setInterval(ask, PROGRESS_EVERY_MS);
    return () => clearInterval(timer);
  }, [local.downloading, ask]);

  const entry = updateEntry(view, local);
  if (entry.kind === "none") return null;

  const download = async () => {
    setLocal({ downloading: true, error: null, failedStep: null });
    try { const next = await client.request({ type: "updates.stage" }); if (alive.current) setView(next); setLocal({ downloading: false, error: null, failedStep: null }); }
    catch (failure) { if (alive.current) setLocal({ downloading: false, error: (failure as Error).message, failedStep: "download" }); }
  };
  const restart = async () => {
    setLocal({ downloading: false, error: null, failedStep: null });
    try { await client.request({ type: "updates.restart" }); }
    catch (failure) { if (alive.current) setLocal({ downloading: false, error: (failure as Error).message, failedStep: "restart" }); }
  };
  const click = () => {
    if (entry.kind === "available" || (entry.kind === "error" && entry.retry === "download")) void download();
    else if (entry.kind === "ready" || (entry.kind === "error" && entry.retry === "restart")) void restart();
  };
  const label = updateLabel(navigator.language, entry);
  return (
    <div className="rail-update">
      <button type="button" className={`rail-button${entry.kind === "error" ? " error" : ""}`} disabled={entry.kind === "downloading"}
        title={entry.kind === "error" ? entry.message : undefined} onClick={click}>
        <Icon name={entry.kind === "ready" ? "uturn" : "download"} size={13} />{label}
      </button>
      {entry.kind === "downloading" && entry.percent !== null && <div className="rail-update-bar" role="progressbar" aria-valuenow={entry.percent} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${entry.percent}%` }} /></div>}
    </div>
  );
}
