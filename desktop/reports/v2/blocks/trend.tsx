import { z } from 'zod';
import { scaleLinear, scalePoint, scaleUtc } from 'd3-scale';
import { defineBlock, type Ctx } from '../core/registry';
import { Card, SrTable } from '../core/ui';
import { areaFor, declutter, niceY, pathFor, PW } from '../core/chart';
import { fmt, r1 } from '../core/text';

type X = string | number;
type Series = { name: string; points: Array<[X, number]> };
type Trend = { title?: string; x: 'date' | 'num' | 'cat'; series: Series[]; area?: boolean; unit?: string; zero?: boolean; target?: { value: number; label: string }; marks?: Array<{ x: X; label: string }> };
const PH = 300;

export function parseX(v: X): number {
  if (typeof v === 'number') return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(v);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
  const t = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (t) return Date.UTC(1970, 0, 1, +t[1], +t[2]);
  return NaN;
}
function fmtDate(ms: number, span: number, lang: string): string {
  const d = new Date(ms);
  const hm = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  if (span <= 2 * 864e5) return hm;
  if (span > 120 * 864e5) return lang === 'en' ? ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] : `${d.getUTCMonth() + 1}月`;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function TrendChart({ block, ctx }: { block: Trend; ctx: Ctx }) {
  const all = block.series.flatMap(s => s.points.map(p => p[1])).concat(block.target ? [block.target.value] : []);
  const { y, ticks } = niceY(all, { zero: block.zero || block.area });
  y.range([PH, 0]);
  const [y0, y1] = y.domain();
  const yPct = (v: number) => r1((1 - (v - y0) / (y1 - y0)) * 100);
  let xPos: (v: X) => number;
  let xTicks: Array<{ at: number; label: string }>;
  if (block.x === 'cat') {
    const cats = [...new Set(block.series.flatMap(s => s.points.map(p => String(p[0]))))];
    const sx = scalePoint<string>().domain(cats).range([0, PW]);
    xPos = v => sx(String(v)) ?? 0;
    const step = Math.ceil(cats.length / 7);
    xTicks = cats.filter((_, i) => i % step === 0 || i === cats.length - 1).map(c => ({ at: sx(c)!, label: c }));
  } else {
    const xs = block.series.flatMap(s => s.points.map(p => parseX(p[0])));
    const lo = Math.min(...xs), hi = Math.max(...xs);
    if (block.x === 'date') {
      const sx = scaleUtc().domain([lo, hi]).range([0, PW]);
      xPos = v => sx(parseX(v));
      const raw = sx.ticks(5).map(d => +d);
      const uniq: Array<{ at: number; label: string }> = [];
      for (const ms of raw) { const label = fmtDate(ms, hi - lo, ctx.lang); if (!uniq.some(u => u.label === label)) uniq.push({ at: sx(ms), label }); }
      const k = Math.ceil(uniq.length / 5);
      xTicks = uniq.filter((_, i) => i % k === 0);
    } else {
      const sx = scaleLinear().domain([lo, hi]).range([0, PW]);
      xPos = v => sx(parseX(v));
      xTicks = sx.ticks(5).map(t => ({ at: sx(t), label: fmt(t) }));
    }
  }
  const xp = (v: number) => `${r1(v / PW * 100)}%`;
  const lines = block.series.map(s => s.points.map(p => [xPos(p[0]), y(p[1])] as [number, number]));
  const ends = block.series.map(s => s.points[s.points.length - 1]);
  const endPos = declutter(ends.map(e => yPct(e[1])), 11, 4, 96);
  return <>
    <div className="tr" aria-hidden="true">
      <div className="yl">{ticks.map(t => <span key={t} style={{ top: `${yPct(t)}%` }}>{fmt(t)}</span>)}</div>
      <div className="tp">
        <svg viewBox={`0 0 ${PW} ${PH}`} preserveAspectRatio="none">
          {ticks.map(t => <line key={t} className="gl" x1={0} x2={PW} y1={r1(y(t))} y2={r1(y(t))} vectorEffect="non-scaling-stroke"/>)}
          {block.area && lines.map((l, i) => <path key={`a${i}`} className={`ar c${i + 1}`} d={areaFor(l, y(Math.max(y0, 0)))}/>)}
          {block.target && <line className="tgt" x1={0} x2={PW} y1={r1(y(block.target.value))} y2={r1(y(block.target.value))} vectorEffect="non-scaling-stroke"/>}
          {lines.map((l, i) => <path key={i} className={`ln c${i + 1}`} d={pathFor(l)} vectorEffect="non-scaling-stroke"/>)}
        </svg>
        {block.marks?.map((m, i) => <span key={i} className="mk" style={{ left: xp(xPos(m.x)) }}><em className={xPos(m.x) > PW * 0.7 ? 'l' : undefined}>{m.label}</em></span>)}
        {block.target && <span className="tgl" style={{ top: `${yPct(block.target.value)}%` }}>{block.target.label}</span>}
        {ends.map((e, i) => <i key={i} className={`dot c${i + 1}`} style={{ left: xp(xPos(e[0])), top: `${yPct(e[1])}%` }}/>)}
      </div>
      <div className="el">{ends.map((e, i) => <span key={i} className={`c${i + 1}`} style={{ top: `${endPos[i]}%` }}><b>{fmt(e[1], block.unit)}</b>{block.series.length > 1 && <em>{block.series[i].name}</em>}</span>)}</div>
      <div className="xl">{xTicks.map((t, i) => <span key={i} style={{ left: xp(t.at) }} className={t.at < PW * 0.04 ? 'first' : t.at > PW * 0.96 ? 'last' : undefined}>{t.label}</span>)}</div>
    </div>
    <SrTable caption={block.title ?? 'trend'} columns={['x', ...block.series.map(s => s.name)]}
      rows={[...new Set(block.series.flatMap(s => s.points.map(p => String(p[0]))))].map(x => [x, ...block.series.map(s => { const p = s.points.find(q => String(q[0]) === x); return p ? fmt(p[1], block.unit) : '–'; })])}/>
  </>;
}

