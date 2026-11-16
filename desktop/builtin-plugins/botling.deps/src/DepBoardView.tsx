// Settings → Plugin dependencies: who depends on whom, read only. The graph (arrows from a plugin to the plugins that provide
// what it requires, solid, or uses, dashed; a service nobody provides in red), then each plugin, then the slots and who fills them.
// Nothing here changes anything: there is no switch, no button that acts, no drag.
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { DepBoard, DepNode, DepSlot } from "../../../../Web/host/src/api";
import { layoutGraph, NODE_H, NODE_W, type Graph } from "./layout";
import { REFRESH_MS, type BoardSource } from "./source";

const SLOT_GROUPS: { group: DepSlot["group"]; title: string }[] = [
  { group: "view", title: "Screens" }, { group: "menu", title: "Menus" }, { group: "status", title: "Status bar" }, { group: "hook", title: "Hooks" }, { group: "other", title: "Other" },
];

function Group({ title, children, note, label }: { title: string; children: ReactNode; note?: string; label?: string }) {
  return (
    <section className="settings-group" aria-label={label ?? title}>
      <h3>{title}</h3>
      <div className="settings-card">{children}</div>
      {note && <p className="settings-note">{note}</p>}
    </section>
  );
}

const Chips = ({ names, kind }: { names: string[]; kind: string }) => <>{names.map((name) => <span key={name} className={`dep-chip dep-${kind}`}>{name}</span>)}</>;

function Summary({ board }: { board: DepBoard }) {
  const plugins = board.plugins.filter((plugin) => !plugin.app);
  const on = plugins.filter((plugin) => plugin.enabled).length;
  const live = board.edges.filter((edge) => edge.kind === "requires").length;
  return (
    <p className="settings-note dep-summary" role="status">
      {plugins.length} plugins, {on} on · {live} hard {live === 1 ? "dependency" : "dependencies"} · {board.edges.length - live} optional ·{" "}
      <span className={board.missing.length ? "dep-bad" : "dep-ok"}>{board.missing.length ? `${board.missing.length} missing ${board.missing.length === 1 ? "provider" : "providers"}` : "no missing providers"}</span>
    </p>
  );
}

