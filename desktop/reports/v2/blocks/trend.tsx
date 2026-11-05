// Retired native chart: the renderer no longer draws it. Older specs still validate and show the data as a
// plain table with a notice (and a lint warning); new charts are `figure` blocks drawn by a matplotlib script.
import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { RetiredChart, type Tab } from '../core/ui';
import type { Labels } from '../core/i18n';
import { fmt } from '../core/text';

type Trend = { x: 'date' | 'num' | 'cat'; series: { name: string; points: Array<[string | number, number]> }[]; unit?: string };
const toTable = (b: unknown, _t?: Labels): Tab => { const t = b as Trend; const xs = [...new Set(t.series.flatMap(s => s.points.map(p => String(p[0]))))]; return { columns: ['x', ...t.series.map(s => s.name)], rows: xs.map(x => [x, ...t.series.map(s => { const p = s.points.find(q => String(q[0]) === x); return p ? fmt(p[1], t.unit) : '—'; })]) }; };

export function parseX(v: string | number): number {
  if (typeof v === 'number') return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(v);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
  const t = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (t) return Date.UTC(1970, 0, 1, +t[1], +t[2]);
  return NaN;
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
  Doc: ({ block, ctx }) => <RetiredChart type="trend" block={block} ctx={ctx} {...toTable(block, ctx.t)}/>,
  slide: { weight: b => 0.2 + Math.min(12, new Set(b.series.flatMap((s: { points: unknown[][] }) => s.points.map(p => String(p[0])))).size) * 0.06 },
});
