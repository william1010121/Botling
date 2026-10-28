import { z } from 'zod';
import { arc, pie } from 'd3-shape';
import { defineBlock } from '../core/registry';
import { Card } from '../core/ui';
import { fmt, pct } from '../core/text';

type Part = { label: string; value: number };

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
  Doc: ({ block, ctx }) => {
    const parts: Part[] = block.parts;
    const total = parts.reduce((a, p) => a + p.value, 0);
    const arcs = pie<Part>().value(p => p.value).sort(null).padAngle(0.025)(parts);
    const gen = arc<unknown>().innerRadius(62).outerRadius(90).cornerRadius(3);
    return <Card type="donut" block={block} ctx={ctx}>
      <div className="dn">
        <div className="dnc">
          <svg viewBox="-92 -92 184 184" role="img" aria-label={parts.map(p => `${p.label} ${pct(p.value / total)}`).join('，')}>
            {arcs.map((a, i) => <path key={i} className={`c${i + 1}`} d={(gen(a as never) ?? '').replace(/(\.\d)\d+/g, '$1')}/>)}
          </svg>
          {block.center && <p><b>{block.center.value}</b><span>{block.center.label}</span></p>}
        </div>
        <ul className="dnl">{parts.map((p, i) => <li key={i}><i className={`sw c${i + 1}`}/><span>{p.label}</span><b>{pct(p.value / total)}</b><em>{fmt(p.value, block.unit)}</em></li>)}</ul>
      </div>
    </Card>;
  },
  slide: { weight: () => 0.55 },
});
