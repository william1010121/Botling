import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { statusEnum, statusTone, type Status } from '../core/i18n';
import { Card } from '../core/ui';

type Item = { label: string; status?: Status; note?: string };
type Col = { title: string; items: Item[] };

export const roadmap = defineBlock({
  type: 'roadmap',
  description: 'Two to four columns (e.g. Now / Next / Later) of short items with optional status.',
  when: 'Plans without exact dates, or "what is in flight vs queued". Dated work with durations → timeline.',
  fields: {
    columns: z.array(z.strictObject({
      title: z.string().trim().min(1).max(12),
      items: z.array(z.strictObject({ label: z.string().trim().min(1).max(30), status: statusEnum.optional(), note: z.string().trim().min(1).max(40).optional() })).max(6),
    })).min(2).max(4),
  },
  examples: [{ title: '這週收尾兩條線，下週開始 Windows', columns: [{ title: '現在', items: [{ label: 'Rust 後端 IPC', status: 'active', note: '剩 3 個指令' }, { label: '手機版 bot 清單', status: 'blocked' }] }, { title: '下一步', items: [{ label: '報告區塊定稿' }, { label: '安裝器簽章' }] }, { title: '之後', items: [{ label: 'Windows / Linux 打包' }] }] }],
  fit: 'full',
  visual: true,
  Doc: ({ block, ctx }) => <Card type="roadmap" block={block} ctx={ctx}>
    <div className="rm" style={{ ['--n' as string]: block.columns.length }}>{(block.columns as Col[]).map((c, i) => <section key={i} className={i === 0 ? 'now' : undefined}>
      <h4><span>{c.title}</span><em>{ctx.t.items(c.items.length)}</em></h4>
      <ul>{c.items.map((it, k) => <li key={k} className={`chipcard t-${it.status ? statusTone[it.status] : 'none'}`}>
        <p className="cct">{it.label}</p>
        {(it.note || it.status) && <p className="ccm">{it.status && <span className="sc">{ctx.t.status[it.status]}</span>}{it.status && it.note && ' · '}{it.note}</p>}
      </li>)}</ul>
    </section>)}</div>
  </Card>,
  slide: { weight: b => 0.3 + Math.max(...b.columns.map((c: Col) => c.items.length)) * 0.12 },
});
