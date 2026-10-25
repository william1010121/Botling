// The update check in the app page (Phase 5b): the line under the header when a newer Botling 2 is out
// (Settings → Updates has the switch and Check now). Main does the looking (main/updates.ts);
// a newer release is only linked: its page opens in the browser, nothing is downloaded or installed.
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
    void client.request({ type: "updates.check", manual: false }).then((view) => { if (live) setState(view); }, () => {});
    return () => { live = false; };
  }, [client, enabled]);
  const newer = state?.enabled ? state.newer : null;
  if (!newer || dismissed === newer.version) return null;
  return (
    <div className="update-bar" role="status" aria-label="Update">
      <span>Botling {newer.version} is available.</span>
      <button type="button" onClick={() => void client.request({ type: "updates.open" }).catch(() => {})}>Open release page</button>
      <button type="button" className="quiet" onClick={() => setDismissed(newer.version)}>Later</button>
    </div>
  );
}
