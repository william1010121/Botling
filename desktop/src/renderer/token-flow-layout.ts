export interface Point { x: number; y: number }
export interface Camera extends Point { scale: number }
export interface FlowEdge { source: string; target: string }
export const NODE_WIDTH = 220, NODE_HEIGHT = 108;
export const MIN_SCALE = .001, MAX_SCALE = 2.5;
export const clampScale = (scale: number) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));

/** New arrivals get free slots; existing coordinates are never recomputed on telemetry refresh. */
export function addPositions(previous: Record<string, Point>, ids: string[], vertical = false) {
  const next = { ...previous };
  let slot = 0;
  for (const id of ids) if (!next[id]) {
    let point: Point;
    do { point = vertical ? { x: 0, y: slot * 150 } : { x: (slot % 3) * 290, y: Math.floor(slot / 3) * 160 }; slot++; }
    while (Object.values(next).some(other => Math.abs(other.x - point.x) < NODE_WIDTH + 20 && Math.abs(other.y - point.y) < NODE_HEIGHT + 20));
    next[id] = point;
  }
  return next;
}
export function fitCamera(positions: Record<string, Point>, width: number, height: number): Camera {
  const points = Object.values(positions);
  if (!points.length || width <= 0 || height <= 0) return { x: 24, y: 24, scale: 1 };
  const left = Math.min(...points.map(p => p.x)), top = Math.min(...points.map(p => p.y));
  const right = Math.max(...points.map(p => p.x + NODE_WIDTH)), bottom = Math.max(...points.map(p => p.y + NODE_HEIGHT));
  const scale = clampScale(Math.min(1, (width - 64) / (right - left), (height - 64) / (bottom - top)));
  return { scale, x: (width - (right - left) * scale) / 2 - left * scale, y: (height - (bottom - top) * scale) / 2 - top * scale };
}
export function zoomCamera(camera: Camera, scale: number, anchor: Point): Camera {
  const next = clampScale(scale), ratio = next / camera.scale;
  return { scale: next, x: anchor.x - (anchor.x - camera.x) * ratio, y: anchor.y - (anchor.y - camera.y) * ratio };
}
/** Use the already installed ELK only for initial topology, not token/status changes. */
export async function layoutFlow(ids: string[], edges: FlowEdge[]): Promise<Record<string, Point>> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  // Bundled ELK uses a finite in-process worker shim; there is no worker thread to terminate.
  const graph = await elk.layout({ id: "flow", layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "32", "elk.layered.spacing.nodeNodeBetweenLayers": "90",
    }, children: ids.map(id => ({ id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: edges.map((edge, index) => ({ id: `e${index}`, sources: [edge.source], targets: [edge.target] })) });
    return Object.fromEntries((graph.children ?? []).map(node => [node.id, { x: node.x ?? 0, y: node.y ?? 0 }]));
}

export function readFlowLayout(botId: string): { positions: Record<string, Point>; camera: Camera } | null {
  try {
    const value = JSON.parse(localStorage.getItem("token-flow-layout-v2") ?? "{}")[botId];
    if (!value || !Number.isFinite(value.camera?.x) || !Number.isFinite(value.camera?.y) || !(value.camera?.scale > 0)) return null;
    const positions = Object.fromEntries(Object.entries(value.positions ?? {}).slice(-200).filter(([, p]: [string, any]) => Number.isFinite(p?.x) && Number.isFinite(p?.y))) as Record<string, Point>;
    return { positions, camera: { ...value.camera, scale: clampScale(value.camera.scale) } };
  } catch { return null; }
}
export function saveFlowLayout(botId: string, positions: Record<string, Point>, camera: Camera) {
  try {
    const all = JSON.parse(localStorage.getItem("token-flow-layout-v2") ?? "{}");
    delete all[botId];
    const bounded = Object.fromEntries(Object.entries(all).slice(-19));
    bounded[botId] = { positions: Object.fromEntries(Object.entries(positions).slice(-200)), camera };
    localStorage.setItem("token-flow-layout-v2", JSON.stringify(bounded));
  } catch { /* Storage unavailable: retain the in-memory layout. */ }
}