const xValue = z.union([z.string().trim().min(1).max(20), z.number()]);
export const trend = defineBlock({
  type: 'trend',
  description: 'Line or area chart over time (or any ordered x) for 1–4 series, with direct end labels, optional target line and up to 3 event marks.',
  when: 'Change over time, especially before/after an event (mark it). Title says the trend ("閒置 CPU 降了七成"). For two numbers only, use kpi or beforeafter.',
  fields: {
    x: z.enum(['date', 'num', 'cat']).default('date').describe('date = "YYYY-MM-DD", "YYYY-MM-DD HH:MM" or "HH:MM"; num = numbers; cat = ordered labels.'),
    series: z.array(z.strictObject({ name: z.string().trim().min(1).max(20), points: z.array(z.tuple([xValue, z.number()])).min(2).max(60) })).min(1).max(4),
    area: z.boolean().optional(),
    zero: z.boolean().optional().describe('Start the y axis at zero.'),
    unit: z.string().trim().max(8).optional(),
    target: z.strictObject({ value: z.number(), label: z.string().trim().min(1).max(16) }).optional(),
    marks: z.array(z.strictObject({ x: xValue, label: z.string().trim().min(1).max(16) })).max(3).optional(),
  },
  refine: (v, c) => {
    const b = v as unknown as Trend;
    if (b.x !== 'cat') b.series.forEach((s, i) => s.points.forEach((p, j) => { if (Number.isNaN(parseX(p[0]))) c.addIssue({ code: 'custom', path: ['series', i, 'points', j, 0], message: b.x === 'date' ? 'date must be "YYYY-MM-DD", "YYYY-MM-DD HH:MM" or "HH:MM"' : 'x must be a number' }); }));
  },
  examples: [{ title: '閒置 CPU 在 10/24 改版後降到 2%', unit: '%', x: 'date', area: true, target: { value: 3, label: '目標 3%' }, marks: [{ x: '2026-10-24', label: '停掉背景輪詢' }], series: [{ name: '閒置 CPU', points: [['2026-10-20', 9.6], ['2026-10-21', 9.9], ['2026-10-22', 9.2], ['2026-10-23', 8.8], ['2026-10-24', 4.1], ['2026-10-25', 2.6], ['2026-10-26', 2.2], ['2026-10-27', 2.1]] }] }],
  fit: 'visual',
  visual: true,
  Doc: ({ block, ctx }) => <Card type="trend" block={block} ctx={ctx}><TrendChart block={block} ctx={ctx}/></Card>,
  slide: { weight: () => 0.72 },
});
