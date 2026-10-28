import { scaleLinear } from 'd3-scale';
import { line as d3line, area as d3area } from 'd3-shape';
import { r1 } from './text';

/** Plot space for stretchable charts: marks are drawn in a 1000×H box with preserveAspectRatio=none
 *  and non-scaling strokes, while every label is HTML positioned in % so text never shrinks. */
export const PW = 1000;

export function niceY(values: number[], opts: { zero?: boolean; ticks?: number } = {}) {
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.08;
  const domain: [number, number] = opts.zero || lo >= 0 && lo < (hi - lo) * 0.6 ? [Math.min(0, lo), hi + pad] : [lo - pad, hi + pad];
  const y = scaleLinear().domain(domain).nice(opts.ticks ?? 4);
  return { y, ticks: y.ticks(opts.ticks ?? 4) };
}

export function pathFor(points: Array<[number, number]>): string {
  return (d3line<[number, number]>().x(p => r1(p[0])).y(p => r1(p[1]))(points) ?? '').replace(/(\d)\.0(?=\D|$)/g, '$1');
}
export function areaFor(points: Array<[number, number]>, base: number): string {
  return d3area<[number, number]>().x(p => r1(p[0])).y0(r1(base)).y1(p => r1(p[1]))(points) ?? '';
}

/** Spread label positions (0–100 %) so they keep a minimum gap, preserving order. Deterministic. */
export function declutter(pos: number[], gap: number, lo = 0, hi = 100): number[] {
  const idx = pos.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const out = idx.map(([p]) => p);
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap);
  const over = out.length ? out[out.length - 1] - hi : 0;
  if (over > 0) for (let i = out.length - 1; i >= 0; i--) out[i] = Math.min(out[i] - over, i < out.length - 1 ? out[i + 1] - gap : hi);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(lo, out[i]);
  const res = new Array<number>(pos.length);
  idx.forEach(([, i], k) => { res[i] = r1(out[k]); });
  return res;
}

export function Sparkline({ points, className }: { points: number[]; className?: string }) {
  const H = 24;
  const y = scaleLinear().domain([Math.min(...points), Math.max(...points) || 1]).range([H - 2, 2]);
  if (Math.min(...points) === Math.max(...points)) y.domain([points[0] - 1, points[0] + 1]);
  const pts = points.map((v, i) => [i * (100 / (points.length - 1)), y(v)] as [number, number]);
  const last = pts[pts.length - 1];
  return <span className={`spark ${className ?? ''}`} aria-hidden="true">
    <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none"><path d={pathFor(pts)} vectorEffect="non-scaling-stroke"/></svg>
    <i style={{ top: `${r1(last[1] / H * 100)}%` }}/>
  </span>;
}
