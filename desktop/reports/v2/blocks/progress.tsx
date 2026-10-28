import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { statusEnum, statusTone, type Status } from '../core/i18n';
import { Card } from '../core/ui';
import { fmt, pct } from '../core/text';

type Item = { label: string; value: number; max: number; unit?: string; status?: Status };

export const progress = defineBlock({
  type: 'progress',
  description: 'One to eight labelled progress bars (value of max).',
  when: 'How far each workstream has come (12 / 23 cards migrated). Use kpi for a single headline number, checklist for yes/no items.',
  fields: {
    items: z.array(z.strictObject({
      label: z.string().trim().min(1).max(30),
      value: z.number().min(0),
      max: z.number().positive().default(100),
      unit: z.string().trim().max(8).optional(),
      status: statusEnum.optional(),
    })).min(1).max(8),
  },
  refine: (v, c) => (v.items as Item[]).forEach((it, i) => { if (it.value > it.max) c.addIssue({ code: 'custom', path: ['items', i, 'value'], message: 'value must be ≤ max' }); }),
  examples: [{ title: 'Rust 遷移過半，手機版追上七成', items: [{ label: 'Rust 後端指令', value: 34, max: 52, status: 'active' }, { label: '手機版功能對齊', value: 7, max: 10, status: 'active' }, { label: '元件卡片搬移', value: 23, max: 23, status: 'done' }] }],
  fit: 'half',
  visual: true,
  Doc: ({ block, ctx }) => <Card type="progress" block={block} ctx={ctx}>
    <ul className="pg">{(block.items as Item[]).map((it, i) => {
      const share = it.value / it.max;
      return <li key={i}>
        <p><span>{it.label}</span><b>{it.max === 100 && !it.unit ? pct(share) : `${fmt(it.value)} / ${fmt(it.max, it.unit)}`}</b></p>
        <div className="track" role="progressbar" aria-label={it.label} aria-valuenow={it.value} aria-valuemin={0} aria-valuemax={it.max}>
          <span className={`fill t-${it.status ? statusTone[it.status] : 'info'}`} style={{ width: pct(share) }}/>
        </div>
      </li>;
    })}</ul>
  </Card>,
  slide: { weight: b => 0.15 + b.items.length * 0.1, side: true },
});
