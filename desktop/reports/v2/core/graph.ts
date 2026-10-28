// Graph layout via elkjs (EPL-2.0 OR GPL-3.0, used unmodified; see reports/v2/NOTICE).
// Runs once at generation time in Node; the HTML only receives finished SVG coordinates.
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import { textWidth, wrapText, r1 } from './text';

export type GNode = { id: string; label: string; sub?: string; kind?: string; status?: string };
export type GEdge = { from: string; to: string; label?: string; kind?: string };
export type PlacedNode = GNode & { x: number; y: number; w: number; h: number; lines: string[] };
export type PlacedEdge = GEdge & { points: Array<[number, number]>; lx?: number; ly?: number; lw?: number };
export type GraphLayout = { w: number; h: number; nodes: PlacedNode[]; edges: PlacedEdge[] };

export const NODE_FONT = 14, SUB_FONT = 12, LINE = 18;
const elk = new ELK();

export function nodeSize(n: GNode, maxW: number): { w: number; h: number; lines: string[] } {
  const pad = n.kind === 'decision' ? 44 : 28;
  const lines = wrapText(n.label, NODE_FONT, maxW - pad, 3);
  const subText = `${n.status ? '進行中' : ''}${n.status && n.sub ? ' · ' : ''}${n.sub ?? ''}`;
  const textW = Math.max(...lines.map(l => textWidth(l, NODE_FONT)), subText ? textWidth(subText, SUB_FONT) : 0);
  const w = Math.ceil(Math.min(maxW, Math.max(n.kind === 'start' || n.kind === 'end' ? 72 : 104, textW + pad + (n.status ? 6 : 0))));
  const h = 22 + lines.length * LINE + (n.sub || n.status ? 16 : 0);
  return { w, h, lines };
}

export async function layoutGraph(nodes: GNode[], edges: GEdge[], dir: 'LR' | 'TB'): Promise<GraphLayout> {
  const maxW = dir === 'LR' ? 176 : 220;
  const sized = new Map(nodes.map(n => [n.id, nodeSize(n, maxW)]));
  const graph: ElkNode = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '20',
      'elk.layered.spacing.nodeNodeBetweenLayers': dir === 'LR' ? '44' : '36',
      'elk.spacing.edgeLabel': '4',
      'elk.layered.spacing.edgeNodeBetweenLayers': '16',
      'elk.edgeLabels.inline': 'true',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=4,left=4,bottom=4,right=4]',
      'elk.randomSeed': '1',
    },
    children: nodes.map(n => ({ id: n.id, width: sized.get(n.id)!.w, height: sized.get(n.id)!.h })),
    edges: edges.map((e, i) => ({
      id: `e${i}`, sources: [e.from], targets: [e.to],
      labels: e.label ? [{ text: e.label, width: Math.ceil(textWidth(e.label, 12)) + 12, height: 18 }] : [],
    })),
  });
  const placed: PlacedNode[] = nodes.map(n => {
    const c = graph.children!.find(k => k.id === n.id)!;
    return { ...n, x: r1(c.x!), y: r1(c.y!), w: c.width!, h: c.height!, lines: sized.get(n.id)!.lines };
  });
  const placedEdges: PlacedEdge[] = edges.map((e, i) => {
    const ge = graph.edges!.find(k => k.id === `e${i}`)! as ElkExtendedEdge;
    const s = ge.sections?.[0];
    const points: Array<[number, number]> = s ? [[s.startPoint.x, s.startPoint.y], ...(s.bendPoints ?? []).map(p => [p.x, p.y] as [number, number]), [s.endPoint.x, s.endPoint.y]] : [];
    const lab = ge.labels?.[0];
    return { ...e, points: points.map(([x, y]) => [r1(x), r1(y)] as [number, number]), ...(lab ? { lx: r1(lab.x!), ly: r1(lab.y!), lw: lab.width } : {}) };
  });
  return { w: Math.ceil(graph.width!), h: Math.ceil(graph.height!), nodes: placed, edges: placedEdges };
}

/** Orthogonal polyline with rounded corners, ending a few px short so the arrowhead meets the node. */
export function roundedPath(points: Array<[number, number]>, radius = 8): string {
  if (points.length < 2) return '';
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1], [x, y] = points[i], [nx, ny] = points[i + 1];
    const r = Math.min(radius, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const ax = x - Math.sign(x - px) * r, ay = y - Math.sign(y - py) * r;
    const bx = x + Math.sign(nx - x) * r, by = y + Math.sign(ny - y) * r;
    d += `L${r1(ax)} ${r1(ay)}Q${x} ${y} ${r1(bx)} ${r1(by)}`;
  }
  const [lx, ly] = points[points.length - 1], [qx, qy] = points[points.length - 2];
  const len = Math.hypot(lx - qx, ly - qy) || 1;
  d += `L${r1(lx - ((lx - qx) / len) * 2)} ${r1(ly - ((ly - qy) / len) * 2)}`;
  return d;
}
