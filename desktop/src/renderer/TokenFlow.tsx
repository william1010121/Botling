import { useEffect, useMemo, useRef, useState } from "react";
import type { BotView, TaskView, TokenFlowHistoryView, UsageView } from "../contract";
import type { Client } from "./client";
import { TokenFlowCanvas } from "./TokenFlowCanvas";
import { AllocationCharts, LedgerChart } from "./TokenFlowCharts";
import { flowCount, flowLedger, flowTotal, PURPOSE_BASIS } from "./token-flow-model";
import { historicalAllocation, historyWorkers, PURPOSE_NAMES, type FlowPeriod } from "./token-flow-history-model";

export function TokenFlow({ client, bot, bots, tasks }: { client: Client; bot: BotView; bots: BotView[]; tasks: TaskView[] }) {
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [history, setHistory] = useState<TokenFlowHistoryView | null>(null);
  const [failed, setFailed] = useState(false);
  const [seen, setSeen] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [period, setPeriod] = useState<FlowPeriod>("all");
  const [selected, setSelected] = useState<string | null>(null);
  const detailPanel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected) detailPanel.current?.scrollIntoView?.({ block: "nearest" }); }, [selected]);
  useEffect(() => {
    let live = true, pending = false, again = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (!live || document.hidden) return;
      if (pending) { again = true; return; }
      pending = true;
      void Promise.allSettled([client.request({ type: "usage.view", localOnly: true }), client.request({ type: "tokenFlow.view", botId: bot.id })]).then(([ledger, records]) => {
        if (!live) return;
        if (ledger.status === "fulfilled") setUsage(ledger.value);
        if (records.status === "fulfilled" && records.value.rows) setHistory(records.value);
        setFailed(ledger.status === "rejected" || records.status === "rejected");
        if (ledger.status === "fulfilled" || records.status === "fulfilled") setSeen(Date.now());
      }).finally(() => { pending = false; if (live && again) { again = false; schedule(); } });
    };
    const schedule = () => { if (!timer && !document.hidden) timer = setTimeout(() => { timer = undefined; load(); }, 750); };
    const visibility = () => { if (document.hidden) { clearTimeout(timer); timer = undefined; } else load(); };
    const off = client.onEvent(({ event }) => {
      if (((event.type === "turn.finished" || event.type === "tasks.updated" || event.type === "subagent.updated") && event.botId === bot.id) || (event.type === "bot.updated" && event.bot.id === bot.id)) schedule();
    });
    document.addEventListener("visibilitychange", visibility); load();
    return () => { live = false; clearTimeout(timer); off(); document.removeEventListener("visibilitychange", visibility); };
  }, [client, retry, bot.id]);
  const workers = useMemo(() => historyWorkers(bot, history, tasks), [bot, history, tasks]);
  const allocation = useMemo(() => historicalAllocation(workers, period, seen ?? Date.now()), [workers, period, seen]);
  const ledger = flowLedger(bot, bots, usage);
  const purposes = allocation.totals, known = allocation.known;
  const reading = failed ? "Refresh failed · last snapshot" : seen ? `Snapshot ${new Date(seen).toLocaleTimeString()}` : "Reading history";
  const coverage = `${reading}. Partial retained history across this bot's saved heads/tasks, including completed workers. Up to 500 workers. Past per-bot daily spending was not saved. Periods include whole record windows; spanning/undated counters stay unknown. ${history?.unreadable ? "Some saved records could not be read." : ""}`;
  const group = selected?.startsWith("group:") ? allocation.groups.find(item => `group:${item.id}` === selected) : null;
  const selectedPurpose = selected?.startsWith("purpose:") ? selected.slice(8) as keyof typeof PURPOSE_NAMES : null;
  const details = group?.workers ?? (selectedPurpose ? allocation.workers.filter(worker => worker.purpose === selectedPurpose) : allocation.workers);
  const title = group?.name ?? (selectedPurpose ? PURPOSE_NAMES[selectedPurpose] : bot.name);
  const detailOpen = selected !== null && selected !== "ledger";
  return <section className="token-flow" aria-label="Token Flow">
    <header className="tf-heading"><h2>{bot.name}</h2><div className="tf-reading">
      <select aria-label="History period" value={period} onChange={event => { setPeriod(event.target.value as FlowPeriod); setSelected(null); }}><option value="all">All available</option><option value="today">Today</option><option value="7d">7 days</option></select>
      <button className="tf-status" title={coverage} aria-label={coverage} onClick={() => setSelected(selected === "coverage" ? null : "coverage")}>{failed ? "Stale" : "Partial"}</button>
      <button aria-label="Refresh ledger" title="Refresh local history and ledger" onClick={() => setRetry(value => value + 1)}>↻</button>
    </div></header>
    <div className="tf-purpose-heading"><span title={PURPOSE_BASIS}>≈ Roles · output</span><button className="tf-info" aria-label="Attribution basis" title={PURPOSE_BASIS} onClick={() => setSelected(selected === "basis" ? null : "basis")}>ⓘ</button>
      <button className="tf-daily" aria-label="Daily usage details" title="Today's bot ledger, including input and cache. Separate from retained output history." onClick={() => setSelected(selected === "ledger" ? null : "ledger")}>{flowCount(ledger ? flowTotal(ledger) : null)} <small>today</small></button>
    </div>
    <div className="tf-purpose-summary" aria-label="Role-based output estimate">
      {(["communication", "execution", "mixed"] as const).map(purpose => {
        const bucket = purposes[purpose];
        return <button key={purpose} data-purpose={purpose} aria-label={`${PURPOSE_NAMES[purpose]} allocation`} title={`${bucket.measured ? bucket.known.toLocaleString() + " known output tokens" : "unreported"}${bucket.unknown ? "; incomplete" : ""}. ${PURPOSE_BASIS}`} onClick={() => setSelected(`purpose:${purpose}`)}>
          <span><i />{PURPOSE_NAMES[purpose]}</span><strong>{flowCount(bucket.measured ? bucket.known : null)}{bucket.unknown > 0 && bucket.measured > 0 && <sup aria-label="Incomplete coverage">?</sup>}</strong>
          <div className="tf-purpose-meter" aria-hidden="true">{bucket.measured ? <i style={{ width: `${known ? bucket.known / known * 100 : 0}%` }} /> : <em />}</div>
        </button>;
      })}
    </div>
    {(history || failed) ? <TokenFlowCanvas bot={bot} workers={allocation.nodes} allocationEdges={allocation.edges} rootOutput={allocation.workers.some(worker => worker.attributableOutput !== null) ? known : null} rootLabel={period === "all" ? "All available · partial" : period === "today" ? "Today · partial" : "7 days · partial"} selected={selected} onSelect={setSelected} /> : <div className="tf-graph-loading" role="status" aria-label="Reading saved bot history">…</div>}
    <div ref={detailPanel}>
      {detailOpen && <AllocationCharts includeCoordinator={!group && (!selectedPurpose || selectedPurpose === "communication")} title={title} workers={details} onClose={() => setSelected(null)} />}
      {selected === "ledger" && <LedgerChart tokens={ledger} day={usage?.day ?? "Today"} onClose={() => setSelected(null)} />}
    </div>
  </section>;
}
