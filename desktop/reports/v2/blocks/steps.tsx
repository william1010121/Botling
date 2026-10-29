import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { statusEnum, type Status } from '../core/i18n';
import { Card, Pill } from '../core/ui';

type Step = { title: string; text?: string; status?: Status };

export const steps = defineBlock({
  type: 'steps',
  description: 'An ordered sequence of 2–6 steps, each a short title with an optional one-line detail.',
  when: 'A procedure, a fix plan or "what happens next" in order. If the steps branch, use flowchart instead.',
  fields: {
    items: z.array(z.strictObject({
      title: z.string().trim().min(1).max(24),
      text: z.string().trim().min(1).max(70).optional(),
      status: statusEnum.optional(),
    })).min(2).max(6),
  },
  examples: [{ title: '修復分三步，今天先做第一步', items: [{ title: '補回 bot 清單 API', text: '手機端改讀 /bots，不再只讀 Main', status: 'active' }, { title: '加上回歸測試', text: '三個 bot 都要出現在側欄' }, { title: '實機驗收', text: 'iPhone 與 Android 各跑一次' }] }],
  fit: b => (b.items.length <= 4 ? 'full' : 'half'),
  visual: false,
  Doc: ({ block, ctx }) => <Card type="steps" block={block} ctx={ctx}>
    <ol className={`stp${block.items.some((s: Step) => s.text) ? '' : ' compact'}`}>
      {block.items.map((s: Step, i: number) => <li key={i} className={s.status ? `s-${s.status}` : undefined}>
        <i className="n">{i + 1}</i>
        <div><p className="st">{s.title}{s.status && <Pill status={s.status} ctx={ctx}/>}</p>{s.text && <p className="sx">{s.text}</p>}</div>
      </li>)}
    </ol>
  </Card>,
  slide: { weight: b => 0.2 + b.items.length * 0.1, side: true },
});
