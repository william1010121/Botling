import { useId, useMemo, useRef } from "react";
import type { BotView } from "../contract";
import type { AllocationEdge } from "./token-flow-history-model";
import { flowCount, type FlowWorker } from "./token-flow-model";
import { allocationPositions, ALLOCATION_COLUMNS, ALLOCATION_COLUMN_STEP, NODE_HEIGHT, NODE_WIDTH } from "./token-flow-layout";

/** Allocation is a three-stage accounting view, not a freely arranged delegation graph. */
export function TokenFlowAllocationCanvas({ bot, workers, selected, onSelect, allocationEdges, rootOutput, rootLabel, basis = "output" }: {
  bot: BotView; workers: FlowWorker[]; selected: string | null; onSelect: (key: string | null) => void;
  allocationEdges: AllocationEdge[]; rootOutput?: number | null; rootLabel?: string; basis?: "tokens" | "output";
}) {
  const ids = ["coordinator", ...workers.map(worker => worker.key)];
  const topology = JSON.stringify([ids.slice().sort(), allocationEdges.map(e => [e.source, e.target]).sort()]);
  // Cache by topology only; live counters cannot move a node under the reader's pointer.
  const positions = useMemo(() => allocationPositions(ids, allocationEdges), [topology]);
  const marker = `allocation-${useId().replace(/:/g, "")}`;
  const viewport = useRef<HTMLDivElement>(null);
  const height = Math.max(...Object.values(positions).map(p => p.y + NODE_HEIGHT)) + 24;
  const max = Math.max(1, ...workers.map(w => w.output ?? 0));
  const connected = new Set([selected, ...allocationEdges.filter(e => e.source === selected || e.target === selected).flatMap(e => [e.source, e.target])]);
  return <div className="tf-graph-shell">
    <div className="tf-graph-toolbar" style={{ flexWrap: "wrap" }}>
      <small>Select a card for details · Scroll to see all columns</small>
      <div role="group" aria-label="Show allocation column">{ALLOCATION_COLUMNS.map((title, i) => <button key={title} aria-label={`Show ${title} column`} onClick={() => viewport.current?.scrollTo({ left: i * ALLOCATION_COLUMN_STEP, top: 0 })}>{title}</button>)}</div>
    </div>
    <div ref={viewport} className="tf-canvas" role="group" aria-label="Token allocation: Project to Tasks to Activity" tabIndex={0}
      style={{ overflow: "auto", touchAction: "pan-x pan-y", cursor: "auto", height: Math.min(height + 12, 760) }}
      onKeyDown={event => {
        if (event.key === "Escape") onSelect(null);
        if (event.target !== event.currentTarget) return;
        const delta = { ArrowLeft: [-80, 0], ArrowRight: [80, 0], ArrowUp: [0, -80], ArrowDown: [0, 80] }[event.key];
        if (delta) { event.preventDefault(); viewport.current?.scrollBy({ left: delta[0], top: delta[1] }); }
      }}>
      <div style={{ position: "relative", width: ALLOCATION_COLUMN_STEP * 2 + NODE_WIDTH + 48, height }}>
        {ALLOCATION_COLUMNS.map((title, i) => <strong key={title} style={{ position: "absolute", left: 24 + i * ALLOCATION_COLUMN_STEP, top: 14, fontSize: 13, color: "var(--muted)" }}>{title}</strong>)}
        <svg className="tf-edges" aria-label="Recorded allocation edges" style={{ left: 24 }}>
          <defs>{["communication", "execution", "mixed", "unknown"].map(purpose => <marker key={purpose} id={`${marker}-${purpose}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path data-purpose={purpose} d="M0 0 L10 5 L0 10 z" /></marker>)}</defs>
          {allocationEdges.map(edge => {
            const a = positions[edge.source], b = positions[edge.target];
            if (!a || !b) return null;
            const x1 = a.x + NODE_WIDTH, x2 = b.x, mid = (x1 + x2) / 2;
            const y1 = a.y + NODE_HEIGHT / 2, y2 = b.y + NODE_HEIGHT / 2;
            return <path key={`${edge.source}:${edge.target}`} data-source={edge.source} data-target={edge.target} data-purpose={edge.purpose}
              d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} markerEnd={`url(#${marker}-${edge.purpose})`}
              style={{ strokeWidth: edge.value === null ? 2 : 2 + 10 * edge.value / Math.max(1, rootOutput ?? 1), strokeDasharray: edge.value === null ? "5 5" : undefined, opacity: selected && selected !== edge.source && selected !== edge.target ? .12 : .65 }} />;
          })}
        </svg>
        {ids.map(key => {
          const worker = workers.find(w => w.key === key), position = positions[key];
          if (!position) return null;
          const purpose = worker?.purpose ?? "mixed";
          return <button key={key} className={`tf-graph-node ${worker ? "tf-worker" : "tf-coordinator"}`} data-flow-node={key} data-position={`${position.x},${position.y}`} data-purpose={purpose} aria-pressed={selected === key}
            style={{ left: position.x + 24, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT, cursor: "pointer", touchAction: "pan-x pan-y", opacity: selected && !connected.has(key) ? .5 : 1 }}
            onClick={() => onSelect(selected === key ? null : key)}>
            <span className="tf-dot" /><b title={worker?.title ?? bot.name}>{worker?.title ?? bot.name}</b>
            <small>{worker ? key.startsWith("purpose:") ? basis === "tokens" ? "Whole-turn activity" : "Recorded activity" : `${worker.count ?? 0} ${worker.count === 1 ? "record" : "records"}` : rootLabel ?? "Project"}</small>
            <span className="tf-node-usage"><strong>{flowCount(worker ? worker.output : rootOutput ?? null)}{worker?.incomplete && <sup title="Partial: some counters unavailable">?</sup>}</strong> {basis === "tokens" ? "tokens" : "out"}</span>
            {worker && <i className="tf-node-meter"><em style={{ width: `${worker.output === null ? 0 : worker.output / max * 100}%` }} /></i>}
          </button>;
        })}
      </div>
    </div>
  </div>;
}
