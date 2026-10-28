import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { Card, SrTable } from '../core/ui';
import { fmt, pct } from '../core/text';

type Row = { label: string; before: number; after: number; unit?: string; better: 'higher' | 'lower' };

export function change(r: Row): { text: string; tone: 'good' | 'bad' | 'neutral' } {
  if (r.before === r.after) return { text: '±0', tone: 'neutral' };
  const rel = r.before !== 0 ? (r.after - r.before) / Math.abs(r.before) : null;
  const text = rel === null ? `${r.after > r.before ? '+' : '−'}${fmt(Math.abs(r.after - r.before), r.unit)}` : `${rel > 0 ? '+' : '−'}${Math.round(Math.abs(rel) * 100)}%`;
  const improved = (r.after > r.before) === (r.better === 'higher');
  return { text, tone: improved ? 'good' : 'bad' };
}

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
  Doc: ({ block, ctx }) => {
    const rows: Row[] = block.rows;
    const lb = block.labels ?? { before: ctx.t.before, after: ctx.t.after };
    return <Card type="beforeafter" block={block} ctx={ctx}>
      <ul className="ba-k" aria-hidden="true"><li><i className="sw cb"/>{lb.before}</li><li><i className="sw ca"/>{lb.after}</li></ul>
      <div className="ba" aria-hidden="true">{rows.map((r, i) => {
        const max = Math.max(r.before, r.after) || 1, c = change(r);
        return <div key={i} className="bar-row">
          <p className="bal"><span>{r.label}</span><span className={`dl t-${c.tone}`}>{c.text}</span></p>
          <div className="bab"><span className="bt"><i className="cb" style={{ width: pct(r.before / max) }}/></span><em>{fmt(r.before, r.unit)}</em></div>
          <div className="bab"><span className="bt"><i className={`ca t-${c.tone}`} style={{ width: pct(r.after / max) }}/></span><em><b>{fmt(r.after, r.unit)}</b></em></div>
        </div>;
      })}</div>
      <SrTable caption={block.title ?? 'before/after'} columns={['', lb.before, lb.after, '%']} rows={rows.map(r => [r.label, fmt(r.before, r.unit), fmt(r.after, r.unit), change(r).text])}/>
    </Card>;
  },
  slide: { weight: b => 0.2 + b.rows.length * 0.14, side: false },
});
