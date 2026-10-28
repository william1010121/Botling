import { z } from 'zod';
import { defineBlock } from '../core/registry';

export const quote = defineBlock({
  type: 'quote',
  description: 'A short quotation with its source.',
  when: 'The user\'s own words or a log line that is the evidence itself. One sentence; never as decoration.',
  fields: {
    text: z.string().trim().min(1).max(200),
    source: z.string().trim().min(1).max(60).optional(),
  },
  examples: [{ text: '手機上只看得到 Main bot，其他 bot 都不見了。', source: '使用者回報 · 10/27 21:40' }],
  fit: 'text',
  visual: false,
  Doc: ({ block }) => <blockquote className="blk blk-quote"><p>{block.text}</p>{block.source && <footer>{block.source}</footer>}</blockquote>,
  slide: { weight: () => 0.35, side: true },
});
