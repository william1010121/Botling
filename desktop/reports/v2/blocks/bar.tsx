import { z } from 'zod';
import { defineBlock, type Ctx } from '../core/registry';
import { Card, Legend, SrTable } from '../core/ui';
import { niceY } from '../core/chart';
import { fmt, pct, textUnits } from '../core/text';

type Row = { label: string; values: number[] };
type Bar = { title?: string; series: { name: string }[]; rows: Row[]; stacked?: boolean; horizontal?: boolean; unit?: string; highlight?: string; sort?: boolean };

export function isHorizontal(b: Bar): boolean {
  return b.horizontal ?? (b.rows.length > 7 || Math.max(...b.rows.map(r => textUnits(r.label))) > 6);
}

function colour(b: Bar, row: Row, s: number): string {
  if (b.series.length > 1) return `c${s + 1}`;
  if (b.highlight) return row.label === b.highlight ? 'c1' : 'cm';
  return 'c1';
}

function BarChart({ block, ctx }: { block: Bar; ctx: Ctx }) {
  const rows = block.sort ? [...block.rows].sort((a, b) => sum(b.values) - sum(a.values)) : block.rows;
  const totals = rows.map(r => (block.stacked ? sum(r.values) : Math.max(...r.values)));
  const { y, ticks } = niceY([0, ...totals], { zero: true, ticks: 4 });
  const max = y.domain()[1];
  const at = (v: number) => pct(v / max);
  const multi = block.series.length > 1;
  const sr = <SrTable caption={block.title ?? 'bar'} columns={['', ...block.series.map(s => s.name)]} rows={rows.map(r => [r.label, ...r.values.map(v => fmt(v, block.unit))])}/>;
  if (isHorizontal(block)) {
    return <>
      <Legend names={block.series.map(s => s.name)}/>
      <div className="hb" aria-hidden="true">{rows.map((r, i) => <div key={i} className={`hr${block.highlight && r.label !== block.highlight ? ' dim' : ''}`}>
        <span className="hl">{r.label}</span>
        <span className="ht">{block.stacked || !multi
          ? <span className="hs" style={{ width: at(block.stacked ? sum(r.values) : r.values[0]) }}>{r.values.map((v, s) => <i key={s} className={colour(block, r, s)} style={{ flexGrow: v }}/>)}</span>
          : <span className="hg">{r.values.map((v, s) => <i key={s} className={colour(block, r, s)} style={{ width: at(v) }}/>)}</span>}</span>
        <span className="hv">{fmt(block.stacked ? sum(r.values) : r.values[0], block.unit)}{multi && !block.stacked && r.values.length > 1 ? ` · ${r.values.slice(1).map(v => fmt(v)).join(' · ')}` : ''}</span>
      </div>)}</div>
      {sr}
    </>;
  }
  return <>
    <Legend names={block.series.map(s => s.name)}/>
    <div className="vb" aria-hidden="true" style={{ ['--n' as string]: rows.length }}>
      <div className="yl">{ticks.map(t => <span key={t} style={{ bottom: at(t) }}>{fmt(t)}</span>)}</div>
      <div className="vp">
        {ticks.map(t => <i key={t} className="gl" style={{ bottom: at(t) }}/>)}
        {rows.map((r, i) => <div key={i} className={`vc${block.highlight && r.label !== block.highlight ? ' dim' : ''}`}>
          {block.stacked || !multi
            ? <span className="vs" style={{ height: at(totals[i]) }}><em>{fmt(totals[i], block.unit === '%' ? '%' : '')}</em>{[...r.values].reverse().map((v, k) => <i key={k} className={colour(block, r, r.values.length - 1 - k)} style={{ flexGrow: v }}/>)}</span>
            : <span className="vg">{r.values.map((v, s) => <i key={s} className={colour(block, r, s)} style={{ height: at(v) }}/>)}</span>}
        </div>)}
      </div>
      <div className="xl">{rows.map((r, i) => <span key={i}>{r.label}</span>)}</div>
    </div>
    {sr}
  </>;
}
const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);

export const bar = defineBlock({
  type: 'bar',
  description: 'Bar chart for comparing categories: one or more series, grouped or stacked, vertical or horizontal (auto).',
  when: 'Comparing amounts across ≤15 categories. Use highlight to point at the bar the title talks about. Time series → trend; parts of one whole → donut.',
  fields: {
    series: z.array(z.strictObject({ name: z.string().trim().min(1).max(20) })).min(1).max(4),
    rows: z.array(z.strictObject({ label: z.string().trim().min(1).max(24), values: z.array(z.number().min(0)).min(1).max(4) })).min(1).max(15),
    stacked: z.boolean().optional(),
    horizontal: z.boolean().optional().describe('Omit to choose automatically (horizontal for many or long labels).'),
    sort: z.boolean().optional().describe('Sort rows by size, largest first.'),
    unit: z.string().trim().max(8).optional(),
    highlight: z.string().trim().max(24).optional().describe('Row label to emphasise; other bars turn grey.'),
  },
  refine: (v, c) => {
    const b = v as unknown as Bar;
    b.rows.forEach((r, i) => { if (r.values.length !== b.series.length) c.addIssue({ code: 'custom', path: ['rows', i, 'values'], message: `needs ${b.series.length} value(s), one per series` }); });
    if (b.highlight && !b.rows.some(r => r.label === b.highlight)) c.addIssue({ code: 'custom', path: ['highlight'], message: 'highlight must equal one row label' });
  },
  examples: [
    { title: '啟動時間主要花在載入聊天紀錄', unit: 'ms', series: [{ name: '耗時' }], highlight: '聊天紀錄', rows: [{ label: '主程序', values: [180] }, { label: '聊天紀錄', values: [620] }, { label: '外掛', values: [140] }, { label: '側欄', values: [90] }] },
    { title: '本週合併的 PR，Codex 佔一半', stacked: true, series: [{ name: 'Claude' }, { name: 'Codex' }], rows: [{ label: '週一', values: [3, 2] }, { label: '週二', values: [2, 4] }, { label: '週三', values: [4, 3] }, { label: '週四', values: [1, 3] }] },
  ],
  fit: 'visual',
  visual: true,
  Doc: ({ block, ctx }) => <Card type="bar" block={block} ctx={ctx}><BarChart block={block} ctx={ctx}/></Card>,
  slide: { weight: b => (isHorizontal(b) ? 0.25 + b.rows.length * 0.07 : 0.7) },
});
