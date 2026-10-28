import { useEffect, useMemo, useRef, useState } from "react";
import type { BotView, TaskView, UsageView } from "../contract";
import type { Client } from "./client";
import { flowCount, flowLedger, flowTotal, flowWorkers } from "./token-flow-model";

export function TokenFlow({ client, bot, bots, tasks }: { client: Client; bot: BotView; bots: BotView[]; tasks: TaskView[] }) {
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [failed, setFailed] = useState(false);
  const [seen, setSeen] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [scope, setScope] = useState("chat");
  const [selected, setSelected] = useState<string | null>(null);
  const detailPanel = useRef<HTMLElement>(null);
  useEffect(() => { if (selected) detailPanel.current?.scrollIntoView?.({ block: "nearest" }); }, [selected]);
  useEffect(() => {
    let live = true, pending = false, again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (!live || document.hidden) return;
      if (pending) { again = true; return; }
      pending = true;
      void client.request({ type: "usage.view", localOnly: true }).then(value => {
        if (live) { setUsage(value); setFailed(false); setSeen(Date.now()); }
      }, () => { if (live) setFailed(true); }).finally(() => {
        pending = false;
        if (live && again) { again = false; schedule(); }
      });
    };
    const schedule = () => { if (!timer && !document.hidden) timer = setTimeout(() => { timer = undefined; load(); }, 750); };
    const visibility = () => { if (document.hidden) { clearTimeout(timer); timer = undefined; } else load(); };
    const off = client.onEvent(({ event }) => { if (event.type === "turn.finished") schedule(); });
    document.addEventListener("visibilitychange", visibility);
    load();
    return () => { live = false; clearTimeout(timer); off(); document.removeEventListener("visibilitychange", visibility); };
  }, [client, retry]);
  const workers = useMemo(() => flowWorkers(bot, tasks), [bot, tasks]);
  const ledger = flowLedger(bot, bots, usage);
  const tokens = scope === "all" ? usage?.spendingStatus === "available" && (usage.byBot.some(row => row.breakdown) || flowTotal(usage.tokens) > 0) ? usage.tokens : null : ledger;
  const detail = workers.find(worker => worker.id === selected);
  const max = Math.max(1, ...workers.map(worker => worker.output ?? 0));
  const active = workers.filter(worker => worker.status === "running" || worker.status === "waiting").length;
  return <section className="token-flow" aria-label="Token Flow">
    <header className="tf-heading"><div><h2>Token Flow</h2><span className="tf-muted">{usage?.day ?? "Today"} · recorded usage</span></div>
      <select aria-label="Usage scope" value={scope} onChange={event => setScope(event.target.value)}><option value="chat">This chat</option><option value="all">All chats</option></select>
    </header>
    <div className="tf-summary"><div><strong>{flowCount(tokens ? flowTotal(tokens) : null)}</strong><span>recorded tokens</span></div><div><strong>{active}</strong><span>{scope === "all" ? "active in this chat" : "workers active"}</span></div><div><strong>{workers.length}</strong><span>{scope === "all" ? "tracked in this chat" : "tracked workers"}</span></div></div>
    <div className="tf-accounting" title="Disjoint normalized buckets. Cached input has already been removed from uncached input. Worker counters below are separate and are never added to this ledger.">
      {([['input', 'Uncached input'], ['output', 'Output'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write']] as const).map(([key, label]) => <span key={key}>{label}<b>{flowCount(tokens?.[key] ?? null)}</b></span>)}
    </div>
    <div className="tf-reading"><span title="Usage is recorded at turn boundaries, not per tool. Refresh reads the local ledger only.">{failed ? seen ? "Refresh failed · last snapshot" : "Ledger unavailable" : seen ? `Snapshot ${new Date(seen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : "Reading ledger…"}{tokens === null && " · attribution unavailable"}</span><button onClick={() => setRetry(value => value + 1)}>Refresh</button></div>
    {scope === "all" && <div className="tf-ledger" aria-label="Usage by ledger name">{usage?.spendingStatus === "available" && [...usage.byBot].sort((a, b) => (b.breakdown ? flowTotal(b.breakdown) : -1) - (a.breakdown ? flowTotal(a.breakdown) : -1)).map(row => <div key={row.name}><span>{row.name}</span><b>{flowCount(row.breakdown ? flowTotal(row.breakdown) : null)}</b></div>)}</div>}
    <div className="tf-flow-heading"><h3>Delegation · {bot.name}</h3><span className="tf-muted" title="Only retained worker records and explicit task links are shown. Nested agents may not be tracked.">Limited tracking ⓘ</span></div>
    <div className="tf-root"><span className={`tf-dot ${bot.working ? 'running' : 'idle'}`} /><div><b>{bot.name}</b><small>Coordinator · {bot.heads.join(" + ")}</small></div><span>{bot.connection ? "Reconnecting" : bot.working ? "Running" : "Idle"}</span></div>
    <div className="tf-workers" aria-label="Tracked workers">
      {!workers.length && <p className="tf-empty">No worker records in this chat yet.</p>}
      {workers.map(worker => <button key={worker.id} className={`tf-worker ${worker.direct ? 'direct' : ''}`} aria-pressed={selected === worker.id} onClick={() => setSelected(selected === worker.id ? null : worker.id)}>
        <span className={`tf-dot ${worker.status}`} /><span className="tf-worker-title"><b>{worker.title || "Worker"}</b><small>{worker.engine ?? "Unknown engine"} · {worker.status}{!worker.direct && " · task link only"}</small>{worker.tasks.length > 0 && <small className="tf-task">{worker.tasks.map(task => task.name).join(" · ")}</small>}</span>
        <span className="tf-worker-tokens"><b>{flowCount(worker.output)}</b><small>output · retained record</small><i><em style={{ width: `${worker.output === null ? 0 : 100 * worker.output / max}%` }} /></i></span>
      </button>)}
    </div>
    {detail && <aside ref={detailPanel} className="tf-detail" aria-label="Worker detail"><div><h3>{detail.title || "Worker"}</h3><button aria-label="Close worker detail" onClick={() => setSelected(null)}>×</button></div><dl>
      <dt>Worker ID</dt><dd>{detail.id}</dd><dt>Parent</dt><dd>{detail.direct ? `${bot.name} / ${detail.engine ?? "unknown head"}` : "Direct parent not recorded"}</dd>
      <dt>Tasks</dt><dd>{detail.tasks.length ? detail.tasks.map(task => <span key={task.id}>{task.name} <code>{task.id}</code><br /></span>) : "Task link not recorded"}</dd>
      <dt>Output</dt><dd>{detail.output === null ? "Not reported" : detail.output.toLocaleString()} · retained record</dd>
      <dt>Input / cache</dt><dd>Not tracked per worker</dd>
      <dt>Started</dt><dd>{detail.startedAt ? new Date(detail.startedAt).toLocaleString() : "Unknown"}</dd>
      {detail.endedAt !== null && <><dt>Ended</dt><dd>{new Date(detail.endedAt).toLocaleString()}</dd></>}
    </dl></aside>}
    <p className="tf-footnote">Worker output is separate from the daily ledger. — means unreported.</p>
  </section>;
}
