// Retired native chart: the renderer no longer draws it. Older specs still validate and show the data as a
// plain table with a notice (and a lint warning); new charts are `figure` blocks drawn by a matplotlib script.
import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { RetiredChart, type Tab } from '../core/ui';
import type { Labels } from '../core/i18n';
import { fmt } from '../core/text';
import { statusEnum } from '../core/i18n';

type Quad = { x: string; y: string; points: { label: string; x: number; y: number }[] };
const toTable = (b: unknown, _t?: Labels): Tab => { const q = b as Quad; return { columns: ['', q.x, q.y], rows: q.points.map(p => [p.label, fmt(p.x), fmt(p.y)]) }; };

export const quadrant = defineBlock({
  type: 'quadrant',
  description: '2×2 chart: items placed by two 0–1 scores (e.g. effort × impact), with the four quadrants named.',
  when: 'Prioritising ≤12 items on two judgements. Scores are estimates, so say so in the note. Name quadrants by the action ("先做", "別做").',
  fields: {
    x: z.string().trim().min(1).max(16).describe('X axis name, low → high (left → right).'),
    y: z.string().trim().min(1).max(16).describe('Y axis name, low → high (bottom → top).'),
    quadrants: z.tuple([z.string().max(12), z.string().max(12), z.string().max(12), z.string().max(12)]).optional().describe('[top-left, top-right, bottom-left, bottom-right]'),
    best: z.number().int().min(0).max(3).optional().describe('Index of the quadrant to highlight as the good one (0=top-left…3=bottom-right).'),
    points: z.array(z.strictObject({ label: z.string().trim().min(1).max(16), x: z.number().min(0).max(1), y: z.number().min(0).max(1), status: statusEnum.optional() })).min(1).max(12),
  },
  examples: [{ title: '先修手機清單：影響大又便宜', note: '估計值', x: '工作量', y: '影響', quadrants: ['先做', '排進計畫', '順手做', '別做'], best: 0, points: [{ label: '手機 bot 清單', x: 0.2, y: 0.9, status: 'blocked' }, { label: 'Rust IPC', x: 0.75, y: 0.8, status: 'active' }, { label: '報告動畫', x: 0.6, y: 0.2 }, { label: '側欄字距', x: 0.15, y: 0.25 }] }],
  fit: 'visual',
  visual: true,
  Doc: ({ block, ctx }) => <RetiredChart type="quadrant" block={block} ctx={ctx} {...toTable(block, ctx.t)}/>,
  slide: { weight: b => 0.2 + b.points.length * 0.07 },
});
