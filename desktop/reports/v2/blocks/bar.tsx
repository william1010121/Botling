// Retired native chart: the renderer no longer draws it. Older specs still validate and show the data as a
// plain table with a notice (and a lint warning); new charts are `figure` blocks drawn by a matplotlib script.
import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { RetiredChart, type Tab } from '../core/ui';
import type { Labels } from '../core/i18n';
import { fmt } from '../core/text';

type Bar = { stacked?: boolean; highlight?: string; series: { name: string }[]; rows: { label: string; values: number[] }[]; unit?: string };
const toTable = (b: unknown, _t?: Labels): Tab => ({ columns: ['', ...(b as Bar).series.map(s => s.name)], rows: (b as Bar).rows.map(r => [r.label, ...r.values.map(v => fmt(v, (b as Bar).unit))]) });

export const bar = defineBlock({
  type: 'bar',
  description: 'Bar chart for comparing categories: one or more series, positive or signed/diverging values, optional referenceLine, vertical or horizontal (auto).',
  when: 'Comparing amounts or signed gains/deltas across ≤15 categories (negative numbers render around a 0 baseline automatically; use referenceLine for chance/target baselines). Use highlight to point at the bar the title talks about. Time series → trend; parts of one whole → donut.',
  fields: {
    series: z.array(z.strictObject({ name: z.string().trim().min(1).max(20) })).min(1).max(4),
    rows: z.array(z.strictObject({ label: z.string().trim().min(1).max(24), values: z.array(z.number()).min(1).max(4) })).min(1).max(15),
    stacked: z.boolean().optional(),
    horizontal: z.boolean().optional().describe('Omit to choose automatically (horizontal for many or long labels).'),
    sort: z.boolean().optional().describe('Sort rows by size, largest first.'),
    unit: z.string().trim().max(8).optional(),
    highlight: z.string().trim().max(24).optional().describe('Row label to emphasise; other bars turn grey.'),
    referenceLine: z.strictObject({ value: z.number(), label: z.string().trim().min(1).max(32) }).optional().describe('Optional baseline or chance-level line (e.g. random guess 25%).'),
  },
  refine: (v, c) => {
    const b = v as unknown as Bar;
    b.rows.forEach((r, i) => { if (r.values.length !== b.series.length) c.addIssue({ code: 'custom', path: ['rows', i, 'values'], message: `needs ${b.series.length} value(s), one per series` }); });
    if (b.stacked && b.rows.some(r => r.values.some(x => x < 0))) c.addIssue({ code: 'custom', path: ['stacked'], message: 'stacked bars cannot contain negative values; omit stacked for diverging bars' });
    if (b.highlight && !b.rows.some(r => r.label === b.highlight)) c.addIssue({ code: 'custom', path: ['highlight'], message: 'highlight must equal one row label' });
  },
  examples: [
    { title: '啟動時間主要花在載入聊天紀錄', unit: 'ms', series: [{ name: '耗時' }], highlight: '聊天紀錄', rows: [{ label: '主程序', values: [180] }, { label: '聊天紀錄', values: [620] }, { label: '外掛', values: [140] }, { label: '側欄', values: [90] }] },
    { title: '本週合併的 PR，Codex 佔一半', stacked: true, series: [{ name: 'Claude' }, { name: 'Codex' }], rows: [{ label: '週一', values: [3, 2] }, { label: '週二', values: [2, 4] }, { label: '週三', values: [4, 3] }, { label: '週四', values: [1, 3] }] },
    { title: '扣除隨機猜測後，MAtt 跨人增益兩資料集相等', unit: 'Δκ', series: [{ name: '2a' }, { name: 'OpenBMI' }], rows: [{ label: 'MAtt 跨人', values: [0.098, 0.096] }, { label: 'SPDIM 跨人', values: [-0.032, -0.033] }] },
  ],
  fit: 'visual',
  visual: true,
  Doc: ({ block, ctx }) => <RetiredChart type="bar" block={block} ctx={ctx} {...toTable(block, ctx.t)}/>,
  slide: { weight: b => 0.2 + b.rows.length * 0.08 },
});
