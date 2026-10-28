import type { UsageView } from "../contract";
import { flowCount, purposeTotals, PURPOSE_BASIS, type FlowWorker } from "./token-flow-model";
import { PURPOSE_NAMES } from "./token-flow-history-model";

export function AllocationCharts({ title, workers, onClose, includeCoordinator = false, basis = "tokens" }: { title: string; workers: FlowWorker[]; includeCoordinator?: boolean; basis?: "tokens" | "output"; onClose: () => void }) {
  const totals = purposeTotals(workers);
  const sum = Object.values(totals).reduce((sum, bucket) => sum + bucket.known, 0);
  const measured = workers.filter(worker => worker.attributableOutput !== null).length;
  const unknown = workers.length - measured + Number(includeCoordinator);
  let offset = 0;
  const top = [...workers].sort((a, b) => (b.attributableOutput ?? -1) - (a.attributableOutput ?? -1)).slice(0, 5);
  const max = Math.max(1, ...top.map(worker => worker.attributableOutput ?? 0));
  return <aside className="tf-detail tf-charts" aria-label="Allocation detail">
    <div><h3>{title}</h3><button aria-label="Close allocation detail" onClick={onClose}>×</button></div>
    <div className="tf-chart-grid">
      <svg className="tf-donut" viewBox="0 0 120 120" role="img" aria-label={`${flowCount(measured ? sum : null)} known ${basis}; ${unknown} unreported. Observed turn activity.`}>
        <circle cx="60" cy="60" r="44" className="tf-ring-track" />
        {(["communication", "execution", "mixed", "unknown"] as const).map(purpose => {
          const share = sum ? totals[purpose].known / sum : 0, start = offset; offset += share;
          return <circle key={purpose} data-purpose={purpose} cx="60" cy="60" r="44" pathLength="100" className="tf-ring-value" strokeDasharray={`${share * 100} ${100 - share * 100}`} strokeDashoffset={-start * 100} transform="rotate(-90 60 60)" />;
        })}
        {unknown > 0 && <circle cx="60" cy="60" r="54" className="tf-ring-unknown" />}
        <text x="60" y="58" textAnchor="middle" className="tf-ring-total">{flowCount(measured ? sum : null)}</text><text x="60" y="74" textAnchor="middle" className="tf-ring-label">{basis}</text>
      </svg>
      <div className="tf-chart-legend" title={PURPOSE_BASIS}>{(["communication", "execution", "mixed", "unknown"] as const).map(purpose => <div key={purpose} data-purpose={purpose}><span><i />{PURPOSE_NAMES[purpose]}</span><b>{flowCount(totals[purpose].measured ? totals[purpose].known : null)}</b></div>)}<small title="Unreported counters, unavailable coordinator usage, or records crossing the period boundary.">{measured} groups{unknown > 0 && ` · ${unknown} ?`}</small></div>
    </div>
    <div className="tf-contributors" aria-label="Largest retained contributors">{top.map(worker => <div className="tf-contributor" key={worker.key} title={`${worker.title}: ${worker.attributableOutput === null ? "unreported or excluded from totals" : worker.attributableOutput.toLocaleString() + " tokens"}`}>
      <span>{worker.title || "Worker"}</span><b>{flowCount(worker.attributableOutput)}</b><i><em data-purpose={worker.purpose ?? "mixed"} style={{ width: `${(worker.attributableOutput ?? 0) / max * 100}%` }} /></i>
      <small aria-label={`State: ${worker.status}`} title={worker.status}>{worker.status === "completed" ? "✓" : worker.status === "failed" ? "!" : worker.status === "running" ? "▶" : "○"}</small>
    </div>)}</div>
  </aside>;
}

export function LedgerChart({ tokens, day, onClose }: { tokens: UsageView["tokens"] | null; day: string; onClose: () => void }) {
  const total = tokens ? tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite : 0;
  const buckets = [['input', 'Input'], ['output', 'Output'], ['cacheRead', 'Cache read'], ['cacheWrite', 'Cache write']] as const;
  return <aside className="tf-detail tf-charts" aria-label="Daily ledger detail" title="Today's bot ledger only. Disjoint normalized buckets: cached input counted once. Historical per-bot ledger and request-purpose usage are unavailable."><div><h3>{day}</h3><button aria-label="Close daily usage detail" onClick={onClose}>×</button></div>
    <div className="tf-stack" aria-label="Input, output and cache composition">{buckets.map(([key], index) => <i key={key} style={{ width: `${total ? tokens![key] / total * 100 : 25}%`, background: ['var(--blue)', '#A78BFA', 'var(--muted)', 'var(--green)'][index], opacity: tokens ? 1 : .2 }} />)}</div>
    <div className="tf-ledger-values">{buckets.map(([key, label]) => <span key={key}>{label}<b>{flowCount(tokens?.[key] ?? null)}</b></span>)}</div>
  </aside>;
}
