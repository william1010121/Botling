// The graph of the board, laid out: columns by how far a plugin is from the ones that provide things (a plugin that needs
// nothing is the rightmost column; whoever needs it is one column to its left, and so on), one row per node, one arrow per
// (plugin, service). Pure: the board in, boxes and arrow paths out, so it is tested without a page.
// Only plugins with an arrow (or a missing provider) are drawn; the rest are on the list below the graph.
import type { DepBoard } from "../../../../Web/host/src/api";

export const NODE_W = 188;
export const NODE_H = 46;
export const COL_GAP = 132;
export const ROW_GAP = 16;
export const PAD = 16;

export interface GraphNode {
  id: string;
  label: string;
  /** The line under the label: the version, or "no provider" for a missing service. */
  sub: string;
  kind: "plugin" | "app" | "missing";
  enabled: boolean;
  x: number;
  y: number;
}
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  service: string;
  kind: "requires" | "uses" | "missing";
  live: boolean;
  /** An SVG path from the right side of `from` to the left side of `to`. */
  path: string;
  /** Where the service name sits (the middle of the arrow). */
  labelX: number;
  labelY: number;
}
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number }

/** The id of the stand-in node for a service nobody provides. */
export const missingId = (service: string) => `missing:${service}`;

export function layoutGraph(board: DepBoard): Graph {
  const named = new Map(board.plugins.map((plugin) => [plugin.name, plugin]));
  const links: { from: string; to: string; service: string; kind: GraphEdge["kind"]; live: boolean }[] = [];
  for (const edge of board.edges) if (named.has(edge.from) && named.has(edge.to)) links.push(edge);
  for (const gap of board.missing) if (named.has(gap.plugin)) links.push({ from: gap.plugin, to: missingId(gap.service), service: gap.service, kind: "missing", live: false });

  const ids = new Set<string>();
  for (const link of links) { ids.add(link.from); ids.add(link.to); }
  if (ids.size === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const targets = new Map<string, string[]>();
  for (const link of links) targets.set(link.from, [...(targets.get(link.from) ?? []), link.to]);
  // level 0: needs nothing drawn; otherwise one more than the deepest thing it needs (an arrow back into the chain being measured counts as 0, so a cycle ends).
  const levels = new Map<string, number>();
  const measuring = new Set<string>();
  const level = (id: string): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    if (measuring.has(id)) return -1;
    measuring.add(id);
    const value = Math.max(-1, ...(targets.get(id) ?? []).filter((to) => to !== id).map(level)) + 1;
    measuring.delete(id);
    levels.set(id, value);
    return value;
  };
  for (const id of ids) level(id);
  const deepest = Math.max(...[...ids].map((id) => levels.get(id)!));

  const label = (id: string) => (id.startsWith("missing:") ? id.slice("missing:".length) : named.get(id)?.title ?? id);
  const order = [...ids].sort((a, b) => label(a).localeCompare(label(b)) || a.localeCompare(b));
  const rows = new Map<number, number>();
  const nodes: GraphNode[] = order.map((id) => {
    const column = deepest - levels.get(id)!;
    const row = rows.get(column) ?? 0;
    rows.set(column, row + 1);
    const plugin = named.get(id);
    return {
      id, label: label(id), kind: plugin ? (plugin.app ? "app" : "plugin") : "missing",
      sub: plugin ? (plugin.version ? `v${plugin.version}${plugin.enabled ? "" : " · off"}` : "built in") : "no provider",
      enabled: plugin ? plugin.enabled : false,
      x: PAD + column * (NODE_W + COL_GAP), y: PAD + row * (NODE_H + ROW_GAP),
    };
  });
  const box = new Map(nodes.map((node) => [node.id, node]));
  const edges: GraphEdge[] = links.map((link, index) => {
    const a = box.get(link.from)!, b = box.get(link.to)!;
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
    const bend = Math.max(40, Math.abs(x2 - x1) / 2);
    return {
      id: `${link.kind}:${link.from}:${link.to}:${link.service}:${index}`, ...link,
      path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      labelX: (x1 + x2) / 2, labelY: (y1 + y2) / 2 - 4,
    };
  });
  const columns = deepest + 1;
  const tallest = Math.max(...rows.values());
  return { nodes, edges, width: PAD * 2 + columns * NODE_W + (columns - 1) * COL_GAP, height: PAD * 2 + tallest * NODE_H + (tallest - 1) * ROW_GAP };
}
