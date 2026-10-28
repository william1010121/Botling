import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { statusEnum, statusTone, type Status } from '../core/i18n';
import { Card, SrTable } from '../core/ui';
import { pct } from '../core/text';

type Pt = { label: string; x: number; y: number; status?: Status };
type Quad = { best?: number; x: string; y: string; quadrants?: [string, string, string, string]; points: Pt[]; title?: string };

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
  Doc: ({ block, ctx }) => {
    const q = block as Quad;
    return <Card type="quadrant" block={block} ctx={ctx}>
      <div className="qd" aria-hidden="true">
        <div className="qg">{(q.quadrants ?? ['', '', '', '']).map((name, i) => <span key={i} className={`q${i}${q.best === i ? ' best' : ''}`}>{name}</span>)}</div>
        <div className="qa">{q.points.map((p, i) => <span key={i} className={`qp t-${p.status ? statusTone[p.status] : 'info'}${p.x > 0.68 ? ' left' : ''}`} style={{ left: pct(p.x), bottom: pct(p.y) }}><i/><em>{p.label}</em></span>)}</div>
        <span className="qy">↑ {q.y}</span><span className="qx">{q.x} →</span>
      </div>
      <SrTable caption={q.title ?? `${q.x} × ${q.y}`} columns={['', q.x, q.y]} rows={q.points.map(p => [p.label, p.x, p.y])}/>
    </Card>;
  },
  slide: { weight: () => 0.85 },
});