function GraphView({ graph }: { graph: Graph }) {
  const box = new Map(graph.nodes.map((node) => [node.id, node]));
  return (
    <div className="dep-scroll">
      <svg className="dep-graph" width={graph.width} height={graph.height} viewBox={`0 0 ${graph.width} ${graph.height}`} role="img" aria-label="Dependency graph: arrows go from a plugin to the plugin that provides what it needs">
        <defs>
          {["ok", "off", "bad"].map((tone) => (
            <marker key={tone} id={`dep-arrow-${tone}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" className={`dep-head dep-head-${tone}`} /></marker>
          ))}
        </defs>
        {graph.edges.map((edge) => {
          const tone = edge.kind === "missing" ? "bad" : edge.live ? "ok" : "off";
          return (
            <g key={edge.id} className={`dep-edge dep-edge-${edge.kind} dep-edge-${tone}`} data-kind={edge.kind} data-from={edge.from} data-to={edge.to}>
              <title>{`${box.get(edge.from)?.label} ${edge.kind === "uses" ? "uses" : "requires"} ${edge.service}${edge.kind === "missing" ? " (nobody provides it)" : ""}`}</title>
              <path d={edge.path} fill="none" marker-end={`url(#dep-arrow-${tone})`} />
              <text x={edge.labelX} y={edge.labelY} text-anchor="middle">{edge.service}</text>
            </g>
          );
        })}
        {graph.nodes.map((node) => (
          <g key={node.id} className={`dep-node dep-node-${node.kind}${node.enabled || node.kind === "missing" ? "" : " dep-node-off"}`} data-id={node.id} transform={`translate(${node.x} ${node.y})`}>
            <rect width={NODE_W} height={NODE_H} rx="9" />
            <text x="12" y="19" className="dep-node-name">{node.label.length > 24 ? `${node.label.slice(0, 23)}…` : node.label}</text>
            <text x="12" y="35" className="dep-node-sub">{node.sub}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function PluginRow({ plugin, board }: { plugin: DepNode; board: DepBoard }) {
  const gaps = new Set(board.missing.filter((gap) => gap.plugin === plugin.name).map((gap) => gap.service));
  return (
    <div className={`dep-plugin${plugin.enabled ? "" : " dep-plugin-off"}`} data-plugin={plugin.name}>
      <div className="dep-plugin-head">
        <span className="dep-plugin-name">{plugin.title}</span>
        <span className="dep-plugin-id">{plugin.name}{plugin.version ? ` · v${plugin.version}` : ""}</span>
        <span className="dep-plugin-meta">{plugin.app ? "app" : plugin.builtIn ? "built in" : "installed"}</span>
        <span className={`dep-state ${plugin.enabled ? "dep-state-on" : "dep-state-off"}`}>{plugin.enabled ? "On" : plugin.failure ? "Off (failed)" : "Off"}</span>
      </div>
      <div className="dep-lines">
        {plugin.provides.services.length > 0 && <div className="dep-line"><span className="dep-key">Provides</span><Chips names={plugin.provides.services} kind="provides" /></div>}
        {plugin.requires.length > 0 && <div className="dep-line"><span className="dep-key">Requires</span>{plugin.requires.map((service) => <span key={service} className={`dep-chip ${gaps.has(service) ? "dep-missing" : "dep-requires"}`}>{service}{gaps.has(service) ? " · missing" : ""}</span>)}</div>}
        {plugin.uses.length > 0 && <div className="dep-line"><span className="dep-key">Uses</span><Chips names={plugin.uses} kind="uses" /></div>}
        {plugin.fills.length > 0 && <div className="dep-line"><span className="dep-key">Fills</span><Chips names={plugin.fills} kind="slot" /></div>}
        {plugin.provides.services.length + plugin.requires.length + plugin.uses.length + plugin.fills.length === 0 && <div className="dep-line dep-none">Declares nothing{plugin.builtIn ? "" : " (installed plugins' dependency fields are not read)"}.</div>}
      </div>
    </div>
  );
}

function Slots({ board }: { board: DepBoard }) {
  return (
    <>
      {SLOT_GROUPS.map(({ group, title }) => {
        const rows = board.slots.filter((slot) => slot.group === group);
        if (!rows.length) return null;
        return (
          <Group key={group} title={`Slots · ${title}`} label={`Slots: ${title}`}>
            {rows.map((slot) => (
              <div key={slot.slot} className="settings-row dep-slot" data-slot={slot.slot}>
                <div className="settings-label dep-slot-name">{slot.slot}</div>
                <div className="dep-slot-fills">{slot.fills.length ? <Chips names={slot.fills} kind="slot" /> : <span className="dep-none">empty</span>}</div>
              </div>
            ))}
          </Group>
        );
      })}
    </>
  );
}

/** The page: reads on open and every few seconds, one ask at a time (a slow answer is never overtaken by a second ask). */
export function DepBoardView({ source }: { source: BoardSource }) {
  const [board, setBoard] = useState<DepBoard | null>(null);
  const [failed, setFailed] = useState(false);
  const busy = useRef(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (busy.current) return;
      busy.current = true;
      source.read().then((next) => { if (live) { setBoard(next); setFailed(false); } }, () => { if (live) setFailed(true); })
        .finally(() => { busy.current = false; if (live) timer = setTimeout(load, REFRESH_MS); });
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [source]);
  if (!board) return failed ? <p className="settings-note" role="alert">The plugin list is unavailable. It is asked again in a few seconds.</p> : <p className="settings-note" role="status">Loading plugins…</p>;
  const graph = layoutGraph(board);
  return (
    <>
      {failed && <p className="settings-note" role="alert">Could not refresh; showing the last list.</p>}
      <Summary board={board} />
      <Group title="Who depends on whom" note={graph.nodes.length ? "Solid arrow: requires. Dashed: uses (optional). Red: a required service nobody provides." : undefined}>
        {graph.nodes.length ? <GraphView graph={graph} /> : <div className="dep-none dep-pad">No plugin depends on another one yet.</div>}
        {board.missing.length > 0 && (
          <ul className="dep-gaps" aria-label="Missing providers">
            {board.missing.map((gap) => (
              <li key={`${gap.plugin}:${gap.service}`} className="dep-gap">
                <b>{board.plugins.find((plugin) => plugin.name === gap.plugin)?.title ?? gap.plugin}</b> requires <code>{gap.service}</code>, and no plugin that is on provides it
                {gap.offProviders.length > 0 && <> (provided by {gap.offProviders.join(", ")}, which {gap.offProviders.length === 1 ? "is" : "are"} off)</>}.
              </li>
            ))}
          </ul>
        )}
      </Group>
      <Group title="Plugins" label="Plugins">
        {board.plugins.map((plugin) => <PluginRow key={plugin.name} plugin={plugin} board={board} />)}
      </Group>
      <Slots board={board} />
    </>
  );
}
