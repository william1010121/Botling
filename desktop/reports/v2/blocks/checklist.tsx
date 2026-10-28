import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { statusEnum, statusTone, type Status } from '../core/i18n';
import { Card } from '../core/ui';

type Item = { label: string; status: Status; note?: string };
const mark: Record<Status, string> = { done: '✓', active: '◐', pending: '○', blocked: '✕', risk: '!', unverified: '?', skipped: '–' };
const order: Status[] = ['done', 'active', 'pending', 'unverified', 'risk', 'blocked', 'skipped'];

export const checklist = defineBlock({
  type: 'checklist',
  description: 'A list of items with a status each, plus a done-count and a status bar.',
  when: 'Acceptance criteria, a release checklist, Done/Next/Blocked lists. ≤12 items; each label is a noun phrase, the note one line.',
  fields: {
    items: z.array(z.strictObject({
      label: z.string().trim().min(1).max(40),
      status: statusEnum,
      note: z.string().trim().min(1).max(60).optional(),
    })).min(1).max(12),
  },
  examples: [{ title: '4 項驗收已過 2 項，1 項受阻', items: [{ label: '任務面板 .11 安裝', status: 'done' }, { label: '舊資料自動搬移', status: 'done' }, { label: 'Rust 後端接上 IPC', status: 'active', note: '剩 3 個指令' }, { label: '手機版同步 bot 清單', status: 'blocked', note: '等 API 修好' }] }],
  fit: 'half',
  visual: false,
  Doc: ({ block, ctx }) => {
    const items: Item[] = block.items;
    const done = items.filter(i => i.status === 'done').length;
    const counts = order.map(s => [s, items.filter(i => i.status === s).length] as const).filter(([, n]) => n);
    return <Card type="checklist" block={block} ctx={ctx}>
      <div className="ck-sum"><b>{ctx.t.doneOf(done, items.length)}</b>
        <div className="segbar" role="img" aria-label={counts.map(([s, n]) => `${ctx.t.status[s]} ${n}`).join('，')}>
          {counts.map(([s, n]) => <span key={s} className={`seg t-${statusTone[s]}`} style={{ flexGrow: n }}/>)}
        </div>
      </div>
      <ul className="ck">{items.map((it, i) => <li key={i} className={`t-${statusTone[it.status]}`}>
        <i aria-hidden="true">{mark[it.status]}</i>
        <div><p><span>{it.label}</span><span className="sr-only">（{ctx.t.status[it.status]}）</span></p>{it.note && <p className="ckn">{it.note}</p>}</div>
        <span className="cks" aria-hidden="true">{ctx.t.status[it.status]}</span>
      </li>)}</ul>
    </Card>;
  },
  slide: {
    weight: b => 0.18 + b.items.length * 0.085,
    split: b => b.items.length <= 7 ? [b] : [{ ...b, items: b.items.slice(0, 6) }, { ...b, items: b.items.slice(6) }],
    side: true,
  },
});
