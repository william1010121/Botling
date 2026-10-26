import { useEffect, useState } from "react";
import type { DoctorCheck, DoctorView } from "../contract/doctor";
import type { Client } from "./client";

export function DoctorSection({ client }: { client: Client }) {
  const [result, setResult] = useState<DoctorView | null>(null);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState(false);
  const state = result;
  useEffect(() => {
    let live = true, updated = false;
    const off = client.onEvent(({ event }) => {
      if (event.type === "doctor.updated" && live) { updated = true; setResult(event.doctor); }
    });
    void client.request({ type: "doctor.view" }).then(async value => {
      if (!live) return;
      if (!updated) setResult(value);
      if (!value.includedLatest || !value.checks.length) {
        if (live) setRunning(true);
        value = await client.request({ type: "doctor.run", includeLatest: true });
      }
      if (live) setResult(previous => updated && previous && (previous.checkedAt ?? 0) > (value.checkedAt ?? 0) ? previous : value);
    }).catch(() => { if (live) setProblem(true); }).finally(() => { if (live) setRunning(false); });
    return () => { live = false; off(); };
  }, [client]);
  const rerun = async () => {
    setRunning(true); setProblem(false);
    try { setResult(await client.request({ type: "doctor.run", includeLatest: true })); }
    catch { setProblem(true); }
    finally { setRunning(false); }
  };
  const busy = running || state?.isRunning;
  return <section className="settings-group" aria-label="Command-line tools">
    <h3>Command-line tools</h3>
    <div className="settings-card">
      {!state?.checks.length && !problem && <p role="status">Checking…</p>}
      {state?.checks.map(check => <DoctorRow key={check.tool} check={check} client={client} />)}
      <div className="settings-actions" style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button type="button" disabled={busy} onClick={() => void rerun()}>Run again</button>
        {busy ? <span role="status">Checking…</span> : state?.checkedAt && <span className="settings-hint">Checked {new Date(state.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
      </div>
      {problem && <p className="settings-note" role="alert">The check could not finish. Run again to retry.</p>}
    </div>
    <p className="settings-note">Bots run Claude Code; Codex is optional. Each check has a 10-second limit and spends no tokens.</p>
  </section>;
}
function DoctorRow({ check, client }: { check: DoctorCheck; client: Client }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setCopied(false); setFailed(false); }, [check.fix]);
  const color = check.status === "ok" ? "var(--green)" : check.status === "warning" ? "var(--orange)" : "var(--error)";
  return <div className="settings-row" style={{ display: "block" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span role="img" aria-label={check.status === "ok" ? "OK" : check.status === "warning" ? "Warning" : "Failing"} style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
      <strong>{check.name}</strong><span className="settings-hint">{check.version ?? "—"}</span>
      <span className="settings-hint" style={{ marginLeft: "auto" }}>needs {check.minimum}+</span>
    </div>
    <div style={{ paddingLeft: 19 }}>
      <p className="settings-hint" style={{ color: check.status === "ok" ? undefined : color }}>{check.summary}</p>
      {check.path && <p className="settings-hint" title={check.path} style={{ overflowWrap: "anywhere", userSelect: "text" }}>{check.path}</p>}
      {check.fix && <div className="settings-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <code style={{ flex: 1, overflowWrap: "anywhere", userSelect: "text" }}>{check.fix}</code>
        <button type="button" title="Copy the command, then run it in Terminal" onClick={() => {
          void client.request({ type: "doctor.copy", tool: check.tool }).then(value => { setCopied(value.copied); setFailed(!value.copied); }, () => setFailed(true));
        }}>{copied ? "Copied" : "Copy"}</button>
      </div>}
      {failed && <p className="settings-hint" role="alert">Could not copy. Select the command to copy it.</p>}
    </div>
  </div>;
}
