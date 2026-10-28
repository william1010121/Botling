import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { statusEnum, statusTone, type Status } from '../core/i18n';
import { Card } from '../core/ui';
import { Sparkline } from '../core/chart';

type Item = { label: string; value: string | number; unit?: string; delta?: string; deltaDir: 'up_good' | 'down_good' | 'neutral'; target?: string; spark?: number[]; status?: Status };

function deltaTone(it: Item): string {
  if (!it.delta || it.deltaDir === 'neutral') return 'neutral';
  const down = /^[-−↓▼]/.test(it.delta.trim());
  const up = /^[+↑▲]/.test(it.delta.trim()) || (!down && /^\d/.test(it.delta.trim()));
  if (!down && !up) return 'neutral';
  return (up === (it.deltaDir === 'up_good')) ? 'good' : 'bad';
}

export const kpi = defineBlock({
  type: 'kpi',
  description: 'A row of 1–6 headline numbers, each with label and optional delta, target and sparkline.',
  when: 'The 3–5 numbers the reader should remember, at the top of status and results reports. Put the most important first. Do not repeat a KPI as a chart.',
  fields: {
    items: z.array(z.strictObject({
      label: z.string().trim().min(1).max(16),
      value: z.union([z.number(), z.string().trim().min(1).max(10)]),
      unit: z.string().trim().max(6).optional(),
      delta: z.string().trim().min(1).max(12).optional().describe('Signed change, e.g. "-42%" or "+3". Colour follows deltaDir.'),
      deltaDir: z.enum(['up_good', 'down_good', 'neutral']).default('up_good'),
      target: z.string().trim().min(1).max(20).optional().describe('e.g. "目標 ≤ 3%"'),
      spark: z.array(z.number()).min(2).max(40).optional(),
      status: statusEnum.optional().describe('Colours the number (blocked = red, pending = orange…).'),
    })).min(1).max(6),
    stack: z.boolean().optional().describe('Draw a segmented bar of the items that have a status (first item = total).'),
  },
  examples: [
    { items: [{ label: '冷啟動', value: 1.4, unit: 's', delta: '-42%', deltaDir: 'down_good', spark: [2.6, 2.5, 2.4, 2.1, 1.6, 1.4] }, { label: '閒置 CPU', value: '2.1%', delta: '-7.7pt', deltaDir: 'down_good', target: '目標 ≤ 3%' }, { label: '記憶體', value: 412, unit: 'MB', delta: '+6%', deltaDir: 'down_good' }] },
    { stack: true, items: [{ label: '追蹤項目', value: 7 }, { label: '受阻', value: 1, status: 'blocked' }, { label: '進行中', value: 3, status: 'active' }, { label: '完成', value: 3, status: 'done' }] },
  ],
  fit: 'kpi',
  visual: false,
  Doc: ({ block, ctx }) => {
    const items: Item[] = block.items;
    const segs = block.stack ? items.filter(i => i.status && typeof i.value === 'number' && i.value > 0) : [];
    return <Card type="kpi" block={block} ctx={ctx} className={`n${items.length}`}>
      <dl className="kpis">{items.map((it, i) => <div key={i} className={`kpi${it.status ? ` t-${statusTone[it.status]}` : ''}`}>
        <dt>{it.label}</dt>
        <dd className="kv"><b>{typeof it.value === 'number' ? it.value.toLocaleString('en-US') : it.value}</b>{it.unit && <small>{it.unit}</small>}</dd>
        {(it.delta || it.target) && <dd className="kd">{it.delta && <span className={`dl t-${deltaTone(it)}`}>{it.delta}</span>}{it.target && <span className="tg">{it.target}</span>}</dd>}
        {it.spark && <dd className="ks"><Sparkline points={it.spark} className={`t-${deltaTone(it)}`}/></dd>}
      </div>)}</dl>
      {segs.length > 0 && <div className="segbar lg" role="img" aria-label={segs.map(s => `${s.label} ${s.value}`).join('，')}>
        {segs.map((s, i) => <span key={i} className={`seg t-${statusTone[s.status!]}`} style={{ flexGrow: s.value as number }}/>)}
      </div>}
    </Card>;
  },
  slide: { weight: b => (b.items.some((i: Item) => i.spark) ? 0.42 : 0.32) + (b.stack ? 0.06 : 0) },
});
