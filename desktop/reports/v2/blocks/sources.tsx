import { z } from 'zod';
import { defineBlock } from '../core/registry';

export const sources = defineBlock({
  type: 'sources',
  description: 'Up to four one-line sources: a short reference (commit, file, run id) and what it shows.',
  when: 'At the end of a report, for the evidence that carries the conclusion. Four lines maximum; long logs stay out of the report.',
  fields: {
    items: z.array(z.strictObject({
      ref: z.string().trim().min(1).max(40).describe('Commit, file, run or ticket id; shown as code.'),
      text: z.string().trim().min(1).max(60).describe('What this source establishes, in one line.'),
    })).min(1).max(4),
  },
  examples: [{ items: [{ ref: 'a58c883', text: '任務面板 .11 已安裝並開啟' }, { ref: 'perf-run:1028', text: '同機同條件量測 5 次取中位數' }] }],
  fit: 'full',
  visual: false,
  Doc: ({ block, ctx }) => <nav className="blk blk-sources" aria-label={block.title ?? ctx.t.sources}>
    <h3>{block.title ?? ctx.t.sources}</h3>
    <ul>{block.items.map((s: { ref: string; text: string }, i: number) => <li key={i}><code>{s.ref}</code><span>{s.text}</span></li>)}</ul>
  </nav>,
  slide: { weight: () => 0.2 },
});
