import { z } from 'zod';
import { defineBlock } from '../core/registry';
import { Card } from '../core/ui';

export const glossary = defineBlock({
  type: 'glossary',
  description: 'Plain one-sentence definitions of the acronyms, symbols and field terms the reader may not know.',
  when: 'In the first section of any report that uses domain terms (acronyms, model or dataset names, metric symbols such as κ). Define each term once, in everyday words or with an analogy, then use it the same way everywhere. The renderer treats terms listed here as defined.',
  fields: {
    items: z.array(z.strictObject({
      term: z.string().trim().min(1).max(40).describe('The term exactly as the report writes it, e.g. "LOSO" or "κ"; related names may share one entry ("MAtt / SPDIM").'),
      plain: z.string().trim().min(1).max(120).describe('One plain sentence: what it is and why it matters here.'),
    })).min(1).max(10),
  },
  examples: [{ title: '先看懂這三個詞', items: [
    { term: 'SESS', plain: '一種「先把每個人的腦波調到同一個基準」的前處理，像把不同麥克風的底噪先扣掉。' },
    { term: '跨受試者', plain: '用其他人的資料訓練、拿沒看過的新人來考，最接近真實上線。' },
    { term: 'κ', plain: '扣掉亂猜後的分數：0 = 跟亂猜一樣，1 = 全對；類別數不同的資料集要用它比。' },
  ] }],
  fit: 'half',
  visual: false,
  Doc: ({ block, ctx }) => <Card type="glossary" block={{ ...block, title: block.title ?? ctx.t.glossary }} ctx={ctx}>
    <dl>{block.items.map((it: { term: string; plain: string }, i: number) => <div key={i} className="gi"><dt>{it.term}</dt><dd>{it.plain}</dd></div>)}</dl>
  </Card>,
  slide: { weight: (b: { items: unknown[] }) => 0.12 + 0.1 * b.items.length, side: true },
});
