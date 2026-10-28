import { TokenFlowAllocationCanvas } from "./TokenFlowAllocationCanvas";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BotView } from "../contract";
import { flowCount, flowPurpose, type FlowWorker } from "./token-flow-model";
import { addPositions, readFlowLayout, saveFlowLayout, fitCamera, layoutFlow, NODE_HEIGHT, NODE_WIDTH, zoomCamera, type Camera, type Point } from "./token-flow-layout";

function DelegationCanvas({ bot, workers, selected, onSelect, allocationEdges, rootOutput, rootLabel, basis = "output" }: {
  bot: BotView; workers: FlowWorker[]; selected: string | null; onSelect: (key: string | null) => void;
  allocationEdges?: import("./token-flow-history-model").AllocationEdge[]; rootOutput?: number | null; rootLabel?: string; basis?: "tokens" | "output";
}) {
  const ids = useMemo(() => ["coordinator", ...workers.map(worker => worker.key)], [workers]);
  const edges = useMemo(() => allocationEdges ?? workers.filter(worker => worker.parentKey && ids.includes(worker.parentKey) && worker.key !== worker.parentKey)
    .map(worker => ({ source: worker.parentKey, target: worker.key })), [workers, ids, allocationEdges]);
  const [narrow, setNarrow] = useState(() => window.innerWidth < 600);
  const layoutKey = `${bot.id}:${narrow ? "narrow" : "wide"}`;
  const restored = useRef(readFlowLayout(layoutKey));
  const [positions, setPositions] = useState(() => addPositions(restored.current?.positions ?? {}, ids, narrow));
  const shown = useMemo(() => addPositions(positions, ids, narrow), [positions, ids, narrow]);
  const visiblePositions = Object.fromEntries(ids.map(id => [id, shown[id]]));
  const [camera, setCamera] = useState<Camera>(restored.current?.camera ?? { x: 24, y: 24, scale: 1 });
  const viewport = useRef<HTMLDivElement>(null);
  const latest = useRef({ camera, positions: shown, visiblePositions });
  latest.current = { camera, positions: shown, visiblePositions };
  const touched = useRef(!!restored.current), fitted = useRef(!!restored.current);
  useEffect(() => { const timer = setTimeout(() => saveFlowLayout(layoutKey, positions, camera), 250); return () => clearTimeout(timer); }, [positions, camera, layoutKey]);
  useEffect(() => () => saveFlowLayout(layoutKey, latest.current.positions, latest.current.camera), [layoutKey]);
  const drag = useRef<{ pointer: number; key: string | null; start: Point; origin: Point; scale: number; moved: boolean } | null>(null);
  const marker = `flow-arrow-${useId().replace(/:/g, "")}`;
  useEffect(() => { setPositions(previous => addPositions(previous, ids, narrow)); }, [ids]);
  useEffect(() => {
    let live = true;
    if (restored.current) return;
    // Keep a manual layout if interaction wins the race with asynchronous ELK.
    const rect = viewport.current?.getBoundingClientRect();
    const vertical = !!rect && rect.width < 500;
    if (vertical) setNarrow(true);
    void (vertical ? Promise.resolve(addPositions({}, ids, true)) : layoutFlow(ids, edges)).then(layout => {
      if (!live || touched.current) return;
      setPositions(previous => ({ ...previous, ...layout }));
      const rect = viewport.current?.getBoundingClientRect();
      if (rect) { setCamera(fitCamera(layout, rect.width, vertical ? ids.length * 150 + 64 : rect.height)); fitted.current = true; }
    }).catch(() => { /* The deterministic grid remains usable if layout is unavailable. */ });
    return () => { live = false; };
    // Initial layout only. Newly observed nodes occupy free slots; existing nodes never jump.
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = () => {
      if (fitted.current || touched.current) return;
      const rect = element.getBoundingClientRect();
      if (rect.width && rect.height) { setCamera(fitCamera(latest.current.visiblePositions, rect.width, rect.height)); fitted.current = true; }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(element); resize();
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); touched.current = true;
      const rect = element.getBoundingClientRect();
      setCamera(current => event.ctrlKey || event.metaKey
        ? zoomCamera(current, current.scale * Math.exp(-event.deltaY * .002), { x: event.clientX - rect.left, y: event.clientY - rect.top })
        : { ...current, x: current.x - event.deltaX, y: current.y - event.deltaY });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => { observer?.disconnect(); element.removeEventListener("wheel", wheel); drag.current = null; };
  }, []);
  const zoom = (factor: number) => {
    touched.current = true;
    const rect = viewport.current!.getBoundingClientRect();
    setCamera(current => zoomCamera(current, current.scale * factor, { x: rect.width / 2, y: rect.height / 2 }));
  };
  const fit = () => {
    touched.current = true;
    const rect = viewport.current!.getBoundingClientRect();
    setCamera(fitCamera(latest.current.visiblePositions, rect.width, rect.height));
  };
  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const max = Math.max(1, ...workers.map(worker => worker.output ?? 0));
  return <div className="tf-graph-shell">
    <div className="tf-graph-toolbar"><span title="Drag nodes to arrange; drag blank space or scroll to pan. Ctrl/⌘ + scroll to zoom." aria-label="Drag nodes and pan canvas">↔</span><div role="group" aria-label="Canvas controls">
      <button aria-label="Zoom out" title="Zoom out" onClick={() => zoom(1 / 1.2)}>−</button><output aria-label="Zoom level">{Math.round(camera.scale * 1000) / 10}%</output>
      <button aria-label="Zoom in" title="Zoom in" onClick={() => zoom(1.2)}>+</button><button aria-label="Fit view" title="Fit all nodes" onClick={fit}>⊡</button>
    </div></div>
    <div ref={viewport} className="tf-canvas" style={narrow ? { height: Math.max(600, ids.length * 150 + 64) } : undefined} tabIndex={0} role="group" aria-label="Delegation canvas" title="Drag a node to arrange it. Drag blank space or scroll to pan. Ctrl/⌘ + scroll to zoom. Arrow keys move a focused node or pan the canvas."
      onPointerDown={event => {
        if (event.button !== 0 || drag.current) return;
        const key = (event.target as Element).closest<HTMLElement>("[data-flow-node]")?.dataset.flowNode ?? null;
        touched.current = true;
        drag.current = { pointer: event.pointerId, key, start: { x: event.clientX, y: event.clientY },
          origin: key ? { ...shown[key] } : { x: camera.x, y: camera.y }, scale: camera.scale, moved: false };
        // Keep pointer capture on the canvas even when the node moves under the pointer.
        (event.target as Element).closest<HTMLButtonElement>("button")?.focus();
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={event => {
        const gesture = drag.current;
        if (!gesture || gesture.pointer !== event.pointerId) return;
        const dx = event.clientX - gesture.start.x, dy = event.clientY - gesture.start.y;
        if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
        gesture.moved = true;
        if (gesture.key) setPositions(previous => ({ ...addPositions(previous, ids, narrow), [gesture.key!]: { x: gesture.origin.x + dx / gesture.scale, y: gesture.origin.y + dy / gesture.scale } }));
        else setCamera(current => ({ ...current, x: gesture.origin.x + dx, y: gesture.origin.y + dy }));
      }}
      onPointerUp={event => {
        const gesture = drag.current;
        if (gesture?.pointer === event.pointerId && !gesture.moved && gesture.key) onSelect(selected === gesture.key ? null : gesture.key);
        finish(event);
      }} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={event => {
        const delta = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[event.key];
        if (!delta) return;
        event.preventDefault(); touched.current = true;
        const key = (event.target as HTMLElement).dataset.flowNode;
        if (key) setPositions(previous => ({ ...addPositions(previous, ids, narrow), [key]: { x: shown[key].x + delta[0], y: shown[key].y + delta[1] } }));
        else setCamera(current => ({ ...current, x: current.x + delta[0], y: current.y + delta[1] }));
      }}>
      <div className="tf-world" data-camera={`${camera.x},${camera.y},${camera.scale}`} style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
        <svg className="tf-edges" aria-label="Recorded delegation edges"><defs>{(["communication", "execution", "mixed", "unknown"] as const).map(purpose => <marker key={purpose} id={`${marker}-${purpose}`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" orient="auto-start-reverse"><path data-purpose={purpose} d="M 0 0 L 10 5 L 0 10 z" /></marker>)}</defs>
          {edges.map(edge => {
            const a = shown[edge.source], b = shown[edge.target];
            const right = b.x >= a.x, x1 = a.x + (right ? NODE_WIDTH : 0), x2 = b.x + (right ? 0 : NODE_WIDTH);
            const y1 = a.y + NODE_HEIGHT / 2, y2 = b.y + NODE_HEIGHT / 2, bend = Math.max(40, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
            const path = narrow
              ? `M${a.x + NODE_WIDTH},${y1} C${Math.max(a.x,b.x) + NODE_WIDTH + 40},${y1} ${Math.max(a.x,b.x) + NODE_WIDTH + 40},${y2} ${b.x + NODE_WIDTH},${y2}`
              : `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
            const purpose = "purpose" in edge ? edge.purpose as import("./token-flow-model").FlowPurpose : edge.source === "coordinator" ? "communication" : flowPurpose(workers.find(worker => worker.key === edge.source)!, workers);
            return <path key={`${edge.source}:${edge.target}`} style={"value" in edge ? { strokeWidth: edge.value === null ? 2 : 2 + 16 * (edge.value as number) / Math.max(1, rootOutput ?? 1), strokeDasharray: edge.value === null ? "5 5" : undefined } : undefined} data-purpose={purpose} data-source={edge.source} data-target={edge.target} d={path} markerEnd={`url(#${marker}-${purpose})`} />;
          })}
        </svg>
        {ids.map(key => {
          const worker = workers.find(node => node.key === key), position = shown[key];
          const unknownParent = worker && !worker.aggregate && !ids.includes(worker.parentKey);
          const purpose = worker ? flowPurpose(worker, workers) : rootLabel ? "mixed" : "communication";
          const status = worker?.status ?? (bot.connection ? "waiting" : bot.working ? "running" : "idle");
          const stateIcon: Record<string, string> = { running: "▶", completed: "✓", failed: "!", stopped: "■", waiting: "Ⅱ", idle: "○", unknown: "?" };
          return <button key={key} data-purpose={purpose} data-flow-node={key} data-position={`${position.x},${position.y}`} className={`tf-graph-node ${worker ? 'tf-worker' : 'tf-coordinator'}`} aria-pressed={selected === key}
            style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
            onClick={event => {
              // Pointer selection is handled on pointerup; keyboard activation has detail=0.
              if (event.detail === 0) onSelect(selected === key ? null : key);
            }}>
            <span className="tf-dot" title={`${purpose} · observed turn activity`} />
            <b title={worker?.title ?? bot.name}>{worker?.title || (worker ? "Worker" : bot.name)}</b>
            <small>{worker?.aggregate ? worker.key.startsWith("purpose:") ? "activity" : `${worker.count ?? 0} ${worker.count === 1 ? "record" : "records"}` : worker?.engine ?? (worker ? "?" : rootLabel ?? "Coordinator")}</small><span hidden={!!worker?.aggregate || !!rootLabel} className={`tf-node-state ${status}`} aria-label={`State: ${status}`} title={status}>{stateIcon[status] ?? "?"}</span>
            <span className="tf-node-usage"><strong>{flowCount(worker ? worker.output : rootOutput ?? null)}{worker?.incomplete && <sup title="Partial: some counters unavailable">?</sup>}</strong> {basis === "output" ? "out" : "tokens"}{unknownParent && <em title="The direct parent is missing or not recorded. No edge is inferred."> · ?</em>}</span>
            {worker && <i className="tf-node-meter"><em style={{ width: `${worker.output === null ? 0 : worker.output / max * 100}%` }} /></i>}
          </button>;
        })}
      </div>
      {!workers.length && <p className="tf-canvas-empty">No worker records yet</p>}
    </div>
  </div>;
}

export function TokenFlowCanvas(props: Parameters<typeof DelegationCanvas>[0]) {
  return props.allocationEdges !== undefined
    ? <TokenFlowAllocationCanvas {...props} allocationEdges={props.allocationEdges} />
    : <DelegationCanvas {...props} />;
}
