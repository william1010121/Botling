import { z } from 'zod';
import { scaleUtc } from 'd3-scale';
import { defineBlock, type Ctx } from '../core/registry';
import { statusEnum, statusTone, type Status } from '../core/i18n';
import { Card } from '../core/ui';
import { pct } from '../core/text';
import { parseX } from './trend';

type Item = { label: string; start: string; end?: string; status?: Status; lane?: string; text?: string };
type Timeline = { items: Item[]; today?: string; title?: string };
export const isGantt = (b: Timeline) => b.items.some(i => i.end);

function Events({ b, ctx }: { b: Timeline; ctx: Ctx }) {
  return <ol className="ev">{b.items.map((it, i) => <li key={i} className={`t-${it.status ? statusTone[it.status] : 'none'}`}>
    <time>{it.start}</time><i aria-hidden="true"/>
    <div><p className="evl">{it.label}{it.status && <span className="sr-only">（{ctx.t.status[it.status]}）</span>}</p>{it.text && <p className="evt">{it.text}</p>}</div>
  </li>)}</ol>;
}

function Gantt({ b, ctx }: { b: Timeline; ctx: Ctx }) {
  const xs = b.items.flatMap(i => [parseX(i.start), ...(i.end ? [parseX(i.end)] : [])]).concat(b.today ? [parseX(b.today)] : []);
  const lo = Math.min(...xs), hi = Math.max(...xs), padMs = (hi - lo) * 0.02 || 864e5;
  const x = scaleUtc().domain([lo - padMs, hi + padMs]).range([0, 1]);
  const ticks = x.ticks(5).map(d => ({ at: x(d), label: `${d.getUTCMonth() + 1}/${d.getUTCDate()}` }));
  const lanes = [...new Set(b.items.map(i => i.lane ?? ''))];
  const summary = b.items.map(i => `${i.label}：${i.start}${i.end ? ` – ${i.end}` : ''}${i.status ? `（${ctx.t.status[i.status]}）` : ''}`).join('；');
  return <div className="gt" role="img" aria-label={summary}>
    <div className="gx" aria-hidden="true"><span/><div>{ticks.map((t, i) => <span key={i} style={{ left: pct(t.at) }}>{t.label}</span>)}</div></div>
    <div className="gb">
      {ticks.map((t, i) => <i key={i} className="gl" style={{ ['--x' as string]: +t.at.toFixed(4) }} aria-hidden="true"/>)}
      {b.today && <i className="today" style={{ ['--x' as string]: +x(parseX(b.today)).toFixed(4) }} aria-hidden="true"><em>{ctx.t.today}</em></i>}
      {lanes.map(lane => <div key={lane} className="glane">
        {lane && <p className="glh">{lane}</p>}
        {b.items.filter(i => (i.lane ?? '') === lane).map((it, k) => {
          const s = x(parseX(it.start)), e = it.end ? x(parseX(it.end)) : s;
          const tone = it.status ? statusTone[it.status] : 'none';
          return <div key={k} className="gr">
            <p className="gl-l">{it.label}<span className="sr-only">{`：${it.start}${it.end ? ` – ${it.end}` : ''}${it.status ? `（${ctx.t.status[it.status]}）` : ''}`}</span></p>
            <div className="gtrk">{it.end
              ? <span className={`gbar t-${tone}`} style={{ left: pct(s), width: pct(Math.max(e - s, 0.012)) }}/>
              : <span className={`gms t-${tone}`} style={{ left: pct(s) }}/>}</div>
          </div>;
        })}
      </div>)}
    </div>
  </div>;
}

export const timeline = defineBlock({
  type: 'timeline',
  description: 'Either a vertical event log (items without end) or a gantt chart (items with start and end dates, optional lanes and a today line).',
  when: 'Investigations (what happened when) and plans (phases with dates). ≤12 events in a report body; keep each label to the event, not the narration.',
  fields: {
    items: z.array(z.strictObject({
      label: z.string().trim().min(1).max(40),
      start: z.string().trim().min(1).max(20).describe('Event: any short time text ("10/27 21:40"). Gantt: "YYYY-MM-DD".'),
      end: z.string().trim().min(1).max(20).optional().describe('Gantt only, "YYYY-MM-DD". Omit for milestones/events.'),
      status: statusEnum.optional(),
      lane: z.string().trim().min(1).max(16).optional(),
      text: z.string().trim().min(1).max(80).optional().describe('Event mode only: one line of detail.'),
    })).min(1).max(20),
    today: z.string().trim().max(20).optional().describe('Gantt only, "YYYY-MM-DD".'),
  },
  refine: (v, c) => {
    const b = v as unknown as Timeline;
    if (!isGantt(b)) return;
    b.items.forEach((it, i) => {
      for (const k of ['start', 'end'] as const) if (it[k] && Number.isNaN(parseX(it[k]!))) c.addIssue({ code: 'custom', path: ['items', i, k], message: 'gantt dates must be "YYYY-MM-DD"' });
      if (it.end && parseX(it.end) < parseX(it.start)) c.addIssue({ code: 'custom', path: ['items', i, 'end'], message: 'end is before start' });
    });
    if (b.today && Number.isNaN(parseX(b.today))) c.addIssue({ code: 'custom', path: ['today'], message: 'today must be "YYYY-MM-DD"' });
  },
  examples: [
    { title: '問題在 21:10 的改版後出現', items: [{ start: '10/27 21:10', label: '手機版 .4 上線', status: 'done' }, { start: '21:40', label: '使用者回報只看到 Main', status: 'blocked', text: 'iPhone 與 Android 都一樣' }, { start: '22:05', label: '確認 /bots 回傳被截斷', status: 'risk' }, { start: '22:30', label: '暫時退回 .3', status: 'done' }] },
    { title: 'Rust 遷移預計 11/14 完成', today: '2026-10-28', items: [{ label: 'IPC 指令', start: '2026-10-20', end: '2026-11-02', status: 'active', lane: '後端' }, { label: '資料遷移', start: '2026-11-01', end: '2026-11-08', lane: '後端' }, { label: '手機版對齊', start: '2026-10-22', end: '2026-11-05', status: 'active', lane: '前端' }, { label: '發布 .12', start: '2026-11-14', lane: '前端' }] },
  ],
  fit: 'full',
  visual: true,
  Doc: ({ block, ctx }) => <Card type="timeline" block={block} ctx={ctx}>{isGantt(block) ? <Gantt b={block} ctx={ctx}/> : <Events b={block} ctx={ctx}/>}</Card>,
  slide: {
    weight: b => 0.16 + b.items.length * (isGantt(b) ? 0.085 : 0.11),
    split: b => (b.items.length <= 6 ? [b] : [{ ...b, items: b.items.slice(0, Math.ceil(b.items.length / 2)) }, { ...b, items: b.items.slice(Math.ceil(b.items.length / 2)) }]),
  },
});
