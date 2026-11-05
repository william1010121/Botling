// Retired native chart: the renderer no longer draws it. Older specs still validate and show the data as a
// plain table with a notice (and a lint warning); new charts are `figure` blocks drawn by a matplotlib script.
import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { RetiredChart, type Tab } from '../core/ui';
import type { Labels } from '../core/i18n';
import { fmt, pct } from '../core/text';

type Donut = { parts: { label: string; value: number }[]; unit?: string };
const toTable = (b: unknown, _t?: Labels): Tab => { const d = b as Donut; const total = d.parts.reduce((a, p) => a + p.value, 0); return { columns: ['', d.unit ?? '', '%'], rows: d.parts.map(p => [p.label, fmt(p.value), pct(p.value / total)]) }; };

export const donut = defineBlock({
  type: 'donut',
  description: 'Parts of one whole, 2–4 slices, with a centre figure and a value legend.',
  when: 'Only when the parts add up to a meaningful whole (time spent, share of crashes). More than 4 parts or comparing amounts → bar.',
  fields: {
    parts: z.array(z.strictObject({ label: z.string().trim().min(1).max(20), value: z.number().positive() })).min(2).max(4),
    unit: z.string().trim().max(8).optional(),
    center: z.strictObject({ value: z.string().trim().min(1).max(8), label: z.string().trim().min(1).max(12) }).optional(),
  },
  examples: [{ title: '啟動時間一半花在聊天紀錄', unit: 'ms', center: { value: '1.4s', label: '冷啟動' }, parts: [{ label: '聊天紀錄', value: 620 }, { label: '主程序', value: 380 }, { label: '外掛與側欄', value: 230 }, { label: '其他', value: 170 }] }],
  fit: 'half',
  visual: true,
  Doc: ({ block, ctx }) => <RetiredChart type="donut" block={block} ctx={ctx} {...toTable(block, ctx.t)}/>,
  slide: { weight: b => 0.2 + b.parts.length * 0.08 },
});
