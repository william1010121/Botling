// Retired native chart: the renderer no longer draws it. Older specs still validate and show the data as a
// plain table with a notice (and a lint warning); new charts are `figure` blocks drawn by a matplotlib script.
import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { RetiredChart, type Tab } from '../core/ui';
import type { Labels } from '../core/i18n';
import { fmt } from '../core/text';

type BA = { labels?: { before: string; after: string }; rows: { label: string; before: number; after: number; unit?: string }[] };
const toTable = (b: unknown, t: Labels): Tab => { const x = b as BA; return { columns: ['', x.labels?.before ?? t.before, x.labels?.after ?? t.after], rows: x.rows.map(r => [r.label, fmt(r.before, r.unit), fmt(r.after, r.unit)]) }; };

export const beforeafter = defineBlock({
  type: 'beforeafter',
  description: 'Paired before/after bars per metric with the change in %, coloured by whether higher or lower is better.',
  when: 'Results of a change: 1–6 metrics measured the same way before and after. Each row has its own scale, so mixed units are fine.',
  fields: {
    labels: z.strictObject({ before: z.string().trim().min(1).max(12), after: z.string().trim().min(1).max(12) }).optional().describe('Defaults to 之前 / 之後.'),
    rows: z.array(z.strictObject({
      label: z.string().trim().min(1).max(20),
      before: z.number().min(0),
      after: z.number().min(0),
      unit: z.string().trim().max(8).optional(),
      better: z.enum(['higher', 'lower']),
    })).min(1).max(6),
  },
  examples: [{ title: '三項效能指標都變好', labels: { before: '.10', after: '.11' }, rows: [{ label: '冷啟動', before: 2.4, after: 1.4, unit: 's', better: 'lower' }, { label: '閒置 CPU', before: 9.8, after: 2.1, unit: '%', better: 'lower' }, { label: '每秒訊息', before: 140, after: 210, better: 'higher' }] }],
  fit: 'half',
  visual: true,
  Doc: ({ block, ctx }) => <RetiredChart type="beforeafter" block={block} ctx={ctx} {...toTable(block, ctx.t)}/>,
  slide: { weight: b => 0.2 + b.rows.length * 0.08 },
});
