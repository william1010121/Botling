import { useEffect, useMemo, useRef, useState } from "react";
import type { BotView, TaskView, TokenFlowHistoryView, UsageView } from "../contract";
import type { Client } from "./client";
import { TokenFlowGraph } from "./TokenFlowGraph";
import { TokenFlowCanvas } from "./TokenFlowCanvas";
import { AllocationCharts, LedgerChart } from "./TokenFlowCharts";
import { flowCount, flowLedger, flowTotal, PURPOSE_BASIS } from "./token-flow-model";
import { historicalAllocation, historyWorkers, measuredWorkers, PURPOSE_NAMES, type FlowPeriod } from "./token-flow-history-model";

export function TokenFlow({ client, bot, bots, tasks }: { client: Client; bot: BotView; bots: BotView[]; tasks: TaskView[] }) {
  const ownershipBasis = "Project → recorded task or explicit chat → provider and agent. Every column partitions the same recorded total. Selection highlights relationships without filtering totals. Missing dispatch receipts and earlier attribution are disclosed separately; activity is not a token-purpose allocation.";
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [history, setHistory] = useState<TokenFlowHistoryView | null>(null);
  const [failed, setFailed] = useState(false);
  const [seen, setSeen] = useState<number | null>(null);
  const [retry, setRetry] = useState(0);
  const [period, setPeriod] = useState<FlowPeriod>("all");
  const [basis, setBasis] = useState<"measured" | "legacy">("measured");
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
        setFailed(ledger.status === "rejected" || records.status === "rejected" || (records.status === "fulfilled" && !!records.value.metered?.unreadable));
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
  const allocation = useMemo(() => historicalAllocation(basis === "measured" ? measuredWorkers(bot, history, period) : workers, basis === "measured" ? "all" : period, seen ?? Date.now()), [workers, period, seen, basis, bot, history]);
  const todayRows = history?.metered?.periods.today;
  const ledger = todayRows?.some(r => r.turns > (r.missing ?? 0)) ? todayRows.reduce((a, r) => ({input:a.input+r.tokens.input,output:a.output+r.tokens.output,cacheRead:a.cacheRead+r.tokens.cacheRead,cacheWrite:a.cacheWrite+r.tokens.cacheWrite}), {input:0,output:0,cacheRead:0,cacheWrite:0}) : null;
  const purposes = allocation.totals, known = allocation.known;
  const stopped = !!(history?.metered?.limited || history?.metered?.unreadable);
  const reading = failed ? "Refresh failed · last snapshot" : seen ? `Snapshot ${new Date(seen).toLocaleTimeString()}` : "Reading history";
  const coverage = basis === "measured" ? `${reading}. Identified Codex turns and Claude messages since collection began; earlier history is separate. In-progress snapshots use their latest observation date; completed units use their completion date. Missing usage remains unknown. Unsupported providers and events not delivered by the engine are not counted. ${history?.metered?.limited ? "Journal capacity reached; new collection stopped." : ""}` : `${reading}. Retained worker output only, purpose unknown. Up to 500 displayed records; ownership is resolved before retention. May overlap the separate measured source; never added together. Spanning/undated counters stay unknown. ${history?.unreadable ? "Some saved records could not be read." : ""}`;
  const group = selected?.startsWith("group:") ? allocation.groups.find(item => `group:${item.id}` === selected) : null;
  const selectedPurpose = selected?.startsWith("purpose:") ? selected.slice(8) as keyof typeof PURPOSE_NAMES : null;
  const details = group?.workers ?? (selectedPurpose ? allocation.workers.filter(worker => worker.purpose === selectedPurpose) : allocation.workers);
  const title = group?.name ?? (selectedPurpose ? PURPOSE_NAMES[selectedPurpose] : bot.name);
  const detailOpen = selected !== null && selected !== "ledger";
  return <section className="token-flow" aria-label="Token Flow">
    <header className="tf-heading"><h2>{bot.name}</h2><div className="tf-reading">
      <select aria-label="History period" value={period} onChange={event => { setPeriod(event.target.value as FlowPeriod); setSelected(null); }}><option value="all">All available</option><option value="today">Today</option><option value="7d">7 days</option></select>
      <button className="tf-status" title={coverage} aria-label={coverage} onClick={() => setSelected(selected === "coverage" ? null : "coverage")}>{stopped ? "Collection stopped" : failed ? "Stale" : "Partial"}</button>
      <button aria-label="Refresh ledger" title="Refresh local history and ledger" onClick={() => setRetry(value => value + 1)}>↻</button>
    </div></header>
    {stopped && <p role="alert" className="tf-collection-stopped"><strong>Token collection stopped.</strong> {history?.metered?.error ?? "Token storage is unavailable."} Preserve the token-flow files. Check disk space and file permissions; restore damaged files from a verified backup, then restart the app. Displayed totals are incomplete.</p>}
    <div className="tf-source" role="group" aria-label="Coverage source"><button aria-pressed={basis === "measured"} onClick={() => {setBasis("measured");setSelected(null);}} title={history?.metered?.since ? `Collected since ${new Date(history.metered.since).toLocaleString()}. Whole turns assigned to completion day; earlier activity is separate.` : "Waiting for identified metered turns. Legacy activity is separate."}>Measured{history?.metered?.since ? ` · ${new Date(history.metered.since).toLocaleDateString()}` : " · —"}</button><button aria-pressed={basis === "legacy"} onClick={() => {setBasis("legacy");setSelected(null);}} title="Retained historical output only. Purpose unknown. Not added to measured records.">Legacy · partial</button></div>
    <div className="tf-purpose-heading"><span title={basis === "measured" ? ownershipBasis : PURPOSE_BASIS}>{basis === "measured" ? "Ownership · recorded tokens" : "Legacy · output"}</span><button className="tf-info" aria-label="Attribution basis" title={basis === "measured" ? ownershipBasis : PURPOSE_BASIS} onClick={() => setSelected(selected === "basis" ? null : "basis")}>ⓘ</button>
      <button className="tf-daily" aria-label="Daily usage details" title="Today's bot ledger, including input and cache. Separate from retained output history." onClick={() => setSelected(selected === "ledger" ? null : "ledger")}>{flowCount(ledger ? flowTotal(ledger) : null)} <small>today</small></button>
    </div>
    {basis === "legacy" && <div className="tf-purpose-summary" aria-label="Observed turn activity">
      {(["communication", "execution", "mixed", "unknown"] as const).map(purpose => {
        const bucket = purposes[purpose];
        return <button key={purpose} data-purpose={purpose} aria-label={`${PURPOSE_NAMES[purpose]} allocation`} title={`${bucket.measured ? bucket.known.toLocaleString() + " tokens" : "unreported"}${bucket.unknown ? "; incomplete" : ""}. ${PURPOSE_BASIS}`} onClick={() => setSelected(`purpose:${purpose}`)}>
          <span><i />{PURPOSE_NAMES[purpose]}</span><strong>{flowCount(bucket.measured ? bucket.known : null)}{bucket.unknown > 0 && bucket.measured > 0 && <sup aria-label="Incomplete coverage">?</sup>}</strong>
          <div className="tf-purpose-meter" aria-hidden="true">{bucket.measured ? <i style={{ width: `${known ? bucket.known / known * 100 : 0}%` }} /> : <em />}</div>
        </button>;
      })}
    </div>}
    {basis === "measured" && history ? <TokenFlowGraph key={`${bot.id}:${period}`} name={bot.name} rows={history.metered?.periods[period] ?? []} tasks={history.tasks} workers={history.rows} /> : (history || failed) ? <TokenFlowCanvas bot={bot} workers={allocation.nodes} basis={basis === "measured" ? "tokens" : "output"} allocationEdges={allocation.edges} rootOutput={allocation.workers.some(worker => worker.attributableOutput !== null) ? known : null} rootLabel={period === "all" ? "All available · partial" : period === "today" ? "Today · partial" : "7 days · partial"} selected={selected} onSelect={setSelected} /> : <div className="tf-graph-loading" role="status" aria-label="Reading saved bot history">…</div>}
    <div ref={detailPanel}>
      {selected === "coverage" && <p className="tf-coverage-note">{coverage}</p>}
      {selected === "basis" && <p className="tf-coverage-note">{basis === "measured" ? ownershipBasis : PURPOSE_BASIS} Claude uses message snapshots; Codex uses whole-turn differences. Cache read is counted once; reasoning is already included in output.</p>}
      {detailOpen && selected !== "coverage" && selected !== "basis" && <AllocationCharts basis={basis === "measured" ? "tokens" : "output"} title={title} workers={details} onClose={() => setSelected(null)} />}
      {selected === "ledger" && <LedgerChart tokens={ledger} day={usage?.day ?? "Today"} onClose={() => setSelected(null)} />}
    </div>
  </section>;
}
